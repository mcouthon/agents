"use strict";

/**
 * `a decide`: the owner's answer on a phase, recorded in their own words and applied.
 * Every accepted answer is one `decisions` row (the quote byte for byte) and one move of
 * the task doc; `override` and `land_anyway` change nothing until `a run start` or
 * `a land` claims them. `a note` sets a phase's note.
 */

const db = require("./db");
const session = require("./session");
const taskLib = require("./task");
const nextStore = require("./next-store");
const { fail } = require("./start");
const { withLock } = require("./lock");
const { applyTransition } = require("./transitions");

const CHOICES = ["approve", "reject", "skip", "abort", "answer", "override", "land_anyway"];
const TERMINAL = ["landed", "done", "failed", "skipped"];

const holder = () => ({ session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid });

/** A dispatched agent has Bash and `a` on its PATH; its own registration names it, and the owner's answer is not its to give. */
function refuseDispatched() {
  const dir = process.env.AGENTS_SESSION_DIR;
  if (!dir) return;
  let reg = null;
  try { reg = session.readRegistration(dir); } catch { /* an unreadable registration names no agent */ }
  if (reg && reg.origin === "dispatch") {
    throw fail(2, "a decide records the owner's answer; a dispatched agent cannot call it. Hand the question back to whoever started you.", "not_owner");
  }
}

function stepContext(taskDir, key) {
  const projectDir = nextStore.mainRootOf(taskDir) || (key && key.main_root) || null;
  const ctx = { taskDir };
  if (!projectDir) return ctx;
  ctx.projectDir = projectDir;
  ctx.policy = require("./policy").resolvePolicy(projectDir);
  try { ctx.gitFacts = require("./next").collectGitFacts(projectDir); } catch { /* a phase on no checkout has no git facts */ }
  return ctx;
}

const ANYTIME = ["skip", "abort", "override"];

/** Where the phase stands and which choices apply there (the decide table). */
function situationOf(phase, task, ctx) {
  if (TERMINAL.includes(phase.status)) return { name: "terminal", label: `${phase.status}`, choices: [] };
  const s = require("./next").stepForPhase(phase, task, ctx);
  const cp = s.step === "blocked" ? s.checkpoint : null;
  if (s.step === "approve") return { name: "approve", label: "step approve", choices: ["approve", "reject", ...ANYTIME] };
  if (cp && cp.type === "review_cap") return { name: "review_cap", label: "review_cap", choices: ["approve", "reject", ...ANYTIME] };
  if (cp && /-clarify$/.test(cp.id || "")) return { name: "clarify", label: "clarify", choices: ["answer", ...ANYTIME] };
  if (cp && cp.type === "fix_cap") return { name: "fix_cap", label: "fix_cap", choices: ["approve", "reject", ...ANYTIME, "land_anyway"] };
  if (cp && cp.type === "review_fail") return { name: "review_fail", label: "review_fail", choices: ["reject", ...ANYTIME, "land_anyway"] };
  const label = `step ${s.step} (${phase.status})`;
  if (["implemented", "committed"].includes(phase.status)) return { name: "code", label, choices: [...ANYTIME, "land_anyway"] };
  return { name: "other", label, choices: ANYTIME };
}

const stamp = (fields) => ({ ...fields, at: new Date().toISOString() });

function toTerminal(phase, task, ctx, to) {
  const from = phase.status;
  applyTransition(phase, to, task, ctx);
  return `${from} → ${to}`;
}

/** Send a code-stage phase back to the Builder, as the checkpoint's replan and force_retry do. */
function backToBuilder(phase, task, ctx) {
  const review = (phase.reports && phase.reports.code_review) || { kind: "code", issues: [], summary: "" };
  phase.reports = { ...phase.reports, code_review: { ...review, verdict: "needs_work" } };
  (phase.counters || (phase.counters = {})).fix_attempts = 0;
  applyTransition(phase, "in_progress", task, ctx);
  return "implemented → in_progress";
}

/** Apply the choice to the phase in the in-memory doc; returns the transition text recorded on the decision. */
function applyChoice({ choice, quote, phase, task, sit, ctx, decisionId }) {
  const revision = (agent) => ({ decision_id: decisionId, choice, quote, at: new Date().toISOString(), agent });
  const approving = { ...ctx, decision: { choice: "approve", phase_id: phase.id, decision_id: decisionId } };
  const from = phase.status;
  switch (choice) {
    case "approve": {
      if (sit.name === "fix_cap") {
        phase.reports.code_review = { kind: "code", verdict: "pass", attributed_to: "user", issues: [], summary: "The owner accepted the code at the fix cap", quote, decision_id: decisionId };
        return "implemented (code accepted by the owner)";
      }
      if (sit.name === "review_cap") {
        phase.reports = { ...phase.reports, reviewer: { kind: "plan", verdict: "pass", attributed_to: "user", issues: [], summary: "The owner approved at the review cap", quote, decision_id: decisionId } };
      }
      if (phase.status === "planned") applyTransition(phase, "reviewed", task, ctx);
      applyTransition(phase, "approved", task, approving);
      return `${from} → ${from === "planned" ? "reviewed → " : ""}approved`;
    }
    case "reject": {
      if (sit.name === "fix_cap" || sit.name === "review_fail") {
        const text = backToBuilder(phase, task, ctx);
        phase.note = quote;
        phase.revision = revision("builder");
        return text;
      }
      if (phase.status === "reviewed") applyTransition(phase, "planned", task, ctx);
      if (sit.name === "review_cap") {
        phase.reports = { ...phase.reports, reviewer: null };
        const counters = phase.counters || (phase.counters = {});
        counters.review_passes = Math.max(0, (counters.review_passes || 0) - 1);
      }
      phase.note = quote;
      phase.revision = revision("explorer");
      return sit.name === "review_cap" ? "planned (review cleared, owner rejected)" : `${from} → planned (rejected)`;
    }
    case "answer": {
      const counters = phase.counters || (phase.counters = {});
      counters.clarify_rounds = (counters.clarify_rounds || 0) + 1;
      const explorer = phase.reports && phase.reports.explorer;
      for (const q of (explorer && explorer.open_questions) || []) q.answered = stamp({ decision_id: decisionId });
      phase.revision = revision("explorer");
      return "planned (open questions answered)";
    }
    case "skip": return toTerminal(phase, task, ctx, "skipped");
    case "abort": return toTerminal(phase, task, ctx, "failed");
    default: return `${choice} recorded`;
  }
}

