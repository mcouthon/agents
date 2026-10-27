"use strict";

/**
 * `a land` — landing an implemented or committed phase onto base.
 *
 * The evidence check runs first: a phase missing its plan review, test
 * evidence, code review or recorded commits is refused before any git command
 * runs. Commits must already be recorded on the phase.
 *
 * Phases on a branch: after the rebase `a land` re-derives `phase.commits`
 * from `git rev-list --reverse <base>..<branch>` and advances an implemented
 * phase to committed before landing.
 * Direct repos: fetch → rebase → derive commits → validate → ff-merge into base
 * from the main checkout → push → record landed_sha → transition to landed.
 * PR repos: fetch → rebase → derive commits → validate → push → gh pr create → set pr_open.
 *
 * Phases already on base (no branch, or the base branch) are marked landed on
 * every repo with no merge, push or PR, once their commits are on base. A
 * selection that mixes on-base and branch phases is refused.
 *
 * AGENTS_LAND=1 is set around all git calls (the env contract; the git guard
 * honours it).
 *
 * Conflicts: on rebase conflict, record phase.conflict and exit 20.
 * `a land --continue` runs `git rebase --continue` after the Builder resolves them.
 * Cap: one attempt, files <= 10; otherwise abort and needs_human.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy } = require("./policy");
const { withNamedLock, LockHeldError } = require("./lock");
const { scrubbedEnv } = require("./session");
const { applyTransition, landRefusal, landingEvidence, verificationRun, expectedExit } = require("./transitions");
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
  if (found) return found.path;
  // During an in-progress rebase the worktree is in detached HEAD (no branch
  // line in `git worktree list`); match it via the rebase state's head-name.
  const ref = `refs/heads/${branch}`;
  for (const wt of wts) {
    const wtName = path.basename(wt.path);
    for (const state of ["rebase-merge", "rebase-apply"]) {
      try {
        const headName = fs.readFileSync(path.join(projectDir, ".git", "worktrees", wtName, state, "head-name"), "utf8").trim();
        if (headName === ref) return wt.path;
      } catch {}
    }
  }
  const err = new Error(`no worktree found for branch ${branch}`);
  err.code = "BRANCH_NO_WORKTREE";
  throw err;
}

const RERUN_TIMEOUT_MS = 600000;

/**
 * Re-run the checks a phase's report recorded, in the phase's checkout, before
 * anything lands: each command expected to exit 0, once (the last entry per
 * distinct command). An entry recorded with a non-zero expected_exit is
 * history about the tree before the change and is never run again. Stdout and
 * stderr go to a log file per command, not a pipe: a background process the
 * command leaves behind would hold a pipe open until the timeout.
 *
 * @returns {{phase: number, cmd: string, expected: number, exit: number, seconds: number}[]}
 */
function reverify(phases, checkoutOf, taskDir) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "a-land-rerun-"));
  const reverified = [];
  for (const p of phases) {
    const cwd = checkoutOf(p);
    if (!cwd) continue;
    const lastPerCmd = new Map();
    for (const entry of verificationRun(p) || []) {
      if (expectedExit(entry) === 0) lastPerCmd.set(entry.cmd, entry);
    }
    let k = 0;
    for (const entry of lastPerCmd.values()) {
      const logPath = path.join(logDir, `${p.id}-${++k}.log`);
      const fd = fs.openSync(logPath, "w");
      const started = Date.now();
      let r;
      try {
        r = spawnSync("sh", ["-c", entry.cmd], {
          cwd, timeout: RERUN_TIMEOUT_MS, killSignal: "SIGKILL",
          stdio: ["ignore", fd, fd], env: scrubbedEnv(),
        });
      } finally {
        fs.closeSync(fd);
      }
      const seconds = (Date.now() - started) / 1000;
      const timedOut = !!(r.error && r.error.code === "ETIMEDOUT");
      const got = r.status !== null ? r.status : 128 + (os.constants.signals[r.signal] || 0);
      if (timedOut || got !== 0) {
        const what = timedOut ? `timed out after ${RERUN_TIMEOUT_MS / 1000} s` : `exited ${got}`;
        const err = new Error(
          `land refused for phase ${p.id}: \`${entry.cmd}\` ${what} on re-run, recorded ${entry.exit} (expected 0). ` +
          `To proceed: re-run the Builder on phase ${p.id} so its report records what the command does now. Output: ${logPath}` +
          landAnywayTail(taskDir, p.id)
        );
        err.code = "LAND_RERUN";
        throw err;
      }
      reverified.push({ phase: p.id, cmd: entry.cmd, expected: 0, exit: got, seconds });
    }
  }
  return reverified;
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
 * Land implemented or committed phases.
 *
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {number[]} [opts.phaseIds] - Specific phase ids to land (default: all implemented/committed)
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
    (p) => ["implemented", "committed"].includes(p.status) && !p.pr_open && (!p.conflict || continueMode)
  );
  if (phaseIds && phaseIds.length > 0) {
    phases = phases.filter((p) => phaseIds.includes(p.id));
  }
  if (phases.length === 0) {
    throw new Error("no implemented or committed phases to land");
  }

  const lifted = claimLifts(taskDir, task, phases);
  let result;
  try {
    result = landSelected({ taskDir, continueMode, policy, key, base, task, phases }, lifted);
  } catch (err) {
    releaseLifts(lifted);
    throw err;
  }
  if (result.landed === true || result.pr_created === true) {
    if (lifted.size > 0) {
      recordLandOverrides(taskDir, lifted);
      result.landed_anyway = [...lifted].map(([phase, l]) => ({ phase, decision_id: l.decision_id, missing: l.missing }));
    }
  } else {
    releaseLifts(lifted);
  }
  return result;
}

