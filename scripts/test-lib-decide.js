#!/usr/bin/env node
"use strict";

// a decide: the owner's words recorded as one decisions row and one events row; task.json is untouched;
// the advice that comes back is recomputed from the rows.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-decide-"));
  for (const d of ["home", "xdg", "tasks", "sessions"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  for (const k of ["CLAUDE_CODE_SESSION_ID", "AGENTS_SESSION_DIR"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const { decide, note, CHOICES, GATES, checkShape } = require("./lib/decide");
const derive = require("./lib/derive");
const { landHold } = require("./lib/land");
const dbExport = require("./lib/db-export");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

db.open({ create: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-decide-repo-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
execFileSync("git", ["add", "."], { cwd: repo });
// the init commit lands an hour back, so no decision's instant can count it
const past = new Date(Date.now() - 3600000).toISOString();
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: past } });

let n = 0;
function makeTask(approvals = "ask") {
  const id = ++n;
  const r = taskLib.createTask({ repo: repoKey(repo), title: `D${id}`, slug: `d${id}`, session_id: "s", phases: [{ id: 1, name: "One" }, { id: 2, name: "Two", blocked_by: [1] }] });
  const taskId = db.taskIdOf(r.task_dir);
  db.setTaskKnob(taskId, "approvals", approvals);
  fs.mkdirSync(path.join(r.task_dir, "plan"));
  fs.writeFileSync(path.join(r.task_dir, "plan", "phase-1-p.md"), "# plan\n");
  return r.task_dir;
}
const attempt = (fn) => { try { return { result: fn() }; } catch (err) { return { err }; } };
const rows = (dir) => db.listDecisions({ taskId: db.taskIdOf(dir) });
const sleep = (ms) => spawnSync("sleep", [String(ms / 1000)]);

// Each of the seven choices records one row with the verbatim quote, and no task file is written.
{
  check(CHOICES.join() === "approve,accept,reject,answer,skip,land_anyway,waived", `the seven choices (${CHOICES.join()})`);
  const dir = makeTask();
  for (const choice of ["approve", "accept", "reject", "answer", "skip", "land_anyway"]) {
    const quote = `  "${choice}" — verbatim,\tspaced  `;
    const r = attempt(() => decide({ taskDir: dir, phaseId: 1, choice, quote }));
    const last = rows(dir).pop();
    check(!r.err && last.choice === choice && last.quote === quote && r.result.decision_id === last.decision_id && r.result.quote === quote, `${choice}: one row with the owner's words byte for byte (${r.err && r.err.message})`);
  }
  const waived = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "waived", gate: "phase-plan", quote: "cheap to revert" }));
  const last = rows(dir).pop();
  check(!waived.err && last.choice === "waived" && last.gate === "phase-plan" && last.quote === "cheap to revert"
    && last.plan_hash === derive.planHash(fs.readFileSync(path.join(dir, "plan", "phase-1-p.md"), "utf8")),
    `a phase-plan waiver records its gate and the plan body's hash (${waived.err && waived.err.message})`);
  check(rows(dir).length === 7 && !fs.existsSync(path.join(dir, "task.json")), "seven rows, and no task.json is ever written");
  check(db.lastEventAt(db.taskIdOf(dir), "decide") !== null, "each decision appends an events row of kind decide");
  const rendered = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  check(rendered.includes("waived phase-plan (agent)"), "the waiver renders in the decisions block with (agent)");
}

