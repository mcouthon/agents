"use strict";

/**
 * `a next` — the Conductor's Step Determination as a pure function.
 * Takes task.json + git facts and returns { step, phase_ids, agent, checkpoint,
 * reason, caps, overrides }. Idempotent: same input → same output.
 *
 * Steps: plan, review_plan, approve, build, review_code, fix, commit, land,
 * pr, ci_wait, consolidate, done, blocked.
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { checkTransition, CAPS } = require("./transitions");
const { formatCap } = require("./caps");

const ALL_STEPS = [
  "plan", "review_plan", "approve", "build", "review_code", "fix",
  "commit", "land", "resolve_conflicts", "pr", "ci_wait", "consolidate",
  "done", "blocked",
];

/**
 * D37: the `how` for each step — {tool, command} telling the agent exactly
 * how to perform the step. `tool` is one of "Agent", "AskUserQuestion",
 * "Bash", "Skill", or null (no action needed).
 */
function computeHow(step, phase, ctx) {
  const dir = (ctx && ctx.taskDir) || "<dir>";
  const N = phase ? phase.id : "<N>";
  const planPath = phase ? (phase.plan_path || "") : "";

  switch (step) {
    case "plan":
      return { tool: "Agent", command: `spawn Explorer on phase ${N}; report captured on SubagentStop` };
    case "review_plan":
      return { tool: "Agent", command: `spawn Reviewer on phase ${N}${planPath ? " with " + planPath : ""}; report captured on SubagentStop` };
    case "approve":
      return { tool: "AskUserQuestion", command: "ask the user; checkpoint-capture records the answer" };
    case "build":
      return { tool: "Agent", command: `spawn Builder on phase ${N}; report captured on SubagentStop` };
    case "review_code":
      return { tool: "Agent", command: `spawn Reviewer on phase ${N}; report captured on SubagentStop` };
    case "fix":
      return { tool: "Agent", command: `spawn Builder on phase ${N} to apply fixes; report captured on SubagentStop` };
    case "commit": {
      const base = (ctx && ctx.gitFacts) ? ctx.gitFacts.base : "main";
      const branch = (phase && phase.branch) ||
        ((ctx && ctx.gitFacts) ? ctx.gitFacts.currentBranch() : "");
      if (!branch || branch === base) {
        return { tool: "Bash", command: `a state update --task-dir ${dir} --phase-id ${N} --phase-status committed --commits <sha,…>` };
      }
      return { tool: "Bash", command: `a land --task-dir ${dir}` };
    }
    case "land":
      return { tool: "Bash", command: `a land --task-dir ${dir}` };
    case "resolve_conflicts":
      return { tool: "Agent", command: `spawn Builder on phase ${N} to resolve conflicts; report captured on SubagentStop` };
    case "pr":
      return { tool: "Bash", command: "gh pr create" };
    case "ci_wait":
      return { tool: "Bash", command: `a pr status --task-dir ${dir}` };
    case "consolidate":
      return { tool: "Skill", command: "consolidate-task" };
    case "done":
    case "blocked":
    default:
      return { tool: null, command: null };
  }
}

/**
 * Collect git facts for a project directory.
 * Returns functions that `a next` uses to verify artifacts.
 * @param {string} projectDir
 * @returns {{ shaExists, isAncestor, currentBranch, base: string }}
 */
function collectGitFacts(projectDir) {
  const base = deriveBase(projectDir);
  return {
    shaExists(sha) {
      try {
        execFileSync("git", ["-C", projectDir, "cat-file", "-e", sha], {
          stdio: ["ignore", "pipe", "pipe"], timeout: 2000,
        });
        return true;
      } catch { return false; }
    },
    isAncestor(sha, ref) {
      try {
        execFileSync("git", ["-C", projectDir, "merge-base", "--is-ancestor", sha, ref], {
          stdio: ["ignore", "pipe", "pipe"], timeout: 2000,
        });
        return true;
      } catch { return false; }
    },
    currentBranch() {
      try {
        return execFileSync("git", ["-C", projectDir, "branch", "--show-current"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000,
        }).trim();
      } catch { return ""; }
    },
    base,
  };
}

