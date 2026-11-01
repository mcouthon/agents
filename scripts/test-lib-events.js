#!/usr/bin/env node
"use strict";

// One events row per world-changing verb: every intent kind is written by the
// verb that changes it, through the CLI, and `a ls --json`'s data_version
// moves with it. Stub zmx and claude as test-lib-start.js uses them.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-events-")));
  for (const d of ["home", "xdg", "logs", "stubbin"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_TEST_TMP: t,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "STUB_ZMX_EXIT", "STUB_ZMX_SNAP", "STUB_CLAUDE_EXIT"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const SCRIPTS = __dirname;
const A = path.join(SCRIPTS, "bin", "a");
const T = process.env.AGENTS_TEST_TMP;

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

// Stub zmx and claude (as test-lib-start.js): zmx answers --version and list from $ZMX_LIST_FILE.
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  '  list) [ -f "$ZMX_LIST_FILE" ] && cat "$ZMX_LIST_FILE"; exit 0 ;;',
  "esac",
  'if [ "$1" = run ] && [ -n "$STUB_ZMX_SNAP" ]; then cp "$STUB_ZMX_SNAP" "$ZMX_LOG.snap"; fi',
  'printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  'echo "cwd $PWD" >> "$ZMX_LOG"',
  'exit "${STUB_ZMX_EXIT:-0}"',
  "",
].join("\n"), { mode: 0o755 });
fs.writeFileSync(path.join(stubBin, "claude"), '#!/bin/sh\nexit "${STUB_CLAUDE_EXIT:-0}"\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;

// The fixture: one root holding the db, tasks, sessions, worktrees and a repo
// with a local bare origin, so land's fetch and push stay inside it.
const root = path.join(T, "fixture");
for (const d of ["tasks", "sessions", "worktrees", "work"]) fs.mkdirSync(path.join(root, d), { recursive: true });
Object.assign(process.env, {
  AGENTS_TASKS_ROOT: path.join(root, "tasks"),
  AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
  AGENTS_DB: path.join(root, "agents.db"),
  ZMX_LOG: path.join(root, "zmx.log"),
  ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
});
fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ worktrees_root: path.join(root, "worktrees") }));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repoDir = path.join(root, "work", "acme");
fs.mkdirSync(repoDir, { recursive: true });
const origin = path.join(root, "origin.git");
git(root, "init", "-q", "--bare", "-b", "main", origin);
git(repoDir, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
git(repoDir, "add", ".");
git(repoDir, "commit", "-q", "-m", "init");
git(repoDir, "remote", "add", "origin", origin);
git(repoDir, "push", "-q", "-u", "origin", "main");
git(repoDir, "remote", "set-head", "origin", "main");
const { repoKey } = require(path.join(SCRIPTS, "lib", "repo"));
const key = repoKey(repoDir);
fs.mkdirSync(path.dirname(path.join(process.env.HOME, ".agents", "repo-policies.json")), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, ".agents", "repo-policies.json"), JSON.stringify({ [key.main_root]: "direct" }));

const cli = (args) => {
  const r = spawnSync(process.execPath, [A, ...args, "--json"], { cwd: repoDir, encoding: "utf8", timeout: 90000 });
  return { status: r.status, out: r.stdout, err: r.stderr, data: r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null };
};

const query = (sql, ...params) => {
  const d = new DatabaseSync(process.env.AGENTS_DB, { readOnly: true });
  try { return d.prepare(sql).all(...params); } finally { d.close(); }
};
const countOf = (taskId, kind) => query("SELECT count(*) AS n FROM events WHERE task_id = ? AND kind = ?", taskId, kind)[0].n;
const dataVersion = () => cli(["ls", "--repo", repoDir]).data.data_version;

// one verb, one events row of its kind carrying the task id, and a moving data_version
let taskId = null;
function step(label, kind, args) {
  const rowsBefore = taskId === null ? 0 : countOf(taskId, kind);
  const dvBefore = dataVersion();
  const r = cli(args);
  const rowsAfter = taskId === null ? 0 : countOf(taskId, kind);
  const dvAfter = dataVersion();
  check(r.status === 0, `${label}: exits 0 (${r.status}: ${(r.err || "").slice(0, 160)})`);
  check(rowsAfter === rowsBefore + 1, `${label}: exactly one new ${kind} row carries the task id (${rowsBefore} -> ${rowsAfter})`);
  check(dvAfter > dvBefore, `${label}: a ls's data_version grows (${dvBefore} -> ${dvAfter})`);
  return r;
}

