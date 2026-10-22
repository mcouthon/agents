#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolate the registry to a tmpdir so this test never writes to the real
// ~/.agents/sessions. Clear AGENTS_SESSION_DIR so the pointer logic in
// register() doesn't treat test registrations as nested (the parent Claude
// session sets this env var).
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-sessions-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-sessions-tasks-"));
process.env.AGENTS_LOGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-sessions-logs-"));
delete process.env.AGENTS_SESSION_DIR;

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

// Set up a temp task directory with task.json (v2) for lease tests. D33: lease
// and binding live in task.json, so the fixtures write v2 — never state.json.
const tmpDir = path.join(os.tmpdir(), `agents-test-${Date.now()}`);
const taskDir = path.join(tmpDir, "test-task");
fs.mkdirSync(taskDir, { recursive: true });

function resetState() {
  const task = {
    schema: 2,
    slug: "test-task",
    number: 1,
    title: "Test Task",
    status: "planning",
    mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny", land: "per_phase" },
    binding: {},
    lease: {},
    last_writer: {},
    phases: [{ id: 1, name: "Test", status: "not_started", owner: null, blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "", reports: { explorer: null, builder: null, reviewer: null, committer: null }, commits: [], branch: "", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, started: null, completed: null }],
    checkpoints: [],
    flags: [],
    created: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2), "utf8");
  // Remove any stale state.json so loadTask doesn't try to migrate it.
  try { fs.unlinkSync(path.join(taskDir, "state.json")); } catch {}
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

  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === leaseId) ok("task.json has lease with correct session_id");
  else fail_("task.json should have lease with correct session_id");
  if (task.binding && task.binding.session_id === leaseId) ok("task.json has binding with correct session_id");
  else fail_("task.json should have binding with correct session_id");
  // No state.json should exist (D33: lease lives in task.json, not state.json).
  if (!fs.existsSync(path.join(taskDir, "state.json"))) ok("no state.json after lease claim (D33)");
  else fail_("state.json should not exist after lease claim (D33)");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, leaseId), { recursive: true, force: true }); } catch {}
}

// Test 8a: state_prime reads the lease holder from task.json (D33)
{
  resetState();
  const primeLeaseId = `prime-${Date.now()}`;
  session.register({ session_id: primeLeaseId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  session.claimLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: primeLeaseId,
    pid: process.pid,
  });

  // state_prime (via stateOps) reads task.json and returns `a next` JSON; the
  // lease holder is persisted in task.json, so a subsequent reader sees it.
  const { primeState } = require("./lib/state-ops");
  const result = primeState(tmpDir, taskDir);
  if (result.format === "json") ok("state_prime returns json format for v2 task");
  else fail_("state_prime should return json format for v2 task");
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === primeLeaseId) ok("state_prime sees holder from task.json (lease persisted)");
  else fail_("lease holder should be in task.json after claimLease");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, primeLeaseId), { recursive: true, force: true }); } catch {}
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

  const stateBefore = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  const expiresBefore = stateBefore.lease.expires_at;

  const renewed = session.renewLease({
    task_dir: taskDir,
    project_dir: tmpDir,
    session_id: renewId,
    lease_ttl_ms: 3 * 60 * 60 * 1000,
  });
  if (renewed === true) ok("renewLease returns true for own lease");
  else fail_("renewLease should return true for own lease");

  const stateAfter = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
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

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
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

