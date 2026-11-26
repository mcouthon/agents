"use strict";

// What to do next on a task, derived from its phases, the owner's recorded words and git.
// `advise` is pure; `factsFor` is the impure collector that feeds it: the index
// half reads the database (checkmarks, decisions, notes), the cached half goes
// through derive.js (refs, commits, landing). Nothing here refuses.

const last = (rows) => (rows.length > 0 ? rows[rows.length - 1] : null);

/**
 * The end of a stacked task whose phases are all checked, from `facts.stack`: close once every
 * PR is merged, land when a phase was checked since the last land or a merged PR left the one
 * above it on a stale base, else drive the open PRs.
 */
function stackEnd(f, out, warnings) {
  const { landed, checkedSince, layers, ghFailed } = f.stack;
  if (landed) return out("close", "Every phase is checked and every PR is merged; close the task.");
  if (checkedSince) return out("land", "Every phase is checked; land the task.");
  const lower = layers.find((l) => l.merged && layers.some((u) => !u.merged && u.base === l.ref));
  if (lower) return out("land", `${lower.ref}'s PR merged: land again so the PRs above restack onto ${f.base}.`);
  if (ghFailed) warnings.push(`could not ask GitHub whether the PRs merged (${ghFailed}); a merged one reads as open`);
  const open = layers.filter((l) => !l.merged && l.pr_url).map((l) => `${l.group}: ${l.pr_url}`).join(", ");
  return out("drive", `Every phase is landed; drive the open PRs to ready (${open}); the task closes once every PR is merged.`);
}

function isCheckedPhase(p, decisions) {
  return p.checked === true || decisions.some((d) => d.phase_id === p.id && d.choice === "skip");
}

function readyPhaseIds(phases, decisions) {
  const ids = new Set(phases.map((p) => p.id));
  const checked = phases.filter((p) => isCheckedPhase(p, decisions)).map((p) => p.id);
  const isDone = (id) => !ids.has(id) || checked.includes(id);
  return phases.filter((p) => !checked.includes(p.id) && (p.blocked_by || []).every(isDone)).map((p) => p.id);
}

/**
 * @param {object} task the view from task.js (phases carry `checked`/`skipped`)
 * @param {object} facts see factsFor
 * @returns {{phase: object|null, move: string, advice: string, question: object|null, approvals: string,
 *   migrated: boolean, worktree: string|null, ready: number[], checked: number[], warnings: string[],
 *   policy: string, base: string|null, review_base: string|null, prs: {group: string, url: string, merged: boolean}[]|null}}
 */
