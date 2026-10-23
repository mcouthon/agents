"use strict";

// SessionEnd: mark the caller's own session ended. A subagent's SessionEnd and
// a payload without a session id change nothing.

const common = require("./common");
const session = require("../session");

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  session.unregister(payload.session_id);
  return null;
}

module.exports = { run: common.wrap("session-end", run) };
