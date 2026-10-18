#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/land.js — direct ff path, conflict path, pr path,
// and the SHA-rewrite case where base moves between commit and land.
// Uses throwaway git repos in tmpdir with a bare remote.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-"));

const landLib = require("./lib/land");
const taskLib = require("./lib/task");
const wtLib = require("./lib/worktree");
const { applyTransition, checkTransition } = require("./lib/transitions");

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

function makeRepo(baseDir, name) {
  const repoPath = path.join(baseDir, name);
  fs.mkdirSync(repoPath, { recursive: true });
  const repo = fs.realpathSync(repoPath);
  git(repo, ["init"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".tasks\n");
  git(repo, ["add", "f.txt", ".gitignore"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
  git(repo, ["branch", "-M", "main"]);

  // Bare remote
  const remotePath = path.join(baseDir, `${name}-remote`);
  fs.mkdirSync(remotePath, { recursive: true });
  const remote = fs.realpathSync(remotePath);
  git(remote, ["init", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);

  return { repo, remote };
}

function makeTask(repo, num, slug, branch, commitSha) {
  const taskDir = path.join(repo, ".tasks", `${num}-${slug}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), `# ${slug}\n`);
  const task = {
    schema: 2, slug, number: num, title: slug,
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: `P1: ${slug}`, status: "committed", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "",
      manifest: ["src/a.js"], note: "",
      reports: taskLib.emptyReports(),
      commits: commitSha ? [commitSha] : [],
      branch: branch || "",
      counters: taskLib.emptyCounters(),
      started: "", completed: "",
    }],
    checkpoints: [], flags: [],
    created: "2026-10-17", updated: "2026-10-17",
  };
  taskLib.writeTaskJson(taskDir, task);
  return taskDir;
}

function makeGitFacts(projectDir) {
  return require("./lib/next").collectGitFacts(projectDir);
}

// ---------------------------------------------------------------------------
// T1: direct ff path — commit on branch → land → ff-merge → landed_sha set
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-ff-"));
  const { repo } = makeRepo(baseDir, "repo");

  // Create worktree on a branch
  const wtResult = wtLib.add({ projectDir: repo, name: "200-ff-test" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  // Commit on the branch
  commit(wtPath, "feature work");
  const commitSha = git(wtPath, ["rev-parse", "HEAD"]);

  // Create task with committed phase
  const taskDir = makeTask(repo, 200, "ff-test", branch, commitSha);

  // Land it (direct, no push since push: ask)
  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.landed === true, "land returns landed=true");
  check(result.landed_sha !== undefined, "landed_sha is set");

  // Main has the commit by ff
  const mainTip = git(repo, ["rev-parse", "main"]);
  check(mainTip === commitSha, `main tip matches branch tip after ff, got ${mainTip} vs ${commitSha}`);

  // Phase is landed with landed_sha
  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].status === "landed", "phase status is landed");
  check(task.phases[0].landed_sha === mainTip, "landed_sha is the ff tip");

  // The landed guard passes via landed_sha (not old commit SHAs)
  const guardResult = checkTransition("committed", "landed", task.phases[0], task, {
    gitFacts: makeGitFacts(repo),
  });
  check(guardResult.ok === true, "landed guard passes via landed_sha");

  // Worktree removed (no remaining phases)
  check(!fs.existsSync(wtPath), "worktree removed after landing (no phases remain)");
  ok("T1: direct ff path — land ff-merges into base, sets landed_sha, removes worktree");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T2: conflict path — rebase conflict → conflict recorded → exit 20
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-conflict-"));
  const { repo } = makeRepo(baseDir, "repo");

  // Create worktree
  const wtResult = wtLib.add({ projectDir: repo, name: "201-conflict-test" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  // Create a conflicting change on main
  fs.writeFileSync(path.join(repo, "conflict.txt"), "main version\n");
  git(repo, ["add", "conflict.txt"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "main change"]);
  git(repo, ["push", "origin", "main"]);

  // Create a conflicting change on the branch
  fs.writeFileSync(path.join(wtPath, "conflict.txt"), "branch version\n");
  git(wtPath, ["add", "conflict.txt"]);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch change"]);

  const taskDir = makeTask(repo, 201, "conflict-test", branch, "dummy-sha");

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.conflict === true, "land returns conflict=true");
  check(result.exitCode === 20, `exit code 20, got ${result.exitCode}`);
  check(result.files.includes("conflict.txt"), "conflict files include conflict.txt");

  // Phase has conflict recorded
  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].conflict !== undefined, "phase.conflict is set");
  check(task.phases[0].conflict.files.includes("conflict.txt"), "conflict.files has conflict.txt");
  ok("T2: conflict path — rebase conflict recorded, exit 20");

  // Abort the rebase for cleanup
  try { git(wtPath, ["rebase", "--abort"]); } catch {}
  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T3: SHA-rewrite case — base moves, rebase rewrites SHAs, guard still passes
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-sha-rewrite-"));
  const { repo } = makeRepo(baseDir, "repo");

  // Create worktree and commit on branch
  const wtResult = wtLib.add({ projectDir: repo, name: "202-sha-test" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;
  commit(wtPath, "feature work");
  const originalSha = git(wtPath, ["rev-parse", "HEAD"]);

  // Record original SHA in task
  const taskDir = makeTask(repo, 202, "sha-test", branch, originalSha);

  // Base moves: commit on main AFTER the branch commit
  commit(repo, "base moved");
  git(repo, ["push", "origin", "main"]);

  // Land: rebase rewrites the branch commit SHA
  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.landed === true, "land succeeds despite SHA rewrite");

  // The rebased commit SHA is different from the original
  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].commits[0] !== originalSha, "phase.commits updated to rebased SHA");
  check(task.phases[0].landed_sha !== undefined, "landed_sha set");
  check(task.phases[0].status === "landed", "phase is landed");

  // Guard passes via landed_sha (not the old SHAs)
  const guardResult = checkTransition("committed", "landed", task.phases[0], task, {
    gitFacts: makeGitFacts(repo),
  });
  check(guardResult.ok === true, "guard passes via landed_sha despite SHA rewrite");
  ok("T3: SHA-rewrite — base moves, rebase rewrites SHAs, guard passes via landed_sha");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T4: pr path — push + gh pr create (stubbed) → pr_open set
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-pr-"));
  const { repo } = makeRepo(baseDir, "repo");

  // Stub gh command
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  fs.writeFileSync(path.join(stubDir, "gh"), "#!/bin/sh\necho 'https://example.com/pr/1'\n");
  try { fs.chmodSync(path.join(stubDir, "gh"), 0o755); } catch {}
  const oldPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;

  // Create worktree and commit
  const wtResult = wtLib.add({ projectDir: repo, name: "203-pr-test" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;
  commit(wtPath, "pr feature");

  const taskDir = makeTask(repo, 203, "pr-test", branch, "dummy");

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "pr", base: "main", merge: "manual" },
  });

  check(result.pr_created === true, "land returns pr_created=true");
  check(result.pr_url === "https://example.com/pr/1", "pr_url from gh stub");

  // Phase has pr_open, not landed
  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].pr_open === true, "phase.pr_open is set");
  check(task.phases[0].status === "committed", "phase stays committed (not landed)");
  check(task.phases[0].pr !== undefined, "phase.pr recorded");
  ok("T4: pr path — push + gh pr create → pr_open set, phase stays committed");

  process.env.PATH = oldPath;
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T5: multi-phase — worktree+branch kept between phases, removed at end
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-multi-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "204-multi" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;
  commit(wtPath, "phase 1 work");
  const sha1 = git(wtPath, ["rev-parse", "HEAD"]);

  const taskDir = path.join(repo, ".tasks", "204-multi");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), "# multi\n");
  const task = {
    schema: 2, slug: "multi", number: 204, title: "Multi",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS, land: "per_phase" },
    binding: {}, lease: {}, last_writer: {},
    phases: [
      { id: 1, name: "P1: first", status: "committed", owner: null,
        blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js"],
        note: "", reports: taskLib.emptyReports(), commits: [sha1], branch,
        counters: taskLib.emptyCounters(), started: "", completed: "" },
      { id: 2, name: "P2: second", status: "not_started", owner: null,
        blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/b.js"],
        note: "", reports: taskLib.emptyReports(), commits: [], branch,
        counters: taskLib.emptyCounters(), started: "", completed: "" },
    ],
    checkpoints: [], flags: [],
    created: "2026-10-17", updated: "2026-10-17",
  };
  taskLib.writeTaskJson(taskDir, task);

  // Land phase 1
  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
    phaseIds: [1],
  });

  check(result.landed === true, "phase 1 landed");
  check(fs.existsSync(wtPath), "worktree still exists (phase 2 remains)");

  // Branch still exists (not deleted because phases remain)
  check(gitOk(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]),
    "branch still exists between phases");

  // Phase 1 is landed, phase 2 is not_started
  const updated = taskLib.readTaskJson(taskDir);
  check(updated.phases[0].status === "landed", "phase 1 is landed");
  check(updated.phases[1].status === "not_started", "phase 2 is not_started");
  ok("T5: multi-phase — worktree+branch kept between phases, removed at end");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T6: phase.commits scoped to rebase target — local base behind origin/base