// Test 18 (D28): pointer-based nested-session detection in register().
// AGENTS_SESSION_DIR points at a launcher-written registration; a live, foreign
// pid there means a nested process, which registers under its own id without
// touching the parent's registration or lease. Same/dead/null pid rebinds.
{
  const d28Repo = path.join(os.tmpdir(), `agents-d28-repo-${Date.now()}`);
  const d28TaskAbs = path.join(d28Repo, ".tasks", "d28");
  fs.mkdirSync(d28TaskAbs, { recursive: true });
  function resetD28State() {
    fs.writeFileSync(path.join(d28TaskAbs, "task.json"), JSON.stringify({
      schema: 2, slug: "d28", number: 1, title: "D28", status: "planning",
      mode: "full", knobs: {}, binding: {}, lease: {}, last_writer: {},
      phases: [], checkpoints: [], flags: [],
      created: "2026-01-01", updated: "2026-01-01T00:00:00.000Z",
    }));
    try { fs.unlinkSync(path.join(d28TaskAbs, "state.json")); } catch {}
  }
  const d28Pointer = path.join(os.tmpdir(), `agents-d28-ptr-${Date.now()}`);
  fs.mkdirSync(d28Pointer, { recursive: true });
  const savedDir = process.env.AGENTS_SESSION_DIR;
  process.env.AGENTS_SESSION_DIR = d28Pointer;
  try {
    const parentSid = `d28-parent-${Date.now()}`;
    const childSid = `d28-child-${Date.now()}`;
    fs.writeFileSync(path.join(d28Pointer, "registration.json"), JSON.stringify({
      schema: 1, origin: "cli", session_id: parentSid, task_dir: ".tasks/d28",
      cwd: d28Repo, agent: "conductor", pid: process.pid,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }));
    resetD28State();
    session.claimLease({ task_dir: ".tasks/d28", project_dir: d28Repo, session_id: parentSid, pid: process.pid });

    // Nested: foreign pid registers under its own id, no lease change.
    const res = session.register({
      session_id: childSid, pid: 7777777, cwd: d28Repo, agent: "conductor",
      task_dir: ".tasks/d28", project_dir: d28Repo,
    });
    const childDir = path.join(session.SESSIONS_ROOT, childSid);
    const childReg = session.readRegistration(childDir);
    if (childReg && childReg.session_id === childSid && childReg.origin === "external" &&
        childReg.parent_session_id === parentSid)
      ok("D28 lib: nested register creates own registration with parent_session_id");
    else
      fail_("D28 lib: nested should register separately: " + JSON.stringify(childReg));
    if (res.lease === null)
      ok("D28 lib: nested register does not claim the parent's lease");
    else
      fail_("D28 lib: nested should not claim lease: " + JSON.stringify(res.lease));
    const parentReg = session.readRegistration(d28Pointer);
    if (parentReg && parentReg.session_id === parentSid && parentReg.pid === process.pid)
      ok("D28 lib: parent registration untouched");
    else
      fail_("D28 lib: parent should be untouched: " + JSON.stringify(parentReg && parentReg.session_id));
    const st = JSON.parse(fs.readFileSync(path.join(d28TaskAbs, "task.json"), "utf8"));
    if (st.lease && st.lease.session_id === parentSid)
      ok("D28 lib: parent's lease left untouched (held by parentSid)");
    else
      fail_("D28 lib: parent lease should be untouched: " + JSON.stringify(st.lease));
    try { fs.rmSync(childDir, { recursive: true, force: true }); } catch {}

    // Dead recorded pid rebinds the pointer and the lease.
    resetD28State();
    const deadOld = `d28-dead-old-${Date.now()}`;
    const deadNew = `d28-dead-new-${Date.now()}`;
    fs.writeFileSync(path.join(d28Pointer, "registration.json"), JSON.stringify({
      schema: 1, origin: "cli", session_id: deadOld, task_dir: ".tasks/d28",
      cwd: d28Repo, agent: "conductor", pid: 999999,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }));
    const res3 = session.register({
      session_id: deadNew, pid: 8888888, cwd: d28Repo, agent: "conductor",
      task_dir: ".tasks/d28", project_dir: d28Repo,
    });
    if (res3.session_dir === d28Pointer && res3.registration.session_id === deadNew &&
        res3.registration.pid === 8888888)
      ok("D28 lib: dead recorded pid rebinds the pointer to the new session");
    else
      fail_("D28 lib: dead pid should rebind: " + JSON.stringify(res3.registration));
    const st3 = JSON.parse(fs.readFileSync(path.join(d28TaskAbs, "task.json"), "utf8"));
    if (st3.lease && st3.lease.session_id === deadNew)
      ok("D28 lib: dead recorded pid rebinds the lease");
    else
      fail_("D28 lib: dead pid should rebind lease: " + JSON.stringify(st3.lease));

    // Same session id rebinds the pointer dir.
    const sameRes = session.register({
      session_id: deadNew, pid: 8888888, cwd: d28Repo, agent: "conductor",
    });
    if (sameRes.session_dir === d28Pointer)
      ok("D28 lib: same session id rebinds the pointer dir");
    else
      fail_("D28 lib: same session id should rebind pointer: " + sameRes.session_dir);

    // resolveSessionDir follows the caller's own id: a nested child resolves to
    // its own dir, not the pointer; a matching pointer id resolves to the pointer.
    const ownDir = path.join(session.SESSIONS_ROOT, "d28-resolve-own");
    fs.mkdirSync(ownDir, { recursive: true });
    fs.writeFileSync(path.join(ownDir, "registration.json"), JSON.stringify({
      schema: 1, origin: "external", session_id: "d28-resolve-own", cwd: "/tmp",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }));
    // Pointer still records deadNew; a different id must NOT resolve to it.
    if (session.resolveSessionDir("d28-resolve-own") === ownDir)
      ok("D28 lib: resolveSessionDir returns own dir for a non-pointer id");
    else
      fail_("D28 lib: resolveSessionDir should return own dir, got: " + session.resolveSessionDir("d28-resolve-own"));
    if (session.resolveSessionDir(deadNew) === d28Pointer)
      ok("D28 lib: resolveSessionDir returns pointer for the matching id");
    else
      fail_("D28 lib: resolveSessionDir should return pointer for matching id: " + session.resolveSessionDir(deadNew));
    try { fs.rmSync(ownDir, { recursive: true, force: true }); } catch {}
  } finally {
    if (savedDir !== undefined) process.env.AGENTS_SESSION_DIR = savedDir;
    else delete process.env.AGENTS_SESSION_DIR;
    try { fs.rmSync(d28Pointer, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(d28Repo, { recursive: true, force: true }); } catch {}
  }
}

// --- isLive (D38 item 6: verify process identity) ---

// T_isLive_1: isLive returns false for null entry
{
  if (session.isLive(null) === false) ok("isLive: null entry → false");
  else fail_("isLive: null should be false");
}

// T_isLive_2: isLive returns false for entry with ended_at
{
  if (session.isLive({ ended_at: "2026-01-01T00:00:00Z", pid: 1 }) === false)
    ok("isLive: ended_at → false");
  else fail_("isLive: ended_at should be false");
}

// T_isLive_3: isLive returns false for entry with no pid
{
  if (session.isLive({ pid: null, created_at: "2026-01-01T00:00:00Z" }) === false)
    ok("isLive: no pid → false");
  else fail_("isLive: no pid should be false");
}

// T_isLive_4: isLive returns false for dead pid
{
  if (session.isLive({ pid: 999999, created_at: "2026-01-01T00:00:00Z" }) === false)
    ok("isLive: dead pid → false");
  else fail_("isLive: dead pid should be false");
}

// T_isLive_5: isLive rejects a pid whose start time is newer than created_at
// (pid reuse: the pid exists but belongs to a different process started later)
{
  // Use our own process pid but a created_at far in the past.
  // The process started now, created_at is in 2020 → start time > created_at.
  const entry = { pid: process.pid, created_at: "2020-01-01T00:00:00Z" };
  // Our process is alive and its command line contains "node" (running the test),
  // not "claude", so this should also fail on the command line check.
  // But even if it were "claude", the start time check would reject it.
  const result = session.isLive(entry);
  // The command line check will fail first (our process is "node", not "claude"),
  // but the key assertion is that isLive returns false.
  if (result === false) ok("isLive: pid reuse (start time newer than created_at) → false");
  else fail_("isLive: pid reuse should be false");
}

// T_isLive_6: isLive rejects a pid whose command is bg-spare
// We can't easily test this with a real process, so we test the logic:
// a live process with "bg-spare" in its command should be rejected.
// This is covered by the command line check in isLive.

// T_isLive_7: findLiveByRepoKey uses isLive (returns empty for no live sessions)
{
  const live = session.findLiveByRepoKey("nonexistent-repo-key-" + Date.now());
  if (Array.isArray(live) && live.length === 0)
    ok("findLiveByRepoKey: empty for nonexistent repo key");
  else fail_("findLiveByRepoKey: should return empty array");
}

// --- pruneLostSessions (D43 self-heal) ---

// T_prune_1: pruneLostSessions marks lost entries as ended
{
  // Register a session with a dead pid.
  const lostId = `lost-${Date.now()}`;
  session.register({
    session_id: lostId,
    pid: 999999,  // dead pid
    cwd: "/tmp",
    agent: "conductor",
    repo_key: "test/lost",
  });
  // Verify it's not live
  const before = session.find({ session_id: lostId });
  if (before && !before.ended_at) {
    // Run prune
    const result = session.pruneLostSessions();
    const after = session.find({ session_id: lostId });
    if (after && after.ended_at) ok("pruneLostSessions: marks lost entry as ended");
    else fail_("pruneLostSessions: should mark lost entry as ended");
  } else {
    fail_("pruneLostSessions: setup failed (entry already ended)");
  }
}

// --- F24: lease re-key when holder is dead ---

// F24 scenario: `a cc` mints an id, claims the lease, then exits. The real
// session (nested) calls touch, which calls renewLease. renewLease sees the
// holder is dead and re-keys the lease to the live session.

// F24a: renewLease re-keys when the holder is dead
{
  resetState();
  const ccId = `cc-${Date.now()}`;
  const realId = `real-${Date.now()}`;
  session.register({ session_id: ccId, pid: 999999, cwd: tmpDir, agent: "conductor" });
  session.register({ session_id: realId, pid: process.pid, cwd: tmpDir, agent: "conductor" });

  session.claimLease({
    task_dir: taskDir, project_dir: tmpDir, session_id: ccId, pid: 999999,
  });

  let task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === ccId) ok("F24a: lease initially held by cc-id");
  else fail_("F24a: lease should be held by cc-id: " + JSON.stringify(task.lease));

  const renewed = session.renewLease({
    task_dir: taskDir, project_dir: tmpDir, session_id: realId,
  });
  if (renewed === true) ok("F24a: renewLease re-keys when holder is dead");
  else fail_("F24a: renewLease should re-key: " + renewed);

  task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === realId) ok("F24a: lease re-keyed to real-id");
  else fail_("F24a: lease should be held by real-id: " + JSON.stringify(task.lease));
  if (task.binding && task.binding.session_id === realId) ok("F24a: binding re-keyed to real-id");
  else fail_("F24a: binding should be real-id: " + JSON.stringify(task.binding));

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, ccId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, realId), { recursive: true, force: true }); } catch {}
}

