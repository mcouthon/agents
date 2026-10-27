#!/usr/bin/env node
"use strict";
// `a decide` and `a note`, the `a run start` step check and its override, through the CLI with a stub `claude`.
// Isolation: nothing here may touch the real HOME, config, git config or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-decide-")));
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
const session = require("./lib/session");
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
function mkTask({ statuses = ["not_started", "not_started"], edit, groups } = {}) {
  const slug = `job${++taskCounter}`;
  const phases = statuses.map((_, i) => ({ id: i + 1, name: `P${i + 1}`, ...(groups ? { parallel_group: groups[i] } : {}) }));
  const made = taskLib.createTask({ repo: key, title: slug, slug, mode: "full", tier: "standard", phases, description: "" });
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
  return { dir: made.task_dir, filesDir, md: path.join(filesDir, "task.md") };
}
const readTask = (task) => taskLib.readTaskJson(task.dir);
const phaseOf = (task, id = 1) => readTask(task).phases.find((p) => p.id === id);
const rowsOf = (task) => db.listDecisions({ taskId: db.taskIdOf(task.dir) });
const storedRow = (task) => db.open().get("SELECT awaiting, next_json FROM tasks WHERE task_dir = ?", task.dir);

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
const decide = (task, phase, choice, quote, env) => aJson(["decide", "--task-dir", task.dir, "--phase-id", String(phase), "--choice", choice, "--quote", quote], env);

const initLine = { type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/x", session_id: "s" };
const resultLine = (extra) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 3, permission_denials: [], modelUsage: { "claude-sonnet-5-5": {} }, terminal_reason: "completed", result: "done", ...extra });
function stream(lines) {
  const file = path.join(mk("stream"), "stream.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const explorerOut = (phaseId = 1, extra = {}) => ({ phase_id: phaseId, plan_path: `plan/phase-${phaseId}.md`, manifest: ["src/a.js"], open_questions: [], summary: "planned", ...extra });
const successStream = (out) => stream([initLine, resultLine({ structured_output: out })]);

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
const argvOf = (log) => fs.readFileSync(log, "utf8").split("\0").slice(0, -1);
const sessionCount = () => fs.readdirSync(process.env.AGENTS_SESSIONS_ROOT).length;

const passReview = { kind: "plan", verdict: "pass", issues: [], summary: "ok" };
const failPlan = { kind: "plan", verdict: "needs_work", issues: [], summary: "no" };
const passCode = { kind: "code", verdict: "pass", issues: [], summary: "ok" };
const needsCode = { kind: "code", verdict: "needs_work", issues: [], summary: "no" };
const reviewed = () => mkTask({ statuses: ["reviewed", "not_started"], edit: (d) => { d.phases[0].reports.reviewer = passReview; } });
const atReviewCap = () => mkTask({ statuses: ["planned", "not_started"], edit: (d) => { d.phases[0].counters.review_passes = 2; d.phases[0].reports.reviewer = failPlan; } });
const atFixCap = () => mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].counters.fix_attempts = 2; d.phases[0].reports.code_review = needsCode; } });
const atClarify = () => mkTask({ statuses: ["planned", "not_started"], edit: (d) => { d.phases[0].reports.explorer = { plan_path: "plan/phase-1.md", manifest: [], open_questions: [{ question: "Which db?", options: [] }], summary: "s" }; } });
const atReviewFail = () => mkTask({ statuses: ["implemented", "not_started"], edit: (d) => { d.phases[0].reports.code_review = { kind: "code", verdict: "fail", issues: [], summary: "no" }; } });