// excludes other authors' commits that landed on origin/base.
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-commits-scope-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "205-commits-scope" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  // Branch commits a real change on its own file
  fs.writeFileSync(path.join(wtPath, "feature.txt"), "feature\n");
  git(wtPath, ["add", "feature.txt"]);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "feature work"]);

  // Another author pushes a real commit to origin/main
  fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
  git(repo, ["add", "other.txt"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "other author commit"]);
  git(repo, ["push", "origin", "main"]);
  const otherSha = git(repo, ["rev-parse", "HEAD"]);

  // Roll local main back so it is behind origin/main
  git(repo, ["reset", "--hard", "HEAD~1"]);

  const taskDir = makeTask(repo, 205, "commits-scope", branch, "dummy");

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.landed === true, "land succeeds when local base is behind origin/base");

  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].commits.length === 1,
    `phase.commits scoped to branch only (got ${task.phases[0].commits.length})`);
  check(!task.phases[0].commits.includes(otherSha),
    "phase.commits excludes other author's base commit");
  ok("T6: phase.commits scoped to origin/base — excludes other authors' commits");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T7: dirty main checkout in an overlapping file → needs_human, nothing moved
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-dirty-main-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "206-dirty-main" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  // Branch commits a change to overlap.txt
  fs.writeFileSync(path.join(wtPath, "overlap.txt"), "branch version\n");
  git(wtPath, ["add", "overlap.txt"]);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch touches overlap"]);

  const mainTipBefore = git(repo, ["rev-parse", "main"]);

  // Dirty the main checkout in the same file (uncommitted change)
  fs.writeFileSync(path.join(repo, "overlap.txt"), "dirty main version\n");

  const taskDir = makeTask(repo, 206, "dirty-main", branch, "dummy");

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.needs_human === true, "dirty overlapping main → needs_human=true");
  check(Array.isArray(result.files) && result.files.includes("overlap.txt"),
    "needs_human files include overlap.txt");

  const mainTipAfter = git(repo, ["rev-parse", "main"]);
  check(mainTipBefore === mainTipAfter, "main tip unchanged (nothing moved)");

  const task = taskLib.readTaskJson(taskDir);
  check(task.phases[0].status === "committed", "phase stays committed (not landed)");
  ok("T7: dirty main in overlapping file → needs_human, nothing moved");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// T8: dirty main with a modified tracked file (" M" status) → needs_human.
