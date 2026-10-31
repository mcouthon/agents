"use strict";

/**
 * `a decide`: the owner's answer on a phase, recorded in their own words. One `decisions`
 * row and one `events` row per answer; no task file is written. The advice derives from the
 * rows, so recording is all a decision does. `approve` and `reject` hash the plan file as it
 * is on disk when the decision is recorded, so the approval binds to the body the owner was
 * shown and appended evidence never undoes it. `a note` appends to the notes table.
 */

const path = require("path");
const fs = require("fs");
const db = require("./db");
const taskLib = require("./task");
const { fail } = require("./start");
const { withLock } = require("./lock");

const CHOICES = ["approve", "accept", "reject", "answer", "skip", "land_anyway"];

const holder = () => ({ session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid });

function refusal(exitCode, code, message, remedy) {
  return fail(exitCode, `${message}\nRemedy: ${remedy}`, code, { remedy });
}

function phaseOf(task, taskDir, phaseId) {
  const phase = (task.phases || []).find((p) => p.id === phaseId);
  if (phase) return phase;
  const ids = (task.phases || []).map((p) => p.id).join(", ") || "none";
  throw refusal(4, "unknown_phase", `Phase ${phaseId} is not in ${path.basename(taskDir)} (phases: ${ids}).`, "name an existing phase, or add it with add_phases first");
}

/** The plan body hash of a phase as its file is on disk; null with no plan file. */
function planHashAt(taskDir, task, phaseId) {
  const derive = require("./derive");
  const dirs = taskLib.planDirsFor(taskLib.taskRowOf(taskDir), db.pendingFoldOf(db.taskIdOf(taskDir)));
  const found = derive.planFileFor(dirs, phaseId);
  if (!found.file) return null;
  try { return derive.planHash(fs.readFileSync(found.file, "utf8")); } catch { return null; }
}

/**
 * Record the owner's choice on a phase and return it with the advice it leads to.
 * Everything is checked before the row is written.
 */
function decide({ taskDir, phaseId, choice, quote }) {
  if (!CHOICES.includes(choice)) {
    throw refusal(2, "unknown_choice", `Unknown choice "${choice}".`, `choose one of: ${CHOICES.join(", ")}`);
  }
  if (typeof quote !== "string" || quote.trim() === "") {
    throw refusal(2, "quote_required", "A decision needs the owner's words.", "pass the owner's words verbatim as quote");
  }
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw refusal(2, "no_task_row", `${taskDir} has no row in the agents database.`, "pass a task dir under the central tasks root");

  const task = taskLib.readTaskJson(taskDir);
  const phase = phaseOf(task, taskDir, phaseId);
  const planHash = choice === "approve" || choice === "reject" ? planHashAt(taskDir, task, phaseId) : null;
  const decisionId = db.insertDecision({
    task_id: taskId, phase_id: phase.id, choice, plan_hash: planHash, quote,
    recorded_by: process.env.CLAUDE_CODE_SESSION_ID || null,
  });
  const loc = db.locate(taskDir);
  db.appendEvent({ kind: "decide", repoKey: loc && loc.repoKey, taskId, sessionId: process.env.CLAUDE_CODE_SESSION_ID, detail: JSON.stringify({ decision_id: decisionId, phase_id: phase.id, choice }) });
  require("./db-export").exportTask(taskId);
  return { decision_id: decisionId, choice, quote, advice: require("./advise").adviceFor(taskDir, task) };
}

/** Append a note to a phase (or the task with no phase), verbatim. */
function note({ taskDir, phaseId, text }) {
  if (typeof text !== "string" || text === "") throw refusal(2, "text_required", "A note needs text.", "pass --text");
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw refusal(2, "no_task_row", `${taskDir} has no row in the agents database.`, "pass a task dir under the central tasks root");
  return withLock(taskDir, holder(), () => {
    const task = taskLib.readTaskJson(taskDir);
    const phase = phaseId === null || phaseId === undefined ? null : phaseOf(task, taskDir, phaseId);
    db.insertNote({ task_id: taskId, phase_id: phase ? phase.id : null, text, session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}` });
    const loc = db.locate(taskDir);
    db.appendEvent({ kind: "note", repoKey: loc && loc.repoKey, taskId, sessionId: process.env.CLAUDE_CODE_SESSION_ID, detail: JSON.stringify({ phase_id: phase ? phase.id : null }) });
    require("./db-export").exportTask(taskId);
    return { phase: phase ? { id: phase.id, note: text } : { id: null, note: text } };
  });
}

const word = (v) => (v === undefined || v === true ? undefined : v);

function phaseIdOf(args) {
  const raw = word(args["--phase-id"]);
  if (raw === undefined) throw refusal(2, "phase_required", "--phase-id is required.", "pass --phase-id <n>");
  const n = Number(raw);
  if (!Number.isInteger(n)) throw refusal(2, "bad_phase", "--phase-id must be an integer.", "pass --phase-id <n>");
  return n;
}

/** `a decide` and `a note`; `args` is the parsed flag object, `ctx` `{ taskDirOf }`. */
function cli(cmd, args, ctx) {
  if (!word(args["--task-dir"])) throw refusal(2, "task_dir_required", "--task-dir is required.", "pass --task-dir <dir>");
  const taskDir = ctx.taskDirOf(args["--task-dir"]);
  const phaseId = phaseIdOf(args);
  if (cmd === "note") {
    const out = note({ taskDir, phaseId, text: word(args["--text"]) });
    return { exitCode: 0, json: out, text: `Phase ${phaseId} note set` };
  }
  const choice = word(args["--choice"]);
  if (choice === undefined) throw refusal(2, "choice_required", "--choice is required.", `pass --choice ${CHOICES.join("|")}`);
  const out = decide({ taskDir, phaseId, choice, quote: word(args["--quote"]) });
  return { exitCode: 0, json: out, text: `Decision ${out.decision_id} on phase ${phaseId}: ${choice}. Next: ${out.advice.advice}` };
}

module.exports = { CHOICES, decide, note, cli };
