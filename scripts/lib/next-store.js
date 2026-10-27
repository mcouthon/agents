"use strict";

/**
 * The next step of a task as it is stored on its `tasks` row: `computeNext`
 * plus the command that performs the step (`call`), who the task waits for
 * (`awaiting`), the live run if any, and when it was computed. Every task write
 * stores it (`writeTaskJson`), and a run's start or end refreshes it, so a
 * reader of the database sees the step without calling `a next`.
 */

const fs = require("fs");
const db = require("./db");
const { withLock } = require("./lock");

const RESUMABLE = ["capped", "killed", "crashed", "no_report"];
const OWNER_RESUMES = ["capped", "killed", "crashed"];
const START_STEPS = ["plan", "review_plan", "build", "review_code", "fix", "resolve_conflicts", "commit"];

// The database stores a task's repo key as the relative path under the tasks root, so a
// path-shaped key (a local origin) loses its leading slash there.
const storedKey = (k) => String(k).replace(/\/{2,}/g, "/").replace(/^\//, "");

/** The main checkout of the repo a task dir belongs to, from the root index; null when unknown or gone. */
function mainRootOf(taskDir) {
  const loc = db.locate(taskDir);
  if (!loc) return null;
  const index = require("./tasks-root").readRootIndex();
  for (const [key, entry] of Object.entries(index)) {
    if (storedKey(key) !== loc.repoKey) continue;
    return entry && entry.main_root && fs.existsSync(entry.main_root) ? entry.main_root : null;
  }
  return null;
}

const startCall = (taskDir, phaseId, agent) => ({
  verb: "run start", agent, phase_id: phaseId,
  text: `a run start --task-dir ${taskDir} --phase-id ${phaseId} --agent ${agent} --brief "<brief>"`,
});

/** The newest run of any agent on a phase, or null. */
function newestRun(runs, phaseId) {
  const on = runs.filter((r) => r.phase_id === phaseId);
  return on.length ? on[on.length - 1] : null;
}

/** What the owner may answer at a block, from the checkpoint it raised. */
function choicesAt(checkpoint) {
  if (/-clarify$/.test(checkpoint.id || "")) return ["answer", "skip", "abort"];
  if (checkpoint.type === "review_cap" || checkpoint.type === "fix_cap") return ["approve", "reject", "skip", "abort"];
  if (checkpoint.type === "review_fail") return ["reject", "skip", "abort"];
  return null;
}

const decideCall = (taskDir, phaseId, choices) => ({
  verb: "decide", phase_id: phaseId, choices,
  text: `a decide --task-dir ${taskDir} --phase-id ${phaseId} --choice ${choices[0]} --quote "<the owner's words>"`,
});

function callFor(taskDir, next, runs, lastPhaseId) {
  const phaseId = next.phase_ids[0];
  if (next.agent && phaseId !== undefined) {
    const last = newestRun(runs, phaseId);
    if (last && last.agent === next.agent && RESUMABLE.includes(last.status)) {
      return {
        verb: "run resume", agent: next.agent, phase_id: phaseId, run_id: last.run_id,
        text: `a run resume --run-id ${last.run_id} --brief "<brief>"`,
        restart: startCall(taskDir, phaseId, next.agent).text,
      };
    }
  }
  if (START_STEPS.includes(next.step) && next.agent && phaseId !== undefined) return startCall(taskDir, phaseId, next.agent);
  if (next.step === "consolidate" && lastPhaseId !== undefined) return startCall(taskDir, lastPhaseId, "consolidator");
  if (next.step === "approve" && phaseId !== undefined) return decideCall(taskDir, phaseId, ["approve", "reject", "skip", "abort"]);
  if (next.step === "blocked" && next.checkpoint && phaseId !== undefined) {
    const choices = choicesAt(next.checkpoint);
    if (choices) return decideCall(taskDir, phaseId, choices);
  }
  if (next.step === "land" && phaseId !== undefined) {
    return { verb: "land", phase_id: phaseId, text: `a land --task-dir ${taskDir} --phase-id ${phaseId}` };
  }
  if (next.step === "done" && next.pending_transitions) return { verb: "next", text: `a next --task-dir ${taskDir}` };
  return null;
}

function awaitingOf(next, call, live, runs) {
  if (live) return "agent";
  if (next.step === "approve" || (next.step === "blocked" && next.checkpoint)) return "owner";
  if (call && call.verb === "run resume") {
    const run = runs.find((r) => r.run_id === call.run_id);
    if (run && OWNER_RESUMES.includes(run.status)) return "owner";
  }
  return next.step;
}

/**
 * `computeNext` for a task doc, extended with `call`, `awaiting`, `live_run_id`
 * and `computed_at`. `projectDir` defaults to the task's own main checkout and
 * `policy` to that repo's, as `a next` resolves them.
 */
function describeNext(taskDir, task, { projectDir, policy, gitFacts, explain } = {}) {
  const root = projectDir === undefined ? mainRootOf(taskDir) : projectDir;
  const pol = policy || (root ? require("./policy").resolvePolicy(root) : undefined);
  const next = require("./next").computeNext(task, { projectDir: root || undefined, policy: pol, taskDir, gitFacts, explain });
  const taskId = db.enabled() ? db.taskIdOf(taskDir) : null;
  const runs = taskId === null ? [] : db.listRuns({ taskId });
  const live = runs.filter((r) => db.LIVE_RUN_STATUSES.includes(r.status)).slice(-1)[0] || null;
  const phases = task.phases || [];
  const call = callFor(taskDir, next, runs, phases.length ? phases[phases.length - 1].id : undefined);
  return { ...next, call, awaiting: awaitingOf(next, call, live, runs), live_run_id: live ? live.run_id : null, computed_at: new Date().toISOString() };
}

/** `{ json, awaiting }` for a row; a task the next step cannot be computed for is stored with the reason. Never throws. */
function storedFields(taskDir, task) {
  try {
    const described = describeNext(taskDir, task);
    return { json: JSON.stringify(described), awaiting: described.awaiting };
  } catch (err) {
    return { json: JSON.stringify({ error: err.message, computed_at: new Date().toISOString() }), awaiting: null };
  }
}

/** The stored next step of a task, parsed; null without a database, a row or a stored value, or when the stored value is an error object. Never throws. */
function stored(taskDir) {
  try {
    if (!db.enabled()) return null;
    const taskId = db.taskIdOf(taskDir);
    if (taskId === null) return null;
    const row = db.getNext(taskId);
    if (!row) return null;
    const parsed = JSON.parse(row.json);
    return parsed && typeof parsed === "object" && !parsed.error && typeof parsed.step === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Recompute and store a task's next step under the task lock (so an older value
 * never overwrites a newer one). Call it only from a caller that does not hold
 * the lock. A held lock, no database or no row skips it; it never throws.
 */
function refresh(taskDir) {
  try {
    if (!db.enabled()) return;
    const taskId = db.taskIdOf(taskDir);
    if (taskId === null) return;
    const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
    withLock(taskDir, holder, () => {
      const task = require("./task").readTaskJson(taskDir);
      if (!task) return;
      const { json, awaiting } = storedFields(taskDir, task);
      db.setNext(taskId, json, awaiting);
    });
  } catch (err) {
    process.stderr.write(`warning: next step not refreshed: ${err.message}\n`);
  }
}

module.exports = { mainRootOf, describeNext, storedFields, stored, refresh, startCall };
