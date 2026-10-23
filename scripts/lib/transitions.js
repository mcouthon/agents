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

// Transition table: { from: { to: guardName | guardName[] } }
// guardName is a key into GUARD_CHECKS; null means no guard (unconditional).
// An array means all guards must pass; artifact guards are checked first (D32).
const TRANSITIONS = {
  not_started: { planned: "plan_path_exists", in_progress: "fast_mode" },
  planned: { reviewed: "reviewer_verdict_pass" },
  // D56: `reviewed → planned` revokes a plan review (wrong or fabricated
  // verdict, plan changed); the stale reviewer report is cleared as a side
  // effect so it cannot satisfy the next planned → reviewed.
  reviewed: { approved: "checkpoint_resolved", planned: null },
  approved: { in_progress: "deps_done" },
  in_progress: { implemented: "builder_report_present" },
  implemented: {
    in_progress: "review_needs_work",
    committed: ["commits_recorded", "code_review_pass"],
  },
  committed: { landed: "ancestor_of_base" },
  landed: { done: null },
};

// D32: evidence guards can warn under enforcement: warn; artifact guards always deny.
const EVIDENCE_GUARDS = new Set([
  "reviewer_verdict_pass",
  "checkpoint_resolved",
  "builder_report_present",
  "code_review_pass",
  "review_needs_work",
  "fast_mode",
]);

const ARTIFACT_GUARDS = new Set([
  "plan_path_exists",
  "deps_done",
  "commits_recorded",
  "ancestor_of_base",
]);

// D37: map every `missing` key the guards emit to the exact action that
// satisfies the guard. Shared by CLI stderr, CLI --json error, MCP tool error
// text, and phase.warnings reason — appended wherever a refusal surfaces.
// Placeholders: <dir> = task dir, <N> = phase id, <ids> = comma-joined phase ids.
const MISSING_ACTIONS = {
  plan_path:
    "spawn an Explorer on phase <N>; its final JSON report is captured, " +
    "or run `a report --task-dir <dir> --phase-id <N> --agent explorer`",
  "reports.explorer":
    "spawn an Explorer on phase <N>; its final JSON report is captured, " +
    "or run `a report --task-dir <dir> --phase-id <N> --agent explorer`",
  "reports.builder":
    "spawn a Builder on phase <N>; its final JSON report is captured, " +
    "or run `a report --task-dir <dir> --phase-id <N> --agent builder`",
  "reports.reviewer":
    "spawn a Reviewer on phase <N>; its final JSON report is captured, " +
    "or run `a report --task-dir <dir> --phase-id <N> --agent reviewer`",
  "reports.reviewer.verdict":
    "spawn a Reviewer on phase <N>; its final JSON report is captured, " +
    "or run `a report --task-dir <dir> --phase-id <N> --agent reviewer`",
  checkpoint:
    "ask the user with AskUserQuestion; the checkpoint-capture hook records " +
    "the answer",
  "checkpoint:approve_plan":
    "ask the user with AskUserQuestion; the checkpoint-capture hook records " +
    "the answer",
  commits:
    "run `a state update --task-dir <dir> --phase-id <N> --phase-status " +
    "committed --commits <sha,…>`",
  landed_sha:
    "run `a land --task-dir <dir>` (records landed_sha after the rebase+merge)",
  deps:
    "wait for phases <ids> to reach done/landed, or re-sequence the phase " +
    "so its dependencies complete first",
  cap:
    "ask the user with AskUserQuestion how to proceed (the cap was reached)",
};

/**
 * Resolve a single missing key to its action sentence, substituting
 * placeholders from the phase and context. Returns null if unmapped.
 */