function advise(task, facts) {
  const f = facts || {};
  const phases = Array.isArray(task.phases) ? task.phases : [];
  const decisions = f.decisions || [];
  const rowsOf = (id, ...choices) => decisions.filter((d) => d.phase_id === id && choices.includes(d.choice));
  const knob = task.knobs && task.knobs.approvals;
  const approvals = knob === "ask" ? "ask" : "none";
  const migrated = knob !== "ask" && knob !== "none";
  const ids = new Set(phases.map((p) => p.id));
  const warnings = [];

  const isChecked = (p) => isCheckedPhase(p, decisions);
  const checked = phases.filter(isChecked).map((p) => p.id);
  for (const p of phases) {
    for (const b of p.blocked_by || []) if (!ids.has(b)) warnings.push(`phase ${p.id} waits on phase ${b}, which does not exist`);
    const matches = (f.planCounts || {})[p.id] || 0;
    if (matches > 1) warnings.push(`phase ${p.id} has ${matches} plan files`);
  }
  const ready = readyPhaseIds(phases, decisions);

  if ((f.boundSessions || 0) > 1) warnings.push("two sessions are bound to this task");
  if (f.setup && f.setup.state === "pending") warnings.push("worktree setup is pending: wait for it (`a setup wait`) before build or test");
  if (f.setup && f.setup.state === "failed") warnings.push("worktree setup failed: fix it, then `a setup run <worktree>`");
  for (const p of phases) {
    if (!p.checked || !p.checked_at) continue;
    if ((f.checkedCommits || {})[p.id] === 0) warnings.push(`phase ${p.id} is checked but has no commits`);
  }

  const unlanded = f.unlanded || 0;
  const landMode = (task.knobs && task.knobs.land) || (f.policy === "pr" ? "at_end" : "per_phase");
  const out = (move, advice, extra = {}) => ({
    phase: null, move, advice, question: null, approvals, migrated, worktree: f.worktree || null,
    setup: f.setup || null,
    ready, checked, warnings, policy: f.policy || "unlisted", base: f.base || null,
    review_base: f.reviewBase || (f.base ? `origin/${f.base}` : null), prs: f.prs || null, ...extra,
  });

  if (phases.length === 0) {
    return out("phases", `Task has no phases: ask the owner which phases it needs, then add them.`, {
      question: { text: `What phases should ${task.number ? `task ${task.number}` : "the task"} have?`, choices: ["answer"] },
    });
  }
  if (checked.length === phases.length) {
    if (f.stack) return stackEnd(f, out, warnings);
    return unlanded > 0
      ? out("land", "Every phase is checked; land the task.")
      : out("close", "Every phase is checked and landed; close the task.");
  }
  if (ready.length === 0) {
    const waiting = phases.filter((p) => !isChecked(p)).map((p) => p.id).join(", ");
    return out("phases", `Phases ${waiting} wait on each other.`, {
      question: { text: `Phases ${waiting} wait on each other; which goes first?`, choices: ["answer"] },
    });
  }

  const p = phases.find((x) => x.id === ready[0]);
  const planAt = (f.planMtime || {})[p.id] || null;
  const planHash = (f.planHash || {})[p.id] || null;
  const hasPlan = planAt !== null;
  const verdict = last(rowsOf(p.id, "approve", "reject"));
  const hashOf = (d) => (d && d.plan_hash !== undefined ? d.plan_hash : null);
  const approved = verdict !== null && verdict.choice === "approve" && planAt !== null && hashOf(verdict) === planHash;
  const rejectCurrent = verdict !== null && verdict.choice === "reject" && planAt !== null && hashOf(verdict) === planHash;
  const accept = last(rowsOf(p.id, "accept"));
  // The commits instant: the phase's latest accept under `ask`, else the C11
  // instant (a decision, another phase's checkmark, the land event, the floor
  // `created`). A plan file's mtime never enters it.
  const since = approvals === "ask"
    ? (accept && accept.decided_at) || null
    : (f.commitsInstant || {})[p.id] || null;
  const commits = since ? ((f.commitsSince || {})[since] || 0) > 0 : false;
  const phase = { id: p.id, name: p.name, pr: p.pr || null, plan_path: (f.planFiles || {})[p.id] || null, plan: hasPlan, approved, accepted: accept !== null, commits };
  const named = `phase ${p.id}${p.name ? ` (${p.name})` : ""}`;
  const move = (m, advice, extra) => out(m, advice, { phase, ...extra });

  const checkedAt = phases.map((x) => x.checked_at).filter(Boolean);
  const landDue = unlanded > 0 && landMode === "per_phase" && (checkedAt.length > 0
    ? checkedAt.some((at) => !f.lastLandAt || at > f.lastLandAt)
    : checked.length > 0 && !approved && !commits);
  if (landDue) return move("land", `Land the checked phases before starting ${named}${f.policy === "pr" ? " (push or update the PR)" : ""}.`);

  if (!hasPlan) return move("plan", `${named} has no plan: dispatch the Explorer to plan it.`);
  // A reject of the current plan reads revise under every approvals knob: it
  // outranks the none branch, which would otherwise say "build".
  if (rejectCurrent) {
    return move("revise", `The owner rejected ${named}'s plan (“${String(verdict.quote).slice(0, 200)}”): send it back to the Explorer.`);
  }
  if (approvals === "none") {
    return commits
      ? move("check", `${named} is committed: mark it checked.`)
      : move("build", `${named} has a plan: build it, review it, then commit it.`);
  }
  if (!approved) {
    return move("approve", `${named} has a plan the owner has not approved.`, {
      question: { text: `Approve the plan for phase ${p.id}?`, choices: ["approve", "reject", "answer"] },
    });
  }
  if (!accept) return move("build", `${named} is approved: build it, review it, then ask the owner to accept it.`);
  return commits
    ? move("check", `${named} is committed: mark it checked.`)
    : move("commit", `${named} is accepted: commit it.`);
}

