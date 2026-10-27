#!/usr/bin/env node
"use strict";
// `a run`: headless agent runs, driven through the CLI with a stub `claude`.
// Isolation: nothing here may touch the real HOME, config, git config or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-run-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "procs", "tasks", "sessions"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.writeFileSync(path.join(t, "home", ".claude", "repo-policies.json"), "{}");
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
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "PAV_TERMINAL_ID", "PAV_TERMINAL_DIR", "VIRTUAL_ENV", "POETRY_ACTIVE",
    "STUB_STREAM", "STUB_EXIT", "STUB_STDERR", "STUB_SLEEP"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const pause = (s) => execFileSync("/bin/sleep", [String(s)]);

// A stub claude records what it was given and prints a canned stream. A copied binary would be killed on arm64.
fs.writeFileSync(path.join(T, "stubbin", "claude"), [
  "#!/bin/sh",
  "printf '%s\\0' \"$@\" > \"$CLAUDE_ARGV_LOG\"",
  "pwd > \"$CLAUDE_ARGV_LOG.cwd\"",
  "env > \"$CLAUDE_ARGV_LOG.env\"",
  "[ -f \"$AGENTS_SESSION_DIR/registration.json\" ] && cp \"$AGENTS_SESSION_DIR/registration.json\" \"$CLAUDE_ARGV_LOG.reg\"",
  "[ -n \"$STUB_STDERR\" ] && printf '%s\\n' \"$STUB_STDERR\" >&2",
  "[ -n \"$STUB_STREAM\" ] && cat \"$STUB_STREAM\"",
  "[ -n \"$STUB_SLEEP\" ] && sleep \"$STUB_SLEEP\"",
  "exit \"${STUB_EXIT:-0}\"",
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${path.join(T, "stubbin")}:${process.env.PATH}`;

// A process whose command line contains "claude", so a registration stamped with its pid counts as live.
fs.writeFileSync(path.join(T, "procs", "claude"), '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
const pids = new Set();
function spawnClaude() {
  const child = spawn(path.join(T, "procs", "claude"), ["60"], { stdio: "ignore", detached: true });
  pids.add(child.pid);
  for (let i = 0; i < 100; i++) {
    if (execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).includes("claude")) break;
    pause(0.02);
  }
  return child;
}
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

// A task with phase 1 not_started, phase 2 in the given status, and the plan file an Explorer would have written.
let taskCounter = 0;
function mkTask(phase2Status = "in_progress", phase1Status = "not_started") {
  const slug = `job${++taskCounter}`;
  const made = taskLib.createTask({ repo: key, title: slug, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "One" }, { id: 2, name: "Two" }], description: "" });
  const doc = taskLib.readTaskJson(made.task_dir);
  doc.phases[0].status = phase1Status;
  doc.phases[1].status = phase2Status;
  taskLib.writeTaskJson(made.task_dir, doc);
  const filesDir = taskLib.filesDir(made.task_dir, doc);
  fs.mkdirSync(path.join(filesDir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(filesDir, "plan", "phase-1.md"), "# plan\n");
  return { dir: made.task_dir, filesDir, name: path.basename(made.task_dir) };
}
const readTask = (task) => taskLib.readTaskJson(task.dir);

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

// Canned streams, shaped like what `claude -p --output-format stream-json --verbose` prints.
const initLine = { type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/x", session_id: "s" };
const toolLine = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const threeTools = [toolLine("Read", { file_path: "/x/a.js" }), toolLine("Edit", { file_path: "/x/a.js" }), toolLine("Bash", { command: "npm test\n--silent" })];
const resultLine = (extra) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, duration_ms: 1234, num_turns: 7, permission_denials: [], modelUsage: { "claude-sonnet-5-5": {} }, terminal_reason: "completed", result: "done", ...extra });
function stream(lines) {
  const file = path.join(mk("stream"), "stream.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const explorerOut = (phaseId = 1) => ({ phase_id: phaseId, plan_path: "plan/phase-1.md", manifest: ["src/a.js"], open_questions: [], summary: "planned" });
const builderOut = (phaseId = 2) => ({ phase_id: phaseId, files_touched: ["a.js"], verification: [{ cmd: "true", exit: 0, summary: "ok" }], deviations: [], summary: "built" });
const successStream = (out) => stream([initLine, ...threeTools, resultLine({ structured_output: out })]);

function runStart(task, { phase = 1, agent = "explorer", brief = "Plan it", model, streamFile, exit = 0, stderr, sleep, env = {} } = {}) {
  const log = path.join(mk("argv"), "argv");
  const stubEnv = { CLAUDE_ARGV_LOG: log, STUB_EXIT: String(exit), ...(streamFile ? { STUB_STREAM: streamFile } : {}), ...(stderr ? { STUB_STDERR: stderr } : {}), ...(sleep ? { STUB_SLEEP: String(sleep) } : {}), ...env };
  const r = aJson(["run", "start", "--task-dir", task.dir, "--phase-id", String(phase), "--agent", agent, "--brief", brief, ...(model ? ["--model", model] : [])], stubEnv);
  if (r.status === 0 && r.data) pids.add(r.data.pid);
  return { ...r, log };
}
function waitExit(runId) {
  const row = db.getRun(runId);
  for (let i = 0; i < 200 && !fs.existsSync(row.exit_path); i++) pause(0.05);
  return fs.existsSync(row.exit_path);
}
const reap = (extra = []) => aJson(["run", "reap", ...extra]);
const argvOf = (log) => fs.readFileSync(log, "utf8").split("\0").slice(0, -1);
const envOf = (log) => fs.readFileSync(log + ".env", "utf8").split("\n").filter(Boolean);
const sessionCount = () => fs.readdirSync(process.env.AGENTS_SESSIONS_ROOT).length;

// ---------------------------------------------------------------- start
// R1: the registration exists before claude starts; the files live in the run's session dir.
const r1Task = mkTask();
const r1Stream = successStream(explorerOut());
const r1 = runStart(r1Task, { streamFile: r1Stream });
{
  const d = r1.data;
  check(r1.status === 0 && d && Number.isInteger(d.run_id) && d.status === "running" && Number.isInteger(d.pid) && d.session_id, `R1: a run start exits 0 with the run, its session and pid (${r1.status}: ${r1.err.trim()})`);
  const row = db.getRun(d.run_id);
  const reg = JSON.parse(fs.readFileSync(path.join(process.env.AGENTS_SESSIONS_ROOT, d.session_id, "registration.json"), "utf8"));
  check(reg.task_dir === r1Task.dir && reg.agent === "explorer" && reg.origin === "dispatch" && reg.cwd === key.main_root, `R1: the registration binds the task as an explorer dispatch in the main checkout (${JSON.stringify(reg)})`);
  waitExit(d.run_id);
  const seen = fs.existsSync(r1.log + ".reg") ? JSON.parse(fs.readFileSync(r1.log + ".reg", "utf8")) : null;
  check(seen && seen.session_id === d.session_id && seen.task_dir === r1Task.dir, "R1: claude already saw the registration when it started");
  check(fs.readFileSync(r1.log + ".cwd", "utf8").trim() === key.main_root, "R1: claude ran in the main checkout");
  const base = path.join(process.env.AGENTS_SESSIONS_ROOT, d.session_id, "runs", String(d.run_id));
  check(row.stream_path === `${base}.jsonl` && row.err_path === `${base}.err` && row.exit_path === `${base}.exit`, `R1: the three files sit in the run's session dir (${row.stream_path})`);
  check(!fs.existsSync(path.join(r1Task.filesDir, "runs")), "R1: nothing about the run is written under the task's files dir");
}

// R1 argv
{
  const w = argvOf(r1.log);
  const sid = r1.data.session_id;
  const schema = JSON.parse(w[12] || "null");
  const brief = w[18] || "";
  check(w.length === 19 && JSON.stringify(w.slice(0, 12)) === JSON.stringify(["-p", "--agent", "Explorer", "--session-id", sid, "--add-dir", r1Task.filesDir, "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--json-schema"]) && JSON.stringify(w.slice(13, 18)) === JSON.stringify(["--output-format", "stream-json", "--verbose", "--max-budget-usd", "8"]), `R1: the argv is the 19 words in order (${JSON.stringify(w.slice(0, 12))} ... ${JSON.stringify(w.slice(13, 18))}, ${w.length} words)`);
  check(schema && JSON.stringify(schema.required) === JSON.stringify(["plan_path", "manifest", "open_questions", "summary"]) && !/"skeleton"/.test(w[12]), "R1: the schema word is the explorer schema without renderer hints");
  check(brief.endsWith("\n\nPlan it") && brief.includes("Phase id: 1") && brief.includes(r1Task.filesDir) && !w.includes("--model"), "R1: the brief carries the phase id and files dir before the caller's words, and no --model is passed");
}

// R1 env
{
  const venv = path.join(T, "venv");
  fs.mkdirSync(venv, { recursive: true });
  const callerPath = `${venv}/bin:${process.env.PATH}`;
  const caller = { CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: "caller-session", AGENTS_SESSION_ID: "caller-sid", AGENTS_LAND: "1", PAV_TERMINAL_ID: "term-1", PAV_TERMINAL_DIR: "/term", ZMX_SESSION: "zmx-1", CLAUDE_CODE_MESSAGING_SOCKET: "sock", CLAUDE_CODE_MESSAGING_TOKEN: "tok", VIRTUAL_ENV: venv, POETRY_ACTIVE: "1", PATH: callerPath };
  const run = runStart(mkTask(), { env: caller });
  waitExit(run.data.run_id);
  const lines = envOf(run.log);
  const names = lines.map((l) => l.split("=")[0]);
  const leaked = Object.keys(caller).filter((k) => k !== "PATH" && names.includes(k));
  const row = db.getRun(run.data.run_id);
  check(leaked.join() === "", `R1: none of the caller's session, terminal, messaging or virtualenv variables reach claude (${leaked.join()})`);
  check(lines.includes(`PATH=${callerPath}`), "R1: PATH reaches claude as the caller had it");
  check(lines.includes(`AGENTS_SESSION_DIR=${path.join(process.env.AGENTS_SESSIONS_ROOT, run.data.session_id)}`) && lines.includes(`AGENTS_RUN_OUT=${row.stream_path}`) && lines.includes(`AGENTS_RUN_ERR=${row.err_path}`) && lines.includes(`AGENTS_RUN_EXIT=${row.exit_path}`) && lines.includes(`HOME=${process.env.HOME}`), "R1: claude gets the run's session dir and file paths, and keeps HOME");
}

// R1b: haiku and the builder schema
{
  const run = runStart(mkTask("in_progress", "landed"), { phase: 2, agent: "builder", model: "haiku" });
  waitExit(run.data.run_id);
  const w = argvOf(run.log);
  const schema = JSON.parse(w[14] || "null");
  check(w.length === 21 && w[5] === "--model" && w[6] === "haiku" && w[4] === run.data.session_id, `R1b: --model haiku are the two words right after the session id (${w.length} words: ${JSON.stringify(w.slice(0, 8))})`);
  const item = schema && schema.properties.verification.items.properties;
  check(item && item.expected_exit && !/"skeleton"/.test(w[14]) && w[w.length - 2] === "15", "R1b: the builder schema offers expected_exit, has no renderer hints and the cap is 15");
}

// R1c: refusals register nothing
{
  const task = mkTask();
  const before = { rows: db.listRuns().length, sessions: sessionCount() };
  const badModel = runStart(task, { model: "opus" });
  const badAgent = runStart(task, { agent: "oracle" });
  const noPhase = runStart(task, { phase: 9 });
  check(badModel.status === 2 && badAgent.status === 2 && noPhase.status === 4, `R1c: bad model, bad agent and unknown phase exit 2, 2, 4 (${badModel.status}, ${badAgent.status}, ${noPhase.status})`);
  check(db.listRuns().length === before.rows && sessionCount() === before.sessions, "R1c: no run row and no registration were added");
}

// ---------------------------------------------------------------- reap
// R2: a finished explorer run moves the phase like `a report` does
{
  waitExit(r1.data.run_id);
  const out = reap(["--task-dir", r1Task.dir]);
  const row = db.getRun(r1.data.run_id);
  const phase = readTask(r1Task).phases[0];
  check(out.status === 0 && row.status === "succeeded" && row.transition === "not_started → planned", `R2: the run is succeeded and names the transition (${row.status}, ${row.transition}, ${out.err.trim()})`);
  check(phase.status === "planned" && phase.reports.explorer.plan_path === "plan/phase-1.md" && phase.reports.explorer.written_by.session_id === r1.data.session_id, "R2: phase 1 is planned and the report is attributed to the run's session");
  check(row.cost_usd === 0.42 && row.duration_ms === 1234 && row.num_turns === 7 && row.model === "claude-sonnet-5-5" && row.permission_denials === "[]" && typeof row.ended_at === "string", `R2: cost, duration, turns, model, denials and end time are on the row (${JSON.stringify({ c: row.cost_usd, m: row.model })})`);
  const reg = JSON.parse(fs.readFileSync(path.join(row.session_dir, "registration.json"), "utf8"));
  check(typeof reg.ended_at === "string", "R2: the run's registration is ended");
}

// R3: a succeeded builder run
const r3Task = mkTask("in_progress", "landed");
const r3 = runStart(r3Task, { phase: 2, agent: "builder", streamFile: successStream(builderOut()) });
{
  waitExit(r3.data.run_id);
  reap(["--task-dir", r3Task.dir]);
  const row = db.getRun(r3.data.run_id);
  const phase = readTask(r3Task).phases[1];
  check(row.status === "succeeded" && phase.status === "implemented" && phase.reports.builder.summary === "built" && phase.reports.tests.verification[0].cmd === "true", `R3: the builder run is succeeded, phase 2 implemented, builder and tests stored (${row.status}, ${phase.status})`);
}

// R4: a result without a structured output
{
  const task = mkTask();
  const run = runStart(task, { streamFile: stream([initLine, resultLine({ result: "I did it" })]) });
  waitExit(run.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(run.data.run_id);
  check(row.status === "no_report" && row.result_text === "I did it" && readTask(task).phases[0].status === "not_started" && row.git_status !== null, `R4: no_report keeps the words and moves nothing (${row.status}, ${row.result_text})`);
}

// R5: the dollar cap
{
  const task = mkTask();
  const capped = resultLine({ subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.05)"], terminal_reason: "budget_exhausted", result: undefined });
  const run = runStart(task, { streamFile: stream([initLine, capped]), exit: 1 });
  waitExit(run.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(run.data.run_id);
  check(row.status === "capped" && row.subtype === "error_max_budget_usd" && row.error.includes("Reached maximum budget") && readTask(task).phases[0].status === "not_started", `R5: capped, with the reason and nothing moved (${row.status}, ${row.error})`);
}

// R6: killed runs
const r6Task = mkTask();
const r6a = runStart(r6Task, { streamFile: stream([initLine, threeTools[0]]), exit: 143 });
{
  const task = mkTask();
  const b = runStart(task, { streamFile: stream([initLine, threeTools[0]]), exit: 137 });
  waitExit(r6a.data.run_id); waitExit(b.data.run_id);
  reap(["--task-dir", r6Task.dir]); reap(["--task-dir", task.dir]);
  const rowA = db.getRun(r6a.data.run_id), rowB = db.getRun(b.data.run_id);
  check(rowA.status === "killed" && rowA.exit_code === 143 && rowB.status === "killed" && rowB.exit_code === 137, `R6: exits 143 and 137 are killed with their codes (${rowA.status}/${rowA.exit_code}, ${rowB.status}/${rowB.exit_code})`);
  const sleeper = runStart(mkTask(), { sleep: 30 });
  kill(sleeper.data.pid);
  let row = null;
  for (let i = 0; i < 100; i++) {
    reap();
    row = db.getRun(sleeper.data.run_id);
    if (row.status !== "running") break;
    pause(0.05);
  }
  check(row.status === "killed" && row.exit_code === null, `R6: a wrapper killed outright is killed with no exit code (${row.status}, ${row.exit_code})`);
}

// R7: crashed
{
  const task = mkTask();
  fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x\n");
  const run = runStart(task, { stderr: "boom: no auth", exit: 2 });
  waitExit(run.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(run.data.run_id);
  check(row.status === "crashed" && row.error.includes("boom: no auth") && row.git_status.includes("?? dirty.txt"), `R7: crashed keeps stderr and the checkout's git status (${row.status}, ${row.error})`);
  fs.rmSync(path.join(repoDir, "dirty.txt"));
}

// R8: a report the engine refuses
{
  const task = mkTask();
  const run = runStart(task, { streamFile: successStream(explorerOut(9)) });
  waitExit(run.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(run.data.run_id);
  check(row.status === "refused" && row.error.includes("phase_id 9") && readTask(task).phases[0].status === "not_started", `R8: a mismatched phase_id is refused with the reason (${row.status}, ${row.error})`);
}

// R8b: the task lock is held while the run is reaped
{
  const task = mkTask("in_progress", "landed");
  const run = runStart(task, { phase: 2, agent: "builder", streamFile: successStream(builderOut()) });
  waitExit(run.data.run_id);
  const lock = path.join(task.dir, ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "holder"), JSON.stringify({ session_id: "held", pid: process.pid }));
  const before = fs.readFileSync(path.join(task.dir, "task.json"), "utf8");
  reap(["--task-dir", task.dir]);
  const deferred = db.getRun(run.data.run_id);
  const reg = JSON.parse(fs.readFileSync(path.join(deferred.session_dir, "registration.json"), "utf8"));
  check(deferred.status === "running" && deferred.error.includes("report not stored yet") && deferred.error.includes("Lock held by held") && !deferred.ended_at && !reg.ended_at && fs.readFileSync(path.join(task.dir, "task.json"), "utf8") === before, `R8b: a held lock defers the report and writes nothing else (${deferred.status}, ${deferred.error})`);
  fs.rmSync(lock, { recursive: true });
  reap(["--task-dir", task.dir]);
  const done = db.getRun(run.data.run_id);
  check(done.status === "succeeded" && readTask(task).phases[1].status === "implemented" && readTask(task).phases[1].reports.builder.summary === "built", `R8b: the next reap stores it once (${done.status})`);
}

// R8c: a task with no tasks row
{
  const task = mkTask();
  const conn = db.open();
  conn.run("DELETE FROM tasks WHERE task_dir = ?", task.dir);
  const before = { rows: db.listRuns().length, sessions: sessionCount() };
  const run = runStart(task);
  check(run.status === 2 && run.err.includes("no tasks row") && db.listRuns().length === before.rows && sessionCount() === before.sessions, `R8c: a task with no tasks row is refused before anything is registered (${run.status}: ${run.err.trim()})`);
}

// R9: a run is persisted once
{
  const before = fs.readFileSync(path.join(r3Task.dir, "task.json"), "utf8");
  const again = reap();
  check(again.status === 0 && JSON.stringify(again.data) === "[]" && fs.readFileSync(path.join(r3Task.dir, "task.json"), "utf8") === before, "R9: reaping again returns nothing and changes nothing");
}

// R10: one live run per phase
const r10Task = mkTask("in_progress", "landed");
const conductorProc = spawnClaude();
session.register({ session_id: "conductor-r10", session_dir: mk("conductor"), pid: conductorProc.pid, pid_at: new Date().toISOString(), agent: "conductor", origin: "cli", cwd: key.main_root, repo_key: key.key, task_dir: r10Task.dir });
pause(0.05);
const r10 = runStart(r10Task, { phase: 2, agent: "builder", sleep: 30 });
{
  const second = runStart(r10Task, { phase: 2, agent: "builder" });
  check(second.status === 2 && second.err.includes(`run ${r10.data.run_id}`) && second.err.includes("a run wait"), `R10: a second run on the phase is refused, naming the first (${second.status}: ${second.err.trim()})`);
}

// R18: a live run, started after a live Conductor on the same task, is the task's live session in `a ls`
{
  const claude = spawnClaude();
  session.register({ session_id: r10.data.session_id, session_dir: db.getRun(r10.data.run_id).session_dir, pid: claude.pid, pid_at: new Date().toISOString() });
  const ls = aJson(["ls"]);
  const row = ls.data && ls.data.tasks.find((t) => t.dir === r10Task.dir);
  const reg = JSON.parse(fs.readFileSync(path.join(db.getRun(r10.data.run_id).session_dir, "registration.json"), "utf8"));
  check(row && row.live && row.live.session_id === r10.data.session_id && reg.origin === "dispatch", `R18: a live dispatched run shows as the task's live session (${row && JSON.stringify(row.live)})`);
}
kill(r10.data.pid);

// R11: resume
{
  const task = mkTask();
  const conductor = session.register({ session_id: "conductor-r11", session_dir: mk("conductor"), pid: process.pid, agent: "conductor", origin: "cli", task_dir: task.dir });
  const conductorBytes = fs.readFileSync(path.join(conductor.session_dir, "registration.json"), "utf8");
  const killed = runStart(task, { streamFile: stream([initLine, threeTools[0]]), exit: 143 });
  waitExit(killed.data.run_id);
  reap(["--task-dir", task.dir]);
  const sourceBefore = fs.readFileSync(db.getRun(killed.data.run_id).stream_path, "utf8");
  const log = path.join(mk("argv"), "argv");
  const resumed = aJson(["run", "resume", "--run-id", String(killed.data.run_id), "--brief", "go on"], { AGENTS_SESSION_DIR: conductor.session_dir, AGENTS_SESSION_ID: "conductor-r11", CLAUDE_ARGV_LOG: log, STUB_EXIT: "0" });
  if (resumed.data) pids.add(resumed.data.pid);
  check(resumed.status === 0 && resumed.data, `R11: a killed run resumes (${resumed.status}: ${resumed.err.trim()})`);
  const row = db.getRun(resumed.data.run_id);
  const source = db.getRun(killed.data.run_id);
  waitExit(row.run_id);
  const w = argvOf(log);
  check(row.resumed_from === killed.data.run_id && row.session_id === source.session_id && row.stream_path === path.join(source.session_dir, "runs", `${row.run_id}.jsonl`) && fs.readFileSync(source.stream_path, "utf8") === sourceBefore, "R11: the new run shares the session, writes its own files beside the source's and leaves them as they were");
  check(w[3] === "--resume" && w[4] === source.session_id && !w.includes("--session-id") && w[2] === "Explorer", `R11: the argv resumes the session instead of naming it (${JSON.stringify(w.slice(0, 6))})`);
  const seen = JSON.parse(fs.readFileSync(log + ".reg", "utf8"));
  check(!seen.ended_at && seen.origin === "dispatch" && !seen.parent_session_id && fs.readFileSync(path.join(conductor.session_dir, "registration.json"), "utf8") === conductorBytes, "R11: claude saw a live dispatch registration with no parent, and the caller's own registration is untouched");

  const live = runStart(task, { sleep: 30 });
  const refusedSource = aJson(["run", "resume", "--run-id", String(live.data.run_id), "--brief", "x"]);
  const refusedSibling = aJson(["run", "resume", "--run-id", String(killed.data.run_id), "--brief", "x"]);
  check(refusedSource.status === 2 && refusedSibling.status === 2 && refusedSibling.err.includes(`run ${live.data.run_id}`), `R11: a live source and a live sibling on the phase both refuse the resume (${refusedSource.status}, ${refusedSibling.status}: ${refusedSibling.err.trim()})`);
  kill(live.data.pid);
}

// R12: wait is capped
{
  const task = mkTask();
  const run = runStart(task, { sleep: 30 });
  const t0 = Date.now();
  const waited = aJson(["run", "wait", "--run-id", String(run.data.run_id), "--seconds", "2"]);
  const took = (Date.now() - t0) / 1000;
  const over = aJson(["run", "wait", "--run-id", String(run.data.run_id), "--seconds", "241"]);
  check(waited.status === 0 && waited.data.finished === false && waited.data.run.status === "running" && took < 6, `R12: wait returns unfinished after its seconds (${waited.status}, finished ${waited.data && waited.data.finished}, ${took}s)`);
  check(over.status === 2 && over.err.includes("240"), `R12: more than 240 seconds is refused naming the cap (${over.status}: ${over.err.trim()})`);
  kill(run.data.pid);
}

// R13: wait returns the next step
{
  const task = mkTask("in_progress", "landed");
  const run = runStart(task, { phase: 2, agent: "builder", streamFile: successStream(builderOut()) });
  const waited = aJson(["run", "wait", "--run-id", String(run.data.run_id)]);
  check(waited.status === 0 && waited.data.finished === true && waited.data.run.status === "succeeded" && waited.data.next.step === "review_code", `R13: wait reaps and names the next step (${waited.status}: ${waited.data && waited.data.next && waited.data.next.step}, ${waited.err.trim()})`);
}

// R14: `a next` reaps first
{
  const task = mkTask("in_progress", "landed");
  const run = runStart(task, { phase: 2, agent: "builder", streamFile: successStream(builderOut()) });
  waitExit(run.data.run_id);
  const next = aJson(["next", "--task-dir", task.dir]);
  check(next.status === 0 && readTask(task).phases[1].status === "implemented" && db.getRun(run.data.run_id).status === "succeeded", `R14: a next stores the finished run without a reap (${next.status}: ${next.err.trim()})`);
}

// R15: tail
{
  const full = aJson(["run", "tail", "--run-id", String(r3.data.run_id)]);
  const two = aJson(["run", "tail", "--run-id", String(r3.data.run_id), "--lines", "2"]);
  check(full.status === 0 && full.data.tool_calls === 3 && full.data.tool_uses.map((u) => u.name).join() === "Read,Edit,Bash", `R15: tail counts the tool calls and names them (${full.status}: ${JSON.stringify(full.data && full.data.tool_uses)})`);
  check(two.data.tool_calls === 3 && two.data.tool_uses.map((u) => u.name).join() === "Edit,Bash" && two.data.tool_uses[1].detail === "npm test --silent", `R15: --lines 2 keeps the last two, details on one line (${JSON.stringify(two.data && two.data.tool_uses)})`);
  const text = a(["run", "tail", "--run-id", String(r3.data.run_id), "--lines", "1"]);
  check(text.out.split("\n")[0].startsWith(`Run ${r3.data.run_id} builder succeeded`) && text.out.includes("3 tool calls") && text.out.includes("Bash: npm test --silent"), `R15: the text form has a header and the last tool use (${text.out.trim()})`);
}

// R16: without the database nothing is registered or written
{
  const none = path.join(T, "none.db");
  const saved = process.env.AGENTS_DB;
  process.env.AGENTS_DB = none;
  let task;
  try { task = mkTask(); } finally { process.env.AGENTS_DB = saved; }
  const before = sessionCount();
  const next = a(["next", "--task-dir", task.dir, "--json"], { AGENTS_DB: none });
  const run = runStart(task, { env: { AGENTS_DB: none } });
  check(next.status === 0 && next.err === "", `R16: a next on a file task exits 0 with nothing on stderr (${next.status}: ${next.err.trim()})`);
  check(run.status === 2 && run.err.includes("file-only mode") && sessionCount() === before && !fs.existsSync(none), `R16: a run start refuses naming file-only mode and registers nothing (${run.status}: ${run.err.trim()})`);
}

// R17: a default-model run that merely used haiku inside resumes without --model
{
  const task = mkTask();
  const used = runStart(task, { streamFile: stream([initLine, resultLine({ modelUsage: { "claude-sonnet-5-5": {}, "claude-haiku-4-5": {} } })]) });
  waitExit(used.data.run_id);
  reap(["--task-dir", task.dir]);
  const log = path.join(mk("argv"), "argv");
  const resumed = aJson(["run", "resume", "--run-id", String(used.data.run_id), "--brief", "go on"], { CLAUDE_ARGV_LOG: log, STUB_EXIT: "0" });
  if (resumed.data) pids.add(resumed.data.pid);
  waitExit(resumed.data.run_id);
  const seen = db.getRun(used.data.run_id).model;
  check(seen.includes("haiku") && !argvOf(log).includes("--model"), `R17: the observed models name haiku (${seen}) but the resume passes no --model (${JSON.stringify(argvOf(log).slice(0, 8))})`);
}

// R20: a run started on haiku keeps resuming on haiku after it is reaped
{
  const task = mkTask();
  const used = runStart(task, { model: "haiku", streamFile: stream([initLine, resultLine({ modelUsage: { "claude-haiku-4-5": {} } })]) });
  waitExit(used.data.run_id);
  reap(["--task-dir", task.dir]);
  const log = path.join(mk("argv"), "argv");
  const resumed = aJson(["run", "resume", "--run-id", String(used.data.run_id), "--brief", "go on"], { CLAUDE_ARGV_LOG: log, STUB_EXIT: "0" });
  if (resumed.data) pids.add(resumed.data.pid);
  waitExit(resumed.data.run_id);
  const w = argvOf(log);
  check(w[5] === "--model" && w[6] === "haiku", `R20: the resume of a haiku run passes --model haiku (${JSON.stringify(w.slice(0, 8))})`);
}

// R19: an unreadable launch.env_file refuses before anything is registered or recorded
{
  const cfg = path.join(mk("cfg"), "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ launch: { env_file: path.join(T, "no-such.env") } }));
  const bad = { AGENTS_CONFIG_PATH: cfg };
  const task = mkTask();
  const sessionsBefore = sessionCount();
  const runsBefore = db.listRuns({}).length;
  const started = runStart(task, { env: bad });
  check(started.status === 2 && started.err.includes("launch.env_file") && sessionCount() === sessionsBefore && db.listRuns({}).length === runsBefore, `R19: a start refuses with exit 2 and leaves no registration or run row (${started.status}: ${started.err.trim()})`);

  const source = runStart(task, { streamFile: stream([initLine, threeTools[0]]), exit: 143 });
  waitExit(source.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(source.data.run_id);
  const endedBefore = session.readRegistration(row.session_dir).ended_at;
  const runsAfterSource = db.listRuns({}).length;
  const resumed = aJson(["run", "resume", "--run-id", String(source.data.run_id), "--brief", "go on"], bad);
  const endedAfter = session.readRegistration(row.session_dir).ended_at;
  check(resumed.status === 2 && resumed.err.includes("launch.env_file") && endedBefore && endedAfter === endedBefore && db.listRuns({}).length === runsAfterSource, `R19: a resume refuses with exit 2 and leaves the source session ended and no new run row (${resumed.status}: ${resumed.err.trim()})`);
}

// R21: a resume of a run whose phase has left the task refuses before it touches the registration
{
  const task = mkTask();
  const source = runStart(task, { streamFile: stream([initLine, threeTools[0]]), exit: 143 });
  waitExit(source.data.run_id);
  reap(["--task-dir", task.dir]);
  const row = db.getRun(source.data.run_id);
  const endedBefore = session.readRegistration(row.session_dir).ended_at;
  const runsBefore = db.listRuns({}).length;
  const doc = readTask(task);
  doc.phases = doc.phases.filter((p) => p.id !== 1);
  taskLib.writeTaskJson(task.dir, doc);
  const resumed = aJson(["run", "resume", "--run-id", String(source.data.run_id), "--brief", "go on"]);
  const endedAfter = session.readRegistration(row.session_dir).ended_at;
  check(resumed.status === 4 && resumed.err.includes("phase 1") && endedBefore && endedAfter === endedBefore && db.listRuns({}).length === runsBefore, `R21: a resume of a removed phase exits 4 naming it, with the registration still ended and no new run row (${resumed.status}: ${resumed.err.trim()})`);
}

// W1: a manifest overlap on `a worktree add` keeps its validation shape and exit 2
{
  const holder = mkTask();
  const doc = readTask(holder);
  doc.phases[0].manifest = ["src/shared.js"];
  taskLib.writeTaskJson(holder.dir, doc);
  const claude = spawnClaude();
  session.register({ session_id: "overlap-holder", session_dir: path.join(process.env.AGENTS_SESSIONS_ROOT, "overlap-holder"), pid: claude.pid, agent: "builder", origin: "cli", repo_key: key.key, task_dir: holder.dir });
  const wanting = mkTask();
  const wdoc = readTask(wanting);
  wdoc.phases[0].manifest = ["src/shared.js"];
  taskLib.writeTaskJson(wanting.dir, wdoc);
  const refused = aJson(["worktree", "add", "--task", wanting.dir]);
  check(refused.status === 2 && refused.data && refused.data.error === "validation" && refused.data.message === "manifest overlap with live tasks", `W1: the overlap prints {"error":"validation"} and exits 2 (${refused.status}: ${refused.out.trim()} ${refused.err.trim()})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
