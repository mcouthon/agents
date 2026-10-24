#!/usr/bin/env node
"use strict";
// The five hooks (session-register, session-end, prime, report-capture,
// checkpoint-capture): hook mode never exits non-zero on a crash, handlers
// never refuse, stubs honour the kill switch first.

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
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "A", "AGENTS_HOOKS_OFF", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_NON_INTERACTIVE"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const repo = path.resolve(__dirname, "..");
const A = path.join(repo, "scripts", "bin", "a");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-five-"));
let counter = 0;
const mk = (label) => { const d = path.join(tmpRoot, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
function write(file, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function runNode(node, args, { input = "", env = {}, cwd } = {}) {
  const r = spawnSync(node, args, { input, encoding: "utf8", cwd: cwd || mk("cwd"), env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const runA = (args, opts) => runNode(process.execPath, [A, ...args], opts);
const lines = (s) => s.split("\n").filter(Boolean);

// H1: a node without node:sqlite never costs more than one stderr line while the database is on.
// --no-experimental-sqlite needs node 22.13+ (23.4+); a dev on 22.5-22.12 sees a bad-option failure here.
{
  const wrapper = write(path.join(mk("wrap"), "node-nosqlite"), `#!/bin/sh\nexec "${process.execPath}" --no-experimental-sqlite "$@"\n`, 0o755);
  const db = write(path.join(mk("db"), "agents.db"), "");
  const on = runNode(wrapper, [A, "hook", "prime"], { env: { AGENTS_DB: db }, input: "{}" });
  check(on.status === 0 && on.out === "" && lines(on.err).length === 1 && on.err.includes("node:sqlite"), `H1: database on + node without node:sqlite exits 0 with one stderr line (${on.status}: ${on.err.trim()})`);
  const off = runNode(wrapper, [A, "hook", "prime"], { env: { AGENTS_DB: path.join(mk("nodb"), "agents.db") }, input: "{}" });
  check(off.status === 0 && !off.err.includes("node:sqlite"), `H1: database off runs the hook normally (${off.status}: ${off.err.trim()})`);
}

// H2: a crash while loading a hook handler fails open.
{
  const preload = write(path.join(mk("pre"), "preload.js"),
    'const M = require("module"); const orig = M._load;\n' +
    'M._load = function (req, ...rest) { if (/lib[\\/\\\\]hooks[\\/\\\\]prime$/.test(req)) throw new Error("boom-hook"); return orig.call(this, req, ...rest); };\n');
  const r = runA(["hook", "prime"], { env: { NODE_OPTIONS: `--require ${preload}` }, input: "{}" });
  check(r.status === 0 && r.err.includes("agents: hook prime failed:") && r.err.includes("boom-hook"), `H2: crash loading the prime handler exits 0 and names the failure (${r.status}: ${r.err.trim()})`);
}

// H3: a bad session id fails open (the path that used to exit 2).
{
  const r = runA(["hook", "session-end"], { input: JSON.stringify({ session_id: "bad/id" }) });
  check(r.status === 0 && r.out === "", `H3: session-end with a session id containing a slash exits 0 with no output (${r.status}: ${r.err.trim()})`);
}

// ---------------------------------------------------------------------------
// Handlers through `a hook <name>`. Behaviour of each handler is in test-lib-hooks.js.
// ---------------------------------------------------------------------------

const session = require("./lib/session");
const taskLib = require("./lib/task");
const common = require("./lib/hooks/common");

const logPath = common.hookLogPath();
const logLines = () => (fs.existsSync(logPath) ? lines(fs.readFileSync(logPath, "utf8")) : []);
const readTask = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
const taskText = (dir) => fs.readFileSync(path.join(dir, "task.json"), "utf8");

function makeTask({ phases, lease, checkpoints, knobs } = {}) {
  const dir = mk("task");
  const task = {
    schema: 2, slug: "acme-task", number: 999, title: "Acme task", status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS, ...(knobs || {}) }, binding: {}, lease: lease || {}, last_writer: {},
    phases: phases || [{ id: 1, name: "P0: build", status: "in_progress", blocked_by: [], manifest: [], reports: {}, counters: {} }],
    checkpoints: checkpoints || [], flags: [], created: new Date().toISOString(), updated: new Date().toISOString(),
  };
  write(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
  return dir;
}
let sidCounter = 0;
function bind(taskDir, agent = "conductor") {
  const sid = `bound-session-${++sidCounter}`;
  write(path.join(session.sessionsRoot(), sid, "registration.json"), JSON.stringify({ session_id: sid, agent, task_dir: taskDir }));
  return sid;
}
const bindNothing = () => `unbound-session-${++sidCounter}`;

const fence = (obj) => "Done.\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
const builderReport = { phase_id: 1, files_touched: ["a.js"], verification: [{ cmd: "npm test", exit: 0, summary: "ok" }], deviations: [], summary: "built" };
const reviewerReport = { phase_id: 1, verdict: "pass", issues: [], summary: "fine" };
const handback = (agentType, message) => ({ hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_type: agentType, tool_input: { message } });

// Runs a hook through the CLI and returns what a caller can observe: exit status, parsed output, and the log lines it added.
function hookRun(name, payload, { taskDir = null, env = {} } = {}) {
  const before = logLines().length;
  const p = { cwd: mk("proj"), session_id: taskDir ? bind(taskDir) : bindNothing(), ...payload };
  const r = runA(["hook", name], { input: JSON.stringify(p), env });
  return { status: r.status, output: r.out.trim() ? JSON.parse(r.out) : null, err: r.err, log: logLines().slice(before) };
}
const capture = (payload, opts) => hookRun("report-capture", payload, opts);

const FORBIDDEN = ["permissionDecision", "decision", "continue", "stopReason", "updatedInput", "systemMessage"];
function forbiddenKey(value) {
  if (!value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN.includes(k)) return k;
    const inner = forbiddenKey(v);
    if (inner) return inner;
  }
  return null;
}
function neverRefuses(status, output) {
  if (status !== 0) return false;
  if (output === null) return true;
  const hso = output.hookSpecificOutput;
  return Object.keys(output).every((k) => k === "hookSpecificOutput")
    && Boolean(hso) && typeof hso.hookEventName === "string"
    && Object.keys(hso).every((k) => k === "hookEventName" || k === "additionalContext")
    && forbiddenKey(output) === null;
}
// Exactly one new log line, five tab fields, for report-capture, with this outcome and reason prefix.
function oneLog(r, outcome, detailPrefix) {
  if (r.log.length !== 1) return false;
  const f = r.log[0].split("\t");
  return f.length === 5 && f[2] === "report-capture" && f[3] === outcome && f[4].startsWith(detailPrefix);
}
const context = (r) => (r.output ? r.output.hookSpecificOutput.additionalContext : "");

// H4: a name outside the five loads nothing, whatever it points at.
for (const name of ["common", "../hook"]) {
  const dir = makeTask();
  const before = taskText(dir);
  const logBefore = logLines().length;
  const r = runA(["hook", name], { input: JSON.stringify({ cwd: mk("proj"), session_id: bind(dir), ...handback("Builder", fence(builderReport)) }) });
  check(r.status === 0 && r.out === "" && r.err === "" && logLines().length === logBefore && taskText(dir) === before, `H4: a hook ${name} exits 0 silently and writes nothing (${r.status}: ${r.err.trim()})`);
}

// H5: the kill switch is checked inside `a` too, so a stub that skipped its own check still does nothing.
{
  const flag = write(path.join(mk("flag"), "off"), "");
  const dir = makeTask();
  const before = taskText(dir);
  const logBefore = logLines().length;
  const input = JSON.stringify({ cwd: mk("proj"), session_id: bind(dir), ...handback("Builder", fence(builderReport)) });
  const off = runA(["hook", "report-capture"], { input, env: { AGENTS_HOOKS_FLAG: flag } });
  check(off.status === 0 && off.out === "" && off.err === "" && logLines().length === logBefore && taskText(dir) === before, `H5: the flag present means exit 0, no output, no log line, task.json unchanged (${off.status}: ${off.err.trim()})`);
  const on = runA(["hook", "report-capture"], { input });
  check(on.status === 0 && readTask(dir).phases[0].reports.builder, "H5: the same payload without the flag records the report");
}

// R1-R3: recorded, identity from the payload, schema failure.
{
  const dir = makeTask();
  const r = capture(handback("Builder", fence(builderReport)), { taskDir: dir });
  const phase = readTask(dir).phases[0];
  check(r.status === 0 && phase.reports.builder.summary === "built" && phase.status === "implemented", "R1: a Builder hand-back is stored and the phase becomes implemented");
  check(context(r).startsWith("Report recorded") && oneLog(r, "recorded", "agent=builder phase=1 from=report result="), `R1: context says recorded and the log has one recorded line (${r.log})`);

  const dir2 = makeTask();
  const reg = capture(handback("Reviewer", fence(reviewerReport)), { taskDir: dir2 });
  check(readTask(dir2).phases[0].reports.code_review.verdict === "pass" && reg.status === 0, "R2: stored as the code review: the payload's agent_type decides the identity, not the bound registration");
  const none = capture({ hook_event_name: "PreToolUse", tool_input: { message: fence(builderReport) } }, { taskDir: dir2 });
  check(none.output === null && oneLog(none, "not_recorded", "reason=no_agent_type") && !readTask(dir2).phases[0].reports.builder, "R2: no agent_type stores nothing and logs no_agent_type");

  const dir3 = makeTask();
  const bad = capture(handback("Builder", fence({ phase_id: 1, summary: "only a summary" })), { taskDir: dir3 });
  check(Object.keys(readTask(dir3).phases[0].reports).length === 0 && context(bad).startsWith("Report not recorded") && oneLog(bad, "not_recorded", "reason=schema_error"), "R3: an invalid fence stores nothing and says why");
}

// R4: the hook and `a report` store the same report.
{
  const viaHook = makeTask();
  const viaCli = makeTask();
  capture(handback("Builder", fence(builderReport)), { taskDir: viaHook });
  const cli = runA(["report", "--task-dir", viaCli, "--phase-id", "1", "--agent", "builder"], { input: JSON.stringify(builderReport) });
  const a = readTask(viaHook).phases[0];
  const b = readTask(viaCli).phases[0];
  delete a.reports.builder.written_by;
  delete b.reports.builder.written_by;
  delete a.reports.tests.written_by;
  delete b.reports.tests.written_by;
  check(cli.status === 0 && JSON.stringify(a.reports) === JSON.stringify(b.reports) && a.status === "implemented" && b.status === "implemented", `R4: report-capture and a report store equal reports (${cli.status} ${cli.err.trim()})`);
}

// R5-R11: every decline writes exactly one log line and never refuses.
{
  const oracleDir = makeTask();
  const oracle = capture(handback("Oracle", fence(builderReport)), { taskDir: oracleDir });
  check(oracle.output === null && oneLog(oracle, "not_recorded", "reason=not_reporting_agent") && Object.keys(readTask(oracleDir).phases[0].reports).length === 0, "R5: Oracle is not a reporting agent");

  const leased = makeTask({ lease: { session_id: "holder-session", pid: 1 } });
  const recorded = capture(handback("Reviewer", fence(reviewerReport)), { taskDir: leased, env: { CLAUDE_CODE_SESSION_ID: "other-session" } });
  check(oneLog(recorded, "recorded", "agent=reviewer") && readTask(leased).phases[0].reports.code_review.verdict === "pass", `R6: a reviewer hand-back is recorded as the code review though the task's lease names another session (${recorded.log})`);
  check(forbiddenKey(recorded.output) === null, "R6: the recorded hand-back carries context only");

  const leasedCli = makeTask({ lease: { session_id: "holder-session", pid: 1 } });
  const cliReview = runA(["report", "--task-dir", leasedCli, "--phase-id", "1", "--agent", "reviewer"], { input: JSON.stringify(reviewerReport), env: { CLAUDE_CODE_SESSION_ID: "other-session" } });
  check(cliReview.status === 0 && readTask(leasedCli).phases[0].reports.code_review.verdict === "pass", `R4b: a report on a leased task by another session exits 0 and stores the verdict as the code review (${cliReview.status} ${cliReview.err.trim()})`);

  const unbound = capture(handback("Builder", fence(builderReport)), { taskDir: null });
  check(unbound.output === null && oneLog(unbound, "not_recorded", "reason=no_task_bound"), "R7: no bound task logs no_task_bound");

  const broken = mk("broken");
  write(path.join(broken, "task.json"), "{not json");
  const unreadable = capture(handback("Builder", fence(builderReport)), { taskDir: broken });
  check(unreadable.output === null && oneLog(unreadable, "not_recorded", "reason=task_unreadable"), "R8: task.json that is not JSON logs task_unreadable");

  const finished = makeTask({ phases: [{ id: 1, name: "P0: done", status: "done", blocked_by: [], manifest: [], reports: {}, counters: {} }] });
  const noPhase = capture(handback("Builder", fence({ ...builderReport, phase_id: 0 })), { taskDir: finished });
  check(noPhase.output === null && oneLog(noPhase, "not_recorded", "reason=no_phase_for_agent"), `R9: a done task with no phase stated logs no_phase_for_agent (${noPhase.log})`);

  const noMessage = capture({ hook_event_name: "PreToolUse", agent_type: "Builder", tool_input: { message: 42 } }, { taskDir: makeTask() });
  check(context(noMessage).startsWith("Report not recorded") && oneLog(noMessage, "not_recorded", "reason=no_message"), "R10: a non-string message logs no_message");

  const prose = capture(handback("Builder", "All done, nothing to report in JSON."), { taskDir: makeTask() });
  check(context(prose).startsWith("Report not recorded") && oneLog(prose, "not_recorded", "reason=parse_failure"), "R11: prose without JSON logs parse_failure");
}

// R12: an unexpected throw is an error line and exit 0; a persistence failure is a decline.
{
  const preload = write(path.join(mk("pre"), "validate-throws.js"),
    'const M = require("module"); const orig = M._load;\n' +
    'M._load = function (req, ...rest) { const m = orig.call(this, req, ...rest);\n' +
    '  if (/report$/.test(req) && m && m.validateReport && !m.__patched) { m.__patched = true; m.validateReport = () => { throw new Error("boom-validate"); }; }\n' +
    '  return m; };\n');
  const thrown = capture(handback("Builder", fence(builderReport)), { taskDir: makeTask(), env: { NODE_OPTIONS: `--require ${preload}` } });
  check(thrown.status === 0 && thrown.output === null && oneLog(thrown, "error", "reason=exception: boom-validate"), `R12: a throw inside the handler is one error line and exit 0 (${thrown.log})`);

  if (process.getuid && process.getuid() !== 0) {
    const locked = makeTask();
    fs.chmodSync(locked, 0o500);
    try {
      const failedPersist = capture(handback("Builder", fence(builderReport)), { taskDir: locked });
      check(failedPersist.status === 0 && oneLog(failedPersist, "not_recorded", "reason=persist_error") && context(failedPersist).startsWith("Report not recorded"), `R12: a persistence failure is a persist_error decline (${failedPersist.log})`);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  }
}

// C1, C4: checkpoint-capture records an answer on the open checkpoint and never refuses.
const ask = { questions: [{ question: "Ship it?", header: "Ship", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] };
const openCheckpoint = { id: "c-1-custom", phase: 1, type: "custom", question: "Ship it?", options: ["Yes", "No"], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null };
{
  const dir = makeTask({ checkpoints: [openCheckpoint] });
  const r = hookRun("checkpoint-capture", { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: ask, tool_response: { answers: { "Ship it?": "Yes" } } }, { taskDir: dir });
  check(r.status === 0 && r.output === null && readTask(dir).checkpoints[0].chosen === "Yes", "C1: an answer through a hook checkpoint-capture resolves the open checkpoint");

  const empty = makeTask({ checkpoints: [openCheckpoint] });
  const e = hookRun("checkpoint-capture", { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: ask, tool_response: {} }, { taskDir: empty });
  const f = e.log.length === 1 ? e.log[0].split("\t") : [];
  check(e.status === 0 && readTask(empty).checkpoints[0].chosen === null, "C4: no extractable answer leaves the open checkpoint open");
  check(f.length === 5 && f[2] === "checkpoint-capture" && f[3] === "not_recorded" && f[4].startsWith("reason=no_answer session_id="), `C4: and logs one not_recorded line (${e.log})`);
}

// S2: session-end marks the caller's own session ended and ignores subagents.
{
  const sid = "s2-session";
  const r1 = runA(["hook", "session-register"], { input: JSON.stringify({ session_id: sid, cwd: tmpRoot, source: "startup" }) });
  check(r1.status === 0 && Boolean(session.find({ session_id: sid })) && !session.find({ session_id: sid }).ended_at, "S2: a registered session starts without ended_at");
  const sub = runA(["hook", "session-end"], { input: JSON.stringify({ session_id: sid, agent_id: "sub-1" }) });
  check(sub.status === 0 && !session.find({ session_id: sid }).ended_at, "S2: a subagent's SessionEnd changes nothing");
  const end = runA(["hook", "session-end"], { input: JSON.stringify({ session_id: sid }) });
  check(end.status === 0 && typeof session.find({ session_id: sid }).ended_at === "string", "S2: session-end sets ended_at on the caller's own session");
}

// T2: none of the five can refuse through the CLI, whatever the payload or the bound task.
{
  const names = ["session-register", "session-end", "prime", "report-capture", "checkpoint-capture"];
  const good = makeTask();
  const broken = mk("broken");
  write(path.join(broken, "task.json"), "{not json");
  const ctxs = { unbound: null, bound: good, brokenTask: broken };
  const fenceBuilder = fence(builderReport);
  const payloads = {
    empty: {},
    eventOnly: { hook_event_name: "PreToolUse" },
    subagent: { hook_event_name: "SessionStart", agent_id: "sub-1", agent_type: "Builder" },
    validBuilder: handback("Builder", fenceBuilder),
    prose: handback("Builder", "no json here"),
    unknownAgent: handback("Wizard", fenceBuilder),
    noAgentType: { hook_event_name: "PreToolUse", tool_input: { message: fenceBuilder } },
    questionsAnswers: { hook_event_name: "PostToolUse", tool_input: { ...ask, answers: { "Ship it?": "Yes" } }, tool_response: { answers: { "Ship it?": "Yes" } } },
    legacyShape: { hook_event_name: "PostToolUse", tool_input: { question: "Ship it?", options: ["Yes"] }, tool_response: { answer: "Yes" } },
    stringResponse: { hook_event_name: "PostToolUse", tool_response: "Yes" },
  };
  const bad = [];
  for (const name of names) {
    for (const [cname, taskDir] of Object.entries(ctxs)) {
      for (const [pname, payload] of Object.entries(payloads)) {
        const sid = taskDir ? bind(taskDir) : bindNothing();
        const cli = runA(["hook", name], { input: JSON.stringify({ ...payload, session_id: sid, cwd: tmpRoot }) });
        let parsed = null;
        let parseOk = true;
        try { parsed = cli.out.trim() ? JSON.parse(cli.out) : null; } catch { parseOk = false; }
        if (!parseOk || !neverRefuses(cli.status, parsed)) bad.push(`${name}/${cname}/${pname}`);
      }
    }
  }
  check(bad.length === 0, `T2: no hook refuses across payloads and bound tasks (${bad.slice(0, 5).join(", ")})`);
}

// T1: the installer registers exactly the five, each backed by a stub and a handler.
{
  const installer = require("./install-global-hooks");
  const scripts = Object.values(installer.AGENTS_HOOKS).flat().map((e) => e.hooks[0].command.split("/").pop());
  check(scripts.sort().join() === "checkpoint-capture.sh,prime.sh,report-capture.sh,session-end.sh,session-register.sh", `T1: AGENTS_HOOKS holds exactly the five (${scripts})`);
  const stubsOk = scripts.every((s) => {
    const base = s.replace(/\.sh$/, "");
    const stubPath = path.join(repo, "hooks", s);
    return fs.existsSync(stubPath) && fs.readFileSync(stubPath, "utf8").includes(`hook ${base}`) && typeof require(`./lib/hooks/${base}`).run === "function";
  });
  check(stubsOk, "T1: each script exists in hooks/, calls its own handler name, and the handler exists");
  const commands = Object.values(installer.computeNewSettings({}).hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  check(commands.length === 5, `T1: a fresh settings.json gets five commands (${commands.length})`);
  check(fs.readdirSync(path.join(repo, "hooks")).sort().join() === "checkpoint-capture.sh,prime.sh,report-capture.sh,session-end.sh,session-register.sh", "T1: hooks/ holds the five stubs and nothing else");
}

// D1-D3: `a doctor hooks` flips and shows the kill switch; `a hooks status` is unchanged.
{
  const home = mk("home");
  const env = { HOME: home, AGENTS_HOOKS_FLAG: "" };
  const flag = path.join(home, ".agents", "hooks.disabled");
  const off = runA(["doctor", "hooks", "off"], { env });
  check(off.status === 0 && fs.existsSync(flag) && off.out.trim() === `hooks OFF (${flag})`, `D1: doctor hooks off creates the flag (${off.out.trim()})`);
  const status = runA(["doctor", "hooks"], { env });
  check(status.status === 0 && status.out.trim() === `hooks OFF (${flag})`, "D1: doctor hooks shows the state");
  const json = runA(["doctor", "hooks", "--json"], { env });
  check(JSON.parse(json.out).hooks === "off" && JSON.parse(json.out).flag === flag, "D1: --json carries the state and the flag path");
  const on = runA(["doctor", "hooks", "on"], { env });
  check(on.status === 0 && !fs.existsSync(flag) && on.out.trim() === `hooks ON (${flag})`, `D1: doctor hooks on removes the flag (${on.out.trim()})`);
  const again = runA(["doctor", "hooks", "on"], { env });
  check(again.status === 0, "D1: doctor hooks on is fine when the flag is already gone");

  if (process.getuid && process.getuid() !== 0) {
    runA(["doctor", "hooks", "off"], { env });
    fs.chmodSync(path.join(home, ".agents"), 0o500);
    try {
      const stuck = runA(["doctor", "hooks", "on"], { env });
      check(stuck.status === 1 && stuck.err.includes("chflags nouchg") && stuck.err.includes(flag) && fs.existsSync(flag), `D2: an unremovable flag exits 1 with the chflags hint (${stuck.err.trim()})`);
    } finally {
      fs.chmodSync(path.join(home, ".agents"), 0o700);
    }
  }

  runA(["doctor", "hooks", "on"], { env });
  const mode = runA(["hooks", "status"], { env });
  check(mode.status === 2 && mode.err.includes("Usage: a <group> <cmd>"), `D3: a hooks status exits 2 with the usage line (${mode.status})`);
  const hooksOff = runA(["hooks", "off"], { env });
  check(hooksOff.status === 2 && !fs.existsSync(flag), "D3: a hooks off exits 2 and writes no flag");
  const groups = runA(["--help"], { env }).out.split("\n").find((l) => l.startsWith("Groups:")) || "";
  check(groups.includes("doctor") && !/\bhooks\b/.test(groups), `D3: the Groups line has no hooks group (${groups})`);
  const touchHook = runA(["session", "touch", "--hook"], { env, input: JSON.stringify({ session_id: "acme-s1" }) });
  check(touchHook.status === 2 && touchHook.err.includes("--session-id is required"), `D3: session touch --hook is gone (${touchHook.status}: ${touchHook.err.trim()})`);
  const wtCreate = runA(["worktree", "create", "--hook"], { env, input: "{}" });
  check(wtCreate.status === 2, `D3: worktree create --hook exits 2 (${wtCreate.status})`);
  const sideways = runA(["doctor", "hooks", "sideways"], { env });
  check(sideways.status === 2 && sideways.err.includes("usage: a doctor hooks"), "D3: doctor hooks sideways exits 2 with a usage line");
}

// T3: the five stubs check the kill switch first, run the recorded node, and always exit 0.
{
  const names = ["session-register", "session-end", "prime", "report-capture", "checkpoint-capture"];
  const hooksDir = path.join(repo, "hooks");
  const fakeA = (body) => write(path.join(mk("fa"), "a"), `#!/bin/sh\n${body}\n`, 0o755);
  const fakeNode = write(path.join(mk("fn"), "node"), '#!/bin/sh\nA="$1"; shift; exec "$A" "$@"\n', 0o755);
  const runStub = (name, a, env = {}) =>
    spawnSync("sh", [path.join(hooksDir, `${name}.sh`)], { input: "{}", encoding: "utf8", cwd: mk("cwd"), env: { ...process.env, A: a, AGENTS_NODE: fakeNode, ...env } });

  for (const name of names) {
    const marker = path.join(mk("marker"), "ran");
    const touching = fakeA(`echo ran > "${marker}"; echo '{"x":1}'`);
    const flag = write(path.join(mk("flag"), "off"), "");

    const viaFlag = runStub(name, touching, { AGENTS_HOOKS_FLAG: flag });
    check(viaFlag.status === 0 && viaFlag.stdout === "" && !fs.existsSync(marker), `T3 ${name}: the flag file stops it before a starts`);
    const viaEnv = runStub(name, touching, { AGENTS_HOOKS_OFF: "1" });
    check(viaEnv.status === 0 && viaEnv.stdout === "" && !fs.existsSync(marker), `T3 ${name}: AGENTS_HOOKS_OFF=1 stops it before a starts`);

    const crash = runStub(name, fakeA("echo boom >&2; exit 1"));
    check(crash.status === 0, `T3 ${name}: a exiting 1 still exits 0`);
    const refuse = runStub(name, fakeA('echo \'{"hookSpecificOutput":{"hookEventName":"X"}}\'; exit 2'));
    check(refuse.status === 0 && refuse.stdout.includes("hookEventName"), `T3 ${name}: a exiting 2 still exits 0 and its output passes through`);

    const argsLog = path.join(mk("log"), "args");
    const logging = write(path.join(mk("ln"), "node"), `#!/bin/sh\necho "$@" > "${argsLog}"\n`, 0o755);
    const aPath = fakeA("exit 0");
    runStub(name, aPath, { AGENTS_NODE: logging });
    check(fs.readFileSync(argsLog, "utf8").trim() === `${aPath} hook ${name}`, `T3 ${name}: runs <recorded node> <a> hook ${name}`);

    const noNode = runStub(name, touching, { AGENTS_NODE: path.join(mk("nonode"), "node") });
    check(noNode.status === 0 && lines(noNode.stderr).length === 1 && noNode.stderr.includes("run ./install.sh") && !fs.existsSync(marker), `T3 ${name}: no recorded node exits 0 with one stderr line`);

    const text = fs.readFileSync(path.join(hooksDir, `${name}.sh`), "utf8").split("\n");
    const firstFlag = text.findIndex((l) => l.includes("hooks.disabled"));
    const firstNode = text.findIndex((l) => l.includes('"$NODE"'));
    check(firstFlag > 0 && firstFlag < firstNode, `T3 ${name}: the flag check comes before the first use of the node`);
    check(text.length <= 17 && !/exit [1-9]/.test(text.join("\n")), `T3 ${name}: at most 16 lines and no non-zero exit`);
  }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
