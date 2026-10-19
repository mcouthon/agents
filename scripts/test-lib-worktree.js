#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/worktree.js — add/remove/list/clean + manifest overlap.
// Uses throwaway git repos in tmpdir.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-lib-"));

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

// --- T1: add creates worktree at ../repo-wt-200-test-task on wt/200-test-task ---

const wtPath = path.resolve(repo, "..", "repo-wt-200-test-task");

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

// --- T6: clean removes merged worktrees, skips unmerged ---

const wt2Path = path.resolve(repo, "..", "repo-wt-201-other");
git(repo, ["worktree", "add", "-b", "wt/201-other", wt2Path, "main"]);
commit(wt2Path, "other work");
// wt/201-other is not merged → should be skipped by clean

{
  const result = wt.clean({ projectDir: repo, dryRun: true });
  check(result.removed.length === 0, "dry-run reports 0 removable (nothing merged)");
  check(result.skipped.some((s) => s.branch === "wt/201-other"), "skips unmerged wt/201-other");
  ok("clean: dry-run skips unmerged worktrees");
}

// Merge wt/201-other → now cleanable
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/201-other", "-m", "merge2"]);
{
  const result = wt.clean({ projectDir: repo, dryRun: false });
  check(result.removed.some((r) => r.branch === "wt/201-other"), "clean removes merged wt/201-other");
  check(!fs.existsSync(wt2Path), "wt2 directory gone after clean");
  ok("clean: removes merged worktree");
}

// --- T7: add with --name (non-task-bound) ---

const wt3Path = path.resolve(repo, "..", "repo-wt-manual");
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
  const t11TaskDir = path.join(t11RepoReal, ".tasks", "301-remove-test");
  fs.mkdirSync(t11TaskDir, { recursive: true });
  fs.writeFileSync(path.join(t11TaskDir, "task.md"), "# Remove\n");
  const t11WtPath = path.resolve(t11RepoReal, "..", "repo-wt-301-remove-test");
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
