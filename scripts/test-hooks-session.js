#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolate the registry to a tmpdir so this test never writes to the real
// ~/.agents/sessions. runHook inherits this via process.env, so the child
// `a session register --hook` processes write to the same tmpdir.
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-hook-sessions-"));

const session = require("./lib/session");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const A_PATH = path.join(__dirname, "bin", "a");
const testBase = `hooktest-${Date.now()}`;

function runHook(input, env) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.AGENTS_SESSION_DIR;
  delete cleanEnv.AGENTS_SESSION_ID;
  // Claude Code sets CLAUDE_CODE_CHILD_SESSION=1 and CLAUDECODE=1 on every
  // subprocess it spawns (hooks included), even for top-level sessions, so
  // every fixture mirrors that env (D28): the guard is gone and nested-vs-
  // top-level is asserted through CLAUDE_PID / pointer fixtures, not the env.
  const fullEnv = {
    ...cleanEnv,
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDECODE: "1",
    ...(env || {}),
  };
  try {
    return execSync(`node ${A_PATH} session register --hook`, {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
      env: fullEnv,
    });
  } catch (err) {
    return err.stdout || "";
  }
}

// Test 1: startup source creates a registration
{
  const sid = `${testBase}-startup`;
  const output = runHook({
    session_id: sid,
    cwd: "/tmp",
    source: "startup",
    agent_type: "conductor",
  });
  const reg = session.find({ session_id: sid });
  if (reg) ok("startup source creates a registration");
  else fail_("startup source should create a registration");
  if (reg && reg.origin === "external") ok("startup registration has origin=external");
  else fail_("startup registration should have origin=external");
  if (reg && reg.pid !== null) ok("startup registration has pid");
  else fail_("startup registration should have pid");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
}

// Test 2: subagent (agent_id present) is skipped
{
  const sid = `${testBase}-subagent`;
  const output = runHook({
    session_id: sid,
    agent_id: "sub-1",
    cwd: "/tmp",
    source: "startup",
  });
  const reg = session.find({ session_id: sid });
  if (reg === null) ok("subagent (agent_id present) is skipped");
  else fail_("subagent should be skipped — no registration created");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
}