/**
 * The owner's `land_anyway` decisions for the selected phases, claimed one each before any check
 * runs (a conditional UPDATE per row, so two lands cannot spend one decision); empty without the
 * database or a task row. A claimed phase skips the evidence gate and the re-run.
 */
function claimLifts(taskDir, task, phases) {
  const lifted = new Map();
  const db = require("./db");
  const taskId = db.enabled() ? db.taskIdOf(taskDir) : null;
  if (taskId === null) return lifted;
  for (const p of phases) {
    const row = db.claimPendingDecision(taskId, p.id, "land_anyway", "land");
    if (row) lifted.set(p.id, { decision_id: row.decision_id, quote: row.quote, missing: landingEvidence(p, task) });
  }
  return lifted;
}

function releaseLifts(lifted) {
  const db = require("./db");
  for (const l of lifted.values()) db.releaseDecision(l.decision_id);
}

function recordLandOverrides(taskDir, lifted) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      const l = lifted.get(phase.id);
      if (l) phase.land_override = { decision_id: l.decision_id, quote: l.quote, missing: l.missing, commits: [...(phase.commits || [])], at: new Date().toISOString() };
    }
    taskLib.writeTaskJson(taskDir, task);
  });
}

/** The sentence that tells the owner how to lift a refusal; empty where `a decide` cannot work (no database or task row). */
function landAnywayTail(taskDir, phaseId) {
  const db = require("./db");
  if (!db.enabled() || db.taskIdOf(taskDir) === null) return "";
  return ` The owner can land it anyway: a decide --task-dir ${taskDir} --phase-id ${phaseId} --choice land_anyway --quote "<reason>"`;
}

function landSelected({ taskDir, continueMode, policy, key, base, task, phases }, lifted) {
  const landAnyway = new Set(lifted.keys());
  const refusals = [];
  const missingByPhase = [];
  for (const p of phases) {
    if (landAnyway.has(p.id)) continue;
    const sentence = landRefusal(p, task, { taskDir });
    if (sentence) {
      refusals.push(sentence + landAnywayTail(taskDir, p.id));
      missingByPhase.push({ phase: p.id, missing: landingEvidence(p, task) });
    }
  }
  if (refusals.length > 0) {
    const err = new Error(refusals.join("\n"));
    err.code = "LAND_EVIDENCE";
    err.missing = missingByPhase;
    throw err;
  }

  const onBasePhases = phases.filter((p) => !p.branch || p.branch === base);
  if (onBasePhases.length > 0 && onBasePhases.length < phases.length) {
    const ids = (list) => list.map((p) => p.id).join(", ");
    const err = new Error(
      `land refused: phases ${ids(onBasePhases)} are on ${base} and phases ` +
      `${ids(phases.filter((p) => !onBasePhases.includes(p)))} are on a branch. ` +
      "To proceed: land them separately with --phase-id."
    );
    err.code = "MIXED_SELECTION";
    throw err;
  }
  const onBase = onBasePhases.length > 0;
  const branch = phases[0].branch;

  const checkoutOf = (p) => {
    if (onBase) return key.main_root;
    if (!gitOk(key.main_root, ["rev-parse", "--verify", `refs/heads/${p.branch}`])) return null;
    return findWorktreeForBranch(key.main_root, p.branch);
  };
  const reverified = reverify(phases.filter((p) => !landAnyway.has(p.id)), checkoutOf, taskDir);

  const lockPath = path.join(os.homedir(), ".agents", "locks", `${key.key}.land.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };

  const result = withNamedLock(lockPath, holder, () => {
    if (onBase) return landOnBase({ taskDir, phases, base, mainRoot: key.main_root, landAnyway });

    // Verify the branch exists before resolving the worktree. A stale
    // phase.branch pointing at a deleted branch (e.g. from a test `a worktree
    // add --task` or a manual branch delete) would otherwise throw a generic
    // "no worktree found" deep inside findWorktreeForBranch.
    if (!gitOk(key.main_root, ["rev-parse", "--verify", `refs/heads/${branch}`])) {
      const err = new Error(
        `branch ${branch} recorded on phase ${phases[0].id} does not exist; ` +
        "run `a worktree add --task <task-dir>` to recreate the worktree, " +
        "or clear phase.branch in task.json to land without a worktree"
      );
      err.code = "BRANCH_NOT_FOUND";
      throw err;
    }
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
    updatePhaseCommits(taskDir, phases, commits, key.main_root, landAnyway);

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
    return landDirect({ taskDir, phases, branch, base, wtPath, key, policy, landAnyway });
  });
  return { ...result, reverified };
}

