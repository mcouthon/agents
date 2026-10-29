"use strict";

// What to do next on a task, derived from its phases, the owner's recorded words and git.
// `advise` is pure; `factsFor` is the impure collector that feeds it. Nothing here refuses.

const CHECKED = new Set(["committed", "landed", "done", "skipped"]);
const PLANNED_STATUS = new Set(["planned", "reviewed", "approved", "in_progress", "implemented"]);
const APPROVED_STATUS = new Set(["approved", "in_progress", "implemented"]);

const last = (rows) => (rows.length > 0 ? rows[rows.length - 1] : null);

/**
 * @param {object} task task.json
 * @param {object} facts see factsFor
 * @returns {{phase: object|null, move: string, advice: string, question: object|null, approvals: string,
 *   migrated: boolean, worktree: string|null, ready: number[], checked: number[], warnings: string[]}}
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

  const isChecked = (p) => CHECKED.has(p.status) || rowsOf(p.id, "skip").length > 0;
  const checked = phases.filter(isChecked).map((p) => p.id);
  const isDone = (id) => !ids.has(id) || checked.includes(id);
  for (const p of phases) {
    for (const b of p.blocked_by || []) if (!ids.has(b)) warnings.push(`phase ${p.id} waits on phase ${b}, which does not exist`);
  }
  const ready = phases.filter((p) => !isChecked(p) && (p.blocked_by || []).every(isDone)).map((p) => p.id);

  if ((f.boundSessions || 0) > 1) warnings.push("two sessions are bound to this task");
  for (const p of phases) {
    if (p.status !== "done" || !p.checked_at) continue;
    const since = last(rowsOf(p.id, "approve"));
    const key = since ? since.decided_at : (f.planMtime || {})[p.id];
    if (key && f.commitsSince && f.commitsSince[key] === 0) warnings.push(`phase ${p.id} is checked but has no commits`);
  }

  const unlanded = f.unlanded || 0;
  const landMode = (task.knobs && task.knobs.land) || (f.policy === "pr" ? "at_end" : "per_phase");
  const out = (move, advice, extra = {}) => ({
    phase: null, move, advice, question: null, approvals, migrated, worktree: f.worktree || null,
    ready, checked, warnings, ...extra,
  });

  if (phases.length === 0) {
    return out("phases", `Task has no phases: ask the owner which phases it needs, then add them.`, {
      question: { text: `What phases should ${task.number ? `task ${task.number}` : "the task"} have?`, choices: ["answer"] },
    });
  }
  if (checked.length === phases.length) {
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
  const hasPlan = planAt !== null || PLANNED_STATUS.has(p.status);
  const verdict = last(rowsOf(p.id, "approve", "reject"));
  const accept = last(rowsOf(p.id, "accept"));
  const approved = APPROVED_STATUS.has(p.status) || (verdict !== null && verdict.choice === "approve" && planAt !== null && verdict.decided_at > planAt);
  const since = approvals === "ask" ? (accept && accept.decided_at) : planAt;
  const commits = p.status === "committed" || p.status === "landed" || (since ? (f.commitsSince || {})[since] > 0 : false);
  const phase = { id: p.id, name: p.name, plan_path: p.plan_path || null, plan: hasPlan, approved, accepted: accept !== null, commits };
  const named = `phase ${p.id}${p.name ? ` (${p.name})` : ""}`;
  const move = (m, advice, extra) => out(m, advice, { phase, ...extra });

  const checkedAt = phases.map((x) => x.checked_at).filter(Boolean);
  const landDue = unlanded > 0 && landMode === "per_phase" && (checkedAt.length > 0
    ? checkedAt.some((at) => !f.lastLandAt || at > f.lastLandAt)
    : checked.length > 0 && !approved && !commits);
  if (landDue) return move("land", `Land the checked phases before starting ${named}${f.policy === "pr" ? " (push or update the PR)" : ""}.`);

  if (!hasPlan) return move("plan", `${named} has no plan: dispatch the Explorer to plan it.`);
  if (approvals === "none") {
    return commits
      ? move("check", `${named} is committed: mark it checked.`)
      : move("build", `${named} has a plan: build it, review it, then commit it.`);
  }
  if (verdict && verdict.choice === "reject" && (planAt === null || verdict.decided_at > planAt)) {
    return move("revise", `The owner rejected ${named}'s plan (“${String(verdict.quote).slice(0, 200)}”): send it back to the Explorer.`);
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

const git = (cwd, args) => {
  const r = require("child_process").spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * The facts `advise` reads, from the task dir, the database, the plan files and git.
 * @param {string} taskDir
 * @param {object} task
 * @param {{mainRoot?: string}} [ctx]
 */
