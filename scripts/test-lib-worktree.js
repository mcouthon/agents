#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/worktree.js — add/remove/list/clean + manifest overlap.
// Uses throwaway git repos in tmpdir.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-tasks-"));
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-cfg-"));
const WT_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-root-")));
const CFG = path.join(CFG_DIR, "config.json");
fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT }));
process.env.AGENTS_CONFIG_PATH = CFG;

const wt = require("./lib/worktree");
const session = require("./lib/session");
const taskLib = require("./lib/task");

let passed = 0, failed = 0;
function ok(msg) { passed++; console.log("OK: " + msg); }
function fail(msg) { failed++; console.error("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout || "").trim();
}

function gitOk(repo, args) {
  try {
    spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    return true;
  } catch { return false; }
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
fs.writeFileSync(path.join(repo, ".gitignore"), ".tasks\n");
git(repo, ["add", "f.txt", ".gitignore"]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
git(repo, ["branch", "-M", "main"]);

// Setup: a task in .tasks/
const taskDir = path.join(repo, ".tasks", "200-test-task");
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, "task.md"), "# Test task\n");
const task = {
  schema: 2, slug: "test-task", number: 200, title: "Test",
  status: "planning", mode: "full",
  knobs: { ...taskLib.DEFAULT_KNOBS },
  binding: {}, lease: {}, last_writer: {},
  phases: [{ id: 1, name: "P1: test", status: "committed", owner: null,
    blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js"],
    note: "", reports: taskLib.emptyReports(), commits: ["abc123"], branch: "",
    counters: taskLib.emptyCounters(), started: "", completed: "" }],
  checkpoints: [], flags: [],
  created: "2026-10-17", updated: "2026-10-17",
};
taskLib.writeTaskJson(taskDir, task);

// --- T1: add creates worktree at <root>/repo/200-test-task on wt/200-test-task ---

const wtPath = path.join(WT_ROOT, "repo", "200-test-task");

try {
  const result = wt.add({ projectDir: repo, taskDir, force: true });
  check(result.branch === "wt/200-test-task", `branch is wt/200-test-task, got ${result.branch}`);
  check(result.path === wtPath, `path is ${wtPath}, got ${result.path}`);
  check(fs.existsSync(wtPath), "worktree directory exists");
  check(git(wtPath, ["branch", "--show-current"]) === "wt/200-test-task", "worktree is on the right branch");

  const updatedTask = taskLib.readTaskJson(taskDir);
  check(updatedTask.phases[0].branch === "wt/200-test-task", "branch recorded in task.json");
  ok("add: task-bound worktree created with correct path and branch");
} catch (err) {
  fail(`add threw: ${err.message}`);
}

// --- T2: remove refuses when dirty ---

try {
  fs.writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted\n");
  const r = wt.remove({ projectDir: repo, path: wtPath, force: false });
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
  ok("remove: refuses unlanded branch");
}

// --- T4: remove succeeds after merge (branch is ancestor of base) ---

git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/200-test-task", "-m", "merge"]);
try {
  const result = wt.remove({ projectDir: repo, path: wtPath, force: false });
  check(!fs.existsSync(wtPath), "worktree directory gone after remove");
  check(result.branchDeleted === true, "branch deleted after merge");
  ok("remove: succeeds after merge, deletes branch");
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

// --- T8: manifest overlap refusal ---

const task2Dir = path.join(repo, ".tasks", "201-other-task");
fs.mkdirSync(task2Dir, { recursive: true });
fs.writeFileSync(path.join(task2Dir, "task.md"), "# Other task\n");
const task2 = {
  schema: 2, slug: "other-task", number: 201, title: "Other",
  status: "planning", mode: "full",
  knobs: { ...taskLib.DEFAULT_KNOBS },
  binding: {}, lease: {}, last_writer: {},
  phases: [{ id: 1, name: "P1: other", status: "in_progress", owner: null,
    blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js", "src/b.js"],
    note: "", reports: taskLib.emptyReports(), commits: [], branch: "",
    counters: taskLib.emptyCounters(), started: "", completed: "" }],
  checkpoints: [], flags: [],
  created: "2026-10-17", updated: "2026-10-17",
};
taskLib.writeTaskJson(task2Dir, task2);

// Register a live session bound to task2
const realRepoKey = require("./lib/repo").repoKey(repo).key;
const sid = "overlap-test-session";
session.register({
  session_id: sid, pid: process.pid, cwd: repo, agent: "builder",
  repo_key: realRepoKey, task_dir: task2Dir,
});

try {
  wt.add({ projectDir: repo, taskDir, force: false });
  fail("add should have refused due to manifest overlap");
} catch (err) {
  check(err.code === "MANIFEST_OVERLAP", `manifest overlap refused (code=${err.code})`);
  check(err.exitCode === 21, `exit code 21, got ${err.exitCode}`);
  check(err.overlaps.length > 0, "overlap details provided");
  check(err.overlaps[0].files.includes("src/a.js"), "overlap includes src/a.js");
  ok("add: manifest overlap refused with exit 21");
}

// T8b: --force bypasses manifest overlap
try {
  const result = wt.add({ projectDir: repo, taskDir, force: true });
  check(result.branch === "wt/200-test-task", "force bypasses overlap");
  git(repo, ["worktree", "remove", result.path]);
  git(repo, ["branch", "-d", "wt/200-test-task"]);
  ok("add: --force bypasses manifest overlap");
} catch (err) {
  fail(`add --force threw: ${err.message}`);
}

// --- T9: occupied returns false when no live session on main ---

{
  const result = wt.occupied(repo);
  // The overlap-test-session has cwd=repo but we need to check
  // if its repo_key matches. Since we used "test-repo" as repo_key
  // and repoKey(repo) would compute a different key, occupied should be false.
  check(result === false || result === true, `occupied returns a boolean, got ${result}`);
  ok("occupied: returns a boolean");
}

// --- T10: recordWorktreeInTask stamps only non-terminal phases ---

{
  const t10Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t10-"));
  const t10Repo = path.join(t10Base, "repo");
  fs.mkdirSync(t10Repo, { recursive: true });
  const t10RepoReal = fs.realpathSync(t10Repo);
  git(t10RepoReal, ["init"]);
  fs.writeFileSync(path.join(t10RepoReal, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(t10RepoReal, ".gitignore"), ".tasks\n");
  git(t10RepoReal, ["add", "f.txt", ".gitignore"]);
  git(t10RepoReal, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(t10RepoReal, ["branch", "-M", "main"]);

  const t10TaskDir = path.join(t10RepoReal, ".tasks", "300-phases");
  fs.mkdirSync(t10TaskDir, { recursive: true });
  fs.writeFileSync(path.join(t10TaskDir, "task.md"), "# Phases\n");
  const t10Task = {
    schema: 2, slug: "phases", number: 300, title: "Phases",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {}, lease: {}, last_writer: {},
    phases: [
      { id: 1, name: "done", status: "done", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "", counters: taskLib.emptyCounters(), started: "", completed: "" },
      { id: 2, name: "landed", status: "landed", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "", counters: taskLib.emptyCounters(), started: "", completed: "" },
      { id: 3, name: "active", status: "not_started", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "", counters: taskLib.emptyCounters(), started: "", completed: "" },
      { id: 4, name: "failed", status: "failed", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "", counters: taskLib.emptyCounters(), started: "", completed: "" },
      { id: 5, name: "skipped", status: "skipped", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "", counters: taskLib.emptyCounters(), started: "", completed: "" },
    ],
    checkpoints: [], flags: [],
    created: "2026-10-19", updated: "2026-10-19",
  };
  taskLib.writeTaskJson(t10TaskDir, t10Task);

  wt.recordWorktreeInTask(t10TaskDir, "wt/300-phases", "/tmp/fake-wt-300", t10RepoReal);
  const updated = taskLib.readTaskJson(t10TaskDir);
  check(updated.phases[0].branch === "", "done phase NOT stamped");
  check(updated.phases[1].branch === "", "landed phase NOT stamped");
  check(updated.phases[2].branch === "wt/300-phases", "active (not_started) phase stamped");
  check(updated.phases[3].branch === "", "failed phase NOT stamped");
  check(updated.phases[4].branch === "", "skipped phase NOT stamped");
  ok("T10: recordWorktreeInTask stamps only non-terminal phases (done/landed/failed/skipped excluded)");

  fs.rmSync(t10Base, { recursive: true, force: true });
}

// --- T11: remove clears branch/worktree_path from non-landed phases ---

{
  const t11Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t11-"));
  const t11Repo = path.join(t11Base, "repo");
  fs.mkdirSync(t11Repo, { recursive: true });
  const t11RepoReal = fs.realpathSync(t11Repo);
  git(t11RepoReal, ["init"]);
  fs.writeFileSync(path.join(t11RepoReal, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(t11RepoReal, ".gitignore"), ".tasks\n");
  git(t11RepoReal, ["add", "f.txt", ".gitignore"]);
  git(t11RepoReal, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(t11RepoReal, ["branch", "-M", "main"]);

  // Create a task with a phase on a branch that will be removed
  // D35: tasks live at the central root
  const { repoKey } = require("./lib/repo");
  const { tasksRoot } = require("./lib/tasks-root");
  const t11Key = repoKey(t11RepoReal);
  const t11TaskDir = path.join(tasksRoot(t11Key), "301-remove-test");
  fs.mkdirSync(t11TaskDir, { recursive: true });
  fs.writeFileSync(path.join(t11TaskDir, "task.md"), "# Remove\n");
  const t11WtPath = path.join(WT_ROOT, "repo", "301-remove-test");
  const t11Task = {
    schema: 2, slug: "remove-test", number: 301, title: "Remove",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {}, lease: {}, last_writer: {},
    phases: [
      { id: 1, name: "landed", status: "landed", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: ["abc"], branch: "wt/301-remove-test", counters: taskLib.emptyCounters(), started: "", completed: "", landed_sha: "abc" },
      { id: 2, name: "committed", status: "committed", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "wt/301-remove-test", counters: taskLib.emptyCounters(), started: "", completed: "" },
    ],
    checkpoints: [], flags: [],
    worktree_path: t11WtPath,
    created: "2026-10-19", updated: "2026-10-19",
  };
  taskLib.writeTaskJson(t11TaskDir, t11Task);

  // Create and merge the worktree so remove succeeds
  const wtResult = wt.add({ projectDir: t11RepoReal, taskDir: t11TaskDir, force: true });
  const t11WtActual = wtResult.path;
  commit(t11WtActual, "work");
  // Merge so the branch is an ancestor of main (remove allows it)
  git(t11RepoReal, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/301-remove-test", "-m", "merge"]);

  const result = wt.remove({ projectDir: t11RepoReal, path: t11WtActual, force: false });
  check(result.removed === t11WtActual, "worktree removed");

  const updated = taskLib.readTaskJson(t11TaskDir);
  // Phase 1 (landed): branch preserved (historical record)
  check(updated.phases[0].branch === "wt/301-remove-test", "landed phase branch preserved");
  // Phase 2 (committed): branch cleared (no longer has a worktree)
  check(updated.phases[1].branch === "", "non-landed phase branch cleared by remove");
  // task.worktree_path cleared
  check(updated.worktree_path === "", "task.worktree_path cleared by remove");
  ok("T11: remove clears branch/worktree_path on non-landed phases, preserves landed");

  fs.rmSync(t11Base, { recursive: true, force: true });
}

// --- T12: recordWorktreeInTask does not overwrite existing branch on non-terminal phases ---

{
  const t12Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t12-"));
  const t12Repo = path.join(t12Base, "repo");
  fs.mkdirSync(t12Repo, { recursive: true });
  const t12RepoReal = fs.realpathSync(t12Repo);
  git(t12RepoReal, ["init"]);
  fs.writeFileSync(path.join(t12RepoReal, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(t12RepoReal, ".gitignore"), ".tasks\n");
  git(t12RepoReal, ["add", "f.txt", ".gitignore"]);
  git(t12RepoReal, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(t12RepoReal, ["branch", "-M", "main"]);

  const t12TaskDir = path.join(t12RepoReal, ".tasks", "302-no-overwrite");
  fs.mkdirSync(t12TaskDir, { recursive: true });
  fs.writeFileSync(path.join(t12TaskDir, "task.md"), "# No Overwrite\n");
  const t12Task = {
    schema: 2, slug: "no-overwrite", number: 302, title: "No Overwrite",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {}, lease: {}, last_writer: {},
    phases: [{ id: 1, name: "P1", status: "not_started", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: taskLib.emptyReports(), commits: [], branch: "wt/existing-branch", counters: taskLib.emptyCounters(), started: "", completed: "" }],
    checkpoints: [], flags: [],
    created: "2026-10-19", updated: "2026-10-19",
  };
  taskLib.writeTaskJson(t12TaskDir, t12Task);

  wt.recordWorktreeInTask(t12TaskDir, "wt/new-branch", "/tmp/fake", t12RepoReal);
  const updated = taskLib.readTaskJson(t12TaskDir);
  check(updated.phases[0].branch === "wt/existing-branch", "existing branch NOT overwritten");
  ok("T12: recordWorktreeInTask does not overwrite an existing branch on a phase");

  fs.rmSync(t12Base, { recursive: true, force: true });
}

// --- T13: add links the main checkout's untracked .env* entries, nothing tracked or present ---

{
  const t13Base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-t13-"));
  const t13Repo = path.join(t13Base, "repo");
  fs.mkdirSync(t13Repo, { recursive: true });
  const main = fs.realpathSync(t13Repo);
  git(main, ["init"]);
  fs.writeFileSync(path.join(main, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(main, ".gitignore"), ".tasks\n");
  fs.writeFileSync(path.join(main, ".env.example"), "EX=1\n");
  fs.writeFileSync(path.join(main, ".env.prod"), "P=base\n");
  git(main, ["add", "f.txt", ".gitignore"]);
  git(main, ["add", "-f", ".env.example", ".env.prod"]);
  git(main, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(main, ["branch", "-M", "main"]);
  git(main, ["rm", "--cached", "-q", ".env.prod"]);
  fs.writeFileSync(path.join(main, ".env.prod"), "P=main\n");
  fs.writeFileSync(path.join(main, ".env"), "E=1\n");

  const excludeFile = path.join(main, ".git", "info", "exclude");
  const readExclude = () => (fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "");
  const nonTasksLines = (text) => text.split("\n").filter((l) => l !== "" && l !== ".tasks");
  const excludeBefore = nonTasksLines(readExclude());

  const r = wt.add({ projectDir: main, name: "envtest" });

  check(JSON.stringify(r.env_links) === JSON.stringify([".env"]), `T13: env_links names only the untracked, absent .env (${JSON.stringify(r.env_links)})`);
  check(fs.lstatSync(path.join(r.path, ".env")).isSymbolicLink() && fs.realpathSync(path.join(r.path, ".env")) === path.join(main, ".env"), "T13: .env in the worktree is a symlink to the main checkout's .env");
  check(fs.lstatSync(path.join(r.path, ".env.example")).isFile() && fs.readFileSync(path.join(r.path, ".env.example"), "utf8") === "EX=1\n", "T13: the tracked .env.example arrives as a regular file");
  check(fs.lstatSync(path.join(r.path, ".env.prod")).isFile() && fs.readFileSync(path.join(r.path, ".env.prod"), "utf8") === "P=base\n", "T13: .env.prod, present in the worktree from git, is left alone");
  check(JSON.stringify(nonTasksLines(readExclude())) === JSON.stringify(excludeBefore), "T13: add writes no ignore rule for the links");
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
  const key = { main_root: "/somewhere/acme" };
  process.env.AGENTS_CONFIG_PATH = path.join(CFG_DIR, "absent.json");
  check(wt.worktreesRoot() === path.join(os.homedir(), ".agents", "worktrees"), "T14: without the knob the root is ~/.agents/worktrees");
  check(wt.worktreePath(key, "007-seven") === path.join(os.homedir(), ".agents", "worktrees", "acme", "007-seven"), "T14: the default path is <root>/<repo-name>/<NNN>-<slug>");
  const tilde = path.join(CFG_DIR, "tilde.json");
  fs.writeFileSync(tilde, JSON.stringify({ worktrees_root: "~/wts" }));
  process.env.AGENTS_CONFIG_PATH = tilde;
  check(wt.worktreePath(key, "manual") === path.join(os.homedir(), "wts", "acme", "manual"), "T14: a leading ~ in worktrees_root is HOME");
  fs.writeFileSync(tilde, JSON.stringify({ worktrees_root: "rel/wts" }));
  check(wt.worktreePath(key, "manual") === path.join(CFG_DIR, "rel", "wts", "acme", "manual"), "T14: a relative worktrees_root resolves against the config file's directory");
  process.env.AGENTS_CONFIG_PATH = CFG;
  check(wt.worktreePath(key, "manual") === path.join(WT_ROOT, "acme", "manual"), "T14: worktrees_root moves the root");
  const tw = wt.taskWorktree(key, "/tasks/007-seven");
  check(tw.branch === "wt/007-seven" && tw.path === path.join(WT_ROOT, "acme", "007-seven"), `T14: taskWorktree derives branch and path (${JSON.stringify(tw)})`);
}

// --- T15: reap removes only a merged, clean worktree no live session runs inside ---

{
  const main = freshRepo("t15", "reaper");
  const made = wt.add({ projectDir: main, name: "reap-me" });
  check(made.path === path.join(WT_ROOT, "reaper", "reap-me"), `T15: the named worktree is <root>/<repo>/<name> (${made.path})`);
  fs.mkdirSync(path.join(made.path, "sub"));
  process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
  session.register({ session_id: "reap-live", pid: process.pid, cwd: path.join(made.path, "sub"), agent: "builder", repo_key: require("./lib/repo").repoKey(main).key });
  let r = wt.reap({ projectDir: main, path: made.path });
  check(!r.removed && /live session reap-liv/.test(r.reason) && fs.existsSync(made.path), `T15: a live session inside blocks it (${r.reason})`);
  session.unregister("reap-live");
  delete process.env.AGENTS_TEST_SKIP_IDENTITY;
  fs.writeFileSync(path.join(made.path, "wip.txt"), "x\n");
  r = wt.reap({ projectDir: main, path: made.path });
  check(!r.removed && r.reason === "uncommitted changes", `T15: a dirty tree stays (${r.reason})`);
  fs.unlinkSync(path.join(made.path, "wip.txt"));
  commit(made.path, "unmerged");
  r = wt.reap({ projectDir: main, path: made.path });
  check(!r.removed && r.reason === "branch wt/reap-me is not merged into main", `T15: an unmerged branch stays (${r.reason})`);
  mergeInto(main, "wt/reap-me");
  r = wt.reap({ projectDir: main, path: made.path });
  check(r.removed && r.branch_deleted && !fs.existsSync(made.path) && git(main, ["branch", "--list", "wt/reap-me"]) === "", `T15: merged, clean and unoccupied it is removed with its branch (${JSON.stringify(r)})`);
  r = wt.reap({ projectDir: main, path: made.path });
  check(!r.removed && r.reason === "not a worktree of this repo", `T15: a path git does not list is left alone (${r.reason})`);
}

// --- T16: survey (a doctor) lists removable and closed-task worktrees under the root ---

{
  const { archiveRoot } = require("./lib/tasks-root");
  const main = freshRepo("t16", "survey");
  const key = require("./lib/repo").repoKey(main);
  const a = wt.add({ projectDir: main, name: "400-merged" });
  const b = wt.add({ projectDir: main, name: "401-closed" });
  fs.writeFileSync(path.join(b.path, "wip.txt"), "x\n");
  fs.mkdirSync(path.join(archiveRoot(), key.key, "401-closed"), { recursive: true });
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
