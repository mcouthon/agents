"use strict";

// UserPromptSubmit: clear the needs-input signal when the session's user speaks.
// Fires for owner-typed prompts and machine-injected events (subagent hand-backs,
// task notifications) alike — the row unlights within seconds of an answer.
// A subagent's prompt-submit changes nothing. Never denies (null output).

const common = require("./common");
const session = require("../../session");

const NAME = "prompt-submit";

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  const dir = session.resolveSessionDir(payload.session_id);
  if (!dir) return null;
  session.clearSignal(dir);
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
