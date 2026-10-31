"use strict";

// `a ls`: active tasks as roster entries (by default those with a live session or
// written in the last 7 days; see build), with the live session bound to each, plus
// the live sessions bound to no task.

const fs = require("fs");
const path = require("path");

function phasesOf(doc) {
  return Array.isArray(doc.phases) ? doc.phases.filter((p) => p && typeof p === "object") : [];
}

// The current phase: the first unchecked one whose `after` phases are all checked, else the last one.
function currentPhase(doc) {
  const derive = require("./derive");
  const phases = phasesOf(doc);
  return derive.currentPhaseOf(doc) || phases[phases.length - 1] || null;
}

const strOrNull = (v) => (typeof v === "string" && v ? v : null);

/** Active task rows `{ repo_key, dir_name, dir, doc, disposition }` and the repos' main roots, from the database. */
function loadTasks({ includeArchived, repoKey } = {}) {
  const db = require("./db");
  const taskLib = require("./task");
  const mainRoots = {};
  for (const r of db.listRepos()) mainRoots[r.key] = r.main_root || null;
  const rows = [];
  const dispositions = includeArchived ? ["active", "archived"] : ["active"];
  const want = repoKey === undefined || repoKey === null ? null : require("./db").storedKey(repoKey);
  for (const disposition of dispositions) {
    for (const r of db.listTasks({ disposition })) {
      if (want !== null && r.repo_key !== want) continue;
      try { rows.push({ repo_key: r.repo_key, dir_name: r.dir_name, dir: r.task_dir, doc: taskLib.readTaskJson(r.task_dir), disposition: r.disposition, row: r }); } catch {}
    }
  }
  return { rows, mainRoots };
}

/** The advice for a task row; a task whose facts cannot be read gets none. */
function adviceFor(doc, dir, mainRoot) {
  try {
    const advise = require("./advise");
    return advise.advise(doc, advise.factsFor(dir, doc, { mainRoot: mainRoot && fs.existsSync(mainRoot) ? mainRoot : null }));
  } catch {
    return null;
  }
}