/**
 * What a stacked pr task adds to the facts: `stack` (the layers and the landing, once every phase is
 * checked), `reviewBase` (the ref the next land's cold review diffs against: the open PR below it,
 * else `origin/<base>`) and `prs` (the layers that have a PR). All null when the task is not stacked.
 * `askGh` lets the landing ask GitHub whether each PR merged.
 */
function stackFactsFor(row, task, context, askGh) {
  const none = { stack: null, reviewBase: null, prs: null };
  if (!row || !context || context.policy !== "pr") return none;
  const derive = require("./derive");
  const stackLib = require("./stack");
  const db = require("./db");
  const phases = Array.isArray(task.phases) ? task.phases : [];
  const lastLand = db.lastLandEvent(row.id);
  const stacked = stackLib.stackOf(phases, lastLand);
  if (!stacked) return none;

  const next = stackLib.nextLayer(phases, stacked.groups, stacked.layers, row.branch || "", context.base, lastLand && lastLand.at);
  const reviewBase = next.layer && next.layer.base !== context.base ? next.layer.base : null;
  const landing = stacked.layers.length > 0 && derive.allChecked(task) ? derive.landingOfTask(row, task, { askGh }) : null;
  const mergedRefs = (landing && landing.merged) || [];
  const layers = stacked.layers.map((l) => ({ group: l.group, ref: l.ref, base: l.base, pr_url: l.pr_url || null, merged: Boolean(l.merged) || mergedRefs.includes(l.ref) }));
  const prs = layers.filter((l) => l.pr_url).map((l) => ({ group: l.group, url: l.pr_url, merged: l.merged }));
  const stack = landing
    ? { landed: landing.state === "landed", checkedSince: Boolean(landing.checkedSince), ghFailed: landing.ghFailed || null, layers }
    : null;
  return { stack, reviewBase, prs: prs.length > 0 ? prs : null };
}

/** The shas of the layer refs the newest land recorded (merged ones included); they hold commits a restack took off HEAD. */
function layerTips(gitCtx, taskId) {
  const db = require("./db");
  const derive = require("./derive");
  if (taskId === null) return [];
  const layers = (db.lastLandEvent(taskId) || {}).layers || [];
  const tips = layers.map((l) => derive.refSha(gitCtx, `refs/heads/${l.ref}`)).filter(Boolean);
  return [...new Set(tips)];
}

/**
 * Per checked phase: the commits authored inside its own window, or null when git
 * cannot say. Oldest window first, so the one cached `git log` is widened once.
 */
function checkedPhaseCommits(row, task, context, phases, decisions, revs) {
  const derive = require("./derive");
  const out = {};
  if (!row) return out;
  const windows = phases
    .filter((p) => p.checked && p.checked_at)
    .map((p) => ({ id: p.id, until: p.checked_at, from: derive.commitsInstantFor(row, task, p.id, decisions, p.checked_at) }))
    .filter((w) => w.from)
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  for (const w of windows) out[w.id] = derive.commitsAuthoredBetween(context.tree, revs, w.from, w.until);
  return out;
}

/**
 * The facts `advise` reads: the plan folders and the database rows (the index
 * half), and the tree's refs, commits and landing through derive's cache (the
 * cached half). `checkedCommits[phase]` is the commit count of a checked phase's own window.
 * @param {string} taskDir
 * @param {object} task
 * @param {{mainRoot?: string, boundSessions?: number, askGh?: boolean}} [ctx] - `askGh` lets a stacked
 *   task's landing ask GitHub whether its PRs merged: set by the one-task callers, never by a listing.
 *   `boundSessions`
 *   is the live bound-session count the roster already holds; without it the
 *   count is read from the sessions table here.
 */
