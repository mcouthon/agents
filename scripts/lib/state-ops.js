"use strict";

/**
 * State operation business logic for the MCP server.
 * Each function encapsulates the logic a handler previously held inline,
 * including the v1 (state.json) vs v2 (task.json) difference so the handler
 * never branches on schema version. The handler is left as schema + delegate
 * + format output.
 */

const fs = require("fs");
const path = require("path");
const store = require("./store");
const taskLib = require("./task");
const { withLock } = require("./lock");
const { applyTransition } = require("./transitions");
const { computeNext } = require("./next");
const { renderStateMd, rebuildTasksIndex } = require("./render");
const { resolvePolicy } = require("./policy");
const sessionLib = require("./session");

const OWNER_VALUES = ["explorer", "builder", "reviewer", "committer", null];

const ENUM_KNOBS = {
  approve: ["ask", "auto"],
  commit: ["per_phase", "at_end"],
  enforcement: ["deny", "warn"],
  land: ["per_phase", "at_end"],
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

/** Write state.json atomically, stamping binding and last_writer. */
function writeStateStamped(taskDir, state, projectDir) {
  const sid = getMcpSessionId();
  state.last_writer = { session_id: sid, timestamp: now() };
  const reg = sessionLib.find({ session_id: sid });
  state.binding = { session_id: sid, pid: (reg && reg.pid) ? reg.pid : process.pid };
  store.writeState(taskDir, state, projectDir, sid);
}

function updateTasksIndex(projectDir) {
  rebuildTasksIndex(projectDir, getMcpSessionId());
}

function validateOwner(owner) {
  if (owner !== undefined && owner !== null && !OWNER_VALUES.includes(owner)) {
    throw new Error(
      `Invalid owner "${owner}". Must be one of: ${OWNER_VALUES.filter(v => v !== null).join(", ")}, or null.`
    );
  }
}

// ---------------------------------------------------------------------------
// state_init
// ---------------------------------------------------------------------------

function initState(projectDir, taskDir, slug, phases) {
  const statePath = path.resolve(projectDir, taskDir, "state.json");
  if (fs.existsSync(statePath)) {
    throw new Error(
      `state.json already exists at ${statePath}. ` +
      "Use state_update to modify existing state."
    );
  }

  const state = {
    schema_version: 1,
    task: slug,
    status: "planning",
    updated: now(),
    phases: phases.map(({ id, name, blocked_by, parallel_group }) => ({
      id,
      name,
      status: "not_started",
      owner: null,
      started: null,
      completed: null,
      blocked_by: blocked_by || [],
      parallel_group: parallel_group ?? null,
      execution: { model: null, effort: null, agent_type: null, estimated_scope: null },
    })),
    flags: [],
  };

  const phaseIds = new Set(state.phases.map((p) => p.id));
  for (const phase of state.phases) {
    for (const depId of phase.blocked_by) {
      if (!phaseIds.has(depId)) {
        throw new Error(
          `Phase ${phase.id} has blocked_by reference to non-existent phase ${depId}. ` +
          `Available phase IDs: ${[...phaseIds].join(", ")}`
        );
      }
    }
  }

  writeStateStamped(taskDir, state, projectDir);
  updateTasksIndex(projectDir);
  return { statePath, phaseCount: phases.length };
}

// ---------------------------------------------------------------------------
// state_update
// ---------------------------------------------------------------------------

function updateState(projectDir, taskDir, updates) {
  const {
    phase_id, phase_status, owner: rawOwner, task_status,
    started, completed, blocked_by, parallel_group,
    execution_model, execution_effort, execution_agent_type, execution_estimated_scope,
  } = updates;

  const owner = rawOwner === "" ? null : rawOwner;
  validateOwner(owner);

  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);

  if (taskLib.isMigrated(taskDirAbs)) {
    const result = withLock(taskDirAbs, lockHolder, () => {
      const task = taskLib.readTaskJson(taskDirAbs);
      if (!task) throw new Error("task.json not found at " + taskDirAbs);

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
        if (phase_status !== undefined) {
          applyTransition(phase, phase_status, task, { projectDir, taskDir: taskDirAbs, sessionId: getMcpSessionId() });
        }
        taskLib.applyPhaseFields(phase, { owner, started, completed, blocked_by, parallel_group });
      }

      taskLib.autoCompleteTask(task, task_status !== undefined);

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

  const state = withLock(taskDirAbs, lockHolder, () => {
    const s = store.readState(taskDir, projectDir);

    if (task_status !== undefined) {
      s.status = task_status;
    }

    if (phase_id !== undefined) {
      const phase = s.phases.find((p) => p.id === phase_id);
      if (!phase) {
        throw new Error(
          `Phase ${phase_id} not found. Available phases: ${s.phases.map((p) => p.id).join(", ")}`
        );
      }

      if (phase_status !== undefined) phase.status = phase_status;
      if (owner !== undefined) phase.owner = owner;
      if (started === true) phase.started = now();
      if (completed === true) phase.completed = now();

      if (blocked_by !== undefined) {
        const phaseIds = new Set(s.phases.map((p) => p.id));
        for (const depId of blocked_by) {
          if (!phaseIds.has(depId)) {
            throw new Error(
              `blocked_by reference to non-existent phase ${depId}. ` +
              `Available phase IDs: ${[...phaseIds].join(", ")}`
            );
          }
        }
        phase.blocked_by = blocked_by;
      }
      if (parallel_group !== undefined) phase.parallel_group = parallel_group;
      if (execution_model !== undefined) phase.execution.model = execution_model;
      if (execution_effort !== undefined) phase.execution.effort = execution_effort;
      if (execution_agent_type !== undefined) phase.execution.agent_type = execution_agent_type;
      if (execution_estimated_scope !== undefined) phase.execution.estimated_scope = execution_estimated_scope;
    }

    if (task_status === undefined) {
      const allDone = s.phases.every((p) => p.status === "done");
      if (allDone && s.status !== "done") {
        s.status = "done";
      }
    }

    s.updated = now();
    writeStateStamped(taskDir, s, projectDir);
    return s;
  });
  updateTasksIndex(projectDir);

  const updatedPhase = phase_id !== undefined
    ? state.phases.find((p) => p.id === phase_id)
    : null;
  const summary = updatedPhase
    ? `Phase ${updatedPhase.id} (${updatedPhase.name}): status=${updatedPhase.status}, owner=${updatedPhase.owner}`
    : `Task status: ${state.status}`;
  return { file: "state.json", summary };
}

// ---------------------------------------------------------------------------
// state_add_phases
// ---------------------------------------------------------------------------

function addPhases(projectDir, taskDir, phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("phases must contain at least one phase.");
  }

  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
  const state = withLock(taskDirAbs, lockHolder, () => {
    const s = store.readState(taskDir, projectDir);

    const existingIds = new Set(s.phases.map((p) => p.id));
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
      started: null,
      completed: null,
      blocked_by: blocked_by || [],
      parallel_group: parallel_group ?? null,
      execution: { model: null, effort: null, agent_type: null, estimated_scope: null },
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

    s.phases.push(...newPhases);
    s.updated = now();
    writeStateStamped(taskDir, s, projectDir);
    return s;
  });
  updateTasksIndex(projectDir);

  const summary = phases.map((p) => `${p.id} (${p.name})`).join(", ");
  return { count: phases.length, summary, totalPhases: state.phases.length };
}

// ---------------------------------------------------------------------------
// state_flag
// ---------------------------------------------------------------------------

function addFlag(projectDir, taskDir, phaseId, type, message) {
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
  const id = `f-${phaseId}-${Date.now()}`;

  // v2: flags live in task.json (unified with `a land`, which writes task.flags).
  if (taskLib.isMigrated(taskDirAbs)) {
    const task = withLock(taskDirAbs, lockHolder, () => {
      const t = taskLib.readTaskJson(taskDirAbs);
      if (!t) throw new Error("task.json not found at " + taskDirAbs);
      const phase = (t.phases || []).find((p) => p.id === phaseId);
      if (!phase) {
        throw new Error(
          `Phase ${phaseId} not found. Available phases: ${(t.phases || []).map((p) => p.id).join(", ")}`
        );
      }
      t.flags = t.flags || [];
      t.flags.push({ id, phase: phaseId, type, message, raised: now() });
      taskLib.writeTaskJson(taskDirAbs, t);
      renderStateMd(taskDirAbs, t, projectDir);
      return t;
    });
    updateTasksIndex(projectDir);
    return { id, phaseId, type, flagCount: (task.flags || []).length };
  }

  const state = withLock(taskDirAbs, lockHolder, () => {
    const s = store.readState(taskDir, projectDir);

    const phase = s.phases.find((p) => p.id === phaseId);
    if (!phase) {
      throw new Error(
        `Phase ${phaseId} not found. Available phases: ${s.phases.map((p) => p.id).join(", ")}`
      );
    }

    const flag = { id, phase: phaseId, type, message, raised: now() };
    s.flags.push(flag);
    s.updated = now();
    writeStateStamped(taskDir, s, projectDir);
    return s;
  });
  updateTasksIndex(projectDir);
  return { id, phaseId, type, flagCount: state.flags.length };
}

// ---------------------------------------------------------------------------
// state_clear_flag
// ---------------------------------------------------------------------------

function clearFlag(projectDir, taskDir, flagId) {
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);

  // v2: flags live in task.json (unified store with `a land`).
  if (taskLib.isMigrated(taskDirAbs)) {
    const task = withLock(taskDirAbs, lockHolder, () => {
      const t = taskLib.readTaskJson(taskDirAbs);
      if (!t) throw new Error("task.json not found at " + taskDirAbs);
      t.flags = t.flags || [];
      const idx = t.flags.findIndex((f) => f.id === flagId);
      if (idx === -1) {
        throw new Error(
          `No flag with id "${flagId}". ` +
          `Current flag ids: ${t.flags.map((f) => f.id).join(", ") || "(none)"}`
        );
      }
      t.flags.splice(idx, 1);
      taskLib.writeTaskJson(taskDirAbs, t);
      renderStateMd(taskDirAbs, t, projectDir);
      return t;
    });
    updateTasksIndex(projectDir);
    return { flagId, remainingFlags: (task.flags || []).length };
  }

  const state = withLock(taskDirAbs, lockHolder, () => {
    const s = store.readState(taskDir, projectDir);

    const idx = s.flags.findIndex((f) => f.id === flagId);
    if (idx === -1) {
      throw new Error(
        `No flag with id "${flagId}". ` +
        `Current flag ids: ${s.flags.map((f) => f.id).join(", ") || "(none)"}`
      );
    }

    s.flags.splice(idx, 1);
    s.updated = now();
    writeStateStamped(taskDir, s, projectDir);
    return s;
  });
  updateTasksIndex(projectDir);
  return { flagId, remainingFlags: state.flags.length };
}

