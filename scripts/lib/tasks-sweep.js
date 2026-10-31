"use strict";

/**
 * `a tasks sweep` — list or archive tasks satisfying the derived done
 * predicate: every phase checked, the landing landed, the newest intent event
 * older than `--older-than` (default 3 days) and no live session bound.
 * All-checked tasks whose landing is unresolved list apart, each with its
 * reason and the close line. The fetch runs once per repo the sandbox guard
 * contains, and what the sweep touches is recomputed ignoring the cache.
 * Dry-run by default; `--apply` archives each listed task through closeTask
 * (a move, reversible; it never deletes).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const taskLib = require("./task");
const db = require("./db");
const derive = require("./derive");
const { contains } = require("./sandbox");

const DEFAULT_OLDER_THAN_DAYS = 3;
const FETCH_TIMEOUT_MS = 30000;

function daysAgo(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

/** True when a live session is bound to the task dir. */
function hasLiveSession(taskDir) {
  const session = require("./session");
  const here = path.resolve(taskDir);
  try {
    return session.list().some((r) => r.task_dir && path.resolve(r.task_dir) === here && session.isLive(r));
  } catch {
    return false;
  }
}

/** One `git fetch origin <base>` in the repo's main checkout, inside the sandbox only. */
function fetchRepo(mainRoot, base) {
  if (!mainRoot || !fs.existsSync(mainRoot)) return { ok: false, reason: "no checkout" };
  if (!contains(mainRoot)) return { ok: false, reason: "outside sandbox" };
  const r = spawnSync("git", ["fetch", "origin", base], {
    cwd: mainRoot, encoding: "utf8", timeout: FETCH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (r.status !== 0) {
    return { ok: false, reason: `git fetch origin ${base} failed: ${((r.stderr || "") + (r.error ? r.error.message : "")).trim()}` };
  }
  return { ok: true };
}

/** The landing of an active all-checked task, recomputed ignoring the cache. */
function landingOfRow(row) {
  let view;
  try { view = taskLib.readTaskJson(row.task_dir); } catch { return null; }
  try { return derive.landingOfTask(row, view, { ignoreCache: true }); } catch { return null; }
}

const closeLine = (row) => `a task close --task-dir ${row.task_dir}`;

/**
 * The done and the unresolved tasks of a repo: done is every-checked, landed,
 * older than `olderThanDays` and free of a live session; unresolved is
 * every-checked with a landing that is not landed.
 * @returns {{done: object[], unresolved: object[]}}
 */
function findTasks(repoKeyObj, { olderThanDays = DEFAULT_OLDER_THAN_DAYS } = {}) {
  const done = [];
  const unresolved = [];
  for (const row of db.listTasks({ disposition: "active", repoKey: repoKeyObj.key })) {
    let view;
    try { view = taskLib.readTaskJson(row.task_dir); } catch { continue; }
    if (!derive.allChecked(view)) continue;
    const landing = landingOfRow(row);
    const recency = db.intentRecency(row.id);
    if (!landing || landing.state !== "landed") {
      unresolved.push({
        dir: row.task_dir,
        slug: view.slug,
        reason: landing && landing.reason ? `unresolved (${landing.reason})` : "unresolved",
        close: closeLine(row),
      });
      continue;
    }
    const ageDays = daysAgo(recency.at);
    if (ageDays < olderThanDays) continue;
    if (hasLiveSession(row.task_dir)) continue;
    done.push({
      dir: row.task_dir,
      slug: view.slug,
      tier: view.tier || "standard",
      disposition: "archive",
      updated: recency.at,
      ageDays: Math.round(ageDays * 10) / 10,
    });
  }
  return { done, unresolved };
}

/**
 * Sweep: fetch the repo's base, then list (or archive) the done tasks and
 * list the unresolved ones.
 * @param {object} opts
 * @param {object} opts.repoKeyObj - Result of repoKey()
 * @param {boolean} [opts.apply=false] - Archive the done tasks instead of just listing
 * @param {number} [opts.olderThanDays] - Only tasks older than this many days (default 3)
 * @returns {{ fetch: object, listed: object[], closed: object[], unresolved: object[] }}
 */
function sweep({ repoKeyObj, apply, olderThanDays }) {
  const { resolvePolicy } = require("./policy");
  const policy = resolvePolicy(repoKeyObj.main_root);
  const base = policy.base || repoKeyObj.base;
  const fetch = fetchRepo(repoKeyObj.main_root, base);
  const { done, unresolved } = findTasks(repoKeyObj, { olderThanDays });

  if (!apply) {
    return { fetch, listed: done, closed: [], unresolved };
  }

  const closed = [];
  for (const t of done) {
    try {
      const result = taskLib.closeTask({ taskDir: t.dir, repoKeyObj });
      closed.push({ slug: t.slug, action: result.action, archivePath: result.archivePath, trashed_to: result.trashed_to || null });
    } catch (err) {
      closed.push({ slug: t.slug, action: "error", reason: err.message });
    }
  }

  return { fetch, listed: [], closed, unresolved };
}

module.exports = { sweep, findTasks, daysAgo };
