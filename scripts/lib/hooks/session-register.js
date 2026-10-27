"use strict";

// SessionStart: register the session under the id the payload names. The task
// binding is whatever the registry already holds for that id (the launcher's
// entry); this hook claims nothing and tells PAV.

const path = require("path");
const common = require("./common");
const session = require("../session");

const NAME = "session-register";

function run(payload) {
  if (payload.agent_id || !payload.session_id) return null;
  let repoKey = null;
  if (payload.cwd) {
    try { repoKey = require("../repo").repoKey(payload.cwd); } catch {}
  }
  let config = {};
  try { config = require("../config").loadConfig(); } catch {}

  const result = session.register({
    session_id: payload.session_id,
    pid: common.hookPid(),
    pid_at: new Date().toISOString(),
    cwd: payload.cwd,
    agent: payload.agent_type || payload.agent || null,
    repo_key: repoKey ? repoKey.key : null,
    transcript_path: payload.transcript_path || null,
    source: payload.source || null,
  });
  const reg = result.registration;
  const port = config.pav && config.pav.port;
  if (port) session.postToPav(reg, port);

  if (reg.parent_session_id) return common.context(payload, NAME, `Nested session under ${reg.parent_session_id}.`);
  if (!reg.task_dir || reg.origin === "dispatch") return null;
  return common.context(payload, NAME, `Bound task: ${reg.task_dir} (${path.basename(reg.task_dir)}). Call \`prime\` on it first.`);
}

module.exports = { run: common.wrap(NAME, run) };
