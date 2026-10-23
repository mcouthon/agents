"use strict";

// PostToolUse on AskUserQuestion: record the user's answer on the open
// checkpoint. A checkpoint is opened only in the approve step with exactly one
// phase; an answer with nothing open and no approve step is logged and dropped.

const common = require("./common");
const checkpoints = require("../checkpoint");

const NAME = "checkpoint-capture";

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
  if (!cp) {
    const { next } = common.nextFor(bound);
    if (next.step === "approve" && next.phase_ids && next.phase_ids.length === 1) {
      cp = checkpoints.openCheckpoint({ taskDir: bound.taskDir, phaseId: next.phase_ids[0], type: "approve_plan", question, options }).checkpoint;
    }
  }
  if (!cp) {
    common.decline(payload, NAME, "no_open_checkpoint");
    return null;
  }

  const ctx = { projectDir: bound.projectDir };
  const phase = (bound.task.phases || []).find((p) => p.id === cp.phase);
  if (cp.type === "approve_plan" && (answer === "approve" || answer === "approved") && phase && phase.status === "planned") {
    require("../report").persistReport({
      taskDir: bound.taskDir,
      phaseId: phase.id,
      agentType: "reviewer",
      report: { verdict: "pass", attributed_to: "user", issues: [], summary: `User resolved the plan review at checkpoint ${cp.id}` },
      ctx,
    });
  }
  checkpoints.resolveCheckpoint({ taskDir: bound.taskDir, checkpointId: cp.id, chosen: answer, ctx });
  common.log(payload, NAME, "recorded", `checkpoint=${cp.id} phase=${cp.phase} chosen=${answer}`);
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
