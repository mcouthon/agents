"use strict";

/**
 * `a decide`: the owner's answer, or the agent's waiver, recorded in words. One
 * `decisions` row and one `events` row per answer; no task file is written
 * besides the rendered blocks. `approve`, `reject` and `waived --gate
 * phase-plan` hash the plan file as it is on disk when the decision is
 * recorded, so the approval binds to the body on disk and appended evidence
 * never undoes it. `a note` appends to the notes table (a phase or the task).
 */

const path = require("path");
const fs = require("fs");
const db = require("./db");
const taskLib = require("./task");
const { fail } = require("./start");
const { withLock } = require("./lock");
const adapter = require("./adapter").forHarness();

const CHOICES = ["approve", "accept", "reject", "answer", "skip", "land_anyway", "waived"];
const GATES = ["task-plan", "phase-plan", "phase-build", "finalize", "land"];

const DECIDE_COLLAPSE_WINDOW_MS = 10 * 60 * 1000;

const holder = () => ({ session_id: adapter.ownSessionId() || `pid-${process.pid}`, pid: process.pid });

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
 * The shape rules every choice obeys, in `a decide` and the MCP adapter alike:
 * a waiver names one of the five gates (with a phase for the two phase gates,
 * without one for the three task-level ones); an answer may name task-plan or
 * finalize, both task-level; every other choice takes a phase and no gate.
 */
function checkShape({ choice, phaseId, gate }) {
  if (choice === "waived") {
    if (gate === undefined || gate === null) {
      throw refusal(2, "gate_required", "A waiver names its gate: task-plan, phase-plan, phase-build, finalize or land.", "pass --gate with one of the five");
    }
    if (!GATES.includes(gate)) {
      throw refusal(2, "bad_gate", `A waiver's gate is one of task-plan, phase-plan, phase-build, finalize or land, not "${gate}".`, "pass one of the five");
    }
    const phaseGate = gate === "phase-plan" || gate === "phase-build";
    if (phaseGate && (phaseId === undefined || phaseId === null)) {
      throw refusal(2, "phase_required", `A ${gate} waiver names its phase.`, "pass --phase-id <n>");
    }
    if (!phaseGate && phaseId !== undefined && phaseId !== null) {
      throw refusal(2, "task_level_gate", `A ${gate} waiver is task-level and takes no phase.`, "drop --phase-id");
    }
    return;
  }
  if (gate !== undefined && gate !== null) {
    if (choice === "answer") {
      if (gate !== "task-plan" && gate !== "finalize") {
        throw refusal(2, "bad_answer_gate", "An answer's gate is task-plan or finalize, both task-level.", "pass --gate task-plan or --gate finalize, or no gate");
      }
      if (phaseId !== undefined && phaseId !== null) {
        throw refusal(2, "task_level_gate", `An answer with a gate is task-level and takes no phase (${gate}).`, "drop --phase-id");
      }
      return;
    }
    throw refusal(2, "gate_refused", `${choice} names no gate; its gate follows from the choice.`, "drop --gate");
  }
  if ((phaseId === undefined || phaseId === null) && choice !== "answer") {
    throw refusal(2, "phase_required", `${choice} names a phase.`, "pass --phase-id <n>");
  }
}

/**
 * Record the owner's choice (or the agent's waiver) and return it with the
 * advice it leads to. Everything is checked before the row is written.
 * `expectPlanHash` refuses when the on-disk plan hash differs (stale-yes guard).
 * `recordedBy` overrides the recorded_by authorship (the events row's sessionId
 * stays adapter.ownSessionId() — it records who ran the command, not whose
 * authorship the row claims). Identical decides within the collapse window
 * return the existing row without inserting a second one.
 */
