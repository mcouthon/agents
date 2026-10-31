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
const { decide, note, CHOICES } = require("./lib/decide");
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
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

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

// Each of the six choices records one row with the verbatim quote, and no task file is written.
{
  check(CHOICES.join() === "approve,accept,reject,answer,skip,land_anyway", "the six choices");
  const dir = makeTask();
  for (const choice of CHOICES) {
    const quote = `  "${choice}" — verbatim,\tspaced  `;
    const r = attempt(() => decide({ taskDir: dir, phaseId: 1, choice, quote }));
    const last = rows(dir).pop();
    check(!r.err && last.choice === choice && last.quote === quote && r.result.decision_id === last.decision_id && r.result.quote === quote, `${choice}: one row with the owner's words byte for byte (${r.err && r.err.message})`);
  }
  check(rows(dir).length === 6 && !fs.existsSync(path.join(dir, "task.json")), "six rows, and no task.json is ever written");
  check(db.lastEventAt(db.taskIdOf(dir), "decide") !== null, "each decision appends an events row of kind decide");
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
  check(empty.err && empty.err.code === "quote_required" && /pass the owner's words verbatim as quote/.test(empty.err.message), "an empty quote refuses with its remedy");
  const unknown = attempt(() => decide({ taskDir: dir, phaseId: 1, choice: "override", quote: "x" }));
  check(unknown.err && unknown.err.code === "unknown_choice" && CHOICES.every((c) => unknown.err.message.includes(c)), "an unknown choice refuses and lists the six");
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

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
