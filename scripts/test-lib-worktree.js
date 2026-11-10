#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/worktree.js — add/remove/list/reap/survey/sweep and
// the worktree record on the task's row. Uses throwaway git repos in tmpdir.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-tasks-"));
process.env.AGENTS_DB = path.join(path.dirname(process.env.AGENTS_TASKS_ROOT), "agents.db");
const WT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-home-"));
process.env.HOME = WT_HOME;
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-cfg-"));
const WT_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-root-")));
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
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-test-"));
const repoPath = path.join(baseDir, "repo");
fs.mkdirSync(repoPath, { recursive: true });
const repo = fs.realpathSync(repoPath);
git(repo, ["init"]);
fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
git(repo, ["add", "f.txt"]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
git(repo, ["branch", "-M", "main"]);
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
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `agents-wt-lib-${tag}-`)), name || "repo");
  fs.mkdirSync(dir);
  const main = fs.realpathSync(dir);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, ".gitignore"), ".tasks\n");
  git(main, ["add", ".gitignore"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
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

// --- T16: survey (a doctor) lists removable and closed-task worktrees under the root ---

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
  const mine = (rows) => rows.filter((row) => row.path.startsWith(path.join(WT_ROOT, "survey") + path.sep));
  const rows = mine(wt.survey());
  const ra = rows.find((row) => row.path === a.path);
  const rb = rows.find((row) => row.path === b.path);
  check(rows.length === 2 && !rows.some((row) => row.path === c.path), `T16: only the removable and the closed-task worktrees are listed (${JSON.stringify(rows)})`);
  check(ra && ra.removable && !ra.task_closed && ra.clean === `a doctor --clean`, `T16: the merged clean one is removable with its clean line (${JSON.stringify(ra)})`);
  check(rb && !rb.removable && rb.task_closed && rb.reason === "uncommitted changes", `T16: the closed task's dirty one stays with its reason (${JSON.stringify(rb)})`);
  check(wt.surveyLine(ra) === `${a.path} [wt/400-merged]: removable; run: a doctor --clean`, `T16: the removable line (${wt.surveyLine(ra)})`);
  check(wt.surveyLine(rb) === `${b.path} [wt/401-closed]: task 401-closed is closed; stays: uncommitted changes`, `T16: the closed-task line (${wt.surveyLine(rb)})`);

  const A = path.join(__dirname, "bin", "a");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-home-"));
  const env = { ...process.env, HOME: home };
  const docJson = spawnSync(process.execPath, [A, "doctor", "--json"], { encoding: "utf8", env, cwd: main });
  let doc = null;
  try { doc = JSON.parse(docJson.stdout); } catch {}
  const rowsOut = doc && doc.info && Array.isArray(doc.info.worktrees) ? doc.info.worktrees : null;
  const listed = rowsOut ? mine(rowsOut).map((row) => row.path).sort() : null;
  check(JSON.stringify(listed) === JSON.stringify([a.path, b.path].sort()), `T16: a doctor --json carries the rows (${JSON.stringify(listed)}; ${docJson.stderr.slice(-300)})`);
  const docText = spawnSync(process.execPath, [A, "doctor", "--verbose"], { encoding: "utf8", env, cwd: main });
  check(docText.stderr.includes(`worktree: ${wt.surveyLine(ra)}\n`) && docText.stderr.includes(`worktree: ${wt.surveyLine(rb)}\n`), `T16: a doctor --verbose prints one line per row (${docText.stderr.slice(-600)})`);
  const cleaned = spawnSync(process.execPath, [A, "doctor", "--clean"], { encoding: "utf8", env, cwd: os.tmpdir() });
  check(!fs.existsSync(a.path) && fs.existsSync(b.path) && fs.existsSync(c.path), `T16: a doctor --clean removes the removable one only (${cleaned.status}: ${cleaned.stderr.slice(-200)})`);
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

// --- T18: the one removal rule — done/closed worktree is removable; open task stays; non-task keeps merged leg ---

function repoWithOrigin(tag, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `agents-wt-lib-${tag}-`));
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
  check(doneBlocker === null, `T18: the done task's worktree is removable (${doneBlocker})`);

  const openBlocker = wt.removalBlocker(main, "main", { path: openWt.path, branch: openWt.branch }, []);
  check(openBlocker === `task ${path.basename(openTask.task_dir)} is not done`, `T18: the open task's worktree is kept (${openBlocker})`);

  // A closed task's worktree is removable even when the branch is not merged
  const closedTask = taskLib.createTask({ repo: t18Key, title: "Closed", slug: "closed", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const closedWt = wt.add({ projectDir: main, taskDir: closedTask.task_dir, force: true });
  db.setTaskDisposition({ repoKey: t18Key.key, dirName: path.basename(closedTask.task_dir), disposition: "archived" });
  const closedBlocker = wt.removalBlocker(main, "main", { path: closedWt.path, branch: closedWt.branch }, []);
  check(closedBlocker === null, `T18: the closed task's worktree is removable (${closedBlocker})`);

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

// --- T21: sweepStale removes done, clean, unoccupied worktrees ---

{
  const { main, key: t21Key } = repoWithOrigin("t21", "sweep");
  // A done task's worktree (removable)
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
  check(result.swept.some((s) => s.path === doneWt.path), `T21: sweep removes the done worktree (${JSON.stringify(result.swept)})`);
  check(!result.swept.some((s) => s.path === openWt.path), `T21: sweep keeps the open task's worktree (${JSON.stringify(result.swept)})`);
  check(!fs.existsSync(doneWt.path), "T21: the done worktree is gone");
  check(fs.existsSync(openWt.path), "T21: the open worktree stays");
}

// --- T22: the teardown command runs before a worktree is removed, on every removal path ---

{
  const { main, key: t22Key } = repoWithOrigin("t22", "teardown");
  const t22Tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t22-"));
  const mark = (n) => path.join(t22Tmp, n);
  const parseDump = (p) => {
    const env = {};
    for (const entry of fs.readFileSync(p, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  };

  // remove() runs the command with cwd in the worktree, before the removal, in the clean-base env
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, teardown: { command: `pwd > ${mark("ran")}; env -0 > ${mark("env-dump")}` } }));
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
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, teardown: { command: `pwd > ${mark("ran-fail")}; exit 1` } }));
  const failing = wt.add({ projectDir: main, name: "teardown-fail" });
  commit(failing.path, "work");
  mergeInto(main, failing.branch);
  const removedFail = wt.remove({ projectDir: main, path: failing.path, force: false });
  check(removedFail.removed === failing.path && !fs.existsSync(failing.path), "T22: a failing teardown never blocks the removal");
  check(removedFail.teardown && removedFail.teardown.exit_code === 1, `T22: the failure is carried in the result (${JSON.stringify(removedFail.teardown)})`);

  // --force (the failed-start rollback path) still runs it
  const forced = wt.add({ projectDir: main, name: "teardown-force" });
  const removedForced = wt.remove({ projectDir: main, path: forced.path, force: true });
  check(removedForced.removed === forced.path, "T22: a forced remove removes the unmerged worktree");
  check(fs.existsSync(mark("ran-fail")), "T22: the forced remove (the rollback path) runs the teardown command too");

  // the repos override wins; "" opts out
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, teardown: { command: "exit 1", repos: { [t22Key.key]: `pwd > ${mark("override")}` } } }));
  const over = wt.add({ projectDir: main, name: "teardown-over" });
  commit(over.path, "work");
  mergeInto(main, over.branch);
  const removedOver = wt.remove({ projectDir: main, path: over.path, force: false });
  check(removedOver.teardown && removedOver.teardown.exit_code === 0 && fs.existsSync(mark("override")), "T22: the repos override runs in place of the default");

  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, teardown: { command: `pwd > ${mark("optout")}`, repos: { [t22Key.key]: "" } } }));
  const out = wt.add({ projectDir: main, name: "teardown-out" });
  commit(out.path, "work");
  mergeInto(main, out.branch);
  const removedOut = wt.remove({ projectDir: main, path: out.path, force: false });
  check(removedOut.removed === out.path && !fs.existsSync(mark("optout")) && !("teardown" in removedOut), "T22: an override of \"\" opts out entirely");

  // the sweep path runs it too
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, teardown: { command: `pwd > ${mark("swept")}` } }));
  const doneTask = taskLib.createTask({ repo: t22Key, title: "DoneT22", slug: "donet22", session_id: "s", phases: [{ id: 1, name: "One" }] });
  taskLib.checkPhase({ taskDir: doneTask.task_dir, phaseId: 1 });
  const doneWt = wt.add({ projectDir: main, taskDir: doneTask.task_dir, force: true });
  const doneReal = fs.realpathSync(doneWt.path);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", doneWt.branch, "-m", "merge"]);
  git(main, ["push", "-q", "origin", "main"]);
  const doneId = db.taskIdOf(doneTask.task_dir);
  db.appendEvent({ kind: "land", repoKey: t22Key.key, taskId: doneId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: doneWt.branch, head: git(main, ["rev-parse", "HEAD"]), pushed: true, pr_url: null }) });
  require("./lib/derive").invalidateTask(doneId);
  const sweepResult = wt.sweepStale(main);
  check(sweepResult.swept.some((s) => s.path === doneWt.path), `T22: sweep removes the done worktree (${JSON.stringify(sweepResult.swept)})`);
  check(fs.readFileSync(mark("swept"), "utf8").trim() === doneReal, "T22: the sweep path runs the teardown command too");

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
