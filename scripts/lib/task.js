"use strict";

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { tasksRoot } = require("./tasks-root");
const { LEGACY_STATUS_MAP, PHASE_STATUSES } = require("./transitions");

// ---------------------------------------------------------------------------
// v2 schema constants
// ---------------------------------------------------------------------------

const SCHEMA_V2 = 2;

const DEFAULT_KNOBS = {
  review_plan: true,
  review_code: true,
  approve: "ask",
  commit: "per_phase",
  parallel: 3,
  enforcement: "deny",
  land: "per_phase",
};

const AGENT_REPORT_KEYS = ["explorer", "builder", "reviewer", "committer", "consolidator"];

const VALID_TIERS = ["strategic", "standard", "minor"];

function emptyCounters() {
  return { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 };
}

function emptyReports() {
  return { explorer: null, builder: null, reviewer: null, committer: null, consolidator: null };
}

// ---------------------------------------------------------------------------
// v2 read / write
// ---------------------------------------------------------------------------

function taskJsonPath(taskDir) {
  return path.join(taskDir, "task.json");
}

function stateJsonPath(taskDir) {
  return path.join(taskDir, "state.json");
}

function isMigrated(taskDir) {
  return fs.existsSync(taskJsonPath(taskDir));
}

function readTaskJson(taskDir) {
  const p = taskJsonPath(taskDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeTaskJson(taskDir, task) {
  task.updated = new Date().toISOString();
  fs.writeFileSync(taskJsonPath(taskDir), JSON.stringify(task, null, 2), "utf8");
}

/**
 * Unified read entry point (D33): every reader/writer goes through here.
 * Returns the v2 task.json. If task.json is absent but a v1 state.json exists,
 * migrates it on first touch (rename → state.json.v1), then reads task.json.
 * Throws a clear error (notFound or malformed) when neither file is usable.
 */
function loadTask(taskDir) {
  if (fs.existsSync(taskJsonPath(taskDir))) {
    return readTaskJson(taskDir);
  }
  if (fs.existsSync(stateJsonPath(taskDir))) {
    const result = migrateTask(taskDir, { dryRun: false });
    if (result.migrated || (result.skipped && result.reason === "already-migrated")) {
      return readTaskJson(taskDir);
    }
    const sp = stateJsonPath(taskDir);
    const err = new Error(
      `state.json at ${sp} is malformed (missing phases/flags arrays); ` +
      "fix it or remove it, then run `a task migrate --apply`."
    );
    err.malformed = true;
    throw err;
  }
  const err = new Error(`task.json not found at ${taskDir}. Run state_init first.`);
  err.notFound = true;
  throw err;
}

// ---------------------------------------------------------------------------
// Migration: state.json v1 → task.json v2
// ---------------------------------------------------------------------------

/**
 * Parse task.md frontmatter to extract title, slug, number, created date.
 */
function parseTaskMd(taskMdPath) {
  if (!fs.existsSync(taskMdPath)) return { title: "", slug: "", created: "", body: "" };
  const raw = fs.readFileSync(taskMdPath, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let frontmatter = {};
  let body = raw;
  if (fmMatch) {
    const fmText = fmMatch[1];
    body = fmMatch[2];
    for (const line of fmText.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) frontmatter[m[1]] = m[2];
    }
  }
  const titleMatch = body.match(/^#\s+(.+)$/m);
  return {
    title: frontmatter.task || (titleMatch ? titleMatch[1] : ""),
    slug: frontmatter.slug || "",
    created: frontmatter.created || "",
    status: frontmatter.status || "",
    body,
    raw,
  };
}

/**
 * Remove the Status column from the phases table in task.md.
 * Returns the updated markdown, or the original if no table found.
 */
function removeStatusColumn(md) {
  const lines = md.split("\n");
  let tableStart = -1;
  let tableEnd = -1;
  let statusColIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*#\s*\|/.test(lines[i])) {
      const headers = parseTableRow(lines[i]);
      const statusIdx = headers.findIndex((h) => h.trim().toLowerCase() === "status");
      if (statusIdx >= 0) {
        tableStart = i;
        statusColIdx = statusIdx;
        break;
      }
    }
  }
  if (tableStart < 0 || statusColIdx < 0) return md;

  // Find table end (first non-table line after start)
  for (let i = tableStart + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) {
      tableEnd = i;
      break;
    }
  }
  if (tableEnd < 0) tableEnd = lines.length;

  // Rebuild each row without the status column
  const result = lines.slice();
  for (let i = tableStart; i < tableEnd; i++) {
    if (!result[i].trim().startsWith("|")) continue;
    const cells = parseTableRow(result[i]);
    cells.splice(statusColIdx, 1);
    result[i] = "| " + cells.join(" | ") + " |";
  }
  return result.join("\n");
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((c) => c.trim());
}