function deriveBase(projectDir) {
  try {
    const out = execFileSync("git", ["-C", projectDir, "symbolic-ref", "refs/remotes/origin/HEAD"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const branch = out.replace("refs/remotes/origin/", "");
    if (branch) return branch;
  } catch {}
  for (const candidate of ["main", "master"]) {
    try {
      execFileSync("git", ["-C", projectDir, "rev-parse", "--verify", `refs/heads/${candidate}`], {
        encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"],
      });
      return candidate;
    } catch {}
  }
  return "main";
}

/**
 * Find the lowest-id eligible phase: first phase that is not done/failed/skipped.
 */
function findEligiblePhases(task) {
  const phases = task.phases || [];
  if (phases.length === 0) return [];

  // Find the first non-terminal phase (D36: landed is terminal)
  const TERMINAL = ["done", "landed", "failed", "skipped"];
  const depsIncomplete = (p) => (p.blocked_by || []).some((depId) => {
    const dep = phases.find((q) => q.id === depId);
    if (!dep) return true;
    return dep.status !== "done" && dep.status !== "landed";
  });
  const open = phases.filter((p) => !TERMINAL.includes(p.status));
  if (open.length === 0) return [];

  // D53: a phase whose deps are incomplete defers, it does not halt the
  // task. The first open phase with satisfied deps is the current one;
  // only when no open phase is eligible does the earliest blocked phase
  // come back so computeNext can report `blocked` with its deps.
  const first = open.find((p) => !depsIncomplete(p));
  if (!first) return [open[0]];

  // Batch: include following phases that share the same parallel_group,
  // are adjacent, and all eligible (not done/failed/skipped, deps satisfied)
  const knobs = task.knobs || {};
  const maxParallel = knobs.parallel || 3;
  const batch = [first];
  const firstIdx = phases.indexOf(first);

  for (let i = firstIdx + 1; i < phases.length; i++) {
    const p = phases[i];
    if (TERMINAL.includes(p.status)) break;
    if (!p.parallel_group || !first.parallel_group) break;
    if (p.parallel_group !== first.parallel_group) break;
    if (depsIncomplete(p)) break;
    batch.push(p);
    if (batch.length >= maxParallel) break;
  }

  return batch;
}

/**
 * Determine the step for a single phase.
 * @param {object} phase - The phase from task.json
 * @param {object} task - The full task.json
 * @param {object} ctx - { projectDir, gitFacts }
 * @returns {{ step: string, agent: string|null, reason: string, checkpoint: object|null, caps: object }}
 */
function stepForPhase(phase, task, ctx) {
  const knobs = task.knobs || {};
  const counters = phase.counters || {};
  const capsResult = {};

  // Format cap strings for display
  for (const c of Object.keys(CAPS)) {
    capsResult[c] = formatCap(c, counters[c]);
  }

  switch (phase.status) {
    case "not_started":
      if (task.mode === "fast") {
        return {
          step: "build",
          agent: "builder",
          reason: "fast mode: build directly",
          checkpoint: null,
          caps: capsResult,
          pending_transitions: ["not_started -> in_progress"],
        };
      }
      return {
        step: "plan",
        agent: "explorer",
        reason: `Phase ${phase.id} (${phase.name}) needs a plan`,
        checkpoint: null,
        caps: capsResult,
      };

    case "planned": {
      // Check for open questions from explorer report
      const explorerReport = phase.reports && phase.reports.explorer;
      if (explorerReport && explorerReport.open_questions && explorerReport.open_questions.length > 0) {
        if ((counters.clarify_rounds || 0) < CAPS.clarify_rounds) {
          return {
            step: "blocked",
            agent: null,
            reason: `Phase ${phase.id} has open questions from explorer`,
            checkpoint: {
              id: `c-${phase.id}-clarify`,
              question: explorerReport.open_questions[0].question,
              options: explorerReport.open_questions[0].options || [],
            },
            caps: capsResult,
          };
        }
      }
      if (knobs.review_plan === false) {
        return {
          step: "approve",
          agent: null,
          reason: `Phase ${phase.id} plan review skipped (knobs.review_plan=false)`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      // D55: a stored failing plan-review verdict means the plan is revised
      // next (Explorer), not reviewed again. The cap below still bounds it.
      const planReview = phase.reports && phase.reports.reviewer;
      const planReviewFailed = planReview &&
        (planReview.verdict === "needs_work" || planReview.verdict === "fail");
      if (planReviewFailed && (counters.review_passes || 0) <= CAPS.review_passes) {
        return {
          step: "plan",
          agent: "explorer",
          reason: `Phase ${phase.id} plan review verdict ${planReview.verdict}: revise the plan`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      // Cap semantics match fix_attempts: `cap` failing rounds are tolerated,
      // the next one asks the human.
      if ((counters.review_passes || 0) > CAPS.review_passes) {
        return {
          step: "blocked",
          agent: null,
          reason: `Phase ${phase.id} review_passes cap reached (${counters.review_passes || 0}/${CAPS.review_passes})`,
          checkpoint: {
            id: `c-${phase.id}-review-cap`,
            type: "review_cap",
            question: `Phase ${phase.id} exceeded review_passes cap (${CAPS.review_passes}). How to proceed?`,
            options: ["approve_anyway", "force_replan", "skip"],
          },
          caps: capsResult,
        };
      }
      return {
        step: "review_plan",
        agent: "reviewer",
        reason: `Phase ${phase.id} plan needs review`,
        checkpoint: null,
        caps: capsResult,
      };
    }

    case "reviewed": {
      if (knobs.approve === "auto") {
        return {
          step: "build",
          agent: "builder",
          reason: `Phase ${phase.id} auto-approved (knobs.approve=auto)`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      // Check for a resolved approve_plan checkpoint
      const cps = task.checkpoints || [];
      const resolved = cps.find(
        (cp) => cp.phase === phase.id && cp.type === "approve_plan" && cp.chosen !== null && cp.resolved_at
      );
      if (!resolved) {
        return {
          step: "approve",
          agent: null,
          reason: `Phase ${phase.id} needs approval`,
          checkpoint: {
            id: `c-${phase.id}-approve`,
            question: `Approve plan for phase ${phase.id} (${phase.name})?`,
            options: ["approve", "reject"],
          },
          caps: capsResult,
        };
      }
      return {
        step: "build",
        agent: "builder",
        reason: `Phase ${phase.id} approved`,
        checkpoint: null,
        caps: capsResult,
      };
    }

    case "approved":
      return {
        step: "build",
        agent: "builder",
        reason: `Phase ${phase.id} ready to build`,
        checkpoint: null,
        caps: capsResult,
      };

    case "in_progress":
      return {
        step: "build",
        agent: "builder",
        reason: `Phase ${phase.id} build in progress`,
        checkpoint: null,
        caps: capsResult,
      };

    case "implemented": {
      // Check if code review is needed
      if (knobs.review_code === false) {
        return {
          step: "commit",
          agent: "committer",
          reason: `Phase ${phase.id} ready to commit (code review skipped)`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      // Check if reviewer has already given a verdict
      const reviewerReport = phase.reports && phase.reports.reviewer;
      if (!reviewerReport) {
        return {
          step: "review_code",
          agent: "reviewer",
          reason: `Phase ${phase.id} needs code review`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      if (reviewerReport.verdict === "needs_work") {
        const attempts = (counters.fix_attempts || 0) + 1;
        if (attempts > CAPS.fix_attempts) {
          return {
            step: "blocked",
            agent: null,
            reason: `Phase ${phase.id} fix_attempts cap reached (${counters.fix_attempts || 0}/${CAPS.fix_attempts})`,
            checkpoint: {
              id: `c-${phase.id}-fix-cap`,
              type: "fix_cap",
              question: `Phase ${phase.id} exceeded fix_attempts cap (${CAPS.fix_attempts}). How to proceed?`,
              options: ["skip", "force_retry", "abort"],
            },
            caps: capsResult,
          };
        }
        return {
          step: "fix",
          agent: "builder",
          reason: `Phase ${phase.id} needs fixes (review: needs_work)`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      if (reviewerReport.verdict === "fail") {
        return {
          step: "blocked",
          agent: null,
          reason: `Phase ${phase.id} review failed (verdict: fail)`,
          checkpoint: {
            id: `c-${phase.id}-review-fail`,
            type: "review_fail",
            question: `Phase ${phase.id} code review failed. How to proceed?`,
            options: ["replan", "skip", "abort"],
          },
          caps: capsResult,
        };
      }
      // pass or pass_with_notes → commit
      return {
        step: "commit",
        agent: "committer",
        reason: `Phase ${phase.id} reviewed, ready to commit`,
        checkpoint: null,
        caps: capsResult,
      };
    }

    case "committed": {
      // D26 layer 3: rebase conflict in progress → Builder resolves
      if (phase.conflict) {
        return {
          step: "resolve_conflicts",
          agent: "builder",
          reason: `Phase ${phase.id} has rebase conflicts: ${(phase.conflict.files || []).join(", ")}`,
          checkpoint: null,
          caps: capsResult,
        };
      }

      // D30: PR already created → wait for CI, never land again
      if (phase.pr_open) {
        return {
          step: "ci_wait",
          agent: null,
          reason: `Phase ${phase.id} PR open, waiting for CI`,
          checkpoint: null,
          caps: capsResult,
        };
      }

      if (ctx.gitFacts) {
        const base = ctx.gitFacts.base;

        // D30: landed_sha set and on base → done (landing complete)
        if (phase.landed_sha) {
          const onOrigin = ctx.gitFacts.isAncestor(phase.landed_sha, `origin/${base}`);
          const onLocal = ctx.gitFacts.isAncestor(phase.landed_sha, base);
          if (onOrigin || onLocal) {
            const pushNeeded = (ctx.policy && ctx.policy.push === "direct") && !onOrigin;
            return {
              step: "done",
              agent: null,
              reason: `Phase ${phase.id} landed (landed_sha on ${base})`,
              checkpoint: null,
              caps: capsResult,
              pending_transitions: ["committed -> landed", "landed -> done"],
              push_needed: pushNeeded,
            };
          }
        }

        const branch = phase.branch || ctx.gitFacts.currentBranch();
        if (branch === base) {
          const sha = phase.landed_sha ||
            (phase.commits && phase.commits[phase.commits.length - 1]) || null;
          const onOrigin = sha && ctx.gitFacts.isAncestor(sha, `origin/${base}`);
          const pushNeeded = (ctx.policy && ctx.policy.push === "direct") && sha && !onOrigin;
          return {
            step: "done",
            agent: null,
            reason: `Phase ${phase.id} committed on base branch`,
            checkpoint: null,
            caps: capsResult,
            pending_transitions: ["committed -> landed", "landed -> done"],
            push_needed: pushNeeded,
          };
        }

        // D30: land: at_end — wait for all phases to commit
        const landKnob = knobs.land || "per_phase";
        if (landKnob === "at_end") {
          const allReady = (task.phases || []).every(
            (p) => p.status === "committed" || p.status === "landed" ||
                   p.status === "done" || p.status === "failed" || p.status === "skipped"
          );
          if (!allReady) {
            return {
              step: "blocked",
              agent: null,
              reason: `Phase ${phase.id} committed but waiting for all phases (land: at_end)`,
              checkpoint: null,
              caps: capsResult,
            };
          }
        }

        // Both direct and PR repos: `a land` handles the push policy
        return {
          step: "land",
          agent: null,
          reason: `Phase ${phase.id} needs landing on ${base}`,
          checkpoint: null,
          caps: capsResult,
        };
      }
      return {
        step: "land",
        agent: null,
        reason: `Phase ${phase.id} needs landing`,
        checkpoint: null,
        caps: capsResult,
      };
    }

    case "landed":
      return {
        step: "done",
        agent: null,
        reason: `Phase ${phase.id} landed`,
        checkpoint: null,
        caps: capsResult,
      };

    case "done":
    case "failed":
    case "skipped":
      return {
        step: "done",
        agent: null,
        reason: `Phase ${phase.id} is ${phase.status}`,
        checkpoint: null,
        caps: capsResult,
      };

    default:
      return {
        step: "blocked",
        agent: null,
        reason: `Phase ${phase.id} unknown status: ${phase.status}`,
        checkpoint: null,
        caps: capsResult,
      };
  }
}

/**
 * Verify artifact behind a status (D13). A status whose artifact is missing
 * is reported as `blocked` with a reason, never advanced.
 */
function verifyArtifacts(phase, task, ctx) {
  const baseDir = (ctx && (ctx.taskDir || ctx.projectDir));

  if (phase.status === "planned" && phase.plan_path && baseDir) {
    const fullPath = path.resolve(baseDir, phase.plan_path);
    if (!fs.existsSync(fullPath)) {
      return { blocked: true, reason: `plan file missing: ${phase.plan_path}` };
    }
  }

  if (phase.status === "committed" && phase.commits && ctx.gitFacts) {
    for (const sha of phase.commits) {
      if (!ctx.gitFacts.shaExists(sha)) {
        return { blocked: true, reason: `commit SHA missing in git: ${sha}` };
      }
    }
  }

  return { blocked: false };
}

/**
 * Compute the next action for a task.
 *
 * @param {object} task - The task.json v2 object
 * @param {object} ctx - { projectDir, policy, gitFacts? }
 *   If gitFacts is not provided but projectDir is, they are collected.
 * @returns {{ step, phase_ids, agent, reason, checkpoint, caps, overrides }}
 */
function computeNext(task, ctx) {
  ctx = ctx || {};
  if (!ctx.gitFacts && ctx.projectDir) {
    ctx.gitFacts = collectGitFacts(ctx.projectDir);
  }

  // Task-level terminal check
  if (task.status === "done" || task.status === "failed") {
    return {
      step: "done",
      phase_ids: [],
      agent: null,
      reason: `Task is ${task.status}`,
      checkpoint: null,
      caps: {},
      overrides: {},
      warnings: [],
      how: computeHow("done", null, ctx),
    };
  }

  // Find eligible phases
  const eligible = findEligiblePhases(task);
  if (eligible.length === 0) {
    // D15/D36: zero phases → blocked, not consolidate. An empty phases
    // array is not "all done" (vacuous truth); it means the task has no
    // phases to work on. `a next` must say "blocked" with how to add phases.
    const phases = task.phases || [];
    if (phases.length === 0) {
      return {
        step: "blocked",
        phase_ids: [],
        agent: null,
        reason: "task has no phases",
        checkpoint: null,
        caps: {},
        overrides: {},
        warnings: [],
        how: { tool: "Bash", command: `a state add-phases --task-dir ${ctx.taskDir || "<dir>"} --phases-json '[{"id":1,"name":"<phase name>"}]'` },
      };
    }
    // D36 done predicate: every phase landed/failed/skipped/done
    const TERMINAL = ["done", "landed", "failed", "skipped"];
    const allDone = phases.every((p) => TERMINAL.includes(p.status));
    if (allDone) {
      return {
        step: "consolidate",
        phase_ids: [],
        agent: null,
        reason: "All phases complete, task ready for consolidation",
        checkpoint: null,
        caps: {},
        overrides: {},
        warnings: [],
        how: computeHow("consolidate", null, ctx),
      };
    }
    return {
      step: "blocked",
      phase_ids: [],
      agent: null,
      reason: "No eligible phases found",
      checkpoint: null,
      caps: {},
      overrides: {},
      warnings: [],
      how: computeHow("blocked", null, ctx),
    };
  }

  // Check if any eligible phase is blocked by incomplete deps
  const blockedByDeps = eligible.find((p) => {
    return (p.blocked_by || []).some((depId) => {
      const dep = (task.phases || []).find((q) => q.id === depId);
      if (!dep) return true;
      return dep.status !== "done" && dep.status !== "landed";
    });
  });

  if (blockedByDeps) {
    return {
      step: "blocked",
      phase_ids: [blockedByDeps.id],
      agent: null,
      reason: `Phase ${blockedByDeps.id} blocked by incomplete dependencies: ${(blockedByDeps.blocked_by || []).join(", ")}`,
      checkpoint: null,
      caps: {},
      overrides: {},
      warnings: [],
      how: computeHow("blocked", blockedByDeps, ctx),
    };
  }

  // Get the step for the first eligible phase (batch shares the same step)
  const firstPhase = eligible[0];
  const result = stepForPhase(firstPhase, task, ctx);

  // Verify artifacts (D13)
  const artifactCheck = verifyArtifacts(firstPhase, task, ctx);
  if (artifactCheck.blocked) {
    const artifactHow = computeArtifactHow(artifactCheck.reason, firstPhase, ctx);
    return {
      step: "blocked",
      phase_ids: eligible.map((p) => p.id),
      agent: null,
      reason: artifactCheck.reason,
      checkpoint: null,
      caps: result.caps,
      overrides: {},
      warnings: [],
      how: artifactHow,
    };
  }

  // Collect warnings from eligible phases (D32)
  const warnings = eligible
    .filter((p) => p.warnings && p.warnings.length > 0)
    .flatMap((p) => p.warnings.map((w) => ({ phase: p.id, ...w })));

  const how = computeHow(result.step, firstPhase, ctx);
  // F16: override how for the auto-advance done step
  if (result.pending_transitions && result.step === "done") {
    how.tool = "Bash";
    how.command = `a next --task-dir ${ctx.taskDir || "<dir>"} (auto-advances committed -> landed -> done on base)`;
  }

  const nextResult = {
    step: result.step,
    phase_ids: eligible.map((p) => p.id),
    agent: result.agent,
    reason: result.reason,
    checkpoint: result.checkpoint,
    caps: result.caps,
    overrides: {},
    warnings,
    how,
  };
  if (result.pending_transitions) nextResult.pending_transitions = result.pending_transitions;
  if (result.push_needed !== undefined) nextResult.push_needed = result.push_needed;

  // F21: --explain
  if (ctx.explain) {
    nextResult.explain = buildExplain(firstPhase, task, ctx, result);
  }

  return nextResult;
}

/**
 * Compute a `how` for artifact-missing blocked cells (High 3).
 * The how names the missing artifact and the command that supplies it,
 * making the cell actionable (third shape of the three-shape rule).
 */
function computeArtifactHow(reason, phase, ctx) {
  const dir = (ctx && ctx.taskDir) || "<dir>";
  const N = phase ? phase.id : "<N>";
  if (reason.includes("plan file") || reason.includes("plan_path")) {
    return { tool: "Agent", command: `spawn Explorer on phase ${N} to write the plan (plan file missing)` };
  }
  if (reason.includes("commit") || reason.includes("commits")) {
    return { tool: "Bash", command: `a state update --task-dir ${dir} --phase-id ${N} --phase-status committed --commits <sha,…>` };
  }
  return { tool: null, command: null };
}

/**
 * Build the explanation for `a next --explain` (F21).
 * Returns the decomposed cell: phase status, knobs, artifacts, git facts, rule.
 */
function buildExplain(phase, task, ctx, result) {
  const knobs = task.knobs || {};
  const artifacts = {
    plan_path: phase.plan_path ? true : false,
    commits: (phase.commits && phase.commits.length > 0) ? true : false,
    landed_sha: phase.landed_sha ? true : false,
    reports: phase.reports ? Object.keys(phase.reports) : [],
  };
  const gitFacts = ctx.gitFacts ? {
    base: ctx.gitFacts.base,
    currentBranch: ctx.gitFacts.currentBranch(),
  } : null;
  return {
    phase_id: phase.id,
    phase_status: phase.status,
    knobs: Object.fromEntries(
      Object.entries(knobs).filter(([k, v]) => v !== undefined)
    ),
    artifacts,
    git_facts: gitFacts,
    matching_rule: result.reason,
    step: result.step,
    agent: result.agent,
  };
}

/**
 * Apply pending transitions outside computeNext (F16, D60 requirement 2).
 * Attempts the task lock non-blocking (skips if held), re-reads task.json,
 * re-verifies git facts, applies each pending transition, writes task.json,
 * and re-renders state.md. Never runs git push — the push is a CLI-path step.
 *
 * @param {object} task - The task.json (re-read inside the lock)
 * @param {object} phase - The phase to advance
 * @param {string[]} pending - Transition descriptions like "committed -> landed"
 * @param {object} ctx - { projectDir, gitFacts, taskDir, policy }
 * @returns {{ applied: string[], skipped: boolean }}
 */
function applyPendingTransitions(taskDir, pending, ctx) {
  const { withLock } = require("./lock");
  const taskLib = require("./task");
  const { applyTransition } = require("./transitions");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };

  const applied = [];
  try {
    return withLock(taskDir, holder, () => {
      const task = taskLib.readTaskJson(taskDir);
      if (!task) return { applied, skipped: false };
      const phaseId = ctx.phaseId;
      const phase = (task.phases || []).find((p) => p.id === phaseId);
      if (!phase) return { applied, skipped: false };

      // Re-verify git facts
      if (!ctx.gitFacts && ctx.projectDir) {
        ctx.gitFacts = collectGitFacts(ctx.projectDir);
      }
      const transitionCtx = { ...ctx, taskDir };

      for (const desc of pending) {
        const [from, to] = desc.split(" -> ").map((s) => s.trim());
        if (phase.status !== from) continue;
        try {
          applyTransition(phase, to, task, transitionCtx);
          applied.push(desc);
        } catch (err) {
          if (err.transitionError) throw err;
          throw err;
        }
      }

      task.updated = new Date().toISOString();
      taskLib.writeTaskJson(taskDir, task);
      try {
        require("./render").renderStateMd(taskDir, task, ctx.projectDir);
      } catch {}
      return { applied, skipped: false };
    });
  } catch (err) {
    if (err.name === "LockHeldError") {
      return { applied, skipped: true };
    }
    throw err;
  }
}

module.exports = {
  computeNext,
  collectGitFacts,
  findEligiblePhases,
  stepForPhase,
  verifyArtifacts,
  ALL_STEPS,
  computeHow,
  computeArtifactHow,
  buildExplain,
  applyPendingTransitions,
};