function resolveMissingAction(key, phase, ctx) {
  let template = null;
  // Exact match first.
  if (MISSING_ACTIONS[key]) {
    template = MISSING_ACTIONS[key];
  } else if (key.startsWith("commits:")) {
    template = MISSING_ACTIONS.commits;
  } else if (key.startsWith("ancestor:")) {
    template = MISSING_ACTIONS.landed_sha;
  } else if (key.startsWith("checkpoint:")) {
    template = MISSING_ACTIONS.checkpoint;
  } else if (key.startsWith("cap:")) {
    template = MISSING_ACTIONS.cap;
  } else if (/^\d+$/.test(key)) {
    // deps_done emits phase ids as missing keys.
    template = MISSING_ACTIONS.deps;
  }
  if (!template) return null;

  const dir = (ctx && ctx.taskDir) || "<dir>";
  const phaseId = phase ? phase.id : "<N>";
  return template
    .replace(/<dir>/g, dir)
    .replace(/<N>/g, String(phaseId));
}

/**
 * Build the appended action sentences for a set of missing keys (D37).
 * Deduplicates identical sentences. Returns a string (possibly empty).
 */
function formatMissingActions(missing, phase, ctx) {
  if (!missing || missing.length === 0) return "";
  const seen = new Set();
  const sentences = [];
  // For deps_done, collect the numeric phase ids into <ids>.
  const depIds = missing.filter((k) => /^\d+$/.test(k));
  for (const key of missing) {
    let sentence;
    if (depIds.length > 0 && /^\d+$/.test(key)) {
      sentence = MISSING_ACTIONS.deps
        .replace(/<ids>/g, depIds.join(", "))
        .replace(/<dir>/g, (ctx && ctx.taskDir) || "<dir>")
        .replace(/<N>/g, phase ? String(phase.id) : "<N>");
    } else {
      sentence = resolveMissingAction(key, phase, ctx);
    }
    if (sentence && !seen.has(sentence)) {
      seen.add(sentence);
      sentences.push(sentence);
    }
  }
  return sentences.length > 0 ? " To proceed: " + sentences.join("; ") + "." : "";
}

// Any non-done, non-failed, non-skipped status can transition to failed or skipped.
function canTransitionToTerminal(from) {
  return from !== "done" && from !== "failed" && from !== "skipped";
}

