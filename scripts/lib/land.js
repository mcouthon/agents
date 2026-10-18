"use strict";

/**
 * `a land` — landing a committed phase onto base.
 *
 * Direct repos: fetch → rebase → validate → ff-merge into base from the main
 * checkout → push → record landed_sha → transition to landed.
 * PR repos: fetch → rebase → validate → push → gh pr create → set pr_open.
 *
 * AGENTS_LAND=1 is set around all git calls (the env contract; P4's git-guard
 * honours it via an allow-list entry that lives in the P4 plan).
 *
 * Conflicts (D26 layer 3): on rebase conflict, record phase.conflict and exit 20.
 * `a land --continue` runs `git rebase --continue` after the Builder resolves them.
 * Cap: one attempt, files <= 10; otherwise abort and needs_human.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy } = require("./policy");
const { withNamedLock, LockHeldError } = require("./lock");
const { applyTransition } = require("./transitions");
const taskLib = require("./task");
const { renderStateMd, rebuildTasksIndex } = require("./render");

const MAX_CONFLICT_FILES = 10;

function gitLand(repoDir, args, opts) {
  const env = { ...process.env, AGENTS_LAND: "1" };
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

function gitLandOk(repoDir, args) {
  try {
    gitLand(repoDir, args);
    return true;
  } catch {
    return false;
  }
}

function gitOk(repoDir, args) {
  try {
    execFileSync("git", ["-C", repoDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function findWorktreeForBranch(projectDir, branch) {
  const { parseWorktrees, shortBranch } = require("./worktree");
  const wts = parseWorktrees(projectDir);
  const found = wts.find((wt) => shortBranch(wt.branch) === branch);
  if (!found) throw new Error(`no worktree found for branch ${branch}`);
  return found.path;
}

function getInitiator() {
  const dir = process.env.AGENTS_SESSION_DIR;
  if (!dir) return null;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registration.json"), "utf8"));
    return reg.initiator || null;
  } catch {
    return null;
  }
}

function runValidationSet(worktreePath) {
  let config;
  try { config = require("./config").loadConfig(); } catch { config = {}; }
  const commands = (config.validate && config.validate.commands) || [];
  const results = [];
  for (const cmd of commands) {
    try {
      execFileSync("sh", ["-c", cmd], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENTS_LAND: "1" },
      });
      results.push({ command: cmd, passed: true });
    } catch (err) {
      results.push({ command: cmd, passed: false, error: err.stderr || err.message });
    }
  }
  return results;
}

/**
 * Land committed phases.
 *
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {number[]} [opts.phaseIds] - Specific phase ids to land (default: all committed)
 * @param {boolean} [opts.continueMode] - Continue after conflict resolution
 * @returns {object} Result: { landed, pr_created, conflict, needs_human, ... }
 */