/**
 * Extract status values from the phases table before removing the column.
 * Returns a map of phaseId → status string (or null if no table).
 */
function extractStatusColumn(md) {
  const lines = md.split("\n");
  let tableStart = -1;
  let statusColIdx = -1;
  let idColIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*#\s*\|/.test(lines[i])) {
      const headers = parseTableRow(lines[i]);
      const statusIdx = headers.findIndex((h) => h.trim().toLowerCase() === "status");
      if (statusIdx >= 0) {
        tableStart = i;
        statusColIdx = statusIdx;
        idColIdx = headers.findIndex((h) => h.trim() === "#");
        break;
      }
    }
  }
  if (tableStart < 0 || statusColIdx < 0) return null;

  const statuses = {};
  for (let i = tableStart + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) break;
    const cells = parseTableRow(lines[i]);
    const phaseId = parseInt((cells[idColIdx] || "").trim(), 10);
    if (Number.isInteger(phaseId)) {
      statuses[phaseId] = (cells[statusColIdx] || "").trim();
    }
  }
  return statuses;
}

/**
 * Map an emoji or text status from the task.md table to a v2 phase status.
 * Returns null if the status is empty or can't be mapped.
 */
function mapEmojiStatus(emoji) {
  if (!emoji) return null;
  const map = {
    "⬜": "not_started",
    "📋": "planned",
    "⭐": "reviewed",
    "🔄": "in_progress",
    "✅": "done",
  };
  for (const [k, v] of Object.entries(map)) {
    if (emoji.includes(k)) return v;
  }
  // Try text matching
  const lower = emoji.toLowerCase();
  for (const s of PHASE_STATUSES) {
    if (lower.includes(s)) return s;
  }
  // Legacy statuses
  for (const [k, v] of Object.entries(LEGACY_STATUS_MAP)) {
    if (lower.includes(k)) return v;
  }
  return null;
}

/**
 * Map a v1 state.json status to a v2 status (D29).
 */
function mapV1Status(status) {
  if (!status) return "planning";
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  if (TASK_STATUSES_V2.includes(status)) return status;
  return "planning";
}

const TASK_STATUSES_V2 = ["planning", "in_progress", "done", "failed"];

/**
 * Convert a v1 state.json phase to a v2 task.json phase.
 */
function convertPhase(v1Phase, v2StatusFromMd) {
  let status = v1Phase.status || "not_started";
  // If we have a status from the task.md table, prefer it if it's more specific
  if (v2StatusFromMd) {
    status = v2StatusFromMd;
  }
  // Map legacy statuses
  if (LEGACY_STATUS_MAP[status]) {
    status = LEGACY_STATUS_MAP[status];
  }

  const phase = {
    id: v1Phase.id,
    name: v1Phase.name,
    status,
    owner: v1Phase.owner,
    blocked_by: v1Phase.blocked_by || [],
    parallel_group: v1Phase.parallel_group || "",
    plan_path: "",
    manifest: [],
    note: "",
    reports: emptyReports(),
    commits: [],
    branch: "",
    counters: emptyCounters(),
    started: v1Phase.started || "",
    completed: v1Phase.completed || "",
    landed_sha: null,
    warnings: [],
    conflict: null,
  };

  // If the phase has a plan_path in execution, try to carry it
  if (v1Phase.execution && v1Phase.execution.agent_type) {
    phase.owner = phase.owner || v1Phase.execution.agent_type;
  }

  return phase;
}

