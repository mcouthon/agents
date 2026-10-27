"use strict";

// `a ls`: active tasks as roster entries (by default those with a live session or
// written in the last 7 days; see build), with the live session bound to each, plus
// the live sessions bound to no task.

const fs = require("fs");
const path = require("path");

const TERMINAL_PHASE = new Set(["done", "failed", "skipped"]);

function phasesOf(doc) {
  return Array.isArray(doc.phases) ? doc.phases.filter((p) => p && typeof p === "object") : [];
}

// First phase not done/failed/skipped, else the last one.
function currentPhase(doc) {
  const phases = phasesOf(doc);
  return phases.find((p) => !TERMINAL_PHASE.has(p.status)) || phases[phases.length - 1] || null;
}

function openCheckpoint(doc) {
  const cps = Array.isArray(doc.checkpoints) ? doc.checkpoints.filter((c) => c && typeof c === "object") : [];
  for (let i = cps.length - 1; i >= 0; i--) if (!cps[i].resolved_at) return cps[i];
  return null;
}

const strOrNull = (v) => (typeof v === "string" && v ? v : null);

/** Active task rows `{ repo_key, dir_name, dir, doc }` and the repos' main roots, from the database or the task files. */
function loadTasks() {
  const db = require("./db");
  if (db.enabled()) {
    const mainRoots = {};
    for (const r of db.listRepos()) mainRoots[r.key] = r.main_root || null;
    const rows = [];
    for (const r of db.listTasks({ disposition: "active" })) {
      try { rows.push({ repo_key: r.repo_key, dir_name: r.dir_name, dir: r.task_dir, doc: JSON.parse(r.doc) }); } catch {}
    }
    return { rows, mainRoots };
  }
  const { tasksRootBase, readRootIndex } = require("./tasks-root");
  const base = tasksRootBase();
  const rows = [];
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || (rel === "" && (name === "archive" || name === "trash"))) continue;
      const sub = path.join(dir, name);
      let isDir = false;
      try { isDir = fs.statSync(sub).isDirectory(); } catch {}
      if (!isDir) continue;
      const taskJson = path.join(sub, "task.json");
      if (fs.existsSync(taskJson)) {
        try { rows.push({ repo_key: rel, dir_name: name, dir: sub, doc: JSON.parse(fs.readFileSync(taskJson, "utf8")) }); } catch {}
      } else {
        walk(sub, rel ? `${rel}/${name}` : name);
      }
    }
  };
  walk(base, "");
  const index = readRootIndex();
  const mainRoots = {};
  for (const [key, entry] of Object.entries(index)) mainRoots[key] = (entry && entry.main_root) || null;
  return { rows, mainRoots };
}

function repoContext(mainRoot, cache) {
  if (cache.has(mainRoot)) return cache.get(mainRoot);
  let ctx = null;
  if (mainRoot && fs.existsSync(mainRoot)) {
    try {
      const nextLib = require("./next");
      ctx = {
        projectDir: mainRoot,
        policy: require("./policy").resolvePolicy(mainRoot),
        gitFacts: nextLib.collectGitFacts(mainRoot),
      };
    } catch {}
  }
  cache.set(mainRoot, ctx);
  return ctx;
}

function nextFor(doc, dir, repoCtx) {
  if (doc.status === "done") return null;
  try {
    const result = require("./next").computeNext(doc, { ...(repoCtx || {}), taskDir: dir });
    const how = result.how && result.how.tool ? `${result.how.tool} — ${result.how.command}` : null;
    return { step: result.step, agent: result.agent || null, how };
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

function isRecent(doc) {
  const stamp = Date.parse(doc.updated);
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
  const { rows, mainRoots } = loadTasks();
  const zmx = start.zmxSessions();

  const live = [];
  for (const reg of session.list()) {
    const { live: isLive, zmxName } = start.liveSession(reg, zmx);
    if (isLive) live.push({ reg, zmxName });
  }
  live.sort((a, b) => String(b.reg.created_at || "").localeCompare(String(a.reg.created_at || "")));

  const cache = new Map();
  const goneCache = new Map();
  const bound = new Set();
  const tasks = [];
  for (const row of rows) {
    if (opts.repoKey && row.repo_key !== opts.repoKey) continue;
    const doc = row.doc;
    const mainRoot = mainRoots[row.repo_key] || null;
    const dir = path.resolve(row.dir);
    const mine = live.filter((l) => l.reg.task_dir && path.resolve(l.reg.task_dir) === dir);
    // a dispatched run is the Conductor's agent, so the Conductor stays the task's live session
    const owner = mine.find((l) => l.reg.origin !== "dispatch") || mine[0];
    for (const l of mine) bound.add(l.reg.session_id);
    if (!opts.all && !owner && (doc.status === "done" || !isRecent(doc) || checkoutGone(mainRoot, goneCache))) continue;
    const phase = currentPhase(doc) || {};
    const checkpoint = openCheckpoint(doc);
    const next = nextFor(doc, row.dir, repoContext(mainRoot, cache));
    const guards = [];
    for (const w of Array.isArray(phase.warnings) ? phase.warnings : []) {
      if (w && typeof w.guard === "string" && !guards.includes(w.guard)) guards.push(w.guard);
    }
    tasks.push({
      repo_key: row.repo_key,
      main_root: mainRoot,
      number: Number.isInteger(doc.number) ? doc.number : null,
      slug: strOrNull(doc.slug),
      dir: row.dir,
      title: strOrNull(doc.title),
      status: strOrNull(doc.status),
      tier: doc.tier || "standard",
      mode: strOrNull(doc.mode),
      next,
      checkpoint: checkpoint ? { question: checkpoint.question, options: checkpoint.options } : null,
      attention: checkpoint !== null || (next !== null && next.step === "blocked"),
      warnings: guards,
      live: owner ? liveInfo(owner.reg, owner.zmxName) : null,
      branch: strOrNull(phase.branch),
      worktree: strOrNull(doc.worktree_path),
      landed_sha: strOrNull(phase.landed_sha),
      disposition: "active",
      updated: strOrNull(doc.updated),
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
    const step = t.next ? t.next.step : "-";
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
  for (const p of phasesOf(doc)) lines.push(`  ${p.id}  ${p.name}  [${p.status}]`);
  if (row.next) lines.push(`next: ${row.next.step}${row.next.agent ? ` (${row.next.agent})` : ""}${row.next.how ? ` — ${row.next.how}` : ""}`);
  else lines.push("next: none");
  if (row.checkpoint) lines.push(`checkpoint: ${row.checkpoint.question}`);
  lines.push(row.live ? `live: ${liveText(row.live)} (session ${row.live.session_id.slice(0, 8)})` : "live: no session");
  if (row.worktree) lines.push(`worktree: ${row.worktree}`);
  return lines.join("\n");
}

module.exports = { build, formatText, formatTask };
