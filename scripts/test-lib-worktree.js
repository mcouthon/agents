#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/worktree.js — add/remove/list/reap/survey/sweep and
// the worktree record on the task's row. Uses throwaway git repos in tmpdir.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// One throwaway base for every root this suite owns, the DB inside it: the
// old header put AGENTS_DB in the tasks root's parent — the machine temp dir
// itself — so every run's rows piled up in a shared agents.db there, and each
// survey/doctor pass scanned every previous run's leftovers (the "209 s
// solo" calibration was that scan, not work). With the DB in the run's own
// base nothing is shared between runs.
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-")));
process.env.AGENTS_SESSIONS_ROOT = path.join(BASE, "sessions");
process.env.AGENTS_TASKS_ROOT = path.join(BASE, "tasks");
process.env.AGENTS_DB = path.join(BASE, "agents.db");
fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
const WT_HOME = path.join(BASE, "home");
process.env.HOME = WT_HOME;
fs.mkdirSync(WT_HOME);
const CFG_DIR = path.join(BASE, "cfg");
const WT_ROOT = path.join(BASE, "worktrees");
fs.mkdirSync(CFG_DIR);
fs.mkdirSync(WT_ROOT);
const CFG = path.join(CFG_DIR, "config.json");
fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
process.env.AGENTS_CONFIG_PATH = CFG;

const wt = require("./lib/worktree");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const db = require("./lib/db");

