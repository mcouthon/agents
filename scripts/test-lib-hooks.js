#!/usr/bin/env node
"use strict";
// The five hook handlers through run(payload): identity and binding come from
// the payload, a report lands on the phase it names, nothing ever refuses.

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
const hooksDir = path.join(repo, "scripts", "lib", "hooks");
const common = require("./lib/hooks/common");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const handlers = {
  "session-register": require("./lib/hooks/session-register"),
  "session-end": require("./lib/hooks/session-end"),
  prime: require("./lib/hooks/prime"),
  "report-capture": require("./lib/hooks/report-capture"),
  "checkpoint-capture": require("./lib/hooks/checkpoint-capture"),
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
let counter = 0;
const mk = (label) => { const d = path.join(tmpRoot, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const proj = mk("proj");
const lines = (s) => s.split("\n").filter(Boolean);
const logLines = () => (fs.existsSync(common.hookLogPath()) ? lines(fs.readFileSync(common.hookLogPath(), "utf8")) : []);
const taskText = (dir) => fs.readFileSync(path.join(dir, "task.json"), "utf8");
const readTask = (dir) => JSON.parse(taskText(dir));
const phaseOf = (dir, id) => readTask(dir).phases.find((p) => p.id === id);

function phase(id, status, extra = {}) {
  return { id, name: `P${id}`, status, blocked_by: [], manifest: [], reports: {}, counters: {}, ...extra };
}
const explorerOn = (summary) => ({ plan_path: "plan/p.md", manifest: ["a.js"], open_questions: [], summary });

function makeTask({ phases, mode = "full", knobs = {}, checkpoints = [] } = {}) {
  const dir = mk("task");
  const task = {
    schema: 2, slug: "acme-task", number: 999, title: "Acme task", status: "in_progress", mode,
    knobs: { ...taskLib.DEFAULT_KNOBS, ...knobs }, binding: {}, lease: {}, last_writer: {},
    phases: phases || [phase(1, "in_progress")], checkpoints, flags: [],
    created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
  fs.mkdirSync(path.join(dir, "plan"));
  fs.writeFileSync(path.join(dir, "plan", "p.md"), "# plan\n");
  return dir;
}

// Phases worked out of array order: 4 waits on 9, so `a next` wants an explorer on 5.
function outOfOrderTask() {
  const planned = (id, blockedBy, summary) => phase(id, "planned", { blocked_by: blockedBy, plan_path: "plan/p.md", reports: { explorer: { ...explorerOn(summary), written_by: { session_id: "old", agent: "explorer" } } } });
  return makeTask({ phases: [phase(1, "done"), planned(4, [9], "plan four"), phase(5, "not_started", { blocked_by: [1] }), planned(9, [1], "plan nine")] });
}

let sidCounter = 0;
function bind(taskDir, { agent = "conductor" } = {}) {
  const sid = `sid-${++sidCounter}`;
  const dir = path.join(session.sessionsRoot(), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "registration.json"), JSON.stringify({ schema: 1, session_id: sid, agent, task_dir: taskDir, cwd: proj, pid: null }));
  return sid;
}

// A payload for a session that has a registration. Only the tests of an absent binding say `unbound`.
function payloadFor(sid, extra = {}, { unbound = false } = {}) {
  if (!unbound && !fs.existsSync(path.join(session.sessionsRoot(), sid, "registration.json"))) throw new Error(`no registration for ${sid}`);
  return { session_id: sid, cwd: proj, ...extra };
}

const fence = (obj) => "Done.\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
const builderReport = { files_touched: ["a.js"], verification: [{ cmd: "npm test", exit: 0, summary: "ok" }], deviations: [], summary: "built" };
const reviewerReport = { verdict: "pass", issues: [], summary: "fine" };
const handback = (agentType, message) => ({ hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_type: agentType, tool_input: { message } });

// Runs a handler and returns what a caller can observe: the output and the log lines it added.
function exercise(name, payload) {
  const before = logLines().length;
  const output = handlers[name].run(payload);
  return { output, log: logLines().slice(before) };
}
const capture = (taskDir, extra, { agent_id } = {}) => {
  const sid = bind(taskDir);
  const payload = payloadFor(sid, extra);
  if (agent_id) payload.agent_id = agent_id;
  return { sid, ...exercise("report-capture", payload) };
};
const contextOf = (r) => (r.output ? r.output.hookSpecificOutput.additionalContext : "");
function oneLog(r, hook, outcome, detailPrefix) {
  if (r.log.length !== 1) return false;
  const f = r.log[0].split("\t");
  return f.length === 5 && f[2] === hook && f[3] === outcome && f[4].startsWith(detailPrefix);
}
const oneCapture = (r, outcome, detailPrefix) => oneLog(r, "report-capture", outcome, detailPrefix);

// RC1: a report that states its phase lands there.
{
  const dir = makeTask();
  const r = capture(dir, handback("Builder", fence({ ...builderReport, phase_id: 1 })));
  check(phaseOf(dir, 1).reports.builder.summary === "built" && phaseOf(dir, 1).status === "implemented", "RC1: a builder hand-back naming phase 1 is stored and the phase becomes implemented");
  check(oneCapture(r, "recorded", "agent=builder phase=1 from=report result=in_progress → implemented") && contextOf(r) === "Report recorded for phase 1: in_progress → implemented", `RC1: one recorded line and a context saying so (${r.log})`);
}

// RC2: the phase is the one the report names, else the one `a next` gives that agent, never the first unfinished.
{
  const dir = outOfOrderTask();
  const before = readTask(dir);
  const r = capture(dir, handback("explorer", fence({ ...explorerOn("nine only"), phase_id: 9 })));
  const after = readTask(dir);
  check(after.phases.find((p) => p.id === 9).reports.explorer.summary === "nine only" && oneCapture(r, "recorded", "agent=explorer phase=9 from=report"), `RC2a: an explorer report naming phase 9 lands on phase 9 (${r.log})`);
  check(JSON.stringify(after.phases.find((p) => p.id === 4)) === JSON.stringify(before.phases.find((p) => p.id === 4)) && JSON.stringify(after.phases.find((p) => p.id === 5)) === JSON.stringify(before.phases.find((p) => p.id === 5)), "RC2a: phases 4 and 5 are untouched");

  for (const label of ["no phase_id", "phase_id 0"]) {
    const d = outOfOrderTask();
    const b = readTask(d);
    const body = label === "no phase_id" ? explorerOn("via next") : { ...explorerOn("via next"), phase_id: 0 };
    const n = capture(d, handback("explorer", fence(body)));
    const a = readTask(d);
    check(a.phases.find((p) => p.id === 5).reports.explorer.summary === "via next" && a.phases.find((p) => p.id === 5).status === "planned" && oneCapture(n, "recorded", "agent=explorer phase=5 from=next"), `RC2b: ${label} lands on the phase a next gives the explorer (${n.log})`);
    check(JSON.stringify(a.phases.find((p) => p.id === 4)) === JSON.stringify(b.phases.find((p) => p.id === 4)) && JSON.stringify(a.phases.find((p) => p.id === 9)) === JSON.stringify(b.phases.find((p) => p.id === 9)), `RC2b: ${label} leaves phases 4 and 9 untouched`);
  }

  const dc = outOfOrderTask();
  const bc = taskText(dc);
  const c = capture(dc, handback("reviewer", fence(reviewerReport)));
  check(c.output === null && oneCapture(c, "not_recorded", "reason=no_phase_for_agent: a next: plan for explorer on 5") && taskText(dc) === bc, `RC2c: a reviewer report with no phase_id is declined and nothing changes (${c.log})`);

  const dd = outOfOrderTask();
  const bd = taskText(dd);
  const d = capture(dd, handback("explorer", fence({ ...explorerOn("x"), phase_id: 7 })));
  check(contextOf(d).startsWith("Report not recorded:") && oneCapture(d, "not_recorded", "reason=unknown_phase: 7") && taskText(dd) === bd, `RC2d: a stated phase that does not exist is declined, not guessed (${d.log})`);
}

// RC3: identity is the payload's agent_type.
{
  const dir = makeTask();
  const sid = bind(dir, { agent: "conductor" });
  const r = exercise("report-capture", payloadFor(sid, handback("Reviewer", fence({ ...reviewerReport, phase_id: 1 }))));
  check(phaseOf(dir, 1).reports.code_review && phaseOf(dir, 1).reports.code_review.verdict === "pass" && oneCapture(r, "recorded", "agent=reviewer phase=1"), "RC3: the payload's agent_type decides, not the registration's agent; a reviewer hand-back mid-build is stored as the code review");
  const none = capture(makeTask(), { hook_event_name: "PreToolUse", tool_input: { message: fence(builderReport) } });
  check(none.output === null && oneCapture(none, "not_recorded", "reason=no_agent_type"), "RC3: no agent_type is declined");
  const oracle = capture(makeTask(), handback("Oracle", fence(builderReport)));
  check(oracle.output === null && oneCapture(oracle, "not_recorded", "reason=not_reporting_agent"), "RC3: Oracle is not a reporting agent");
  const proto = capture(makeTask(), handback("constructor", fence(builderReport)));
  check(proto.output === null && oneCapture(proto, "not_recorded", "reason=not_reporting_agent"), "RC3: an agent_type that names an object property is not a reporting agent");
}

// RC4: every decline is one line that names the reason, the session and the subagent.
{
  const sub = { agent_id: "sub-1" };
  const messageOnly = (m) => handback("Builder", m);
  const noSid = exercise("report-capture", payloadFor("-", { ...messageOnly(fence(builderReport)), session_id: undefined, ...sub }, { unbound: true }));
  check(noSid.output === null && oneCapture(noSid, "not_recorded", "reason=no_session_id session_id=- agent_id=sub-1"), `RC4: no session_id (${noSid.log})`);
  const badSid = exercise("report-capture", payloadFor("bad/id", { ...messageOnly(fence(builderReport)), ...sub }, { unbound: true }));
  check(badSid.output === null && oneCapture(badSid, "not_recorded", "reason=bad_session_id session_id=bad/id agent_id=sub-1"), `RC4: a session id with a path separator (${badSid.log})`);
  const ghost = exercise("report-capture", payloadFor("ghost", { ...messageOnly(fence(builderReport)), ...sub }, { unbound: true }));
  check(ghost.output === null && oneCapture(ghost, "not_recorded", "reason=no_task_bound session_id=ghost agent_id=sub-1"), `RC4: a session with no registration (${ghost.log})`);

  const broken = mk("broken");
  fs.writeFileSync(path.join(broken, "task.json"), "{not json");
  const bsid = bind(broken);
  const unreadable = exercise("report-capture", payloadFor(bsid, { ...messageOnly(fence(builderReport)), ...sub }));
  check(unreadable.output === null && oneCapture(unreadable, "not_recorded", `reason=task_unreadable session_id=${bsid} agent_id=sub-1`), `RC4: task.json that is not JSON (${unreadable.log})`);

  const asSub = (message) => { const dir = makeTask(); return capture(dir, messageOnly(message), { agent_id: "sub-1" }); };
  const nonString = asSub(42);
  check(contextOf(nonString).startsWith("Report not recorded:") && oneCapture(nonString, "not_recorded", `reason=no_message session_id=${nonString.sid} agent_id=sub-1`), `RC4: a message that is not a string (${nonString.log})`);
  const prose = asSub("All done, nothing to report in JSON.");
  check(contextOf(prose).startsWith("Report not recorded:") && oneCapture(prose, "not_recorded", `reason=parse_failure session_id=${prose.sid} agent_id=sub-1`), `RC4: prose with no JSON (${prose.log})`);
  const schema = asSub(fence({ summary: "only a summary" }));
  check(contextOf(schema).startsWith("Report not recorded:") && oneCapture(schema, "not_recorded", `reason=schema_error: root.files_touched: required field missing session_id=${schema.sid} agent_id=sub-1`), `RC4: a report that fails the schema (${schema.log})`);

  if (process.getuid && process.getuid() !== 0) {
    const locked = makeTask();
    fs.chmodSync(locked, 0o500);
    try {
      const failed = capture(locked, messageOnly(fence({ ...builderReport, phase_id: 1 })), { agent_id: "sub-1" });
      check(contextOf(failed).startsWith("Report not recorded:") && oneCapture(failed, "not_recorded", "reason=persist_error"), `RC4: a task dir that cannot be written (${failed.log})`);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  }
}

// RC5: the hook and `a report` store the same report.
{
  const viaHook = makeTask();
  const viaCli = makeTask();
  capture(viaHook, handback("Builder", fence({ ...builderReport, phase_id: 1 })));
  const cli = spawnSync(process.execPath, [A, "report", "--task-dir", viaCli, "--phase-id", "1", "--agent", "builder"], { input: JSON.stringify({ ...builderReport, phase_id: 1 }), encoding: "utf8", cwd: mk("cwd") });
  const a = phaseOf(viaHook, 1);
  const b = phaseOf(viaCli, 1);
  delete a.reports.builder.written_by;
  delete b.reports.builder.written_by;
  delete a.reports.tests.written_by;
  delete b.reports.tests.written_by;
  check(cli.status === 0 && JSON.stringify(a.reports) === JSON.stringify(b.reports) && a.status === "implemented" && b.status === "implemented", `RC5: report-capture and a report store equal reports (${cli.status} ${cli.stderr.trim()})`);
  const clash = spawnSync(process.execPath, [A, "report", "--task-dir", viaCli, "--phase-id", "1", "--agent", "builder"], { input: JSON.stringify({ ...builderReport, phase_id: 2 }), encoding: "utf8", cwd: mk("cwd") });
  check(clash.status === 2 && clash.stderr.includes("phase_id 2 in the report does not match phase 1"), `RC5: a report whose phase_id differs from --phase-id exits 2 (${clash.status} ${clash.stderr.trim()})`);
}

// RC6: hostile text cannot forge a field or a line in the hook log.
{
  const hostile = "explorer\tx\nrecorded\tfake";
  const r = capture(makeTask(), handback(hostile, fence(builderReport)), { agent_id: `sub\t1\n${"y".repeat(500)}` });
  check(r.log.length === 1 && r.log[0].split("\t").length === 5 && r.log[0].split("\t")[3] === "not_recorded", `RC6: a hostile agent_type and agent_id make one five-field line (${JSON.stringify(r.log)})`);
  const long = capture(makeTask(), handback("x".repeat(500), fence(builderReport)), { agent_id: "z".repeat(500) });
  check(long.log.length === 1 && long.log[0].split("\t").every((f) => f.length <= 200) && long.log[0].split("\t")[4].length <= 200, "RC6: no log field is longer than 200 characters");
}

// RS1-RS12: the words agents already use are recorded without hand repair; the schema still judges.
{
  const plannedPhase = () => phase(1, "planned", { plan_path: "plan/p.md", reports: { explorer: { ...explorerOn("plan"), written_by: { session_id: "old", agent: "explorer" } } } });
  const planReview = (verdict, issues = []) => handback("reviewer", fence({ phase_id: 1, verdict, issues, summary: "s" }));
  const issue = (extra) => ({ severity: "Low", file: "a.js", line: "3", text: "t", ...extra });

  for (const [sent, stored] of [["APPROVED", "pass"], ["APPROVED WITH SUGGESTIONS", "pass_with_notes"], ["approved_with_suggestions", "pass_with_notes"]]) {
    const dir = makeTask({ phases: [plannedPhase()] });
    const r = capture(dir, planReview(sent));
    check(phaseOf(dir, 1).reports.reviewer?.verdict === stored && phaseOf(dir, 1).status === "reviewed" && oneCapture(r, "recorded", "agent=reviewer phase=1 from=report result=planned → reviewed"), `RS1-2: a plan review with verdict ${sent} is stored as ${stored} and the phase is reviewed (${r.log})`);
  }

  for (const sent of ["BLOCKING", "BLOCKING — the resolver step names no file"]) {
    const dir = makeTask({ phases: [plannedPhase()] });
    const r = capture(dir, planReview(sent));
    check(phaseOf(dir, 1).reports.reviewer?.verdict === "needs_work" && phaseOf(dir, 1).status === "planned" && oneCapture(r, "recorded", "agent=reviewer phase=1 from=report result=planned (review needs_work, revise plan)"), `RS3: a plan review with verdict ${sent} is stored as needs_work and the phase stays planned (${r.log})`);
  }

  for (const [sent, stored] of [["High", "red"], ["Medium", "yellow"], ["low", "yellow"]]) {
    const dir = makeTask({ phases: [plannedPhase()] });
    const r = capture(dir, planReview("pass_with_notes", [issue({ severity: sent })]));
    check(phaseOf(dir, 1).reports.reviewer?.issues[0].severity === stored && oneCapture(r, "recorded", "agent=reviewer phase=1"), `RS4-6: an issue with severity ${sent} is stored as ${stored} (${r.log})`);
  }

  {
    const dir = makeTask();
    const r = capture(dir, handback("committer", fence({ phase_id: 1, commits: ["abc1234", "def5678"], pushed: true })));
    const stored = phaseOf(dir, 1);
    check(oneCapture(r, "recorded", "agent=committer phase=1 from=report result=stored") && JSON.stringify(stored.commits) === '["abc1234","def5678"]' && stored.reports.committer?.commits[1].sha === "def5678", `RS7: SHA strings from a Committer are recorded as the phase's commits (${r.log})`);
  }

  {
    const dir = makeTask();
    const r = capture(dir, handback("builder", fence({ ...builderReport, phase_id: 1, files_touched: { modified: ["a.js"], deleted: ["b.js", "a.js"] } })));
    check(oneCapture(r, "recorded", "agent=builder phase=1 from=report result=in_progress → implemented") && JSON.stringify(phaseOf(dir, 1).reports.builder?.files_touched) === '["a.js","b.js"]', `RS8: grouped files_touched are recorded as one flat list (${r.log})`);
  }

  {
    const dir = makeTask({ phases: [phase(1, "implemented", { reports: { builder: { ...builderReport } } })] });
    const r = capture(dir, handback("reviewer", fence({ ...reviewerReport, phase_id: 1, files_touched: ["a.js"] })));
    check(oneCapture(r, "recorded", "agent=reviewer phase=1") && JSON.stringify(phaseOf(dir, 1).reports.code_review?.files_touched) === '["a.js"]', `RS9: a reviewer report with an extra key is recorded and keeps the key (${r.log})`);
    const ex = makeTask({ phases: [phase(1, "not_started")] });
    const e = capture(ex, handback("explorer", fence({ ...explorerOn("x"), phase_id: 1, notes: "n" })));
    check(oneCapture(e, "recorded", "agent=explorer phase=1") && phaseOf(ex, 1).reports.explorer?.notes === "n", `RS9: an explorer report with an extra key is recorded (${e.log})`);
  }

  {
    const dir = makeTask({ phases: [plannedPhase()] });
    const before = taskText(dir);
    const r = capture(dir, planReview("maybe"));
    check(oneCapture(r, "not_recorded", "reason=schema_error") && taskText(dir) === before, `RS10: a verdict the vocabulary does not know is declined and nothing is stored (${r.log})`);
  }

  for (const [label, bad] of [["a string value", { modified: "a.js" }], ["a non-string entry", { modified: ["a.js", 3] }]]) {
    const dir = makeTask();
    const r = capture(dir, handback("builder", fence({ ...builderReport, phase_id: 1, files_touched: bad })));
    check(oneCapture(r, "not_recorded", "reason=schema_error: root.files_touched: expected array, got object") && phaseOf(dir, 1).status === "in_progress", `RS11: grouped files_touched with ${label} are declined and the phase stays in progress (${r.log})`);
  }

  {
    const dir = makeTask({ phases: [plannedPhase()] });
    const r = capture(dir, planReview("needs_work", [issue({ severity: "Medium", line: 42 })]));
    check(oneCapture(r, "recorded", "agent=reviewer phase=1 from=report result=planned (review needs_work, revise plan)") && phaseOf(dir, 1).reports.reviewer?.issues[0].line === "42", `RS12: a numeric issue line is recorded as a string (${r.log})`);
  }
}

// RP1-RP4: a plan path is found as an absolute path, under the task's files dir, under the task dir, or under the repo root.
{
  const explore = (planPath, filesDirPlan) => {
    const dir = makeTask({ phases: [phase(1, "not_started")] });
    const t = readTask(dir);
    if (filesDirPlan) {
      t.files_dir = path.join(proj, ".tasks", "acme");
      fs.mkdirSync(path.join(t.files_dir, "plan"), { recursive: true });
      fs.writeFileSync(path.join(t.files_dir, "plan", "p.md"), "# plan\n");
      fs.rmSync(path.join(dir, "plan"), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(t, null, 2));
    const r = capture(dir, handback("explorer", fence({ ...explorerOn("x"), plan_path: planPath, phase_id: 1 })));
    return { dir, r };
  };

  const outside = path.join(mk("outside"), "abs-plan.md");
  fs.writeFileSync(outside, "# plan\n");
  const abs = explore(outside, false);
  check(oneCapture(abs.r, "recorded", "agent=explorer phase=1 from=report result=not_started → planned"), `RP1: an absolute plan path outside the task dir is accepted (${abs.r.log})`);

  const rel = explore("plan/p.md", false);
  check(oneCapture(rel.r, "recorded", "agent=explorer phase=1 from=report result=not_started → planned"), `RP2: a plan path relative to the task dir is accepted (${rel.r.log})`);

  const repoRel = explore(".tasks/acme/plan/p.md", true);
  check(oneCapture(repoRel.r, "recorded", "agent=explorer phase=1 from=report result=not_started → planned"), `RP3: a plan path relative to the repo root is accepted (${repoRel.r.log})`);

  const nowhere = explore("plan/missing.md", false);
  check(oneCapture(nowhere.r, "not_recorded", "reason=persist_error") && nowhere.r.log[0].includes("plan/missing.md") && phaseOf(nowhere.dir, 1).status === "not_started", `RP4: a plan path found nowhere is declined by name and the phase stays not_started (${nowhere.r.log})`);
}

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

// PR1: prime injects what `a next` says.
{
  const dir = makeTask();
  const r = exercise("prime", payloadFor(bind(dir), { hook_event_name: "UserPromptSubmit" }));
  const text = contextOf(r);
  check(text.includes("Step: ") && text.includes("Phase: 1") && text.endsWith(`Task dir: ${dir}`) && r.output.hookSpecificOutput.hookEventName === "UserPromptSubmit", `PR1: a bound task gets Step, Phase and Task dir lines (${JSON.stringify(text)})`);

  const clarify = makeTask({ phases: [phase(1, "planned", { plan_path: "plan/p.md", reports: { explorer: { ...explorerOn("p"), open_questions: [{ question: "Which store?", options: ["a", "b"] }] } } })] });
  const c = exercise("prime", payloadFor(bind(clarify), { hook_event_name: "UserPromptSubmit" }));
  check(contextOf(c).includes("Checkpoint: Which store?") && !contextOf(c).includes("[object Object]"), `PR1: an open question shows as its text (${JSON.stringify(contextOf(c))})`);

  const fast = makeTask({ mode: "fast", phases: [phase(1, "not_started")] });
  exercise("prime", payloadFor(bind(fast), { hook_event_name: "UserPromptSubmit" }));
  check(phaseOf(fast, 1).status === "in_progress", "PR1: a fast-mode not_started phase becomes in_progress");

  const unbound = exercise("prime", payloadFor("nobody", { hook_event_name: "UserPromptSubmit" }, { unbound: true }));
  check(unbound.output === null && unbound.log.length === 0, "PR1: an unbound session gets nothing");
}

// CP1-CP3: checkpoint-capture.
const ask = { questions: [{ question: "Approve the plan?", header: "Plan", options: [{ label: "approve" }, { label: "reject" }], multiSelect: false }] };
const answered = (answer) => ({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: ask, tool_response: { answers: { "Approve the plan?": answer } } });
const reviewedPhase = (id) => phase(id, "reviewed", { plan_path: "plan/p.md", reports: { reviewer: { verdict: "pass", issues: [], summary: "ok" } } });
{
  const dir = makeTask({ knobs: { approve: "ask" }, phases: [reviewedPhase(1)] });
  const r = exercise("checkpoint-capture", payloadFor(bind(dir), answered("approve")));
  const cps = readTask(dir).checkpoints;
  check(r.output === null && cps.length === 1 && cps[0].phase === 1 && cps[0].type === "approve_plan" && cps[0].chosen === "approve", `CP1: in the approve step an answer opens a checkpoint on that phase and resolves it (${r.log})`);

  const other = outOfOrderTask();
  const otherBefore = taskText(other);
  const o = exercise("checkpoint-capture", payloadFor(bind(other), answered("approve")));
  check(o.output === null && taskText(other) === otherBefore && oneLog(o, "checkpoint-capture", "not_recorded", "reason=no_open_checkpoint session_id=sid-"), `CP1: outside the approve step the same answer opens nothing (${o.log})`);

  const batch = makeTask({ knobs: { approve: "ask" }, phases: [{ ...reviewedPhase(1), parallel_group: "g" }, { ...reviewedPhase(2), parallel_group: "g" }] });
  const step = common.nextFor({ task: readTask(batch), projectDir: proj, taskDir: batch }).next;
  const batchBefore = taskText(batch);
  const b = exercise("checkpoint-capture", payloadFor(bind(batch), answered("approve")));
  check(step.step === "approve" && step.phase_ids.length === 2 && taskText(batch) === batchBefore && oneLog(b, "checkpoint-capture", "not_recorded", "reason=no_open_checkpoint"), `CP1: an approve step naming two phases opens nothing (${step.step} ${step.phase_ids})`);
}
{
  const open = (phaseId, type) => ({ id: `c-${phaseId}-${type}`, phase: phaseId, type, question: "Approve the plan?", options: ["approve", "reject"], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null });
  const dir = outOfOrderTask();
  const t = readTask(dir);
  t.checkpoints = [open(5, "custom")];
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(t, null, 2));
  const r = exercise("checkpoint-capture", payloadFor(bind(dir), answered("go")));
  check(readTask(dir).checkpoints[0].chosen === "go" && oneLog(r, "checkpoint-capture", "recorded", "checkpoint=c-5-custom phase=5 chosen=go"), `CP2: with a checkpoint open the answer resolves it whatever a next says (${r.log})`);

  const planned = makeTask({ knobs: { approve: "ask" }, phases: [phase(1, "planned", { plan_path: "plan/p.md" })], checkpoints: [open(1, "approve_plan")] });
  exercise("checkpoint-capture", payloadFor(bind(planned), answered("approve")));
  const p = phaseOf(planned, 1);
  check(p.reports.reviewer.attributed_to === "user" && p.reports.reviewer.verdict === "pass" && readTask(planned).checkpoints[0].chosen === "approve", "CP2: approving a planned phase stores a reviewer pass attributed to the user and resolves the checkpoint");
}
{
  const dir = makeTask({ phases: [reviewedPhase(1)], checkpoints: [{ id: "c-1-custom", phase: 1, type: "custom", question: "Q", options: [], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null }] });
  const sid = bind(dir);
  const none = exercise("checkpoint-capture", payloadFor(sid, { hook_event_name: "PostToolUse", tool_input: ask, tool_response: {} }));
  check(none.output === null && readTask(dir).checkpoints[0].chosen === null && oneLog(none, "checkpoint-capture", "not_recorded", `reason=no_answer session_id=${sid}`), `CP3: no answer logs once and leaves the checkpoint open (${none.log})`);
  const before = taskText(dir);
  const pre = exercise("checkpoint-capture", payloadFor(sid, { hook_event_name: "PreToolUse", tool_input: ask }));
  check(pre.output === null && pre.log.length === 0 && taskText(dir) === before, "CP3: PreToolUse does nothing");
}

// CP4: the answer is found in whichever shape the tool response carries it.
{
  const openCp = { id: "c-1-custom", phase: 1, type: "custom", question: "Ship it?", options: ["Yes", "No"], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null };
  const shipIt = { questions: [{ question: "Ship it?", header: "Ship", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] };
  const chosenFor = (toolInput, toolResponse) => {
    const dir = makeTask({ checkpoints: [{ ...openCp }] });
    const payload = { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: toolInput };
    if (toolResponse !== undefined) payload.tool_response = toolResponse;
    exercise("checkpoint-capture", payloadFor(bind(dir), payload));
    return readTask(dir).checkpoints[0].chosen;
  };
  check(chosenFor(shipIt, { answers: { "Ship it?": "Yes" } }) === "Yes", "CP4: tool_response.answers keyed by the question");
  check(chosenFor(shipIt, { answers: { "Another question text": "No" } }) === "No", "CP4: the first value of tool_response.answers when the key differs");
  check(chosenFor({ ...shipIt, answers: { "Ship it?": "Yes" } }, {}) === "Yes", "CP4: tool_input.answers");
  check(chosenFor({ question: "Ship it?", options: ["Yes", "No"] }, { answer: "No" }) === "No", "CP4: the legacy question shape with tool_response.answer");
  check(chosenFor(shipIt, { text: "Yes" }) === "Yes", "CP4: tool_response.text");
  check(chosenFor(shipIt, "Yes") === "Yes", "CP4: a string tool_response");
  check(chosenFor(shipIt, { answers: { "Ship it?": ["Yes", "No"] } }) === "Yes, No", "CP4: a multi-select answer is joined");
}

// CP5: an answer to an open review_cap / fix_cap / review_fail checkpoint moves the phase.
{
  const cp = (type, options) => ({ id: `c-1-${type}`, phase: 1, type, question: "Approve the plan?", options, chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null });
  const built = { files_touched: [], verification: [], deviations: [], summary: "built" };
  const answerOn = (phases, checkpoint, answer) => {
    const dir = makeTask({ phases, checkpoints: [checkpoint] });
    exercise("checkpoint-capture", payloadFor(bind(dir), answered(answer)));
    return { task: readTask(dir), phase: phaseOf(dir, 1) };
  };

  const cap = answerOn([phase(1, "planned", { counters: { review_passes: 2 } })], cp("review_cap", ["approve_anyway", "force_replan", "skip"]), "approve_anyway");
  check(cap.phase.status === "reviewed" && cap.phase.reports.reviewer.attributed_to === "user" && cap.phase.reports.reviewer.kind === "plan" && cap.task.checkpoints[0].chosen === "approve_anyway", "CP5: review_cap approve_anyway makes the phase reviewed with a user-attributed reviewer report");

  const fix = answerOn([phase(1, "implemented", { reports: { builder: built, reviewer: { verdict: "needs_work", issues: [], summary: "fix" } }, counters: { fix_attempts: 3 } })], cp("fix_cap", ["skip", "force_retry", "abort"]), "skip");
  check(fix.phase.status === "skipped" && fix.task.checkpoints[0].chosen === "skip", "CP5: fix_cap skip makes the phase skipped");

  const fail = answerOn([phase(1, "implemented", { reports: { builder: built, code_review: { kind: "code", verdict: "fail", issues: [], summary: "fail" } } })], cp("review_fail", ["replan", "skip", "abort"]), "replan");
  check(fail.phase.status === "in_progress" && fail.phase.reports.code_review.verdict === "needs_work" && fail.phase.counters.fix_attempts === 0 && fail.task.checkpoints[0].chosen === "replan", "CP5: review_fail replan puts the phase back in progress as needs_work with no fix attempts");
}

// CP6-CP9, PR2: an engine checkpoint takes only its own options, and a capped review can be answered.
{
  const approveStep = () => makeTask({ knobs: { approve: "ask" }, phases: [reviewedPhase(1)] });
  const cappedPlan = () => makeTask({ phases: [phase(1, "planned", { plan_path: "plan/p.md", counters: { review_passes: 2 }, reports: { reviewer: { verdict: "needs_work", issues: [], summary: "no" } } })] });
  const openApprove = { id: "c-1-approve_plan", phase: 1, type: "approve_plan", question: "Approve the plan?", options: ["approve", "reject"], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null };

  const open = makeTask({ knobs: { approve: "ask" }, phases: [reviewedPhase(1)], checkpoints: [{ ...openApprove }] });
  const a = exercise("checkpoint-capture", payloadFor(bind(open), answered("adopt suggestion 2")));
  check(readTask(open).checkpoints[0].chosen === null && phaseOf(open, 1).status === "reviewed" && oneLog(a, "checkpoint-capture", "not_recorded", "reason=not_an_option"), `CP6: a word that is not an option leaves an open approve_plan checkpoint and its phase alone (${a.log})`);

  const fresh = approveStep();
  const b = exercise("checkpoint-capture", payloadFor(bind(fresh), answered("adopt suggestion 2")));
  check(readTask(fresh).checkpoints.length === 0 && oneLog(b, "checkpoint-capture", "not_recorded", "reason=not_an_option"), `CP6: in the approve step the same word opens no checkpoint (${b.log})`);

  const yes = approveStep();
  const y = exercise("checkpoint-capture", payloadFor(bind(yes), answered(" Approve ")));
  const yesCp = readTask(yes).checkpoints[0];
  check(yesCp.chosen === "approve" && yesCp.type === "approve_plan" && phaseOf(yes, 1).status === "approved" && y.log.length === 1 && y.log[0].endsWith("chosen=approve"), `CP7: " Approve " opens and resolves the checkpoint as approve and the phase is approved (${y.log})`);

  const no = approveStep();
  exercise("checkpoint-capture", payloadFor(bind(no), answered("REJECT")));
  check(readTask(no).checkpoints[0].chosen === "reject" && phaseOf(no, 1).status === "planned", "CP7: REJECT resolves the checkpoint as reject and the phase goes back to planned");

  const capped = cappedPlan();
  const c = exercise("checkpoint-capture", payloadFor(bind(capped), answered("approve_anyway")));
  const cappedCps = readTask(capped).checkpoints;
  check(cappedCps.length === 1 && cappedCps[0].type === "review_cap" && cappedCps[0].options.join() === "approve_anyway,force_replan,skip" && cappedCps[0].chosen === "approve_anyway" && phaseOf(capped, 1).status === "reviewed", `CP8: a capped plan review is answerable without an open checkpoint (${c.log})`);
  check(c.log.length === 1 && c.log[0].split("\t")[3] === "recorded" && c.log[0].endsWith("phase=1 chosen=approve_anyway"), `CP8: one recorded line names the answer (${c.log})`);

  const refused = cappedPlan();
  const r = exercise("checkpoint-capture", payloadFor(bind(refused), answered("approve")));
  check(readTask(refused).checkpoints.length === 0 && phaseOf(refused, 1).status === "planned" && oneLog(r, "checkpoint-capture", "not_recorded", "reason=not_an_option"), `CP9: a capped review refuses a word that is not one of its options (${r.log})`);

  const cappedPrime = contextOf(exercise("prime", payloadFor(bind(cappedPlan()), { hook_event_name: "UserPromptSubmit" })));
  check(cappedPrime.includes("Checkpoint: Phase 1 exceeded review_passes cap (1). How to proceed? Options: approve_anyway / force_replan / skip"), `PR2: prime lists the capped review's options (${JSON.stringify(cappedPrime)})`);
  check(cappedPrime.includes("Show the Reviewer's findings before you ask."), "PR2: prime tells the Conductor to show the Reviewer's findings before asking at a cap");
  const approvePrime = contextOf(exercise("prime", payloadFor(bind(approveStep()), { hook_event_name: "UserPromptSubmit" })));
  check(approvePrime.includes("Options: approve / reject") && !approvePrime.includes("findings"), `PR2: prime lists approve / reject at the approve step (${JSON.stringify(approvePrime)})`);
}

// RK1-RK7, TS1-TS3: plan and code reviews are separate reports; test evidence has its own slot.
{
  const { computeNext } = require("./lib/next");
  const { landingEvidence } = require("./lib/transitions");
  const stepOf = (dir) => computeNext(readTask(dir), { taskDir: dir });
  const passingRun = [{ cmd: "npm test", exit: 0, summary: "ok" }];
  const planReview = { kind: "plan", verdict: "pass", issues: [], summary: "plan ok", written_by: { session_id: "old", agent: "reviewer" } };
  const built = { files_touched: [], verification: passingRun, deviations: [], summary: "built" };
  const review = (verdict, extra = {}) => handback("Reviewer", fence({ verdict, issues: [], summary: "v", phase_id: 1, ...extra }));
  const build = (verification, summary) => handback("Builder", fence({ files_touched: ["a.js"], verification, deviations: [], summary, phase_id: 1 }));

  const planned = makeTask({ phases: [phase(1, "planned", { plan_path: "plan/p.md", reports: { explorer: explorerOn("plan") } })] });
  const rk1 = capture(planned, review("pass_with_notes"));
  check(phaseOf(planned, 1).reports.reviewer.kind === "plan" && !phaseOf(planned, 1).reports.code_review && phaseOf(planned, 1).status === "reviewed" && oneCapture(rk1, "recorded", "agent=reviewer phase=1 from=report result=planned → reviewed"), `RK1: a review of a planned phase is the plan review (${rk1.log})`);

  const impl = () => makeTask({ phases: [phase(1, "implemented", { commits: [], reports: { builder: built, reviewer: planReview } })] });
  const rk2dir = impl();
  const planBefore = JSON.stringify(phaseOf(rk2dir, 1).reports.reviewer);
  const rk2 = capture(rk2dir, review("pass"));
  const stored = phaseOf(rk2dir, 1).reports.code_review;
  check(stored.kind === "code" && stored.verdict === "pass" && JSON.stringify(phaseOf(rk2dir, 1).reports.reviewer) === planBefore, "RK2: a review of an implemented phase is the code review and leaves the plan review untouched");
  check(oneCapture(rk2, "recorded", "agent=reviewer phase=1 from=report result=implemented (code review pass)") && stepOf(rk2dir).step === "commit", `RK2: the log names the code review and a next says commit (${rk2.log})`);

  const rk4dir = impl();
  capture(rk4dir, review("needs_work"));
  check(phaseOf(rk4dir, 1).status === "in_progress" && phaseOf(rk4dir, 1).reports.code_review.verdict === "needs_work", "RK4: a needs_work code review sends the phase back to the build");
  capture(rk4dir, build(passingRun, "fixed"));
  check(phaseOf(rk4dir, 1).status === "implemented" && phaseOf(rk4dir, 1).reports.code_review === null && stepOf(rk4dir).step === "review_code", `RK4: the next build voids the old code review and a next asks for a new one (${stepOf(rk4dir).step})`);

  const rk5dir = makeTask({ phases: [phase(1, "implemented", { counters: { fix_attempts: 2 }, reports: { builder: built, reviewer: planReview } })] });
  const rk5 = capture(rk5dir, review("needs_work"));
  const rk5next = stepOf(rk5dir);
  check(phaseOf(rk5dir, 1).status === "implemented" && phaseOf(rk5dir, 1).reports.code_review.verdict === "needs_work" && oneCapture(rk5, "recorded", "agent=reviewer phase=1 from=report result=implemented (code review needs_work, fix cap reached)"), `RK5: a needs_work review at the fix cap is stored and the phase stays implemented (${rk5.log})`);
  check(rk5next.step === "blocked" && rk5next.checkpoint.type === "fix_cap", `RK5: a next blocks on the fix_cap checkpoint (${rk5next.step})`);

  const rk6dir = impl();
  capture(rk6dir, review("pass", { kind: "plan" }));
  check(phaseOf(rk6dir, 1).reports.code_review.kind === "code", "RK6: a kind the report states is overwritten by the phase's status");

  const rk7dir = makeTask({ phases: [phase(1, "implemented", { reports: { builder: built, reviewer: planReview, code_review: { kind: "code", verdict: "pass_with_notes", issues: [], summary: "n" } } })] });
  capture(rk7dir, build(passingRun, "polished"));
  check(phaseOf(rk7dir, 1).reports.code_review.verdict === "pass_with_notes" && stepOf(rk7dir).step === "commit", "RK7: a Builder hand-back on an implemented phase keeps its code review");

  const ts1dir = makeTask();
  capture(ts1dir, build(passingRun, "built"));
  const ts1 = phaseOf(ts1dir, 1).reports.tests;
  check(JSON.stringify(ts1.verification) === JSON.stringify(passingRun) && ts1.written_by.agent === "builder", "TS1: a Builder's checks are kept as the phase's test evidence");

  const committedOf = (tests) => makeTask({ phases: [phase(1, "committed", { commits: ["abc123"], branch: "main", reports: { reviewer: planReview, code_review: { kind: "code", verdict: "pass", issues: [], summary: "c" }, builder: built, tests } })] });
  const ts2dir = committedOf({ verification: passingRun, written_by: { session_id: "old", agent: "builder" } });
  const testsBefore = JSON.stringify(phaseOf(ts2dir, 1).reports.tests);
  capture(ts2dir, build([], "replied"));
  const ts2 = phaseOf(ts2dir, 1);
  const taskOf = (dir) => readTask(dir);
  check(ts2.reports.builder.summary === "replied" && JSON.stringify(ts2.reports.tests) === testsBefore && landingEvidence(ts2, taskOf(ts2dir)).length === 0, "TS2: a Builder that ran no checks leaves the test evidence in place");
  const ts2failDir = committedOf({ verification: passingRun, written_by: { session_id: "old", agent: "builder" } });
  capture(ts2failDir, build([{ cmd: "npm test", exit: 1, summary: "red" }], "ci fix"));
  const ts2fail = phaseOf(ts2failDir, 1);
  check(ts2fail.reports.tests.verification[0].exit === 1 && landingEvidence(ts2fail, taskOf(ts2failDir)).join() === "tests", "TS2: a later failing run replaces the evidence and refuses the landing");

  const ts3dir = makeTask({ phases: [phase(1, "in_progress", { reports: { tests: { verification: passingRun } } })] });
  capture(ts3dir, build([], "rebuilt"));
  const ts3 = phaseOf(ts3dir, 1);
  check(ts3.status === "implemented" && ts3.reports.tests === null && landingEvidence(ts3, taskOf(ts3dir)).includes("tests"), "TS3: a new build that ran no checks replaces the old evidence with none");
}

// PR4, PR5: prime lands an on-base phase only once its commit is on origin on a direct repo.
{
  const gitIn = (dir, ...args) => spawnSync("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", ...args], { encoding: "utf8" }).stdout.trim();
  const origin = mk("origin");
  gitIn(origin, "init", "-q", "--bare", "-b", "main");
  const work = mk("direct");
  gitIn(work, "init", "-q", "-b", "main");
  gitIn(work, "commit", "-q", "--allow-empty", "-m", "init");
  gitIn(work, "remote", "add", "origin", origin);
  gitIn(work, "push", "-q", "-u", "origin", "main");
  fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), ".claude", "repo-policies.json"), JSON.stringify({ [fs.realpathSync(work)]: "direct" }));
  gitIn(work, "commit", "-q", "--allow-empty", "-m", "work");
  const sha = gitIn(work, "rev-parse", "HEAD");
  const reports = { reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "p" }, code_review: { kind: "code", verdict: "pass", issues: [], summary: "c" }, tests: { verification: [{ cmd: "true", exit: 0 }] } };
  const onBase = () => makeTask({ phases: [phase(1, "committed", { commits: [sha], branch: "", reports })] });

  const unpushed = onBase();
  exercise("prime", payloadFor(bind(unpushed), { hook_event_name: "UserPromptSubmit", cwd: work }));
  check(phaseOf(unpushed, 1).status === "committed", `PR4: prime leaves an on-base phase committed while its commit is not on origin (${phaseOf(unpushed, 1).status})`);

  gitIn(work, "push", "-q", "origin", "main");
  const pushed = onBase();
  exercise("prime", payloadFor(bind(pushed), { hook_event_name: "UserPromptSubmit", cwd: work }));
  check(["landed", "done"].includes(phaseOf(pushed, 1).status), `PR5: with the commit on origin prime advances the phase as before (${phaseOf(pushed, 1).status})`);
}

