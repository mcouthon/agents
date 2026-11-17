"use strict";

// UserPromptSubmit: clear the needs-input signal when the session's user speaks.
// Fires for owner-typed prompts and machine-injected events (subagent hand-backs,
// task notifications) alike — the row unlights within seconds of an answer.
// A subagent's prompt-submit changes nothing. Never denies.
// A linked session in a bootstrapping worktree also carries the setup state:
// every fire while the bootstrap is pending or dead, nothing once complete.

const common = require("./common");
const session = require("../../session");

const NAME = "prompt-submit";

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  const dir = session.resolveSessionDir(payload.session_id);
  if (!dir) return null;
  session.clearSignal(dir);
  const reg = session.readRegistration(dir);
  if (reg && reg.task_dir && reg.origin !== "dispatch" && payload.cwd) {
    const line = require("../../setup").awareness(payload.cwd);
    if (line) return common.context(payload, NAME, line);
  }
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