// Test 3 (D28): pointer-based nested-session detection. Replaces the former
// "CLAUDE_CODE_CHILD_SESSION skips" assertion — that env var is set on every
// subprocess Claude Code spawns and is not a nested signal. Every fixture runs
// with CLAUDE_CODE_CHILD_SESSION=1 (runHook sets it); nested-vs-top-level is
// decided by CLAUDE_PID and the pointer, per scripts/lib/session.js register().
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-d28-"));
  execSync("git init -q -b main", { cwd: tmpRepo });
  const taskRel = ".tasks/d28-task";
  const taskDirAbs = path.join(tmpRepo, taskRel);
  fs.mkdirSync(taskDirAbs, { recursive: true });
  function resetState() {
    fs.writeFileSync(path.join(taskDirAbs, "state.json"), JSON.stringify({
      schema_version: 1, task: "d28-task", status: "planning",
      updated: "2026-01-01T00:00:00.000Z", phases: [], flags: [],
    }));
  }
  const pointerDir = path.join(session.SESSIONS_ROOT, `${testBase}-d28-ptr`);
  fs.mkdirSync(pointerDir, { recursive: true });
  function writePointer(sid, pid, task) {
    fs.writeFileSync(path.join(pointerDir, "registration.json"), JSON.stringify({
      schema: 1, origin: "cli", session_id: sid, task_dir: task || null,
      cwd: tmpRepo, agent: "conductor", pid,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }));
  }

  // (a) top-level registers: pointer pid is null (a cc pre-launch), hook
  // rebinds it and records CLAUDE_PID, claiming the lease.
  resetState();
  const topSid = `${testBase}-d28-top`;
  writePointer(topSid, null, taskRel);
  runHook({ session_id: topSid, cwd: tmpRepo, source: "startup", agent_type: "conductor" },
    { AGENTS_SESSION_DIR: pointerDir, CLAUDE_PID: String(process.pid) });
  const topReg = session.readRegistration(pointerDir);
  if (topReg && topReg.session_id === topSid && topReg.pid === process.pid)
    ok("D28(a): top-level (pointer pid null) rebinds and records CLAUDE_PID");
  else
    fail_("D28(a): top-level should rebind pointer: " + JSON.stringify(topReg && topReg.session_id));
  const topState = JSON.parse(fs.readFileSync(path.join(taskDirAbs, "state.json"), "utf8"));
  if (topState.lease && topState.lease.session_id === topSid)
    ok("D28(a): top-level claims the task lease");
  else
    fail_("D28(a): top-level should claim the lease: " + JSON.stringify(topState.lease));

  // (b) /clear (same CLAUDE_PID, new session id) rebinds.
  resetState();
  const clearOld = `${testBase}-d28-clear-old`;
  const clearNew = `${testBase}-d28-clear-new`;
  writePointer(clearOld, process.pid, taskRel);
  runHook({ session_id: clearNew, cwd: tmpRepo, source: "clear", agent_type: "conductor" },
    { AGENTS_SESSION_DIR: pointerDir, CLAUDE_PID: String(process.pid) });
  const clearReg = session.readRegistration(pointerDir);
  if (clearReg && clearReg.session_id === clearNew && clearReg.pid === process.pid)
    ok("D28(b): /clear (same CLAUDE_PID) rebinds pointer to new session id");
  else
    fail_("D28(b): /clear should rebind: " + JSON.stringify(clearReg && clearReg.session_id));
  if (clearReg && clearReg.session_history && clearReg.session_history.includes(clearOld))
    ok("D28(b): /clear appends old session id to history");
  else
    fail_("D28(b): /clear should append old id to history");
  const clearState = JSON.parse(fs.readFileSync(path.join(taskDirAbs, "state.json"), "utf8"));
  if (clearState.lease && clearState.lease.session_id === clearNew)
    ok("D28(b): /clear rebinds the lease to the new session id");
  else
    fail_("D28(b): /clear should rebind lease: " + JSON.stringify(clearState.lease));

  // (c) nested (pointer pid alive and foreign) registers separately and leaves
  // the parent's registration and lease untouched.
  resetState();
  const parentSid = `${testBase}-d28-parent`;
  const childSid = `${testBase}-d28-child`;
  writePointer(parentSid, process.pid, taskRel);
  session.claimLease({ task_dir: taskRel, project_dir: tmpRepo, session_id: parentSid, pid: process.pid });
  runHook({ session_id: childSid, cwd: tmpRepo, source: "startup", agent_type: "conductor" },
    { AGENTS_SESSION_DIR: pointerDir, CLAUDE_PID: "7777777" });
  const childDir = path.join(session.SESSIONS_ROOT, childSid);
  const childReg = session.readRegistration(childDir);
  if (childReg && childReg.session_id === childSid && childReg.origin === "external" &&
      childReg.parent_session_id === parentSid)
    ok("D28(c): nested registers under own id with origin=external and parent_session_id");
  else
    fail_("D28(c): nested should register separately: " + JSON.stringify(childReg));
  const parentReg = session.readRegistration(pointerDir);
  if (parentReg && parentReg.session_id === parentSid && parentReg.pid === process.pid)
    ok("D28(c): parent registration untouched (still parentSid, parent pid)");
  else
    fail_("D28(c): parent registration should be untouched: " + JSON.stringify(parentReg && parentReg.session_id));
  const nestedState = JSON.parse(fs.readFileSync(path.join(taskDirAbs, "state.json"), "utf8"));
  if (nestedState.lease && nestedState.lease.session_id === parentSid)
    ok("D28(c): parent's lease left untouched (still held by parentSid)");
  else
    fail_("D28(c): parent lease should be untouched: " + JSON.stringify(nestedState.lease));
  try { fs.rmSync(childDir, { recursive: true, force: true }); } catch {}

  // (d) dead recorded pid rebinds.
  resetState();
  const deadOld = `${testBase}-d28-dead-old`;
  const deadNew = `${testBase}-d28-dead-new`;
  writePointer(deadOld, 999999, taskRel);
  runHook({ session_id: deadNew, cwd: tmpRepo, source: "startup", agent_type: "conductor" },
    { AGENTS_SESSION_DIR: pointerDir, CLAUDE_PID: "8888888" });
  const deadReg = session.readRegistration(pointerDir);
  if (deadReg && deadReg.session_id === deadNew && deadReg.pid === 8888888)
    ok("D28(d): dead recorded pid rebinds pointer to new session");
  else
    fail_("D28(d): dead pid should rebind: " + JSON.stringify(deadReg && deadReg.session_id));
  const deadState = JSON.parse(fs.readFileSync(path.join(taskDirAbs, "state.json"), "utf8"));
  if (deadState.lease && deadState.lease.session_id === deadNew)
    ok("D28(d): dead recorded pid rebinds the lease");
  else
    fail_("D28(d): dead pid should rebind lease: " + JSON.stringify(deadState.lease));

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  try { fs.rmSync(pointerDir, { recursive: true, force: true }); } catch {}
}

