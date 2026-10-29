"use strict";

// Shared helpers for the two hook handlers. A handler exports run(payload) and
// returns null (allow, no output) or a context object built by context(); it
// never refuses and never throws. Identity and binding come from the payload.

const fs = require("fs");
const os = require("os");
const path = require("path");

const EVENTS = {
  "session-register": "SessionStart",
  "session-end": "SessionEnd",
};

function hookLogPath() {
  const logDir = process.env.AGENTS_LOGS_ROOT || path.join(os.homedir(), ".agents", "logs");
  return path.join(logDir, "hooks.log");
}

function hooksDisabledPath() {
  return process.env.AGENTS_HOOKS_FLAG || path.join(os.homedir(), ".agents", "hooks.disabled");
}

function hooksDisabled() {
  if (process.env.AGENTS_HOOKS_OFF === "1") return true;
  try { return fs.existsSync(hooksDisabledPath()); } catch { return false; }
}

// One value of a log line: no tab or newline can start a new field or line.
function clean(value, max = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/[\t\r\n]+/g, " ").slice(0, max);
}

/** ISO \t session \t hook \t recorded|not_recorded|error \t detail */
function log(payload, hook, outcome, detail) {
  try {
    const logPath = hookLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const sid = clean((payload && payload.session_id) || `pid-${process.pid}`);
    fs.appendFileSync(logPath, `${new Date().toISOString()}\t${sid}\t${hook}\t${outcome}\t${clean(detail)}\n`);
  } catch {}
}

function context(payload, name, text) {
  const event = payload && typeof payload.hook_event_name === "string" && payload.hook_event_name;
  return { hookSpecificOutput: { hookEventName: event || EVENTS[name], additionalContext: text } };
}

function wrap(name, fn) {
  return function run(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    try {
      return fn(p);
    } catch (err) {
      log(p, name, "error", `reason=exception: ${err && err.message}`);
      return null;
    }
  };
}

function hookPid() {
  const envPid = process.env.CLAUDE_PID ? parseInt(process.env.CLAUDE_PID, 10) : NaN;
  return Number.isInteger(envPid) ? envPid : process.ppid;
}

module.exports = {
  hookLogPath, hooksDisabledPath, hooksDisabled, clean, log, context, wrap,
  hookPid,
};