// The gate rules: a waiver names one of the five gates; an answer may name the two task-level ones.
{
  const dir = makeTask();
  const cases = [
    ["waived without a gate", () => decide({ taskDir: dir, phaseId: 1, choice: "waived", quote: "x" }), "gate_required", /A waiver names its gate/],
    ["approve with a gate", () => decide({ taskDir: dir, phaseId: 1, choice: "approve", gate: "finalize", quote: "x" }), "gate_refused", /approve names no gate/],
    ["waived phase-build without a phase", () => decide({ taskDir: dir, choice: "waived", gate: "phase-build", quote: "x" }), "phase_required", /names its phase/],
    ["waived finalize with a phase", () => decide({ taskDir: dir, phaseId: 1, choice: "waived", gate: "finalize", quote: "x" }), "task_level_gate", /takes no phase/],
    ["answer with gate phase-plan", () => decide({ taskDir: dir, choice: "answer", gate: "phase-plan", quote: "x" }), "bad_answer_gate", /An answer's gate is task-plan or finalize/],
    ["answer task-plan with a phase", () => decide({ taskDir: dir, phaseId: 1, choice: "answer", gate: "task-plan", quote: "x" }), "task_level_gate", /takes no phase/],
    ["an unknown gate", () => decide({ taskDir: dir, choice: "waived", gate: "ship", quote: "x" }), "bad_gate", /one of/],
  ];
  for (const [label, fn, code, re] of cases) {
    const r = attempt(fn);
    check(r.err && r.err.code === code && re.test(r.err.message), `${label} refuses with its message (${r.err && r.err.code})`);
  }
  const taskAnswer = attempt(() => decide({ taskDir: dir, choice: "answer", gate: "task-plan", quote: "yes, these phases" }));
  const row = rows(dir).pop();
  check(!taskAnswer.err && row.choice === "answer" && row.gate === "task-plan" && row.phase_id === null,
    `an answer --gate task-plan stores the gate with a NULL phase (${taskAnswer.err && taskAnswer.err.message})`);
  check(rows(dir).length === 1, "no refused call wrote a row");
}

// The same rules from the command line: a decide --gate task-plan stores the gate, the refusals exit 2.
{
  const dir = makeTask();
  const A = path.join(__dirname, "bin", "a");
  const run = (args) => spawnSync(process.execPath, [A, ...args], { encoding: "utf8", timeout: 30000 });
  const ok = run(["decide", "--task-dir", dir, "--choice", "answer", "--gate", "task-plan", "--quote", "yes"]);
  const row = rows(dir).pop();
  check(ok.status === 0 && row && row.gate === "task-plan" && row.phase_id === null, `a decide --gate task-plan on the CLI stores gate and NULL phase (${ok.status}: ${ok.stderr.slice(0, 120)})`);
  for (const [label, args, re] of [
    ["waived without a gate", ["decide", "--task-dir", dir, "--choice", "waived", "--quote", "x"], /A waiver names its gate/],
    ["approve with a gate", ["decide", "--task-dir", dir, "--phase-id", "1", "--choice", "approve", "--gate", "finalize", "--quote", "x"], /names no gate/],
  ]) {
    const r = run(args);
    check(r.status === 2 && re.test(r.stderr), `CLI: ${label} exits 2 with the Design-7 message (${r.status}: ${r.stderr.trim().slice(0, 80)})`);
  }
}

// A waiver satisfies nothing under ask (B6): the advice still asks, the land still holds; under
// none (and for a migrated task) it asks and holds nothing.
{
  const askDir = makeTask("ask");
  decide({ taskDir: askDir, phaseId: 1, choice: "waived", gate: "phase-plan", quote: "skip the ask" });
  const askView = taskLib.readTaskJson(askDir);
  const askFacts = require("./lib/advise").factsFor(askDir, askView);
  check(require("./lib/advise").advise(askView, askFacts).move === "approve", "under ask a waiver leaves the plan waiting for approval");
  const askTaskId = db.taskIdOf(askDir);
  db.insertCheckmark(askTaskId, 1, "s", new Date().toISOString());
  db.appendEvent({ kind: "land", taskId: askTaskId, detail: JSON.stringify({ head: "0".repeat(40), migrated: true }) });
  const askView2 = taskLib.readTaskJson(askDir);
  const askDecisions = db.listDecisions({ taskId: askTaskId });
  check(landHold(askView2, askDecisions, null) && landHold(askView2, askDecisions, null).phases.join() === "1",
    "under ask a checked phase still holds without an accept (a waiver is not one)");

  for (const knob of ["none", null]) {
    const dir = makeTask(knob === null ? undefined : knob);
    if (knob === null) {
      const id = db.taskIdOf(dir);
      db.open().run("UPDATE tasks SET approvals = NULL WHERE id = ?", id);
    }
    decide({ taskDir: dir, phaseId: 1, choice: "waived", gate: "phase-plan", quote: "skip the ask" });
    const view = taskLib.readTaskJson(dir);
    const facts = require("./lib/advise").factsFor(dir, view);
    const move = require("./lib/advise").advise(view, facts).move;
    check(move !== "approve", `under ${knob === null ? "a migrated task" : knob} a waiver asks nothing (${move})`);
    const taskId = db.taskIdOf(dir);
    db.insertCheckmark(taskId, 1, "s", new Date().toISOString());
    db.appendEvent({ kind: "land", taskId, detail: JSON.stringify({ head: "0".repeat(40), migrated: true }) });
    const view2 = taskLib.readTaskJson(dir);
    check(landHold(view2, db.listDecisions({ taskId }), null) === null, `under ${knob === null ? "a migrated task" : knob} a land holds nothing`);
    const rendered = fs.readFileSync(path.join(dir, "task.md"), "utf8");
    check(rendered.includes("waived phase-plan (agent)"), `under ${knob === null ? "a migrated task" : knob} the block shows waived phase-plan (agent)`);
  }
}

// The advice changes with the rows: approve after the plan moves the phase to build.
{
  const dir = makeTask();
  const first = decide({ taskDir: dir, phaseId: 1, choice: "answer", quote: "what about caching?" });
  check(first.advice.move === "approve" && first.advice.question, "an answer leaves the plan waiting for approval");
  sleep(20);
  const approved = decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "yes, go" });
  check(approved.advice.move === "build" && approved.advice.phase.id === 1, `approve after the plan gives build (${approved.advice.move})`);
  const accepted = decide({ taskDir: dir, phaseId: 1, choice: "accept", quote: "looks good" });
  check(accepted.advice.move === "commit", `accept gives commit (${accepted.advice.move})`);
  const toReject = makeTask();
  sleep(20);
  const rejected = decide({ taskDir: toReject, phaseId: 1, choice: "reject", quote: "no, smaller" });
  check(rejected.advice.move === "revise" && /smaller/.test(rejected.advice.advice), `reject gives revise quoting the owner (${rejected.advice.move})`);
}