// ---------------------------------------------------------------------------
// state_read
// ---------------------------------------------------------------------------

function readStateRaw(projectDir, taskDir) {
  return store.readState(taskDir, projectDir);
}

// ---------------------------------------------------------------------------
// state_prime
// ---------------------------------------------------------------------------

function primeState(projectDir, taskDir) {
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);

  if (taskLib.isMigrated(taskDirAbs)) {
    const task = taskLib.readTaskJson(taskDirAbs);
    if (task) {
      const policy = resolvePolicy(projectDir);
      return { format: "json", data: computeNext(task, { projectDir, policy, taskDir: taskDirAbs }) };
    }
  }

  const state = store.readState(taskDir, projectDir);
  const doneCount = state.phases.filter((p) => p.status === "done").length;
  const total = state.phases.length;

  const current = state.phases.find((p) => p.status !== "done");
  const currentStr = current
    ? `Phase ${current.id} (${current.name}) -- ${current.status}, ${current.owner || "unowned"}`
    : "All phases complete";

  const blocked = state.phases.filter(
    (p) => p.status !== "done" && p.blocked_by && p.blocked_by.length > 0 &&
      p.blocked_by.some((depId) => {
        const dep = state.phases.find((d) => d.id === depId);
        return dep && dep.status !== "done";
      })
  );
  const blockerStr = blocked.length > 0
    ? blocked.map((p) => `Phase ${p.id} (blocked by ${p.blocked_by.join(",")})`).join("; ")
    : "None";

  const flagCount = state.flags.length;
  const flagStr = flagCount > 0
    ? `${flagCount} active (${state.flags.map((f) => `${f.type}:phase${f.phase}`).join(", ")})`
    : "None";

  const currentIdx = current ? state.phases.indexOf(current) : -1;
  const upcoming = currentIdx >= 0
    ? state.phases.slice(currentIdx + 1).filter((p) => p.status !== "done")
    : [];

  const nextGroup = upcoming.length > 0 && upcoming[0].parallel_group
    ? upcoming.filter((p) => p.parallel_group === upcoming[0].parallel_group)
    : [];

  const nextStr = nextGroup.length > 1
    ? `Phases ${nextGroup.map((p) => p.id).join("+")} (${nextGroup.map((p) => p.name).join(", ")}) in parallel group ${nextGroup[0].parallel_group}`
    : upcoming.length > 0
      ? `Phase ${upcoming[0].id} (${upcoming[0].name})`
      : "None";

  const prime = [
    `Task: ${state.task} (${state.status})`,
    `Phases: ${doneCount}/${total} complete`,
    `Current: ${currentStr}`,
    `Blockers: ${blockerStr}`,
    `Flags: ${flagStr}`,
    `Next: ${nextStr}`,
  ].join("\n");

  return { format: "text", data: prime };
}

