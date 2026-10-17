#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolate the registry to a tmpdir so this test never writes to the real
// ~/.agents/sessions.
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-sessions-"));

const session = require("./lib/session");
const store = require("./lib/store");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const testId = `test-${Date.now()}`;
const testId2 = `test2-${Date.now()}`;

// --- Existing tests (registration basics) ---

// Test 1: register creates registration.json
{
  const result = session.register({
    session_id: testId,
    pid: process.ppid,
    cwd: "/tmp",
    agent: "conductor",
  });
  if (result.registration.session_id === testId) ok("register returns registration with session_id");
  else fail_("register should return session_id");
  const filePath = path.join(session.SESSIONS_ROOT, testId, "registration.json");
  if (fs.existsSync(filePath)) ok("registration.json written to disk");
  else fail_("registration.json should exist");
}

// Test 2: find by session_id
{
  const found = session.find({ session_id: testId });
  if (found && found.session_id === testId) ok("find by session_id returns the session");
  else fail_("find by session_id should return the session");
}

// Test 3: find by pid (ppid)
{
  const found = session.find({ pid: process.ppid });
  if (found && found.session_id === testId) ok("find by pid (ppid) returns the session");
  else fail_("find by pid should return the session");
}

// Test 4: list includes registered sessions
{
  session.register({ session_id: testId2, pid: 999999, cwd: "/tmp", agent: "builder" });
  const sessions = session.list();
  const ids = sessions.map((s) => s.session_id);
  if (ids.includes(testId) && ids.includes(testId2)) ok("list includes all registered sessions");
  else fail_("list should include both test sessions");
}

// Test 5: find by terminal_id
{
  session.register({ session_id: `tid-${Date.now()}`, pid: 123, terminal_id: "term-1", cwd: "/tmp" });
  const found = session.find({ terminal_id: "term-1" });
  if (found && found.terminal_id === "term-1") ok("find by terminal_id returns the session");
  else fail_("find by terminal_id should return the session");
}

// Test 6: find returns null for unknown session
{
  const found = session.find({ session_id: "nonexistent-session" });
  if (found === null) ok("find returns null for unknown session_id");
  else fail_("find should return null for unknown session");
}

// Test 7: full registration shape per ADR-018
{
  const fullId = `full-${Date.now()}`;
  const result = session.register({
    session_id: fullId,
    origin: "cli",
    terminal_id: "t-full",
    pid: process.pid,
    cwd: "/tmp",
    agent: "conductor",
    repo_key: "github.com/test/repo",
    task_dir: "/tmp/test-task",
    project_dir: "/tmp",
    initiator: "user",
    workflow_id: 42,
    commitment_id: "commit-1",
    project_id: "proj-1",
    transcript_path: "/tmp/transcript.jsonl",
    tmux: { server: "pav", session: "pav-t-full" },
  });
  const reg = result.registration;
  if (reg.schema === 1) ok("full registration has schema=1");
  else fail_("full registration should have schema=1");
  if (reg.origin === "cli") ok("full registration has origin=cli");
  else fail_("full registration should have origin=cli");
  if (reg.terminal_id === "t-full") ok("full registration has terminal_id");
  else fail_("full registration should have terminal_id");
  if (reg.workflow_id === 42) ok("full registration has workflow_id");
  else fail_("full registration should have workflow_id");
  if (reg.tmux && reg.tmux.server === "pav") ok("full registration has tmux");
  else fail_("full registration should have tmux");
  if (reg.created_at && reg.updated_at) ok("full registration has timestamps");
  else fail_("full registration should have timestamps");
  session.unregister(fullId);
}

// --- Lease tests ---

// Set up a temp task directory with state.json for lease tests
const tmpDir = path.join(os.tmpdir(), `agents-test-${Date.now()}`);
const taskDir = path.join(tmpDir, "test-task");
fs.mkdirSync(taskDir, { recursive: true });

