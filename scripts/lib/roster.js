"use strict";

// `a ls`: the roster from one database read — the active tasks with their
// derived status, advice and landing, and every live session on its own row
// (a done task's session included). The slow git facts go through derive's
// cache; liveness costs one pid probe per session row, one batched `ps` and
// one `zmx list`. There is no registration-directory scan. The PAV fields —
// `repos`, the phase counts, `resumable`, the sessions' `origin` and
// `main_root`, `ended_sessions` — come from the database alone: no fs walk,
// no git, no `gh`. `repos` alone stats one main_root per row: a repo whose
// checkout is gone drops out unless an active task holds it.

const fs = require("fs");
const path = require("path");

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

const isRecentAt = (at) => {
  const stamp = Date.parse(at);
  return Number.isFinite(stamp) && Date.now() - stamp <= RECENT_MS;
};

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** A session row's registration fields, with mux and pid_at from its doc. */
function regOfRow(row) {
  let doc = {};
  try { doc = JSON.parse(row.doc || "{}"); } catch { doc = {}; }
  return {
    session_id: row.session_id, terminal_id: row.terminal_id, repo_key: row.repo_key,
    task_dir: row.task_dir, agent: row.agent, origin: doc.origin || row.origin || null,
    cwd: row.cwd, pid: row.pid, created_at: row.created_at, ended_at: row.ended_at,
    mux: doc.mux || null, pid_at: doc.pid_at || null,
  };
}

/**
 * The liveness of the open session rows: one isPidAlive per pid, one batched
 * `ps` for every alive pid's command line and start time (the identity check of
 * session.isLive, skipped under AGENTS_TEST_SKIP_IDENTITY), and the zmx names.
 * Returns a function row -> { live, zmxName }.
 */
