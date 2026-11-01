"use strict";

/**
 * A task's declared intent, read from the agents database and never from a
 * task.json: `loadTask`/`readTaskJson` build the task-shaped view from the
 * tables (phases, checkmarks, decisions, notes, events), and the writers
 * (createTask, addPhases, checkPhase, setKnob, closeTask, decide, note) write
 * tables plus their intent event. The view carries no status word: checked,
 * skipped, the current phase and the task's status are derived on read.
 */

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { tasksRoot } = require("./tasks-root");

const SETTABLE_KNOBS = { approvals: ["ask", "none"], land: ["per_phase", "at_end"] };

const VALID_TIERS = ["strategic", "standard", "minor"];

/** Refusal with the remedy in the message, built the one way so none ships without one. */
function refusal(code, message, remedy) {
  if (!remedy) throw new Error(`refusal ${code} has no remedy`);
  const err = new Error(`${message}\nRemedy: ${remedy}`);
  err.code = code;
  err.exitCode = 2;
  err.detail = { remedy };
  return err;
}

// ---------------------------------------------------------------------------
// The view from tables
// ---------------------------------------------------------------------------

/** The row of a task dir, or null when it is outside the root or has no row. */
function taskRowOf(taskDir) {
  const db = require("./db");
  const loc = db.locate(taskDir);
  if (!loc) return null;
  return db.findTask(loc.repoKey, loc.dirName);
}

/** A task's plan folders: its central dir, plus its pending fold's until the fold runs. */
function planDirsFor(row, foldPath) {
  const dirs = [row.task_dir, foldPath].filter(Boolean).map((d) => path.join(d, "plan"));
  return [...new Set(dirs)];
}

function viewOf(row) {
  const db = require("./db");
  const derive = require("./derive");
  const fold = db.pendingFoldOf(row.id);
  const phases = db.listPhases(row.id);
  const marks = db.checkmarksOf(row.id);
  const decisions = db.listDecisions({ taskId: row.id });
  const notes = db.listNotes(row.id);
  const recency = db.intentRecency(row.id);
  const planDirs = planDirsFor(row, fold);

  const out = {
    schema: 2,
    slug: row.slug || row.dir_name,
    number: Number.isInteger(row.number) ? row.number : null,
    title: row.title || row.dir_name,
    mode: row.mode || "full",
    tier: row.tier || "standard",
    knobs: row.land ? { land: row.land } : {},
    phases: [],
    worktree_path: row.worktree_path || "",
    branch: row.branch || "",
    created: row.created || null,
    updated_at: recency.at,
    disposition: row.disposition,
    checked: [],
    skipped: [],
    all_checked: false,
    decisions,
    notes,
  };
  if (row.approvals) out.knobs.approvals = row.approvals;

  let allChecked = phases.length > 0;
  for (const ph of phases) {
    const mark = marks.get(ph.phase_id) || null;
    const skipped = decisions.some((d) => d.phase_id === ph.phase_id && d.choice === "skip");
    const checked = Boolean(mark) || skipped;
    const plan = derive.planFileFor(planDirs, ph.phase_id);
    const rel = plan.file ? path.relative(row.task_dir, plan.file) : null;
    const planPath = plan.file && rel && !rel.startsWith("..") ? rel : (plan.file || "");
    const newestNote = notes.filter((n) => n.phase_id === ph.phase_id).pop();
    out.phases.push({
      id: ph.phase_id,
      name: ph.name,
      checked,
      skipped,
      blocked_by: ph.after,
      plan_path: planPath,
      note: newestNote ? newestNote.text : "",
      checked_at: mark ? mark.checked_at : null,
      checked_by: mark ? mark.session_id : null,
    });
    if (checked) out.checked.push(ph.phase_id);
    if (skipped) out.skipped.push(ph.phase_id);
    if (!checked) allChecked = false;
  }
  if (allChecked) out.all_checked = true;
  return out;
}

/** The task-shaped view of a task dir (the one reader every verb goes through). */
function loadTask(taskDir) {
  const row = taskRowOf(taskDir);
  if (!row) {
    const err = new Error(`No task row for ${taskDir}. Pass the task dir \`a ls\` shows, or create one with \`a task new\`.`);
    err.notFound = true;
    throw err;
  }
  return viewOf(row);
}

function readTaskJson(taskDir) {
  return loadTask(taskDir);
}

/** Path of a task's task.md: its one home, the central folder. */
function taskMdPath(taskDir) {
  return path.join(taskDir, "task.md");
}

