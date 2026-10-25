"use strict";

/**
 * Worktree operations: add, remove, list, clean, occupied.
 *
 * One creation path (`a worktree add`),
 * one removal policy. Path: ../<repo-name>-wt-<NNN>-<slug>, branch: wt/<NNN>-<slug>.
 * In database mode `add` symlinks the main checkout's `.tasks` into the new
 * worktree (excluded through info/exclude, so the worktree stays clean).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy } = require("./policy");

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(repoDir, args) {
  try {
    execFileSync("git", ["-C", repoDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function isDirty(wtPath) {
  try {
    return git(wtPath, ["status", "--porcelain"]).length > 0;
  } catch {
    return true;
  }
}

function currentBranch(wtPath) {
  try {
    return git(wtPath, ["branch", "--show-current"]);
  } catch {
    return "";
  }
}

function isAncestor(repoDir, sha, ref) {
  return gitOk(repoDir, ["merge-base", "--is-ancestor", sha, ref]);
}

function parseWorktrees(repoDir) {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  const wts = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      wts.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length);
    } else if (line === "") {
      cur = null;
    }
  }
  return wts;
}

function shortBranch(ref) {
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

/**
 * Add a worktree.
 * @param {object} opts
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {string} [opts.taskDir] - Task directory (task-bound worktree)
 * @param {string} [opts.name] - Name for non-task-bound worktree
 * @param {boolean} [opts.force] - Skip manifest overlap check
 * @returns {{branch: string, path: string, tasks_link: string}}
 */
function add({ projectDir, taskDir, name, force }) {
  const key = repoKey(projectDir);
  const repoName = path.basename(key.main_root);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;

  let branch, wtPath;

  if (taskDir) {
    const taskAbsDir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
    const dirName = path.basename(taskAbsDir);
    const match = dirName.match(/^(\d{3})-(.+)$/);
    const taskNum = match ? match[1] : dirName;
    const slug = match ? match[2] : "task";
    branch = `wt/${taskNum}-${slug}`;
    wtPath = path.resolve(key.main_root, "..", `${repoName}-wt-${taskNum}-${slug}`);

    if (!force) {
      const overlaps = checkManifestOverlap(key.main_root, taskAbsDir, key.key);
      if (overlaps.length > 0) {
        const err = new Error("manifest overlap with live tasks");
        err.code = "MANIFEST_OVERLAP";
        err.exitCode = 21;
        err.overlaps = overlaps;
        throw err;
      }
    }
  } else {
    if (!name) throw new Error("either --task or --name is required");
    branch = `wt/${name}`;
    wtPath = path.resolve(key.main_root, "..", `${repoName}-wt-${name}`);
  }

  if (fs.existsSync(wtPath)) {
    throw new Error(`path already exists: ${wtPath}`);
  }
  if (gitOk(key.main_root, ["rev-parse", "--verify", `refs/heads/${branch}`])) {
    throw new Error(`branch already exists: ${branch}`);
  }

  git(key.main_root, ["worktree", "add", "-b", branch, wtPath, base]);

  if (taskDir) {
    const taskAbsDir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
    recordWorktreeInTask(taskAbsDir, branch, wtPath, key.main_root);
  }

  return { branch, path: wtPath, tasks_link: linkRepoFiles(key.main_root, wtPath) };
}

/**
 * Link the main checkout's `.tasks` into a new worktree so repo-files task
 * Markdown is reachable there. Never fails the worktree.
 * @returns {string} "created" | "exists" | "skipped: <reason>" | "failed: <message>"
 */
function linkRepoFiles(mainRoot, wtPath) {
  try {
    if (!require("./db").enabled()) return "skipped: database off";
    const files = require("./tasks-root").ensureRepoFilesRoot(mainRoot);
    if (!files) return "skipped: no repo .tasks directory";
    const link = path.join(wtPath, ".tasks");
    try {
      fs.lstatSync(link);
      return "exists";
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    fs.symlinkSync(files, link, "dir");
    return "created";
  } catch (err) {
    return `failed: ${err.message}`;
  }
}

/**
 * Record branch and worktree_path in task.json for the bound task.
 * Stamps only non-terminal phases (done/failed/skipped/landed are left alone
 * — they already ran or will run elsewhere).
 */
function recordWorktreeInTask(taskDir, branch, wtPath, projectDir) {
  const taskLib = require("./task");
  if (!taskLib.isMigrated(taskDir)) return;
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  const TERMINAL = ["done", "failed", "skipped", "landed"];
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (!phase.branch && !TERMINAL.includes(phase.status)) phase.branch = branch;
    }
    if (!task.worktree_path) task.worktree_path = wtPath;
    taskLib.writeTaskJson(taskDir, task);
    const { renderStateMd } = require("./render");
    renderStateMd(taskDir, task, projectDir);
  });
}