// Test 4: clear source appends old session_id to session_history
{
  const oldSid = `${testBase}-clear-old`;
  const newSid = `${testBase}-clear-new`;

  // First register the old session
  runHook({
    session_id: oldSid,
    cwd: "/tmp",
    source: "startup",
    agent_type: "conductor",
  });

  // Then simulate clear with new session_id, pointing AGENTS_SESSION_DIR at the old dir
  const oldDir = path.join(session.SESSIONS_ROOT, oldSid);
  const output = runHook({
    session_id: newSid,
    cwd: "/tmp",
    source: "clear",
    agent_type: "conductor",
  }, { AGENTS_SESSION_DIR: oldDir });

  const reg = session.readRegistration(oldDir);
  if (reg && reg.session_history && reg.session_history.includes(oldSid)) {
    ok("clear source appends old session_id to session_history");
  } else {
    fail_("clear source should append old session_id to session_history: " + JSON.stringify(reg));
  }
  if (reg && reg.session_id === newSid) ok("clear updates session_id to new id");
  else fail_("clear should update session_id to new id");

  try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, newSid), { recursive: true, force: true }); } catch {}
}

// Test 5: registration with no session_id exits cleanly
{
  const output = runHook({ cwd: "/tmp", source: "startup" });
  if (output === "" || output === undefined || output === null) ok("no session_id produces no output");
  else fail_("no session_id should produce no output");
}

// Test 6: registration fills transcript_path
{
  const sid = `${testBase}-transcript`;
  runHook({
    session_id: sid,
    cwd: "/tmp",
    source: "startup",
    transcript_path: "/tmp/transcript.jsonl",
    agent_type: "conductor",
  });
  const reg = session.find({ session_id: sid });
  if (reg && reg.transcript_path === "/tmp/transcript.jsonl") ok("registration fills transcript_path");
  else fail_("registration should fill transcript_path");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
}

// Test 7: registration fills repo_key from cwd
{
  const sid = `${testBase}-repokey`;
  runHook({
    session_id: sid,
    cwd: __dirname,
    source: "startup",
    agent_type: "conductor",
  });
  const reg = session.find({ session_id: sid });
  if (reg && reg.repo_key) ok("registration fills repo_key from cwd");
  else fail_("registration should fill repo_key from cwd");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
}