/**
 * Migrate a single task directory from state.json v1 to task.json v2.
 * Idempotent: if task.json already exists, returns { skipped: true }.
 *
 * When options.dryRun is true, reports what would change without writing.
 * When options.dryRun is false (default), writes task.json, backs up task.md
 * to task.md.v1 before editing it, and removes the status column.
 *
 * @param {string} taskDir - Absolute path to the task directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, report only; write nothing
 * @returns {{ migrated: boolean, skipped: boolean, slug: string, flags: string[], changes?: string[], backup?: string }}
 */
function migrateTask(taskDir, options = {}) {
  const { dryRun = false } = options;
  const taskJson = taskJsonPath(taskDir);
  if (fs.existsSync(taskJson)) {
    // Already migrated. D33 cleanup: if a stale state.json still sits beside
    // task.json (the A3 coexistence state), rename it to state.json.v1 so the
    // split-brain ends. Idempotent: a second run finds no state.json.
    const staleState = stateJsonPath(taskDir);
    let renamed = false;
    if (fs.existsSync(staleState) && !dryRun) {
      const v1Dest = path.join(taskDir, "state.json.v1");
      // Don't clobber an existing state.json.v1 backup.
      if (!fs.existsSync(v1Dest)) fs.renameSync(staleState, v1Dest);
      else fs.unlinkSync(staleState);
      renamed = true;
    }
    return { migrated: false, skipped: true, reason: "already-migrated", renamed, slug: path.basename(taskDir) };
  }

  const statePath = stateJsonPath(taskDir);
  const taskMdPath = path.join(taskDir, "task.md");
  const backupPath = path.join(taskDir, "task.md.v1");

  // Read v1 state.json (if it doesn't exist, create a minimal v2 from task.md)
  let v1State = null;
  if (fs.existsSync(statePath)) {
    v1State = JSON.parse(fs.readFileSync(statePath, "utf8"));
  }

  // D33: validate v1 structure before touching anything. A malformed state.json
  // (valid JSON but missing phases/flags arrays) is skipped entirely — never
  // written, never renamed — so loadTask/rebuildTasksIndex callers leave it
  // byte-for-byte unchanged and surface a clear error.
  if (v1State && (!Array.isArray(v1State.phases) || !Array.isArray(v1State.flags))) {
    return { migrated: false, skipped: true, reason: "malformed", slug: path.basename(taskDir) };
  }

  // Parse task.md for title, number, and status column
  const md = parseTaskMd(taskMdPath);
  const dirName = path.basename(taskDir);
  const numberMatch = dirName.match(/^(\d{3})(?:-|$)/);
  const number = numberMatch ? parseInt(numberMatch[1], 10) : 0;

  // Extract statuses from the task.md phases table
  const mdStatuses = md.raw ? extractStatusColumn(md.raw) : null;

  // Determine what would change (for dry-run reporting)
  const changes = [];
  if (fs.existsSync(statePath)) {
    changes.push("state.json → task.json");
  }
  if (mdStatuses) {
    changes.push("task.md: status column removed");
  }

  if (dryRun) {
    return {
      migrated: false,
      skipped: false,
      dryRun: true,
      slug: dirName,
      changes,
    };
  }

  // Build v2 phases
  const phases = (v1State && v1State.phases ? v1State.phases : []).map((p) => {
    const mdStatus = mdStatuses ? mapEmojiStatus(mdStatuses[p.id] || "") : null;
    return convertPhase(p, mdStatus);
  });

  // Map task-level status
  const v1Status = v1State ? v1State.status : "planning";
  let taskStatus = mapV1Status(v1Status);

  // Build flags
  const flags = [];
  if (v1State && Array.isArray(v1State.flags)) {
    for (const f of v1State.flags) {
      flags.push(f);
    }
  }
  // If v1 status was needs_human, add a needs_human flag
  if (v1Status === "needs_human") {
    flags.push({
      id: `f-migrate-${Date.now()}`,
      phase: 0,
      type: "needs_human",
      message: "Migrated from v1 needs_human status",
      raised: new Date().toISOString(),
    });
  }

  // Build v2 task.json
  const task = {
    schema: SCHEMA_V2,
    slug: (v1State && v1State.task) || md.slug || dirName,
    number,
    title: md.title || dirName,
    status: taskStatus,
    mode: (v1State && v1State.mode) || "full",
    knobs: { ...DEFAULT_KNOBS },
    binding: (v1State && v1State.binding) || {},
    lease: (v1State && v1State.lease) || {},
    last_writer: (v1State && v1State.last_writer) || {},
    phases,
    worktree_path: "",
    checkpoints: [],
    flags,
    created: md.created || (v1State && v1State.updated) || new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  // Write task.json
  writeTaskJson(taskDir, task);

  // Render state.md on --apply (A3 follow-up: migrate renders).
  // Lazy require avoids a circular dependency (render.js imports from task.js).
  try {
    require("./render").renderStateMd(taskDir, task, taskDir);
  } catch {}

  // D33: retire state.json — rename to state.json.v1 (kept, never read).
  // Done after task.json + state.md are written so a crash here leaves the
  // task readable; the rename is the irrevocable step that ends the split.
  if (fs.existsSync(statePath)) {
    fs.renameSync(statePath, path.join(taskDir, "state.json.v1"));
  }

  // Back up task.md before editing, then remove status column
  let backup = null;
  if (md.raw) {
    const updatedMd = removeStatusColumn(md.raw);
    if (updatedMd !== md.raw) {
      fs.writeFileSync(backupPath, md.raw, "utf8");
      backup = "task.md.v1";
      fs.writeFileSync(taskMdPath, updatedMd, "utf8");
    }
  }

  return {
    migrated: true,
    skipped: false,
    slug: dirName,
    flags: flags.map((f) => f.type),
    backup,
  };
}

/**
 * Migrate all tasks under a project root's .tasks/ directory.
 * @param {string} projectDir - Absolute path to the project root (contains .tasks/)
 * @param {object} [options] - Passed through to migrateTask
 * @param {boolean} [options.dryRun=false] - If true, report only; write nothing
 * @returns {{ migrated: number, skipped: number, details: object[] }}
 */
function migrateAll(projectDir, options = {}) {
  const tasksDir = path.resolve(projectDir, ".tasks");
  if (!fs.existsSync(tasksDir)) {
    return { migrated: 0, skipped: 0, details: [] };
  }

  // D35: after v1→v2 migration, tasks live at the central root, not repo-local.
  // This function still handles the v1→v2 step for a repo-local .tasks/ that
  // has not been moved yet. The central move is handled by migrateToCentral.

  const details = [];
  let migrated = 0;
  let skipped = 0;

  for (const name of fs.readdirSync(tasksDir)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(tasksDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const stateJson = stateJsonPath(dir);
    const taskJson = taskJsonPath(dir);
    // Only migrate dirs that have state.json (or task.json already)
    if (!fs.existsSync(stateJson) && !fs.existsSync(taskJson)) continue;

    try {
      const result = migrateTask(dir, options);
      if (result.migrated) migrated++;
      else if (result.dryRun) migrated++;
      else skipped++;
      details.push(result);
    } catch (err) {
      details.push({ migrated: false, skipped: false, error: err.message, slug: name });
    }
  }

  return { migrated, skipped, details };
}

// ---------------------------------------------------------------------------
// v1 createTask (unchanged for backward compatibility)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v2 createTask — writes task.json (D33: no state.json)
// ---------------------------------------------------------------------------

function createTask({ repo, title, slug, mode, tier, phases, description, session_id }) {
  const sid = session_id || `pid-${process.pid}`;

  // D38 item 5: ensure the repo is migrated before creating a task.
  // Without this, nextTaskNumber sees a half-moved repo (local .tasks/
  // still present) and restarts numbering at 001 in the central root.
  // Propagate the refusal exactly like resolveTaskDir does.
  try {
    require("./tasks-root").ensureMigrated(repo);
  } catch (err) {
    if (err.refused || err.failClosed) throw err;
  }

  const tDir = tasksRoot(repo);
  if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });
  const holder = { session_id: sid, pid: process.pid };

  const result = withLock(tDir, holder, () => {
    const number = nextTaskNumber(tDir);
    const paddedNumber = String(number).padStart(3, "0");
    const dirName = slug ? `${paddedNumber}-${slug}` : `${paddedNumber}`;
    const taskDir = path.join(tDir, dirName);

    try {
      fs.mkdirSync(taskDir);
    } catch (err) {
      if (err.code === "EEXIST") {
        const e = new Error(`Task directory already exists: ${taskDir}`);
        e.code = "EEXIST";
        throw e;
      }
      throw err;
    }

    const taskMd = renderTaskMd({ number, slug, title, description });
    fs.writeFileSync(path.join(taskDir, "task.md"), taskMd, "utf8");

    const now_iso = new Date().toISOString();
    // D15: fast mode (Courier) creates one phase named after the title,
    // status not_started, with knobs review_plan/review_code false and
    // approve auto. Without this, the task has zero phases, `a next` has
    // nothing to land or close, and courier-stop is a no-op.
    const isFast = mode === "fast";
    const effectivePhases = (phases && phases.length > 0)
      ? phases
      : isFast
        ? [{ id: 1, name: title, blocked_by: [] }]
        : (phases || []);
    const effectiveKnobs = isFast
      ? { ...DEFAULT_KNOBS, review_plan: false, review_code: false, approve: "auto" }
      : { ...DEFAULT_KNOBS };
    const task = {
      schema: SCHEMA_V2,
      slug: slug || dirName,
      number,
      title,
      status: "planning",
      mode: mode || "full",
      tier: VALID_TIERS.includes(tier) ? tier : (isFast ? "minor" : "standard"),
      knobs: effectiveKnobs,
      binding: {},
      lease: {},
      last_writer: {},
      phases: effectivePhases.map((p) => ({
        id: p.id,
        name: p.name,
        status: "not_started",
        owner: null,
        blocked_by: p.blocked_by || [],
        parallel_group: p.parallel_group ?? "",
        plan_path: "",
        manifest: [],
        note: "",
        reports: emptyReports(),
        commits: [],
        branch: "",
        counters: emptyCounters(),
        started: null,
        completed: null,
        landed_sha: null,
        warnings: [],
        conflict: null,
      })),
      worktree_path: "",
      checkpoints: [],
      flags: [],
      created: now_iso.slice(0, 10),
      updated: now_iso,
    };
    writeTaskJson(taskDir, task);
    try { require("./render").renderStateMd(taskDir, task, repo.main_root); } catch {}

    return { task_dir: taskDir, slug: dirName, number };
  });

  try {
    require("./render").rebuildTasksIndex(repo.main_root, sid);
  } catch {}

  // D35: update root index.json with this repo's main_root
  try {
    const { updateRootIndex } = require("./tasks-root");
    updateRootIndex(repo.key, { main_root: repo.main_root });
  } catch {}

  return result;
}

