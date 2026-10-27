"use strict";

// UserPromptSubmit: reap the bound task's finished runs, inject its stored next step
// (computed afresh when none is stored) and apply the transitions it marks as pending
// (never pushes: a network call here would stall prompt submission).

const common = require("./common");
const session = require("../session");

const NAME = "prime";
const MAX_CONTEXT = 2048;

function run(payload) {
  const bound = common.boundTask(payload);
  if (bound.reason) return null;
  try { session.touch(payload.session_id); } catch {}

  if (require("../db").enabled()) {
    try {
      require("../run").reap({ taskDir: bound.taskDir });
    } catch (err) {
      common.log(payload, NAME, "error", `reason=reap: ${err.message}`);
    }
  }

  const nextStore = require("../next-store");
  const policy = require("../policy").resolvePolicy(bound.projectDir);
  const task = common.readTask(bound.taskDir) || bound.task;
  const next = nextStore.stored(bound.taskDir) || nextStore.describeNext(bound.taskDir, task, { projectDir: bound.projectDir, policy });

  const lines = [`Step: ${next.step}`];
  if (!next.call && next.how && next.how.tool) lines.push(`How: ${next.how.tool} — ${next.how.command}`);
  if (next.phase_ids && next.phase_ids.length > 0) lines.push(`Phase: ${next.phase_ids.join(", ")}`);
  if (next.agent) lines.push(`Agent: ${next.agent}`);
  if (next.checkpoint) {
    const cp = next.checkpoint;
    const options = Array.isArray(cp.options) && cp.options.length > 0 ? ` Options: ${cp.options.join(" / ")}` : "";
    const findings = cp.type ? " Show the Reviewer's findings before you ask." : "";
    lines.push(`Checkpoint: ${cp.question || cp.id}${options}${findings}`);
  }
  if (next.reason) lines.push(`Reason: ${next.reason}`);
  if (next.call) lines.push(`Call: ${next.call.text}`);
  if (next.awaiting) lines.push(`Awaiting: ${next.awaiting}`);
  const taskLine = `Task dir: ${bound.taskDir}`;
  const body = lines.join("\n");
  const text = body.length + 1 + taskLine.length > MAX_CONTEXT
    ? `${body.slice(0, Math.max(0, MAX_CONTEXT - taskLine.length - 1))}\n${taskLine}`
    : `${body}\n${taskLine}`;

  if (next.pending_transitions && next.phase_ids && next.phase_ids.length > 0) {
    try {
      require("../next").applyPendingTransitions(bound.taskDir, next.pending_transitions, {
        projectDir: bound.projectDir, taskDir: bound.taskDir, phaseId: next.phase_ids[0], policy,
      });
    } catch (err) {
      common.log(payload, NAME, "error", `reason=pending_transitions: ${err.message}`);
    }
  }
  return common.context(payload, NAME, text);
}

module.exports = { run: common.wrap(NAME, run) };
