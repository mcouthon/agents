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
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-tasks-"));
process.env.AGENTS_LOGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-logs-"));
process.env.AGENTS_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-db-")), "agents.db");

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

const PASSING_RUN = [{ cmd: "true", exit: 0, summary: "ok" }];

// The reports a phase carries once reviewed, built, tested and code-reviewed; each part can be left out.
function evidence({ plan = true, tests = true, code = true } = {}) {
  const reports = taskLib.emptyReports();
  if (plan) reports.reviewer = { kind: "plan", verdict: "pass", issues: [], summary: "plan ok" };
  if (tests) {
    reports.builder = { files_touched: [], verification: PASSING_RUN, deviations: [], summary: "built" };
    reports.tests = { verification: PASSING_RUN };
  }
  if (code) reports.code_review = { kind: "code", verdict: "pass", issues: [], summary: "code ok" };
  return reports;
}

function makeTask(repo, num, slug, branch, commitSha, reports) {
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
      reports: reports || evidence(),
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
        note: "", reports: evidence(), commits: [sha1], branch,
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
// T9: an implemented phase with recorded commits on a branch: land re-derives
// the commits after the rebase and advances implemented → committed → landed.
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-implemented-"));
  const { repo } = makeRepo(baseDir, "repo");

  const wtResult = wtLib.add({ projectDir: repo, name: "208-implemented" });
  const wtPath = wtResult.path;
  const branch = wtResult.branch;
  commit(wtPath, "implemented feature work");
  const commitSha = git(wtPath, ["rev-parse", "HEAD"]);

  // The phase is `implemented` with its commits recorded; after the rebase land
  // re-derives them from the branch and advances it to committed, then landed.
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
      note: "", reports: evidence(), commits: [commitSha], branch,
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

// ---------------------------------------------------------------------------
// T11: land errors with phase id + fix when branch does not exist
// ---------------------------------------------------------------------------

{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-stale-"));
  const { repo } = makeRepo(baseDir, "repo");

  // Create a task with a committed phase pointing at a branch that doesn't exist
  const taskDir = path.join(repo, ".tasks", "205-stale-branch");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), "# Stale\n");
  const task = {
    schema: 2, slug: "stale-branch", number: 205, title: "Stale",
    status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 7, name: "P7: stale", status: "committed", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js"],
      note: "", reports: evidence(), commits: ["abc"],
      branch: "wt/deleted-branch",
      counters: taskLib.emptyCounters(), started: "", completed: "",
    }],
    checkpoints: [], flags: [],
    created: "2026-10-19", updated: "2026-10-19",
  };
  taskLib.writeTaskJson(taskDir, task);

  let caught = null;
  try {
    landLib.land({
      taskDir, projectDir: repo,
      policy: { push: "ask", base: "main", merge: "manual" },
    });
  } catch (err) {
    caught = err;
  }

  check(caught !== null, "land throws when branch does not exist");
  check(caught.code === "BRANCH_NOT_FOUND", `error code is BRANCH_NOT_FOUND, got ${caught.code}`);
  check(caught.message.includes("phase 7"), "error message includes the phase id");
  check(caught.message.includes("wt/deleted-branch"), "error message includes the branch name");
  check(caught.message.includes("a worktree add --task"), "error message includes the fix (a worktree add --task)");
  check(caught.message.includes("clear phase.branch"), "error message includes the fix (clear phase.branch)");
  ok("T11: land errors with phase id + fix when branch does not exist (BRANCH_NOT_FOUND)");

  fs.rmSync(baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T12-T24: landing checks the evidence first, and a phase already on base lands
// with no merge, push or PR.
// ---------------------------------------------------------------------------

const { landRefusal } = require("./lib/transitions");
const { persistReport } = require("./lib/report");

const ASK = { push: "ask", base: "main", merge: "manual" };
let evidenceNum = 300;

function phaseSpec(id, overrides) {
  return {
    id, name: `P${id}: work`, status: "committed", owner: null,
    blocked_by: [], parallel_group: "", plan_path: "", manifest: ["src/a.js"],
    note: "", reports: evidence(), commits: [], branch: "",
    counters: taskLib.emptyCounters(), started: "", completed: "",
    ...overrides,
  };
}

function writeTask(repo, phases, { mode = "full", knobs = {} } = {}) {
  const num = ++evidenceNum;
  const taskDir = path.join(repo, ".tasks", `${num}-evidence`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), "# evidence\n");
  taskLib.writeTaskJson(taskDir, {
    schema: 2, slug: "evidence", number: num, title: "Evidence", status: "in_progress", mode,
    knobs: { ...taskLib.DEFAULT_KNOBS, ...knobs }, binding: {}, lease: {}, last_writer: {},
    phases, checkpoints: [], flags: [], created: "2026-10-24", updated: "2026-10-24",
  });
  return taskDir;
}

