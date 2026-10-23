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
    AGENTS_HOOKS_ADVISE_FLAG: path.join(t, "no-advise"),
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

// H2: a crash while loading the hook library fails open.
{
  const preload = write(path.join(mk("pre"), "preload.js"),
    'const M = require("module"); const orig = M._load;\n' +
    'M._load = function (req, ...rest) { if (/lib[\\/\\\\]hook$/.test(req)) throw new Error("boom-hook"); return orig.call(this, req, ...rest); };\n');
  const r = runA(["hook", "prime"], { env: { NODE_OPTIONS: `--require ${preload}` }, input: "{}" });
  check(r.status === 0 && r.err.includes("agents: hook prime failed:") && r.err.includes("boom-hook"), `H2: crash loading lib/hook exits 0 and names the failure (${r.status}: ${r.err.trim()})`);
}

// H3: a bad session id on a --hook path fails open (the exact path that used to exit 2).
{
  const r = runA(["session", "touch", "--hook"], { env: { AGENTS_SESSION_ID: "bad/id" }, input: "{}" });
  check(r.status === 0 && lines(r.err).length === 1 && r.err.includes("session touch --hook failed"), `H3: bad AGENTS_SESSION_ID on session touch --hook exits 0 with one stderr line (${r.status}: ${r.err.trim()})`);
}

// ---------------------------------------------------------------------------
// Handlers: in-process (runHook with a context override) and through `a hook`.
// ---------------------------------------------------------------------------

const hook = require("./lib/hook");
const session = require("./lib/session");
const taskLib = require("./lib/task");

const logPath = hook.hookLogPath();
const logLines = () => (fs.existsSync(logPath) ? lines(fs.readFileSync(logPath, "utf8")) : []);
const readTask = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));

function makeTask({ phases, lease } = {}) {
  const dir = mk("task");
  const task = {
    schema: 2, slug: "acme-task", number: 999, title: "Acme task", status: "in_progress", mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS }, binding: {}, lease: lease || {}, last_writer: {},
    phases: phases || [{ id: 1, name: "P0: build", status: "in_progress", blocked_by: [], manifest: [], reports: {}, counters: {} }],
    checkpoints: [], flags: [], created: new Date().toISOString(), updated: new Date().toISOString(),
  };
  write(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
  return dir;
}
function bind(taskDir, agent = "conductor") {
  const dir = mk("session");
  write(path.join(dir, "registration.json"), JSON.stringify({ session_id: "bound-session", agent, task_dir: taskDir }));
  return dir;
}

const fence = (obj) => "Done.\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
const builderReport = { files_touched: ["a.js"], verification: [{ cmd: "npm test", exit: 0, summary: "ok" }], deviations: [], summary: "built" };
const reviewerReport = { verdict: "pass", issues: [], summary: "fine" };
const handback = (agentType, message) => ({ hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_type: agentType, tool_input: { message } });

