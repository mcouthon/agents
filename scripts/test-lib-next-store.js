#!/usr/bin/env node
"use strict";
// The stored next step (`tasks.next_json`, `tasks.awaiting`), the Builder's start and the
// Committer's commits, driven through `a` with a stub `claude`.
// Isolation: nothing here may touch the real HOME, config, git config or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-nextstore-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "tasks", "sessions"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "AGENTS_TEST_SKIP_IDENTITY", "AGENTS_LAND",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "VIRTUAL_ENV", "POETRY_ACTIVE", "STUB_STREAM", "STUB_EXIT", "STUB_SLEEP"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");

const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const pause = (s) => execFileSync("/bin/sleep", [String(s)]);

fs.writeFileSync(path.join(T, "stubbin", "claude"), [
  "#!/bin/sh",
  "printf '%s\\0' \"$@\" > \"$CLAUDE_ARGV_LOG\"",
  "[ -n \"$STUB_STREAM\" ] && cat \"$STUB_STREAM\"",
  "[ -n \"$STUB_SLEEP\" ] && sleep \"$STUB_SLEEP\"",
  "exit \"${STUB_EXIT:-0}\"",
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${path.join(T, "stubbin")}:${process.env.PATH}`;

const pids = new Set();
process.on("exit", () => {
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
  }
});
const kill = (pid) => { try { process.kill(-pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; } };

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

db.open({ create: true });
const origin = path.join(T, "origin.git");
git(T, "init", "-q", "--bare", "-b", "main", origin);
const repoDir = path.join(T, "work", "acme");
fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
git(repoDir, "add", ".");
git(repoDir, "commit", "-q", "-m", "init");
git(repoDir, "remote", "add", "origin", origin);
git(repoDir, "push", "-q", "-u", "origin", "main");
git(repoDir, "remote", "set-head", "origin", "main");
const key = repoKey(repoDir);

let taskCounter = 0;
/** A task whose phases get `statuses` (default: two not_started), `edit(doc)` for anything else, and a plan file per phase. */
function mkTask({ mode = "full", statuses = ["not_started", "not_started"], edit } = {}) {
  const slug = `job${++taskCounter}`;
  const phases = statuses.map((_, i) => ({ id: i + 1, name: `P${i + 1}` }));
  const made = taskLib.createTask({ repo: key, title: slug, slug, mode, tier: mode === "fast" ? "minor" : "standard", phases, description: "" });
  const doc = taskLib.readTaskJson(made.task_dir);
  const filesDir = taskLib.filesDir(made.task_dir, doc);
  fs.mkdirSync(path.join(filesDir, "plan"), { recursive: true });
  doc.phases.forEach((p, i) => {
    p.status = statuses[i];
    fs.writeFileSync(path.join(filesDir, "plan", `phase-${p.id}.md`), "# plan\n");
    if (statuses[i] !== "not_started") p.plan_path = `plan/phase-${p.id}.md`;
  });
  if (edit) edit(doc);
  taskLib.writeTaskJson(made.task_dir, doc);
  return { dir: made.task_dir, filesDir, name: path.basename(made.task_dir) };
}
const readTask = (task) => taskLib.readTaskJson(task.dir);
const edit = (task, fn) => { const doc = readTask(task); fn(doc); taskLib.writeTaskJson(task.dir, doc); };

function a(args, env = {}) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: repoDir, timeout: 90000, env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function aJson(args, env) {
  const r = a([...args, "--json"], env);
  let data = null;
  try { data = r.out.trim() ? JSON.parse(r.out) : null; } catch { /* a refusal prints text */ }
  return { ...r, data };
}

const initLine = { type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/x", session_id: "s" };
const resultLine = (extra) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 3, permission_denials: [], modelUsage: { "claude-sonnet-5-5": {} }, terminal_reason: "completed", result: "done", ...extra });
function stream(lines) {
  const file = path.join(mk("stream"), "stream.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const explorerOut = (phaseId = 1) => ({ phase_id: phaseId, plan_path: `plan/phase-${phaseId}.md`, manifest: ["src/a.js"], open_questions: [], summary: "planned" });
const builderOut = (phaseId = 1) => ({ phase_id: phaseId, files_touched: ["a.js"], verification: [{ cmd: "true", exit: 0, summary: "ok" }], deviations: [], summary: "built" });
const committerOut = (sha, phaseId = 1) => ({ phase_id: phaseId, commits: [{ sha, files: ["f.txt"], message: "feat: f" }], pushed: false });
const successStream = (out) => stream([initLine, resultLine({ structured_output: out })]);
const cappedStream = () => stream([initLine, resultLine({ subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.05)"], terminal_reason: "budget_exhausted", result: undefined })]);
const noReportStream = () => stream([initLine, resultLine({ result: "I did it" })]);

function runStart(task, { phase = 1, agent = "explorer", brief = "Go", streamFile, exit = 0, sleep, env = {} } = {}) {
  const log = path.join(mk("argv"), "argv");
  const stubEnv = { CLAUDE_ARGV_LOG: log, STUB_EXIT: String(exit), ...(streamFile ? { STUB_STREAM: streamFile } : {}), ...(sleep ? { STUB_SLEEP: String(sleep) } : {}), ...env };
  const r = aJson(["run", "start", "--task-dir", task.dir, "--phase-id", String(phase), "--agent", agent, "--brief", brief], stubEnv);
  if (r.status === 0 && r.data) pids.add(r.data.pid);
  return { ...r, log };
}
function waitExit(runId) {
  const row = db.getRun(runId);
  for (let i = 0; i < 200 && !fs.existsSync(row.exit_path); i++) pause(0.05);
  return fs.existsSync(row.exit_path);
}
const reap = (task) => aJson(["run", "reap", "--task-dir", task.dir]);
const nextOf = (task) => aJson(["next", "--task-dir", task.dir]).data;
const storedRow = (task) => db.open().get("SELECT awaiting, next_json FROM tasks WHERE task_dir = ?", task.dir);
const storedNext = (task) => JSON.parse(storedRow(task).next_json);
const COMPARED = ["step", "phase_ids", "agent", "checkpoint", "push_needed", "call", "awaiting"];
/** The compared keys on which the stored next and a fresh `a next` differ (the stored row is read first, so `a next` cannot have written it). */
function differing(task) {
  const row = storedRow(task);
  const stored = JSON.parse(row.next_json);
  const printed = nextOf(task);
  const keys = COMPARED.filter((k) => JSON.stringify(stored[k]) !== JSON.stringify(printed[k]));
  if (row.awaiting !== printed.awaiting) keys.push("tasks.awaiting");
  return keys;
}
const passReview = { kind: "plan", verdict: "pass", issues: [], summary: "ok" };
const passCode = { kind: "code", verdict: "pass", issues: [], summary: "ok" };

// ---------------------------------------------------------------- N1
{
  const notStarted = mkTask();
  check(differing(notStarted).join() === "", `N1: a not_started task stores what a next prints (${differing(notStarted)})`);
  const reviewed = mkTask({ statuses: ["reviewed", "not_started"], edit: (d) => { d.phases[0].reports.reviewer = passReview; } });
  const rs = storedNext(reviewed);
  check(differing(reviewed).join() === "" && rs.step === "approve" && storedRow(reviewed).awaiting === "owner" && rs.call.verb === "decide" && rs.call.choices.join() === "approve,reject,skip,abort" && rs.call.text.includes("--choice approve --quote"),
    `N1: a reviewed phase waits for the owner, who answers with a decide (${rs.step}, ${storedRow(reviewed).awaiting}, ${JSON.stringify(rs.call)})`);
  const implemented = mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].reports.code_review = passCode; } });
  const is = storedNext(implemented);
  check(differing(implemented).join() === "" && is.step === "commit" && is.call.verb === "run start" && is.call.agent === "committer" && is.call.phase_id === 1 && is.awaiting === "commit",
    `N1: an implemented phase with a passing review offers the committer start (${JSON.stringify(is.call)}, ${is.awaiting})`);
  const landed = mkTask({ statuses: ["landed", "landed"] });
  const ls = storedNext(landed);
  check(differing(landed).join() === "" && ls.step === "consolidate" && ls.call.agent === "consolidator" && ls.call.phase_id === 2, `N1: a task with every phase landed offers the consolidator on the last phase (${ls.step}, ${JSON.stringify(ls.call)})`);
}

// ---------------------------------------------------------------- N2
{
  const task = mkTask();
  const run = runStart(task, { sleep: 30 });
  const live = storedNext(task);
  check(storedRow(task).awaiting === "agent" && live.live_run_id === run.data.run_id, `N2: a live run makes the task await the agent and names the run (${storedRow(task).awaiting}, ${live.live_run_id})`);
  kill(run.data.pid);
  for (let i = 0; i < 100 && db.getRun(run.data.run_id).status === "running"; i++) { reap(task); pause(0.05); }
  const dead = storedNext(task);
  check(storedRow(task).awaiting === "owner" && dead.call.verb === "run resume" && dead.call.run_id === run.data.run_id && dead.call.restart.includes("a run start --task-dir"),
    `N2: after the kill the owner decides on a resume, and the restart is kept (${storedRow(task).awaiting}, ${JSON.stringify(dead.call)})`);
}

// ---------------------------------------------------------------- N3
{
  const clarify = mkTask({ statuses: ["planned", "not_started"], edit: (d) => { d.phases[0].reports.explorer = { plan_path: "plan/phase-1.md", manifest: [], open_questions: [{ question: "Which db?", options: [] }], summary: "s" }; } });
  const cs = storedNext(clarify);
  check(cs.step === "blocked" && storedRow(clarify).awaiting === "owner" && cs.call.verb === "decide" && cs.call.choices.join() === "answer,skip,abort", `N3: open questions wait for the owner, who answers (${cs.step}, ${storedRow(clarify).awaiting}, ${JSON.stringify(cs.call)})`);

  const capped = mkTask({ statuses: ["approved", "not_started"] });
  const run = runStart(capped, { agent: "builder", streamFile: cappedStream(), exit: 1 });
  waitExit(run.data.run_id);
  reap(capped);
  const bs = storedNext(capped);
  check(db.getRun(run.data.run_id).status === "capped" && storedRow(capped).awaiting === "owner" && bs.call.verb === "run resume" && bs.call.run_id === run.data.run_id,
    `N3: a capped builder waits for the owner with a resume (${storedRow(capped).awaiting}, ${JSON.stringify(bs.call)})`);

  const reviewCap = mkTask({ statuses: ["planned", "not_started"], edit: (d) => { d.phases[0].counters.review_passes = 2; d.phases[0].reports.reviewer = { kind: "plan", verdict: "needs_work", issues: [], summary: "no" }; } });
  const rs = storedNext(reviewCap);
  check(rs.checkpoint && rs.checkpoint.type === "review_cap" && storedRow(reviewCap).awaiting === "owner" && rs.call.choices.join() === "approve,reject,skip,abort", `N3: the review cap waits for the owner (${storedRow(reviewCap).awaiting}, ${JSON.stringify(rs.call)})`);

  const fixCap = mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].counters.fix_attempts = 2; d.phases[0].reports.code_review = { kind: "code", verdict: "needs_work", issues: [], summary: "no" }; } });
  const fs_ = storedNext(fixCap);
  check(fs_.checkpoint && fs_.checkpoint.type === "fix_cap" && storedRow(fixCap).awaiting === "owner" && fs_.call.choices.join() === "approve,reject,skip,abort", `N3: the fix cap waits for the owner (${storedRow(fixCap).awaiting}, ${JSON.stringify(fs_.call)})`);

  const failed = mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].reports.code_review = { kind: "code", verdict: "fail", issues: [], summary: "no" }; } });
  const fl = storedNext(failed);
  check(fl.checkpoint && fl.checkpoint.type === "review_fail" && storedRow(failed).awaiting === "owner" && fl.call.choices.join() === "reject,skip,abort", `N3: a failed code review waits for the owner (${storedRow(failed).awaiting}, ${JSON.stringify(fl.call)})`);
}

// ---------------------------------------------------------------- N3b, N3c
{
  const task = mkTask();
  const run = runStart(task, { streamFile: noReportStream() });
  waitExit(run.data.run_id);
  reap(task);
  const s = storedNext(task);
  check(db.getRun(run.data.run_id).status === "no_report" && s.call.verb === "run resume" && s.call.run_id === run.data.run_id && storedRow(task).awaiting === "plan",
    `N3b: a run that ended without a report is the Conductor's to resume (${JSON.stringify(s.call)}, ${storedRow(task).awaiting})`);
}
{
  const task = mkTask();
  const run = runStart(task, { streamFile: stream([initLine]), exit: 143 });
  waitExit(run.data.run_id);
  reap(task);
  const before = storedNext(task);
  const report = aJson(["report", "--task-dir", task.dir, "--phase-id", "1", "--agent", "explorer", "--report-json", JSON.stringify(explorerOut(1))]);
  const after = storedNext(task);
  check(before.call.verb === "run resume" && report.status === 0 && after.step === "review_plan" && after.call.verb === "run start" && after.call.agent === "reviewer",
    `N3c: a reviewer start replaces the resume of a killed explorer once the phase has moved on (${before.call.verb} -> ${JSON.stringify(after.call)})`);
}

// ---------------------------------------------------------------- N4
{
  const task = mkTask();
  const doc = readTask(task);
  doc.phases[0].blocked_by = "1";
  taskLib.writeTaskJson(task.dir, doc);
  const row = storedRow(task);
  check(fs.readFileSync(path.join(task.dir, "task.json"), "utf8") === JSON.stringify(doc, null, 2) && JSON.parse(row.next_json).error && row.awaiting === null,
    `N4: a doc the next step cannot be computed for is still written, and the row says why (${row.next_json.slice(0, 80)})`);
}

// ---------------------------------------------------------------- N5
{
  const task = mkTask();
  const json = nextOf(task);
  const text = a(["next", "--task-dir", task.dir]);
  check(json.call && json.call.verb === "run start" && json.awaiting === "plan" && json.live_run_id === null && typeof json.computed_at === "string", `N5: a next --json carries call, awaiting, live_run_id and computed_at (${JSON.stringify(json.call)})`);
  check(/^Call: a run start --task-dir /m.test(text.out) && /^Awaiting: plan$/m.test(text.out), `N5: the text carries a Call and an Awaiting line (${text.out.trim().split("\n").join(" | ")})`);
}

// ---------------------------------------------------------------- N6
{
  fs.writeFileSync(path.join(process.env.HOME, ".claude", "repo-policies.json"), JSON.stringify({ [key.main_root]: "direct" }));
  fs.writeFileSync(path.join(repoDir, "n6.txt"), "n6\n");
  git(repoDir, "add", "n6.txt");
  git(repoDir, "commit", "-q", "-m", "feat: n6");
  const sha = git(repoDir, "rev-parse", "HEAD");
  const task = mkTask({ statuses: ["committed", "not_started"], edit: (d) => {
    const p = d.phases[0];
    p.commits = [sha];
    p.reports.reviewer = passReview;
    p.reports.code_review = passCode;
    p.reports.tests = { verification: [{ cmd: "true", exit: 0, summary: "ok" }] };
  } });
  const stored = storedNext(task);
  const printed = nextOf(task);
  check(printed.push_needed === true && stored.push_needed === true && stored.step === "done", `N6: a write stores push_needed as a next computes it under the repo's direct policy (${stored.push_needed} vs ${printed.push_needed})`);
  fs.writeFileSync(path.join(process.env.HOME, ".claude", "repo-policies.json"), "{}");
}

// ---------------------------------------------------------------- N7
{
  const task = mkTask();
  const run = runStart(task, { streamFile: stream([initLine]), exit: 143 });
  waitExit(run.data.run_id);
  const awaitingBefore = storedRow(task).awaiting;
  const lock = path.join(task.dir, ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "holder"), JSON.stringify({ session_id: "held", pid: process.pid }));
  const reaped = reap(task);
  const during = storedRow(task).awaiting;
  fs.rmSync(lock, { recursive: true });
  const after = nextOf(task);
  check(db.getRun(run.data.run_id).status === "killed" && awaitingBefore === "agent" && during === "agent" && reaped.err.includes("not refreshed"),
    `N7: with the lock held the reap still ends the run, skips the refresh and says so (${awaitingBefore}, ${during}, ${reaped.err.trim()})`);
  check(storedRow(task).awaiting === "owner" && after.awaiting === "owner", `N7: the next a next brings the stored value up to date (${storedRow(task).awaiting})`);
}

