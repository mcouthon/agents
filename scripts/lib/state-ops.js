"use strict";

/**
 * State operation business logic for the MCP server (D33: task.json is the
 * sole truth). Every reader and writer goes through task.js (loadTask /
 * readTaskJson / writeTaskJson). v1 state.json dirs are migrated on first
 * touch by loadTask; no caller keeps a v1 branch. state.json is never
 * created or written here — createTask/initState write task.json v2 only.
 */

const path = require("path");
const fs = require("fs");
const taskLib = require("./task");
const { withLock } = require("./lock");
const { applyTransition } = require("./transitions");
const { computeNext } = require("./next");
const { renderStateMd, rebuildTasksIndex } = require("./render");
const { resolvePolicy } = require("./policy");
const sessionLib = require("./session");

const OWNER_VALUES = ["explorer", "builder", "reviewer", "committer", null];

/**
 * D35: resolve a task_dir to an absolute path. If it's already absolute,
 * use as-is. Otherwise resolve through the central tasks root via repoKey.
 */
function resolveTaskDirAbs(projectDir, taskDir) {
  if (path.isAbsolute(taskDir)) return taskDir;
  const { repoKey } = require("./repo");
  const { tasksRoot } = require("./tasks-root");
  const key = repoKey(projectDir);
  const root = tasksRoot(key);
  // Try as a slug or number in the central root
  if (/^\d+$/.test(taskDir)) {
    const padded = taskDir.padStart(3, "0");
    if (fs.existsSync(root)) {
      const match = fs.readdirSync(root).find((n) => n.startsWith(padded + "-"));
      if (match) return path.join(root, match);
    }
  }
  if (fs.existsSync(root)) {
    const match = fs.readdirSync(root).find((n) => n.endsWith("-" + taskDir) || n === taskDir);
    if (match) return path.join(root, match);
  }
  // Fall back: treat as a path relative to the central root
  return path.resolve(root, taskDir);
}

const ENUM_KNOBS = {
  approve: ["ask", "auto"],
  commit: ["per_phase", "at_end"],
  enforcement: ["deny", "warn"],
  land: ["per_phase", "at_end"],
  tier: ["strategic", "standard", "minor"],
};

function getMcpSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    const s = sessionLib.find({ session_id: process.env.CLAUDE_CODE_SESSION_ID });
    if (s) return process.env.CLAUDE_CODE_SESSION_ID;
  }
  if (process.env.AGENTS_SESSION_ID) {
    const s = sessionLib.find({ session_id: process.env.AGENTS_SESSION_ID });
    if (s) return process.env.AGENTS_SESSION_ID;
  }
  if (process.env.CLAUDE_PID) {
    const pid = parseInt(process.env.CLAUDE_PID, 10);
    if (Number.isInteger(pid)) {
      const s = sessionLib.find({ pid });
      if (s) return s.session_id;
    }
  }
  return `pid-${process.pid}`;
}

function now() {
  return new Date().toISOString();
}

function validateOwner(owner) {
  if (owner !== undefined && owner !== null && !OWNER_VALUES.includes(owner)) {
    throw new Error(
      `Invalid owner "${owner}". Must be one of: ${OWNER_VALUES.filter(v => v !== null).join(", ")}, or null.`
    );
  }
}

/**
 * Stamp binding + last_writer from the current MCP session's registration
 * (parity with the v1 writeStateStamped). The pid comes from the session
 * registry, not process.pid, so a user-scoped MCP server reports the caller's
 * pid. Called before every task.json write in this module.
 */
function stampWriter(task) {
  const sid = getMcpSessionId();
  task.last_writer = { session_id: sid, timestamp: now() };
  const reg = sessionLib.find({ session_id: sid });
  task.binding = { session_id: sid, pid: (reg && reg.pid) ? reg.pid : process.pid };
}

// ---------------------------------------------------------------------------
// state_init (D33: writes task.json v2 + state.md, never state.json)
// ---------------------------------------------------------------------------