// Refusals happen before anything is written and each names its remedy.
{
  const dir = makeTask();
  const empty = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "   " }));
  check(empty.err && empty.err.code === "quote_required" && /A decision needs the owner's words/.test(empty.err.message), "an empty quote refuses with its remedy");
  const unknown = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "override", quote: "x" }));
  check(unknown.err && unknown.err.code === "unknown_choice" && CHOICES.every((c) => unknown.err.message.includes(c)), "an unknown choice refuses and lists the seven");
  const phase = attempt(() => decide({ taskDir: dir, phaseId: 9, choice: "approve", quote: "x" }));
  check(phase.err && phase.err.code === "unknown_phase" && /phases: 1, 2/.test(phase.err.message) && /add_phases/.test(phase.err.message), "an unknown phase lists the ids and names add_phases");
  check(rows(dir).length === 0, "no refusal wrote a row");
}

// note appends to the notes table, verbatim; a task-level note lands with a NULL phase.
{
  const dir = makeTask();
  const r = note({ taskDir: dir, phaseId: 2, text: "  see the review\n" });
  const taskId = db.taskIdOf(dir);
  const phaseNotes = db.listNotes(taskId).filter((nt) => nt.phase_id === 2);
  check(r.phase.note === "  see the review\n" && phaseNotes.length === 1 && phaseNotes[0].text === "  see the review\n", "note appends the text verbatim to the notes table");
  const taskNote = note({ taskDir: dir, phaseId: null, text: "task-level" });
  check(taskNote.phase.id === null && db.listNotes(taskId).some((nt) => nt.phase_id === null && nt.text === "task-level"), "a note without a phase lands on the task");
  const missing = attempt(() => note({ taskDir: dir, phaseId: 2, text: "" }));
  check(missing.err && /Remedy:/.test(missing.err.message), "an empty note refuses with a remedy");
}

// DH1: approve with --expect-plan-hash where the on-disk hash differs → plan_changed.
{
  const dir = makeTask();
  const planFile = path.join(dir, "plan", "phase-1-p.md");
  const realHash = derive.planHash(fs.readFileSync(planFile, "utf8"));
  const wrongHash = "0".repeat(64);
  const r = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "go", expectPlanHash: wrongHash }));
  check(r.err && r.err.code === "plan_changed" && /the plan changed since it was read/.test(r.err.message),
    `DH1: a wrong expect-plan-hash refuses plan_changed (${r.err && r.err.code})`);
  check(rows(dir).length === 0, "DH1: no row written on the refusal");
  // DH2: the same call with the matching hash records normally.
  const ok = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "go", expectPlanHash: realHash }));
  check(!ok.err && ok.result.decision_id !== null, `DH2: the matching hash records normally (${ok.err && ok.err.message})`);
}

