"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { withNamedLock } = require("./lock");

// Central tasks root. Always ~/.agents/tasks (D35 clean break — no knob,
// no symlink, no repo|central switch). AGENTS_TASKS_ROOT redirects the root
// for fixture tests so no test writes into the real ~/.agents/tasks.
function tasksRootBase() {
  return process.env.AGENTS_TASKS_ROOT || path.join(os.homedir(), ".agents", "tasks");
}

function tasksRoot(repoKeyObj) {
  return path.join(tasksRootBase(), repoKeyObj.key);
}

// Root-level index.json: { "<key>": { main_root, default_tiers, last_seen } }
function rootIndexPath() {
  return path.join(tasksRootBase(), "index.json");
}

function rootIndexMdPath() {
  return path.join(tasksRootBase(), "INDEX.md");
}

function rootLockPath() {
  return path.join(tasksRootBase(), ".root.lock");
}

function archiveRoot() {
  return path.join(tasksRootBase(), "archive");
}

function readRootIndex() {
  const p = rootIndexPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeRootIndex(index) {
  const base = tasksRootBase();
  fs.mkdirSync(base, { recursive: true });
  const p = rootIndexPath();
  const tmp = path.join(base, ".index.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

/**
 * Update a single entry in the root index.json under the root lock.
 * @param {string} key - Repo key
 * @param {object} entry - Fields to merge into the entry
 * @returns {object} The updated root index
 */
function updateRootIndex(key, entry) {
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  return withRootLock(holder, () => {
    const index = readRootIndex();
    index[key] = { ...(index[key] || {}), ...entry, last_seen: new Date().toISOString() };
    writeRootIndex(index);
    return index;
  });
}

function withRootLock(holder, fn) {
  return withNamedLock(rootLockPath(), holder, fn);
}

/**
 * Check whether a repo-local .tasks/ directory exists that needs migration
 * to the central root (D35 move-on-first-touch).
 * @param {object} repoKeyObj - Result of repoKey()
 * @returns {boolean}
 */
function hasLocalTasks(repoKeyObj) {
  return fs.existsSync(path.join(repoKeyObj.main_root, ".tasks"));
}

/**
 * Enumerate git main checkouts under ~/code and ~/dev, rolling up by repoKey
 * so stale worktree copies and nested checkouts are never listed.
 * @returns {object[]} Array of { key, main_root } for each repo with a .tasks/
 */
function enumerateReposWithTasks() {
  const results = new Map();
  for (const parent of [path.join(os.homedir(), "code"), path.join(os.homedir(), "dev")]) {
    if (!fs.existsSync(parent)) continue;
    for (const name of fs.readdirSync(parent)) {
      const candidate = path.join(parent, name);
      let stat;
      try { stat = fs.statSync(candidate); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (!fs.existsSync(path.join(candidate, ".git"))) continue;
      if (!fs.existsSync(path.join(candidate, ".tasks"))) continue;
      try {
        const { repoKey } = require("./repo");
        const key = repoKey(candidate);
        if (!results.has(key.key)) {
          results.set(key.key, { key: key.key, main_root: key.main_root });
        }
      } catch { continue; }
    }
  }
  return [...results.values()];
}

/**
 * D35 move-on-first-touch: if a repo-local .tasks/ exists, move it to the
 * central root before returning the central path. Runs the per-repo migrate
 * routine (v1→v2, move, path rewrite, render) under the task lock. Refuses
 * while other live sessions are bound to a task of this repo (self-exclusion).
 * Fails closed if the session registry is unreadable.
 *
 * @param {object} repoKeyObj - Result of repoKey()
 * @param {object} [options]
 * @param {string} [options.excludeSessionId] - Session to exclude from the live check
 * @returns {{ migrated: boolean, centralDir: string, refused?: string[] }}
 */
function ensureMigrated(repoKeyObj, options = {}) {
  const centralDir = tasksRoot(repoKeyObj);
  const localTasksDir = path.join(repoKeyObj.main_root, ".tasks");

  // No repo-local .tasks/ — nothing to migrate
  if (!fs.existsSync(localTasksDir)) {
    return { migrated: false, centralDir };
  }

  // Already migrated (central dir exists, local dir is gone or being removed)
  if (fs.existsSync(centralDir) && !fs.existsSync(localTasksDir)) {
    return { migrated: false, centralDir, alreadyMigrated: true };
  }

  // Live-session refusal check (D35): refuse if other live sessions are on this repo
  const { findLiveByRepoKey } = require("./session");
  const excludeSessionId = options.excludeSessionId ||
    process.env.CLAUDE_CODE_SESSION_ID || process.env.AGENTS_SESSION_ID || null;

  let liveSessions;
  try {
    liveSessions = findLiveByRepoKey(repoKeyObj.key, excludeSessionId);
  } catch (err) {
    // Fail closed: unreadable registry → error out, never silently read repo-local
    const e = new Error(
      `Cannot verify live sessions for repo ${repoKeyObj.key}: ${err.message}. ` +
      "Run `a task migrate --apply` from a stopped-session shell."
    );
    e.failClosed = true;
    throw e;
  }

  if (liveSessions && liveSessions.length > 0) {
    const names = liveSessions.map((s) => s.session_id || s.terminal_id || "unknown").join(", ");
    const e = new Error(
      `Cannot migrate .tasks/ for repo ${repoKeyObj.key}: live sessions active (${names}). ` +
      "Stop the sessions or run `a task migrate --apply` from a stopped-session shell."
    );
    e.refused = liveSessions;
    throw e;
  }

  // No live sessions — proceed with the move
  const taskLib = require("./task");
  const { withLock } = require("./lock");
  const holder = { session_id: excludeSessionId || `pid-${process.pid}`, pid: process.pid };

  // Create the central dir
  fs.mkdirSync(centralDir, { recursive: true });

  // Move each task dir from local to central
  for (const name of fs.readdirSync(localTasksDir)) {
    if (name.startsWith(".")) continue;
    const srcDir = path.join(localTasksDir, name);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const destDir = path.join(centralDir, name);

    // v1→v2 migrate if needed (task.json absent, state.json present)
    if (!taskLib.isMigrated(srcDir) && fs.existsSync(taskLib.stateJsonPath(srcDir))) {
      try {
        taskLib.migrateTask(srcDir, { dryRun: false });
      } catch {}
    }

    // Move the dir
    if (fs.existsSync(destDir)) {
      // Already exists in central — merge (skip if same task)
      continue;
    }
    try {
      withLock(srcDir, holder, () => {
        fs.renameSync(srcDir, destDir);
      });
    } catch (err) {
      // If rename fails (e.g., cross-device), copy then trash the source
      copyDir(srcDir, destDir);
      const { trashDir } = require("./trash");
      trashDir(srcDir, repoKeyObj.key);
    }

    // Rewrite absolute paths in task.json (old main_root → central)
    if (taskLib.isMigrated(destDir)) {
      const task = taskLib.readTaskJson(destDir);
      if (task) {
        // No absolute paths to rewrite in task.json itself (all paths are relative
        // to the task dir), but update the root index
        try {
          const { renderStateMd } = require("./render");
          renderStateMd(destDir, task, repoKeyObj.main_root);
        } catch {}
      }
    }
  }

  // Remove the old .tasks directory — move to trash, never rm
  try {
    const { trashDir } = require("./trash");
    trashDir(localTasksDir, repoKeyObj.key);
  } catch {}

  // Update root index.json
  try {
    updateRootIndex(repoKeyObj.key, { main_root: repoKeyObj.main_root });
  } catch {}

  // Rebuild the per-repo tasks.json index
  try {
    const { rebuildTasksIndex } = require("./render");
    rebuildTasksIndex(repoKeyObj.main_root, holder.session_id);
  } catch {}

  return { migrated: true, centralDir };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

module.exports = {
  tasksRootBase,
  tasksRoot,
  rootIndexPath,
  rootIndexMdPath,
  rootLockPath,
  archiveRoot,
  readRootIndex,
  writeRootIndex,
  updateRootIndex,
  withRootLock,
  hasLocalTasks,
  enumerateReposWithTasks,
  ensureMigrated,
};