function commitFile(name) {
  fs.writeFileSync(path.join(repoDir, name), name + "\n");
  git(repoDir, "add", name);
  git(repoDir, "commit", "-q", "-m", `feat: ${name}`);
  return git(repoDir, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------- D1
const D1_QUOTE = 'Ship it — "carefully"\nline two';
{
  const task = reviewed();
  const r = decide(task, 1, "approve", D1_QUOTE);
  const rows = rowsOf(task);
  check(r.status === 0 && phaseOf(task).status === "approved" && rows.length === 1 && rows[0].quote === D1_QUOTE && rows[0].transition === "reviewed → approved" && rows[0].choice === "approve",
    `D1: approve moves a reviewed phase to approved and keeps the words byte for byte (${r.status}: ${r.err.trim()})`);
  check(r.data.next.step === "build" && storedRow(task).awaiting === "build" && readTask(task).checkpoints.length === 0 && r.data.decision_id === rows[0].decision_id,
    `D1: the answer carries the next step, the stored awaiting follows, and no checkpoint row was written (${r.data && r.data.next.step}, ${storedRow(task).awaiting})`);
  const q1 = JSON.parse(storedRow(task).next_json);
  check(q1.step === "build", `Q1: the stored next step is build right after the decision (${q1.step})`);
  const ro = db.open({ readonly: true });
  const seen = ro.get("SELECT awaiting, next_json FROM tasks WHERE task_dir = ?", task.dir);
  check(seen.awaiting === "build" && JSON.parse(seen.next_json).step === "build", "Q2: a read-only connection sees the step and who it awaits without any a call");
}

// ---------------------------------------------------------------- D1b, D1c
{
  const task = atReviewCap();
  const r = decide(task, 1, "approve", "good enough");
  const phase = phaseOf(task);
  const row = rowsOf(task)[0];
  check(r.status === 0 && phase.status === "approved" && phase.reports.reviewer.attributed_to === "user" && phase.reports.reviewer.quote === "good enough" && phase.reports.reviewer.decision_id === row.decision_id,
    `D1b: approve at the review cap approves straight through on a user-attributed plan pass (${r.err.trim()})`);
  const bad = mkTask();
  const refused = decide(bad, 1, "approve", "x");
  check(refused.status === 2 && refused.err.includes("step plan") && refused.err.includes("skip, abort, override") && rowsOf(bad).length === 0, `D1c: approve on a phase that has no plan names the situation and the choices that apply (${refused.err.trim()})`);
}

// ---------------------------------------------------------------- D2, D2b
{
  const task = reviewed();
  const r = decide(task, 1, "reject", "the plan skips the migration");
  const phase = phaseOf(task);
  const step = nextOf(task);
  check(r.status === 0 && phase.status === "planned" && phase.note === "the plan skips the migration" && step.step === "plan" && step.agent === "explorer", `D2: reject sends a reviewed phase back to the explorer with the words as its note (${phase.status}, ${step.step})`);
  const run = runStart(task, { agent: "explorer", streamFile: successStream(explorerOut(1)) });
  waitExit(run.data.run_id);
  const brief = argvOf(run.log).slice(-1)[0];
  check(brief.includes("verbatim:\nthe plan skips the migration"), `D2: the explorer's brief carries the owner's words after "verbatim:" (${JSON.stringify(brief.slice(brief.indexOf("The owner's words")))})`);
  reap(task);
  check(nextOf(task).step === "review_plan" && phaseOf(task).revision === undefined, "D2: once the explorer has reported, the plan is reviewed and the revision is gone");
}
{
  const first = atReviewCap();
  const second = atReviewCap();
  const r = decide(first, 1, "reject", "start over");
  const opened = aJson(["checkpoint", "open", "--task-dir", second.dir, "--phase-id", "1", "--type", "review_cap", "--question", "q", "--options-json", JSON.stringify(["approve_anyway", "force_replan", "skip"])]);
  aJson(["checkpoint", "resolve", "--task-dir", second.dir, "--checkpoint-id", opened.data.id, "--chosen", "force_replan"]);
  const x = phaseOf(first), y = phaseOf(second);
  check(r.status === 0 && x.reports.reviewer === null && y.reports.reviewer === null && x.counters.review_passes === 1 && y.counters.review_passes === 1 && nextOf(first).step === "plan" && nextOf(second).step === "plan",
    `D2b: reject at the review cap ends where the checkpoint's force_replan does (${x.counters.review_passes}/${y.counters.review_passes})`);
  check(x.note === "start over" && x.revision.quote === "start over" && x.revision.agent === "explorer", "D2b: and carries the words as the note and the revision");
}

// ---------------------------------------------------------------- D3, D3b
{
  const task = mkTask({ statuses: ["planned", "not_started"] });
  const r = decide(task, 1, "skip", "not now");
  check(r.status === 0 && phaseOf(task, 1).status === "skipped" && nextOf(task).phase_ids.join() === "2", `D3: skip ends the phase and the next names phase 2 (${r.err.trim()})`);
  const clarify = atClarify();
  const cap = atFixCap();
  decide(clarify, 1, "skip", "drop it");
  decide(cap, 1, "skip", "drop it too");
  check(phaseOf(clarify).status === "skipped" && phaseOf(cap).status === "skipped" && rowsOf(clarify)[0].quote === "drop it" && rowsOf(cap)[0].quote === "drop it too", "D3b: skip also works at an open question and at the fix cap, quote stored");
}

// ---------------------------------------------------------------- D4, D4b
{
  const task = mkTask();
  const open = [{ question: "Which db?", options: ["pg", "sqlite"] }, { question: "Which port?" }];
  const report = aJson(["report", "--task-dir", task.dir, "--phase-id", "1", "--agent", "explorer", "--report-json", JSON.stringify(explorerOut(1, { open_questions: open }))]);
  const before = nextOf(task);
  const r = decide(task, 1, "answer", "sqlite, port 8080");
  const phase = phaseOf(task);
  const row = rowsOf(task)[0];
  check(report.status === 0 && before.step === "blocked" && r.status === 0 && nextOf(task).step === "plan" && phase.counters.clarify_rounds === 1 && phase.reports.explorer.open_questions.every((q) => q.answered && q.answered.decision_id === row.decision_id),
    `D4: answer sends the plan back with both questions marked answered (${before.step}, ${r.err.trim()})`);
  const run = runStart(task, { agent: "explorer", streamFile: successStream(explorerOut(1)) });
  waitExit(run.data.run_id);
  const brief = argvOf(run.log).slice(-1)[0];
  check(brief.includes("Your open questions were:") && brief.includes("- Which db?") && brief.includes("- Which port?") && brief.includes("verbatim:\nsqlite, port 8080"), "D4: the explorer's brief lists the questions and carries the answer");
  const none = reviewed();
  const refused = decide(none, 1, "answer", "x");
  check(refused.status === 2 && refused.err.includes("approve") && refused.err.includes("approve, reject, skip, abort, override") && rowsOf(none).length === 0, `D4b: answer with no open question is refused naming the situation and the choices (${refused.err.trim()})`);
}

// ---------------------------------------------------------------- D5, D5b, D5c
{
  const task = atFixCap();
  const r = decide(task, 1, "reject", "rework the parser");
  const phase = phaseOf(task);
  check(r.status === 0 && phase.status === "in_progress" && phase.counters.fix_attempts === 1 && phase.note === "rework the parser", `D5: reject at the fix cap sends the phase back to the builder (${phase.status}, ${phase.counters.fix_attempts})`);
  const run = runStart(task, { agent: "builder", streamFile: successStream({ phase_id: 1, files_touched: ["a.js"], verification: [{ cmd: "true", exit: 0, summary: "ok" }], deviations: [], summary: "built" }) });
  waitExit(run.data.run_id);
  const brief = argvOf(run.log).slice(-1)[0];
  check(run.status === 0 && brief.includes("verbatim:\nrework the parser"), `D5: the builder's brief carries the words (${run.err.trim()})`);

  const accept = atFixCap();
  const ok = decide(accept, 1, "approve", "good enough, ship");
  const p = phaseOf(accept);
  const row = rowsOf(accept)[0];
  check(ok.status === 0 && p.status === "implemented" && p.reports.code_review.verdict === "pass" && p.reports.code_review.attributed_to === "user" && p.reports.code_review.quote === "good enough, ship" && p.reports.code_review.decision_id === row.decision_id && p.counters.fix_attempts === 2,
    `D5b: approve at the fix cap accepts the code as reviewed and leaves the counters (${ok.err.trim()})`);
  const step = nextOf(accept);
  const sha = commitFile("d5b.txt");
  const committed = aJson(["report", "--task-dir", accept.dir, "--phase-id", "1", "--agent", "committer", "--report-json", JSON.stringify({ phase_id: 1, commits: [{ sha: sha.slice(0, 9), files: ["d5b.txt"], message: "feat: d5b" }], pushed: false })]);
  check(step.step === "commit" && step.agent === "committer" && committed.status === 0 && phaseOf(accept).status === "committed", `D5b: the next step is commit and the committer's result moves the phase (${step.step}, ${phaseOf(accept).status})`);

  const fail = atReviewFail();
  const refused = decide(fail, 1, "approve", "x");
  check(refused.status === 2 && refused.err.includes("review_fail") && refused.err.includes("reject, skip, abort") && rowsOf(fail).length === 0, `D5c: approve at a failed review is refused naming review_fail (${refused.err.trim()})`);
}

// ---------------------------------------------------------------- D6
{
  const fixtures = [
    ["not_started", mkTask()],
    ["step approve", reviewed()],
    ["review cap", atReviewCap()],
    ["fix cap", atFixCap()],
    ["committed", mkTask({ statuses: ["committed", "not_started"], edit: (d) => { d.phases[0].commits = [commitFile("d6.txt")]; d.phases[0].reports.reviewer = passReview; d.phases[0].reports.code_review = passCode; } })],
  ];
  const results = fixtures.map(([label, task]) => { decide(task, 1, "abort", `stop ${label}`); return `${phaseOf(task).status}/${rowsOf(task)[0].quote}`; });
  check(results.join("|") === "failed/stop not_started|failed/stop step approve|failed/stop review cap|failed/stop fix cap|failed/stop committed", `D6: abort fails the phase at every step and stores each quote (${results.join("|")})`);
}

// ---------------------------------------------------------------- D7
{
  const task = reviewed();
  const landed = mkTask({ statuses: ["landed", "not_started"] });
  const base = ["decide", "--task-dir", task.dir, "--phase-id", "1", "--choice", "approve", "--quote", "go"];
  const without = (flag) => base.filter((w, i) => w !== flag && base[i - 1] !== flag);
  const exits = [
    a(without("--task-dir")).status, a(without("--phase-id")).status, a(without("--choice")).status, a(without("--quote")).status,
    a([...without("--quote"), "--quote", "  "]).status,
    a(["decide", "--task-dir", task.dir, "--phase-id", "1", "--choice", "maybe", "--quote", "go"]).status,
    a(["decide", "--task-dir", task.dir, "--phase-id", "9", "--choice", "approve", "--quote", "go"]).status,
    a(["decide", "--task-dir", landed.dir, "--phase-id", "1", "--choice", "approve", "--quote", "go"]).status,
    a(base, { AGENTS_DB: path.join(T, "no-such.db") }).status,
  ];
  check(exits.join() === "2,2,2,2,2,2,4,2,2" && rowsOf(task).length === 0 && rowsOf(landed).length === 0, `D7: bad arguments, an unknown phase, a landed phase and file-only mode are refused with no row (${exits.join()})`);
}

// ---------------------------------------------------------------- D8
{
  const task = mkTask();
  const r = aJson(["note", "--task-dir", task.dir, "--phase-id", "1", "--text", "see review"]);
  const empty = aJson(["note", "--task-dir", task.dir, "--phase-id", "1", "--text", ""]);
  const unknown = aJson(["note", "--task-dir", task.dir, "--phase-id", "7", "--text", "x"]);
  check(r.status === 0 && phaseOf(task).note === "see review" && fs.readFileSync(task.md, "utf8").includes("| see review |"), `D8: note sets the phase's note and the rendered table shows it (${r.err.trim()})`);
  check(empty.status === 2 && unknown.status === 4 && phaseOf(task).note === "see review", `D8: an empty text exits 2 and an unknown phase 4 (${empty.status}, ${unknown.status})`);
}

// ---------------------------------------------------------------- D9, D9b
if (process.getuid && process.getuid() !== 0) {
  const task = reviewed();
  const file = path.join(task.dir, "task.json");
  fs.chmodSync(file, 0o444);
  const r = decide(task, 1, "skip", "the words survive");
  fs.chmodSync(file, 0o644);
  const rows = rowsOf(task);
  check(r.status !== 0 && rows.length === 1 && rows[0].quote === "the words survive" && /EACCES|permission/i.test(rows[0].error || "") && rows.filter((x) => !x.consumed_at && !x.error).length === 0,
    `D9: a failed write keeps the owner's words with the error and leaves nothing pending (${r.status}, ${rows[0] && rows[0].error})`);
}
{
  const task = reviewed();
  const lock = path.join(task.dir, ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "holder"), JSON.stringify({ session_id: "held", pid: process.pid }));
  const r = decide(task, 1, "skip", "x");
  fs.rmSync(lock, { recursive: true });
  check(r.status === 3 && rowsOf(task).length === 0, `D9b: a task lock held by someone else exits 3 and records nothing (${r.status})`);
}

// ---------------------------------------------------------------- D10
{
  const task = mkTask();
  const r = aJson(["decide", "--task-dir", task.dir, "--phase-id", "1", "--choice", "override", "--quote= keep  me "]);
  check(r.status === 0 && rowsOf(task)[0].quote === " keep  me ", `D10: the --quote= form keeps leading and trailing spaces (${JSON.stringify(rowsOf(task)[0] && rowsOf(task)[0].quote)})`);
}

// ---------------------------------------------------------------- D11
{
  const task = mkTask({ statuses: ["committed", "not_started"] });
  const reg = (name, origin) => {
    const sid = session.mintId();
    const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, `${name}-${sid}`);
    session.register({ session_id: sid, session_dir: dir, origin, initiator: "engine", agent: "builder", cwd: repoDir, repo_key: key.key, task_dir: task.dir });
    return dir;
  };
  const agentRun = decide(task, 1, "land_anyway", "x", { AGENTS_SESSION_DIR: reg("dispatch", "dispatch") });
  const noRow = rowsOf(task).length === 0;
  const ownerSession = decide(task, 1, "land_anyway", "x", { AGENTS_SESSION_DIR: reg("cli", "cli") });
  const bare = decide(task, 1, "land_anyway", "y");
  check(agentRun.status === 2 && agentRun.data.error === "not_owner" && noRow, `D11: a dispatched agent's decide is refused with not_owner and records nothing (${agentRun.status}: ${agentRun.out.trim()})`);
  check(ownerSession.status === 0 && bare.status === 0 && rowsOf(task).length === 2, `D11: a session of the owner's and a bare shell both record (${ownerSession.status}, ${bare.status})`);
}