// task new (the task id arrives with the row)
{
  const dvBefore = dataVersion();
  const r = cli(["task", "new", "--title", "One row per verb", "--phases-json", JSON.stringify([{ id: 1, name: "One" }]), "--repo", repoDir]);
  const row = r.data ? query("SELECT id, task_dir FROM tasks WHERE task_dir = ?", r.data.task_dir)[0] : null;
  check(r.status === 0 && row, `task new: the task is created (${r.status}: ${(r.err || r.out || "").slice(0, 400)})`);
  taskId = row.id;
  check(countOf(taskId, "task_new") === 1, `task new: one task_new row carries the task id (${countOf(taskId, "task_new")})`);
  check(dataVersion() > dvBefore, "task new: a ls's data_version grows");
}

step("add-phases", "add_phases", ["task", "add-phases", "--task-dir", query("SELECT task_dir FROM tasks WHERE id = ?", taskId)[0].task_dir,
  "--phases-json", JSON.stringify([{ id: 2, name: "Two", after: [1] }]), "--repo", repoDir]);
const taskDir = query("SELECT task_dir FROM tasks WHERE id = ?", taskId)[0].task_dir;
const dirName = path.basename(taskDir);

step("task note", "note", ["task", "note", "--task-dir", taskDir, "--text", "a task-level note", "--repo", repoDir]);
step("task set", "knob", ["task", "set", "--task-dir", taskDir, "--knob", "land", "--value", "at_end", "--repo", repoDir]);
step("decide", "decide", ["decide", "--task-dir", taskDir, "--choice", "answer", "--gate", "task-plan", "--quote", "three phases", "--repo", repoDir]);
{
  const row = query("SELECT detail FROM events WHERE task_id = ? AND kind = 'decide' ORDER BY id DESC LIMIT 1", taskId)[0];
  const detail = row ? JSON.parse(row.detail) : null;
  check(detail && detail.gate === "task-plan" && detail.choice === "answer",
    `the decide event detail carries the gate, as its decisions row does (${row && row.detail})`);
}

// land: a worktree branch with a commit, pushed to the local bare origin
{
  const wt = cli(["worktree", "add", "--task", taskDir, "--repo", repoDir]);
  check(wt.status === 0 && wt.data && wt.data.path, `worktree add: the branch exists (${wt.status}: ${(wt.err || "").slice(0, 160)})`);
  fs.writeFileSync(path.join(wt.data.path, "feature.txt"), "f\n");
  git(wt.data.path, "add", ".");
  git(wt.data.path, "commit", "-q", "-m", "feature");
  step("land", "land", ["land", "--task-dir", taskDir, "--repo", repoDir, "--check", "true"]);
}

step("task check", "check", ["task", "check", "--task-dir", taskDir, "--phase-id", "1", "--repo", repoDir]);

// a second task check on the checked phase adds no row
{
  const dvBefore = dataVersion();
  const again = cli(["task", "check", "--task-dir", taskDir, "--phase-id", "1", "--repo", repoDir]);
  check(countOf(taskId, "check") === 1, `a second task check on the checked phase adds no row (${countOf(taskId, "check")})`);
  check(dataVersion() === dvBefore, `a refused task check leaves data_version still (${dvBefore} -> ${dataVersion()})`);
  void again;
}

// start and resume: the session verbs, with the stub zmx
{
  const started = step("start", "start", ["start", dirName, "--no-attach"]);
  const reg = started.data;
  const session = require(path.join(SCRIPTS, "lib", "session"));
  const transcriptPath = path.join(T, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  session.register({ session_id: reg.session_id, session_dir: reg.session_dir, transcript_path: transcriptPath });
  session.markEnded(reg.session_dir);
  const id8 = reg.session_id.slice(0, 8);
  fs.writeFileSync(process.env.ZMX_LIST_FILE, `name=Conductor-${id8}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp\tended=2\texit_code=0\n`);
  step("resume", "resume", ["resume", dirName]);
}

step("task close", "close", ["task", "close", "--task-dir", taskDir, "--repo", repoDir]);

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
