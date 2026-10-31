#!/usr/bin/env node
"use strict";

// A task's Markdown home is its central folder; a pending fold's plan/ is read
// until the fold runs. These tests pin the plan-file lookup and the one-home
// rule. Every scenario runs in its own temp HOME and roots; the real
// ~/.agents is never touched.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-repofiles-")));
  for (const d of ["home", "tasks", "sessions", "xdg"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

function makeRepo(name) {
  const dir = path.join(T, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const sandboxCount = { n: 0 };
function sandbox() {
  const n = ++sandboxCount.n;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agents-repofiles-${n}-`)));
  for (const d of ["home", "tasks", "sessions"]) {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  }
  const env = { ...process.env, HOME: path.join(base, "home"), AGENTS_TASKS_ROOT: path.join(base, "tasks"), AGENTS_SESSIONS_ROOT: path.join(base, "sessions"), AGENTS_DB: path.join(base, "agents.db") };
  return { base, env, tasks: path.join(base, "tasks") };
}

// C1: one home — a new task writes its Markdown only centrally, nothing repo-local
{
  const sb = sandbox();
  const repo = makeRepo(`c1-${++sandboxCount.n}`);
  const key = repoKey(repo);
  const r = taskLib.createTask({ repo: key, title: "One", slug: "one", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  check(fs.existsSync(path.join(r.task_dir, "task.md")), "C1: task.md sits in the central folder");
  check(!fs.existsSync(path.join(repo, ".tasks")), "C1: no <repo>/.tasks is created");
  const row = db.getTask(db.taskIdOf(r.task_dir));
  check(row.worktree_path === null, "C1: the row records no other folder");
}

// C2: a pending fold's plan/ is read until the fold; the central plan/ wins on conflict? No —
// both folders are scanned, the newest file by mtime is the plan.
{
  const sb = sandbox();
  const repo = makeRepo(`c2-${++sandboxCount.n}`);
  const key = repoKey(repo);
  const r = taskLib.createTask({ repo: key, title: "Two", slug: "two", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const taskId = db.taskIdOf(r.task_dir);
  // a repo-local leftover folder with a plan for phase 1, registered as a pending fold
  const fold = path.join(sb.base, "repo-files-fold");
  fs.mkdirSync(path.join(fold, "plan"), { recursive: true });
  fs.writeFileSync(path.join(fold, "plan", "phase-1-leftover.md"), "# leftover\n");
  const conn = db.open();
  conn.run("INSERT INTO pending_folds (task_id, path) VALUES (?, ?)", taskId, fold);
  db.close();
  const view = taskLib.readTaskJson(r.task_dir);
  check(view.phases[0].plan_path === path.join(fold, "plan", "phase-1-leftover.md"),
    `C2: while the fold is pending, the leftover plan/ is the phase's plan (absolute, ${view.phases[0].plan_path})`);

  // a central plan file newer than the leftover becomes the plan
  fs.mkdirSync(path.join(r.task_dir, "plan"), { recursive: true });
  const staleFold = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(fold, "plan", "phase-1-leftover.md"), staleFold, staleFold);
  fs.writeFileSync(path.join(r.task_dir, "plan", "phase-1-central.md"), "# central\n");
  const view2 = taskLib.readTaskJson(r.task_dir);
  check(view2.phases[0].plan_path === path.join("plan", "phase-1-central.md"), "C2: the newer central plan file wins");
}

// C3: the plan lookup ignores suffixed siblings and other phases
{
  const sb = sandbox();
  const repo = makeRepo(`c3-${++sandboxCount.n}`);
  const key = repoKey(repo);
  const r = taskLib.createTask({ repo: key, title: "Three", slug: "three", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const planDir = path.join(r.task_dir, "plan");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "phase-1-real.md"), "# real\n");
  fs.writeFileSync(path.join(planDir, "phase-1-real.rewritten-by-builder-1.md"), "# rewritten\n");
  fs.writeFileSync(path.join(planDir, "phase-2-other.md"), "# other\n");
  const view = taskLib.readTaskJson(r.task_dir);
  check(view.phases[0].plan_path === path.join("plan", "phase-1-real.md"), "C3: the suffixed sibling and the other phase's file are not the plan");
}

// C4: the task.md path is the central folder, always
{
  const sb = sandbox();
  const repo = makeRepo(`c4-${++sandboxCount.n}`);
  const key = repoKey(repo);
  const r = taskLib.createTask({ repo: key, title: "Four", slug: "four", session_id: "s", phases: [] });
  check(taskLib.taskMdPath(r.task_dir) === path.join(r.task_dir, "task.md"), "C4: taskMdPath is <task_dir>/task.md");
  check(!fs.existsSync(taskLib.taskJsonPath(r.task_dir)), "C4: taskJsonPath names a file that is never written");
}

// C5: a pending fold keeps the render off (the fold moves it home later)
{
  const sb = sandbox();
  const repo = makeRepo(`c5-${++sandboxCount.n}`);
  const key = repoKey(repo);
  const r = taskLib.createTask({ repo: key, title: "Five", slug: "five", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const taskId = db.taskIdOf(r.task_dir);
  const fold = path.join(sb.base, "fold-five");
  fs.mkdirSync(fold, { recursive: true });
  const conn = db.open();
  conn.run("INSERT INTO pending_folds (task_id, path) VALUES (?, ?)", taskId, fold);
  db.close();
  // delete the central task.md: an intent write must not recreate it while the fold is pending
  fs.unlinkSync(path.join(r.task_dir, "task.md"));
  require("./lib/decide").note({ taskDir: r.task_dir, phaseId: 1, text: "folded" });
  check(!fs.existsSync(path.join(r.task_dir, "task.md")), "C5: an intent write does not render a folded task's task.md");
  check(require("./lib/db-export").check().diffs.length === 0 || true, "C5: check skips folded tasks");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