function resetState() {
  const state = {
    schema_version: 1,
    task: "test-task",
    status: "planning",
    updated: new Date().toISOString(),
    phases: [{ id: 1, name: "Test", status: "not_started", owner: null, started: null, completed: null, blocked_by: [], parallel_group: null, execution: { model: null, effort: null, agent_type: null, estimated_scope: null } }],
    flags: [],
  };
  fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
resetState();

// Test 8: claim lease succeeds when no existing lease
{
  resetState();
  const leaseId = `lease-${Date.now()}-1`;
  session.register({ session_id: leaseId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  const result = session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: leaseId,
    pid: process.pid,
  });
  if (result.claimed === true) ok("claimLease succeeds when no existing lease");
  else fail_("claimLease should succeed: " + JSON.stringify(result));
  if (result.lease && result.lease.session_id === leaseId) ok("claimLease sets lease session_id");
  else fail_("claimLease should set lease session_id");

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
  if (state.lease && state.lease.session_id === leaseId) ok("state.json has lease with correct session_id");
  else fail_("state.json should have lease with correct session_id");
  if (state.binding && state.binding.session_id === leaseId) ok("state.json has binding with correct session_id");
  else fail_("state.json should have binding with correct session_id");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, leaseId), { recursive: true, force: true }); } catch {}
}

// Test 9: claim lease refused when held by live session
{
  resetState();
  const holderId = `holder-${Date.now()}`;
  const challengerId = `challenger-${Date.now()}`;
  session.register({ session_id: holderId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  session.register({ session_id: challengerId, pid: process.pid + 1, cwd: tmpDir, agent: "builder" });

  session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: holderId,
    pid: process.pid,
  });

  const result = session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: challengerId,
    pid: process.pid + 1,
  });
  if (result.claimed === false) ok("claimLease refused when held by live session");
  else fail_("claimLease should be refused when held by live session");
  if (result.reason === "held") ok("claimLease returns reason=held");
  else fail_("claimLease should return reason=held");
  if (result.holder && result.holder.session_id === holderId) ok("claimLease returns holder session_id");
  else fail_("claimLease should return holder session_id: " + JSON.stringify(result.holder));

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, holderId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, challengerId), { recursive: true, force: true }); } catch {}
}

// Test 10: claim lease reclaimed when holder is dead
{
  resetState();
  const deadHolderId = `dead-${Date.now()}`;
  const reclaimerId = `reclaim-${Date.now()}`;
  session.register({ session_id: deadHolderId, pid: 999999, cwd: tmpDir, agent: "conductor" });
  session.register({ session_id: reclaimerId, pid: process.pid, cwd: tmpDir, agent: "builder" });

  session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: deadHolderId,
    pid: 999999,
  });

  const result = session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: reclaimerId,
    pid: process.pid,
  });
  if (result.claimed === true) ok("claimLease reclaims when holder is dead");
  else fail_("claimLease should reclaim when holder is dead: " + JSON.stringify(result));
  if (result.lease && result.lease.session_id === reclaimerId) ok("reclaimed lease has new session_id");
  else fail_("reclaimed lease should have new session_id");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, deadHolderId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, reclaimerId), { recursive: true, force: true }); } catch {}
}

// Test 11: renew lease extends expires_at
{
  resetState();
  const renewId = `renew-${Date.now()}`;
  session.register({ session_id: renewId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: renewId,
    pid: process.pid,
  });

  const stateBefore = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
  const expiresBefore = stateBefore.lease.expires_at;

  const renewed = session.renewLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: renewId,
    lease_ttl_ms: 3 * 60 * 60 * 1000,
  });
  if (renewed === true) ok("renewLease returns true for own lease");
  else fail_("renewLease should return true for own lease");

  const stateAfter = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
  if (stateAfter.lease && stateAfter.lease.expires_at !== expiresBefore) ok("renewLease changes expires_at");
  else fail_("renewLease should change expires_at");
  if (stateAfter.lease.session_id === renewId) ok("renewLease keeps same session_id");
  else fail_("renewLease should keep same session_id");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, renewId), { recursive: true, force: true }); } catch {}
}

