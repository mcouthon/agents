#!/usr/bin/env node
"use strict";
// A two-phase task driven to done with CLI calls only: each step is the call the previous `a next` named,
// and the stub `claude` plays every agent. The test itself does only what an agent would do in the checkout.
// Isolation: nothing here may touch the real HOME, config, git config or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-flow-")));
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
const { spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");

const db = require("./lib/db");
const taskLib = require("./lib/task");
const worktree = require("./lib/worktree");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

fs.writeFileSync(path.join(T, "stubbin", "claude"), [
  "#!/bin/sh",
  "[ -n \"$STUB_STREAM\" ] && cat \"$STUB_STREAM\"",
  "exit 0",
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${path.join(T, "stubbin")}:${process.env.PATH}`;

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// ---- setup: a repo with a bare origin, a direct policy, and a two-phase task in a worktree
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
fs.writeFileSync(path.join(process.env.HOME, ".claude", "repo-policies.json"), JSON.stringify({ [key.main_root]: "direct" }));

const made = taskLib.createTask({ repo: key, title: "flow", slug: "flow", mode: "full", tier: "standard", phases: [{ id: 1, name: "One" }, { id: 2, name: "Two" }], description: "" });
const taskDir = made.task_dir;
const wt = worktree.add({ projectDir: repoDir, taskDir, force: true });
const filesDir = taskLib.filesDir(taskDir);
fs.mkdirSync(path.join(filesDir, "plan"), { recursive: true });

// ---- the driver: every `a` call is recorded, and a step is performed only through the call `a next` named
const argvLog = [];
function a(argv, env = {}) {
  argvLog.push(argv);
  const r = spawnSync(process.execPath, [A, ...argv, "--json"], { encoding: "utf8", cwd: repoDir, timeout: 120000, env: { ...process.env, ...env } });
  let data = null;
  try { data = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* checked by the caller */ }
  return { status: r.status, data, err: r.stderr };
}
/** The argv of a call's text: words, with a double-quoted run kept whole and its quotes dropped. */
const argvOfCall = (call) => call.text.match(/"[^"]*"|\S+/g).slice(1).map((w) => w.replace(/^"|"$/g, ""));
const PLACEHOLDERS = ["<brief>", "<the owner's words>"];
const named = [];
/** The call's argv with the word after `flag` replaced by the test's own words. */
function fill(call, flag, words) {
  const argv = argvOfCall(call);
  argv[argv.indexOf(flag) + 1] = words;
  named.push({ call: argvOfCall(call), used: argv });
  return argv;
}
function stream(out) {
  const file = path.join(mk("stream"), "stream.jsonl");
  const lines = [{ type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/x", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 10, num_turns: 1, permission_denials: [], modelUsage: { "claude-sonnet-5-5": {} }, terminal_reason: "completed", result: "done", structured_output: out }];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
function agentRun(call, phaseId, out, words) {
  const started = a(fill(call, "--brief", words), { STUB_STREAM: stream(out) });
  const waited = a(["run", "wait", "--run-id", String(started.data.run_id), "--seconds", "60"]);
  return { started, waited };
}

const sequence = [];
const quotes = [];
const lands = [];
let last = null;
for (let i = 0; i < 40; i++) {
  const n = a(["next", "--task-dir", taskDir]).data;
  last = n;
  if (n.step === "consolidate") break;
  const phaseId = n.phase_ids[0];
  sequence.push(`${n.step}:${n.call ? n.call.verb + (n.call.agent ? "/" + n.call.agent : "") : "none"}`);
  if (!n.call) break;
  if (n.step === "plan") {
    fs.writeFileSync(path.join(filesDir, "plan", `phase-${phaseId}.md`), `# plan ${phaseId}\n`);
    agentRun(n.call, phaseId, { phase_id: phaseId, plan_path: `plan/phase-${phaseId}.md`, manifest: [`feature-${phaseId}.txt`], open_questions: [], summary: "planned" }, `Plan phase ${phaseId}`);
  } else if (n.step === "review_plan" || n.step === "review_code") {
    agentRun(n.call, phaseId, { phase_id: phaseId, verdict: "pass", issues: [], summary: "looks right" }, `Review phase ${phaseId}`);
  } else if (n.step === "approve") {
    const words = `Go ahead with phase ${phaseId} — "carefully"`;
    quotes.push(words);
    a(fill(n.call, "--quote", words));
  } else if (n.step === "build") {
    agentRun(n.call, phaseId, { phase_id: phaseId, files_touched: [`feature-${phaseId}.txt`], verification: [{ cmd: `test -f feature-${phaseId}.txt`, exit: 0, summary: "present" }], deviations: [], summary: "built" }, `Build phase ${phaseId}`);
  } else if (n.step === "commit") {
    fs.writeFileSync(path.join(wt.path, `feature-${phaseId}.txt`), `phase ${phaseId}\n`);
    git(wt.path, "add", `feature-${phaseId}.txt`);
    git(wt.path, "commit", "-q", "-m", `feat: phase ${phaseId}`);
    const sha = git(wt.path, "rev-parse", "HEAD");
    agentRun(n.call, phaseId, { phase_id: phaseId, commits: [{ sha: sha.slice(0, 10), files: [`feature-${phaseId}.txt`], message: `feat: phase ${phaseId}` }], pushed: false }, `Commit phase ${phaseId}`);
  } else if (n.step === "land") {
    named.push({ call: argvOfCall(n.call), used: argvOfCall(n.call) });
    lands.push(a(argvOfCall(n.call)));
  } else {
    break;
  }
}

// ---- what happened, read without writing anything
const ro = db.open({ readonly: true });
const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
const runs = ro.all("SELECT agent, status FROM runs ORDER BY run_id");
const decisions = ro.all("SELECT choice, quote, transition FROM decisions ORDER BY decision_id");
const onOrigin = git(origin, "log", "main", "--format=%s");
const verbOf = (argv) => (argv[0] === "run" ? `run ${argv[1]}` : argv[0]);
const verbs = [...new Set(argvLog.map(verbOf))].sort();

const PHASE = ["plan:run start/explorer", "review_plan:run start/reviewer", "approve:decide", "build:run start/builder", "review_code:run start/reviewer", "commit:run start/committer", "land:land"];
console.log("calls: " + sequence.join(" | "));
console.log("next: " + JSON.stringify({ step: last.step, call: last.call, awaiting: last.awaiting }));
check(sequence.join() === [...PHASE, ...PHASE].join(), `F1: each step is a call the previous next named (${sequence.length} steps)`);
check(task.phases.every((p) => p.status === "landed") && last.step === "consolidate" && last.call.agent === "consolidator", `F1: both phases are landed and the next step is consolidate (${task.phases.map((p) => p.status)}, ${last.step})`);
check(runs.length === 10 && runs.every((r) => r.status === "succeeded"), `F1: ten runs, all succeeded (${runs.map((r) => r.agent + ":" + r.status).join(" ")})`);
check(decisions.length === 2 && decisions[0].quote === quotes[0] && decisions[1].quote === quotes[1] && decisions.every((d) => d.choice === "approve" && d.transition === "reviewed → approved"), `F1: two approvals stored with the words verbatim (${JSON.stringify(decisions.map((d) => d.quote))})`);
check(onOrigin.includes("feat: phase 1") && onOrigin.includes("feat: phase 2"), `F1: origin's main has both commits (${onOrigin.split("\n").join(" / ")})`);
check(lands.length === 2 && lands.every((l, i) => l.status === 0 && l.data.landed === true && l.data.reverified.some((r) => r.cmd === `test -f feature-${i + 1}.txt` && r.exit === 0)), `F1: each land re-ran its recorded check (${lands.map((l) => JSON.stringify(l.data && l.data.reverified && l.data.reverified.map((r) => r.cmd))).join(" ")})`);
const sameButFilled = (p) => p.call.length === p.used.length && p.call.every((w, i) => w === p.used[i] || PLACEHOLDERS.includes(w)) && argvLog.some((l) => JSON.stringify(l) === JSON.stringify(p.used));
check(named.length === 14 && named.every(sameButFilled), `F1: every run start, decide and land the test made is the named call, except the brief or quote it filled in (${named.length} calls)`);
check(verbs.join() ===["decide", "land", "next", "run start", "run wait"].join(), `F1: the only verbs used were next, run start, run wait, decide and land (${verbs.join(", ")})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
