"use strict";

// PreToolUse on SubagentHandback: persist the report a subagent hands back.
// Identity is the payload's agent_type; the phase is the report's phase_id,
// else the phase `a next` gives that agent. A Builder's hand-back at the
// consolidate step is the consolidator report. Never forced, never refuses.

const common = require("./common");
const report = require("../report");

const NAME = "report-capture";

function run(payload) {
  const identity = String(payload.agent_type || "").toLowerCase();
  if (!identity) return common.skip(payload, NAME, "no_agent_type");
  if (!Object.hasOwn(report.loadSchemas(), identity)) return common.skip(payload, NAME, "not_reporting_agent");
  const bound = common.boundTask(payload);
  if (bound.reason) return common.skip(payload, NAME, bound.reason);

  let slot = identity;
  if (identity === "builder") {
    try {
      if (common.nextFor(bound).next.step === "consolidate") slot = "consolidator";
    } catch {}
  }

  const message = payload.tool_input && payload.tool_input.message;
  if (typeof message !== "string") return common.skip(payload, NAME, "no_message", "no report in the hand-back");
  const candidates = report.extractJsonCandidates(message);
  let chosen = null;
  let firstError = null;
  for (let i = candidates.length - 1; i >= 0 && !chosen; i--) {
    if (!candidates[i].valid) continue;
    const check = report.validateReport(slot, candidates[i].report);
    if (check.valid) chosen = candidates[i].report;
    else if (!firstError) firstError = check.errors[0];
  }
  if (!chosen && firstError) return common.skip(payload, NAME, `schema_error: ${firstError}`, firstError);
  if (!chosen) {
    const last = candidates[candidates.length - 1];
    return common.skip(payload, NAME, "parse_failure", last ? last.reason : "no JSON code block found in the report");
  }

  let phaseId = chosen.phase_id || 0;
  const from = phaseId ? "report" : "next";
  if (phaseId && !(bound.task.phases || []).some((p) => p.id === phaseId)) {
    return common.skip(payload, NAME, `unknown_phase: ${phaseId}`, `the task has no phase ${phaseId}`);
  }
  if (!phaseId && slot === "consolidator") {
    phaseId = bound.task.phases[bound.task.phases.length - 1].id;
  } else if (!phaseId) {
    const target = common.targetPhase(bound, identity);
    if (target.reason) return common.skip(payload, NAME, `${target.reason}: ${target.detail}`);
    phaseId = target.id;
  }

  try {
    const submitted = report.submitReport({ taskDir: bound.taskDir, phaseId, agentType: slot, report: chosen, projectDir: bound.projectDir });
    if (!submitted.valid) return common.skip(payload, NAME, `schema_error: ${submitted.errors[0]}`, submitted.errors[0]);
    const what = submitted.result.transition || "stored";
    common.log(payload, NAME, "recorded", `agent=${slot} phase=${phaseId} from=${from} result=${what}`);
    return common.context(payload, NAME, `Report recorded for phase ${phaseId}: ${what}`);
  } catch (err) {
    return common.skip(payload, NAME, `persist_error: ${err.message}`, err.message);
  }
}

module.exports = { run: common.wrap(NAME, run) };
