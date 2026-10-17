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
  delete cleanEnv.CLAUDE_CODE_CHILD_SESSION;
  const fullEnv = { ...cleanEnv, ...(env || {}) };
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

// Test 3: child session is skipped
{
  const sid = `${testBase}-child`;
  const output = runHook({
    session_id: sid,
    cwd: "/tmp",
    source: "startup",
  }, { CLAUDE_CODE_CHILD_SESSION: "1" });
  const reg = session.find({ session_id: sid });
  if (reg === null) ok("child session (CLAUDE_CODE_CHILD_SESSION) is skipped");
  else fail_("child session should be skipped — no registration created");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
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
