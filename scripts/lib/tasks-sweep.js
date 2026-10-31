"use strict";

/**
 * `a tasks sweep` — list or close tasks satisfying the done predicate (D36),
 * read from the database's rows for the repo. Dry-run by default;
 * `--apply` closes each listed task through closeTask (a move, reversible).
 * `--older-than Nd` filters to tasks whose newest intent event is older than N days.
 */

const fs = require("fs");
const path = require("path");
const taskLib = require("./task");
const db = require("./db");

function daysAgo(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

/**
 * The database's done tasks of a repo: every phase checked (a checkmark or a
 * skip decision) and at least one phase, with the task's recency.
 * @param {object} repoKeyObj - Result of repoKey()
 * @param {object} [options]
 * @param {number} [options.olderThanDays] - If set, only include tasks older than this many days
 * @returns {object[]} Array of { dir, slug, tier, disposition, updated, ageDays }
 */
function findDoneTasks(repoKeyObj, options = {}) {
  const { olderThanDays } = options;
  const results = [];
  for (const row of db.listTasks({ disposition: "active", repoKey: repoKeyObj.key })) {
    let doc;
    try { doc = taskLib.readTaskJson(row.task_dir); } catch { continue; }
    if (!taskLib.isTaskDone(doc)) continue;
    const ageDays = daysAgo(doc.updated);
    if (olderThanDays !== undefined && ageDays < olderThanDays) continue;
    results.push({
      dir: row.task_dir,
      slug: doc.slug,
      tier: doc.tier || "standard",
      disposition: "archive",
      updated: doc.updated,
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