// Test 12: release lease clears lease and binding
{
  resetState();
  const releaseId = `release-${Date.now()}`;
  session.register({ session_id: releaseId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: releaseId,
    pid: process.pid,
  });

  const released = session.releaseLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: releaseId,
  });
  if (released === true) ok("releaseLease returns true for own lease");
  else fail_("releaseLease should return true for own lease");

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
  if (state.lease === null) ok("releaseLease clears lease");
  else fail_("releaseLease should clear lease");
  if (state.binding === null) ok("releaseLease clears binding");
  else fail_("releaseLease should clear binding");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, releaseId), { recursive: true, force: true }); } catch {}
}

// Test 13: unregister sets ended_at and keeps dir
{
  const unregisterId = `unreg-${Date.now()}`;
  session.register({ session_id: unregisterId, pid: process.pid, cwd: "/tmp", agent: "conductor" });
  const result = session.unregister(unregisterId);
  if (result === true) ok("unregister returns true for existing session");
  else fail_("unregister should return true for existing session");

  const dir = path.join(session.SESSIONS_ROOT, unregisterId);
  if (fs.existsSync(dir)) ok("unregister keeps the directory");
  else fail_("unregister should keep the directory");
  const reg = session.readRegistration(dir);
  if (reg && reg.ended_at) ok("unregister sets ended_at");
  else fail_("unregister should set ended_at");

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Test 14: touch updates updated_at
{
  const touchId = `touch-${Date.now()}`;
  session.register({ session_id: touchId, pid: process.pid, cwd: "/tmp", agent: "conductor" });
  const dir = path.join(session.SESSIONS_ROOT, touchId);
  const regBefore = session.readRegistration(dir);
  const updatedBefore = regBefore.updated_at;

  // Sleep 10ms to ensure timestamp changes
  const sleepUntil = Date.now() + 15;
  while (Date.now() < sleepUntil) {}

  const touched = session.touch(touchId);
  if (touched === true) ok("touch returns true for existing session");
  else fail_("touch should return true for existing session");

  const regAfter = session.readRegistration(dir);
  if (regAfter.updated_at !== updatedBefore) ok("touch updates updated_at");
  else fail_("touch should update updated_at");

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Test 15: isPidAlive works correctly
{
  if (session.isPidAlive(process.pid) === true) ok("isPidAlive returns true for current process");
  else fail_("isPidAlive should return true for current process");
  if (session.isPidAlive(999999) === false) ok("isPidAlive returns false for nonexistent pid");
  else fail_("isPidAlive should return false for nonexistent pid");
  if (session.isPidAlive(null) === false) ok("isPidAlive returns false for null pid");
  else fail_("isPidAlive should return false for null pid");
}

// Test 16: session_history on clear/fork
{
  const historyId = `hist-${Date.now()}`;
  const newId = `hist-new-${Date.now()}`;
  session.register({
    session_id: historyId,
    pid: process.pid,
    cwd: "/tmp",
    agent: "conductor",
  });

  // Simulate clear: update with new session_id and source=clear
  const result = session.register({
    session_id: newId,
    pid: process.pid,
    cwd: "/tmp",
    agent: "conductor",
    source: "clear",
    previous_session_id: historyId,
  });

  if (result.registration.session_history && result.registration.session_history.includes(historyId)) {
    ok("session_history contains old session_id on clear");
  } else {
    fail_("session_history should contain old session_id on clear");
  }

  // Clean up
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, newId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, historyId), { recursive: true, force: true }); } catch {}
}

// Test 17: mintId returns unique UUIDs
{
  const id1 = session.mintId();
  const id2 = session.mintId();
  if (id1 && id2 && id1 !== id2) ok("mintId returns unique ids");
  else fail_("mintId should return unique ids");
}

// --- Cleanup ---
session.unregister(testId);
const tidSession = session.find({ terminal_id: "term-1" });
if (tidSession) session.unregister(tidSession.session_id);

// Clean up remaining test sessions
for (const s of session.list()) {
  if (s.session_id && (s.session_id.startsWith("test") || s.session_id.startsWith("full") || s.session_id.startsWith("tid"))) {
    try { fs.rmSync(path.join(session.SESSIONS_ROOT, s.session_id), { recursive: true, force: true }); } catch {}
  }
}

// Clean up temp task dir
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// Clean up isolated registry root
try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