// F24b: touch re-keys the lease when the holder is dead
{
  resetState();
  const ccId = `cc2-${Date.now()}`;
  const realId = `real2-${Date.now()}`;
  session.register({ session_id: ccId, pid: 999999, cwd: tmpDir, agent: "conductor" });
  session.register({ session_id: realId, pid: process.pid, cwd: tmpDir, agent: "conductor", task_dir: taskDir });

  session.claimLease({
    task_dir: taskDir, project_dir: tmpDir, session_id: ccId, pid: 999999,
  });

  const touched = session.touch(realId);
  if (touched === true) ok("F24b: touch returns true for real-id");
  else fail_("F24b: touch should return true: " + touched);

  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === realId) ok("F24b: touch re-keyed lease to real-id");
  else fail_("F24b: lease should be re-keyed to real-id: " + JSON.stringify(task.lease));

  const expiresBefore = task.lease.expires_at;
  const sleepUntil = Date.now() + 15;
  while (Date.now() < sleepUntil) {}
  session.touch(realId);
  const task2 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task2.lease && task2.lease.session_id === realId && task2.lease.expires_at !== expiresBefore)
    ok("F24b: second touch renews the re-keyed lease");
  else
    fail_("F24b: second touch should renew: " + JSON.stringify(task2.lease));

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, ccId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, realId), { recursive: true, force: true }); } catch {}
}

// F24c: renewLease does NOT re-key when the holder is alive
{
  resetState();
  const holderId = `holder-${Date.now()}`;
  const challengerId = `challenger-${Date.now()}`;
  session.register({ session_id: holderId, pid: process.pid, cwd: tmpDir, agent: "conductor" });
  session.register({ session_id: challengerId, pid: process.pid, cwd: tmpDir, agent: "builder" });

  session.claimLease({
    task_dir: taskDir, project_dir: tmpDir, session_id: holderId, pid: process.pid,
  });

  const renewed = session.renewLease({
    task_dir: taskDir, project_dir: tmpDir, session_id: challengerId,
  });
  if (renewed === false) ok("F24c: renewLease refuses re-key when holder is alive");
  else fail_("F24c: renewLease should refuse re-key: " + renewed);

  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (task.lease && task.lease.session_id === holderId) ok("F24c: lease stays with live holder");
  else fail_("F24c: lease should stay with holder: " + JSON.stringify(task.lease));

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, holderId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(session.SESSIONS_ROOT, challengerId), { recursive: true, force: true }); } catch {}
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