function catchLand(opts) {
  try { landLib.land(opts); } catch (err) { return err; }
  return null;
}

function catchResult(opts) {
  try { return { value: landLib.land(opts) }; } catch (error) { return { error }; }
}

function onBranchFixture(name) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-land-${name}-`));
  const { repo, remote } = makeRepo(baseDir, "repo");
  const wt = wtLib.add({ projectDir: repo, name: `${name}-wt` });
  commit(wt.path, "feature work");
  return { baseDir, repo, remote, wtPath: wt.path, branch: wt.branch, sha: git(wt.path, ["rev-parse", "HEAD"]) };
}

function onBaseFixture(name) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-land-${name}-`));
  const { repo, remote } = makeRepo(baseDir, "repo");
  commit(repo, "work committed on main");
  return { baseDir, repo, remote, sha: git(repo, ["rev-parse", "HEAD"]) };
}

// T12: a committed phase with no code review is refused before anything moves
{
  const f = onBranchFixture("t12");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidence({ code: false }) })]);
  const mainBefore = git(f.repo, ["rev-parse", "main"]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "LAND_EVIDENCE" && err.message === "land refused for phase 1: missing code review. To proceed: spawn a Reviewer on phase 1 for the code review.", `T12: refusal names the missing code review and how to get it (${err && err.message})`);
  check(taskLib.readTaskJson(taskDir).phases[0].status === "committed" && git(f.repo, ["rev-parse", "main"]) === mainBefore && fs.existsSync(f.wtPath), "T12: the phase stays committed, main does not move and the worktree is kept");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T13: a phase with nothing on record is refused for all four items, in order
{
  const f = onBranchFixture("t13");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [], reports: taskLib.emptyReports() })]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  const want = "land refused for phase 1: missing plan review, tests, code review, commits. To proceed: ask the user: a plan review is recorded only before the build; spawn a Builder on phase 1 whose report lists each verification command with exit 0; spawn a Reviewer on phase 1 for the code review; spawn a Committer on phase 1 to record the commit SHAs.";
  check(err && err.code === "LAND_EVIDENCE" && err.message === want, `T13: all four missing items and their actions (${err && err.message})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T14: a failing or empty verification is not test evidence
{
  const f = onBranchFixture("t14");
  const failing = evidence();
  failing.builder.verification = [{ cmd: "npm test", exit: 1, summary: "red" }];
  failing.tests = { verification: failing.builder.verification };
  const withFailure = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: failing })]);
  const emptyRun = evidence();
  emptyRun.builder.verification = [];
  emptyRun.tests = null;
  const withNoChecks = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: emptyRun })]);
  const a = catchLand({ taskDir: withFailure, projectDir: f.repo, policy: ASK });
  const b = catchLand({ taskDir: withNoChecks, projectDir: f.repo, policy: ASK });
  check(a && a.message.startsWith("land refused for phase 1: missing tests.") && b && b.message.startsWith("land refused for phase 1: missing tests."), `T14: an exit 1 entry and an empty verification both give missing tests (${a && a.message} | ${b && b.message})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T15: with both review knobs off, tests and commits are enough
{
  const f = onBranchFixture("t15");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidence({ plan: false, code: false }) })], { knobs: { review_plan: false, review_code: false } });
  const result = landLib.land({ taskDir, projectDir: f.repo, policy: ASK });
  check(result.landed === true && taskLib.readTaskJson(taskDir).phases[0].status === "landed", "T15: a phase with no reviews lands when both review knobs are off");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T16: a fast-mode task needs no plan review
{
  const f = onBranchFixture("t16");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidence({ plan: false }) })], { mode: "fast" });
  const result = landLib.land({ taskDir, projectDir: f.repo, policy: ASK });
  check(result.landed === true, "T16: a fast-mode phase without a plan review lands");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T17: a review written before kinds existed lands a committed phase, but not an implemented one
{
  const f = onBranchFixture("t17");
  const legacy = taskLib.emptyReports();
  legacy.reviewer = { verdict: "pass_with_notes", issues: [], summary: "old review" };
  legacy.builder = { files_touched: [], verification: PASSING_RUN, deviations: [], summary: "built" };
  const committed = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: legacy })]);
  const implemented = writeTask(f.repo, [phaseSpec(1, { status: "implemented", branch: f.branch, commits: [f.sha], reports: legacy })]);
  const refused = catchLand({ taskDir: implemented, projectDir: f.repo, policy: ASK });
  check(refused && refused.message.startsWith("land refused for phase 1: missing code review."), `T17: the same unstamped review does not count for an implemented phase (${refused && refused.message})`);
  const result = landLib.land({ taskDir: committed, projectDir: f.repo, policy: ASK });
  check(result.landed === true, "T17: an unstamped passing review lands a committed phase");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T18: a phase whose commit is on local main lands with no merge and no push
{
  const f = onBaseFixture("t18");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { status: "implemented", branch: "", commits: [f.sha] })]);
  const remoteBefore = git(f.remote, ["rev-parse", "main"]);
  const result = landLib.land({ taskDir, projectDir: f.repo, policy: { push: "direct", base: "main", merge: "manual" } });
  const phase = taskLib.readTaskJson(taskDir).phases[0];
  check(result.landed === true && result.on_base === true && phase.status === "landed" && phase.landed_sha === f.sha, `T18: an on-base phase is landed at its commit (${JSON.stringify(result)})`);
  check(git(f.repo, ["rev-parse", "main"]) === f.sha && git(f.remote, ["rev-parse", "main"]) === remoteBefore, "T18: local main did not move and nothing was pushed");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T19: a recorded commit that is on no base is refused
{
  const f = onBaseFixture("t19");
  git(f.repo, ["checkout", "-q", "-b", "side"]);
  commit(f.repo, "side work");
  const sideSha = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["checkout", "-q", "main"]);
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: "", commits: [sideSha] })]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "NOT_ON_BASE" && err.message.includes(sideSha) && taskLib.readTaskJson(taskDir).phases[0].status === "committed", `T19: a commit only on a side branch is refused and the phase is unchanged (${err && err.message})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T20: the push policy does not matter on base, and a phase whose branch is main lands the same way
{
  for (const push of ["pr", "ask"]) {
    const f = onBaseFixture(`t20-${push}`);
    const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: push === "pr" ? "" : "main", commits: [f.sha] })]);
    const remoteBefore = git(f.remote, ["rev-parse", "main"]);
    const result = landLib.land({ taskDir, projectDir: f.repo, policy: { push, base: "main", merge: "manual" } });
    check(result.landed === true && result.on_base === true && result.pr_created === undefined && git(f.remote, ["rev-parse", "main"]) === remoteBefore, `T20: push=${push} lands on base with no PR and no push`);
    fs.rmSync(f.baseDir, { recursive: true, force: true });
  }
}

// T21: each refused phase gets its own line
{
  const f = onBranchFixture("t21");
  const taskDir = writeTask(f.repo, [
    phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidence({ code: false }) }),
    phaseSpec(2, { branch: f.branch, commits: [f.sha], reports: evidence({ tests: false }) }),
  ]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.message.split("\n").length === 2 && err.message.split("\n")[0].startsWith("land refused for phase 1: missing code review.") && err.message.split("\n")[1].startsWith("land refused for phase 2: missing tests."), `T21: one line per refused phase (${err && JSON.stringify(err.message)})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T22: the land error and the transition rejection are the same sentence
{
  const f = onBranchFixture("t22");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidence({ code: false }) })]);
  const task = taskLib.readTaskJson(taskDir);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  const sentence = landRefusal(task.phases[0], task, { taskDir });
  let rejected = null;
  try { applyTransition(task.phases[0], "landed", task, { taskDir }); } catch (e) { rejected = e; }
  check(err.message === sentence && rejected.message === `Transition rejected: committed → landed. ${sentence}`, `T22: a land and a state transition refuse with one sentence (${err.message} | ${rejected.message})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// T23, T23b: after a conflict, a Builder that ran no checks keeps the evidence; one whose checks fail does not
{
  const f = onBranchFixture("t23");
  fs.writeFileSync(path.join(f.repo, "conflict.txt"), "main version\n");
  git(f.repo, ["add", "conflict.txt"]);
  git(f.repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "main change"]);
  git(f.repo, ["push", "origin", "main"]);
  fs.writeFileSync(path.join(f.wtPath, "conflict.txt"), "branch version\n");
  git(f.wtPath, ["add", "conflict.txt"]);
  git(f.wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch change"]);
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha] })]);
  const handBack = (verification, summary) => persistReport({ taskDir, phaseId: 1, agentType: "builder", report: { files_touched: ["conflict.txt"], verification, deviations: [], summary } });

  const first = landLib.land({ taskDir, projectDir: f.repo, policy: ASK });
  fs.writeFileSync(path.join(f.wtPath, "conflict.txt"), "merged version\n");
  git(f.wtPath, ["add", "conflict.txt"]);

  handBack([{ cmd: "npm test", exit: 1, summary: "fails" }], "resolved, tests red");
  const refused = catchLand({ taskDir, projectDir: f.repo, policy: ASK, continueMode: true });
  const stuck = taskLib.readTaskJson(taskDir).phases[0];
  const rebasing = spawnSync("git", ["-C", f.wtPath, "rev-parse", "-q", "--verify", "REBASE_HEAD"]).status === 0;
  check(first.conflict === true && refused && refused.code === "LAND_EVIDENCE" && refused.message.includes("missing tests") && stuck.status === "committed" && stuck.conflict && rebasing, `T23b: a resolving Builder whose checks fail leaves the phase conflicted and the rebase in progress (${refused && refused.message})`);

  handBack([{ cmd: "true", exit: 0, summary: "green" }], "resolved, tests green");
  const result = landLib.land({ taskDir, projectDir: f.repo, policy: ASK, continueMode: true });
  check(result.landed === true, "T23b: a later Builder report with exit 0 lets the continue land");
  fs.rmSync(f.baseDir, { recursive: true, force: true });

  const g = onBranchFixture("t23a");
  fs.writeFileSync(path.join(g.repo, "conflict.txt"), "main version\n");
  git(g.repo, ["add", "conflict.txt"]);
  git(g.repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "main change"]);
  git(g.repo, ["push", "origin", "main"]);
  fs.writeFileSync(path.join(g.wtPath, "conflict.txt"), "branch version\n");
  git(g.wtPath, ["add", "conflict.txt"]);
  git(g.wtPath, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch change"]);
  const dir2 = writeTask(g.repo, [phaseSpec(1, { branch: g.branch, commits: [g.sha] })]);
  landLib.land({ taskDir: dir2, projectDir: g.repo, policy: ASK });
  fs.writeFileSync(path.join(g.wtPath, "conflict.txt"), "merged version\n");
  git(g.wtPath, ["add", "conflict.txt"]);
  persistReport({ taskDir: dir2, phaseId: 1, agentType: "builder", report: { files_touched: ["conflict.txt"], verification: [], deviations: [], summary: "resolved" } });
  const landed = landLib.land({ taskDir: dir2, projectDir: g.repo, policy: ASK, continueMode: true });
  const phase = taskLib.readTaskJson(dir2).phases[0];
  check(landed.landed === true && phase.status === "landed" && phase.reports.builder.summary === "resolved" && JSON.stringify(phase.reports.tests.verification) === JSON.stringify(PASSING_RUN), "T23: a resolving Builder that ran no checks lands and leaves the earlier test evidence");
  fs.rmSync(g.baseDir, { recursive: true, force: true });
}

// T24: a selection that mixes on-base and branch phases is refused; each can be landed alone
{
  const f = onBranchFixture("t24");
  const mainSha = git(f.repo, ["rev-parse", "main"]);
  const taskDir = writeTask(f.repo, [
    phaseSpec(1, { branch: "", commits: [mainSha] }),
    phaseSpec(2, { branch: f.branch, commits: [f.sha] }),
  ]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  const after = taskLib.readTaskJson(taskDir).phases.map((p) => p.status).join();
  check(err && err.code === "MIXED_SELECTION" && err.message === "land refused: phases 1 are on main and phases 2 are on a branch. To proceed: land them separately with --phase-id." && after === "committed,committed" && git(f.repo, ["rev-parse", "main"]) === mainSha, `T24: a mixed selection is refused and nothing changes (${err && err.message})`);
  const alone = landLib.land({ taskDir, projectDir: f.repo, policy: ASK, phaseIds: [1] });
  check(alone.landed === true && alone.on_base === true && taskLib.readTaskJson(taskDir).phases[0].status === "landed", "T24: with --phase-id the on-base phase lands");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// L1-L8: the recorded checks are re-run before anything lands, and a red-first
// entry (expected_exit) counts as history, never as a command to run again.
// ---------------------------------------------------------------------------

function evidenceRunning(verification) {
  const reports = evidence();
  reports.builder.verification = verification;
  reports.tests = { verification };
  return reports;
}

function onBaseTask(f, verification) {
  return writeTask(f.repo, [phaseSpec(1, { branch: "", commits: [f.sha], reports: evidenceRunning(verification) })]);
}

// L1: a red-first entry marked expected_exit is accepted and never run again; only the green one re-runs
{
  const f = onBaseFixture("l1");
  const taskDir = onBaseTask(f, [{ cmd: "touch red-ran.txt; exit 1", exit: 1, expected_exit: 1, summary: "red" }, { cmd: "true", exit: 0, summary: "green" }]);
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  const r = (result.value && result.value.reverified) || [];
  check(result.value && result.value.landed === true && r.length === 1 && r[0].phase === 1 && r[0].cmd === "true" && r[0].expected === 0 && r[0].exit === 0 && typeof r[0].seconds === "number", `L1: the green entry re-ran once and the phase landed (${result.error ? result.error.message : JSON.stringify(r)})`);
  check(!fs.existsSync(path.join(f.repo, "red-ran.txt")), "L1: the red-first command was not run again");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L2 (guard): an exit 1 with no expected_exit is refused as missing tests before any command runs
{
  const f = onBaseFixture("l2");
  const taskDir = onBaseTask(f, [{ cmd: "touch ran.txt", exit: 0, summary: "ok" }, { cmd: "false", exit: 1, summary: "red" }]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "LAND_EVIDENCE" && err.message.startsWith("land refused for phase 1: missing tests."), `L2: refused for missing tests (${err && err.message})`);
  check(!fs.existsSync(path.join(f.repo, "ran.txt")), "L2: no recorded command ran");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L3: a recorded green command that no longer exits 0 refuses the land and moves nothing
{
  const f = onBranchFixture("l3");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidenceRunning([{ cmd: "true", exit: 0, summary: "ok" }, { cmd: "exit 3", exit: 0, summary: "ok" }]) })]);
  const mainBefore = git(f.repo, ["rev-parse", "main"]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "LAND_RERUN" && err.message.includes("`exit 3` exited 3 on re-run, recorded 0") && err.message.includes("re-run the Builder on phase 1"), `L3: the refusal names the command and both exits (${err && err.message})`);
  check(taskLib.readTaskJson(taskDir).phases[0].status === "committed" && git(f.repo, ["rev-parse", "main"]) === mainBefore && fs.existsSync(f.wtPath), "L3: the phase stays committed, main does not move and the worktree is kept");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L4: only the last entry of a command re-runs: a red-first entry followed by the same command green runs once, green
{
  const f = onBranchFixture("l4");
  fs.writeFileSync(path.join(f.wtPath, "made.txt"), "made\n");
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha], reports: evidenceRunning([{ cmd: "test -f made.txt", exit: 1, expected_exit: 1, summary: "red" }, { cmd: "test -f made.txt", exit: 0, summary: "green" }]) })]);
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  const r = (result.value && result.value.reverified) || [];
  check(result.value && result.value.landed === true && r.length === 1 && r[0].cmd === "test -f made.txt" && r[0].exit === 0, `L4: one re-run of the green entry, run in the worktree (${result.error ? result.error.message : JSON.stringify(r)})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L5: an on-base phase re-runs in the main root
{
  const f = onBaseFixture("l5");
  fs.writeFileSync(path.join(f.repo, "only-in-main.txt"), "x\n");
  const cmd = "touch rerun-marker.txt; test -f only-in-main.txt";
  const taskDir = onBaseTask(f, [{ cmd, exit: 0, summary: "ok" }]);
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  const r = (result.value && result.value.reverified) || [];
  check(result.value && result.value.landed === true && r.length === 1 && r[0].phase === 1 && r[0].cmd === cmd && r[0].expected === 0 && r[0].exit === 0 && typeof r[0].seconds === "number", `L5: the command re-ran and the phase landed (${result.error ? result.error.message : JSON.stringify(r)})`);
  check(fs.existsSync(path.join(f.repo, "rerun-marker.txt")), "L5: the re-run happened in the main root");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L6 (guard): a run made only of red-first entries is refused as missing tests and nothing re-runs
{
  const f = onBaseFixture("l6");
  const taskDir = onBaseTask(f, [{ cmd: "touch red-ran.txt; exit 1", exit: 1, expected_exit: 1, summary: "red" }]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "LAND_EVIDENCE" && err.message.startsWith("land refused for phase 1: missing tests.") && !fs.existsSync(path.join(f.repo, "red-ran.txt")), `L6: refused for missing tests, nothing re-ran (${err && err.message})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L7: the re-run sees neither the lander's session, pid, terminal and land variables nor its virtualenv; PATH is untouched
{
  const f = onBaseFixture("l7");
  const venv = path.join(f.baseDir, "venv");
  const leaked = { CLAUDE_PID: "4242", CLAUDE_CODE_SESSION_ID: "sess-x", AGENTS_SESSION_DIR: "/nowhere", AGENTS_SESSION_ID: "sess-y", PAV_TERMINAL_ID: "term", PAV_TERMINAL_DIR: "/term", ZMX_SESSION: "z", CLAUDE_CODE_MESSAGING_TOKEN: "tok", VIRTUAL_ENV: venv, POETRY_ACTIVE: "1", AGENTS_LAND: "1" };
  const landerPath = `${venv}/bin:${process.env.PATH}`;
  const saved = {};
  for (const k of [...Object.keys(leaked), "PATH"]) saved[k] = process.env[k];
  Object.assign(process.env, leaked, { PATH: landerPath });
  const taskDir = onBaseTask(f, [{ cmd: "env > rerun-env.txt", exit: 0, summary: "ok" }]);
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const file = path.join(f.repo, "rerun-env.txt");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const names = lines.map((l) => l.split("=")[0]);
  const present = Object.keys(leaked).filter((k) => names.includes(k));
  check(result.value && result.value.landed === true && lines.length > 0, `L7: the phase landed and the re-run wrote its env (${result.error ? result.error.message : "no landed"})`);
  check(present.join() === "", `L7: none of the session, terminal, land or virtualenv variables reached the command (${present.join()})`);
  check(lines.includes(`PATH=${landerPath}`), "L7: PATH reached the command unchanged");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L8: a command that leaves a background process behind does not hold the land up
{
  const f = onBaseFixture("l8");
  const taskDir = onBaseTask(f, [{ cmd: "sleep 3 & exit 0", exit: 0, summary: "ok" }]);
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  const r = (result.value && result.value.reverified) || [];
  check(result.value && result.value.landed === true && r.length === 1 && r[0].exit === 0 && r[0].seconds < 2, `L8: the re-run returned without waiting for the background sleep (${result.error ? result.error.message : JSON.stringify(r)})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// L9: a branch that exists but has no worktree is refused with its own code before anything moves
{
  const f = onBranchFixture("l9");
  git(f.repo, ["worktree", "remove", "--force", f.wtPath]);
  const taskDir = writeTask(f.repo, [phaseSpec(1, { branch: f.branch, commits: [f.sha] })]);
  const mainBefore = git(f.repo, ["rev-parse", "main"]);
  const err = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(err && err.code === "BRANCH_NO_WORKTREE" && err.message.includes(f.branch), `L9: the refusal carries BRANCH_NO_WORKTREE and names the branch (${err && err.code} ${err && err.message})`);
  check(taskLib.readTaskJson(taskDir).phases[0].status === "committed" && git(f.repo, ["rev-parse", "main"]) === mainBefore, "L9: the phase stays committed and main does not move");
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// LA1-LA3: the owner's land_anyway lifts the evidence gate once (database mode)
// ---------------------------------------------------------------------------

require("./lib/db").open({ create: true });
const dbLib = require("./lib/db");
const { repoKey } = require("./lib/repo");

function dbTask(f, overrides) {
  const slug = `la${++evidenceNum}`;
  const made = taskLib.createTask({ repo: repoKey(f.repo), title: slug, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "P1" }], description: "" });
  const doc = taskLib.readTaskJson(made.task_dir);
  doc.phases[0] = { ...doc.phases[0], ...phaseSpec(1, overrides) };
  taskLib.writeTaskJson(made.task_dir, doc);
  return made.task_dir;
}
function landAnyway(taskDir, repo, quote) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "bin", "a"), "decide", "--task-dir", taskDir, "--phase-id", "1", "--choice", "land_anyway", "--quote", quote, "--repo", repo, "--json"], { encoding: "utf8", env: process.env });
  return r.status;
}
const decisionsOf = (taskDir) => dbLib.listDecisions({ taskId: dbLib.taskIdOf(taskDir) });