function liveInfo(reg, zmxName) {
  return {
    session_id: reg.session_id,
    terminal_id: reg.terminal_id || null,
    agent: reg.agent || null,
    pid: reg.pid || null,
    mux: zmxName ? { kind: "zmx", name: zmxName } : null,
    state: "live",
    cwd: reg.cwd || null,
  };
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

// Recency is `max(at)` over the task's intent events, not a stored word.
function isRecentAt(at) {
  const stamp = Date.parse(at);
  return Number.isFinite(stamp) && Date.now() - stamp <= RECENT_MS;
}

function checkoutGone(mainRoot, goneCache) {
  if (typeof mainRoot !== "string") return false;
  if (!goneCache.has(mainRoot)) goneCache.set(mainRoot, !fs.existsSync(mainRoot));
  return goneCache.get(mainRoot);
}

/**
 * Build the roster. By default a task is listed when a live session is bound to it, or
 * when it is not done, was written in the last 7 days and its repo's checkout exists.
 * @param {{ repoKey?: string, all?: boolean }} [opts] - `repoKey` limits to one repo; `all` lists every active task
 * @returns {{ tasks: object[], sessions: object[] }}
 */
function build(opts = {}) {
  const start = require("./start");
  const session = require("./session");
  const { rows, mainRoots } = loadTasks({ includeArchived: opts.includeArchived, repoKey: opts.repoKey });
  const zmx = start.zmxSessions();

  const live = [];
  for (const reg of session.list()) {
    const { live: isLive, zmxName } = start.liveSession(reg, zmx);
    if (isLive) live.push({ reg, zmxName });
  }
  live.sort((a, b) => String(b.reg.created_at || "").localeCompare(String(a.reg.created_at || "")));

  const goneCache = new Map();
  const bound = new Set();
  const tasks = [];
  for (const row of rows) {
    const doc = row.doc;
    const mainRoot = mainRoots[row.repo_key] || null;
    const dir = path.resolve(row.dir);
    const mine = live.filter((l) => l.reg.task_dir && path.resolve(l.reg.task_dir) === dir);
    // a dispatched run is the Conductor's agent, so the Conductor stays the task's live session
    const owner = mine.find((l) => l.reg.origin !== "dispatch") || mine[0];
    for (const l of mine) bound.add(l.reg.session_id);
    const derive = require("./derive");
    const recency = require("./db").intentRecency(row.row.id);
    const status = derive.taskStatusOf(row.row, doc, { boundLive: Boolean(owner) });
    if (!opts.all && !owner && (status === "done" || !isRecentAt(recency.at) || checkoutGone(mainRoot, goneCache))) continue;
    const phase = currentPhase(doc) || {};
    const advice = adviceFor(doc, row.dir, mainRoot);
    tasks.push({
      repo_key: row.repo_key,
      main_root: mainRoot,
      number: Number.isInteger(doc.number) ? doc.number : null,
      slug: strOrNull(doc.slug),
      dir: row.dir,
      title: strOrNull(doc.title),
      status,
      tier: doc.tier || "standard",
      mode: strOrNull(doc.mode),
      advice,
      attention: advice !== null && advice.question !== null,
      warnings: [],
      live: owner ? liveInfo(owner.reg, owner.zmxName) : null,
      branch: strOrNull(doc.branch),
      worktree: strOrNull(doc.worktree_path),
      landed_sha: null,
      disposition: row.disposition || "active",
      updated: strOrNull(recency.at),
    });
  }
  tasks.sort((a, b) => a.repo_key.localeCompare(b.repo_key) || (a.number || 0) - (b.number || 0));

  const sessions = live
    .filter((l) => !bound.has(l.reg.session_id) && (!opts.repoKey || l.reg.repo_key === opts.repoKey))
    .map((l) => ({ ...liveInfo(l.reg, l.zmxName), repo_key: l.reg.repo_key || null, task_dir: l.reg.task_dir || null }));
  return { tasks, sessions };
}

const dirName = (t) => path.basename(t.dir);

function liveText(live) {
  return live ? `${live.agent || "session"} ${live.mux ? live.mux.name : `pid ${live.pid}`}` : "";
}

/** One line per task of `data`, grouped by repo; a repo whose checkout is gone says so in its header. */
function formatText(data) {
  const lines = [];
  const shown = data.tasks;
  let repo = null;
  const width = Math.max(0, ...shown.map((t) => dirName(t).length));
  for (const t of shown) {
    if (t.repo_key !== repo) {
      repo = t.repo_key;
      const missing = t.main_root && !fs.existsSync(t.main_root) ? ", missing" : "";
      lines.push(`${repo}${t.main_root ? ` (${t.main_root}${missing})` : ""}`);
    }
    const step = t.advice ? t.advice.move : "-";
    const attention = t.attention ? " !" : "";
    lines.push(`${dirName(t).padEnd(width)}  ${String(t.status).padEnd(10)}  ${step}${attention}${t.live ? `  [${liveText(t.live)}]` : ""}`);
  }
  if (data.sessions.length > 0) {
    lines.push("Sessions bound to no task");
    for (const s of data.sessions) {
      lines.push(`  ${s.session_id.slice(0, 8)}  ${liveText(s)}  ${s.cwd || "-"}`);
    }
  }
  if (lines.length === 0) lines.push("No active tasks.");
  return lines.join("\n");
}

/** Detail view of one task row. */
function formatTask(row, doc) {
  const lines = [`${dirName(row)}  ${row.title || ""}`, `status: ${row.status}  tier: ${row.tier}  mode: ${row.mode}`];
  for (const p of phasesOf(doc)) lines.push(`  ${p.id}  ${p.name}  [${p.checked ? (p.skipped ? "skipped" : "checked") : "open"}]`);
  if (row.advice) {
    lines.push(`next: ${row.advice.advice}`);
    if (row.advice.question) lines.push(`question: ${row.advice.question.text}`);
    for (const w of row.advice.warnings) lines.push(`warning: ${w}`);
  } else {
    lines.push("next: none");
  }
  lines.push(row.live ? `live: ${liveText(row.live)} (session ${row.live.session_id.slice(0, 8)})` : "live: no session");
  if (row.worktree) lines.push(`worktree: ${row.worktree}`);
  return lines.join("\n");
}

module.exports = { build, formatText, formatTask };
