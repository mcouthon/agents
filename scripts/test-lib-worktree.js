#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/worktree.js — add/remove/list/clean/reap/survey and
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
  check(!fs.existsSync(path.join(wtPath, ".tasks")), "the worktree gets no .tasks link");

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

// --- T6: clean removes merged worktrees, skips unmerged, under the old sibling path and the root alike ---

const wt2Path = path.resolve(repo, "..", "repo-wt-201-other");
git(repo, ["worktree", "add", "-b", "wt/201-other", wt2Path, "main"]);
commit(wt2Path, "other work");
const wt2bPath = wt.add({ projectDir: repo, name: "202-rooted" }).path;
commit(wt2bPath, "rooted work");
// neither branch is merged → both skipped by clean

{
  const result = wt.clean({ projectDir: repo, dryRun: true });
  check(result.removed.length === 0, "dry-run reports 0 removable (nothing merged)");
  check(result.skipped.some((s) => s.branch === "wt/201-other"), "skips unmerged wt/201-other");
  check(result.skipped.some((s) => s.branch === "wt/202-rooted"), "skips unmerged wt/202-rooted");
  ok("clean: dry-run skips unmerged worktrees");
}

git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/201-other", "-m", "merge2"]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/202-rooted", "-m", "merge3"]);
{
  const result = wt.clean({ projectDir: repo, dryRun: false });
  check(result.removed.some((r) => r.branch === "wt/201-other"), "clean removes merged wt/201-other at the old sibling path");
  check(result.removed.some((r) => r.branch === "wt/202-rooted"), "clean removes merged wt/202-rooted under the root");
  check(!fs.existsSync(wt2Path) && !fs.existsSync(wt2bPath), "both directories gone after clean");
  check(git(repo, ["branch", "--list", "wt/202-rooted"]) === "", "clean deletes the merged branch");
  ok("clean: removes merged worktrees across both roots");
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

// --- T9: occupied returns false when no live session on main ---

{
  const result = wt.occupied(repo);
  check(result === false || result === true, `occupied returns a boolean, got ${result}`);
  ok("occupied: returns a boolean");
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

// --- T13: add links the main checkout's untracked .env* entries, nothing tracked or present ---

{
  const t13Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t13-"));
  const t13Repo = path.join(t13Base, "repo");
  fs.mkdirSync(t13Repo, { recursive: true });
  const main = fs.realpathSync(t13Repo);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(main, ".env.example"), "EX=1\n");
  fs.writeFileSync(path.join(main, ".env.prod"), "P=base\n");
  git(main, ["add", "f.txt"]);
  git(main, ["add", "-f", ".env.example", ".env.prod"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
  git(main, ["rm", "--cached", "-q", ".env.prod"]);
  fs.writeFileSync(path.join(main, ".env.prod"), "P=main\n");
  fs.writeFileSync(path.join(main, ".env"), "E=1\n");

  const r = wt.add({ projectDir: main, name: "envtest" });

  check(JSON.stringify(r.env_links) === JSON.stringify([".env"]), `T13: env_links names only the untracked, absent .env (${JSON.stringify(r.env_links)})`);
  check(fs.lstatSync(path.join(r.path, ".env")).isSymbolicLink() && fs.realpathSync(path.join(r.path, ".env")) === path.join(main, ".env"), "T13: .env in the worktree is a symlink to the main checkout's .env");
  check(fs.lstatSync(path.join(r.path, ".env.example")).isFile() && fs.readFileSync(path.join(r.path, ".env.example"), "utf8") === "EX=1\n", "T13: the tracked .env.example arrives as a regular file");
  check(fs.lstatSync(path.join(r.path, ".env.prod")).isFile() && fs.readFileSync(path.join(r.path, ".env.prod"), "utf8") === "P=base\n", "T13: .env.prod, present in the worktree from git, is left alone");
  check(JSON.stringify(wt.linkEnvFiles(main, r.path)) === "[]", "T13: linking a second time links nothing");

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
  check(ra && ra.removable && !ra.task_closed && ra.clean === `a worktree clean --repo ${main}`, `T16: the merged clean one is removable with its clean line (${JSON.stringify(ra)})`);
  check(rb && !rb.removable && rb.task_closed && rb.reason === "uncommitted changes", `T16: the closed task's dirty one stays with its reason (${JSON.stringify(rb)})`);
  check(wt.surveyLine(ra) === `${a.path} [wt/400-merged]: removable; run: a worktree clean --repo ${main}`, `T16: the removable line (${wt.surveyLine(ra)})`);
  check(wt.surveyLine(rb) === `${b.path} [wt/401-closed]: task 401-closed is closed; stays: uncommitted changes`, `T16: the closed-task line (${wt.surveyLine(rb)})`);

  const A = path.join(__dirname, "bin", "a");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-home-"));
  const env = { ...process.env, HOME: home };
  const docJson = spawnSync(process.execPath, [A, "doctor", "--json"], { encoding: "utf8", env, cwd: main });
  let doc = null;
  try { doc = JSON.parse(docJson.stdout); } catch {}
  const listed = doc && Array.isArray(doc.worktrees) ? mine(doc.worktrees).map((row) => row.path).sort() : null;
  check(JSON.stringify(listed) === JSON.stringify([a.path, b.path].sort()), `T16: a doctor --json carries the rows (${JSON.stringify(listed)}; ${docJson.stderr.slice(-300)})`);
  const docText = spawnSync(process.execPath, [A, "doctor"], { encoding: "utf8", env, cwd: main });
  check(docText.stderr.includes(`worktree: ${wt.surveyLine(ra)}\n`) && docText.stderr.includes(`worktree: ${wt.surveyLine(rb)}\n`), `T16: a doctor prints one line per row (${docText.stderr.slice(-600)})`);
  const cleaned = spawnSync(process.execPath, [A, "worktree", "clean", "--repo", main], { encoding: "utf8", env, cwd: os.tmpdir() });
  check(cleaned.status === 0 && !fs.existsSync(a.path) && fs.existsSync(b.path) && fs.existsSync(c.path), `T16: the printed clean line removes the removable one only (${cleaned.status}: ${cleaned.stderr})`);
}

// --- T17: a worktree holding task notes under a real .tasks stays (clean skips, remove refuses, doctor names it) ---

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

  const cleaned = wt.clean({ projectDir: main });
  const skipped = cleaned.skipped.find((s) => s.path === added.path);
  check(!!skipped && /holds task notes in \.tasks\/015-p/.test(skipped.reason) && fs.existsSync(added.path),
    `T17: clean skips the worktree with its reason (${JSON.stringify(skipped)})`);

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
  const warns = ((doc && doc.warnings) || []).join("\n");
  check(warns.includes("015-p"), `T17: a doctor warns for the worktree's stray .tasks (${warns.slice(0, 300)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