// Test 8: hook register reads lease.ttl_ms from config (not the hardcoded default)
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lease-"));
  execSync("git init -q -b main", { cwd: tmpRepo });
  const taskRel = ".tasks/lease-test";
  const taskDirAbs = path.join(tmpRepo, taskRel);
  fs.mkdirSync(taskDirAbs, { recursive: true });
  fs.writeFileSync(path.join(taskDirAbs, "state.json"), JSON.stringify({
    schema_version: 1, task: "lease-test", status: "planning",
    updated: "2026-01-01T00:00:00.000Z", phases: [], flags: [],
  }));

  const sid = `${testBase}-lease`;
  const sessionDir = path.join(session.SESSIONS_ROOT, sid);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "registration.json"), JSON.stringify({
    schema: 1, origin: "cli", session_id: sid, task_dir: taskRel, cwd: tmpRepo,
    agent: "conductor", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }));

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lease-cfg-"));
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ lease: { ttl_ms: 60000 } }));

  runHook({
    session_id: sid,
    cwd: tmpRepo,
    source: "startup",
    agent_type: "conductor",
  }, { AGENTS_SESSION_DIR: sessionDir, AGENTS_CONFIG_PATH: configPath });

  const state = JSON.parse(fs.readFileSync(path.join(taskDirAbs, "state.json"), "utf8"));
  const delta = new Date(state.lease.expires_at).getTime() - new Date(state.lease.acquired_at).getTime();
  if (Math.abs(delta - 60000) <= 1000) ok("hook register reads lease.ttl_ms from config (60000ms)");
  else fail_(`hook register should use config lease.ttl_ms (60000ms), got delta ${delta}ms (default is 7200000ms)`);

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
}

// Test 9: hook records CLAUDE_PID (not the transient hook shell's ppid), so a
// live holder's lease refuses a challenger and the refusal names the holder.
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-live-lease-"));
  execSync("git init -q -b main", { cwd: tmpRepo });
  const taskRel = ".tasks/live-lease";
  const taskDirAbs = path.join(tmpRepo, taskRel);
  fs.mkdirSync(taskDirAbs, { recursive: true });
  fs.writeFileSync(path.join(taskDirAbs, "state.json"), JSON.stringify({
    schema_version: 1, task: "live-lease", status: "planning",
    updated: "2026-01-01T00:00:00.000Z", phases: [], flags: [],
  }));

  const holderSid = `${testBase}-live-holder`;
  const challengerSid = `${testBase}-live-challenger`;
  const holderDir = path.join(session.SESSIONS_ROOT, holderSid);
  const challengerDir = path.join(session.SESSIONS_ROOT, challengerSid);
  for (const d of [holderDir, challengerDir]) fs.mkdirSync(d, { recursive: true });
  for (const [d, sid, agent] of
    [[holderDir, holderSid, "conductor"], [challengerDir, challengerSid, "builder"]]) {
    fs.writeFileSync(path.join(d, "registration.json"), JSON.stringify({
      schema: 1, origin: "cli", session_id: sid, task_dir: taskRel, cwd: tmpRepo,
      agent, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }));
  }

  // Holder binds the task. CLAUDE_PID is the test runner (alive), so the
  // registered pid must be live for the lease to stick.
  runHook({
    session_id: holderSid, cwd: tmpRepo, source: "startup", agent_type: "conductor",
  }, { AGENTS_SESSION_DIR: holderDir, CLAUDE_PID: String(process.pid) });

  const holderReg = session.readRegistration(holderDir);
  if (holderReg && holderReg.pid === process.pid)
    ok("hook records CLAUDE_PID as the session pid (not the transient hook shell)");
  else
    fail_("hook should record CLAUDE_PID as pid, got: " + JSON.stringify(holderReg && holderReg.pid));

  // Challenger tries the same task; a live holder must refuse and name it.
  const out = runHook({
    session_id: challengerSid, cwd: tmpRepo, source: "startup", agent_type: "builder",
  }, { AGENTS_SESSION_DIR: challengerDir, CLAUDE_PID: String(process.pid) });

  if (out.includes(holderSid) && /leased by session/.test(out))
    ok("live holder refuses challenger and names holder session id in output");
  else
    fail_("challenger should be refused with holder session id in output, got: " + JSON.stringify(out));

  fs.rmSync(tmpRepo, { recursive: true, force: true });
  try { fs.rmSync(holderDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(challengerDir, { recursive: true, force: true }); } catch {}
}