/**
 * Remove a worktree. Refuses if dirty or if branch has unlanded commits.
 * @param {object} opts
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {string} opts.path - Worktree path to remove
 * @param {boolean} [opts.force] - Skip safety checks
 * @returns {{removed: string, branch: string|null, branchDeleted: boolean}}
 */
function remove({ projectDir, path: wtPath, force }) {
  const key = repoKey(projectDir);
  const wtAbs = path.resolve(wtPath);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;

  if (!fs.existsSync(wtAbs)) {
    throw new Error(`worktree path does not exist: ${wtAbs}`);
  }

  if (!force && isDirty(wtAbs)) {
    const err = new Error("worktree has uncommitted changes; use --force to remove anyway");
    err.code = "DIRTY";
    throw err;
  }

  const branch = currentBranch(wtAbs);

  if (!force && branch && branch !== base) {
    const merged = isAncestor(key.main_root, branch, base);
    if (!merged) {
      // Check if any task phase in the central root has this branch landed
      const { tasksRoot } = require("./tasks-root");
      const taskLib = require("./task");
      const centralDir = tasksRoot(key);
      let landed = false;
      if (fs.existsSync(centralDir)) {
        for (const name of fs.readdirSync(centralDir)) {
          if (name.startsWith(".")) continue;
          const dir = path.join(centralDir, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          if (!taskLib.isMigrated(dir)) continue;
          const task = taskLib.readTaskJson(dir);
          if (!task) continue;
          const phase = (task.phases || []).find((p) => p.branch === branch);
          if (phase && phase.status === "landed") { landed = true; break; }
        }
      }
      if (!landed) {
        const err = new Error(
          `branch ${branch} has unlanded commits; land first or use --force`
        );
        err.code = "UNLANDED";
        throw err;
      }
    }
  }

  git(key.main_root, ["worktree", "remove", wtAbs]);
  git(key.main_root, ["worktree", "prune"]);

  let branchDeleted = false;
  if (branch && branch !== base && isAncestor(key.main_root, branch, base)) {
    try {
      git(key.main_root, ["branch", "-d", branch]);
      branchDeleted = true;
    } catch {}
  }

  // Clear branch/worktree_path from task.json phases in the central root
  // that referenced the removed branch (non-landed only).
  if (branch) {
    const { tasksRoot } = require("./tasks-root");
    const taskLib = require("./task");
    const { withLock } = require("./lock");
    const centralDir = tasksRoot(key);
    if (fs.existsSync(centralDir)) {
      const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
      for (const name of fs.readdirSync(centralDir)) {
        if (name.startsWith(".")) continue;
        const dir = path.join(centralDir, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (!taskLib.isMigrated(dir)) continue;
        try {
          withLock(dir, holder, () => {
            const task = taskLib.readTaskJson(dir);
            if (!task) return;
            let touched = false;
            for (const phase of task.phases || []) {
              if (phase.branch === branch && phase.status !== "landed") {
                phase.branch = "";
                phase.worktree_path = "";
                touched = true;
              }
            }
            if (wtAbs && task.worktree_path === wtAbs) {
              task.worktree_path = "";
              touched = true;
            }
            if (touched) {
              taskLib.writeTaskJson(dir, task);
              const { renderStateMd } = require("./render");
              renderStateMd(dir, task, key.main_root);
            }
          });
        } catch {}
      }
    }
  }

  return { removed: wtAbs, branch, branchDeleted };
}

/**
 * List all worktrees.
 * @param {string} projectDir
 * @returns {object[]} Array of {path, branch, isMain}
 */
function list(projectDir) {
  const key = repoKey(projectDir);
  const wts = parseWorktrees(key.main_root);
  return wts.map((wt) => ({
    path: wt.path,
    branch: shortBranch(wt.branch),
    isMain: path.resolve(wt.path) === path.resolve(key.main_root),
  }));
}

/**
 * Sweep stale worktrees (merged branches, wt/* and .claude/worktrees/*).
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {boolean} [opts.dryRun] - Report only, do not remove
 * @returns {{removed: string[], skipped: object[]}}
 */
function clean({ projectDir, dryRun }) {
  const key = repoKey(projectDir);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;
  const wts = parseWorktrees(key.main_root);

  const removed = [];
  const skipped = [];

  for (const wt of wts) {
    const isMain = path.resolve(wt.path) === path.resolve(key.main_root);
    if (isMain) continue;

    const branch = shortBranch(wt.branch);
    if (!branch) continue;

    const isWtBranch = branch.startsWith("wt/");
    const isClaudeWt = wt.path.includes(".claude/worktrees/");
    if (!isWtBranch && !isClaudeWt) continue;

    if (!isAncestor(key.main_root, branch, base)) {
      skipped.push({ path: wt.path, branch, reason: "not merged" });
      continue;
    }

    if (isDirty(wt.path)) {
      skipped.push({ path: wt.path, branch, reason: "dirty" });
      continue;
    }

    if (dryRun) {
      removed.push({ path: wt.path, branch });
      continue;
    }

    try {
      git(key.main_root, ["worktree", "remove", wt.path]);
      removed.push({ path: wt.path, branch });
      try {
        git(key.main_root, ["branch", "-d", branch]);
      } catch {}
    } catch (err) {
      skipped.push({ path: wt.path, branch, reason: err.message });
    }
  }

  if (!dryRun) {
    try { git(key.main_root, ["worktree", "prune"]); } catch {}
  }

  return { removed, skipped };
}

/**
 * Check if the main checkout is occupied by a live session.
 * @param {string} projectDir
 * @returns {boolean}
 */
function occupied(projectDir) {
  const key = repoKey(projectDir);
  let session;
  try { session = require("./session"); } catch { return false; }
  const sessions = session.list();
  return sessions.some((s) =>
    !s.ended_at && s.pid && session.isPidAlive(s.pid) &&
    s.repo_key === key.key &&
    s.cwd && path.resolve(s.cwd) === path.resolve(key.main_root)
  );
}

/**
 * Check manifest overlap between a new task and all live tasks in the repo.
 * @param {string} projectDir - Repo main root
 * @param {string} newTaskDir - The new task's directory
 * @param {string} repoKeyValue - The repo key for filtering sessions
 * @returns {object[]} Array of {task, files} for each overlapping task
 */
function checkManifestOverlap(projectDir, newTaskDir, repoKeyValue) {
  const taskLib = require("./task");
  let session;
  try { session = require("./session"); } catch { return []; }

  const newTask = taskLib.readTaskJson(newTaskDir);
  if (!newTask) return [];
  const newManifests = new Set();
  for (const phase of newTask.phases || []) {
    for (const f of phase.manifest || []) newManifests.add(f);
  }
  if (newManifests.size === 0) return [];

  const liveSessions = session.list().filter((s) =>
    !s.ended_at && s.pid && session.isPidAlive(s.pid) &&
    s.repo_key === repoKeyValue && s.task_dir
  );

  const overlaps = [];
  for (const s of liveSessions) {
    if (path.resolve(s.task_dir) === path.resolve(newTaskDir)) continue;
    const otherTask = taskLib.readTaskJson(s.task_dir);
    if (!otherTask) continue;
    const otherManifests = new Set();
    for (const phase of otherTask.phases || []) {
      if (["done", "failed", "skipped", "landed"].includes(phase.status)) continue;
      for (const f of phase.manifest || []) otherManifests.add(f);
    }
    const shared = [...newManifests].filter((f) => otherManifests.has(f));
    if (shared.length > 0) {
      overlaps.push({ task: path.basename(s.task_dir), files: shared });
    }
  }
  return overlaps;
}

module.exports = {
  add,
  remove,
  list,
  clean,
  occupied,
  checkManifestOverlap,
  isDirty,
  isAncestor,
  parseWorktrees,
  shortBranch,
  currentBranch,
  recordWorktreeInTask,
  linkRepoFiles,
};