// PR6: a task that was closed (its directory moved) primes as done, naming where it went.
{
  const dir = makeTask({ phases: [phase(1, "landed")] });
  const sid = bind(dir);
  const closedTo = path.join(require("./lib/tasks-root").archiveRoot(), require("./lib/repo").repoKey(proj).key, path.basename(dir));
  fs.mkdirSync(path.dirname(closedTo), { recursive: true });
  fs.renameSync(dir, closedTo);
  const text = contextOf(exercise("prime", payloadFor(sid, { hook_event_name: "UserPromptSubmit" })));
  check(text.includes("Step: done") && text.includes(`task closed: archived to ${closedTo}`), `PR6: prime says the task is closed and where it went (${JSON.stringify(text)})`);
}

// CP10, PR3: a landing without its evidence is refused and logged, never an error.
{
  const { openCheckpoint } = require("./lib/checkpoint");
  const landable = (sha = "abc123") => makeTask({ phases: [phase(1, "committed", { commits: [sha], branch: "", reports: {
    reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "p" },
    code_review: { kind: "code", verdict: "pass", issues: [], summary: "c" } } })] });

  const ship = landable();
  openCheckpoint({ taskDir: ship, phaseId: 1, type: "ship", question: "Ship phase 1?", options: ["ship", "hold"] });
  const snapshot = taskText(ship);
  const shipAsk = { questions: [{ question: "Ship phase 1?", header: "Ship", options: [{ label: "ship" }, { label: "hold" }], multiSelect: false }] };
  const r = exercise("checkpoint-capture", payloadFor(bind(ship), { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: shipAsk, tool_response: { answers: { "Ship phase 1?": "ship" } } }));
  check(r.output === null && taskText(ship) === snapshot && oneLog(r, "checkpoint-capture", "not_recorded", "reason=transition_rejected: Transition rejected: committed → landed. land refused for phase 1: missing tests."), `CP10: a ship answer the gate refuses is logged as not recorded and writes nothing (${r.log})`);

  const gitDir = mk("gitrepo");
  spawnSync("git", ["-C", gitDir, "init", "-q"]);
  spawnSync("git", ["-C", gitDir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "work"]);
  const realSha = spawnSync("git", ["-C", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const primed = landable(realSha);
  const p = exercise("prime", payloadFor(bind(primed), { hook_event_name: "UserPromptSubmit", cwd: gitDir }));
  check(contextOf(p).includes("Step: blocked") && contextOf(p).includes("Reason: land refused for phase 1: missing tests.") && phaseOf(primed, 1).status === "committed" && !p.log.some((l) => l.split("\t")[3] === "error"), `PR3: prime reports the refusal, does not land the phase and logs no error (${JSON.stringify(contextOf(p))} ${p.log})`);
}

// HS1-HS3: the shape every handler keeps.
{
  const files = fs.readdirSync(hooksDir).sort();
  check(files.join() === "checkpoint-capture.js,common.js,prime.js,report-capture.js,session-end.js,session-register.js", `HS1: the directory holds common.js and the five handlers (${files})`);
  const handlerFiles = files.filter((f) => f !== "common.js");
  const tooLong = handlerFiles.filter((f) => fs.readFileSync(path.join(hooksDir, f), "utf8").split("\n").length - 1 > 120);
  check(tooLong.length === 0, `HS1: every handler is at most 120 lines (${tooLong})`);
  const extra = handlerFiles.filter((f) => {
    const src = fs.readFileSync(path.join(hooksDir, f), "utf8");
    const named = [...src.matchAll(/\bfunction\s+(\w+)/g)].map((m) => m[1]).filter((n) => n !== "run");
    const arrows = /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/m.test(src);
    return named.length > 0 || arrows;
  });
  check(extra.length === 0, `HS1: no handler declares a function besides run (${extra})`);

  const banned = ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "currentPhase", "subagent-types", "permissionDecision", "systemMessage", '"decision"', "process.exit"];
  const hits = files.flatMap((f) => banned.filter((b) => fs.readFileSync(path.join(hooksDir, f), "utf8").includes(b)).map((b) => `${f}:${b}`));
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
  const fenceBuilder = fence(builderReport);
  const payloads = {
    empty: {},
    eventOnly: { hook_event_name: "PreToolUse" },
    subagent: { hook_event_name: "SessionStart", agent_id: "sub-1", agent_type: "Builder" },
    validBuilder: handback("Builder", fenceBuilder),
    prose: handback("Builder", "no json here"),
    unknownAgent: handback("Wizard", fenceBuilder),
    noAgentType: { hook_event_name: "PreToolUse", tool_input: { message: fenceBuilder } },
    answers: answered("Yes"),
    legacyShape: { hook_event_name: "PostToolUse", tool_input: { question: "Ship it?", options: ["Yes"] }, tool_response: { answer: "Yes" } },
    stringResponse: { hook_event_name: "PostToolUse", tool_response: "Yes" },
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

// CN1-CN3: at the consolidate step a Builder's hand-back is the consolidator report.
{
  const consolidation = { distilled_to: ["docs/notes.md"], proposals: ["none"] };
  const allDone = () => makeTask({ phases: [
    phase(1, "done", { reports: { builder: { files_touched: ["a.js"], verification: [], deviations: [], summary: "built one" } } }),
    phase(2, "done", { reports: { builder: { files_touched: ["b.js"], verification: [], deviations: [], summary: "built two" } } }),
  ] });

  const named = allDone();
  const builderBefore = JSON.stringify(phaseOf(named, 1).reports.builder);
  const r1 = capture(named, handback("Builder", fence({ ...consolidation, phase_id: 1 })));
  check(phaseOf(named, 1).reports.consolidator.proposals[0] === "none" && JSON.stringify(phaseOf(named, 1).reports.builder) === builderBefore && oneCapture(r1, "recorded", "agent=consolidator phase=1 from=report result=stored"), `CN1: a consolidation hand-back naming phase 1 is stored as the consolidator report and the Builder report stays (${r1.log})`);

  const unnamed = allDone();
  const r2 = capture(unnamed, handback("Builder", fence(consolidation)));
  check(phaseOf(unnamed, 2).reports.consolidator.distilled_to[0] === "docs/notes.md" && !phaseOf(unnamed, 1).reports.consolidator && oneCapture(r2, "recorded", "agent=consolidator phase=2 from=next result=stored"), `CN2: a consolidator report with no phase_id lands on the last phase (${r2.log})`);

  const wrongShape = allDone();
  const before = taskText(wrongShape);
  const r3 = capture(wrongShape, handback("Builder", fence({ ...builderReport, phase_id: 1 })));
  check(taskText(wrongShape) === before && oneCapture(r3, "not_recorded", "reason=schema_error"), `CN3: a builder-shaped report at the consolidate step is declined and the Builder report stays (${r3.log})`);
}

// CM3: a Committer hand-back whose commits resolve in git moves the phase to committed, as the other routes do.
{
  const { execFileSync } = require("child_process");
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const repoDir = mk("cm3repo");
  const git = (...a) => execFileSync("git", a, { cwd: repoDir, env: gitEnv, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "f.txt"), "f\n");
  git("add", ".");
  git("commit", "-q", "-m", "feat: f");
  const full = git("rev-parse", "HEAD");
  const dir = makeTask({ phases: [phase(1, "implemented", { reports: { code_review: { kind: "code", verdict: "pass", issues: [], summary: "ok" } } })] });
  const sid = bind(dir);
  const committerReport = { phase_id: 1, commits: [{ sha: full.slice(0, 9), files: ["f.txt"], message: "feat: f" }], pushed: false };
  const r = exercise("report-capture", payloadFor(sid, { cwd: repoDir, ...handback("Committer", fence(committerReport)) }));
  const p = phaseOf(dir, 1);
  check(p.status === "committed" && p.commits.join() === full && oneCapture(r, "recorded", "agent=committer phase=1 from=report result=implemented → committed"), `CM3: a committer hand-back with a resolving SHA moves the phase to committed with the full SHA (${p.status}, ${r.log})`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
