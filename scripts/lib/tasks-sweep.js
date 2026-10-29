"use strict";

/**
 * `a tasks sweep` — list or close tasks satisfying the done predicate (D36).
 * Dry-run by default; `--apply` closes each task by its tier rule.
 * `--older-than Nd` filters to tasks whose last write was more than N days ago.
 */

const fs = require("fs");
const path = require("path");
const taskLib = require("./task");
const { tasksRoot, withRootLock } = require("./tasks-root");

function daysAgo(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

/**
 * Scan the central root for tasks satisfying the done predicate.
 * @param {object} repoKeyObj - Result of repoKey()
 * @param {object} [options]
 * @param {number} [options.olderThanDays] - If set, only include tasks older than this many days
 * @returns {object[]} Array of { dir, slug, tier, disposition, updated, ageDays }
 */
function findDoneTasks(repoKeyObj, options = {}) {
  const { olderThanDays } = options;
  const root = tasksRoot(repoKeyObj);
  if (!fs.existsSync(root)) return [];

  const results = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!taskLib.isMigrated(dir)) continue;
    const task = taskLib.readTaskJson(dir);
    if (!task) continue;

    if (!taskLib.isTaskDone(task)) continue;

    const ageDays = daysAgo(task.updated);
    if (olderThanDays !== undefined && ageDays < olderThanDays) continue;

    results.push({
      dir,
      slug: task.slug,
      tier: task.tier || "standard",
      disposition: "archive",
      updated: task.updated,
      ageDays: Math.round(ageDays * 10) / 10,
    });
  }
  return results;
}

/**
 * Sweep: list or close done tasks.
 * @param {object} opts
 * @param {object} opts.repoKeyObj - Result of repoKey()
 * @param {boolean} [opts.apply=false] - Close tasks instead of just listing
 * @param {number} [opts.olderThanDays] - Only close tasks older than this many days
 * @returns {{ listed: object[], closed: object[] }}
 */
function sweep({ repoKeyObj, apply, olderThanDays }) {
  const tasks = findDoneTasks(repoKeyObj, { olderThanDays });

  if (!apply) {
    return { listed: tasks, closed: [] };
  }

  const closed = [];
  for (const t of tasks) {
    try {
      const result = taskLib.closeTask({ taskDir: t.dir, repoKeyObj });
      closed.push({ slug: t.slug, action: result.action, archivePath: result.archivePath, trashed_to: result.trashed_to || null });
    } catch (err) {
      closed.push({ slug: t.slug, action: "error", reason: err.message });
    }
  }

  return { listed: [], closed };
}

module.exports = { sweep, findDoneTasks, daysAgo };
