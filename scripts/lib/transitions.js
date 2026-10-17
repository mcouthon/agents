"use strict";

/**
 * Phase state machine: transition table, guards, and validation.
 * The single source of truth for which status moves are legal.
 */

const PHASE_STATUSES = [
  "not_started", "planned", "reviewed", "approved", "in_progress",
  "implemented", "committed", "landed", "done", "failed", "skipped",
];

const TASK_STATUSES = ["planning", "in_progress", "done", "failed"];

const CAPS = {
  review_passes: 1,
  clarify_rounds: 1,
  fix_attempts: 2,
  ci_attempts: 5,
};

// Legacy statuses that are NOT v2 statuses (D29) and how migrate maps them.
// blocked → in_progress + a next reports "blocked" as a step output
// needs_human → in_progress + a flags[] entry
// review_ready → in_progress (implemented + knobs.review_code covers it)
const LEGACY_STATUS_MAP = {
  blocked: "in_progress",
  needs_human: "in_progress",
  review_ready: "in_progress",
};

// Transition table: { from: { to: guardName } }
// guardName is a key into GUARD_CHECKS; null means no guard (unconditional).
const TRANSITIONS = {
  not_started: { planned: "plan_path_exists" },
  planned: { reviewed: "reviewer_verdict_pass" },
  reviewed: { approved: "checkpoint_resolved" },
  approved: { in_progress: "deps_done" },
  in_progress: { implemented: "builder_report_present" },
  implemented: {
    in_progress: "review_needs_work",
    committed: "commits_and_code_review",
  },
  committed: { landed: "ancestor_of_base" },
  landed: { done: null },
};

// Any non-done, non-failed, non-skipped status can transition to failed or skipped.
function canTransitionToTerminal(from) {
  return from !== "done" && from !== "failed" && from !== "skipped";
}

/**
 * Check whether a transition from → to is legal, and if so whether its guard
 * is satisfied. Returns { ok: true } or { ok: false, reason, missing }.
 *
 * @param {string} from - Current phase status
 * @param {string} to - Target phase status
 * @param {object} phase - The phase object from task.json
 * @param {object} task - The full task.json
 * @param {object} ctx - Additional context (projectDir, gitFacts)
 * @returns {{ ok: boolean, reason?: string, missing?: string[] }}
 */
function checkTransition(from, to, phase, task, ctx) {
  if (from === to) return { ok: true };

  if (to === "failed" || to === "skipped") {
    if (canTransitionToTerminal(from)) return { ok: true };
    return { ok: false, reason: `cannot ${from} → ${to}` };
  }

  const allowed = TRANSITIONS[from];
  if (!allowed || !(to in allowed)) {
    return { ok: false, reason: `illegal transition: ${from} → ${to}`, missing: [] };
  }

  const guardName = allowed[to];
  if (!guardName) return { ok: true };

  const guard = GUARD_CHECKS[guardName];
  if (!guard) return { ok: true };

  return guard(phase, task, ctx);
}

