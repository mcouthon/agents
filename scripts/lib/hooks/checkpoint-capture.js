"use strict";

// PostToolUse on AskUserQuestion: record the user's answer on the open
// checkpoint. One is opened only in the approve step, or in a blocked step that
// names an engine checkpoint, for exactly one phase. An engine checkpoint takes
// only its own options (any case, any surrounding space); any other answer is
// logged and changes nothing, as does an answer with nothing to attach to.

const common = require("./common");
const checkpoints = require("../checkpoint");

const NAME = "checkpoint-capture";
const ENGINE_TYPES = ["approve_plan", "review_cap", "fix_cap", "review_fail"];

function run(payload) {
  if (payload.hook_event_name !== "PostToolUse") return null;
  const bound = common.boundTask(payload);
  if (bound.reason) return null;
  const { question, options } = common.checkpointQuestion(payload.tool_input || {});
  const answer = common.checkpointAnswer(payload, question);
  if (!answer) {
    common.decline(payload, NAME, "no_answer");
    return null;
  }

  const open = (bound.task.checkpoints || []).filter((cp) => cp.chosen === null);
  let cp = open[open.length - 1];
  let candidate = null;
  if (!cp) {
    const { next } = common.nextFor(bound);
    const engine = next.checkpoint;
    if (next.phase_ids && next.phase_ids.length === 1 && engine) {
      if (next.step === "approve") candidate = { type: "approve_plan", question: engine.question || question, options: engine.options || ["approve", "reject"] };
      else if (next.step === "blocked" && engine.type) candidate = { type: engine.type, question: engine.question, options: engine.options || [] };
      if (candidate) candidate.phaseId = next.phase_ids[0];
    }
  }
  const target = cp || candidate;
  if (!target) {
    common.decline(payload, NAME, "no_open_checkpoint");
    return null;
  }

  let chosen = answer;
  if (ENGINE_TYPES.includes(target.type)) {
    chosen = answer.trim().toLowerCase();
    const allowed = target.type === "approve_plan" ? ["approve", "approved", "reject", "rejected"] : (target.options || []).map((o) => String(o).toLowerCase());
    if (!allowed.includes(chosen)) {
      common.decline(payload, NAME, "not_an_option");
      return null;
    }
  }
  if (!cp) cp = checkpoints.openCheckpoint({ taskDir: bound.taskDir, phaseId: candidate.phaseId, type: candidate.type, question: candidate.question, options: candidate.options }).checkpoint;

  const ctx = { projectDir: bound.projectDir };
  const phase = (bound.task.phases || []).find((p) => p.id === cp.phase);
  if (cp.type === "approve_plan" && (chosen === "approve" || chosen === "approved") && phase && phase.status === "planned") {
    require("../report").persistReport({
      taskDir: bound.taskDir,
      phaseId: phase.id,
      agentType: "reviewer",
      report: { verdict: "pass", attributed_to: "user", issues: [], summary: `User resolved the plan review at checkpoint ${cp.id}` },
      ctx,
    });
  }
  try {
    checkpoints.resolveCheckpoint({ taskDir: bound.taskDir, checkpointId: cp.id, chosen, ctx });
  } catch (err) {
    if (!err.transitionError) throw err;
    common.decline(payload, NAME, `transition_rejected: ${err.message}`);
    return null;
  }
  common.log(payload, NAME, "recorded", `checkpoint=${cp.id} phase=${cp.phase} chosen=${chosen}`);
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
