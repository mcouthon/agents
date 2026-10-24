"use strict";

// UserPromptSubmit: inject what `a next` says for the bound task, and apply the
// transitions `a next` marks as pending (never pushes: a network call here
// would stall prompt submission).

const common = require("./common");
const session = require("../session");

const NAME = "prime";
const MAX_CONTEXT = 2048;

function run(payload) {
  const bound = common.boundTask(payload);
  if (bound.reason) return null;
  try { session.touch(payload.session_id); } catch {}

  const { next, policy } = common.nextFor(bound);
  const lines = [`Step: ${next.step}`];
  if (next.how && next.how.tool) lines.push(`How: ${next.how.tool} — ${next.how.command}`);
  if (next.phase_ids && next.phase_ids.length > 0) lines.push(`Phase: ${next.phase_ids.join(", ")}`);
  if (next.agent) lines.push(`Agent: ${next.agent}`);
  if (next.checkpoint) {
    const cp = next.checkpoint;
    const options = Array.isArray(cp.options) && cp.options.length > 0 ? ` Options: ${cp.options.join(" / ")}` : "";
    const findings = cp.type ? " Show the Reviewer's findings before you ask." : "";
    lines.push(`Checkpoint: ${cp.question || cp.id}${options}${findings}`);
  }
  if (next.reason) lines.push(`Reason: ${next.reason}`);
  lines.push(`Task dir: ${bound.taskDir}`);

  if (next.pending_transitions && next.phase_ids && next.phase_ids.length > 0) {
    try {
      require("../next").applyPendingTransitions(bound.taskDir, next.pending_transitions, {
        projectDir: bound.projectDir, taskDir: bound.taskDir, phaseId: next.phase_ids[0], policy,
      });
    } catch (err) {
      common.log(payload, NAME, "error", `reason=pending_transitions: ${err.message}`);
    }
  }
  return common.context(payload, NAME, lines.join("\n").slice(0, MAX_CONTEXT));
}

module.exports = { run: common.wrap(NAME, run) };
