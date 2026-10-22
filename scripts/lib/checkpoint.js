"use strict";

/**
 * `a checkpoint open|resolve` — writes checkpoints[] in task.json.
 * `resolve` with `chosen` triggers the implied transition:
 *   approve_plan → approved
 *   review_outcome (commit_anyway) → committed path
 *   skip → skipped
 */

const { writeTaskJson, readTaskJson } = require("./task");
const { applyTransition } = require("./transitions");
const { withLock } = require("./lock");
const { renderStateMd } = require("./render");

/**
 * Open a new checkpoint for a phase.
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {number} opts.phaseId - Phase ID
 * @param {string} opts.type - Checkpoint type
 * @param {string} opts.question - The question to ask
 * @param {string[]} [opts.options] - Available options
 * @returns {{ id: string, checkpoint: object }}
 */
function openCheckpoint(opts) {
  const { taskDir, phaseId, type, question, options } = opts;
  const holder = { session_id: process.pid, pid: process.pid };

  return withLock(taskDir, holder, () => {
    const task = readTaskJson(taskDir);
    if (!task) throw new Error("task.json not found. Run `a task migrate` first.");

    const id = `c-${phaseId}-${type}-${Date.now()}`;
    const checkpoint = {
      id,
      phase: phaseId,
      type,
      question,
      options: options || [],
      chosen: null,
      opened_at: new Date().toISOString(),
      resolved_at: null,
    };

    if (!task.checkpoints) task.checkpoints = [];
    task.checkpoints.push(checkpoint);
    task.updated = new Date().toISOString();
    writeTaskJson(taskDir, task);

    return { id, checkpoint };
  });
}

/**
 * Resolve an open checkpoint with the chosen option.
 * Triggers the implied transition based on checkpoint type.
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {string} opts.checkpointId - Checkpoint ID to resolve
 * @param {string} opts.chosen - The chosen option
 * @param {object} [opts.ctx] - { projectDir, gitFacts }
 * @returns {{ resolved: boolean, transition: string|null, phase: object }}
 */
function resolveCheckpoint(opts) {
  const { taskDir, checkpointId, chosen, ctx } = opts;
  const holder = { session_id: process.pid, pid: process.pid };
  const transitionCtx = { ...(ctx || {}), taskDir };

  return withLock(taskDir, holder, () => {
    const task = readTaskJson(taskDir);
    if (!task) throw new Error("task.json not found. Run `a task migrate` first.");

    const cp = (task.checkpoints || []).find((c) => c.id === checkpointId);
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);
    if (cp.chosen !== null) throw new Error(`Checkpoint already resolved: ${checkpointId}`);

    cp.chosen = chosen;
    cp.resolved_at = new Date().toISOString();

    const phase = (task.phases || []).find((p) => p.id === cp.phase);
    let transition = null;

    if (phase) {
      switch (cp.type) {
        case "approve_plan":
          if (chosen === "approve" || chosen === "approved") {
            try {
              applyTransition(phase, "approved", task, transitionCtx);
              transition = "reviewed → approved";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          } else if (chosen === "reject" || chosen === "rejected") {
            try {
              applyTransition(phase, "planned", task, transitionCtx);
              transition = "reviewed → planned (rejected)";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          }
          break;

        case "review_cap":
          if (chosen === "approve_anyway") {
            if (phase.status === "planned") {
              if (phase.reports) phase.reports.reviewer = null;
              if (!phase.reports) phase.reports = {};
              phase.reports.reviewer = {
                verdict: "pass",
                attributed_to: "user",
                issues: [],
                summary: "User approved at checkpoint (approve_anyway)",
              };
              try {
                applyTransition(phase, "reviewed", task, transitionCtx);
                transition = "planned -> reviewed";
              } catch (err) {
                if (err.transitionError) throw err;
                throw err;
              }
            }
          } else if (chosen === "force_replan") {
            if (phase.reports) phase.reports.reviewer = null;
            const counters = phase.counters || (phase.counters = {});
            counters.review_passes = Math.max(0, (counters.review_passes || 0) - 1);
            transition = "planned (review cleared, force replan)";
          } else if (chosen === "skip") {
            try {
              applyTransition(phase, "skipped", task, transitionCtx);
              transition = "planned -> skipped";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          }
          break;

        case "fix_cap":
          if (chosen === "skip") {
            try {
              applyTransition(phase, "skipped", task, transitionCtx);
              transition = "implemented -> skipped";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          } else if (chosen === "force_retry") {
            const counters = phase.counters || (phase.counters = {});
            counters.fix_attempts = 0;
            try {
              applyTransition(phase, "in_progress", task, transitionCtx);
              transition = "implemented -> in_progress";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          } else if (chosen === "abort") {
            try {
              applyTransition(phase, "failed", task, transitionCtx);
              transition = "implemented -> failed";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          }
          break;

        case "review_fail":
          if (chosen === "replan") {
            if (phase.reports && phase.reports.reviewer) {
              phase.reports.reviewer.verdict = "needs_work";
            }
            try {
              applyTransition(phase, "in_progress", task, transitionCtx);
              transition = "implemented -> in_progress";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
            const counters = phase.counters || (phase.counters = {});
            counters.fix_attempts = 0;
          } else if (chosen === "skip") {
            try {
              applyTransition(phase, "skipped", task, transitionCtx);
              transition = "implemented -> skipped";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          } else if (chosen === "abort") {
            try {
              applyTransition(phase, "failed", task, transitionCtx);
              transition = "implemented -> failed";
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          }
          break;

        case "review_outcome":
          if (chosen === "commit_anyway") {
            if (phase.status === "implemented") {
              try {
                applyTransition(phase, "committed", task, transitionCtx);
                transition = "implemented → committed";
              } catch (err) {
                if (err.transitionError) throw err;
                throw err;
              }
            }
          } else if (chosen === "skip") {
            try {
              applyTransition(phase, "skipped", task, transitionCtx);
              transition = `${phase.status} → skipped`;
            } catch (err) {
              if (err.transitionError) throw err;
              throw err;
            }
          }
          break;

        case "ship":
          if (chosen === "ship") {
            if (phase.status === "committed") {
              try {
                applyTransition(phase, "landed", task, transitionCtx);
                applyTransition(phase, "done", task, transitionCtx);
                transition = "committed → landed → done";
              } catch (err) {
                if (err.transitionError) throw err;
                throw err;
              }
            }
          }
          break;

        case "clarify":
          // Clarify resolution: increment clarify_rounds counter
          if (phase.counters) {
            phase.counters.clarify_rounds = (phase.counters.clarify_rounds || 0) + 1;
          } else {
            phase.counters = { clarify_rounds: 1, review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0 };
          }
          transition = "clarify resolved";
          break;

        case "custom":
          // Custom checkpoints don't trigger transitions
          transition = null;
          break;
      }
    }

    task.updated = new Date().toISOString();
    writeTaskJson(taskDir, task);

    if (ctx && ctx.projectDir) {
      try { renderStateMd(taskDir, task, ctx.projectDir); } catch {}
    }

    return {
      resolved: true,
      transition,
      phase: phase ? { id: phase.id, name: phase.name, status: phase.status } : null,
    };
  });
}

module.exports = { openCheckpoint, resolveCheckpoint };