function initState(projectDir, taskDir, slug, phases) {
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  if (taskLib.isMigrated(taskDirAbs)) {
    throw new Error(
      `task.json already exists at ${taskLib.taskJsonPath(taskDirAbs)}. ` +
      "Use state_update to modify existing state."
    );
  }

  const dirName = path.basename(taskDirAbs);
  const numberMatch = dirName.match(/^(\d{3})(?:-|$)/);
  const number = numberMatch ? parseInt(numberMatch[1], 10) : 0;
  const md = taskLib.parseTaskMd(path.join(taskDirAbs, "task.md"));
  const nowIso = now();

  const task = {
    schema: taskLib.SCHEMA_V2,
    slug,
    number,
    title: md.title || slug,
    status: "planning",
    mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {},
    lease: {},
    last_writer: {},
    phases: phases.map(({ id, name, blocked_by, parallel_group }) => ({
      id,
      name,
      status: "not_started",
      owner: null,
      blocked_by: blocked_by || [],
      parallel_group: parallel_group ?? "",
      plan_path: "",
      manifest: [],
      note: "",
      reports: taskLib.emptyReports(),
      commits: [],
      branch: "",
      counters: taskLib.emptyCounters(),
      started: null,
      completed: null,
      landed_sha: null,
      warnings: [],
      conflict: null,
    })),
    worktree_path: "",
    checkpoints: [],
    flags: [],
    created: nowIso.slice(0, 10),
    updated: nowIso,
  };

  const phaseIds = new Set(task.phases.map((p) => p.id));
  for (const phase of task.phases) {
    for (const depId of phase.blocked_by) {
      if (!phaseIds.has(depId)) {
        throw new Error(
          `Phase ${phase.id} has blocked_by reference to non-existent phase ${depId}. ` +
          `Available phase IDs: ${[...phaseIds].join(", ")}`
        );
      }
    }
  }

  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  fs.mkdirSync(taskDirAbs, { recursive: true });
  withLock(taskDirAbs, lockHolder, () => {
    stampWriter(task);
  taskLib.writeTaskJson(taskDirAbs, task);
    renderStateMd(taskDirAbs, task, projectDir);
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());
  return { taskPath: taskLib.taskJsonPath(taskDirAbs), phaseCount: phases.length };
}

// ---------------------------------------------------------------------------
// state_update
// ---------------------------------------------------------------------------

/**
 * D34: resolve commit SHAs to full form via `git rev-parse --verify`.
 * Accepts an array of short or full SHAs. Throws on an unknown SHA so the
 * commits_recorded guard never sees an unresolvable SHA.
 */
function resolveCommitShas(projectDir, shas) {
  if (!Array.isArray(shas)) {
    throw new Error("commits must be an array of SHA strings");
  }
  const { execFileSync } = require("child_process");
  return shas.map((sha) => {
    if (typeof sha !== "string" || !sha.trim()) {
      throw new Error(`invalid commit SHA: ${JSON.stringify(sha)}`);
    }
    try {
      return execFileSync("git", ["-C", projectDir, "rev-parse", "--verify", `${sha.trim()}^{commit}`], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(`commit SHA not found in git: ${sha}`);
    }
  });
}

function updateState(projectDir, taskDir, updates) {
  const {
    phase_id, phase_status, owner: rawOwner, task_status,
    started, completed, blocked_by, parallel_group, commits,
  } = updates;

  const owner = rawOwner === "" ? null : rawOwner;
  validateOwner(owner);

  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);

  // D34: resolve --commits SHAs to full form before the transition runs so the
  // commits_recorded guard verifies them. An unknown SHA is refused here.
  const resolvedCommits = commits !== undefined
    ? resolveCommitShas(projectDir, commits)
    : undefined;

  const result = withLock(taskDirAbs, lockHolder, () => {
    const task = taskLib.loadTask(taskDirAbs);

    if (task_status !== undefined) {
      task.status = taskLib.mapLegacyTaskStatus(task_status);
    }

    if (phase_id !== undefined) {
      const phase = (task.phases || []).find((p) => p.id === phase_id);
      if (!phase) {
        throw new Error(
          `Phase ${phase_id} not found. Available phases: ${(task.phases || []).map((p) => p.id).join(", ")}`
        );
      }
      // D34: set phase.commits (full SHAs) before the transition so the
      // commits_recorded guard verifies them as today.
      if (resolvedCommits !== undefined) {
        phase.commits = resolvedCommits;
      }
      if (phase_status !== undefined) {
        const { collectGitFacts } = require("./next");
        applyTransition(phase, phase_status, task, {
          projectDir,
          taskDir: taskDirAbs,
          sessionId: getMcpSessionId(),
          gitFacts: collectGitFacts(projectDir),
        });
      }
      taskLib.applyPhaseFields(phase, { owner, started, completed, blocked_by, parallel_group });
      // Validate blocked_by references (v1 parity: reject dangling deps).
      if (blocked_by !== undefined) {
        const phaseIds = new Set((task.phases || []).map((p) => p.id));
        for (const depId of phase.blocked_by) {
          if (!phaseIds.has(depId)) {
            throw new Error(
              `Phase ${phase_id} has blocked_by reference to non-existent phase ${depId}. ` +
              `Available phase IDs: ${[...phaseIds].join(", ")}`
            );
          }
        }
      }
    }

    taskLib.autoCompleteTask(task, task_status !== undefined);

    stampWriter(task);
  taskLib.writeTaskJson(taskDirAbs, task);
    renderStateMd(taskDirAbs, task, projectDir);
    return task;
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());

  const updatedPhase = phase_id !== undefined
    ? result.phases.find((p) => p.id === phase_id)
    : null;
  const summary = updatedPhase
    ? `Phase ${updatedPhase.id} (${updatedPhase.name}): status=${updatedPhase.status}, owner=${updatedPhase.owner}`
    : `Task status: ${result.status}`;
  return { file: "task.json", summary };
}

// ---------------------------------------------------------------------------
// state_add_phases
// ---------------------------------------------------------------------------

function addPhases(projectDir, taskDir, phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("phases must contain at least one phase.");
  }

  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  const task = withLock(taskDirAbs, lockHolder, () => {
    const t = taskLib.loadTask(taskDirAbs);

    const existingIds = new Set((t.phases || []).map((p) => p.id));
    const seenInBatch = new Set();
    for (const p of phases) {
      if (existingIds.has(p.id)) {
        throw new Error(
          `Phase ${p.id} already exists. Existing phase IDs: ${[...existingIds].join(", ")}. ` +
          "Use state_update to modify it."
        );
      }
      if (seenInBatch.has(p.id)) {
        throw new Error(`Duplicate phase id ${p.id} in the request.`);
      }
      seenInBatch.add(p.id);
    }

    const newPhases = phases.map(({ id, name, blocked_by, parallel_group }) => ({
      id,
      name,
      status: "not_started",
      owner: null,
      blocked_by: blocked_by || [],
      parallel_group: parallel_group ?? "",
      plan_path: "",
      manifest: [],
      note: "",
      reports: taskLib.emptyReports(),
      commits: [],
      branch: "",
      counters: taskLib.emptyCounters(),
      started: null,
      completed: null,
      landed_sha: null,
      warnings: [],
      conflict: null,
    }));

    const allIds = new Set([...existingIds, ...newPhases.map((p) => p.id)]);
    for (const phase of newPhases) {
      for (const depId of phase.blocked_by) {
        if (!allIds.has(depId)) {
          throw new Error(
            `Phase ${phase.id} has blocked_by reference to non-existent phase ${depId}. ` +
            `Available phase IDs: ${[...allIds].join(", ")}`
          );
        }
      }
    }

    t.phases = (t.phases || []).concat(newPhases);
    t.updated = now();
    stampWriter(t);
  taskLib.writeTaskJson(taskDirAbs, t);
    renderStateMd(taskDirAbs, t, projectDir);
    return t;
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());

  const summary = phases.map((p) => `${p.id} (${p.name})`).join(", ");
  return { count: phases.length, summary, totalPhases: (task.phases || []).length };
}

// ---------------------------------------------------------------------------
// state_flag
// ---------------------------------------------------------------------------

function addFlag(projectDir, taskDir, phaseId, type, message) {
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  const id = `f-${phaseId}-${Date.now()}`;

  const task = withLock(taskDirAbs, lockHolder, () => {
    const t = taskLib.loadTask(taskDirAbs);
    const phase = (t.phases || []).find((p) => p.id === phaseId);
    if (!phase) {
      throw new Error(
        `Phase ${phaseId} not found. Available phases: ${(t.phases || []).map((p) => p.id).join(", ")}`
      );
    }
    t.flags = t.flags || [];
    t.flags.push({ id, phase: phaseId, type, message, raised: now() });
    stampWriter(t);
  taskLib.writeTaskJson(taskDirAbs, t);
    renderStateMd(taskDirAbs, t, projectDir);
    return t;
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());
  return { id, phaseId, type, flagCount: (task.flags || []).length };
}

// ---------------------------------------------------------------------------
// state_clear_flag
// ---------------------------------------------------------------------------

function clearFlag(projectDir, taskDir, flagId) {
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);

  const task = withLock(taskDirAbs, lockHolder, () => {
    const t = taskLib.loadTask(taskDirAbs);
    t.flags = t.flags || [];
    const idx = t.flags.findIndex((f) => f.id === flagId);
    if (idx === -1) {
      throw new Error(
        `No flag with id "${flagId}". ` +
        `Current flag ids: ${t.flags.map((f) => f.id).join(", ") || "(none)"}`
      );
    }
    t.flags.splice(idx, 1);
    stampWriter(t);
  taskLib.writeTaskJson(taskDirAbs, t);
    renderStateMd(taskDirAbs, t, projectDir);
    return t;
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());
  return { flagId, remainingFlags: (task.flags || []).length };
}

// ---------------------------------------------------------------------------
// state_read
// ---------------------------------------------------------------------------

function readStateRaw(projectDir, taskDir) {
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  return taskLib.loadTask(taskDirAbs);
}

// ---------------------------------------------------------------------------
// state_prime (D33: always returns `a next` JSON for v2 tasks)
// ---------------------------------------------------------------------------

function primeState(projectDir, taskDir) {
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  const task = taskLib.loadTask(taskDirAbs);
  const policy = resolvePolicy(projectDir);
  return { format: "json", data: computeNext(task, { projectDir, policy, taskDir: taskDirAbs }) };
}

// ---------------------------------------------------------------------------
// state_next (v2 only)
// ---------------------------------------------------------------------------

function nextState(projectDir, taskDir) {
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  const task = taskLib.loadTask(taskDirAbs);
  const policy = resolvePolicy(projectDir);
  return computeNext(task, { projectDir, policy, taskDir: taskDirAbs });
}

// ---------------------------------------------------------------------------
// task_set (v2 only)
// ---------------------------------------------------------------------------

function setKnob(projectDir, taskDir, knob, value) {
  const taskDirAbs = resolveTaskDirAbs(projectDir, taskDir);
  if (ENUM_KNOBS[knob] && !ENUM_KNOBS[knob].includes(value)) {
    throw new Error(`Invalid value for knob "${knob}": "${value}". Must be one of: ${ENUM_KNOBS[knob].join(", ")}.`);
  }
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const sid = getMcpSessionId();
  const result = withLock(taskDirAbs, lockHolder, () => {
    const task = taskLib.loadTask(taskDirAbs);

    if (knob === "mode") {
      task.mode = value;
    } else if (knob === "tier") {
      task.tier = value;
    } else if (knob === "parallel") {
      task.knobs = task.knobs || { ...taskLib.DEFAULT_KNOBS };
      task.knobs.parallel = parseInt(value, 10);
    } else if (knob === "review_plan" || knob === "review_code") {
      task.knobs = task.knobs || { ...taskLib.DEFAULT_KNOBS };
      task.knobs[knob] = value === "true" || value === "1";
    } else {
      task.knobs = task.knobs || { ...taskLib.DEFAULT_KNOBS };
      task.knobs[knob] = value;
    }

    // Record knob history (shared by CLI and MCP).
    task.knob_history = task.knob_history || [];
    task.knob_history.push({ knob, value, by: sid, at: now() });

    stampWriter(task);
  taskLib.writeTaskJson(taskDirAbs, task);
    renderStateMd(taskDirAbs, task, projectDir);
    return { knob, value: task.knobs ? task.knobs[knob] : task.mode };
  });
  rebuildTasksIndex(projectDir, getMcpSessionId());
  return result;
}

module.exports = {
  OWNER_VALUES,
  getMcpSessionId,
  initState,
  updateState,
  addPhases,
  addFlag,
  clearFlag,
  readStateRaw,
  primeState,
  nextState,
  setKnob,
};