function decide({ taskDir, phaseId, choice, gate, quote, expectPlanHash, recordedBy }) {
  if (!CHOICES.includes(choice)) {
    throw refusal(2, "unknown_choice", `Unknown choice "${choice}".`, `choose one of: ${CHOICES.join(", ")}`);
  }
  if (typeof quote !== "string" || quote.trim() === "") {
    throw refusal(2, "quote_required", "A decision needs the owner's words, or for `waived` the agent's reason.", "pass the words verbatim as --quote");
  }
  checkShape({ choice, phaseId, gate });
  if (recordedBy !== undefined && recordedBy !== null && recordedBy.trim() === "") {
    throw refusal(2, "bad_recorded_by", "A recorded-by id must be non-empty.", "pass a session id or drop the flag");
  }
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw refusal(2, "no_task_row", `${taskDir} has no row in the agents database.`, "pass a task dir under the central tasks root");

  const task = taskLib.readTaskJson(taskDir);
  const phase = phaseId === undefined || phaseId === null ? null : phaseOf(task, taskDir, phaseId);
  const hashWorthy = choice === "approve" || choice === "reject" || (choice === "waived" && gate === "phase-plan");
  const planHash = hashWorthy && phase ? planHashAt(taskDir, task, phase.id) : null;

  if (expectPlanHash !== undefined && expectPlanHash !== null) {
    if (!hashWorthy || (hashWorthy && !phase)) {
      throw refusal(2, "expect_hash_unworthy", "`--expect-plan-hash` needs a choice that hashes a plan (approve, reject, or a waived phase-plan).", "drop --expect-plan-hash or use a hash-worthy choice");
    }
    if (planHash !== expectPlanHash) {
      throw refusal(2, "plan_changed", "the plan changed since it was read; re-read and decide again", "re-read the plan and decide again with its current hash");
    }
  }

  return withLock(taskDir, holder(), () => {
    const existing = findCollapse(taskId, phase ? phase.id : null, choice, planHash, quote);
    if (existing) {
      return { decision_id: existing.decision_id, choice, quote, advice: require("./advise").adviceFor(taskDir, task) };
    }
    const decisionId = db.insertDecision({
      task_id: taskId, phase_id: phase ? phase.id : null, choice, gate: gate || null, plan_hash: planHash, quote,
      recorded_by: recordedBy !== undefined ? recordedBy : (adapter.ownSessionId() || (choice === "waived" ? `pid-${process.pid}` : null)),
    });
    const loc = db.locate(taskDir);
    db.appendEvent({ kind: "decide", repoKey: loc && loc.repoKey, taskId, sessionId: adapter.ownSessionId(), detail: JSON.stringify({ decision_id: decisionId, phase_id: phase ? phase.id : null, choice, gate: gate || null }) });
    require("./db-export").exportTask(taskId);
    return { decision_id: decisionId, choice, quote, advice: require("./advise").adviceFor(taskDir, task) };
  });
}

/** Scan for an identical decision within the collapse window. */
function findCollapse(taskId, phaseId, choice, planHash, quote) {
  const all = db.listDecisions({ taskId });
  const now = Date.now();
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i];
    if (d.phase_id !== phaseId) continue;
    if (d.choice !== choice) continue;
    if ((d.plan_hash || null) !== (planHash || null)) continue;
    if (d.quote !== quote) continue;
    const age = now - new Date(d.decided_at).getTime();
    if (age >= 0 && age < DECIDE_COLLAPSE_WINDOW_MS) return d;
  }
  return null;
}

/** Append a note to a phase (or the task with no phase), verbatim. */
function note({ taskDir, phaseId, text }) {
  if (typeof text !== "string" || text === "") throw refusal(2, "text_required", "A note needs text.", "pass --text");
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw refusal(2, "no_task_row", `${taskDir} has no row in the agents database.`, "pass a task dir under the central tasks root");
  return withLock(taskDir, holder(), () => {
    const task = taskLib.readTaskJson(taskDir);
    const phase = phaseId === null || phaseId === undefined ? null : phaseOf(task, taskDir, phaseId);
    db.insertNote({ task_id: taskId, phase_id: phase ? phase.id : null, text, session_id: adapter.ownSessionId() || `pid-${process.pid}` });
    const loc = db.locate(taskDir);
    db.appendEvent({ kind: "note", repoKey: loc && loc.repoKey, taskId, sessionId: adapter.ownSessionId(), detail: JSON.stringify({ phase_id: phase ? phase.id : null }) });
    require("./db-export").exportTask(taskId);
    return { phase: phase ? { id: phase.id, note: text } : { id: null, note: text } };
  });
}

const word = (v) => (v === undefined || v === true ? undefined : v);

/** An optional integer flag: undefined when absent (a null phase is a task-level row). */
function phaseIdOf(args) {
  const raw = word(args["--phase-id"]);
  if (raw === undefined) return undefined;
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
    return { exitCode: 0, json: out, text: phaseId === undefined ? "Task note set" : `Phase ${phaseId} note set` };
  }
  const choice = word(args["--choice"]);
  if (choice === undefined) throw refusal(2, "choice_required", "--choice is required.", `pass --choice ${CHOICES.join("|")}`);
  const gate = word(args["--gate"]);
  const out = decide({ taskDir, phaseId, choice, gate, quote: word(args["--quote"]), expectPlanHash: word(args["--expect-plan-hash"]), recordedBy: word(args["--recorded-by"]) });
  const where = phaseId === undefined ? "the task" : `phase ${phaseId}`;
  return { exitCode: 0, json: out, text: `Decision ${out.decision_id} on ${where}: ${choice}. Next: ${out.advice.advice}` };
}

module.exports = { CHOICES, GATES, DECIDE_COLLAPSE_WINDOW_MS, checkShape, decide, note, cli };
