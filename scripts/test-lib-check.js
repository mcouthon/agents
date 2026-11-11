#!/usr/bin/env node
"use strict";

// a check: record a check_run event for a command run in the task's tree.
// Temp bare origin, a clone, a task worktree; `gh` is a PATH stub.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-check-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "bin"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["CLAUDE_CODE_SESSION_ID", "AGENTS_SESSION_DIR"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const { POLICIES_PATH } = require("./lib/policy");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

db.open({ create: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = path.join(path.dirname(process.env.AGENTS_TASKS_ROOT), "repos");
fs.mkdirSync(root, { recursive: true });
let counter = 0;
const A = path.join(__dirname, "bin", "a");

function fixture() {
  const n = ++counter;
  const origin = path.join(root, `origin${n}.git`);
  const main = path.join(root, `main${n}`);
  const wt = path.join(root, `wt${n}`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  fs.writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "task-branch", wt, "origin/main");
  fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feature");
  const key = repoKey(main);
  const created = taskLib.createTask({ repo: key, title: `T${n}`, slug: `t${n}`, session_id: "s", phases: [{ id: 1, name: "One" }] });
  const taskId = db.taskIdOf(created.task_dir);
  db.setTaskWorktree(taskId, { worktreePath: wt, branch: "task-branch" });
  fs.writeFileSync(POLICIES_PATH, JSON.stringify({ [key.main_root]: "direct" }));
  return { origin, main, wt, key, taskDir: created.task_dir, taskId };
}

function runCheck(args, cwd) {
  const r = spawnSync(process.execPath, [A, "check", ...args], {
    encoding: "utf8", cwd: cwd || process.env.AGENTS_TEST_TMP, timeout: 30000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// CK1: a clean tree, "true" — exits 0, JSON carries {command, tree, exit, at}, event recorded.
{
  const fx = fixture();
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const before = db.intentRecency(fx.taskId);
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "true"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 0, `CK1: "true" exits 0 (exit ${r.status})`);
  check(json && json.command === "true" && json.tree === treeHash && json.exit === 0 && typeof json.at === "string",
    `CK1: JSON is {command, tree, exit, at} (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 1 && runs[0].command === "true" && runs[0].tree === treeHash && runs[0].exit === 0,
    `CK1: a check_run event holds {command, tree, exit} (got ${runs.length} runs)`);
  // CK5 (guard): no intent event appended.
  const after = db.intentRecency(fx.taskId);
  check(JSON.stringify(before) === JSON.stringify(after),
    `CK5: intentRecency unchanged (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
}

// CK2: "false" — exits 1, event recorded with exit 1.
{
  const fx = fixture();
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "false"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 1, `CK2: "false" exits 1 (exit ${r.status})`);
  check(json && json.exit === 1 && json.command === "false" && json.tree === treeHash,
    `CK2: JSON carries exit 1 (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 1 && runs[0].exit === 1 && runs[0].command === "false",
    `CK2: the recorded event has exit 1 (got exit ${runs.length > 0 ? runs[0].exit : "none"})`);
}

// CK3: a dirty tree is refused, exit 2, with the remedy; no event.
{
  const fx = fixture();
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "dirty\n");
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "true"]);
  check(r.status === 2, `CK3: dirty tree exits 2 (exit ${r.status})`);
  check(/Remedy: commit or stash/.test(r.err), `CK3: refusal names the remedy (${r.err.split("\n")[0]})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 0, `CK3: no event recorded for a refused check (got ${runs.length})`);
}

// CK4: no command after -- is a usage error, exit 2, naming the form.
{
  const fx = fixture();
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json"]);
  check(r.status === 2, `CK4: no command exits 2 (exit ${r.status})`);
  check(/Usage: a check/.test(r.err), `CK4: usage names the form (${r.err.split("\n")[0]})`);
}

// CK6: the command runs in the task's worktree — "pwd" prints the worktree path.
{
  const fx = fixture();
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "pwd"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 0, `CK6: "pwd" exits 0 (exit ${r.status})`);
  check(json && json.exit === 0, `CK6: JSON carries exit 0 (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  // The non-JSON stdout of "pwd" is the worktree path; under --json it is captured in the event detail only.
  // Run without --json to see the cwd output.
  const r2 = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--", "pwd"]);
  const pwd = r2.out.trim();
  check(r2.status === 0 && pwd === fs.realpathSync(fx.wt), `CK6: "pwd" prints the worktree path (got ${pwd})`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