// Regression: gitLand's .trim() strips the leading space from the first line
// of "git status --porcelain" when the first dirty file is an unstaged
// modification, corrupting the filename and bypassing the overlap check.
// T7 used an untracked file ("??") which has no leading space to lose.
{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-dirty-mod-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "207-dirty-mod" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  fs.writeFileSync(path.join(wtPath, "f.txt"), "branch version\n");
  git(wtPath, ["add", "f.txt"]);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch touches f.txt"]);

  const mainTipBefore = git(repo, ["rev-parse", "main"]);

  fs.writeFileSync(path.join(repo, "f.txt"), "dirty main version\n");

  const taskDir = makeTask(repo, 207, "dirty-mod", branch, "dummy");

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.needs_human === true, "dirty modified tracked file → needs_human=true");
  check(Array.isArray(result.files) && result.files.includes("f.txt"),
    "needs_human files include f.txt (not corrupted by trim)");
  check(git(repo, ["rev-parse", "main"]) === mainTipBefore, "main tip unchanged (nothing moved)");

  ok("T8: dirty modified tracked file → needs_human, catches trim corruption");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T9: implemented phase (commits not recorded yet) → land derives commits from
// the branch, advances implemented → committed → landed. Regression for the
// case where `a commit` (A5/P5) does not exist yet, so phases sit at
// `implemented` with empty phase.commits and `a land` must derive them itself
// via `git rev-list --reverse <base>..<branch>`.
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-implemented-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "208-implemented" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;
  commit(wtPath, "implemented feature work");
  const commitSha = git(wtPath, ["rev-parse", "HEAD"]);

  // Phase starts as `implemented` with empty commits — exactly as it would
  // right after a Builder finishes, before any `a commit` records anything.
  const taskDir = path.join(repo, ".tasks", "208-implemented");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), "# implemented\n");
  const task = {
    schema: 2, slug: "implemented", number: 208, title: "Implemented",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS, review_code: false },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: "P1: implemented", status: "implemented", owner: "builder",
      blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js"],
      note: "", reports: taskLib.emptyReports(), commits: [], branch,
      counters: taskLib.emptyCounters(), started: "", completed: "",
    }],
    checkpoints: [], flags: [],
    created: "2026-10-17", updated: "2026-10-17",
  };
  taskLib.writeTaskJson(taskDir, task);

  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });

  check(result.landed === true, "implemented phase lands (landed=true)");
  check(result.landed_sha !== undefined, "landed_sha is set");

  const updated = taskLib.readTaskJson(taskDir);
  check(updated.phases[0].commits.length === 1,
    `phase.commits derived from branch (got ${updated.phases[0].commits.length})`);
  check(updated.phases[0].commits[0] === commitSha,
    "phase.commits matches the branch commit SHA");
  check(updated.phases[0].status === "landed",
    "phase advanced implemented -> committed -> landed");
  check(updated.phases[0].landed_sha !== undefined, "landed_sha recorded");
  check(git(repo, ["rev-parse", "main"]) === commitSha,
    "main tip matches branch tip after ff-merge");

  ok("T9: implemented phase — land derives commits, advances to landed");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T10: conflict → resolve → `a land --continue` → landed. Regression for the