const CHANGES_DOC = ["approve", "reject", "answer", "skip", "abort"];

/**
 * Record and apply the owner's choice on a phase. Refusals are thrown before anything
 * is written; once the decision row exists a failure stores its reason on the row and
 * rethrows, so the owner's words are never lost and a failed row is never pending.
 */
function decide({ taskDir, key, phaseId, choice, quote }) {
  refuseDispatched();
  if (!db.enabled()) throw fail(2, "a decide needs the agents database; this `a` is in file-only mode", "no_database");
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw fail(2, `a decide needs the task in the agents database; ${taskDir} has no tasks row`, "no_task_row");
  if (!CHOICES.includes(choice)) throw fail(2, `unknown choice "${choice}"; choose one of: ${CHOICES.join(", ")}`, "unknown_choice");
  if (typeof quote !== "string" || quote.trim() === "") throw fail(2, "--quote is required: the owner's words, verbatim", "quote_required");

  let outcome = null;
  withLock(taskDir, holder(), () => {
    const task = taskLib.readTaskJson(taskDir);
    const phase = task && (task.phases || []).find((p) => p.id === phaseId);
    if (!phase) throw fail(4, `Phase ${phaseId} not found in ${require("path").basename(taskDir)}`);
    const ctx = stepContext(taskDir, key);
    const sit = situationOf(phase, task, ctx);
    if (sit.choices.length === 0) throw fail(2, `Phase ${phaseId} is ${sit.label}; there is nothing left to decide`, "terminal_phase");
    if (!sit.choices.includes(choice)) {
      throw fail(2, `Phase ${phaseId} is at ${sit.label}; ${choice} does not apply here. Choose one of: ${sit.choices.join(", ")}`, "not_applicable", { situation: sit.label, choices: sit.choices });
    }
    const decisionId = db.insertDecision({ task_id: taskId, phase_id: phaseId, choice, quote, recorded_by: process.env.CLAUDE_CODE_SESSION_ID || null });
    try {
      const transition = applyChoice({ choice, quote, phase, task, sit, ctx, decisionId });
      if (CHANGES_DOC.includes(choice)) taskLib.writeTaskJson(taskDir, task);
      db.updateDecision(decisionId, { transition });
      outcome = { decision_id: decisionId, transition, phase: { id: phase.id, status: phase.status } };
    } catch (err) {
      db.updateDecision(decisionId, { error: err.message });
      throw err;
    }
  });
  nextStore.refresh(taskDir);
  const fresh = taskLib.readTaskJson(taskDir);
  return { ...outcome, choice, quote, next: nextStore.describeNext(taskDir, fresh, { projectDir: stepContext(taskDir, key).projectDir || undefined }) };
}

/** Set a phase's note to `text`, verbatim. */
function note({ taskDir, phaseId, text }) {
  if (typeof text !== "string" || text === "") throw fail(2, "--text is required");
  let phaseOut = null;
  withLock(taskDir, holder(), () => {
    const task = taskLib.readTaskJson(taskDir);
    const phase = task && (task.phases || []).find((p) => p.id === phaseId);
    if (!phase) throw fail(4, `Phase ${phaseId} not found in ${require("path").basename(taskDir)}`);
    phase.note = text;
    taskLib.writeTaskJson(taskDir, task);
    phaseOut = { id: phase.id, note: phase.note };
  });
  return { phase: phaseOut };
}

const word = (v) => (v === undefined || v === true ? undefined : v);

function phaseIdOf(args) {
  const raw = word(args["--phase-id"]);
  if (raw === undefined) throw fail(2, "--phase-id is required");
  const n = Number(raw);
  if (!Number.isInteger(n)) throw fail(2, "--phase-id must be an integer");
  return n;
}

/** `a decide` and `a note`; `args` is the parsed flag object, `ctx` `{ key, taskDirOf }`. */
function cli(cmd, args, ctx) {
  if (cmd === "decide") refuseDispatched();
  if (!word(args["--task-dir"])) throw fail(2, "--task-dir is required");
  const taskDir = ctx.taskDirOf(args["--task-dir"]);
  const phaseId = phaseIdOf(args);
  if (cmd === "note") {
    const out = note({ taskDir, phaseId, text: word(args["--text"]) });
    return { exitCode: 0, json: out, text: `Phase ${phaseId} note set` };
  }
  const choice = word(args["--choice"]);
  if (choice === undefined) throw fail(2, "--choice is required");
  const out = decide({ taskDir, key: ctx.key, phaseId, choice, quote: word(args["--quote"]) });
  return { exitCode: 0, json: out, text: `Decision ${out.decision_id} on phase ${phaseId}: ${choice} (${out.transition})` };
}

module.exports = { CHOICES, decide, note, cli };