// Test 10 (D7): a cc's registration and the SessionStart hook share one dir.
// The launcher (a cc) mints a terminal_id, computes sessionDir = <root>/<terminal_id>,
// and registers with origin=cli and no AGENTS_SESSION_DIR in its own env. register()
// must write to <root>/<terminal_id> (D7: id = terminal id when a launcher minted
// one), not <root>/<session_id>. The pane carries AGENTS_SESSION_DIR=<root>/<terminal_id>;
// the hook then finds the launcher's entry, matches session_id, keeps origin=cli,
// and fills pid + transcript_path. One entry results, not two.
{
  const terminalId = session.mintId();
  const sid = `${testBase}-cc-d7`;
  const sessionDir = path.join(session.SESSIONS_ROOT, terminalId);
  const wrongDir = path.join(session.SESSIONS_ROOT, sid);

  // Simulate a cc's register call: no AGENTS_SESSION_DIR in env, terminal_id given.
  const savedDir = process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_DIR;
  try {
    session.register({
      session_id: sid,
      terminal_id: terminalId,
      session_dir: sessionDir,
      origin: "cli",
      initiator: "user",
      agent: "conductor",
      cwd: "/tmp",
      pid: null,
    });
  } finally {
    if (savedDir !== undefined) process.env.AGENTS_SESSION_DIR = savedDir;
    else delete process.env.AGENTS_SESSION_DIR;
  }

  if (fs.existsSync(path.join(sessionDir, "registration.json")))
    ok("D7: cc register writes to <root>/<terminal_id>");
  else
    fail_("D7: cc register should write to <root>/<terminal_id>");
  if (!fs.existsSync(path.join(wrongDir, "registration.json")))
    ok("D7: cc register does NOT write a second entry to <root>/<session_id>");
  else
    fail_("D7: cc register should not write to <root>/<session_id>");

  const preReg = session.readRegistration(sessionDir);
  if (preReg && preReg.origin === "cli" && preReg.pid === null)
    ok("D7: launcher entry has origin=cli, pid=null (pre-hook)");
  else
    fail_("D7: launcher entry should have origin=cli, pid=null: " + JSON.stringify(preReg && preReg.origin));

  // Simulate the SessionStart hook in the pane: AGENTS_SESSION_DIR set.
  runHook({
    session_id: sid,
    cwd: "/tmp",
    source: "startup",
    agent_type: "conductor",
    transcript_path: "/tmp/cc-d7-transcript.jsonl",
  }, { AGENTS_SESSION_DIR: sessionDir, CLAUDE_PID: String(process.pid) });

  // Exactly one entry, at <root>/<terminal_id>.
  const reg = session.readRegistration(sessionDir);
  if (reg && reg.session_id === sid)
    ok("D7: one entry at <root>/<terminal_id> with correct session_id");
  else
    fail_("D7: should have one entry at <root>/<terminal_id>: " + JSON.stringify(reg && reg.session_id));
  if (!fs.existsSync(path.join(wrongDir, "registration.json")))
    ok("D7: no second entry at <root>/<session_id> after hook");
  else
    fail_("D7: should not have a second entry at <root>/<session_id>");
  if (reg && reg.origin === "cli")
    ok("D7: entry keeps origin=cli (hook does not clobber)");
  else
    fail_("D7: entry should keep origin=cli, got: " + JSON.stringify(reg && reg.origin));
  if (reg && reg.pid === process.pid)
    ok("D7: entry has pid set by the hook (CLAUDE_PID)");
  else
    fail_("D7: entry should have pid set, got: " + JSON.stringify(reg && reg.pid));
  if (reg && reg.transcript_path === "/tmp/cc-d7-transcript.jsonl")
    ok("D7: entry has transcript_path set by the hook");
  else
    fail_("D7: entry should have transcript_path, got: " + JSON.stringify(reg && reg.transcript_path));

  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(wrongDir, { recursive: true, force: true }); } catch {}
}

// Cleanup any remaining test sessions
for (const s of session.list()) {
  if (s.session_id && s.session_id.startsWith(testBase)) {
    try { fs.rmSync(path.join(session.SESSIONS_ROOT, s.session_id), { recursive: true, force: true }); } catch {}
  }
}

// Clean up isolated registry root
try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