// Runs report-capture and returns what a caller can observe: exit status, parsed output, and the log lines it added.
function capture(mode, payload, { taskDir = null, env = {} } = {}) {
  const before = logLines().length;
  if (mode === "inproc") {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    try {
      const r = hook.runHook("report-capture", payload, { taskDir, agentType: null, sessionId: "s-inproc", projectDir: mk("proj") });
      return { status: r.exitCode, output: r.output, err: "", log: logLines().slice(before) };
    } finally {
      for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  const e = { ...env };
  if (taskDir) e.AGENTS_SESSION_DIR = bind(taskDir);
  const r = runA(["hook", "report-capture"], { input: JSON.stringify(payload), env: e });
  return { status: r.status, output: r.out.trim() ? JSON.parse(r.out) : null, err: r.err, log: logLines().slice(before) };
}

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

// R1-R3: recorded, identity from the payload, schema failure.
for (const mode of ["inproc", "cli"]) {
  const dir = makeTask();
  const r = capture(mode, handback("Builder", fence(builderReport)), { taskDir: dir });
  const phase = readTask(dir).phases[0];
  check(r.status === 0 && phase.reports.builder.summary === "built" && phase.status === "implemented", `R1 (${mode}): a Builder hand-back is stored and the phase becomes implemented`);
  check(context(r).startsWith("Report recorded") && oneLog(r, "recorded", "agent=builder phase=1 result="), `R1 (${mode}): context says recorded and the log has one recorded line (${r.log})`);

  const dir2 = makeTask();
  const reg = capture(mode, handback("Reviewer", fence(reviewerReport)), { taskDir: dir2 });
  check(readTask(dir2).phases[0].reports.reviewer.verdict === "pass" && reg.status === 0, `R2 (${mode}): the payload's agent_type decides the identity, not the bound registration`);
  const none = capture(mode, { hook_event_name: "PreToolUse", tool_input: { message: fence(builderReport) } }, { taskDir: dir2 });
  check(none.output === null && oneLog(none, "not_recorded", "reason=no_agent_type") && !readTask(dir2).phases[0].reports.builder, `R2 (${mode}): no agent_type stores nothing and logs no_agent_type`);

  const dir3 = makeTask();
  const bad = capture(mode, handback("Builder", fence({ summary: "only a summary" })), { taskDir: dir3 });
  check(Object.keys(readTask(dir3).phases[0].reports).length === 0 && context(bad).startsWith("Report not recorded") && oneLog(bad, "not_recorded", "reason=schema_error"), `R3 (${mode}): an invalid fence stores nothing and says why`);
}

// R4: the hook and `a report` store the same report.
{
  const viaHook = makeTask();
  const viaCli = makeTask();
  capture("cli", handback("Builder", fence(builderReport)), { taskDir: viaHook });
  const file = write(path.join(mk("rep"), "report.json"), JSON.stringify(builderReport));
  const cli = runA(["report", "--task-dir", viaCli, "--phase-id", "1", "--agent", "builder"], { input: fs.readFileSync(file, "utf8") });
  const a = readTask(viaHook).phases[0];
  const b = readTask(viaCli).phases[0];
  delete a.reports.builder.written_by;
  delete b.reports.builder.written_by;
  check(cli.status === 0 && JSON.stringify(a.reports) === JSON.stringify(b.reports) && a.status === "implemented" && b.status === "implemented", `R4: report-capture and a report store equal reports (${cli.status} ${cli.err.trim()})`);
}

// R5-R12: every decline writes exactly one log line and never refuses.
for (const mode of ["inproc", "cli"]) {
  const oracleDir = makeTask();
  const oracle = capture(mode, handback("Oracle", fence(builderReport)), { taskDir: oracleDir });
  check(oracle.output === null && oneLog(oracle, "not_recorded", "reason=not_reporting_agent") && Object.keys(readTask(oracleDir).phases[0].reports).length === 0, `R5 (${mode}): Oracle is not a reporting agent`);

  const leased = makeTask({ lease: { session_id: "holder-session", pid: 1 } });
  const rejected = capture(mode, handback("Reviewer", fence(reviewerReport)), { taskDir: leased, env: { CLAUDE_CODE_SESSION_ID: "other-session" } });
  const after = readTask(leased);
  check(rejected.status === 0 && !after.phases[0].reports.reviewer && after.lease.session_id === "holder-session" && oneLog(rejected, "not_recorded", "reason=attribution_rejected: verdict from session"), `R6 (${mode}): a verdict from another session is declined, not forced (${rejected.log})`);
  check(context(rejected).startsWith("Report not recorded: verdict from session") && forbiddenKey(rejected.output) === null, `R6 (${mode}): the decline carries context only`);
  const open = makeTask();
  const accepted = capture(mode, handback("Reviewer", fence(reviewerReport)), { taskDir: open, env: { CLAUDE_CODE_SESSION_ID: "other-session" } });
  check(oneLog(accepted, "recorded", "agent=reviewer") && readTask(open).phases[0].reports.reviewer.verdict === "pass", `R6 (${mode}): the same hand-back on an unleased task is recorded`);

  const unbound = capture(mode, handback("Builder", fence(builderReport)), { taskDir: null });
  check(unbound.output === null && oneLog(unbound, "not_recorded", "reason=no_task_bound"), `R7 (${mode}): no bound task logs no_task_bound`);

  const broken = mk("broken");
  write(path.join(broken, "task.json"), "{not json");
  const unreadable = capture(mode, handback("Builder", fence(builderReport)), { taskDir: broken });
  check(unreadable.output === null && oneLog(unreadable, "not_recorded", "reason=task_unreadable"), `R8 (${mode}): task.json that is not JSON logs task_unreadable`);

  const finished = makeTask({ phases: [{ id: 1, name: "P0: done", status: "done", blocked_by: [], manifest: [], reports: {}, counters: {} }] });
  const noPhase = capture(mode, handback("Builder", fence(builderReport)), { taskDir: finished });
  check(noPhase.output === null && oneLog(noPhase, "not_recorded", "reason=no_current_phase"), `R9 (${mode}): a task with no current phase logs no_current_phase`);

  const noMessage = capture(mode, { hook_event_name: "PreToolUse", agent_type: "Builder", tool_input: { message: 42 } }, { taskDir: makeTask() });
  check(context(noMessage).startsWith("Report not recorded") && oneLog(noMessage, "not_recorded", "reason=no_message"), `R10 (${mode}): a non-string message logs no_message`);

  const prose = capture(mode, handback("Builder", "All done, nothing to report in JSON."), { taskDir: makeTask() });
  check(context(prose).startsWith("Report not recorded") && oneLog(prose, "not_recorded", "reason=parse_failure"), `R11 (${mode}): prose without JSON logs parse_failure`);
}

// R12: an unexpected throw is an error line and exit 0; a persistence failure is a decline.
{
  const preload = write(path.join(mk("pre"), "validate-throws.js"),
    'const M = require("module"); const orig = M._load;\n' +
    'M._load = function (req, ...rest) { const m = orig.call(this, req, ...rest);\n' +
    '  if (/report$/.test(req) && m && m.validateReport && !m.__patched) { m.__patched = true; m.validateReport = () => { throw new Error("boom-validate"); }; }\n' +
    '  return m; };\n');
  const thrown = capture("cli", handback("Builder", fence(builderReport)), { taskDir: makeTask(), env: { NODE_OPTIONS: `--require ${preload}` } });
  check(thrown.status === 0 && thrown.output === null && oneLog(thrown, "error", "reason=exception: boom-validate"), `R12: a throw inside the handler is one error line and exit 0 (${thrown.log})`);

  if (process.getuid && process.getuid() !== 0) {
    const locked = makeTask();
    fs.chmodSync(locked, 0o500);
    try {
      const fail_persist = capture("cli", handback("Builder", fence(builderReport)), { taskDir: locked });
      check(fail_persist.status === 0 && oneLog(fail_persist, "not_recorded", "reason=persist_error") && context(fail_persist).startsWith("Report not recorded"), `R12: a persistence failure is a persist_error decline (${fail_persist.log})`);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  }
}

// C1-C4: checkpoint-capture never refuses and works from PostToolUse alone.
function checkpointRun(event, toolInput, toolResponse, { taskDir, mode = "inproc" } = {}) {
  const dir = taskDir || makeTask();
  const payload = { hook_event_name: event, tool_name: "AskUserQuestion", tool_input: toolInput };
  if (toolResponse !== undefined) payload.tool_response = toolResponse;
  const before = logLines().length;
  let r;
  if (mode === "inproc") {
    r = hook.runHook("checkpoint-capture", payload, { taskDir: dir, sessionId: "s", agentType: null, projectDir: mk("proj") });
    r = { status: r.exitCode, output: r.output };
  } else {
    const c = runA(["hook", "checkpoint-capture"], { input: JSON.stringify(payload), env: { AGENTS_SESSION_DIR: bind(dir) } });
    r = { status: c.status, output: c.out.trim() ? JSON.parse(c.out) : null };
  }
  return { ...r, dir, checkpoints: readTask(dir).checkpoints, log: logLines().slice(before) };
}
const ask = { questions: [{ question: "Ship it?", header: "Ship", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] };
{
  const a = checkpointRun("PostToolUse", ask, { answers: { "Ship it?": "Yes" } });
  check(a.status === 0 && a.output === null && a.checkpoints.length === 1 && a.checkpoints[0].chosen === "Yes" && a.checkpoints[0].question === "Ship it?", "C1: PostToolUse alone opens and resolves from tool_response.answers[question]");
  const b = checkpointRun("PostToolUse", ask, { answers: { "Another question text": "No" } });
  check(b.checkpoints.length === 1 && b.checkpoints[0].chosen === "No", "C1: falls back to the first value of tool_response.answers");
  const c = checkpointRun("PostToolUse", { ...ask, answers: { "Ship it?": "Yes" } }, {});
  check(c.checkpoints.length === 1 && c.checkpoints[0].chosen === "Yes", "C1: falls back to tool_input.answers[question]");
  const d = checkpointRun("PostToolUse", { question: "Ship it?", options: ["Yes", "No"] }, { answer: "No" });
  check(d.checkpoints.length === 1 && d.checkpoints[0].chosen === "No" && d.checkpoints[0].options.join() === "Yes,No", "C1: legacy question/options with tool_response.answer");
  const e = checkpointRun("PostToolUse", ask, { text: "Yes" });
  check(e.checkpoints[0].chosen === "Yes", "C1: tool_response.text");
  const f = checkpointRun("PostToolUse", ask, "Yes");
  check(f.checkpoints[0].chosen === "Yes", "C1: a string tool_response");
  const g = checkpointRun("PostToolUse", ask, { answers: { "Ship it?": "Yes" } }, { mode: "cli" });
  check(g.status === 0 && g.checkpoints.length === 1 && g.checkpoints[0].chosen === "Yes", "C1: the same through a hook checkpoint-capture");
}
{
  const dir = makeTask();
  process.env.CLAUDE_CODE_NON_INTERACTIVE = "1";
  const pre = checkpointRun("PreToolUse", ask, undefined, { taskDir: dir });
  delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
  check(pre.status === 0 && pre.output === null && pre.checkpoints.length === 1 && pre.checkpoints[0].chosen === null, "C2: a headless PreToolUse allows and opens the checkpoint");
  const post = checkpointRun("PostToolUse", ask, { answers: { "Ship it?": "Yes" } }, { taskDir: dir });
  check(post.checkpoints.length === 1 && post.checkpoints[0].chosen === "Yes", "C3: Pre then Post leaves exactly one checkpoint, resolved");
}
for (const mode of ["inproc", "cli"]) {
  const dir = makeTask();
  const pre = checkpointRun("PreToolUse", ask, undefined, { taskDir: dir, mode });
  const empty = checkpointRun("PostToolUse", ask, {}, { taskDir: dir, mode });
  const f = empty.log.length === 1 ? empty.log[0].split("\t") : [];
  check(empty.status === 0 && pre.checkpoints.length === 1 && empty.checkpoints.length === 1 && empty.checkpoints[0].chosen === null, `C4 (${mode}): no extractable answer leaves the open checkpoint open`);
  check(f.length === 5 && f[2] === "checkpoint-capture" && f[3] === "not_recorded" && f[4] === "reason=no_answer", `C4 (${mode}): and logs one not_recorded line (${empty.log})`);
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

// T2: none of the five can refuse, whatever the payload or the bound task.
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
  let bad = [];
  for (const name of names) {
    for (const [cname, taskDir] of Object.entries(ctxs)) {
      for (const [pname, payload] of Object.entries(payloads)) {
        const inproc = hook.runHook(name, payload, { taskDir, agentType: null, sessionId: "t2", projectDir: mk("proj") });
        if (!neverRefuses(inproc.exitCode, inproc.output)) bad.push(`inproc ${name}/${cname}/${pname}`);
        const env = taskDir ? { AGENTS_SESSION_DIR: bind(taskDir) } : {};
        const cli = runA(["hook", name], { input: JSON.stringify(payload), env });
        let parsed = null;
        let parseOk = true;
        try { parsed = cli.out.trim() ? JSON.parse(cli.out) : null; } catch { parseOk = false; }
        if (!parseOk || !neverRefuses(cli.status, parsed)) bad.push(`cli ${name}/${cname}/${pname}`);
      }
    }
  }
  check(bad.length === 0, `T2: no handler refuses across payloads and bound tasks (${bad.slice(0, 5).join(", ")})`);
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
