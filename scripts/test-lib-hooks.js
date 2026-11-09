#!/usr/bin/env node
"use strict";
// The two hook handlers through run(payload): identity and binding come from
// the payload, nothing ever refuses.

// Isolation: nothing here may touch the real HOME, config, git config or live PAV.
(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-iso-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_HOOKS_FLAG: path.join(t, "no-flag"),
    AGENTS_DB: path.join(t, "agents.db"),
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "A", "AGENTS_HOOKS_OFF", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const repo = path.resolve(__dirname, "..");
const A = path.join(repo, "scripts", "bin", "a");
const hooksDir = path.join(repo, "scripts", "lib", "adapter", "claude-code");
const common = require("./lib/adapter/claude-code/common");
const session = require("./lib/session");
const handlers = {
  "session-register": require("./lib/adapter/claude-code/session-register"),
  "session-end": require("./lib/adapter/claude-code/session-end"),
  "notification": require("./lib/adapter/claude-code/notification"),
  "prompt-submit": require("./lib/adapter/claude-code/prompt-submit"),
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
let counter = 0;
const mk = (label) => { const d = path.join(tmpRoot, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const proj = mk("proj");
const lines = (s) => s.split("\n").filter(Boolean);
const logLines = () => (fs.existsSync(common.hookLogPath()) ? lines(fs.readFileSync(common.hookLogPath(), "utf8")) : []);
const taskText = (dir) => fs.readFileSync(path.join(dir, "task.json"), "utf8");

function makeTask() {
  const dir = mk("task");
  const task = {
    schema: 2, slug: "acme-task", number: 999, title: "Acme task", status: "in_progress", mode: "full",
    knobs: {}, binding: {}, lease: {}, last_writer: {},
    phases: [{ id: 1, name: "P1", status: "in_progress", blocked_by: [] }], checkpoints: [], flags: [],
    created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
  return dir;
}

let sidCounter = 0;
function bind(taskDir, { agent = "conductor" } = {}) {
  const sid = `sid-${++sidCounter}`;
  const dir = path.join(session.sessionsRoot(), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "registration.json"), JSON.stringify({ schema: 1, session_id: sid, agent, task_dir: taskDir, cwd: proj, pid: null }));
  return sid;
}

function payloadFor(sid, extra = {}, { unbound = false } = {}) {
  if (!unbound && !fs.existsSync(path.join(session.sessionsRoot(), sid, "registration.json"))) throw new Error(`no registration for ${sid}`);
  return { session_id: sid, cwd: proj, ...extra };
}

function exercise(name, payload) {
  const before = logLines().length;
  const output = handlers[name].run(payload);
  return { output, log: logLines().slice(before) };
}
const contextOf = (r) => (r.output ? r.output.hookSpecificOutput.additionalContext : "");

// SR1: session-register binds nothing itself and claims no lease.
{
  const dir = makeTask();
  const sid = bind(dir);
  process.env.CLAUDE_PID = "4242";
  try {
    const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
    const taskBefore = taskText(dir);
    const r = exercise("session-register", payloadFor(sid, { hook_event_name: "SessionStart", agent_type: "Conductor", source: "startup" }));
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
    check(reg.pid === 4242 && reg.agent === "conductor" && reg.task_dir === dir, "SR1: the registration gets the pid from CLAUDE_PID and keeps its task_dir");
    check(contextOf(r) === `Bound task: ${dir} (${path.basename(dir)}). Call \`prime\` on it first.` && taskText(dir) === taskBefore, "SR1: context names the bound task and task.json is byte-identical (no lease claimed)");

    const regBefore = fs.readFileSync(regPath, "utf8");
    const sub = exercise("session-register", payloadFor(sid, { agent_id: "sub-1", source: "startup" }));
    check(sub.output === null && fs.readFileSync(regPath, "utf8") === regBefore, "SR1: a subagent's SessionStart changes nothing");
    const entries = fs.readdirSync(session.sessionsRoot()).length;
    const noId = exercise("session-register", { hook_event_name: "SessionStart", cwd: proj });
    check(noId.output === null && fs.readdirSync(session.sessionsRoot()).length === entries, "SR1: a payload without session_id registers nothing");
  } finally {
    delete process.env.CLAUDE_PID;
  }
}

// SR2: the bound-task line is agent-aware — a coordinator seat carries no prime tool.
{
  const dir = makeTask();
  const sid = bind(dir, { agent: "coordinator" });
  const r = exercise("session-register", payloadFor(sid, { hook_event_name: "SessionStart", agent_type: "Coordinator", source: "startup" }));
  const reg = JSON.parse(fs.readFileSync(path.join(session.sessionsRoot(), sid, "registration.json"), "utf8"));
  check(reg.agent === "coordinator", "SR2: the registration stores the agent lowercased (the branch key)");
  const ctx = contextOf(r);
  check(ctx === `Bound task: ${dir} (${path.basename(dir)}). Re-derive from \`a ls --json --all\` and your records.`,
    "SR2: a coordinator seat is told its real first action (byte-exact)");
  check(!ctx.includes("prime"), "SR2: the coordinator's context names prime nowhere (its seat has no such tool)");
}

// SE1: session-end marks the caller's own session ended.
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  exercise("session-end", payloadFor(sid, { agent_id: "sub-1" }));
  check(!JSON.parse(fs.readFileSync(regPath, "utf8")).ended_at, "SE1: a subagent's SessionEnd changes nothing");
  const r = exercise("session-end", payloadFor(sid, { hook_event_name: "SessionEnd" }));
  check(r.output === null && typeof JSON.parse(fs.readFileSync(regPath, "utf8")).ended_at === "string", "SE1: the caller's own SessionEnd sets ended_at and prints nothing");
  const bad = exercise("session-end", { session_id: "bad/id" });
  check(bad.output === null && !fs.existsSync(path.join(session.sessionsRoot(), "bad")), "SE1: a session id with a path separator prints nothing and touches no other directory");
}
// N1: notification writes needs_input and never blocks.
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  const r = exercise("notification", payloadFor(sid, { message: "waiting for input" }));
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  check(r.output === null, "N1: notification returns null (never blocks)");
  check(reg.needs_input && reg.needs_input.message === "waiting for input" && typeof reg.needs_input.at === "string", "N1: the registration carries needs_input with the message and a timestamp");
  const sub = exercise("notification", payloadFor(sid, { agent_id: "sub-1", message: "x" }));
  check(sub.output === null && JSON.parse(fs.readFileSync(regPath, "utf8")).needs_input.message === "waiting for input", "N1: a subagent's notification changes nothing");
  const noId = exercise("notification", { message: "x" });
  check(noId.output === null, "N1: a payload without session_id does nothing");
}
// N2: a re-register (resume) clears needs_input.
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  exercise("notification", payloadFor(sid, { message: "waiting" }));
  check(JSON.parse(fs.readFileSync(regPath, "utf8")).needs_input, "N2: needs_input is set after notification");
  exercise("session-register", payloadFor(sid, { hook_event_name: "SessionStart", source: "resume" }));
  check(!JSON.parse(fs.readFileSync(regPath, "utf8")).needs_input, "N2: a re-register clears needs_input");
}
// N3: derive.sessionState reads needs_input.
{
  const sid = bind(makeTask());
  const { sessionState } = require("./lib/derive");
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  check(sessionState(JSON.parse(fs.readFileSync(regPath, "utf8")), { alive: true, zmxLive: false }) === "live", "N3: without needs_input the state is live");
  exercise("notification", payloadFor(sid, { message: "waiting" }));
  check(sessionState(JSON.parse(fs.readFileSync(regPath, "utf8")), { alive: true, zmxLive: false }) === "needs_input", "N3: with needs_input the state is needs_input");
}
// PS1: prompt-submit clears needs_input after a notification set it.
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  exercise("notification", payloadFor(sid, { message: "waiting for input" }));
  check(JSON.parse(fs.readFileSync(regPath, "utf8")).needs_input, "PS1: needs_input is set after notification");
  const r = exercise("prompt-submit", payloadFor(sid, { hook_event_name: "UserPromptSubmit" }));
  check(r.output === null, "PS1: prompt-submit returns null (never blocks)");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  check(!reg.needs_input, "PS1: needs_input is cleared after prompt-submit");
}
// PS2: prompt-submit with an unknown session id changes nothing and creates no file.
{
  const entries = fs.readdirSync(session.sessionsRoot()).length;
  const r = exercise("prompt-submit", { hook_event_name: "UserPromptSubmit", session_id: "unknown-sid-xyz", cwd: proj });
  check(r.output === null, "PS2: prompt-submit with unknown session returns null");
  check(fs.readdirSync(session.sessionsRoot()).length === entries, "PS2: no new directory created");
}
// PS3: prompt-submit on a registration with no needs_input is a byte-identical no-op (no session.write event).
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  const before = fs.readFileSync(regPath, "utf8");
  const db = require("./lib/db");
  const maxBefore = db.maxEventId();
  const r = exercise("prompt-submit", payloadFor(sid, { hook_event_name: "UserPromptSubmit" }));
  check(r.output === null, "PS3: prompt-submit on a no-needs_input registration returns null");
  check(fs.readFileSync(regPath, "utf8") === before, "PS3: the registration is byte-identical before and after");
  check(db.maxEventId() === maxBefore, "PS3: no session.write event appended (db.maxEventId unchanged)");
}
// PS4: a payload carrying agent_id changes nothing (mirrors the siblings' guards).
{
  const sid = bind(makeTask());
  const regPath = path.join(session.sessionsRoot(), sid, "registration.json");
  exercise("notification", payloadFor(sid, { message: "waiting" }));
  const before = fs.readFileSync(regPath, "utf8");
  const r = exercise("prompt-submit", payloadFor(sid, { hook_event_name: "UserPromptSubmit", agent_id: "sub-1" }));
  check(r.output === null, "PS4: prompt-submit with agent_id returns null");
  check(fs.readFileSync(regPath, "utf8") === before, "PS4: a subagent's prompt-submit changes nothing");
}
// HS1-HS3: the shape every handler keeps.
{
  const handlerNames = ["common.js", "notification.js", "prompt-submit.js", "session-end.js", "session-register.js"];
  const files = fs.readdirSync(hooksDir).sort();
  const handlerFiles = handlerNames.filter((f) => files.includes(f));
  check(handlerFiles.sort().join() === handlerNames.join(), `HS1: the directory holds common.js and the four handlers (${handlerFiles})`);
  const runHandlers = handlerFiles.filter((f) => f !== "common.js");
  const tooLong = runHandlers.filter((f) => fs.readFileSync(path.join(hooksDir, f), "utf8").split("\n").length - 1 > 120);
  check(tooLong.length === 0, `HS1: every handler is at most 120 lines (${tooLong})`);
  const extra = runHandlers.filter((f) => {
    const src = fs.readFileSync(path.join(hooksDir, f), "utf8");
    const named = [...src.matchAll(/\bfunction\s+(\w+)/g)].map((m) => m[1]).filter((n) => n !== "run");
    const arrows = /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/m.test(src);
    return named.length > 0 || arrows;
  });
  check(extra.length === 0, `HS1: no handler declares a function besides run (${extra})`);

  const banned = ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "currentPhase", "subagent-types", "permissionDecision", "systemMessage", '"decision"', "process.exit"];
  const hits = handlerFiles.flatMap((f) => banned.filter((b) => fs.readFileSync(path.join(hooksDir, f), "utf8").includes(b)).map((b) => `${f}:${b}`));
  check(hits.length === 0, `HS2: handler sources read nothing outside the payload and hold no refusal path (${hits})`);
}
{
  const FORBIDDEN = ["permissionDecision", "decision", "continue", "stopReason", "updatedInput", "systemMessage"];
  const forbiddenKey = (v) => {
    if (!v || typeof v !== "object") return null;
    for (const [k, inner] of Object.entries(v)) { if (FORBIDDEN.includes(k)) return k; const f = forbiddenKey(inner); if (f) return f; }
    return null;
  };
  const shapeOk = (out) => out === null || (Object.keys(out).join() === "hookSpecificOutput"
    && typeof out.hookSpecificOutput.hookEventName === "string"
    && Object.keys(out.hookSpecificOutput).sort().join() === "additionalContext,hookEventName"
    && forbiddenKey(out) === null);
  const broken = mk("broken");
  fs.writeFileSync(path.join(broken, "task.json"), "{not json");
  const sessions = { unbound: "matrix-unbound", bound: bind(makeTask()), brokenTask: bind(broken) };
  const payloads = {
    empty: {},
    eventOnly: { hook_event_name: "PreToolUse" },
    subagent: { hook_event_name: "SessionStart", agent_id: "sub-1", agent_type: "Builder" },
    start: { hook_event_name: "SessionStart", source: "startup" },
    hostileEvent: { hook_event_name: 7, tool_input: { message: 3 } },
  };
  const bad = [];
  for (const [name, handler] of Object.entries(handlers)) {
    for (const [cname, sid] of Object.entries(sessions)) {
      for (const [pname, extra] of Object.entries(payloads)) {
        const out = handler.run(payloadFor(sid, extra, { unbound: cname === "unbound" }));
        if (!shapeOk(out)) bad.push(`${name}/${cname}/${pname}`);
      }
    }
    if (!shapeOk(handler.run(null)) || !shapeOk(handler.run("text"))) bad.push(`${name}/non-object`);
  }
  check(bad.length === 0, `HS3: no handler returns anything but null or additionalContext (${bad.slice(0, 5)})`);
}


fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