// ---------------------------------------------------------------- D12
{
  const task = mkTask({ statuses: ["in_progress", "reviewed"], edit: (d) => { d.phases[1].reports.reviewer = passReview; } });
  const before = JSON.stringify(phaseOf(task, 1));
  const r = decide(task, 2, "approve", "phase two is fine");
  check(r.status === 0 && phaseOf(task, 2).status === "approved" && JSON.stringify(phaseOf(task, 1)) === before, `D12: decide judges the phase it is given, not the first one (${r.err.trim()})`);
}

// ---------------------------------------------------------------- S1, S2
{
  const task = mkTask();
  const sessionsBefore = sessionCount();
  const runsBefore = db.listRuns().length;
  const r = runStart(task, { agent: "reviewer" });
  check(r.status === 2 && r.err.includes("a run start --task-dir") && r.err.includes("--agent explorer") && r.data && r.data.error === "step_check" && r.data.advised.step === "plan" && db.listRuns().length === runsBefore && sessionCount() === sessionsBefore,
    `S1: a reviewer start where a next advises the explorer is refused with the advised call and nothing registered (${r.status}: ${r.err.trim()})`);
  const wrongPhase = runStart(task, { phase: 2, agent: "builder" });
  check(wrongPhase.status === 2 && wrongPhase.err.includes("phase 1"), `S2: a builder on phase 2 while phase 1 is not started is refused naming phase 1 (${wrongPhase.err.trim()})`);

  const o = decide(task, 1, "override", "trust me");
  const first = runStart(task, { agent: "reviewer" });
  const used = rowsOf(task)[0];
  check(o.status === 0 && first.status === 0 && used.consumed_by === `run ${first.data.run_id}`, `S3: an override lets one start through and names the run that used it (${first.err.trim()}, ${used.consumed_by})`);
  waitExit(first.data.run_id);
  reap(task);
  const second = runStart(task, { agent: "reviewer" });
  check(second.status === 2 && second.data.error === "step_check", `S3: the same start again is refused (${second.status})`);
}