// LA1: a committed phase with no code review is refused naming land_anyway; once the owner says so it lands, on record
{
  const f = onBaseFixture("la1");
  const taskDir = dbTask(f, { branch: "", commits: [f.sha], reports: evidence({ code: false }) });
  const refused = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  check(refused && refused.code === "LAND_EVIDENCE" && refused.message.includes("--choice land_anyway"), `LA1: the refusal tells the owner how to land it anyway (${refused && refused.message})`);
  const exit = landAnyway(taskDir, f.repo, "hotfix, reviewed live");
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  const phase = taskLib.readTaskJson(taskDir).phases[0];
  const row = decisionsOf(taskDir)[0];
  check(exit === 0 && result.value && result.value.landed === true && phase.status === "landed", `LA1: with the decision the phase lands (${exit}, ${result.error ? result.error.message : "landed"})`);
  check(phase.land_override.quote === "hotfix, reviewed live" && phase.land_override.missing.join() === "code review" && phase.land_override.decision_id === row.decision_id && row.consumed_by === "land" && result.value.landed_anyway[0].phase === 1,
    `LA1: the override is on the phase and the decision is consumed (${JSON.stringify(phase.land_override)}, ${row.consumed_by})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// LA2: a recorded check that fails on re-run does not stop a land the owner lifted, and is not run
{
  const f = onBaseFixture("la2");
  const taskDir = dbTask(f, { branch: "", commits: [f.sha], reports: evidenceRunning([{ cmd: "exit 3", exit: 0, summary: "ok" }]) });
  const refused = catchLand({ taskDir, projectDir: f.repo, policy: ASK });
  landAnyway(taskDir, f.repo, "known flaky");
  const result = catchResult({ taskDir, projectDir: f.repo, policy: ASK });
  check(refused && refused.code === "LAND_RERUN" && refused.message.includes("--choice land_anyway"), `LA2: the re-run refusal names land_anyway (${refused && refused.code})`);
  check(result.value && result.value.landed === true && result.value.reverified.length === 0, `LA2: with the decision it lands without re-running that check (${result.error ? result.error.message : JSON.stringify(result.value.reverified)})`);
  fs.rmSync(f.baseDir, { recursive: true, force: true });
}

// LA3: a land that ends in a conflict leaves the decision to be used again
{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-la3-"));
  const { repo } = makeRepo(baseDir, "repo");
  const wt = wtLib.add({ projectDir: repo, name: "la3-wt" });
  fs.writeFileSync(path.join(repo, "conflict.txt"), "main version\n");
  git(repo, ["add", "conflict.txt"]);
  git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "main change"]);
  git(repo, ["push", "origin", "main"]);
  fs.writeFileSync(path.join(wt.path, "conflict.txt"), "branch version\n");
  git(wt.path, ["add", "conflict.txt"]);
  git(wt.path, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "branch change"]);
  const taskDir = dbTask({ repo }, { branch: wt.branch, commits: ["dummy-sha"], reports: evidence({ code: false }) });
  landAnyway(taskDir, repo, "ship it");
  const result = catchResult({ taskDir, projectDir: repo, policy: ASK });
  const row = decisionsOf(taskDir)[0];
  check(result.value && result.value.conflict === true && row.consumed_at === null && row.consumed_by === null, `LA3: a conflict consumes nothing (${result.error ? result.error.message : JSON.stringify(result.value)}, ${row.consumed_by})`);
  try { git(wt.path, ["rebase", "--abort"]); } catch {}
  fs.rmSync(baseDir, { recursive: true, force: true });
}

// LA4: on a pr policy the owner's decision is spent opening the PR; the later committed -> landed still goes through
{
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-la4-"));
  const { repo } = makeRepo(baseDir, "repo");
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  fs.writeFileSync(path.join(stubDir, "gh"), "#!/bin/sh\necho 'https://example.com/pr/4'\n");
  fs.chmodSync(path.join(stubDir, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  const wt = wtLib.add({ projectDir: repo, name: "la4-wt" });
  commit(wt.path, "la4 feature");
  const taskDir = dbTask({ repo }, { branch: wt.branch, commits: ["dummy-sha"], reports: evidence({ code: false }) });
  landAnyway(taskDir, repo, "reviewed live");
  const opened = catchResult({ taskDir, projectDir: repo, policy: { push: "pr", base: "main", merge: "manual" } });
  process.env.PATH = oldPath;
  const doc = taskLib.readTaskJson(taskDir);
  const attempt = (() => {
    try { require("./lib/transitions").applyTransition(doc.phases[0], "landed", doc, {}); return null; } catch (e) { return e; }
  })();
  check(opened.value && opened.value.pr_created === true && !attempt && doc.phases[0].status === "landed",
    `LA4: after the PR is merged the phase reaches landed (${opened.error ? opened.error.message : ""}${attempt ? attempt.message : "landed"})`);
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
}

// A pr-policy phase whose owner decision was spent opening the PR; the PR is then merged by hand.
function spentOnPr(tag) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-land-${tag}-`));
  const { repo } = makeRepo(baseDir, "repo");
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  fs.writeFileSync(path.join(stubDir, "gh"), "#!/bin/sh\necho 'https://example.com/pr/5'\n");
  fs.chmodSync(path.join(stubDir, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  const wt = wtLib.add({ projectDir: repo, name: `${tag}-wt` });
  commit(wt.path, `${tag} feature`);
  const taskDir = dbTask({ repo }, { branch: wt.branch, commits: ["dummy-sha"], reports: evidence({ code: false }) });
  landAnyway(taskDir, repo, "reviewed live");
  const policy = { push: "pr", base: "main", merge: "manual" };
  const opened = catchResult({ taskDir, projectDir: repo, policy });
  process.env.PATH = oldPath;
  const cleanup = () => { fs.rmSync(baseDir, { recursive: true, force: true }); fs.rmSync(stubDir, { recursive: true, force: true }); };
  return { repo, taskDir, wt, policy, opened, cleanup };
}

// LA5: once the PR of a lifted phase is merged, `a next` offers committed -> landed instead of refusing the phase
{
  const s = spentOnPr("la5");
  git(s.repo, ["merge", "--no-ff", "-m", "merge la5", s.wt.branch]);
  const doc = taskLib.readTaskJson(s.taskDir);
  delete doc.phases[0].pr_open;
  doc.phases[0].landed_sha = git(s.repo, ["rev-parse", "main"]);
  const next = require("./lib/next").computeNext(doc, { projectDir: s.repo, taskDir: s.taskDir, policy: s.policy });
  check(s.opened.value && s.opened.value.pr_created === true && next.step === "done" && next.pending_transitions.includes("committed -> landed"),
    `LA5: the merged PR of a lifted phase is offered committed -> landed (${s.opened.error ? s.opened.error.message : ""}${next.step}: ${next.reason})`);
  s.cleanup();
}

// LA6: a phase whose commits change after the owner's decision needs a new decision
{
  const s = spentOnPr("la6");
  const doc = taskLib.readTaskJson(s.taskDir);
  delete doc.phases[0].pr_open;
  doc.phases[0].commits = ["a-different-sha"];
  taskLib.writeTaskJson(s.taskDir, doc);
  const err = catchLand({ taskDir: s.taskDir, projectDir: s.repo, policy: s.policy });
  check(err && err.code === "LAND_EVIDENCE" && err.message.startsWith("land refused for phase 1: missing code review") && err.message.includes("--choice land_anyway"),
    `LA6: changed commits are refused with the land_anyway tail (${err ? err.code + " " + err.message : "no refusal"})`);
  s.cleanup();
}

// LA7: a committed phase with no override is refused with the evidence sentence
{
  const phase = phaseSpec(1, { commits: ["abc"], reports: evidence({ code: false }) });
  const sentence = require("./lib/transitions").landRefusal(phase, { phases: [phase], knobs: {} }, {});
  check(typeof sentence === "string" && sentence.startsWith("land refused for phase 1: missing code review"), `LA7: the refusal starts with the evidence sentence (${sentence})`);
}

// LA8: an old override without a commits field lifts nothing, even for a phase whose commits are empty
{
  const phase = phaseSpec(1, { commits: [], reports: evidence({ code: false }) });
  phase.land_override = { reason: "reviewed live" };
  const sentence = require("./lib/transitions").landRefusal(phase, { phases: [phase], knobs: {} }, {});
  check(typeof sentence === "string" && sentence.startsWith("land refused for phase 1:"), `LA8: an override without commits is refused (${sentence})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