// DH3: --expect-plan-hash with an unworthy shape → expect_hash_unworthy.
{
  const dir = makeTask();
  const answer = attempt(() => decide({ taskDir: dir, choice: "answer", gate: "task-plan", quote: "yes", expectPlanHash: "x".repeat(64) }));
  check(answer.err && answer.err.code === "expect_hash_unworthy" && /needs a choice that hashes a plan/.test(answer.err.message),
    `DH3: an answer with expect-plan-hash refuses expect_hash_unworthy (${answer.err && answer.err.code})`);
  const skip = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "skip", quote: "skip it", expectPlanHash: "x".repeat(64) }));
  check(skip.err && skip.err.code === "expect_hash_unworthy",
    `DH3: a skip with expect-plan-hash refuses expect_hash_unworthy (${skip.err && skip.err.code})`);
  const taskLevel = attempt(() => decide({ taskDir: dir, choice: "waived", gate: "finalize", quote: "x", expectPlanHash: "x".repeat(64) }));
  check(taskLevel.err && taskLevel.err.code === "expect_hash_unworthy",
    `DH3: a task-level waived with expect-plan-hash refuses expect_hash_unworthy (${taskLevel.err && taskLevel.err.code})`);
}

// DH4: the collapse — identical decide twice within the window → same decision_id, no new row or event.
{
  const dir = makeTask();
  const first = decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "go ahead" });
  const firstRows = rows(dir).length;
  const firstEvents = db.maxEventId();
  const second = decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "go ahead" });
  check(second.decision_id === first.decision_id, `DH4: the second identical decide returns the same decision_id (${first.decision_id} vs ${second.decision_id})`);
  check(rows(dir).length === firstRows, `DH4: listDecisions length unchanged (${rows(dir).length} vs ${firstRows})`);
  check(db.maxEventId() === firstEvents, `DH4: the events table unchanged (${db.maxEventId()} vs ${firstEvents})`);
}

// DH5: the non-collapse — a different quote, or a stale row past the window, inserts a second row.
{
  const dir = makeTask();
  decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "first" });
  const different = decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "different" });
  const allRows = rows(dir);
  check(allRows.length === 2 && allRows[1].decision_id === different.decision_id, `DH5: a different quote inserts a second row (${allRows.length} rows)`);

  const dir2 = makeTask();
  const firstId = db.insertDecision({ task_id: db.taskIdOf(dir2), phase_id: 1, choice: "approve", gate: null, plan_hash: null, quote: "stale", recorded_by: null, decided_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  const fresh = decide({ taskDir: dir2, phaseId: 1, choice: "approve", quote: "stale" });
  const allRows2 = rows(dir2);
  check(allRows2.length === 2 && fresh.decision_id !== firstId, `DH5: a same-shape row 11 minutes back inserts a second row (${allRows2.length} rows, first=${firstId}, fresh=${fresh.decision_id})`);

  // DH5 plan-hash dimension: the same quote on a changed plan does not collapse — two rows.
  const dir3 = makeTask();
  const planFile = path.join(dir3, "plan", "phase-1-p.md");
  decide({ taskDir: dir3, phaseId: 1, choice: "approve", quote: "same words" });
  fs.writeFileSync(planFile, "# revised plan\n");
  const second = decide({ taskDir: dir3, phaseId: 1, choice: "approve", quote: "same words" });
  const allRows3 = rows(dir3);
  check(allRows3.length === 2 && second.decision_id !== allRows3[0].decision_id, `DH5: a changed plan_hash with the same quote inserts a second row (${allRows3.length} rows)`);
}

// DH6: --recorded-by overrides the recorded_by default.
{
  const dir = makeTask();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const withFlag = decide({ taskDir: dir, phaseId: 1, choice: "approve", quote: "go", recordedBy: "abc" });
  const row = rows(dir).pop();
  check(row.recorded_by === "abc", `DH6: --recorded-by abc sets recorded_by to "abc" (${row.recorded_by})`);

  const dir2 = makeTask();
  process.env.CLAUDE_CODE_SESSION_ID = "env-sid-123";
  const noFlag = decide({ taskDir: dir2, phaseId: 1, choice: "approve", quote: "go" });
  const row2 = rows(dir2).pop();
  check(row2.recorded_by === "env-sid-123", `DH6: with the env set and no flag, recorded_by is the env id (${row2.recorded_by})`);
  delete process.env.CLAUDE_CODE_SESSION_ID;

  const dir3 = makeTask();
  const neither = decide({ taskDir: dir3, phaseId: 1, choice: "approve", quote: "go" });
  const row3 = rows(dir3).pop();
  check(row3.recorded_by === null, `DH6: with neither env nor flag, recorded_by is null for non-waived (${row3.recorded_by})`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