// ---------------------------------------------------------------------------
// state_next (v2 only)
// ---------------------------------------------------------------------------

function nextState(projectDir, taskDir) {
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
  if (!taskLib.isMigrated(taskDirAbs)) {
    throw new Error("task.json not found. Run `a task migrate` first.");
  }
  const task = taskLib.readTaskJson(taskDirAbs);
  if (!task) throw new Error("task.json not found at " + taskDirAbs);
  const policy = resolvePolicy(projectDir);
  return computeNext(task, { projectDir, policy, taskDir: taskDirAbs });
}

// ---------------------------------------------------------------------------
// task_set (v2 only)
// ---------------------------------------------------------------------------

function setKnob(projectDir, taskDir, knob, value) {
  const taskDirAbs = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
  if (!taskLib.isMigrated(taskDirAbs)) {
    throw new Error("task.json not found. Run `a task migrate` first.");
  }
  if (ENUM_KNOBS[knob] && !ENUM_KNOBS[knob].includes(value)) {
    throw new Error(`Invalid value for knob "${knob}": "${value}". Must be one of: ${ENUM_KNOBS[knob].join(", ")}.`);
  }
  const lockHolder = { session_id: getMcpSessionId(), pid: process.pid };
  const sid = getMcpSessionId();
  const result = withLock(taskDirAbs, lockHolder, () => {
    const task = taskLib.readTaskJson(taskDirAbs);
    if (!task) throw new Error("task.json not found at " + taskDirAbs);

    if (knob === "mode") {
      task.mode = value;
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
