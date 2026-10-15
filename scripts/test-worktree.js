#!/usr/bin/env node
// Tests for scripts/worktree.js -- run against a throwaway git repo in tmpdir.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WORKTREE_JS = path.join(__dirname, "worktree.js");

let passed = 0;
let failed = 0;

function ok(msg) {
  passed++;
  console.log(`  ok - ${msg}`);
}

function fail(msg) {
  failed++;
  console.error(`  FAIL - ${msg}`);
}

function check(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

/** Run worktree.js with cwd=<dir>; returns { status, stdout, stderr }. */
function wt(dir, args) {
  const r = spawnSync("node", [WORKTREE_JS, ...args], { cwd: dir, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Run git in <repo>; throws on non-zero exit. */
function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

/** Branch a worktree currently has checked out. */
function currentBranch(wtPath) {
  return git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function test(name, fn) {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (e) {
    fail(`unexpected error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Temp repo setup -- main branch forced so status/clean's merge detection has
// a stable base regardless of the contributor's init.defaultBranch.
// ---------------------------------------------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-test-"));
const repoPath = path.join(base, "repo");
fs.mkdirSync(repoPath, { recursive: true });
// Resolve the tmpdir symlink (macOS /var/folders -> /private/var/folders) so
// expected paths match what `git rev-parse --show-toplevel` reports.
const repo = fs.realpathSync(repoPath);
git(repo, ["init"]);
fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
git(repo, ["add", "f.txt"]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
git(repo, ["branch", "-M", "main"]);
fs.mkdirSync(path.join(repo, ".tasks", "124-test-task"), { recursive: true });
fs.writeFileSync(path.join(repo, ".tasks", "124-test-task", "task.md"), "# Test task\n");

const repoWt = (branch) =>
  path.resolve(repo, "..", `repo-${branch.replace(/\//g, "-")}`);

function removeWorktree(wtPath, force = false) {
  git(repo, force ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath]);
}

test("T0: bare invocation prints usage including status and clean", () => {
  const r = wt(repo, []);
  check(r.status === 0, `exit 0, got ${r.status}`);
  check(r.stderr.includes("status"), "usage mentions status");
  check(r.stderr.includes("clean"), "usage mentions clean");
});

test("T1: --print-path emits exactly one bare path on stdout, hints on stderr", () => {
  const r = wt(repo, ["add", "wt/t1", "--print-path"]);
  const expected = repoWt("wt/t1");
  check(r.status === 0, `exit 0, got ${r.status}`);
  const lines = r.stdout.trim().split("\n");
  check(lines.length === 1, `stdout is one line, got ${lines.length}`);
  check(lines[0] === expected, `stdout is the bare path ${expected}, got "${lines[0]}"`);
  check(r.stderr.includes("Worktree created at"), "stderr carries the human hints");
  check(fs.existsSync(expected), "worktree directory exists");
  check(currentBranch(expected) === "wt/t1", "worktree is on branch wt/t1");
  removeWorktree(expected);
});

test("T1b: add accepts an explicit [path] positional with flags after it", () => {
  const explicitPath = path.join(base, "explicit-t1b");
  const r = wt(repo, ["add", "wt/t1b", explicitPath, "--print-path"]);
  check(r.status === 0, `exit 0, got ${r.status}`);
  check(r.stdout.trim() === explicitPath, `stdout is the explicit path, got "${r.stdout.trim()}"`);
  check(currentBranch(explicitPath) === "wt/t1b", "worktree is on branch wt/t1b");
  removeWorktree(explicitPath);
});

test("T2: add + remove roundtrip", () => {
  const wtPath = repoWt("wt/t2");
  const added = wt(repo, ["add", "wt/t2"]);
  check(added.status === 0, `add exits 0, got ${added.status}`);
  check(fs.existsSync(wtPath), "worktree directory exists after add");
  check(worktreeListIncludes(wtPath), "git worktree list shows the worktree");

  const removed = wt(repo, ["remove", wtPath]);
  check(removed.status === 0, `remove exits 0, got ${removed.status}`);
  check(!fs.existsSync(wtPath), "worktree directory gone after remove");
  check(!worktreeListIncludes(wtPath), "git worktree list no longer shows it");
});

function worktreeListIncludes(wtPath) {
  return git(repo, ["worktree", "list"]).includes(wtPath);
}

test("T3: --task 999 with no matching task dir falls back to wt/999-unnamed", () => {
  const r = wt(repo, ["add", "--task", "999", "--print-path"]);
  const wtPath = repoWt("wt/999-unnamed");
  check(r.status === 0, `exit 0, got ${r.status}`);
  check(r.stdout.trim() === wtPath, `path is ${wtPath}, got "${r.stdout.trim()}"`);
  check(currentBranch(wtPath) === "wt/999-unnamed", "branch is wt/999-unnamed");
  removeWorktree(wtPath);
});

test("T4: --auto generates wt/auto-<timestamp> branch", () => {
  const r = wt(repo, ["add", "--auto", "--print-path"]);
  check(r.status === 0, `exit 0, got ${r.status}`);
  const wtPath = r.stdout.trim();
  check(/^wt\/auto-\d{8}-\d{6}$/.test(currentBranch(wtPath)), `branch is wt/auto-<timestamp>, got "${currentBranch(wtPath)}"`);
  removeWorktree(wtPath);
});

test("T5: clean with no merged worktrees is a no-op exit 0", () => {
  const wtPath = repoWt("wt/unmerged");
  const added = wt(repo, ["add", "wt/unmerged"]);
  check(added.status === 0, `add exits 0, got ${added.status}`);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-m", "wip"]);

  const r = wt(repo, ["clean"]);
  check(r.status === 0, `clean exits 0, got ${r.status}`);
  check(r.stdout.includes("No stale worktrees"), "reports no stale worktrees");
  check(fs.existsSync(wtPath), "unmerged worktree is untouched");
  removeWorktree(wtPath);
});

test("T6: --task 124 names the branch wt/124-test-task from .tasks/124-test-task", () => {
  const r = wt(repo, ["add", "--task", "124", "--print-path"]);
  const wtPath = repoWt("wt/124-test-task");
  check(r.status === 0, `exit 0, got ${r.status}`);
  check(r.stdout.trim() === wtPath, `path is ${wtPath}, got "${r.stdout.trim()}"`);
  check(currentBranch(wtPath) === "wt/124-test-task", "branch is wt/124-test-task");
});

test("T6b: --task combines with an explicit [path] positional", () => {
  const explicitPath = path.join(base, "explicit-t6b");
  const r = wt(repo, ["add", "--task", "888", explicitPath, "--print-path"]);
  check(r.status === 0, `exit 0, got ${r.status}`);
  check(r.stdout.trim() === explicitPath, `stdout is the explicit path, got "${r.stdout.trim()}"`);
  check(currentBranch(explicitPath) === "wt/888-unnamed", "branch is wt/888-unnamed");
  removeWorktree(explicitPath);
});

test("T7: status shows the task association and main checkout", () => {
  const r = wt(repo, ["status"]);
  check(r.status === 0, `exit 0, got ${r.status}`);
  const wtPath = repoWt("wt/124-test-task");
  check(r.stdout.includes(wtPath), "status lists the 124 worktree path");
  check(r.stdout.includes("124-test-task"), "TASK column shows 124-test-task");
  check(r.stdout.includes("(main checkout)"), "main checkout row is labeled");
});

test("T8: status marks a merged-branch worktree as merged (stale)", () => {
  const wtPath = repoWt("wt/merged-wt");
  const added = wt(repo, ["add", "wt/merged-wt"]);
  check(added.status === 0, `add exits 0, got ${added.status}`);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-m", "wip"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/merged-wt", "-m", "merge"]);

  const r = wt(repo, ["status"]);
  check(r.status === 0, `exit 0, got ${r.status}`);
  const mergedRow = r.stdout.split("\n").find((l) => l.includes(wtPath));
  check(mergedRow !== undefined, "status lists the merged worktree");
  check(mergedRow.includes("merged (stale)"), `merged row is flagged, got "${mergedRow}"`);
});

test("T9: clean without --force skips stale worktrees in non-interactive mode", () => {
  const r = wt(repo, ["clean"]);
  check(r.status === 0, `clean exits 0, got ${r.status}`);
  check(r.stderr.includes("--force"), "suggests re-running with --force");
  check(fs.existsSync(repoWt("wt/merged-wt")), "merged worktree survives");
  check(fs.existsSync(repoWt("wt/124-test-task")), "124 worktree survives");
});

test("T10: clean --force removes merged-branch worktrees", () => {
  const r = wt(repo, ["clean", "--force"]);
  check(r.status === 0, `clean exits 0, got ${r.status}`);
  check(r.stdout.includes("Removed worktree"), "reports removals");
  check(!fs.existsSync(repoWt("wt/merged-wt")), "merged worktree removed");
  check(!fs.existsSync(repoWt("wt/124-test-task")), "124 worktree removed");
});

test("T11: clean skips a merged-but-dirty worktree even with --force", () => {
  const wtPath = repoWt("wt/dirty");
  const added = wt(repo, ["add", "wt/dirty"]);
  check(added.status === 0, `add exits 0, got ${added.status}`);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-m", "wip"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "merge", "wt/dirty", "-m", "merge"]);
  fs.writeFileSync(path.join(wtPath, "uncommitted.txt"), "local work\n");

  const r = wt(repo, ["clean", "--force"]);
  check(r.status === 0, `clean exits 0, got ${r.status}`);
  check(r.stderr.includes("uncommitted"), "warns about uncommitted changes");
  check(fs.existsSync(wtPath), "dirty worktree is not removed");
  removeWorktree(wtPath, true);
});

fs.rmSync(base, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
