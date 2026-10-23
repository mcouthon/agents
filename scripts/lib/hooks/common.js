"use strict";

// Shared helpers for the five hook handlers. A handler exports run(payload) and
// returns null (allow, no output) or a context object built by context(); it
// never refuses and never throws. Identity and binding come from the payload.

const fs = require("fs");
const os = require("os");
const path = require("path");
const session = require("../session");

const EVENTS = {
  "session-register": "SessionStart",
  "session-end": "SessionEnd",
  prime: "UserPromptSubmit",
  "report-capture": "PreToolUse",
  "checkpoint-capture": "PostToolUse",
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

/** A declined hand-back or answer: one line that names the reason, the session and the subagent. */
function decline(payload, hook, reason) {
  const p = payload || {};
  const who = `session_id=${clean(p.session_id || "-", 40)} agent_id=${clean(p.agent_id || "-", 40)}`;
  log(payload, hook, "not_recorded", `reason=${clean(reason, 110)} ${who}`);
}

/** decline() and, when there is something to tell the agent, a context saying the report was not recorded. */
function skip(payload, hook, reason, text) {
  decline(payload, hook, reason);
  return text ? context(payload, hook, `Report not recorded: ${text}`) : null;
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

function readTask(taskDir) {
  try { return require("../task").readTaskJson(taskDir); } catch { return null; }
}

/**
 * The task the payload's session is bound to, from the registry entry that
 * names that session id. Returns { taskDir, task, projectDir } or { reason }.
 */
function boundTask(payload) {
  const sid = payload.session_id;
  if (!sid) return { reason: "no_session_id" };
  try { session.validateSessionId(sid); } catch { return { reason: "bad_session_id" }; }
  const reg = session.readRegistration(session.resolveSessionDir(sid));
  if (!reg || !reg.task_dir) return { reason: "no_task_bound" };
  let projectDir = payload.cwd || reg.cwd || process.cwd();
  if (payload.cwd) {
    try { projectDir = require("../repo").repoKey(payload.cwd).main_root; } catch {}
  }
  const taskDir = path.isAbsolute(reg.task_dir) ? reg.task_dir : path.resolve(projectDir, reg.task_dir);
  const task = readTask(taskDir);
  if (!task) return { reason: "task_unreadable" };
  return { taskDir, task, projectDir };
}

/** `a next` for a bound task, with the policy it was computed under. */
function nextFor(bound) {
  const policy = require("../policy").resolvePolicy(bound.projectDir);
  const next = require("../next").computeNext(bound.task, { projectDir: bound.projectDir, policy, taskDir: bound.taskDir });
  return { next, policy };
}

/**
 * The one phase `a next` assigns to `agent` (any agent when null), or
 * { reason: "no_phase_for_agent", detail } when it assigns none or several.
 */
function targetPhase(bound, agent) {
  const { next } = nextFor(bound);
  const ids = next.phase_ids || [];
  if (ids.length === 1 && (!agent || next.agent === agent)) return { id: ids[0] };
  return { reason: "no_phase_for_agent", detail: `a next: ${next.step} for ${next.agent || "nobody"} on ${ids.join(",") || "none"}` };
}

function hookPid() {
  const envPid = process.env.CLAUDE_PID ? parseInt(process.env.CLAUDE_PID, 10) : NaN;
  return Number.isInteger(envPid) ? envPid : process.ppid;
}

function answerText(v) {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(", ").trim();
  return "";
}

/** The question and options of an AskUserQuestion call. */
function checkpointQuestion(toolInput) {
  const q0 = Array.isArray(toolInput.questions) ? toolInput.questions[0] : null;
  const raw = (q0 && q0.options) || toolInput.options || [];
  const options = raw.map((o) => (typeof o === "string" ? o : (o && (o.label || o.text)) || ""));
  return { question: (q0 && q0.question) || toolInput.question || "", options };
}

/** The user's answer, from whichever shape the tool response carries it in. */
function checkpointAnswer(payload, question) {
  const input = payload.tool_input || {};
  const resp = payload.tool_response;
  const isMap = (a) => a && typeof a === "object" && !Array.isArray(a);
  const byQuestion = (a) => (isMap(a) ? answerText(a[question]) : "");
  const firstOf = (a) => (isMap(a) ? Object.values(a).map(answerText).find(Boolean) || "" : "");
  const respAnswers = resp && typeof resp === "object" ? resp.answers : null;
  return byQuestion(respAnswers)
    || firstOf(respAnswers)
    || byQuestion(input.answers)
    || (resp && typeof resp === "object" ? answerText(resp.answer) || answerText(resp.text) : "")
    || (typeof resp === "string" ? resp.trim() : "");
}

module.exports = {
  hookLogPath, hooksDisabledPath, hooksDisabled, clean, log, decline, skip, context, wrap,
  readTask, boundTask, nextFor, targetPhase, hookPid, checkpointQuestion, checkpointAnswer,
};