let passed = 0, failed = 0;
function ok(msg) { passed++; console.log("OK: " + msg); }
function fail(msg) { failed++; console.error("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout || "").trim();
}

function commit(repo, msg) {
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-m", msg]);
}

// Setup: temp repo with main branch
const baseDir = fs.mkdtempSync(path.join(BASE, "test-"));
const repoPath = path.join(baseDir, "repo");
fs.mkdirSync(repoPath, { recursive: true });
const repo = fs.realpathSync(repoPath);
git(repo, ["init"]);
fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
git(repo, ["add", "f.txt"]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
git(repo, ["branch", "-M", "main"]);
// An origin — the worktree cut needs its origin/main ref — planted before the
// repo key is taken, so every later key derivation agrees on the key's shape.
const originDir = path.join(baseDir, "origin.git");
git(repo, ["init", "-q", "--bare", "-b", "main", originDir]);
git(repo, ["remote", "add", "origin", originDir]);
git(repo, ["push", "-q", "origin", "main"]);
git(repo, ["remote", "set-head", "origin", "main"]);
const key = require("./lib/repo").repoKey(repo);

// Setup: a task created centrally (a row, no task.json anywhere)
const made = taskLib.createTask({ repo: key, title: "Test task", slug: "test-task", session_id: "s", phases: [{ id: 1, name: "P1: test" }] });
const taskDir = made.task_dir;
const taskId = db.taskIdOf(taskDir);

// --- T1: add creates the worktree at <root>/repo/<dir> on wt/<dir>, records it on the row, links nothing ---

const wtPath = path.join(WT_ROOT, "repo", "001-test-task");

try {
  const result = wt.add({ projectDir: repo, taskDir, force: true });
  check(result.branch === "wt/001-test-task", `branch is wt/001-test-task, got ${result.branch}`);
  check(result.path === wtPath, `path is ${wtPath}, got ${result.path}`);
  check(fs.existsSync(wtPath), "worktree directory exists");
  check(git(wtPath, ["branch", "--show-current"]) === "wt/001-test-task", "worktree is on the right branch");
  check(!("tasks_link" in result), "add reports no tasks_link");
  const wtTasksDir = path.join(wtPath, ".tasks");
  if (fs.existsSync(wtTasksDir)) {
    const entries = fs.readdirSync(wtTasksDir, { withFileTypes: true });
    check(entries.every((e) => e.isSymbolicLink()), "the worktree's .tasks entries are symlinks (not real dirs)");
  } else {
    ok("the worktree gets no .tasks dir when no task to link");
  }

  const row = db.getTask(taskId);
  check(row.worktree_path === wtPath && row.branch === "wt/001-test-task", "the worktree record lands on the row (worktree_path and branch)");
  ok("add: task-bound worktree created with correct path, branch and record");
} catch (err) {
  fail(`add threw: ${err.message}`);
}

// --- T2: remove refuses when dirty ---

try {
  fs.writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted\n");
  wt.remove({ projectDir: repo, path: wtPath, force: false });
  fail("remove should have refused dirty worktree");
} catch (err) {
  check(err.code === "DIRTY", `dirty worktree refused (code=${err.code})`);
  ok("remove: refuses dirty worktree");
}
try { fs.unlinkSync(path.join(wtPath, "dirty.txt")); } catch {}

// --- T3: remove refuses when branch has unlanded commits ---

commit(wtPath, "wip");
try {
  wt.remove({ projectDir: repo, path: wtPath, force: false });
  fail("remove should have refused unlanded worktree");
} catch (err) {
  check(err.code === "UNLANDED", `unlanded branch refused (code=${err.code})`);
  ok("remove: refuses unlanded branch (no landing signal yet)");
}

// --- T3b: a task whose landing derives landed (the same patches upstream) removes without a merge ---

{
  const t3b = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t3b-"));
  const origin = path.join(t3b, "origin.git");
  const main = path.join(t3b, "main");
  git(t3b, ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  git(main, ["add", "f.txt"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  git(main, ["remote", "add", "origin", origin]);
  git(main, ["push", "-q", "origin", "main"]);
  // the policy lists the repo direct, so the branch proofs need no gh
  fs.mkdirSync(path.join(WT_HOME, ".claude"), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(WT_HOME, ".agents", "repo-policies.json")), { recursive: true });
  fs.writeFileSync(path.join(WT_HOME, ".agents", "repo-policies.json"),
    JSON.stringify({ [fs.realpathSync(main)]: { push: "direct" }, [main]: { push: "direct" } }));
  const key3b = require("./lib/repo").repoKey(main);
  const made3b = taskLib.createTask({ repo: key3b, title: "Squashed", slug: "squashed", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const added = wt.add({ projectDir: main, taskDir: made3b.task_dir, force: true });
  fs.writeFileSync(path.join(added.path, "g.txt"), "g\n");
  git(added.path, ["add", "g.txt"]);
  git(added.path, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "work"]);
  // squash the branch onto main: the same patch lands, the branch ref stays
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "--squash", added.branch]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "squashed"]);
  git(main, ["push", "-q", "origin", "main"]);
  taskLib.checkPhase({ taskDir: made3b.task_dir, phaseId: 1 });
  const row3b = db.getTask(db.taskIdOf(made3b.task_dir));
  const landing = require("./lib/derive").landingOfTask(row3b);
  check(landing && landing.state === "landed", `T3b: the same patches upstream derive landed (${JSON.stringify(landing)})`);
  let refused = null;
  try { wt.remove({ projectDir: main, path: added.path, force: false }); } catch (err) { refused = err; }
  check(!refused, `T3b: remove succeeds on the derived landing without a merge (${refused && refused.message})`);
  check(!fs.existsSync(added.path), "T3b: the worktree is gone");
  fs.rmSync(t3b, { recursive: true, force: true });
}

// --- T4: remove succeeds after merge (branch is ancestor of base) ---

git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/001-test-task", "-m", "merge"]);
try {
  const result = wt.remove({ projectDir: repo, path: wtPath, force: false });
  check(!fs.existsSync(wtPath), "worktree directory gone after remove");
  check(result.branchDeleted === true, "branch deleted after merge");
  const row = db.getTask(taskId);
  check(row.worktree_path === null && row.branch === null, "remove clears the worktree record on the row");
  ok("remove: succeeds after merge, deletes branch, clears the record");
} catch (err) {
  fail(`remove after merge threw: ${err.message}`);
}

// --- T5: list shows main and worktrees ---

{
  const result = wt.list(repo);
  check(result.length >= 1, "list returns at least main");
  check(result.some((w) => w.isMain), "list includes main checkout");
  ok("list: returns worktrees");
}

// --- T7: add with --name (non-task-bound) ---

const wt3Path = path.join(WT_ROOT, "repo", "manual");
try {
  const result = wt.add({ projectDir: repo, name: "manual" });
  check(result.branch === "wt/manual", `branch is wt/manual, got ${result.branch}`);
  check(result.path === wt3Path, `path is ${wt3Path}, got ${result.path}`);
  check(fs.existsSync(wt3Path), "non-task worktree exists");
  ok("add: non-task-bound worktree created");
  git(repo, ["worktree", "remove", wt3Path]);
  git(repo, ["branch", "-d", "wt/manual"]);
} catch (err) {
  fail(`add --name threw: ${err.message}`);
}

// --- T10: recordWorktreeInTask writes the record on a task made by task new (no task.json anywhere) ---

{
  const t10Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t10-"));
  const t10Repo = path.join(t10Base, "repo");
  fs.mkdirSync(t10Repo, { recursive: true });
  const t10RepoReal = fs.realpathSync(t10Repo);
  git(t10RepoReal, ["init"]);
  fs.writeFileSync(path.join(t10RepoReal, "f.txt"), "hi\n");
  git(t10RepoReal, ["add", "f.txt"]);
  git(t10RepoReal, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(t10RepoReal, ["branch", "-M", "main"]);
  const t10Key = require("./lib/repo").repoKey(t10RepoReal);
  const t10 = taskLib.createTask({ repo: t10Key, title: "Fresh", slug: "fresh", session_id: "s", phases: [{ id: 1, name: "One" }] });

  wt.recordWorktreeInTask(t10.task_dir, "wt/300-fresh", "/tmp/fake-wt-300", t10RepoReal);
  const row = db.getTask(db.taskIdOf(t10.task_dir));
  check(row.worktree_path === "/tmp/fake-wt-300" && row.branch === "wt/300-fresh", "the record lands on a task with no task.json anywhere (C6)");
  ok("T10: recordWorktreeInTask works on a fresh row task");

  fs.rmSync(t10Base, { recursive: true, force: true });
}

// --- T11: a task just made by task new gets its worktree record from a start ---

{
  const t11Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t11-"));
  const t11Repo = path.join(t11Base, "repo");
  fs.mkdirSync(t11Repo, { recursive: true });
  const main = fs.realpathSync(t11Repo);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  git(main, ["add", "f.txt"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
  const t11Origin = path.join(t11Base, "origin.git");
  git(t11Base, ["init", "-q", "--bare", "-b", "main", t11Origin]);
  git(main, ["remote", "add", "origin", t11Origin]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["remote", "set-head", "origin", "main"]);
  const t11Key = require("./lib/repo").repoKey(main);
  const t11 = taskLib.createTask({ repo: t11Key, title: "Recorded", slug: "recorded", session_id: "s", phases: [{ id: 1, name: "One" }] });

  const added = wt.add({ projectDir: main, taskDir: t11.task_dir, force: true });
  commit(added.path, "work");
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge"]);

  const result = wt.remove({ projectDir: main, path: added.path, force: false });
  check(result.removed === added.path, "worktree removed");
  const row = db.getTask(db.taskIdOf(t11.task_dir));
  check(row.worktree_path === null && row.branch === null, "the record is cleared on remove");

  fs.rmSync(t11Base, { recursive: true, force: true });
}

// --- T13: add copies the main checkout's untracked .env* files, nothing tracked or present ---

{
  const t13Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t13-"));
  const t13Repo = path.join(t13Base, "repo");
  fs.mkdirSync(t13Repo, { recursive: true });
  const main = fs.realpathSync(t13Repo);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(main, ".env.example"), "EX=1\n");
  fs.writeFileSync(path.join(main, ".env.prod"), "P=base\n");
  fs.mkdirSync(path.join(main, ".envdir"));
  git(main, ["add", "f.txt"]);
  git(main, ["add", "-f", ".env.example", ".env.prod"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
  const t13Origin = path.join(t13Base, "origin.git");
  git(t13Base, ["init", "-q", "--bare", "-b", "main", t13Origin]);
  git(main, ["remote", "add", "origin", t13Origin]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["remote", "set-head", "origin", "main"]);
  git(main, ["rm", "--cached", "-q", ".env.prod"]);
  fs.writeFileSync(path.join(main, ".env.prod"), "P=main\n");
  fs.writeFileSync(path.join(main, ".env"), "E=1\n");

  const r = wt.add({ projectDir: main, name: "envtest" });

  check(JSON.stringify(r.env_copies) === JSON.stringify([".env"]), `T13: env_copies names only the untracked, absent .env (${JSON.stringify(r.env_copies)})`);
  const envStat = fs.lstatSync(path.join(r.path, ".env"));
  check(envStat.isFile() && !envStat.isSymbolicLink() && fs.readFileSync(path.join(r.path, ".env"), "utf8") === fs.readFileSync(path.join(main, ".env"), "utf8"), "T13: .env in the worktree is a regular file carrying the main checkout's bytes, not a symlink");
  check(!fs.existsSync(path.join(r.path, ".envdir")), "T13: an untracked .env* directory is skipped");
  check(fs.lstatSync(path.join(r.path, ".env.example")).isFile() && fs.readFileSync(path.join(r.path, ".env.example"), "utf8") === "EX=1\n", "T13: the tracked .env.example arrives as a regular file");
  check(fs.lstatSync(path.join(r.path, ".env.prod")).isFile() && fs.readFileSync(path.join(r.path, ".env.prod"), "utf8") === "P=base\n", "T13: .env.prod, present in the worktree from git, is left alone");
  check(JSON.stringify(wt.copyEnvFiles(main, r.path)) === "[]", "T13: copying a second time copies nothing");

  fs.rmSync(t13Base, { recursive: true, force: true });
}

function freshRepo(tag, name) {
  const dir = path.join(fs.mkdtempSync(path.join(BASE, `t-${tag}-`)), name || "repo");
  fs.mkdirSync(dir);
  const main = fs.realpathSync(dir);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, ".gitignore"), ".tasks\n");
  git(main, ["add", ".gitignore"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
  // An origin — the worktree cut needs its origin/main ref, and a done plant's
  // landing derives from the push — planted before any repo key is taken, so
  // a subprocess's fresh key derivation agrees with this process's.
  const origin = path.join(path.dirname(main), "origin.git");
  git(main, ["init", "-q", "--bare", "-b", "main", origin]);
  git(main, ["remote", "add", "origin", origin]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["remote", "set-head", "origin", "main"]);
  return main;
}
const mergeInto = (main, branch) => git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", branch, "-m", `merge ${branch}`]);

// --- T14: worktreePath: ~/.agents/worktrees/<repo>/<name> by default, worktrees_root moves it ---

{
  const key14 = { main_root: "/somewhere/acme" };
  process.env.AGENTS_CONFIG_PATH = path.join(CFG_DIR, "absent.json");
  check(wt.worktreesRoot() === path.join(os.homedir(), ".agents", "worktrees"), "T14: without the knob the root is ~/.agents/worktrees");
  check(wt.worktreePath(key14, "007-seven") === path.join(os.homedir(), ".agents", "worktrees", "acme", "007-seven"), "T14: the default path is <root>/<repo-name>/<NNN>-<slug>");
  const tilde = path.join(CFG_DIR, "tilde.json");
  fs.writeFileSync(tilde, JSON.stringify({ worktrees_root: "~/wts" }));
  process.env.AGENTS_CONFIG_PATH = tilde;
  check(wt.worktreePath(key14, "manual") === path.join(os.homedir(), "wts", "acme", "manual"), "T14: a leading ~ in worktrees_root is HOME");
  fs.writeFileSync(tilde, JSON.stringify({ worktrees_root: "rel/wts" }));
  check(wt.worktreePath(key14, "manual") === path.join(CFG_DIR, "rel", "wts", "acme", "manual"), "T14: a relative worktrees_root resolves against the config file's directory");
  process.env.AGENTS_CONFIG_PATH = CFG;
  check(wt.worktreePath(key14, "manual") === path.join(WT_ROOT, "acme", "manual"), "T14: worktrees_root moves the root");
  const tw = wt.taskWorktree(key14, "/tasks/007-seven");
  check(tw.branch === "wt/007-seven" && tw.path === path.join(WT_ROOT, "acme", "007-seven"), `T14: taskWorktree derives branch and path (${JSON.stringify(tw)})`);
}

// --- T15: reap removes only a merged, clean worktree no live session runs inside ---

{
  const main = freshRepo("t15", "reaper");
  const made2 = wt.add({ projectDir: main, name: "reap-me" });
  check(made2.path === path.join(WT_ROOT, "reaper", "reap-me"), `T15: the named worktree is <root>/<repo>/<name> (${made2.path})`);
  fs.mkdirSync(path.join(made2.path, "sub"));
  process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
  session.register({ session_id: "reap-live", pid: process.pid, cwd: path.join(made2.path, "sub"), agent: "builder", repo_key: require("./lib/repo").repoKey(main).key });
  let r = wt.reap({ projectDir: main, path: made2.path });
  check(!r.removed && /live session reap-liv/.test(r.reason) && fs.existsSync(made2.path), `T15: a live session inside blocks it (${r.reason})`);
  session.unregister("reap-live");
  delete process.env.AGENTS_TEST_SKIP_IDENTITY;
  fs.writeFileSync(path.join(made2.path, "wip.txt"), "x\n");
  r = wt.reap({ projectDir: main, path: made2.path });
  check(!r.removed && r.reason === "uncommitted changes", `T15: a dirty tree stays (${r.reason})`);
  fs.unlinkSync(path.join(made2.path, "wip.txt"));
  commit(made2.path, "unmerged");
  r = wt.reap({ projectDir: main, path: made2.path });
  check(!r.removed && r.reason === "branch wt/reap-me is not merged into main", `T15: an unmerged branch stays (${r.reason})`);
  mergeInto(main, "wt/reap-me");
  r = wt.reap({ projectDir: main, path: made2.path });
  check(r.removed && r.branch_deleted && !fs.existsSync(made2.path) && git(main, ["branch", "--list", "wt/reap-me"]) === "", `T15: merged, clean and unoccupied it is removed with its branch (${JSON.stringify(r)})`);
  r = wt.reap({ projectDir: main, path: made2.path });
  check(!r.removed && r.reason === "not a worktree of this repo", `T15: a path git does not list is left alone (${r.reason})`);
}

// --- T16: survey (a doctor) lists removable, closed-task and done-but-open worktrees under the root ---

{
  const { archiveRoot } = require("./lib/tasks-root");
  const main = freshRepo("t16", "survey");
  const t16Key = require("./lib/repo").repoKey(main);
  const a = wt.add({ projectDir: main, name: "400-merged" });
  const b = wt.add({ projectDir: main, name: "401-closed" });
  fs.writeFileSync(path.join(b.path, "wip.txt"), "x\n");
  fs.mkdirSync(path.join(archiveRoot(), t16Key.key, "401-closed"), { recursive: true });
  const c = wt.add({ projectDir: main, name: "402-busy" });
  commit(c.path, "busy");
  // a done-but-open task's worktree: checked, landed, never closed
  const doneTask = taskLib.createTask({ repo: t16Key, title: "Done", slug: "done", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: doneTask.task_dir, phaseId: 1 });
  const d = wt.add({ projectDir: main, taskDir: doneTask.task_dir, force: true });
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", d.branch, "-m", "merge done"]);
  git(main, ["push", "-q", "origin", "main"]);
  const dId = db.taskIdOf(doneTask.task_dir);
  db.appendEvent({ kind: "land", repoKey: t16Key.key, taskId: dId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: d.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(dId);
  const mine = (rows) => rows.filter((row) => row.path.startsWith(path.join(WT_ROOT, "survey") + path.sep));
  const rows = mine(wt.survey());
  const ra = rows.find((row) => row.path === a.path);
  const rb = rows.find((row) => row.path === b.path);
  const rd = rows.find((row) => row.path === d.path);
  check(rows.length === 3 && !rows.some((row) => row.path === c.path), `T16: only the removable, the closed-task and the done-but-open worktrees are listed (${JSON.stringify(rows)})`);
  check(ra && ra.removable && !ra.task_closed && ra.clean === `a doctor --clean`, `T16: the merged clean one is removable with its clean line (${JSON.stringify(ra)})`);
  check(rb && !rb.removable && rb.task_closed && rb.reason === "uncommitted changes", `T16: the closed task's dirty one stays with its reason (${JSON.stringify(rb)})`);
  check(rd && !rd.removable && rd.task_closed === false && rd.reason === `task ${path.basename(doneTask.task_dir)} is done, not closed` && rd.clean === null, `T16: the done, not-closed task's worktree stays with its reason (${JSON.stringify(rd)})`);
  check(wt.surveyLine(ra) === `${a.path} [wt/400-merged]: removable; run: a doctor --clean`, `T16: the removable line (${wt.surveyLine(ra)})`);
  check(wt.surveyLine(rb) === `${b.path} [wt/401-closed]: task 401-closed is closed; stays: uncommitted changes`, `T16: the closed-task line (${wt.surveyLine(rb)})`);
  check(wt.surveyLine(rd) === `${d.path} [${d.branch}]: stays: task ${path.basename(doneTask.task_dir)} is done, not closed`, `T16: the done-but-open line (${wt.surveyLine(rd)})`);

  const A = path.join(__dirname, "bin", "a");
  const home = fs.mkdtempSync(path.join(BASE, "doctor-home-"));
  const env = { ...process.env, HOME: home };
  const docJson = spawnSync(process.execPath, [A, "doctor", "--json"], { encoding: "utf8", env, cwd: main });
  let doc = null;
  try { doc = JSON.parse(docJson.stdout); } catch {}
  const rowsOut = doc && doc.info && Array.isArray(doc.info.worktrees) ? doc.info.worktrees : null;
  const listed = rowsOut ? mine(rowsOut).map((row) => row.path).sort() : null;
  check(JSON.stringify(listed) === JSON.stringify([a.path, b.path, d.path].sort()), `T16: a doctor --json carries the rows (${JSON.stringify(listed)}; ${docJson.stderr.slice(-300)})`);
  const docText = spawnSync(process.execPath, [A, "doctor", "--verbose"], { encoding: "utf8", env, cwd: main });
  check(docText.stderr.includes(`worktree: ${wt.surveyLine(ra)}\n`) && docText.stderr.includes(`worktree: ${wt.surveyLine(rb)}\n`), `T16: a doctor --verbose prints one line per row (${docText.stderr.slice(-600)})`);
  check(docText.stderr.includes(`worktree: ${wt.surveyLine(rd)}\n`), `T16: the done-but-open row's stays line is printed (${docText.stderr.slice(-600)})`);
  const cleaned = spawnSync(process.execPath, [A, "doctor", "--clean"], { encoding: "utf8", env, cwd: os.tmpdir() });
  check(!fs.existsSync(a.path) && fs.existsSync(b.path) && fs.existsSync(c.path), `T16: a doctor --clean removes the removable one only (${cleaned.status}: ${cleaned.stderr.slice(-200)})`);
  check(fs.existsSync(d.path), `T16: a doctor --clean keeps the done, not-closed worktree (${cleaned.stderr.slice(-300)})`);
  check(cleaned.stderr.includes(`worktree kept: ${d.path} (task ${path.basename(doneTask.task_dir)} is done, not closed)`), `T16: the kept line names the reason (${cleaned.stderr.slice(-400)})`);
}

// --- T17: a worktree holding task notes under a real .tasks stays (remove refuses, doctor names it) ---

{
  const main = freshRepo("t17", "notes");
  const t17Key = require("./lib/repo").repoKey(main);
  const added = wt.add({ projectDir: main, name: "015-holder" });
  commit(added.path, "work");
  mergeInto(main, "wt/015-holder");
  fs.mkdirSync(path.join(added.path, ".tasks", "015-p"), { recursive: true });
  fs.writeFileSync(path.join(added.path, ".tasks", "015-p", "task.md"), "notes\n");

  const blocker = wt.removalBlocker(main, "main", { path: added.path, branch: "wt/015-holder" }, []);
  check(blocker === "holds task notes in .tasks/015-p", `T17: removalBlocker names the held notes (${blocker})`);

  let refused = null;
  try { wt.remove({ projectDir: main, path: added.path }); } catch (err) { refused = err; }
  check(refused && refused.code === "NOTES" && fs.existsSync(added.path),
    `T17: remove refuses without --force (${refused && refused.message})`);
  const forced = wt.remove({ projectDir: main, path: added.path, force: true });
  check(forced.removed === added.path, `T17: --force removes it (${forced.removed})`);

  // the doctor names the stray in a worktree of a repos row (a fresh holder, since the first went)
  const holder2 = wt.add({ projectDir: main, name: "016-holder" });
  mergeInto(main, "wt/016-holder");
  fs.mkdirSync(path.join(holder2.path, ".tasks", "015-p"), { recursive: true });
  fs.writeFileSync(path.join(holder2.path, ".tasks", "015-p", "task.md"), "notes\n");
  db.upsertRepo(t17Key.key, { main_root: main });
  const strays = wt.strayNotesInRepo(main);
  check(strays.length === 1 && strays[0] === path.join(holder2.path, ".tasks", "015-p"),
    `T17: strayNotesInRepo names the worktree's .tasks (${JSON.stringify(strays)})`);
  const A = path.join(__dirname, "bin", "a");
  const docJson = spawnSync(process.execPath, [A, "doctor", "--json"], { encoding: "utf8", env: { ...process.env }, cwd: main });
  let doc = null;
  try { doc = JSON.parse(docJson.stdout); } catch {}
  const docStrays = ((doc && doc.info && doc.info.strays) || []).join("\n");
  check(docStrays.includes("015-p"), `T17: a doctor carries the worktree's stray .tasks in info.strays (${docStrays.slice(0, 300)})`);
}

// --- T18: the one removal rule — a closed task's worktree is removable; a done, not-closed task's stays; open task stays; non-task keeps merged leg ---

function repoWithOrigin(tag, name) {
  const base = fs.mkdtempSync(path.join(BASE, `t-${tag}-`));
  const origin = path.join(base, "origin.git");
  const main = path.join(base, name || "repo");
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(main, ".gitignore"), ".tasks\n");
  git(main, ["add", ".gitignore"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  git(main, ["remote", "add", "origin", origin]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["remote", "set-head", "origin", "main"]);
  const key = require("./lib/repo").repoKey(main);
  const policiesPath = path.join(WT_HOME, ".agents", "repo-policies.json");
  let policies = {};
  try { policies = JSON.parse(fs.readFileSync(policiesPath, "utf8")); } catch {}
  policies[fs.realpathSync(main)] = { push: "direct" };
  policies[main] = { push: "direct" };
  fs.writeFileSync(policiesPath, JSON.stringify(policies));
  return { main, key, origin };
}

{
  const { main, key: t18Key } = repoWithOrigin("t18", "onerule");
  // A task-bound worktree with a done task
  const doneTask = taskLib.createTask({ repo: t18Key, title: "Done", slug: "done", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: doneTask.task_dir, phaseId: 1 });
  const doneWt = wt.add({ projectDir: main, taskDir: doneTask.task_dir, force: true });
  // Simulate a landing: merge the branch and push to origin
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", doneWt.branch, "-m", "merge done"]);
  git(main, ["push", "-q", "origin", "main"]);
  const doneTaskId = db.taskIdOf(doneTask.task_dir);
  db.appendEvent({ kind: "land", repoKey: t18Key.key, taskId: doneTaskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: doneWt.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(doneTaskId);

  const doneRow = db.getTask(doneTaskId);
  const doneDoc = taskLib.readTaskJson(doneTask.task_dir);
  const doneStatus = require("./lib/derive").taskStatusOf(doneRow, doneDoc);
  check(doneStatus === "done", `T18: the done task reads done (${doneStatus})`);

  // A task-bound worktree with an open (not done) task
  const openTask = taskLib.createTask({ repo: t18Key, title: "Open", slug: "open", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const openWt = wt.add({ projectDir: main, taskDir: openTask.task_dir, force: true });

  const doneBlocker = wt.removalBlocker(main, "main", { path: doneWt.path, branch: doneWt.branch }, []);
  check(doneBlocker === `task ${path.basename(doneTask.task_dir)} is done, not closed`, `T18: the done, not-closed task's worktree stays until its close (${doneBlocker})`);

  const openBlocker = wt.removalBlocker(main, "main", { path: openWt.path, branch: openWt.branch }, []);
  check(openBlocker === `task ${path.basename(openTask.task_dir)} is not done`, `T18: the open task's worktree is kept (${openBlocker})`);

  // A genuinely closed task (the folder archived): removable even when the branch is not merged
  const closedTask = taskLib.createTask({ repo: t18Key, title: "Closed", slug: "closed", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const closedWt = wt.add({ projectDir: main, taskDir: closedTask.task_dir, force: true });
  commit(closedWt.path, "unmerged work");
  const t18Archive = path.join(require("./lib/tasks-root").archiveRoot(), t18Key.key);
  fs.mkdirSync(t18Archive, { recursive: true });
  fs.renameSync(closedTask.task_dir, path.join(t18Archive, path.basename(closedTask.task_dir)));
  db.setTaskDisposition({ repoKey: t18Key.key, dirName: path.basename(closedTask.task_dir), disposition: "archived" });
  const closedBlocker = wt.removalBlocker(main, "main", { path: closedWt.path, branch: closedWt.branch }, []);
  check(closedBlocker === null, `T18: the closed task's worktree is removable even when its branch is not merged (${closedBlocker})`);

  // A row archived in the database whose folder is still live reads untrackable
  // (the folder check returns first, the row leaves the active list), so the
  // merged leg decides — the branch rides main's tip, removable here
  const liveClosedTask = taskLib.createTask({ repo: t18Key, title: "LiveClosed", slug: "liveclosed", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const liveClosedWt = wt.add({ projectDir: main, taskDir: liveClosedTask.task_dir, force: true });
  db.setTaskDisposition({ repoKey: t18Key.key, dirName: path.basename(liveClosedTask.task_dir), disposition: "archived" });
  const liveClosedBlocker = wt.removalBlocker(main, "main", { path: liveClosedWt.path, branch: liveClosedWt.branch }, []);
  check(liveClosedBlocker === null, `T18: a db-archived task whose folder is still live falls back to the merged leg (${liveClosedBlocker})`);

  // A non-task worktree keeps the merged leg
  const nonTaskWt = wt.add({ projectDir: main, name: "manual" });
  commit(nonTaskWt.path, "unmerged work");
  const nonTaskBlocker = wt.removalBlocker(main, "main", { path: nonTaskWt.path, branch: nonTaskWt.branch }, []);
  check(nonTaskBlocker === `branch wt/manual is not merged into main`, `T18: the non-task worktree keeps the merged leg (${nonTaskBlocker})`);

  // A name-based worktree matching wt/NNN-slug but with no task in the DB keeps the merged leg
  const fakeWt = wt.add({ projectDir: main, name: "500-fake" });
  mergeInto(main, "wt/500-fake");
  const fakeBlocker = wt.removalBlocker(main, "main", { path: fakeWt.path, branch: fakeWt.branch }, []);
  check(fakeBlocker === null, `T18: a wt/NNN-slug worktree with no task in the DB keeps the merged leg (${fakeBlocker})`);

  // Clean up
  wt.remove({ projectDir: main, path: doneWt.path, force: true });
  wt.remove({ projectDir: main, path: openWt.path, force: true });
  wt.remove({ projectDir: main, path: closedWt.path, force: true });
  wt.remove({ projectDir: main, path: liveClosedWt.path, force: true });
  wt.remove({ projectDir: main, path: nonTaskWt.path, force: true });
  wt.remove({ projectDir: main, path: fakeWt.path, force: true });
}

// --- T19: strayTaskNotes skips symlinked entries ---

{
  const main = freshRepo("t19", "symlinks");
  const t19Key = require("./lib/repo").repoKey(main);
  const t19Task = taskLib.createTask({ repo: t19Key, title: "Symlinked", slug: "symlinked", session_id: "s", phases: [{ id: 1, name: "One" }] });
  wt.linkTaskFolder(main, t19Task.task_dir);

  // The .tasks dir exists with a symlinked entry
  const tasksDir = path.join(main, ".tasks");
  check(fs.lstatSync(path.join(tasksDir, path.basename(t19Task.task_dir))).isSymbolicLink(), "T19: linkTaskFolder created a symlink");

  // strayTaskNotes returns nothing for the symlinked entry
  const notes = wt.strayTaskNotes(main);
  check(notes.length === 0, `T19: strayTaskNotes skips symlinks (${JSON.stringify(notes)})`);

  // A real directory still counts
  fs.mkdirSync(path.join(tasksDir, "999-real"), { recursive: true });
  const notes2 = wt.strayTaskNotes(main);
  check(notes2.length === 1 && notes2[0] === "999-real", `T19: strayTaskNotes counts real directories (${JSON.stringify(notes2)})`);
}

// --- T20: linkTaskFolder creates the symlink and the info/exclude line ---

{
  const main = freshRepo("t20", "link");
  const t20Key = require("./lib/repo").repoKey(main);
  const t20Task = taskLib.createTask({ repo: t20Key, title: "Link", slug: "link", session_id: "s", phases: [{ id: 1, name: "One" }] });
  wt.linkTaskFolder(main, t20Task.task_dir);

  const linkPath = path.join(main, ".tasks", path.basename(t20Task.task_dir));
  check(fs.lstatSync(linkPath).isSymbolicLink(), "T20: the .tasks link is a symlink");
  check(fs.realpathSync(linkPath) === fs.realpathSync(t20Task.task_dir), "T20: the symlink points at the central task folder");

  const commonDir = git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const exclude = path.join(commonDir, "info", "exclude");
  const excludeContent = fs.readFileSync(exclude, "utf8");
  check(excludeContent.includes("/.tasks/"), `T20: info/exclude carries /.tasks/ (${excludeContent})`);

  // Idempotent: calling again does not duplicate the line
  wt.linkTaskFolder(main, t20Task.task_dir);
  const excludeContent2 = fs.readFileSync(exclude, "utf8");
  const count = (excludeContent2.match(/\/\.tasks\//g) || []).length;
  check(count === 1, `T20: info/exclude has exactly one /.tasks/ line (${count})`);

  // linkTaskFolder also works in a worktree
  const added = wt.add({ projectDir: main, name: "linkwt" });
  wt.linkTaskFolder(added.path, t20Task.task_dir);
  const wtLinkPath = path.join(added.path, ".tasks", path.basename(t20Task.task_dir));
  check(fs.lstatSync(wtLinkPath).isSymbolicLink(), "T20: the worktree's .tasks link is a symlink");
  check(fs.realpathSync(wtLinkPath) === fs.realpathSync(t20Task.task_dir), "T20: the worktree's symlink points at the central task folder");

  wt.remove({ projectDir: main, path: added.path, force: true });
}

// --- T21: sweepStale removes closed, clean, unoccupied worktrees; a done, not-closed one stays ---

{
  const { main, key: t21Key } = repoWithOrigin("t21", "sweep");
  // A done-but-open task's worktree (held until the task's close)
  const doneTask = taskLib.createTask({ repo: t21Key, title: "Done2", slug: "done2", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: doneTask.task_dir, phaseId: 1 });
  const doneWt = wt.add({ projectDir: main, taskDir: doneTask.task_dir, force: true });
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", doneWt.branch, "-m", "merge"]);
  git(main, ["push", "-q", "origin", "main"]);
  const doneId = db.taskIdOf(doneTask.task_dir);
  db.appendEvent({ kind: "land", repoKey: t21Key.key, taskId: doneId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: doneWt.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(doneId);

  // An open task's worktree (not removable)
  const openTask = taskLib.createTask({ repo: t21Key, title: "Open2", slug: "open2", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const openWt = wt.add({ projectDir: main, taskDir: openTask.task_dir, force: true });

  const result = wt.sweepStale(main);
  check(!result.swept.some((s) => s.path === doneWt.path), `T21: the sweep leaves the done, not-closed worktree (${JSON.stringify(result.swept)})`);
  check(!result.held.some((h) => h.path === doneWt.path), `T21: the kept worktree is no hold — held is teardown-only (${JSON.stringify(result.held)})`);
  check(fs.existsSync(doneWt.path), "T21: the done, not-closed worktree survives the sweep");
  check(!result.swept.some((s) => s.path === openWt.path), `T21: sweep keeps the open task's worktree (${JSON.stringify(result.swept)})`);
  check(fs.existsSync(openWt.path), "T21: the open worktree stays");

  // A closed task's worktree (the done recipe plus the archive step a close performs)
  const closedTask = taskLib.createTask({ repo: t21Key, title: "Closed2", slug: "closed2", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: closedTask.task_dir, phaseId: 1 });
  const closedWt = wt.add({ projectDir: main, taskDir: closedTask.task_dir, force: true });
  mergeInto(main, closedWt.branch);
  git(main, ["push", "-q", "origin", "main"]);
  const closedId = db.taskIdOf(closedTask.task_dir);
  db.appendEvent({ kind: "land", repoKey: t21Key.key, taskId: closedId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: closedWt.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(closedId);
  const t21Archive = path.join(require("./lib/tasks-root").archiveRoot(), t21Key.key);
  fs.mkdirSync(t21Archive, { recursive: true });
  fs.renameSync(closedTask.task_dir, path.join(t21Archive, path.basename(closedTask.task_dir)));
  db.setTaskDisposition({ repoKey: t21Key.key, dirName: path.basename(closedTask.task_dir), disposition: "archived" });

  const closedResult = wt.sweepStale(main);
  check(closedResult.swept.some((s) => s.path === closedWt.path), `T21: the sweep removes the closed task's worktree (${JSON.stringify(closedResult.swept)})`);
  check(!fs.existsSync(closedWt.path), "T21: the closed task's worktree is gone");
  check(git(main, ["branch", "--list", closedWt.branch]) === "", "T21: the closed task's branch is deleted");
}

// --- T22: the per-repo teardown command (repos[key] = {teardown}) runs before a
// worktree is removed, on every removal path — and on a kept close, closed tasks
// only, once per success, retried by every later visit; "" opts out; a failure never blocks ---

{
  const { main, key: t22Key } = repoWithOrigin("t22", "teardown");
  const t22Tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t22-"));
  const mark = (n) => path.join(t22Tmp, n);
  const setTeardown = (cmd) => fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, repos: { [t22Key.key]: { teardown: cmd } } }));
  const parseDump = (p) => {
    const env = {};
    for (const entry of fs.readFileSync(p, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  };

  // remove() runs the command with cwd in the worktree, before the removal, in the clean-base env
  setTeardown(`pwd > ${mark("ran")}; env -0 > ${mark("env-dump")}`);
  const merged = wt.add({ projectDir: main, name: "teardown-me" });
  commit(merged.path, "work");
  mergeInto(main, merged.branch);
  const mergedReal = fs.realpathSync(merged.path);
  const savedVirtualEnv = process.env.VIRTUAL_ENV;
  process.env.VIRTUAL_ENV = "/fake/venv-t22";
  const removed = wt.remove({ projectDir: main, path: merged.path, force: false });
  process.env.VIRTUAL_ENV = savedVirtualEnv;
  check(removed.removed === merged.path && !fs.existsSync(merged.path), "T22: remove still removes the worktree");
  check(removed.teardown && removed.teardown.exit_code === 0 && removed.teardown.command.includes("env -0"), `T22: the result carries the teardown run (${JSON.stringify(removed.teardown)})`);
  check(fs.readFileSync(mark("ran"), "utf8").trim() === mergedReal, "T22: the teardown command ran with cwd in the worktree, before the removal");
  check(!("VIRTUAL_ENV" in parseDump(mark("env-dump"))), "T22: the teardown env is the clean base (no VIRTUAL_ENV)");

  // a failing teardown never blocks the removal; the failure is carried in the result
  setTeardown(`pwd > ${mark("ran-fail")}; exit 1`);
  const failing = wt.add({ projectDir: main, name: "teardown-fail" });
  commit(failing.path, "work");
  mergeInto(main, failing.branch);
  const removedFail = wt.remove({ projectDir: main, path: failing.path, force: false });
  check(removedFail.removed === failing.path && !fs.existsSync(failing.path), "T22: a failing teardown never blocks the removal");
  check(removedFail.teardown && removedFail.teardown.exit_code === 1, `T22: the failure is carried in the result (${JSON.stringify(removedFail.teardown)})`);

  // --force (the failed-start rollback path) still runs it
  setTeardown(`pwd > ${mark("forced")}`);
  const forced = wt.add({ projectDir: main, name: "teardown-force" });
  const removedForced = wt.remove({ projectDir: main, path: forced.path, force: true });
  check(removedForced.removed === forced.path, "T22: a forced remove removes the unmerged worktree");
  check(fs.existsSync(mark("forced")), "T22: the forced remove (the rollback path) runs the teardown command too");

  // "" opts out entirely: no teardown runs, no teardown key in the result
  setTeardown("");
  const out = wt.add({ projectDir: main, name: "teardown-out" });
  commit(out.path, "work");
  mergeInto(main, out.branch);
  const removedOut = wt.remove({ projectDir: main, path: out.path, force: false });
  check(removedOut.removed === out.path && !("teardown" in removedOut), `T22: a teardown of "" opts out entirely (${JSON.stringify(removedOut)})`);

  // A closed task's worktree — the done recipe plus the archive step a close
  // performs — is the plant for every leg below: the one shape the rule still removes.
  const plantClosed = (slug) => {
    const task = taskLib.createTask({ repo: t22Key, title: `Closed ${slug}`, slug, session_id: "s", phases: [{ id: 1, name: "One" }] });
    taskLib.checkPhase({ taskDir: task.task_dir, phaseId: 1 });
    const added = wt.add({ projectDir: main, taskDir: task.task_dir, force: true });
    mergeInto(main, added.branch);
    git(main, ["push", "-q", "origin", "main"]);
    const id = db.taskIdOf(task.task_dir);
    db.appendEvent({ kind: "land", repoKey: t22Key.key, taskId: id, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
    require("./lib/derive").invalidateTask(id);
    const base = path.join(require("./lib/tasks-root").archiveRoot(), t22Key.key);
    fs.mkdirSync(base, { recursive: true });
    fs.renameSync(task.task_dir, path.join(base, path.basename(task.task_dir)));
    db.setTaskDisposition({ repoKey: t22Key.key, dirName: path.basename(task.task_dir), disposition: "archived" });
    return added;
  };

  // the sweep path runs it too
  setTeardown(`pwd > ${mark("swept")}`);
  const doneWt = plantClosed("donet22");
  const doneReal = fs.realpathSync(doneWt.path);
  const sweepResult = wt.sweepStale(main);
  check(sweepResult.swept.some((s) => s.path === doneWt.path), `T22: sweep removes the closed worktree (${JSON.stringify(sweepResult.swept)})`);
  check(fs.readFileSync(mark("swept"), "utf8").trim() === doneReal, "T22: the sweep path runs the teardown command too");
  check(sweepResult.swept.some((s) => s.path === doneWt.path && s.teardown && s.teardown.exit_code === 0), `T22: the swept row carries the teardown run (${JSON.stringify(sweepResult.swept)})`);

  // the reap funnel (close, batch close, land) runs it and reports it in the result
  setTeardown(`pwd > ${mark("reaped")}`);
  const reapedWt = plantClosed("donetwotwo");
  const reapedReal = fs.realpathSync(reapedWt.path);
  const reaped = wt.reap({ projectDir: main, path: reapedWt.path });
  check(reaped.removed === true && !fs.existsSync(reapedWt.path), `T22: reap removes the closed worktree (${JSON.stringify(reaped)})`);
  check(reaped.teardown && reaped.teardown.exit_code === 0, `T22: the reap result carries the teardown run (${JSON.stringify(reaped.teardown)})`);
  check(fs.readFileSync(mark("reaped"), "utf8").trim() === reapedReal, "T22: the reap path runs the teardown command too");

  // no teardown configured → no teardown key in the reap result (absent means not run)
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
  const bareWt = plantClosed("donetwobare");
  const reapedBare = wt.reap({ projectDir: main, path: bareWt.path });
  check(reapedBare.removed === true && !("teardown" in reapedBare), `T22: a reap without a configured teardown carries no teardown key (${JSON.stringify(reapedBare)})`);

  // A teardown that did not complete holds the worktree: remove refuses with
  // the --force remedy, the sweep reports a held row and retries on the next
  // run, reap keeps the worktree.
  const savedKnob = process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";

  setTeardown("sleep 2");
  const heldWt = wt.add({ projectDir: main, name: "hold-timeout" });
  commit(heldWt.path, "work");
  mergeInto(main, heldWt.branch);
  let timeoutErr = null;
  try { wt.remove({ projectDir: main, path: heldWt.path, force: false }); } catch (err) { timeoutErr = err; }
  check(timeoutErr && timeoutErr.code === "TEARDOWN_INCOMPLETE", `T22: a timed-out teardown refuses the remove (${timeoutErr && timeoutErr.code})`);
  check(timeoutErr && /--force/.test(timeoutErr.message), `T22: the refusal names the --force remedy (${timeoutErr && timeoutErr.message})`);
  check(timeoutErr && timeoutErr.teardown && timeoutErr.teardown.exit_code === null, `T22: the refusal carries the incomplete run (${JSON.stringify(timeoutErr && timeoutErr.teardown)})`);
  check(fs.existsSync(heldWt.path), "T22: the timed-out worktree still exists");

  setTeardown("kill -9 $$");
  const signalWt = wt.add({ projectDir: main, name: "hold-signal" });
  commit(signalWt.path, "work");
  mergeInto(main, signalWt.branch);
  let signalErr = null;
  try { wt.remove({ projectDir: main, path: signalWt.path, force: false }); } catch (err) { signalErr = err; }
  check(signalErr && signalErr.code === "TEARDOWN_INCOMPLETE" && signalErr.teardown && signalErr.teardown.exit_code === null, `T22: a signal-killed teardown refuses the remove (${signalErr && signalErr.code})`);
  check(fs.existsSync(signalWt.path), "T22: the signal-held worktree still exists");

  // --force removes past the hold (the failed-start rollback's semantics)
  setTeardown("sleep 2");
  const forceWt = wt.add({ projectDir: main, name: "hold-force" });
  commit(forceWt.path, "work");
  mergeInto(main, forceWt.branch);
  const removedHeld = wt.remove({ projectDir: main, path: forceWt.path, force: true });
  check(!fs.existsSync(forceWt.path), "T22: --force removes past the hold");
  check(removedHeld.teardown && removedHeld.teardown.exit_code === null, `T22: the forced removal still carries the incomplete run (${JSON.stringify(removedHeld.teardown)})`);

  // the held plants above must not join the sweep legs below
  setTeardown("true");
  if (fs.existsSync(heldWt.path)) wt.remove({ projectDir: main, path: heldWt.path, force: true });
  if (fs.existsSync(signalWt.path)) wt.remove({ projectDir: main, path: signalWt.path, force: true });

  // the sweep holds an incomplete teardown, warns, and the next sweep retries it
  setTeardown("sleep 2");
  const holdSweepWt = plantClosed("donehold");
  const holdSweepReal = fs.realpathSync(holdSweepWt.path);
  const heldSweep = wt.sweepStale(main);
  check(!heldSweep.swept.some((s) => s.path === holdSweepWt.path), `T22: the sweep does not remove the held worktree (${JSON.stringify(heldSweep.swept)})`);
  check(heldSweep.held && heldSweep.held.some((h) => h.path === holdSweepWt.path && h.teardown && h.teardown.exit_code === null), `T22: the held row carries the incomplete run (${JSON.stringify(heldSweep.held)})`);
  check(heldSweep.warnings.some((w) => w === `held ${holdSweepWt.path}: teardown did not complete; the next sweep retries it`), `T22: the sweep warns about the hold (${JSON.stringify(heldSweep.warnings)})`);
  check(fs.existsSync(holdSweepWt.path), "T22: the held worktree survives the sweep");
  setTeardown(`pwd > ${mark("retried")}`);
  delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  const retried = wt.sweepStale(main);
  check(retried.swept.some((s) => s.path === holdSweepWt.path && s.teardown && s.teardown.exit_code === 0), `T22: the next sweep retries the held worktree (${JSON.stringify(retried.swept)})`);
  check(fs.existsSync(mark("retried")) && fs.readFileSync(mark("retried"), "utf8").trim() === holdSweepReal, "T22: the retry runs the teardown in the worktree and removes it");
  check(!fs.existsSync(holdSweepWt.path), "T22: the retried worktree is gone");

  // a held reap keeps the worktree; --force cleans it
  setTeardown("sleep 2");
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  const holdReapWt = plantClosed("donereap");
  const heldReap = wt.reap({ projectDir: main, path: holdReapWt.path });
  check(heldReap.removed === false && /did not complete/.test(heldReap.reason || ""), `T22: a held reap keeps the worktree (${JSON.stringify(heldReap)})`);
  check(heldReap.teardown && heldReap.teardown.exit_code === null, `T22: the held reap carries the incomplete run (${JSON.stringify(heldReap.teardown)})`);
  check(fs.existsSync(holdReapWt.path), "T22: the reap-held worktree still exists");
  setTeardown("true");
  if (fs.existsSync(holdReapWt.path)) wt.remove({ projectDir: main, path: holdReapWt.path, force: true });
  check(!fs.existsSync(holdReapWt.path), "T22: --force removes past a held reap");
  if (savedKnob === undefined) delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS; else process.env.AGENTS_TEARDOWN_TIMEOUT_MS = savedKnob;

  // --- the kept-close legs: a close whose worktree is held still releases the
  // repo's resources — the teardown runs while the files stay, once per
  // success, retried by every later visit until it exits 0 ---

  const keptKnob = process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  const teardownRecordOf = (w) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(git(w, ["rev-parse", "--absolute-git-dir"]), "teardown.json"), "utf8"));
    } catch { return null; }
  };
  const linesOf = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;

  // a kept close runs the teardown in the held worktree; the record turns complete
  setTeardown(`pwd >> ${mark("kept-ran")}`);
  const keptWt = plantClosed("keptclose");
  const keptReal = fs.realpathSync(keptWt.path);
  fs.writeFileSync(path.join(keptWt.path, "held.txt"), "held\n");
  const keptReap = wt.reap({ projectDir: main, path: keptWt.path });
  check(keptReap.removed === false && keptReap.reason === "uncommitted changes", `T22: the dirty closed worktree is kept (${JSON.stringify(keptReap.reason)})`);
  check(keptReap.teardown && keptReap.teardown.exit_code === 0 && !keptReap.teardown.already_ran, `T22: the kept close carries the teardown run (${JSON.stringify(keptReap.teardown)})`);
  check(fs.readFileSync(mark("kept-ran"), "utf8").trim() === keptReal, "T22: the teardown ran inside the kept worktree, cwd in it");
  check(fs.existsSync(keptWt.path) && fs.existsSync(path.join(keptWt.path, "held.txt")), "T22: the kept worktree and its files stay on disk");
  check(wt.reapLine(keptReap) === `worktree kept: ${keptWt.path} (uncommitted changes); teardown ran`, `T22: the kept line carries the teardown bit (${wt.reapLine(keptReap)})`);
  const keptRec = teardownRecordOf(keptWt.path);
  check(keptRec && keptRec.state === "complete" && keptRec.exit_code === 0, `T22: the record reads complete (${JSON.stringify(keptRec)})`);

  // idempotency: a second reap and a later clean visit run nothing again
  const keptReap2 = wt.reap({ projectDir: main, path: keptWt.path });
  check(keptReap2.teardown && keptReap2.teardown.already_ran === true && keptReap2.teardown.exit_code === 0, `T22: a second reap says already_ran (${JSON.stringify(keptReap2.teardown)})`);
  check(wt.reapLine(keptReap2) === `worktree kept: ${keptWt.path} (uncommitted changes); teardown already ran`, `T22: the second line says already ran (${wt.reapLine(keptReap2)})`);
  const keptClean = wt.cleanSurvey();
  const keptCleanRow = keptClean.kept.find((r) => r.path === keptWt.path);
  check(keptCleanRow && keptCleanRow.teardown && keptCleanRow.teardown.already_ran === true, `T22: the clean visit's kept row says already_ran (${JSON.stringify(keptCleanRow && keptCleanRow.teardown)})`);
  check(linesOf(mark("kept-ran")) === 1, `T22: the complete teardown runs nothing again (${linesOf(mark("kept-ran"))} lines in the mark)`);

  // the until-success loop: a failed teardown retries at every visit; only an exit-0 run is terminal
  setTeardown(`pwd >> ${mark("kept-retry")}; exit 1`);
  const retryWt = plantClosed("retryme");
  fs.writeFileSync(path.join(retryWt.path, "held.txt"), "held\n");
  const failedReap = wt.reap({ projectDir: main, path: retryWt.path });
  check(failedReap.teardown && failedReap.teardown.exit_code === 1, `T22: the kept close carries the failed run (${JSON.stringify(failedReap.teardown)})`);
  check(wt.reapLine(failedReap) === `worktree kept: ${retryWt.path} (uncommitted changes); teardown failed (exit 1) — the next clean retries it`, `T22: the kept line warns and names the retry (${wt.reapLine(failedReap)})`);
  let retryRec = teardownRecordOf(retryWt.path);
  check(retryRec && retryRec.state === "failed" && retryRec.exit_code === 1, `T22: the failed run records failed (${JSON.stringify(retryRec)})`);
  check(linesOf(mark("kept-retry")) === 1, "T22: the failed run appended the mark once");
  const retriedClean = wt.cleanSurvey();
  const retriedRow = retriedClean.kept.find((r) => r.path === retryWt.path);
  check(retriedRow && retriedRow.teardown && retriedRow.teardown.exit_code === 1 && !retriedRow.teardown.already_ran, `T22: the next clean re-runs the failed teardown (${JSON.stringify(retriedRow && retriedRow.teardown)})`);
  check(linesOf(mark("kept-retry")) === 2, "T22: the re-run appended the mark again");
  setTeardown(`pwd >> ${mark("kept-retry")}`);
  const doneClean = wt.cleanSurvey();
  const doneRow = doneClean.kept.find((r) => r.path === retryWt.path);
  check(doneRow && doneRow.teardown && doneRow.teardown.exit_code === 0, `T22: the visit that succeeds runs to exit 0 (${JSON.stringify(doneRow && doneRow.teardown)})`);
  retryRec = teardownRecordOf(retryWt.path);
  check(retryRec && retryRec.state === "complete", `T22: the record turned complete (${JSON.stringify(retryRec)})`);
  const settledClean = wt.cleanSurvey();
  const settledRow = settledClean.kept.find((r) => r.path === retryWt.path);
  check(settledRow && settledRow.teardown && settledRow.teardown.already_ran === true, `T22: every later visit says already_ran (${JSON.stringify(settledRow && settledRow.teardown)})`);
  check(linesOf(mark("kept-retry")) === 3, `T22: the exit-0 run is terminal — one mark line per actual run (${linesOf(mark("kept-retry"))})`);

  // an unfinished kept-close run (timeout kill) records incomplete and retries the same way
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  setTeardown("sleep 2");
  const timedWt = plantClosed("timedheld");
  fs.writeFileSync(path.join(timedWt.path, "held.txt"), "held\n");
  const timedReap = wt.reap({ projectDir: main, path: timedWt.path });
  check(timedReap.teardown && timedReap.teardown.exit_code === null && timedReap.teardown.error, `T22: the kept close carries the unfinished run (${JSON.stringify(timedReap.teardown)})`);
  check(wt.reapLine(timedReap) === `worktree kept: ${timedWt.path} (uncommitted changes); teardown did not complete — the next clean retries it`, `T22: the kept line names the incomplete retry (${wt.reapLine(timedReap)})`);
  const timedRec = teardownRecordOf(timedWt.path);
  check(timedRec && timedRec.state === "incomplete" && timedRec.exit_code === null && timedRec.error, `T22: the unfinished run records incomplete (${JSON.stringify(timedRec)})`);
  delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  setTeardown(`pwd > ${mark("timed-retried")}`);
  const timedClean = wt.cleanSurvey();
  const timedRow = timedClean.kept.find((r) => r.path === timedWt.path);
  check(timedRow && timedRow.teardown && timedRow.teardown.exit_code === 0 && fs.existsSync(mark("timed-retried")), `T22: the next clean retries the incomplete teardown to success (${JSON.stringify(timedRow && timedRow.teardown)})`);

  // the remove seam: the refusal never reads the record — a failed record's
  // retry finishes non-zero and the removal proceeds; only a retry that
  // cannot finish refuses; a complete record runs nothing
  setTeardown(`pwd >> ${mark("seam-fail")}; exit 1`);
  const seamWt = plantClosed("seamfail");
  fs.writeFileSync(path.join(seamWt.path, "held.txt"), "held\n");
  wt.reap({ projectDir: main, path: seamWt.path });
  check(teardownRecordOf(seamWt.path) && teardownRecordOf(seamWt.path).state === "failed", "T22: the seam plant holds a failed record");
  fs.unlinkSync(path.join(seamWt.path, "held.txt"));
  const seamRemoved = wt.remove({ projectDir: main, path: seamWt.path, force: false });
  check(seamRemoved.removed === seamWt.path && !fs.existsSync(seamWt.path), "T22: a failed record never blocks the removal of the cleaned tree");
  check(seamRemoved.teardown && seamRemoved.teardown.exit_code === 1 && !seamRemoved.teardown.already_ran, `T22: the removal retried the failed teardown once (${JSON.stringify(seamRemoved.teardown)})`);
  check(linesOf(mark("seam-fail")) === 2, "T22: the retry appended the mark again before the removal");

  setTeardown(`pwd > ${mark("seam-hang")}; exit 1`);
  const hangWt = plantClosed("seamhang");
  fs.writeFileSync(path.join(hangWt.path, "held.txt"), "held\n");
  wt.reap({ projectDir: main, path: hangWt.path });
  fs.unlinkSync(path.join(hangWt.path, "held.txt"));
  setTeardown("sleep 2");
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  let seamHangErr = null;
  try { wt.remove({ projectDir: main, path: hangWt.path, force: false }); } catch (err) { seamHangErr = err; }
  check(seamHangErr && seamHangErr.code === "TEARDOWN_INCOMPLETE", `T22: a retry that cannot finish refuses exactly as a fresh hang (${seamHangErr && seamHangErr.code})`);
  check(seamHangErr && seamHangErr.teardown && seamHangErr.teardown.exit_code === null, `T22: the refusal carries the unfinished retry (${JSON.stringify(seamHangErr && seamHangErr.teardown)})`);
  check(fs.existsSync(hangWt.path), "T22: the hung worktree still exists");
  if (keptKnob === undefined) delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS; else process.env.AGENTS_TEARDOWN_TIMEOUT_MS = keptKnob;
  setTeardown("true");
  if (fs.existsSync(hangWt.path)) wt.remove({ projectDir: main, path: hangWt.path, force: true });

  setTeardown(`pwd >> ${mark("seam-done")}`);
  const doneSeamWt = plantClosed("seamdone");
  fs.writeFileSync(path.join(doneSeamWt.path, "held.txt"), "held\n");
  wt.reap({ projectDir: main, path: doneSeamWt.path });
  check(teardownRecordOf(doneSeamWt.path) && teardownRecordOf(doneSeamWt.path).state === "complete", "T22: the done seam plant holds a complete record");
  fs.unlinkSync(path.join(doneSeamWt.path, "held.txt"));
  const doneRemoved = wt.remove({ projectDir: main, path: doneSeamWt.path, force: false });
  check(doneRemoved.removed === doneSeamWt.path && doneRemoved.teardown && doneRemoved.teardown.already_ran === true, `T22: a complete record removes without a re-run (${JSON.stringify(doneRemoved.teardown)})`);
  check(linesOf(mark("seam-done")) === 1, "T22: the removal re-ran nothing");

  // a live session inside holds the teardown itself; the line names it, and the visit after it ends self-heals
  setTeardown(`pwd > ${mark("held-live")}`);
  const liveWt = plantClosed("livelive");
  fs.writeFileSync(path.join(liveWt.path, "held.txt"), "held\n");
  fs.mkdirSync(path.join(liveWt.path, "sub"));
  process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
  session.register({ session_id: "t22-kept-live", pid: process.pid, cwd: path.join(liveWt.path, "sub"), agent: "builder", repo_key: t22Key.key });
  const heldLiveReap = wt.reap({ projectDir: main, path: liveWt.path });
  check(heldLiveReap.removed === false && !("teardown" in heldLiveReap), `T22: a live session inside holds the teardown (${JSON.stringify({ reason: heldLiveReap.reason })})`);
  check(heldLiveReap.reason === "uncommitted changes; teardown held — a live session runs inside it", `T22: the kept reason names the held teardown (${heldLiveReap.reason})`);
  check(wt.reapLine(heldLiveReap) === `worktree kept: ${liveWt.path} (uncommitted changes; teardown held — a live session runs inside it)`, `T22: the kept line names the hold (${wt.reapLine(heldLiveReap)})`);
  check(!fs.existsSync(mark("held-live")) && !teardownRecordOf(liveWt.path), "T22: nothing ran and nothing was recorded under the live session's feet");
  session.unregister("t22-kept-live");
  delete process.env.AGENTS_TEST_SKIP_IDENTITY;
  const healedClean = wt.cleanSurvey();
  const healedRow = healedClean.kept.find((r) => r.path === liveWt.path);
  check(healedRow && healedRow.teardown && healedRow.teardown.exit_code === 0 && fs.existsSync(mark("held-live")), `T22: the visit after the session ends tears down (the self-heal) (${JSON.stringify(healedRow && healedRow.teardown)})`);

  // an open task's and a done, not-closed task's kept worktrees never release anything
  setTeardown(`pwd > ${mark("never-ran")}`);
  const openPlant = taskLib.createTask({ repo: t22Key, title: "T22 open", slug: "opentwotwo", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const openWtT22 = wt.add({ projectDir: main, taskDir: openPlant.task_dir, force: true });
  fs.writeFileSync(path.join(openWtT22.path, "held.txt"), "held\n");
  const openKept = wt.reap({ projectDir: main, path: openWtT22.path });
  check(openKept.removed === false && openKept.reason === "uncommitted changes" && !("teardown" in openKept), `T22: an open task's kept worktree runs no teardown (${JSON.stringify(openKept)})`);
  check(!teardownRecordOf(openWtT22.path), "T22: an open task's worktree holds no record");

  const donePlant = taskLib.createTask({ repo: t22Key, title: "T22 done open", slug: "donestillopen", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: donePlant.task_dir, phaseId: 1 });
  const doneWtT22 = wt.add({ projectDir: main, taskDir: donePlant.task_dir, force: true });
  mergeInto(main, doneWtT22.branch);
  git(main, ["push", "-q", "origin", "main"]);
  const doneIdT22 = db.taskIdOf(donePlant.task_dir);
  db.appendEvent({ kind: "land", repoKey: t22Key.key, taskId: doneIdT22, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: doneWtT22.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(doneIdT22);
  fs.writeFileSync(path.join(doneWtT22.path, "held.txt"), "held\n");
  const doneKept = wt.reap({ projectDir: main, path: doneWtT22.path });
  check(doneKept.removed === false && doneKept.reason === "uncommitted changes" && !("teardown" in doneKept), `T22: a done, not-closed task's kept worktree runs no teardown (${JSON.stringify(doneKept)})`);
  check(!fs.existsSync(mark("never-ran")) && !teardownRecordOf(doneWtT22.path), "T22: nothing ran and nothing was recorded for the open or done task");

  // the held plants stay held: hand them to --force so later blocks survey a clean field
  setTeardown("true");
  for (const leftover of [keptWt, retryWt, timedWt, liveWt, openWtT22, doneWtT22]) {
    if (fs.existsSync(leftover.path)) wt.remove({ projectDir: main, path: leftover.path, force: true });
  }
  if (keptKnob === undefined) delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS; else process.env.AGENTS_TEARDOWN_TIMEOUT_MS = keptKnob;

  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
  fs.rmSync(t22Tmp, { recursive: true, force: true });
}

// --- T23: ensureTaskWorktree — the one restore path: reuse (healing), check out the surviving branch, or create ---

{
  const main = freshRepo("t23", "ensurer");
  const t23Key = require("./lib/repo").repoKey(main);
  fs.writeFileSync(path.join(main, ".env"), "E=1\n");

  // Reuse: a listed worktree whose .env copy and .tasks link were lost is healed in place
  const t23a = taskLib.createTask({ repo: t23Key, title: "Reused", slug: "reused", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const aAdded = wt.add({ projectDir: main, taskDir: t23a.task_dir, force: true });
  fs.unlinkSync(path.join(aAdded.path, ".env"));
  fs.rmSync(path.join(aAdded.path, ".tasks"), { recursive: true, force: true });
  const a = wt.ensureTaskWorktree({ projectDir: main, taskDir: t23a.task_dir });
  check(a.state === "reused" && a.path === aAdded.path, `T23: a listed worktree is reused, not recreated (${JSON.stringify(a)})`);
  check(JSON.stringify(a.env_copies) === JSON.stringify([".env"]) && fs.readFileSync(path.join(a.path, ".env"), "utf8") === "E=1\n", `T23: the lost .env copy is healed (${JSON.stringify(a.env_copies)})`);
  check(fs.lstatSync(path.join(a.path, ".tasks", path.basename(t23a.task_dir))).isSymbolicLink(), "T23: the worktree's .tasks link is healed");

  // Restored: the directory gone, the branch surviving — checked out with the env copy and both links
  const t23b = taskLib.createTask({ repo: t23Key, title: "Restored", slug: "restored", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const bAdded = wt.add({ projectDir: main, taskDir: t23b.task_dir, force: true });
  git(main, ["worktree", "remove", "--force", bAdded.path]);
  const b = wt.ensureTaskWorktree({ projectDir: main, taskDir: t23b.task_dir });
  check(b.state === "restored" && b.path === bAdded.path && b.branch === bAdded.branch, `T23: a surviving branch is checked out (${JSON.stringify(b)})`);
  check(fs.readFileSync(path.join(b.path, ".env"), "utf8") === "E=1\n", "T23: the restored worktree carries the env copy");
  check(fs.lstatSync(path.join(main, ".tasks", path.basename(t23b.task_dir))).isSymbolicLink() && fs.lstatSync(path.join(b.path, ".tasks", path.basename(t23b.task_dir))).isSymbolicLink(), "T23: the .tasks link is written on both sides");
  const bRow = db.getTask(db.taskIdOf(t23b.task_dir));
  check(bRow.worktree_path === b.path && bRow.branch === b.branch, `T23: the restored worktree is recorded on the task row (${JSON.stringify({ path: bRow.worktree_path, branch: bRow.branch })})`);

  // Created: no branch, no worktree — add()'s behavior
  const t23c = taskLib.createTask({ repo: t23Key, title: "Created", slug: "created", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const c = wt.ensureTaskWorktree({ projectDir: main, taskDir: t23c.task_dir });
  check(c.state === "created" && c.branch === `wt/${path.basename(t23c.task_dir)}` && fs.readFileSync(path.join(c.path, ".env"), "utf8") === "E=1\n", `T23: with nothing to reuse a worktree is created (${JSON.stringify(c)})`);

  // Refused: a plain directory at the path is never adopted
  const t23d = taskLib.createTask({ repo: t23Key, title: "Blocked", slug: "blocked", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const dTarget = wt.taskWorktree(t23Key, t23d.task_dir);
  fs.mkdirSync(dTarget.path, { recursive: true });
  let refused = null;
  try { wt.ensureTaskWorktree({ projectDir: main, taskDir: t23d.task_dir }); } catch (err) { refused = err; }
  check(refused && /exists but is not a worktree of this repo/.test(refused.message) && Number.isInteger(refused.exitCode),
    `T23: a non-worktree directory at the path refuses (${refused && refused.message})`);

  fs.rmSync(path.dirname(main), { recursive: true, force: true });
}

// --- T24: a done task's worktree goes once it goes quiet past the removal grace — teardown first ---

{
  const { main, key: t24Key } = repoWithOrigin("t24", "dormant");
  const { WORKTREE_GRACE_DAYS } = require("./lib/dormancy");
  const t24Tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t24-"));
  const mark = (n) => path.join(t24Tmp, n);
  const setTeardown = (cmd) => fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, repos: { [t24Key.key]: { teardown: cmd } } }));

  const plantDone = (slug) => {
    const task = taskLib.createTask({ repo: t24Key, title: `Done ${slug}`, slug, session_id: "s", phases: [{ id: 1, name: "One" }] });
    taskLib.checkPhase({ taskDir: task.task_dir, phaseId: 1 });
    const added = wt.add({ projectDir: main, taskDir: task.task_dir, force: true });
    mergeInto(main, added.branch);
    git(main, ["push", "-q", "origin", "main"]);
    const id = db.taskIdOf(task.task_dir);
    db.appendEvent({ kind: "land", repoKey: t24Key.key, taskId: id, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
    require("./lib/derive").invalidateTask(id);
    return { task, added, id };
  };
  const backdate = (taskId, days) => {
    const at = new Date(Date.now() - days * 86400000).toISOString();
    const conn = db.open();
    conn.tx(() => {
      conn.run("UPDATE events SET at = ? WHERE task_id = ?", at, taskId);
      conn.run("UPDATE checkmarks SET checked_at = ? WHERE task_id = ?", at, taskId);
    });
    db.close();
  };

  // A freshly done task (landed seconds ago) and a dormant one (grace + 1 day of quiet)
  const fresh = plantDone("fresh");
  const dormant = plantDone("dormant");
  backdate(dormant.id, WORKTREE_GRACE_DAYS + 1);

  // A dormant-but-open task: the grace alone removes nothing an unchecked phase holds
  const openTask = taskLib.createTask({ repo: t24Key, title: "Open3", slug: "open3", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const openWt = wt.add({ projectDir: main, taskDir: openTask.task_dir, force: true });
  backdate(db.taskIdOf(openTask.task_dir), WORKTREE_GRACE_DAYS + 1);

  const freshBlocker = wt.removalBlocker(main, "main", { path: fresh.added.path, branch: fresh.added.branch }, []);
  check(freshBlocker === `task ${path.basename(fresh.task.task_dir)} is done, not closed`, `T24: a freshly done task's worktree stays (${freshBlocker})`);
  const dormantBlocker = wt.removalBlocker(main, "main", { path: dormant.added.path, branch: dormant.added.branch }, []);
  check(dormantBlocker === null, `T24: the dormant done task's worktree is removable (${dormantBlocker})`);
  const openBlocker = wt.removalBlocker(main, "main", { path: openWt.path, branch: openWt.branch }, []);
  check(openBlocker === `task ${path.basename(openTask.task_dir)} is not done`, `T24: a dormant but open task's worktree stays (${openBlocker})`);

  // A live session inside keeps even the dormant one
  const occupiedBlocker = wt.removalBlocker(main, "main", { path: dormant.added.path, branch: dormant.added.branch }, [{ cwd: dormant.added.path, session_id: "live-inside-it", agent: "conductor" }]);
  check((occupiedBlocker || "").includes("runs inside it"), `T24: a live session inside keeps the dormant worktree (${occupiedBlocker})`);

  // The sweep removes the dormant one, teardown first, with its merged branch
  setTeardown(`pwd > ${mark("swept")}`);
  const dormantReal = fs.realpathSync(dormant.added.path);
  const result = wt.sweepStale(main);
  check(result.swept.some((s) => s.path === dormant.added.path && s.teardown && s.teardown.exit_code === 0), `T24: the sweep removes the dormant done worktree, teardown first (${JSON.stringify(result.swept)})`);
  check(!fs.existsSync(dormant.added.path), "T24: the dormant worktree is gone");
  check(fs.readFileSync(mark("swept"), "utf8").trim() === dormantReal, "T24: the teardown ran inside the worktree");
  check(git(main, ["branch", "--list", dormant.added.branch]) === "", "T24: the merged branch is deleted");
  check(fs.existsSync(fresh.added.path) && fs.existsSync(openWt.path), `T24: the fresh-done and open worktrees survive (${JSON.stringify(result.warnings)})`);

  // The survey (a doctor --clean) marks a dormant survivor removable
  const dormant2 = plantDone("dormant2");
  backdate(dormant2.id, WORKTREE_GRACE_DAYS + 1);
  const rows = wt.survey().filter((row) => row.path === dormant2.added.path);
  check(rows.length === 1 && rows[0].removable === true && rows[0].task_closed === false, `T24: the survey marks the dormant done worktree removable (${JSON.stringify(rows)})`);

  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
  fs.rmSync(t24Tmp, { recursive: true, force: true });
}

// --- T25: the removal rule compares against the cut's ref (origin/base), not the
// local base — a closed task's worktree born at origin's tip is removed with its
// teardown even when the local checkout sits behind origin ---

{
  const { main, key: t25Key } = repoWithOrigin("t25", "ahead");
  const t25Tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t25-"));
  const mark = (n) => path.join(t25Tmp, n);
  // Local main stays behind: one commit lands on origin only.
  git(main, ["checkout", "-q", "-b", "t25-ahead"]);
  fs.writeFileSync(path.join(main, "origin-only.txt"), "x\n");
  git(main, ["add", "origin-only.txt"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "origin only"]);
  git(main, ["push", "-q", "origin", "t25-ahead:main"]);
  git(main, ["checkout", "-q", "main"]);
  git(main, ["branch", "-q", "-D", "t25-ahead"]);
  check(git(main, ["rev-list", "--count", "main..origin/main"]) === "1", "T25: local main sits one commit behind origin");

  // A task + its worktree: the cut rides origin/main, so the branch is ahead of local main
  const made = taskLib.createTask({ repo: t25Key, title: "T25 close", slug: "t25-close", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const added = wt.add({ projectDir: main, taskDir: made.task_dir, force: true });
  check(git(added.path, ["log", "-1", "--format=%s"]) === "origin only", "T25: the worktree is born at origin's tip");

  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, repos: { [t25Key.key]: { teardown: `touch ${mark("ran")}` } } }));

  // The close's reap must remove (not refuse "unlanded" against the stale local base)
  const result = taskLib.closeTask({ taskDir: made.task_dir, repoKeyObj: { key: t25Key.key, main_root: main } });
  const w = result.worktree;
  check(result.action === "archive" && w && w.removed === true, `T25: a closed task's origin-cut worktree is removed at close (${JSON.stringify(w && w.reason)})`);
  check(w && w.teardown && w.teardown.exit_code === 0 && fs.existsSync(mark("ran")), "T25: the teardown ran before the removal");
  check(!fs.existsSync(added.path), "T25: the worktree directory is gone");
  check(git(main, ["branch", "--list", "wt/*t25-close"]) === "", `T25: the branch is deleted (${git(main, ["branch", "--list", "wt/*t25-close"])})`);

  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
  fs.rmSync(t25Tmp, { recursive: true, force: true });
}

// --- T26: a worktree removal killed at its budget heals — the forced retry at
// the full default budget completes the half-deleted tree ---

{
  const { main, key: t26Key } = repoWithOrigin("t26", "heal");
  const made = taskLib.createTask({ repo: t26Key, title: "T26 heal", slug: "t26-heal", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const added = wt.add({ projectDir: main, taskDir: made.task_dir, force: true });
  process.env.AGENTS_WORKTREE_REMOVE_TIMEOUT_MS = "1";
  let healed = null;
  try {
    healed = wt.remove({ projectDir: main, path: added.path, force: false });
  } finally {
    delete process.env.AGENTS_WORKTREE_REMOVE_TIMEOUT_MS;
  }
  check(healed && healed.removed === added.path && !fs.existsSync(added.path),
    `T26: a removal killed at its budget completes on the forced retry (${JSON.stringify(healed && { removed: healed.removed, reason: healed.reason })})`);
}

// --- T27: every engine removal writes a receipt — a worktree_removed event and
// a file in the repo's worktrees root naming path, branch, repo, actor, reason ---

{
  const { main, key: t25Key } = repoWithOrigin("t25", "receipts");
  const receiptDir = path.join(WT_ROOT, "receipts", ".removed");
  const receiptOf = (name) => path.join(receiptDir, `${name}.json`);
  const readReceipt = (name) => JSON.parse(fs.readFileSync(receiptOf(name), "utf8"));
  const removalEvents = () => db.open().all("SELECT * FROM events WHERE kind = 'worktree_removed' ORDER BY id")
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  const savedSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  // remove (the verb path): unattributed when no session runs it
  const solo = wt.add({ projectDir: main, name: "solo" });
  mergeInto(main, solo.branch);
  wt.remove({ projectDir: main, path: solo.path });
  let r = readReceipt("solo");
  check(r.kind === "worktree_removed" && r.path === solo.path && r.branch === "wt/solo"
    && r.repo === main && r.actor === "unattributed" && r.reason === "a worktree remove"
    && Number.isFinite(Date.parse(r.at)),
    `T27: remove writes the receipt with path, branch, repo, actor and reason (${JSON.stringify(r)})`);
  let ev = removalEvents().find((e) => e.detail.path === solo.path);
  check(ev && ev.repo_key === t25Key.key && ev.session_id === null && ev.detail.actor === "unattributed"
    && ev.detail.reason === "a worktree remove" && ev.detail.repo === main,
    `T27: the worktree_removed event carries the same attribution (${JSON.stringify(ev)})`);

  // remove inside a session: the actor is that session, in the file and the event
  process.env.CLAUDE_CODE_SESSION_ID = "bbbb1677-1111-4000-8000-000000001670";
  const attributed = wt.add({ projectDir: main, name: "attributed" });
  mergeInto(main, attributed.branch);
  wt.remove({ projectDir: main, path: attributed.path });
  check(readReceipt("attributed").actor === "bbbb1677-1111-4000-8000-000000001670",
    `T27: a session's removal is attributed to it (${readReceipt("attributed").actor})`);
  ev = removalEvents().find((e) => e.detail.path === attributed.path);
  check(ev && ev.session_id === "bbbb1677-1111-4000-8000-000000001670" && ev.detail.actor === "bbbb1677-1111-4000-8000-000000001670",
    `T27: the event row carries the session (${JSON.stringify(ev && { session_id: ev.session_id, actor: ev.detail.actor })})`);
  delete process.env.CLAUDE_CODE_SESSION_ID;

  // --force names itself in the reason; a caller's reason passes through (the rollback's contract)
  const forced = wt.add({ projectDir: main, name: "forced" });
  wt.remove({ projectDir: main, path: forced.path, force: true });
  check(readReceipt("forced").reason === "a worktree remove --force", `T27: a forced remove says so in the reason (${readReceipt("forced").reason})`);
  const rolled = wt.add({ projectDir: main, name: "rolled" });
  wt.remove({ projectDir: main, path: rolled.path, force: true, reason: "a start's failure rollback" });
  check(readReceipt("rolled").reason === "a start's failure rollback", `T27: a caller's reason is passed through (${readReceipt("rolled").reason})`);

  // The done recipe every removal-path leg below plants; `close` adds the
  // archive step a close performs, so the task reads closed.
  const plantDone = (slug) => {
    const task = taskLib.createTask({ repo: t25Key, title: `Done ${slug}`, slug, session_id: "s", phases: [{ id: 1, name: "One" }] });
    taskLib.checkPhase({ taskDir: task.task_dir, phaseId: 1 });
    const added = wt.add({ projectDir: main, taskDir: task.task_dir, force: true });
    mergeInto(main, added.branch);
    git(main, ["push", "-q", "origin", "main"]);
    const id = db.taskIdOf(task.task_dir);
    db.appendEvent({ kind: "land", repoKey: t25Key.key, taskId: id, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
    require("./lib/derive").invalidateTask(id);
    return { task, added };
  };
  const plantClosed = (slug) => {
    const planted = plantDone(slug);
    const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), t25Key.key);
    fs.mkdirSync(archiveBase, { recursive: true });
    fs.renameSync(planted.task.task_dir, path.join(archiveBase, path.basename(planted.task.task_dir)));
    db.setTaskDisposition({ repoKey: t25Key.key, dirName: path.basename(planted.task.task_dir), disposition: "archived" });
    return planted;
  };

  // sweepStale (a start's sweep)
  const closedForSweep = plantClosed("sweptreceipt");
  const sweep = wt.sweepStale(main);
  check(sweep.swept.some((s) => s.path === closedForSweep.added.path), `T27: the sweep removes the closed worktree (${JSON.stringify(sweep.swept)})`);
  r = readReceipt(path.basename(closedForSweep.added.path));
  check(r.reason === "a start's sweep" && r.path === closedForSweep.added.path && r.branch === closedForSweep.added.branch
    && r.repo === main && r.actor === "unattributed",
    `T27: the sweep's receipt names a start's sweep (${JSON.stringify(r)})`);
  ev = removalEvents().find((e) => e.detail.path === closedForSweep.added.path);
  check(ev && ev.detail.reason === "a start's sweep", `T27: the sweep's event names it too (${JSON.stringify(ev && ev.detail)})`);

  // cleanSurvey (a doctor --clean)
  const closedForClean = plantClosed("cleanedreceipt");
  const clean = wt.cleanSurvey();
  check(clean.removed.some((row) => row.path === closedForClean.added.path), `T27: the clean removes the closed worktree (${JSON.stringify(clean.removed.map((x) => x.path))})`);
  check(readReceipt(path.basename(closedForClean.added.path)).reason === "a doctor --clean",
    `T27: the doctor --clean receipt names its path (${JSON.stringify(readReceipt(path.basename(closedForClean.added.path)))})`);

  // closeTask (the task close teardown) — the folder still live, the close archives it
  const doneForClose = plantDone("closedreceipt");
  const closed = taskLib.closeTask({ taskDir: doneForClose.task.task_dir, repoKeyObj: t25Key });
  check(closed.action === "archive" && closed.worktree && closed.worktree.removed === true,
    `T27: the close archives the task and reaps its worktree (${JSON.stringify(closed)})`);
  r = readReceipt(path.basename(doneForClose.added.path));
  check(r.reason === "a task close" && r.branch === doneForClose.added.branch && r.repo === main,
    `T27: the close's receipt names a task close (${JSON.stringify(r)})`);
  ev = removalEvents().find((e) => e.detail.path === doneForClose.added.path);
  check(ev && ev.detail.reason === "a task close", `T27: the close's event names it too (${JSON.stringify(ev && ev.detail)})`);

  // Every receipt lives in the repo's worktrees root, never inside a removed worktree
  const receipts = fs.readdirSync(receiptDir);
  check(receipts.length > 0 && receipts.every((n) => n.endsWith(".json")),
    `T27: the receipts sit as JSON files in the repo's .removed (${JSON.stringify(receipts)})`);
  check(receiptDir === path.join(wt.worktreesRoot(), "receipts", ".removed")
    && !fs.existsSync(solo.path) && !fs.existsSync(attributed.path) && !fs.existsSync(closedForSweep.added.path),
    "T27: the receipt directory is the repo's worktrees root, and the removed worktrees are gone");
  if (savedSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = savedSessionEnv;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.on("exit", () => fs.rmSync(BASE, { recursive: true, force: true }));
process.exit(failed > 0 ? 1 : 0);
