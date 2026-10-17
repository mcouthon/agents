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
  "commit", "land", "pr", "ci_wait", "consolidate", "done", "blocked",
];

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

  // Find the first non-terminal phase
  const first = phases.find(
    (p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped"
  );
  if (!first) return [];

  // Check if this phase is blocked by incomplete deps
  const blockedByIncomplete = (first.blocked_by || []).some((depId) => {
    const dep = phases.find((p) => p.id === depId);
    if (!dep) return true;
    return dep.status !== "done" && dep.status !== "landed";
  });
  if (blockedByIncomplete) return [first];

  // Batch: include following phases that share the same parallel_group,
  // are adjacent, and all eligible (not done/failed/skipped, deps satisfied)
  const knobs = task.knobs || {};
  const maxParallel = knobs.parallel || 3;
  const batch = [first];
  const firstIdx = phases.indexOf(first);

  for (let i = firstIdx + 1; i < phases.length; i++) {
    const p = phases[i];
    if (p.status === "done" || p.status === "failed" || p.status === "skipped") break;
    if (!p.parallel_group || !first.parallel_group) break;
    if (p.parallel_group !== first.parallel_group) break;
    // Check deps
    const pBlocked = (p.blocked_by || []).some((depId) => {
      const dep = phases.find((q) => q.id === depId);
      if (!dep) return true;
      return dep.status !== "done" && dep.status !== "landed";
    });
    if (pBlocked) break;
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
      if ((counters.review_passes || 0) >= CAPS.review_passes) {
        return {
          step: "blocked",
          agent: null,
          reason: `Phase ${phase.id} review_passes cap reached (${counters.review_passes || 0}/${CAPS.review_passes})`,
          checkpoint: {
            id: `c-${phase.id}-review-cap`,
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
          reason: `Phase ${phase.id} review failed`,
          checkpoint: null,
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
      // Check if commits are ancestors of base (landed)
      if (ctx.gitFacts) {
        const branch = phase.branch || ctx.gitFacts.currentBranch();
        const base = ctx.gitFacts.base;
        if (branch === base) {
          return {
            step: "done",
            agent: null,
            reason: `Phase ${phase.id} committed on base branch`,
            checkpoint: null,
            caps: capsResult,
          };
        }
        // Check if all commits are ancestors of base
        const commits = phase.commits || [];
        const allAncestors = commits.every((sha) => ctx.gitFacts.isAncestor(sha, `origin/${base}`));
        if (allAncestors && commits.length > 0) {
          return {
            step: "done",
            agent: null,
            reason: `Phase ${phase.id} commits are on ${base}`,
            checkpoint: null,
            caps: capsResult,
          };
        }
        // Check if it's a PR repo
        const policy = ctx.policy || {};
        if (policy.push === "pr") {
          // Check CI status
          if ((counters.ci_attempts || 0) < CAPS.ci_attempts) {
            return {
              step: "ci_wait",
              agent: null,
              reason: `Phase ${phase.id} waiting for CI`,
              checkpoint: null,
              caps: capsResult,
            };
          }
          return {
            step: "blocked",
            agent: null,
            reason: `Phase ${phase.id} CI attempts exhausted`,
            checkpoint: null,
            caps: capsResult,
          };
        }
        // Direct repo: needs landing
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
    };
  }

  // Find eligible phases
  const eligible = findEligiblePhases(task);
  if (eligible.length === 0) {
    // All phases are done/failed/skipped — check if task should be done
    const allDone = (task.phases || []).every(
      (p) => p.status === "done" || p.status === "failed" || p.status === "skipped"
    );
    if (allDone) {
      return {
        step: "consolidate",
        phase_ids: [],
        agent: null,
        reason: "All phases complete, task ready for consolidation",
        checkpoint: null,
        caps: {},
        overrides: {},
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
    };
  }

  // Get the step for the first eligible phase (batch shares the same step)
  const firstPhase = eligible[0];
  const result = stepForPhase(firstPhase, task, ctx);

  // Verify artifacts (D13)
  const artifactCheck = verifyArtifacts(firstPhase, task, ctx);
  if (artifactCheck.blocked) {
    return {
      step: "blocked",
      phase_ids: eligible.map((p) => p.id),
      agent: null,
      reason: artifactCheck.reason,
      checkpoint: null,
      caps: result.caps,
      overrides: {},
    };
  }

  return {
    step: result.step,
    phase_ids: eligible.map((p) => p.id),
    agent: result.agent,
    reason: result.reason,
    checkpoint: result.checkpoint,
    caps: result.caps,
    overrides: {},
  };
}

module.exports = {
  computeNext,
  collectGitFacts,
  findEligiblePhases,
  stepForPhase,
  verifyArtifacts,
  ALL_STEPS,
};