function factsFor(taskDir, task, ctx = {}) {
  const fs = require("fs");
  const taskLib = require("./task");
  const db = require("./db");
  const mainRoot = ctx.mainRoot || require("./tasks-root").mainRootOf(taskDir);
  const phases = Array.isArray(task.phases) ? task.phases : [];

  const planMtime = {};
  for (const p of phases) {
    const file = taskLib.resolvePlanFile(p.plan_path, task, { taskDir, projectDir: mainRoot });
    planMtime[p.id] = file ? fs.statSync(file).mtime.toISOString() : null;
  }

  let taskId = null;
  let decisions = [];
  let lastLandAt = null;
  if (db.enabled()) {
    taskId = db.taskIdOf(taskDir);
    if (taskId !== null) {
      decisions = db.listDecisions({ taskId }).map((d) => ({ phase_id: d.phase_id, choice: d.choice, quote: d.quote, decided_at: d.decided_at }));
      lastLandAt = db.lastEventAt(taskId, "land");
    }
  }

  let worktree = null;
  let policy = "unlisted";
  let tree = mainRoot;
  let base = null;
  if (mainRoot) {
    try {
      const key = require("./repo").repoKey(mainRoot);
      base = key.base;
      policy = require("./policy").policyKind(mainRoot);
      worktree = require("./worktree").taskWorktreeOf(key, task, taskDir);
      if (worktree) tree = worktree;
    } catch { /* no git facts: the advice falls back to what the task file says */ }
  }

  const instants = new Set(Object.values(planMtime).filter(Boolean));
  for (const d of decisions) if (d.choice === "accept" || d.choice === "approve") instants.add(d.decided_at);
  const commitsSince = {};
  let unlanded = 0;
  if (tree && base) {
    const remote = git(tree, ["rev-parse", "--verify", "--quiet", `origin/${base}`]) !== null;
    const baseRef = remote ? `origin/${base}` : base;
    const range = git(tree, ["rev-parse", "--verify", "--quiet", baseRef]) !== null ? `${baseRef}..HEAD` : "HEAD";
    for (const at of instants) {
      const n = git(tree, ["rev-list", "--count", `--since=${at}`, range]);
      commitsSince[at] = n === null ? 0 : Number(n);
    }
    const n = remote ? git(tree, ["rev-list", "--count", range]) : null;
    unlanded = n === null ? 0 : Number(n);
  }

  const session = require("./session");
  const here = require("path").resolve(taskDir);
  let boundSessions = 0;
  try {
    boundSessions = session.list().filter((r) => r.task_dir && require("path").resolve(r.task_dir) === here && session.isLive(r)).length;
  } catch { /* no registry */ }

  return { planMtime, decisions, commitsSince, unlanded, lastLandAt, boundSessions, worktree, policy };
}

/** `advise` over `factsFor` for a task dir. */
function adviceFor(taskDir, task, ctx = {}) {
  const t = task || require("./task").readTaskJson(taskDir);
  return advise(t, factsFor(taskDir, t, ctx));
}

module.exports = { advise, factsFor, adviceFor };