function livenessFn(rows, zmx) {
  const session = require("./session");
  const { spawnSync } = require("child_process");
  const names = (zmx || []).filter((z) => !z.ended).map((z) => z.name);
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const alivePids = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.pid || seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (session.isPidAlive(row.pid)) alivePids.push(row.pid);
  }
  const identity = new Map(); // pid -> "lstart command" (or null when ps knows nothing)
  if (process.env.AGENTS_TEST_SKIP_IDENTITY !== "1" && alivePids.length > 0) {
    try {
      const out = spawnSync("ps", ["-o", "pid=,lstart=,command=", "-p", alivePids.join(",")],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
      if (out.status === 0) {
        for (const line of (out.stdout || "").split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(.+)$/);
          if (m) identity.set(Number(m[1]), m[2]);
        }
      }
    } catch { /* ps failed: no identity facts */ }
  }
  const zmxLive = (reg) => {
    if (reg.mux && reg.mux.kind === "zmx" && reg.mux.name) return names.includes(reg.mux.name) ? reg.mux.name : null;
    if (!reg.mux && reg.session_id) {
      const re = new RegExp(`-${escapeRe(String(reg.session_id).slice(0, 8))}(-r\\d+)?$`);
      return names.find((n) => re.test(n)) || null;
    }
    return null;
  };
  return (row) => {
    const reg = regOfRow(row);
    const name = zmxLive(reg);
    if (reg.ended_at) return { live: false, zmxName: null, reg };
    // a session is live when its pid passes the identity checks or its zmx session is listed
    let byPid = false;
    if (reg.pid && session.isPidAlive(reg.pid)) {
      if (process.env.AGENTS_TEST_SKIP_IDENTITY === "1") {
        byPid = true;
      } else {
        const line = identity.get(reg.pid);
        if (line !== undefined) {
          const m = line.match(/^(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/);
          if (m && !m[2].includes("bg-spare") && m[2].includes("claude")) {
            byPid = true;
            if (reg.pid_at || reg.created_at) {
              const procStart = new Date(m[1]).getTime();
              const limit = reg.pid_at ? new Date(reg.pid_at).getTime() + 1000 : new Date(reg.created_at).getTime();
              if (!isNaN(procStart) && !isNaN(limit) && procStart > limit) byPid = false;
            }
          }
        }
      }
    }
    return { live: byPid || name !== null, zmxName: name, reg };
  };
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

function currentPhaseOf(task) {
  const derive = require("./derive");
  const phases = Array.isArray(task.phases) ? task.phases : [];
  return derive.currentPhaseOf(task) || phases[phases.length - 1] || null;
}

function liveInfo(reg, zmxName) {
  const derive = require("./derive");
  return {
    session_id: reg.session_id,
    agent: reg.agent || null,
    pid: reg.pid || null,
    mux: zmxName ? { kind: "zmx", name: zmxName } : null,
    cwd: reg.cwd || null,
    session_state: derive.sessionState(reg, { alive: true, zmxLive: zmxName !== null }),
  };
}

function checkoutGone(mainRoot, goneCache) {
  if (typeof mainRoot !== "string") return false;
  if (!goneCache.has(mainRoot)) goneCache.set(mainRoot, !fs.existsSync(mainRoot));
  return goneCache.get(mainRoot);
}

/**
 * The repo keys that hold an active task row — the repos a moved checkout
 * cannot hide. One database read, no stats.
 */
function activeTaskRepos() {
  return new Set(require("./db").listTasks({ disposition: "active" }).map((r) => r.repo_key));
}

/**
 * The repos rows the roster leaves out of `repos`: the checkout is gone and
 * no active task holds the repo. `a doctor` names these; no row is deleted.
 */
function goneRepos() {
  const goneCache = new Map();
  const active = activeTaskRepos();
  return require("./db").listRepos().filter((r) => checkoutGone(r.main_root, goneCache) && !active.has(r.key));
}

/** True when ended row `a` is the newer: the greater ended_at, ties by updated_at. */
function endedNewer(a, b) {
  const ms = (row, col) => {
    const t = Date.parse(row[col] || "");
    return Number.isFinite(t) ? t : 0;
  };
  return ms(a, "ended_at") > ms(b, "ended_at")
    || (ms(a, "ended_at") === ms(b, "ended_at") && ms(a, "updated_at") > ms(b, "updated_at"));
}

/**
 * The newest ended Conductor/Courier session per resolved task dir (the agent is
 * stored lowercased), the resumable lookup's one pass over the ended rows.
 */
function endedResumeMap(endedRows) {
  const byDir = new Map();
  for (const row of endedRows) {
    if (!row.ended_at || !row.task_dir) continue;
    const agent = String(row.agent || "").toLowerCase();
    if (agent !== "conductor" && agent !== "courier") continue;
    const dir = path.resolve(row.task_dir);
    const prev = byDir.get(dir);
    if (!prev || endedNewer(row, prev)) byDir.set(dir, row);
  }
  return byDir;
}

/** A resume row as the payload serves it, or null. */
function resumableOf(row) {
  return row ? { session_id: row.session_id, agent: row.agent || null, ended_at: row.ended_at, cwd: row.cwd || null } : null;
}

/** The view's phase counts: checked phases (a checkmark or a skip decision) and all of them. */
function phaseCounts(view) {
  const phases = Array.isArray(view && view.phases) ? view.phases : [];
  return { checked: phases.filter((p) => p.checked).length, total: phases.length };
}

/**
 * Build the roster. By default a task is listed when it is not done and either
 * a live session is bound to it or it has an intent event within 7 days and
 * its repo's checkout exists; `--all` lists every active task. Every value in
 * the payload comes from the database; `repos` adds one stat per row (a repo
 * whose main_root is gone drops out unless it holds an active task).
 * @param {{ repoKey?: string, all?: boolean, includeArchived?: boolean }} [opts]
 * @returns {{ data_version: number, generated_at: string, repos: object[], tasks: object[],
 *   sessions: object[], ended_sessions: object[] }}
 */
function build(opts = {}) {
  const db = require("./db");
  const taskLib = require("./task");
  const derive = require("./derive");
  const adviseLib = require("./advise");
  const start = require("./start");

  const repoRows = db.listRepos();
  const mainRoots = {};
  for (const r of repoRows) mainRoots[r.key] = r.main_root || null;
  const activeRepos = activeTaskRepos();
  const want = opts.repoKey === undefined || opts.repoKey === null ? null : db.storedKey(opts.repoKey);

  const sessionRows = db.listSessions();
  const openRows = sessionRows.filter((r) => !r.ended_at);
  const endedRows = sessionRows.filter((r) => r.ended_at);
  const resumeByDir = endedResumeMap(endedRows);
  const liveOf = livenessFn(openRows, start.zmxSessions());
  const live = openRows.map((r) => ({ row: r, ...liveOf(r) })).filter((x) => x.live);
  live.sort((a, b) => String(b.reg.created_at || "").localeCompare(String(a.reg.created_at || "")));

  const tasks = [];
  const goneCache = new Map();
  const dispositions = opts.includeArchived ? ["active", "archived"] : ["active"];
  for (const disposition of dispositions) {
    for (const row of db.listTasks({ disposition })) {
      if (want !== null && row.repo_key !== want) continue;
      let view;
      try { view = taskLib.readTaskJson(row.task_dir); } catch { continue; }
      const mainRoot = mainRoots[row.repo_key] || null;
      const dir = path.resolve(row.task_dir);
      const mine = live.filter((l) => l.reg.task_dir && path.resolve(l.reg.task_dir) === dir);
      // a dispatched run is the Conductor's agent, so the Conductor stays the task's live session
      const owner = mine.find((l) => l.reg.origin !== "dispatch") || mine[0];
      const recency = db.intentRecency(row.id);
      const status = derive.taskStatusOf(row, view, { boundLive: Boolean(owner) });
      if (!opts.all && !owner && (status === "done" || !isRecentAt(recency.at) || checkoutGone(mainRoot, goneCache))) continue;

      const advice = adviseLib.advise(view, adviseLib.factsFor(row.task_dir, view, { mainRoot: mainRoot && fs.existsSync(mainRoot) ? mainRoot : null, boundSessions: mine.length }));
      const phase = currentPhaseOf(view) || {};
      const landing = derive.allChecked(view) ? derive.landingOfTask(row, view) : null;
      const counts = phaseCounts(view);
      tasks.push({
        repo_key: row.repo_key,
        main_root: mainRoot,
        number: Number.isInteger(view.number) ? view.number : null,
        slug: view.slug || null,
        dir: row.task_dir,
        title: view.title || null,
        tier: view.tier || "standard",
        mode: view.mode || null,
        task_status: status,
        phases_checked: counts.checked,
        phases_total: counts.total,
        current_phase: {
          id: phase.id === undefined ? null : phase.id,
          name: phase.name || null,
          plan_file: phase.plan_path || null,
          approved: Boolean(advice.phase && advice.phase.approved),
          accepted: Boolean(advice.phase && advice.phase.accepted),
        },
        advice: {
          move: advice.move,
          text: advice.advice,
          question: advice.question,
          warnings: advice.warnings,
        },
        approvals: advice.approvals,
        migrated: advice.migrated,
        attention: advice.question !== null,
        landing,
        live: owner ? liveInfo(owner.reg, owner.zmxName) : null,
        resumable: resumableOf(resumeByDir.get(dir)),
        worktree: view.worktree_path || null,
        branch: view.branch || null,
        updated: recency.at,
      });
    }
  }
  tasks.sort((a, b) => a.repo_key.localeCompare(b.repo_key) || (a.number || 0) - (b.number || 0));

  // every live session on its own row, bound or not, with its task's facts
  const byDir = new Map(tasks.map((t) => [path.resolve(t.dir), t]));
  const taskRows = new Map();
  for (const row of db.listTasks()) taskRows.set(path.resolve(row.task_dir), row);
  const sessions = live
    .filter((l) => !want || db.storedKey(l.reg.repo_key || "") === want)
    .map((l) => {
      const taskDir = l.reg.task_dir ? path.resolve(l.reg.task_dir) : null;
      const listed = byDir.get(taskDir) || null;
      const row = taskRows.get(taskDir) || null;
      let number = null;
      let taskStatus = null;
      if (listed) {
        number = listed.number;
        taskStatus = listed.task_status;
      } else if (row) {
        try {
          const view = taskLib.readTaskJson(row.task_dir);
          number = Number.isInteger(view.number) ? view.number : null;
          taskStatus = derive.taskStatusOf(row, view, { boundLive: true });
        } catch { /* no view: no task facts */ }
      }
      return {
        ...liveInfo(l.reg, l.zmxName),
        repo_key: l.reg.repo_key || null,
        task_dir: l.reg.task_dir || null,
        origin: l.reg.origin,
        main_root: mainRoots[l.reg.repo_key] || null,
        task_number: number,
        task_status: taskStatus,
      };
    });

  // the rows ended inside the window, newest first, bound or not
  const generatedAt = new Date().toISOString();
  const generatedMs = Date.parse(generatedAt);
  const endedSessions = endedRows
    .filter((r) => {
      const t = Date.parse(r.ended_at);
      return Number.isFinite(t) && generatedMs - t <= ENDED_WINDOW_MS;
    })
    .sort((a, b) => (endedNewer(a, b) ? -1 : endedNewer(b, a) ? 1 : 0))
    .map((r) => ({ session_id: r.session_id, task_dir: r.task_dir || null, agent: r.agent || null, ended_at: r.ended_at }));

  return {
    data_version: db.maxEventId(),
    generated_at: generatedAt,
    repos: repoRows.filter((r) => !checkoutGone(r.main_root, goneCache) || activeRepos.has(r.key))
      .map((r) => ({ repo_key: r.key, main_root: r.main_root || null })),
    tasks,
    sessions,
    ended_sessions: endedSessions,
  };
}

// ---------------------------------------------------------------------------
// One task's detail (a ls <task>, a task read)
// ---------------------------------------------------------------------------

/**
 * The full view of one task: its roster row plus the phases (after, checked,
 * skipped, plan file and hash, approved, accepted), the decisions with their
 * gate, the notes and the last land event.
 */
function taskDetail(taskDir, { repoKeyObj } = {}) {
  const db = require("./db");
  const taskLib = require("./task");
  const derive = require("./derive");
  const adviseLib = require("./advise");
  const row = taskLib.taskRowOf(taskDir);
  if (!row) return null;
  const view = taskLib.viewOf(row);
  // The task's own repo row first; the caller's key (a relative name's repo) only as its fallback.
  const mainRoot = (db.repoOf(row.repo_key) || {}).main_root || (repoKeyObj && repoKeyObj.main_root) || null;

  // the task's live session (the dispatch-origin rule), for the row, its status and the facts
  const sessionRows = db.listSessions();
  const openRows = sessionRows.filter((r) => !r.ended_at);
  const liveOf = livenessFn(openRows, require("./start").zmxSessions());
  const here = path.resolve(row.task_dir);
  const mine = openRows.map((r) => ({ r, ...liveOf(r) }))
    .filter((x) => x.live && x.reg.task_dir && path.resolve(x.reg.task_dir) === here);
  const owner = mine.find((x) => x.reg.origin !== "dispatch") || mine[0] || null;
  const resumeByDir = endedResumeMap(sessionRows.filter((r) => r.ended_at));

  const facts = adviseLib.factsFor(row.task_dir, view, { mainRoot: mainRoot && fs.existsSync(mainRoot) ? mainRoot : null, boundSessions: mine.length });

  const base = buildRow(row, view, facts, mainRoot, { boundLive: Boolean(owner), resumable: resumableOf(resumeByDir.get(here)) });
  base.live = owner ? liveInfo(owner.reg, owner.zmxName) : null;
  const decisions = db.listDecisions({ taskId: row.id });
  const lastOf = (phaseId, ...choices) => {
    const rows = decisions.filter((d) => d.phase_id === phaseId && choices.includes(d.choice));
    return rows.length > 0 ? rows[rows.length - 1] : null;
  };
  const phases = view.phases.map((p) => {
    const planHash = (facts.planHash || {})[p.id] || null;
    const verdict = lastOf(p.id, "approve", "reject");
    return {
      id: p.id, name: p.name,
      after: Array.isArray(p.blocked_by) ? p.blocked_by : [],
      checked: Boolean(p.checked), checked_at: p.checked_at || null, checked_by: p.checked_by || null,
      skipped: Boolean(p.skipped),
      plan_file: p.plan_path || null,
      plan_hash: planHash,
      approved: verdict !== null && verdict.choice === "approve" && planHash !== null && verdict.plan_hash === planHash,
      accepted: lastOf(p.id, "accept") !== null,
    };
  });
  const land = db.lastLandEvent(row.id);
  return {
    ...base,
    phases,
    decisions: decisions.map((d) => ({
      decision_id: d.decision_id, phase_id: d.phase_id, choice: d.choice, gate: d.gate || null,
      plan_hash: d.plan_hash || null, quote: d.quote, recorded_by: d.recorded_by || null, decided_at: d.decided_at,
    })),
    notes: db.listNotes(row.id).map((n) => ({ note_id: n.note_id, phase_id: n.phase_id === null ? null : n.phase_id, text: n.text, at: n.at })),
    last_land: land ? {
      at: land.at, head: land.head || null, branch: land.branch || null,
      pr_url: land.pr_url || null, migrated: Boolean(land.migrated),
    } : null,
  };
}

/** One task's roster row, sharing build()'s shape (a task the filter would hide still gets its row). */
function buildRow(row, view, facts, mainRoot, { boundLive, resumable = null } = {}) {
  const db = require("./db");
  const derive = require("./derive");
  const adviseLib = require("./advise");
  const advice = adviseLib.advise(view, facts);
  const phase = currentPhaseOf(view) || {};
  const recency = db.intentRecency(row.id);
  const landing = derive.allChecked(view) ? derive.landingOfTask(row, view) : null;
  const counts = phaseCounts(view);
  return {
    repo_key: row.repo_key,
    main_root: mainRoot || null,
    number: Number.isInteger(view.number) ? view.number : null,
    slug: view.slug || null,
    dir: row.task_dir,
    title: view.title || null,
    tier: view.tier || "standard",
    mode: view.mode || null,
    task_status: derive.taskStatusOf(row, view, { boundLive: Boolean(boundLive) }),
    phases_checked: counts.checked,
    phases_total: counts.total,
    current_phase: {
      id: phase.id === undefined ? null : phase.id,
      name: phase.name || null,
      plan_file: phase.plan_path || null,
      approved: Boolean(advice.phase && advice.phase.approved),
      accepted: Boolean(advice.phase && advice.phase.accepted),
    },
    advice: { move: advice.move, text: advice.advice, question: advice.question, warnings: advice.warnings },
    approvals: advice.approvals,
    migrated: advice.migrated,
    attention: advice.question !== null,
    landing,
    live: null,
    resumable,
    worktree: view.worktree_path || null,
    branch: view.branch || null,
    updated: recency.at,
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const dirName = (t) => path.basename(t.dir);

const liveText = (live) => live ? `${live.agent || "session"} ${live.mux ? live.mux.name : `pid ${live.pid}`}` : "";

/** One line per task, grouped by repo; a repo whose checkout is gone says so in its header. */
function formatText(data) {
  const lines = [];
  const shown = data.tasks;
  let repo = null;
  const width = Math.max(0, ...shown.map((t) => dirName(t).length));
  const shownLive = new Set(shown.filter((t) => t.live).map((t) => t.live.session_id));
  for (const t of shown) {
    if (t.repo_key !== repo) {
      repo = t.repo_key;
      const missing = t.main_root && !fs.existsSync(t.main_root) ? ", missing" : "";
      lines.push(`${repo}${t.main_root ? ` (${t.main_root}${missing})` : ""}`);
    }
    const attention = t.attention ? " !" : "";
    const landing = t.landing ? ` · ${t.landing.state}${t.landing.proof ? ` (${t.landing.proof})` : ""}` : "";
    lines.push(`${dirName(t).padEnd(width)}  ${String(t.task_status).padEnd(10)}  ${t.advice.move}${attention}${landing}${t.live ? `  [${liveText(t.live)}]` : ""}`);
  }
  const rest = data.sessions.filter((s) => !shownLive.has(s.session_id));
  if (rest.length > 0) {
    lines.push("Live sessions");
    for (const s of rest) {
      const on = s.task_dir ? ` on ${path.basename(s.task_dir)}` : "";
      lines.push(`  ${String(s.session_id).slice(0, 8)}  ${liveText(s)}${on}  ${s.cwd || "-"}`);
    }
  }
  if (lines.length === 0) lines.push("No active tasks.");
  return lines.join("\n");
}

/** Detail view of one task. */
function formatTask(row) {
  const lines = [`${dirName(row)}  ${row.title || ""}`, `status: ${row.task_status}  tier: ${row.tier}  mode: ${row.mode}`];
  for (const p of row.phases) {
    lines.push(`  ${p.id}  ${p.name || "(unnamed)"}  [${p.skipped ? "skipped" : p.checked ? "checked" : "open"}]`);
  }
  if (row.advice) {
    lines.push(`next: ${row.advice.text}`);
    if (row.advice.question) lines.push(`question: ${row.advice.question.text}`);
    for (const w of row.advice.warnings) lines.push(`warning: ${w}`);
  } else {
    lines.push("next: none");
  }
  if (row.landing) lines.push(`landing: ${row.landing.state}${row.landing.proof ? ` (${row.landing.proof})` : ""}${row.landing.reason ? ` — ${row.landing.reason}` : ""}`);
  lines.push(row.live ? `live: ${liveText(row.live)} (session ${String(row.live.session_id).slice(0, 8)})` : "live: no session");
  if (row.worktree) lines.push(`worktree: ${row.worktree}`);
  return lines.join("\n");
}

module.exports = { build, taskDetail, formatText, formatTask, regOfRow, livenessFn, goneRepos };