function land({ taskDir, projectDir, phaseIds, continueMode, policy }) {
  const key = repoKey(projectDir);
  policy = policy || resolvePolicy(key.main_root);
  const base = policy.base;

  const task = taskLib.readTaskJson(taskDir);
  if (!task) throw new Error("task.json not found at " + taskDir);

  let phases = (task.phases || []).filter(
    (p) => p.status === "committed" && !p.pr_open && (!p.conflict || continueMode)
  );
  if (phaseIds && phaseIds.length > 0) {
    phases = phases.filter((p) => phaseIds.includes(p.id));
  }
  if (phases.length === 0) {
    throw new Error("no committed phases to land");
  }

  const branch = phases[0].branch;
  if (!branch) throw new Error("phase has no branch recorded; run `a commit` first");
  if (branch === base) throw new Error("phase is already on base; nothing to land");

  const lockPath = path.join(os.homedir(), ".agents", "locks", `${key.key}.land.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };

  return withNamedLock(lockPath, holder, () => {
    const wtPath = findWorktreeForBranch(key.main_root, branch);

    const rebaseTarget = gitOk(key.main_root, ["rev-parse", "--verify", `origin/${base}`])
      ? `origin/${base}` : base;

    if (continueMode) {
      try {
        gitLand(wtPath, ["rebase", "--continue"]);
      } catch (e) {
        if (!String(e.stderr || e.message || "").includes("no rebase in progress")) throw e;
      }
      clearConflict(taskDir, phases, key.main_root);
    } else {
      try { gitLand(key.main_root, ["fetch", "origin"]); } catch {}
      try {
        gitLand(wtPath, ["rebase", rebaseTarget]);
      } catch (err) {
        return handleConflict(taskDir, phases, wtPath, key.main_root, base, err);
      }
    }

    const commits = gitLand(wtPath, ["rev-list", "--reverse", `${rebaseTarget}..${branch}`])
      .split("\n").filter(Boolean);
    updatePhaseCommits(taskDir, phases, commits, key.main_root);

    const validation = runValidationSet(wtPath);
    const failed = validation.filter((v) => !v.passed);
    if (failed.length > 0) {
      const err = new Error("validation set failed: " + failed.map((f) => f.command).join(", "));
      err.code = "VALIDATION_FAILED";
      err.validation = validation;
      throw err;
    }

    if (policy.push === "pr") {
      return landPR({ taskDir, phases, branch, base, wtPath, key, policy });
    }
    return landDirect({ taskDir, phases, branch, base, wtPath, key, policy });
  });
}

function handleConflict(taskDir, phases, wtPath, projectDir, base, rebaseErr) {
  const conflictFiles = parseConflictFiles(wtPath);
  if (conflictFiles.length > MAX_CONFLICT_FILES) {
    gitLand(wtPath, ["rebase", "--abort"]);
    addNeedsHumanFlag(taskDir, phases, {
      reason: `too many conflict files (${conflictFiles.length} > ${MAX_CONFLICT_FILES})`,
      files: conflictFiles,
    }, projectDir);
    return { needs_human: true, reason: "too many conflict files", files: conflictFiles };
  }

  const baseSha = gitLandOk(wtPath, ["rev-parse", "REBASE_HEAD"]) ? gitLand(wtPath, ["rev-parse", "REBASE_HEAD"]) : "";
  const branchSha = gitLandOk(wtPath, ["rev-parse", "ORIG_HEAD"]) ? gitLand(wtPath, ["rev-parse", "ORIG_HEAD"]) : "";

  recordConflict(taskDir, phases, {
    files: conflictFiles,
    base_sha: baseSha,
    branch_sha: branchSha,
    attempt: 1,
  }, projectDir);

  return { conflict: true, files: conflictFiles, exitCode: 20 };
}

function parseConflictFiles(wtPath) {
  try {
    const out = gitLand(wtPath, ["diff", "--diff-filter=U", "--name-only"]);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function recordConflict(taskDir, phases, conflict, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        phase.conflict = conflict;
      }
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
}

function clearConflict(taskDir, phases, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        delete phase.conflict;
      }
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
}

function updatePhaseCommits(taskDir, phases, commits, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        phase.commits = commits;
      }
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
}

function addNeedsHumanFlag(taskDir, phases, info, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    task.flags = task.flags || [];
    task.flags.push({
      id: `f-land-${Date.now()}`,
      phase: phases[0].id,
      type: "needs_human",
      message: `${info.reason}; files: ${info.files.join(", ")}`,
      raised: new Date().toISOString(),
    });
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
}

function landDirect({ taskDir, phases, branch, base, wtPath, key, policy }) {
  const mainRoot = key.main_root;

  const mainBranch = gitLand(mainRoot, ["branch", "--show-current"]);
  if (mainBranch !== base) {
    addNeedsHumanFlag(taskDir, phases, {
      reason: `main checkout is on ${mainBranch}, not ${base}`,
      files: [],
    }, mainRoot);
    return { needs_human: true, reason: `main checkout not on ${base}` };
  }

  const mainStatus = gitLand(mainRoot, ["status", "--porcelain"]);
  if (mainStatus) {
    const branchFiles = gitLand(wtPath, ["diff", "--name-only", `${base}..${branch}`])
      .split("\n").filter(Boolean);
    const dirtyFiles = mainStatus.split("\n").map((l) => (" " + l).slice(3).trim());
    const overlap = dirtyFiles.filter((f) => branchFiles.includes(f));
    if (overlap.length > 0) {
      addNeedsHumanFlag(taskDir, phases, {
        reason: "main checkout has uncommitted changes in files the branch touches",
        files: overlap,
      }, mainRoot);
      return { needs_human: true, reason: "main checkout dirty in overlapping files", files: overlap };
    }
  }

  gitLand(mainRoot, ["merge", "--ff-only", branch]);

  if (policy.push === "direct") {
    gitLand(mainRoot, ["push", "origin", base]);
  }

  const ffTip = gitLand(mainRoot, ["rev-parse", base]);
  transitionToLanded(taskDir, phases, ffTip, mainRoot);

  const remaining = countRemainingPhases(taskDir);
  let worktreeRemoved = false;
  let branchDeleted = false;
  if (remaining === 0) {
    const result = removeWorktreeAndBranch(mainRoot, wtPath, branch);
    worktreeRemoved = result.removed;
    branchDeleted = result.branchDeleted;
  }

  return {
    landed: true,
    landed_sha: ffTip,
    phases: phases.map((p) => p.id),
    worktree_removed: worktreeRemoved,
    branch_deleted: branchDeleted,
  };
}

function landPR({ taskDir, phases, branch, base, wtPath, key, policy }) {
  gitLand(wtPath, ["push", "-u", "origin", branch]);

  const initiator = getInitiator();
  const isDraft = initiator === "mission" || initiator === "intake";
  const prArgs = ["pr", "create", "--base", base, "--head", branch, "--title",
    phases.map((p) => p.name).join(", ")];
  if (isDraft) prArgs.push("--draft");

  let prUrl = "";
  try {
    prUrl = execFileSync("gh", prArgs, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTS_LAND: "1" },
    }).trim();
  } catch (err) {
    const err2 = new Error("gh pr create failed: " + (err.stderr || err.message));
    err2.code = "PR_CREATE_FAILED";
    throw err2;
  }

  setPrOpen(taskDir, phases, { url: prUrl, branch, base }, key.main_root);

  return {
    pr_created: true,
    pr_url: prUrl,
    phases: phases.map((p) => p.id),
    draft: isDraft,
  };
}

function setPrOpen(taskDir, phases, prInfo, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        phase.pr_open = true;
        phase.pr = prInfo;
      }
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
}

function transitionToLanded(taskDir, phases, landedSha, projectDir) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    const ctx = {
      projectDir,
      taskDir,
      gitFacts: {
        base: require("./next").collectGitFacts(projectDir).base,
        isAncestor: (sha, ref) => {
          try {
            execFileSync("git", ["-C", projectDir, "merge-base", "--is-ancestor", sha, ref], {
              stdio: ["ignore", "pipe", "pipe"], timeout: 2000,
            });
            return true;
          } catch { return false; }
        },
      },
    };
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        phase.landed_sha = landedSha;
        applyTransition(phase, "landed", task, ctx);
      }
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, projectDir);
  });
  rebuildTasksIndex(projectDir, process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`);
}

function countRemainingPhases(taskDir) {
  const task = taskLib.readTaskJson(taskDir);
  if (!task) return 0;
  return (task.phases || []).filter(
    (p) => !["done", "failed", "skipped", "landed"].includes(p.status)
  ).length;
}

function removeWorktreeAndBranch(projectDir, wtPath, branch) {
  const { remove } = require("./worktree");
  try {
    const result = remove({ projectDir, path: wtPath, force: false });
    return { removed: true, branchDeleted: result.branchDeleted };
  } catch {
    return { removed: false, branchDeleted: false };
  }
}

module.exports = { land, runValidationSet, MAX_CONFLICT_FILES };