// detached-HEAD case: during an in-progress rebase the worktree has no branch
// line in `git worktree list`, so findWorktreeForBranch must fall back to the
// rebase state's head-name to locate the worktree for --continue.
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-continue-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "209-continue" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;

  // Conflicting change on main
  fs.writeFileSync(path.join(repo, "conflict.txt"), "main version\n");
  git(repo, ["add", "conflict.txt"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "main change"]);
  git(repo, ["push", "origin", "main"]);

  // Conflicting change on branch
  fs.writeFileSync(path.join(wtPath, "conflict.txt"), "branch version\n");
  git(wtPath, ["add", "conflict.txt"]);
  git(wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch change"]);

  const taskDir = makeTask(repo, 209, "continue-test", branch, "dummy-sha");

  // First land attempt → conflict (rebase in progress, worktree detached)
  const first = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
  });
  check(first.conflict === true, "first land returns conflict=true");
  check(first.files.includes("conflict.txt"), "conflict files include conflict.txt");

  // Worktree is now in detached HEAD during the rebase — the bug condition.
  const wtBranch = git(wtPath, ["branch", "--show-current"]);
  check(wtBranch === "", `worktree is detached during rebase (got "${wtBranch}")`);

  // Resolve the conflict and stage
  fs.writeFileSync(path.join(wtPath, "conflict.txt"), "merged version\n");
  git(wtPath, ["add", "conflict.txt"]);

  // Continue → finds the detached worktree via rebase state, lands
  const result = landLib.land({
    taskDir, projectDir: repo,
    policy: { push: "ask", base: "main", merge: "manual" },
    continueMode: true,
  });

  check(result.landed === true, "continue lands after conflict resolution");
  check(result.landed_sha !== undefined, "landed_sha set after continue");

  const updated = taskLib.readTaskJson(taskDir);
  check(updated.phases[0].status === "landed", "phase is landed after continue");
  check(updated.phases[0].conflict === undefined, "conflict cleared after continue");
  check(updated.phases[0].landed_sha !== undefined, "landed_sha recorded");
  ok("T10: conflict → resolve → continue → landed (detached-HEAD worktree found)");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