function factsFor(taskDir, task, ctx = {}) {
  const fs = require("fs");
  const path = require("path");
  const derive = require("./derive");
  const taskLib = require("./task");
  const db = require("./db");
  const phases = Array.isArray(task.phases) ? task.phases : [];

  const row = taskLib.taskRowOf(taskDir);
  const planDirs = row ? taskLib.planDirsFor(row, db.pendingFoldOf(row.id)) : [path.join(taskDir, "plan")];
  const planMtime = {};
  const planFiles = {};
  const planCounts = {};
  const planHash = {};
  for (const p of phases) {
    const found = derive.planFileFor(planDirs, p.id);
    planMtime[p.id] = found.file ? fs.statSync(found.file).mtime.toISOString() : null;
    planFiles[p.id] = found.file;
    planCounts[p.id] = found.count;
    planHash[p.id] = found.file ? derive.planHash(fs.readFileSync(found.file, "utf8")) : null;
  }

  let decisions = [];
  let lastLandAt = null;
  const taskId = db.taskIdOf(taskDir);
  if (taskId !== null) {
    decisions = db.listDecisions({ taskId }).map((d) => ({ phase_id: d.phase_id, choice: d.choice, quote: d.quote, decided_at: d.decided_at, plan_hash: d.plan_hash }));
    lastLandAt = db.lastEventAt(taskId, "land");
  }

  // the tree, the policy and the refs, one context for every slow fact
  const shell = { repo_key: null, task_dir: taskDir, dir_name: path.basename(taskDir), worktree_path: null };
  const context = derive.contextOf(row || shell, task, { mainRoot: ctx.mainRoot || null });
  const mainRoot = ctx.mainRoot || (context ? context.mainRoot : require("./tasks-root").mainRootOf(taskDir));
  const worktree = context ? context.worktreePath : null;
  const policy = context ? context.policy : "unlisted";

  // the commits instant of every phase (C11), then the commits themselves
  const commitsInstant = {};
  const commitsSince = {};
  const checkedCommits = {};
  let unlanded = 0;
  if (context && context.gitCtx) {
    for (const p of phases) {
      if (row) commitsInstant[p.id] = derive.commitsInstantFor(row, task, p.id, decisions);
    }
    const head = derive.headSha(context.gitCtx);
    if (head) {
      Object.assign(checkedCommits, checkedPhaseCommits(row, task, context, phases, decisions, [head, ...layerTips(context.gitCtx, taskId)]));
      const current = readyPhaseIds(phases, decisions)[0];
      const at = commitsInstant[current];
      if (at) commitsSince[at] = derive.commitsSince(context.tree, head, at);
      const n = derive.unlandedOf(context.tree, head, context.originBase);
      unlanded = n === null || n === undefined ? 0 : n;
    }
  }

  // The bound-session count: a fact the roster passes from its one sessions
  // read; alone it comes from the sessions table, never the registration walk
  // (the real root holds ~900 registrations).
  let boundSessions = 0;
  if (typeof ctx.boundSessions === "number") {
    boundSessions = ctx.boundSessions;
  } else {
    const session = require("./session");
    const here = path.resolve(taskDir);
    for (const r of db.listSessions()) {
      if (r.ended_at || !r.task_dir || path.resolve(r.task_dir) !== here) continue;
      let pidAt = null;
      try { pidAt = JSON.parse(r.doc || "{}").pid_at || null; } catch { pidAt = null; }
      if (session.isLive({ pid: r.pid, ended_at: null, pid_at: pidAt, created_at: r.created_at })) boundSessions++;
    }
  }

  // The worktree's bootstrap state, only when the task has a worktree: the
  // pending/failed record the agent must respect before building (prime's
  // setup field). Lazy-required; resolve never throws.
  let setup = null;
  if (worktree) {
    try {
      const st = require("./setup").resolve(worktree);
      if (st.state !== "none") setup = { state: st.state, pane: st.pane, pane_kind: st.pane_kind };
    } catch {
      setup = null;
    }
  }

  return {
    ...stackFactsFor(row, task, context, Boolean(ctx.askGh)),
    planMtime, planFiles, planCounts, planHash, decisions, commitsInstant, commitsSince, checkedCommits, unlanded,
    lastLandAt, boundSessions, worktree, setup, policy, base: context ? context.base : null,
  };
}

/** `advise` over `factsFor` for a task dir. */
function adviceFor(taskDir, task, ctx = {}) {
  const t = task || require("./task").readTaskJson(taskDir);
  return advise(t, factsFor(taskDir, t, ctx));
}

module.exports = { advise, factsFor, adviceFor };
