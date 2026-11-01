"use strict";

// Notification: record the needs-input signal on the session's registration.
// A subagent's notification changes nothing. Never denies (null output).

const common = require("./common");
const session = require("../../session");

const NAME = "notification";

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  const dir = session.resolveSessionDir(payload.session_id);
  if (!dir) return null;
  session.recordSignal(dir, { message: payload.message || null });
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