/**
 * Check whether a transition from → to is legal, and if so whether its guard
 * is satisfied. Returns { ok: true } or { ok: false, reason, missing, guard, kind }.
 * `kind` is "artifact" (always deny) or "evidence" (may warn under enforcement: warn).
 *
 * @param {string} from - Current phase status
 * @param {string} to - Target phase status
 * @param {object} phase - The phase object from task.json
 * @param {object} task - The full task.json
 * @param {object} ctx - Additional context (projectDir, gitFacts, sessionId)
 * @returns {{ ok: boolean, reason?: string, missing?: string[], guard?: string, kind?: string }}
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

  const guardNames = allowed[to];
  if (!guardNames) return { ok: true };

  const guardList = Array.isArray(guardNames) ? guardNames : [guardNames];

  // Artifact guards first — always deny on failure (D32)
  for (const name of guardList) {
    if (!ARTIFACT_GUARDS.has(name)) continue;
    const guard = GUARD_CHECKS[name];
    if (!guard) continue;
    const result = guard(phase, task, ctx);
    if (!result.ok) {
      return { ...result, guard: name, kind: "artifact" };
    }
  }

  // Evidence guards — may warn under enforcement: warn (D32)
  for (const name of guardList) {
    if (!EVIDENCE_GUARDS.has(name)) continue;
    const guard = GUARD_CHECKS[name];
    if (!guard) continue;
    const result = guard(phase, task, ctx);
    if (!result.ok) {
      return { ...result, guard: name, kind: "evidence" };
    }
  }

  return { ok: true };
}

// Guard implementations. Each returns { ok: true } or { ok: false, reason, missing }.
const GUARD_CHECKS = {
  fast_mode(phase, task, ctx) {
    if (task.mode === "fast") return { ok: true };
    return { ok: false, reason: "not a fast-mode task", missing: [] };
  },

  plan_path_exists(phase, task, ctx) {
    if (!phase.plan_path) {
      return { ok: false, reason: "plan_path not set", missing: ["plan_path"] };
    }
    if (ctx && (ctx.taskDir || ctx.projectDir)) {
      if (!require("./task").resolvePlanFile(phase.plan_path, task, ctx)) {
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
    // D31: a user-attributed pass (a human resolved the review at a checkpoint)
    // satisfies planned → reviewed without flipping review_plan/approve knobs.
    if (report.attributed_to === "user" &&
        (report.verdict === "pass" || report.verdict === "pass_with_notes")) {
      return { ok: true };
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

  commits_recorded(phase, task, ctx) {
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
    return { ok: true };
  },

  code_review_pass(phase, task, ctx) {
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
    const base = ctx.gitFacts.base || "main";
    let landedSha = phase.landed_sha;

    // D34: a phase on the base branch (or with no branch) can go committed →
    // landed without `a land` (which refuses "already on base"). Derive
    // landed_sha from the last recorded commit and verify it is an ancestor
    // of base. The guard mutates phase.landed_sha — this is intentional: the
    // derivation is a prerequisite of the transition, not a side effect of it.
    if (!landedSha) {
      const branch = phase.branch || "";
      if (branch === "" || branch === base) {
        const commits = phase.commits || [];
        if (commits.length === 0) {
          return { ok: false, reason: "no commits recorded on base branch", missing: ["commits"] };
        }
        landedSha = commits[commits.length - 1];
        if (!ctx.gitFacts.isAncestor(landedSha, `origin/${base}`) &&
            !ctx.gitFacts.isAncestor(landedSha, base)) {
          return { ok: false, reason: `last commit ${landedSha} is not an ancestor of ${base}`, missing: [`ancestor:${landedSha}`] };
        }
        phase.landed_sha = landedSha;
      } else {
        return { ok: false, reason: "no landed_sha recorded (run `a land` first)", missing: ["landed_sha"] };
      }
    }

    if (ctx.gitFacts.isAncestor(landedSha, `origin/${base}`)) return { ok: true };
    if (ctx.gitFacts.isAncestor(landedSha, base)) return { ok: true };
    return { ok: false, reason: `landed_sha ${landedSha} is not an ancestor of ${base}`, missing: [`ancestor:${landedSha}`] };
  },
};

/**
 * Validate and apply a phase transition. Returns the updated phase object
 * or throws an Error with { from, to, missing }.
 *
 * Under task.knobs.enforcement === "warn" (D32), a failed evidence guard lets
 * the transition through and appends {guard, reason, at, session_id} to
 * phase.warnings. Artifact guards always deny.
 *
 * @param {object} phase - The phase to transition
 * @param {string} to - Target status
 * @param {object} task - The full task.json
 * @param {object} ctx - Context (projectDir, gitFacts, sessionId)
 * @returns {object} The updated phase (mutated in place)
 * @throws {Error} If the transition is illegal or an artifact guard fails
 */
function applyTransition(phase, to, task, ctx) {
  const from = phase.status;
  const result = checkTransition(from, to, phase, task, ctx);
  if (!result.ok) {
    const enforcement = (task.knobs || {}).enforcement || "deny";
    const actions = formatMissingActions(result.missing, phase, ctx);
    if (result.kind === "evidence" && enforcement === "warn") {
      phase.warnings = phase.warnings || [];
      phase.warnings.push({
        guard: result.guard,
        reason: (result.reason || "") + actions,
        at: new Date().toISOString(),
        session_id: (ctx && ctx.sessionId) || `pid-${process.pid}`,
      });
    } else {
      const err = new Error(
        `Transition rejected: ${from} → ${to}. ${result.reason || ""}${actions}`
      );
      err.transitionError = true;
      err.error = result.reason || "";
      err.from = from;
      err.to = to;
      err.missing = result.missing || [];
      throw err;
    }
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
  if (to === "planned" && from === "reviewed") {
    if (phase.reports) phase.reports.reviewer = null;
    // Revoking the review also undoes the round it counted.
    const counters = phase.counters || (phase.counters = {});
    counters.review_passes = Math.max(0, (counters.review_passes || 0) - 1);
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
  EVIDENCE_GUARDS,
  ARTIFACT_GUARDS,
  MISSING_ACTIONS,
  checkTransition,
  applyTransition,
  canTransitionToTerminal,
  formatMissingActions,
  resolveMissingAction,
};