// ---------------------------------------------------------------- FR1
{
  const task = mkTask({ statuses: ["planned", "not_started"], edit: (d) => { d.phases[0].counters.review_passes = 2; d.phases[0].reports.reviewer = { kind: "plan", verdict: "needs_work", issues: [], summary: "no" }; } });
  const opened = aJson(["checkpoint", "open", "--task-dir", task.dir, "--phase-id", "1", "--type", "review_cap", "--question", "q", "--options-json", JSON.stringify(["approve_anyway", "force_replan", "skip"])]);
  const resolved = aJson(["checkpoint", "resolve", "--task-dir", task.dir, "--checkpoint-id", opened.data.id, "--chosen", "force_replan"]);
  const replan = nextOf(task);
  const report = aJson(["report", "--task-dir", task.dir, "--phase-id", "1", "--agent", "explorer", "--report-json", JSON.stringify(explorerOut(1))]);
  const review = nextOf(task);
  check(resolved.status === 0 && replan.step === "plan" && replan.agent === "explorer" && report.status === 0 && review.step === "review_plan",
    `FR1: force_replan sends the plan back to the explorer, whose report brings the review round (${replan.step}/${replan.agent} then ${review.step})`);
}

// ---------------------------------------------------------------- BI1, BI2
{
  const task = mkTask({ statuses: ["approved", "not_started"] });
  const run = runStart(task, { agent: "builder", streamFile: successStream(builderOut(1)), sleep: 1 });
  const during = readTask(task).phases[0];
  check(run.status === 0 && during.status === "in_progress" && typeof during.started === "string", `BI1: a builder start moves an approved phase to in_progress and stamps started (${run.err.trim()}, ${during.status})`);
  waitExit(run.data.run_id);
  reap(task);
  check(readTask(task).phases[0].status === "implemented", `BI1: the builder's result then moves it to implemented (${readTask(task).phases[0].status})`);

  const fast = mkTask({ mode: "fast", statuses: ["not_started"] });
  const fastRun = runStart(fast, { agent: "builder", streamFile: successStream(builderOut(1)), sleep: 1 });
  const fastDuring = readTask(fast).phases[0];
  check(fastRun.status === 0 && fastDuring.status === "in_progress", `BI1: a fast task's first builder start moves it to in_progress (${fastRun.err.trim()}, ${fastDuring.status})`);
  waitExit(fastRun.data.run_id);
  reap(fast);
  check(readTask(fast).phases[0].status === "implemented", "BI1: and the result moves it to implemented");
}
{
  const task = mkTask({ statuses: ["approved", "not_started"] });
  const run = runStart(task, { agent: "builder", sleep: 30 });
  check(readTask(task).phases[0].status === "in_progress", "BI2: the start moved the phase");
  kill(run.data.pid);
  for (let i = 0; i < 100 && db.getRun(run.data.run_id).status === "running"; i++) { reap(task); pause(0.05); }
  const step = nextOf(task);
  check(readTask(task).phases[0].status === "in_progress" && step.step === "build" && step.agent === "builder", `BI2: after the kill the phase stays in_progress and a next says build (${step.step})`);
  const report = aJson(["report", "--task-dir", task.dir, "--phase-id", "1", "--agent", "builder", "--report-json", JSON.stringify(builderOut(1))]);
  check(report.status === 0 && readTask(task).phases[0].status === "implemented", `BI2: a hand-stored builder report then reaches implemented, as a reaped one does (${report.err.trim()})`);
}