// Guard implementations. Each returns { ok: true } or { ok: false, reason, missing }.
const GUARD_CHECKS = {
  plan_path_exists(phase, task, ctx) {
    if (!phase.plan_path) {
      return { ok: false, reason: "plan_path not set", missing: ["plan_path"] };
    }
    if (ctx && (ctx.taskDir || ctx.projectDir)) {
      const fs = require("fs");
      const path = require("path");
      const baseDir = ctx.taskDir || ctx.projectDir;
      const fullPath = path.resolve(baseDir, phase.plan_path);
      if (!fs.existsSync(fullPath)) {
        return { ok: false, reason: `plan file not found: ${phase.plan_path}`, missing: ["plan_path"] };
      }
    }
    return { ok: true };
  },

  reviewer_verdict_pass(phase, task, ctx) {
    const knobs = task.knobs || {};
    if (knobs.review_plan === false) return { ok: true };
    const report = phase.reports && phase.reports.reviewer;
    if (!report) {
      return { ok: false, reason: "reviewer report not found", missing: ["reports.reviewer"] };
    }
    if (report.verdict !== "pass" && report.verdict !== "pass_with_notes") {
      return { ok: false, reason: `reviewer verdict is ${report.verdict}, need pass or pass_with_notes`, missing: ["reports.reviewer.verdict"] };
    }
    return { ok: true };
  },

  checkpoint_resolved(phase, task, ctx) {
    const knobs = task.knobs || {};
    if (knobs.approve === "auto") return { ok: true };
    const checkpoints = task.checkpoints || [];
    const resolved = checkpoints.find(
      (cp) => cp.phase === phase.id && cp.type === "approve_plan" && cp.chosen !== null && cp.resolved_at
    );
    if (!resolved) {
      return { ok: false, reason: "no resolved approve_plan checkpoint", missing: ["checkpoint:approve_plan"] };
    }
    return { ok: true };
  },

  deps_done(phase, task, ctx) {
    const blockedBy = phase.blocked_by || [];
    if (blockedBy.length === 0) return { ok: true };
    const incomplete = blockedBy.filter((depId) => {
      const dep = (task.phases || []).find((p) => p.id === depId);
      if (!dep) return true;
      return dep.status !== "done" && dep.status !== "landed";
    });
    if (incomplete.length > 0) {
      return { ok: false, reason: `blocked by incomplete phases: ${incomplete.join(", ")}`, missing: incomplete.map(String) };
    }
    return { ok: true };
  },

  builder_report_present(phase, task, ctx) {
    const report = phase.reports && phase.reports.builder;
    if (!report) {
      return { ok: false, reason: "builder report not found", missing: ["reports.builder"] };
    }
    return { ok: true };
  },

  review_needs_work(phase, task, ctx) {
    const report = phase.reports && phase.reports.reviewer;
    if (!report || report.verdict !== "needs_work") {
      return { ok: false, reason: "reviewer verdict is not needs_work", missing: ["reports.reviewer.verdict"] };
    }
    const counters = phase.counters || {};
    const attempts = (counters.fix_attempts || 0) + 1;
    if (attempts > CAPS.fix_attempts) {
      return { ok: false, reason: `fix_attempts cap reached (${attempts}/${CAPS.fix_attempts})`, missing: ["cap:fix_attempts"] };
    }
    return { ok: true };
  },

  commits_and_code_review(phase, task, ctx) {
    const commits = phase.commits || [];
    if (commits.length === 0) {
      return { ok: false, reason: "no commits recorded", missing: ["commits"] };
    }
    if (ctx && ctx.gitFacts) {
      for (const sha of commits) {
        if (!ctx.gitFacts.shaExists(sha)) {
          return { ok: false, reason: `commit SHA not found in git: ${sha}`, missing: [`commits:${sha}`] };
        }
      }
    }
    const knobs = task.knobs || {};
    if (knobs.review_code === false) return { ok: true };
    const report = phase.reports && phase.reports.reviewer;
    if (!report) {
      return { ok: false, reason: "code reviewer report not found", missing: ["reports.reviewer"] };
    }
    if (report.verdict !== "pass" && report.verdict !== "pass_with_notes") {
      return { ok: false, reason: `code reviewer verdict is ${report.verdict}, need pass or pass_with_notes`, missing: ["reports.reviewer.verdict"] };
    }
    return { ok: true };
  },

  ancestor_of_base(phase, task, ctx) {
    if (!ctx || !ctx.gitFacts) return { ok: true };
    const commits = phase.commits || [];
    if (commits.length === 0) {
      return { ok: false, reason: "no commits to land", missing: ["commits"] };
    }
    const branch = phase.branch || "";
    const base = (ctx.gitFacts.base || "main");
    if (branch === base) return { ok: true };
    for (const sha of commits) {
      if (!ctx.gitFacts.isAncestor(sha, base)) {
        return { ok: false, reason: `commit ${sha} is not an ancestor of ${base}`, missing: [`ancestor:${sha}`] };
      }
    }
    return { ok: true };
  },
};

/**
 * Validate and apply a phase transition. Returns the updated phase object
 * or throws an Error with { from, to, missing }.
 *
 * @param {object} phase - The phase to transition
 * @param {string} to - Target status
 * @param {object} task - The full task.json
 * @param {object} ctx - Context (projectDir, gitFacts)
 * @returns {object} The updated phase (mutated in place)
 * @throws {Error} If the transition is illegal or guard fails
 */
function applyTransition(phase, to, task, ctx) {
  const from = phase.status;
  const result = checkTransition(from, to, phase, task, ctx);
  if (!result.ok) {
    const err = new Error(
      `Transition rejected: ${from} → ${to}. ${result.reason || ""}`
    );
    err.transitionError = true;
    err.error = result.reason || "";
    err.from = from;
    err.to = to;
    err.missing = result.missing || [];
    throw err;
  }

  // Side effects for specific transitions
  if (to === "in_progress" && from === "implemented") {
    const counters = phase.counters || (phase.counters = {});
    counters.fix_attempts = (counters.fix_attempts || 0) + 1;
  }
  if (to === "reviewed" && from === "planned") {
    const counters = phase.counters || (phase.counters = {});
    counters.review_passes = (counters.review_passes || 0) + 1;
  }
  if (to === "in_progress" && from === "approved") {
    if (!phase.started) phase.started = new Date().toISOString();
  }
  if (to === "done") {
    phase.completed = new Date().toISOString();
  }

  phase.status = to;
  return phase;
}

module.exports = {
  PHASE_STATUSES,
  TASK_STATUSES,
  CAPS,
  LEGACY_STATUS_MAP,
  TRANSITIONS,
  checkTransition,
  applyTransition,
  canTransitionToTerminal,
};