/** True when a file path names a task.md (the one place that says which file that is). */
function isTaskMd(filePath) {
  return path.basename(filePath) === "task.md";
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function renderTaskMd({ number, slug, title, description }) {
  const lines = [
    `---`,
    `task: ${title}`,
    `slug: ${slug || ""}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
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

/** The next number for a repo: 1 + the larger of the database's highest and the central folders'. */
function nextTaskNumber(repoKeyObj, tDir) {
  const db = require("./db");
  let max = 0;
  const highest = db.maxTaskNumber(repoKeyObj.key);
  if (Number.isInteger(highest)) max = highest;
  if (fs.existsSync(tDir)) {
    for (const name of fs.readdirSync(tDir)) {
      const m = name.match(/^(\d+)(?:-|$)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}

/**
 * Create a task: its row, phases and `task_new` event in the database, its
 * Markdown in the central folder only (approvals `none`), its repo registered.
 */
function createTask({ repo, title, slug, mode, tier, phases, description, session_id }) {
  const db = require("./db");
  const sid = session_id || `pid-${process.pid}`;

  const tDir = tasksRoot(repo);
  if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });
  const holder = { session_id: sid, pid: process.pid };

  const result = withLock(tDir, holder, () => {
    const number = nextTaskNumber(repo, tDir);
    const paddedNumber = String(number).padStart(3, "0");
    const dirName = slug ? `${paddedNumber}-${slug}` : `${paddedNumber}`;
    const taskDir = path.join(tDir, dirName);
    if (fs.existsSync(taskDir)) {
      const err = new Error(`Task directory already exists: ${taskDir}`);
      err.code = "EEXIST";
      throw err;
    }
    fs.mkdirSync(taskDir);
    fs.writeFileSync(taskMdPath(taskDir), renderTaskMd({ number, slug, title, description }), "utf8");

    const isFast = mode === "fast";
    const effectivePhases = (phases && phases.length > 0)
      ? phases
      : isFast
        ? [{ id: 1, name: title, blocked_by: [] }]
        : [];
    const taskId = db.createTaskRow({
      repoKey: repo.key,
      dirName,
      taskDir,
      slug: slug || dirName,
      number,
      title,
      tier: VALID_TIERS.includes(tier) ? tier : (isFast ? "minor" : "standard"),
      mode: mode || "full",
      created: new Date().toISOString().slice(0, 10),
      approvals: "none",
      land: "per_phase",
      worktreePath: null,
      branch: null,
      phases: effectivePhases.map((p, i) => ({ id: p.id, name: p.name, ord: i, after: p.blocked_by || p.after || [] })),
    });
    db.upsertRepo(repo.key, { main_root: repo.main_root });
    require("./db-export").exportTask(taskId);
    return { task_dir: taskDir, slug: dirName, number };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

const holder = () => ({ session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid });

/**
 * Upsert phases by id: a new id appends a phase that waits on `after`; an
 * existing id updates its name and after and never its checkmark.
 */
function addPhases({ taskDir, phases }) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw refusal("no_phases", "No phases given.", "pass phases as [{id, name, after: [ids]}]");
  }
  for (const p of phases) {
    if (!Number.isInteger(p.id) || typeof p.name !== "string" || !p.name) {
      throw refusal("bad_phase", `Phase ${JSON.stringify(p)} needs an integer id and a name.`, "pass phases as [{id, name, after: [ids]}]");
    }
  }
  const row = taskRowOf(taskDir);
  if (!row) throw refusal("no_task_row", `${taskDir} has no row in the agents database.`, "pass the task dir `a ls` shows");
  return withLock(taskDir, holder(), () => {
    require("./db").upsertPhases(row.id, phases.map((p) => ({
      id: p.id, name: p.name, after: Array.isArray(p.after) ? p.after : (p.blocked_by || []),
    })));
    require("./db-export").exportTask(row.id);
    const view = viewOf(require("./db").getTask(row.id));
    return { phases: view.phases.map((p) => ({ id: p.id, name: p.name, checked: p.checked, blocked_by: p.blocked_by })) };
  });
}

/** Set one of the two knobs the engine reads: `approvals` (ask|none) or `land` (per_phase|at_end). */
function setKnob({ taskDir, knob, value }) {
  const allowed = SETTABLE_KNOBS[knob];
  if (!allowed) {
    throw refusal("unknown_knob", `Unknown knob "${knob}".`, `use one of: ${Object.keys(SETTABLE_KNOBS).join(", ")}`);
  }
  if (!allowed.includes(value)) {
    throw refusal("bad_knob_value", `Knob ${knob} takes ${allowed.join(" or ")}, not "${value}".`, `pass --value ${allowed.join("|")}`);
  }
  const row = taskRowOf(taskDir);
  if (!row) throw refusal("no_task_row", `${taskDir} has no row in the agents database.`, "pass the task dir `a ls` shows");
  return withLock(taskDir, holder(), () => {
    require("./db").setTaskKnob(row.id, knob, value);
    require("./db-export").exportTask(row.id);
    return { knob, value };
  });
}

/** Mark a phase checked: the agent's claim that the phase is built. Idempotent; no uncheck. */
function checkPhase({ taskDir, phaseId }) {
  const db = require("./db");
  const row = taskRowOf(taskDir);
  if (!row) throw refusal("no_task_row", `${taskDir} has no row in the agents database.`, "pass the task dir `a ls` shows");
  return withLock(taskDir, holder(), () => {
    const phases = db.listPhases(row.id);
    const phase = phases.find((p) => p.phase_id === phaseId);
    if (!phase) {
      const ids = phases.map((p) => p.phase_id).join(", ") || "none";
      throw refusal("unknown_phase", `Phase ${phaseId} is not in this task (phases: ${ids}).`, "register it with add_phases, or pass one of the existing phase ids");
    }
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
    const inserted = db.insertCheckmark(row.id, phaseId, sessionId, new Date().toISOString());
    if (inserted) require("./db-export").exportTask(row.id);
    const mark = db.checkmarkOf(row.id, phaseId);
    return {
      id: phase.phase_id, name: phase.name, checked: true,
      checked_at: mark ? mark.checked_at : null, checked_by: mark ? mark.session_id : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Done predicate and close
// ---------------------------------------------------------------------------

/** True when every phase of the view is checked (a checkmark or a skip decision) and it has at least one. */
function isTaskDone(task) {
  return require("./derive").allChecked(task);
}

/**
 * Close a task: archive it, or trash it with `delete`. Never refuses on phase
 * state; keys off checkmarks, not status. Reads the task from the view and
 * stamps nothing on its repo. A row whose folder is gone closes in the database
 * alone: the disposition flips and no folder is created anywhere.
 */
function closeTask({ taskDir, repoKeyObj, delete: trash }) {
  const { withLock } = require("./lock");
  const db = require("./db");

  let closed = null;

  // The folder is gone: the row still closes, but nothing is renamed, exported
  // or created (withLock would mkdir the folder's .lock and fail ENOENT).
  if (!fs.existsSync(taskDir)) {
    closed = readTaskJson(taskDir);
    db.setTaskDisposition({ repoKey: repoKeyObj.key, dirName: path.basename(taskDir), disposition: trash ? "deleted" : "archived" });
    const result = trash
      ? { action: "delete", trashed_to: null, folder: "missing" }
      : { action: "archive", archivePath: null, folder: "missing" };
    const worktree = reapClosedTaskWorktree(repoKeyObj, closed, taskDir);
    return worktree ? { ...result, worktree } : result;
  }

  const result = withLock(taskDir, holder(), () => {
    const task = readTaskJson(taskDir);
    closed = task;

    if (trash) {
      const { trashDir } = require("./trash");
      const trashedTo = trashDir(taskDir, repoKeyObj.key);
      db.setTaskDisposition({ repoKey: repoKeyObj.key, dirName: path.basename(taskDir), disposition: "deleted" });
      require("./lock").removeLockDir(path.join(trashedTo, ".lock"));
      return { action: "delete", trashed_to: trashedTo };
    }

    // archive
    const { trashDir } = require("./trash");
    const { archiveRoot } = require("./tasks-root");
    const archiveBase = path.join(archiveRoot(), repoKeyObj.key);
    fs.mkdirSync(archiveBase, { recursive: true });
    const dirName = path.basename(taskDir);
    const archivePath = path.join(archiveBase, dirName);
    if (fs.existsSync(archivePath)) trashDir(archivePath, repoKeyObj.key);
    fs.renameSync(taskDir, archivePath);
    db.setTaskDisposition({ repoKey: repoKeyObj.key, dirName, disposition: "archived", taskDir: archivePath });
    require("./db-export").exportTask(db.taskIdOf(archivePath));
    require("./lock").removeLockDir(path.join(archivePath, ".lock"));

    return { action: "archive", archivePath };
  });
  const worktree = reapClosedTaskWorktree(repoKeyObj, closed, taskDir);
  return worktree ? { ...result, worktree } : result;
}

function reapClosedTaskWorktree(repoKeyObj, task, taskDir) {
  if (!repoKeyObj.main_root || !task) return null;
  const worktreeLib = require("./worktree");
  let wtPath;
  try {
    wtPath = worktreeLib.taskWorktreeOf(repoKeyObj, task, taskDir);
  } catch (err) {
    return { path: null, removed: false, branch_deleted: false, reason: `cannot list worktrees: ${err.message}` };
  }
  return wtPath ? worktreeLib.reap({ projectDir: repoKeyObj.main_root, path: wtPath }) : null;
}

// ---------------------------------------------------------------------------
// The batch close (the file step's unresolved list, closed on the owner's word)
// ---------------------------------------------------------------------------

/** True when a live session is bound to the task dir (the batch close's `in use`). */
function batchLiveSession(taskDir) {
  const session = require("./session");
  const here = path.resolve(taskDir);
  try {
    return session.list().some((r) => !r.ended_at && r.task_dir && path.resolve(r.task_dir) === here && session.isLive(r));
  } catch {
    return false;
  }
}

/**
 * Close the unresolved list an `--apply` wrote, on the owner's one word:
 * per task, in list order, only while it still reads all-checked and
 * unresolved with the newest intent event the list names and no live session
 * bound. Each closed task first records one task-level `finalize` answer with
 * the owner's words, then archives through closeTask; every archive move is
 * appended to the bundle's manifest and undo.sh is regenerated.
 */
function closeBatch({ batch, quote }) {
  const db = require("./db");
  const derive = require("./derive");
  const fs = require("fs");
  if (typeof quote !== "string" || quote.trim() === "") {
    throw refusal("quote_required", "The batch close carries the owner's words.", "pass --quote \"<the owner's words>\"");
  }
  if (typeof batch !== "string" || !fs.existsSync(batch)) {
    throw refusal("batch_missing", `No unresolved list at ${batch}.`, "pass the path a task import --apply printed");
  }
  let list;
  try {
    list = JSON.parse(fs.readFileSync(batch, "utf8"));
  } catch (err) {
    throw refusal("batch_unreadable", `The unresolved list at ${batch} does not parse: ${err.message}.`, "re-run a task import --apply");
  }
  const appendMoves = require("./db-import").appendMoves;
  const closed = [];
  const notClosed = [];
  for (const entry of list) {
    const row = db.getTask(entry.task_id);
    const name = entry.dir || (row && row.dir_name) || `task ${entry.task_id}`;
    if (!row || row.disposition !== "active") {
      notClosed.push({ dir: name, reason: "no active row" });
      continue;
    }
    if (!require("./sandbox").contains(row.task_dir)) {
      notClosed.push({ dir: name, reason: "outside sandbox" });
      continue;
    }
    let view;
    try { view = readTaskJson(row.task_dir); } catch {
      notClosed.push({ dir: name, reason: "changed, not closed" });
      continue;
    }
    const landing = derive.allChecked(view) ? derive.landingOfTask(row, view) : null;
    const recency = db.intentRecency(row.id);
    const unchanged = derive.allChecked(view) && landing !== null && landing.state === "unresolved"
      && recency.id === entry.newest_intent_event_id;
    if (!unchanged) {
      notClosed.push({ dir: name, reason: "changed, not closed" });
      continue;
    }
    if (batchLiveSession(row.task_dir)) {
      notClosed.push({ dir: name, reason: "in use" });
      continue;
    }
    const repoRow = db.repoOf(row.repo_key);
    const repoKeyObj = { key: row.repo_key, main_root: (repoRow && repoRow.main_root) || null };
    const decisionId = db.insertDecision({
      task_id: row.id, phase_id: null, choice: "answer", gate: "finalize", plan_hash: null,
      quote, recorded_by: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`,
      decided_at: new Date().toISOString(),
    });
    db.appendEvent({
      kind: "decide", repoKey: row.repo_key, taskId: row.id, sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      detail: JSON.stringify({ decision_id: decisionId, phase_id: null, choice: "answer", gate: "finalize" }),
    });
    const result = closeTask({ taskDir: row.task_dir, repoKeyObj });
    if (result.archivePath) {
      appendMoves(path.dirname(batch), [{ op: "move", from: row.task_dir, to: result.archivePath, sha256: null }]);
    }
    closed.push({ dir: name, task_dir: result.archivePath || row.task_dir, decision_id: decisionId });
  }
  return {
    closed, not_closed: notClosed,
    text: `closed ${closed.length}, not closed ${notClosed.length}`,
  };
}

module.exports = {
  createTask,
  nextTaskNumber,
  renderTaskMd,
  VALID_TIERS,
  SETTABLE_KNOBS,
  isTaskDone,
  closeTask,
  addPhases,
  checkPhase,
  setKnob,
  closeBatch,
  refusal,
  loadTask,
  readTaskJson,
  taskRowOf,
  viewOf,
  planDirsFor,
  taskMdPath,
  isTaskMd,
};