// ---------------------------------------------------------------- S4
{
  const task = mkTask({ statuses: ["landed", "landed"] });
  const r = runStart(task, { phase: 2, agent: "consolidator" });
  check(r.status === 0, `S4: a consolidator start is accepted once every phase has landed (${r.err.trim()})`);
}

// ---------------------------------------------------------------- S5
{
  const task = mkTask({ statuses: ["approved", "not_started"], groups: ["A", "A"] });
  const builder = runStart(task, { phase: 2, agent: "builder" });
  const explorer = runStart(task, { phase: 2, agent: "explorer" });
  check(builder.status === 2 && builder.data.error === "step_check" && builder.data.advised.step === "plan" && builder.data.advised.phase_ids.join() === "2" && explorer.status === 0,
    `S5: a batch member is judged on its own step: the builder is refused (plan), the explorer is accepted (${builder.err.trim()})`);
}

// ---------------------------------------------------------------- S6
(async () => {
  const task = mkTask();
  decide(task, 1, "override", "once");
  const start = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [A, "run", "start", "--task-dir", task.dir, "--phase-id", "1", "--agent", "reviewer", "--brief", "Go", "--json"], { cwd: repoDir, env: { ...process.env, CLAUDE_ARGV_LOG: path.join(mk("argv"), "argv"), STUB_SLEEP: "5" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
  const [x, y] = await Promise.all([start(), start()]);
  const winners = [x, y].filter((r) => r.status === 0);
  const runs = db.listRuns({ taskId: db.taskIdOf(task.dir) });
  if (winners.length === 1) pids.add(JSON.parse(winners[0].out).pid);
  check(winners.length === 1 && [x, y].filter((r) => r.status === 2).length === 1 && runs.length === 1 && rowsOf(task)[0].consumed_by === `run ${runs[0].run_id}`,
    `S6: of two starts racing for one override exactly one runs and owns it (${x.status}, ${y.status}, ${runs.length} runs)`);

  const released = mkTask();
  decide(released, 1, "override", "again");
  const bad = runStart(released, { agent: "reviewer", env: { AGENTS_SESSIONS_ROOT: "/dev/null/nope" } });
  const row = rowsOf(released)[0];
  check(bad.status !== 0 && row.consumed_at === null && row.consumed_by === null, `S7: a start that fails after the claim gives the override back (${bad.status}: ${bad.err.trim().split("\n").pop()})`);
  const again = runStart(released, { agent: "reviewer" });
  check(again.status === 0, `S7: and the next start can use it (${again.err.trim()})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