// ---------------------------------------------------------------- CM2
{
  fs.writeFileSync(path.join(repoDir, "cm2.txt"), "cm2\n");
  git(repoDir, "add", "cm2.txt");
  git(repoDir, "commit", "-q", "-m", "feat: cm2");
  const full = git(repoDir, "rev-parse", "HEAD");
  const task = mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].reports.code_review = passCode; } });
  const run = runStart(task, { agent: "committer", streamFile: successStream(committerOut(full.slice(0, 9), 1)) });
  waitExit(run.data.run_id);
  reap(task);
  const phase = readTask(task).phases[0];
  check(db.getRun(run.data.run_id).status === "succeeded" && phase.status === "committed" && phase.commits.join() === full && phase.reports.committer.pushed === false,
    `CM2: a committer run whose SHA resolves moves the phase to committed with the full SHA, pushed stored as reported (${phase.status}, ${phase.commits})`);
}

// ---------------------------------------------------------------- PH1 to PH4: the prime hook injects the stored next step
const primeHook = require("./lib/hooks/prime");
const sessionLib = require("./lib/session");
let sidCounter = 0;
/** What the prime hook prints for a Conductor session bound to `task`. */
function primeContext(task, { origin } = {}) {
  const sid = `ph-sid-${++sidCounter}`;
  const dir = path.join(sessionLib.sessionsRoot(), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "registration.json"), JSON.stringify({ schema: 1, session_id: sid, agent: "conductor", task_dir: task.dir, cwd: repoDir, pid: null, ...(origin ? { origin } : {}) }));
  const out = primeHook.run({ session_id: sid, cwd: repoDir, hook_event_name: "UserPromptSubmit" });
  return out ? out.hookSpecificOutput.additionalContext : "";
}
const taskIdOf = (task) => db.taskIdOf(task.dir);
{
  const reviewed = mkTask({ statuses: ["reviewed", "not_started"], edit: (d) => { d.phases[0].reports.reviewer = passReview; } });
  const stored = storedNext(reviewed);
  const text = primeContext(reviewed);
  const lines = text.split("\n");
  check(lines.includes(`Call: ${stored.call.text}`) && lines.includes("Awaiting: owner") && !lines.some((l) => l.startsWith("How:")) && lines[lines.length - 1] === `Task dir: ${reviewed.dir}` && stored.call.text.includes("--choice approve --quote"),
    `PH1: a bound task with a call gets Call and Awaiting from the stored next, no How line, and Task dir last (${JSON.stringify(text)})`);
}
{
  const task = mkTask();
  const run = runStart(task, { streamFile: successStream(explorerOut(1)) });
  waitExit(run.data.run_id);
  const text = primeContext(task);
  check(db.getRun(run.data.run_id).status === "succeeded" && readTask(task).phases[0].status === "planned" && text.split("\n").includes("Step: review_plan"),
    `PH2: the prime hook reaps a finished run and says the step the stored result leads to (${db.getRun(run.data.run_id).status}, ${readTask(task).phases[0].status}, ${text.split("\n")[0]})`);
}
{
  const task = mkTask();
  const base = storedNext(task);
  db.setNext(taskIdOf(task), JSON.stringify({ ...base, awaiting: "owner", call: { verb: "decide", phase_id: 1, choices: ["approve"], text: "STORED-CALL" } }), "owner");
  const text = primeContext(task);
  check(text.split("\n").includes("Call: STORED-CALL") && text.split("\n").includes("Awaiting: owner"), `PH3: the call comes from the stored row, not from a fresh computation (${JSON.stringify(text)})`);
}
{
  const task = mkTask();
  db.setNext(taskIdOf(task), "{\"error\":\"boom\"}", null);
  const text = primeContext(task);
  const lines = text.split("\n");
  check(lines.includes("Step: plan") && lines.some((l) => l.startsWith("Call: a run start --task-dir ")) && !text.includes("boom"),
    `PH4: a stored error is ignored and the next step is computed afresh (${JSON.stringify(text)})`);
}
{
  const task = mkTask();
  const text = primeContext(task, { origin: "dispatch" });
  check(text === "", "PH5: a dispatched run's session gets nothing");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