function landOnBase({ taskDir, phases, base, mainRoot, landAnyway }) {
  const onBase = (sha) => [`origin/${base}`, base].some((ref) => gitOk(mainRoot, ["merge-base", "--is-ancestor", sha, ref]));
  for (const p of phases) {
    const stray = (p.commits || []).filter((sha) => !onBase(sha));
    if (stray.length > 0) {
      const err = new Error(
        `land refused for phase ${p.id}: commits not on ${base}: ${stray.join(", ")}. ` +
        `To proceed: commit the work on ${base}, or record the phase's branch.`
      );
      err.code = "NOT_ON_BASE";
      throw err;
    }
  }

  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  let landedSha = "";
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    const ctx = {
      projectDir: mainRoot,
      taskDir,
      landAnyway,
      gitFacts: { ...require("./next").collectGitFacts(mainRoot), base },
    };
    for (const phase of task.phases || []) {
      if (!phases.some((p) => p.id === phase.id)) continue;
      if (phase.status === "implemented") applyTransition(phase, "committed", task, ctx);
      landedSha = phase.commits[phase.commits.length - 1];
      phase.landed_sha = landedSha;
      applyTransition(phase, "landed", task, ctx);
    }
    taskLib.writeTaskJson(taskDir, task);
    renderStateMd(taskDir, task, mainRoot);
  });
  rebuildTasksIndex(mainRoot, process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`);

  return {
    landed: true,
    on_base: true,
    landed_sha: landedSha,
    phases: phases.map((p) => p.id),
    worktree_removed: false,
    branch_deleted: false,
  };
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

function updatePhaseCommits(taskDir, phases, commits, projectDir, landAnyway) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    const ctx = {
      projectDir,
      taskDir,
      landAnyway,
      gitFacts: require("./next").collectGitFacts(projectDir),
    };
    for (const phase of task.phases || []) {
      if (phases.some((p) => p.id === phase.id)) {
        phase.commits = commits;
        if (phase.status === "implemented") {
          applyTransition(phase, "committed", task, ctx);
        }
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

function landDirect({ taskDir, phases, branch, base, wtPath, key, policy, landAnyway }) {
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
  transitionToLanded(taskDir, phases, ffTip, mainRoot, landAnyway);

  const worktree = reapLanded(taskDir, mainRoot, wtPath, branch);

  return {
    landed: true,
    landed_sha: ffTip,
    phases: phases.map((p) => p.id),
    worktree_removed: worktree.removed,
    branch_deleted: worktree.branch_deleted,
    worktree,
  };
}

/** Remove the landed branch's worktree by the clean policy, unless a phase still to finish runs on that branch. */
function reapLanded(taskDir, mainRoot, wtPath, branch) {
  const task = taskLib.readTaskJson(taskDir);
  const pending = ((task && task.phases) || []).filter(
    (p) => p.branch === branch && !["done", "failed", "skipped", "landed"].includes(p.status)
  );
  if (pending.length > 0) {
    const ids = pending.map((p) => p.id).join(", ");
    return { path: wtPath, branch, removed: false, branch_deleted: false, reason: `phase${pending.length > 1 ? "s" : ""} ${ids} still run${pending.length > 1 ? "" : "s"} on ${branch}` };
  }
  return require("./worktree").reap({ projectDir: mainRoot, path: wtPath });
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
    worktree: reapLanded(taskDir, key.main_root, wtPath, branch),
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

function transitionToLanded(taskDir, phases, landedSha, projectDir, landAnyway) {
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    const ctx = {
      projectDir,
      taskDir,
      landAnyway,
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

module.exports = { land, runValidationSet, MAX_CONFLICT_FILES };
