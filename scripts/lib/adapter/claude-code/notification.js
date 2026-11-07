"use strict";

// Notification: record the needs-input signal on the session's registration,
// with the notification's kind (idle_prompt, permission_prompt, ...) verbatim.
// A subagent's notification changes nothing. Never denies (null output).

const common = require("./common");
const session = require("../../session");

const NAME = "notification";

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  const dir = session.resolveSessionDir(payload.session_id);
  if (!dir) return null;
  session.recordSignal(dir, {
    message: payload.message || null,
    kind: payload.notification_type || null,
  });
  return null;
}

module.exports = { run: common.wrap(NAME, run) };