function nextTaskNumber(tasksDir) {
  const numbers = [];
  if (fs.existsSync(tasksDir)) {
    for (const name of fs.readdirSync(tasksDir)) {
      if (name.startsWith(".")) continue;
      const match = name.match(/^(\d{3})(?:-|$)/);
      if (match) numbers.push(parseInt(match[1], 10));
    }
  }
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

function renderTaskMd({ number, slug, title, description }) {
  const lines = [
    `---`,
    `task: ${title}`,
    `slug: ${slug || ""}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `status: planning`,
    `---`,
    ``,
    `# ${title}`,
    ``,
  ];
  if (description) {
    lines.push(description, "");
  }
  lines.push("## Phases", "", "| # | Phase | Notes |", "|---|---|---|", "", "## Decision Log", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// v2 update helpers (extracted from state-server thin-wrapper)
// ---------------------------------------------------------------------------

/**
 * Map a legacy task status to its v2 equivalent.
 * @param {string} status - Legacy status (blocked, needs_human, review_ready)
 * @returns {string} Mapped v2 status, or the original if not a legacy status
 */
function mapLegacyTaskStatus(status) {
  return LEGACY_STATUS_MAP[status] || status;
}

/**
 * Apply field updates to a phase object (owner, started, completed,
 * blocked_by, parallel_group). Only applies fields that are defined.
 * @param {object} phase - The phase to mutate
 * @param {object} updates - { owner, started, completed, blocked_by, parallel_group }
 */
function applyPhaseFields(phase, updates) {
  const { owner, started, completed, blocked_by, parallel_group } = updates;
  if (owner !== undefined) phase.owner = owner;
  if (started === true) phase.started = new Date().toISOString();
  if (completed === true) phase.completed = new Date().toISOString();
  if (blocked_by !== undefined) phase.blocked_by = blocked_by;
  if (parallel_group !== undefined) phase.parallel_group = parallel_group;
}

/**
 * Auto-complete a task when all phases are done/failed/skipped.
 * Only fires when the caller did not explicitly set task_status.
 * @param {object} task - The task.json object (mutated in place)
 * @param {boolean} taskStatusWasSet - Whether task_status was explicitly provided
 */
function autoCompleteTask(task, taskStatusWasSet) {
  if (taskStatusWasSet) return;
  const TERMINAL = ["done", "landed", "failed", "skipped"];
  const allDone = (task.phases || []).every((p) => TERMINAL.includes(p.status));
  if (allDone && task.status !== "done") task.status = "done";
}

// ---------------------------------------------------------------------------
// Done predicate (D36): every phase landed/failed/skipped, never task.status
// ---------------------------------------------------------------------------

const TERMINAL_PHASE_STATUSES = ["landed", "failed", "skipped", "done"];

function isTaskDone(task) {
  const phases = task.phases || [];
  if (phases.length === 0) return false;
  return phases.every((p) => TERMINAL_PHASE_STATUSES.includes(p.status));
}

/**
 * Compute the disposition for a done task by its tier (D36).
 * Returns "archive" or "delete".
 */
function taskDisposition(task) {
  const tier = task.tier || "standard";
  const consolidatorReport = (task.phases || [])
    .flatMap((p) => p.reports ? [p.reports.consolidator] : [])
    .find((r) => r && Array.isArray(r.distilled_to));
  const hasDistilled = consolidatorReport && consolidatorReport.distilled_to.length > 0;

  if (tier === "strategic") {
    if (!hasDistilled) return { action: "refuse", reason: "strategic task requires consolidation before close" };
    return { action: "archive" };
  }
  if (tier === "standard") {
    return hasDistilled ? { action: "archive" } : { action: "delete" };
  }
  // minor
  return { action: "delete" };
}

/**
 * Close a task by its tier rule (D36). Moves to archive or deletes.
 * Does not change task.status — close keys off phases, not status.
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {object} opts.repoKeyObj - Result of repoKey()
 * @returns {{ action: "archive"|"delete", archivePath?: string }}
 */
function closeTask({ taskDir, repoKeyObj }) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };

  return withLock(taskDir, holder, () => {
    const task = readTaskJson(taskDir);
    if (!task) throw new Error(`task.json not found at ${taskDir}`);

    if (!isTaskDone(task)) {
      throw new Error("Task is not done — every phase must be landed/failed/skipped before close");
    }

    const disp = taskDisposition(task);
    if (disp.action === "refuse") throw new Error(disp.reason);

    const { archiveRoot, updateRootIndex } = require("./tasks-root");

    if (disp.action === "delete") {
      const { trashDir } = require("./trash");
      const trashedTo = trashDir(taskDir, repoKeyObj.key);
      updateRootIndex(repoKeyObj.key, { disposition: "deleted" });
      return { action: "delete", trashed_to: trashedTo };
    }

    // archive
    const { trashDir } = require("./trash");
    const archiveBase = path.join(archiveRoot(), repoKeyObj.key);
    fs.mkdirSync(archiveBase, { recursive: true });
    const dirName = path.basename(taskDir);
    const archivePath = path.join(archiveBase, dirName);
    if (fs.existsSync(archivePath)) trashDir(archivePath, repoKeyObj.key);
    fs.renameSync(taskDir, archivePath);

    updateRootIndex(repoKeyObj.key, { disposition: "archived" });

    return { action: "archive", archivePath };
  });
}

module.exports = {
  createTask,
  nextTaskNumber,
  renderTaskMd,
  SCHEMA_V2,
  DEFAULT_KNOBS,
  VALID_TIERS,
  TERMINAL_PHASE_STATUSES,
  migrateTask,
  migrateAll,
  readTaskJson,
  writeTaskJson,
  loadTask,
  isMigrated,
  taskJsonPath,
  stateJsonPath,
  parseTaskMd,
  removeStatusColumn,
  extractStatusColumn,
  mapEmojiStatus,
  mapV1Status,
  convertPhase,
  emptyCounters,
  emptyReports,
  mapLegacyTaskStatus,
  applyPhaseFields,
  autoCompleteTask,
  isTaskDone,
  taskDisposition,
  closeTask,
};
