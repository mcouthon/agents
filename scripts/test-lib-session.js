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

// --- Registry calls leave the task file alone ---

const tmpDir = path.join(os.tmpdir(), `agents-test-${Date.now()}`);

// L1: register, touch and unregister write only the registration. A task.json
// that carries a lease stays byte-identical after each call.
{
  const taskDir = path.join(tmpDir, "test-task");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify({
    schema: 2, slug: "test-task", number: 1, title: "Test Task", status: "planning", mode: "full",
    knobs: {}, binding: {}, lease: {}, last_writer: {}, phases: [], checkpoints: [], flags: [],
    created: "2026-01-01", updated: "2026-01-01T00:00:00.000Z",
  }, null, 2) + "\n");
  const before = fs.readFileSync(taskFile, "utf8");
  const sid = `l1-${Date.now()}`;

  const res = session.register({ session_id: sid, pid: process.pid, cwd: tmpDir, agent: "conductor", task_dir: taskDir, project_dir: tmpDir });
  if (fs.readFileSync(taskFile, "utf8") === before) ok("L1: register leaves task.json byte-identical");
  else fail_("L1: register changed task.json");
  if (Object.keys(res).sort().join() === "registration,session_dir") ok("L1: register returns exactly registration and session_dir");
  else fail_("L1: register returned " + Object.keys(res).sort().join());

  session.touch(sid);
  if (fs.readFileSync(taskFile, "utf8") === before) ok("L1: touch leaves task.json byte-identical");
  else fail_("L1: touch changed task.json");

  session.unregister(sid);
  if (fs.readFileSync(taskFile, "utf8") === before) ok("L1: unregister leaves task.json byte-identical");
  else fail_("L1: unregister changed task.json");

  try { fs.rmSync(path.join(session.SESSIONS_ROOT, sid), { recursive: true, force: true }); } catch {}
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
// touching the parent's registration. Same/dead/null pid rebinds.
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

    // Nested: foreign pid registers under its own id and leaves the parent alone.
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
    const parentReg = session.readRegistration(d28Pointer);
    if (parentReg && parentReg.session_id === parentSid && parentReg.pid === process.pid)
      ok("D28 lib: parent registration untouched");
    else
      fail_("D28 lib: parent should be untouched: " + JSON.stringify(parentReg && parentReg.session_id));
    try { fs.rmSync(childDir, { recursive: true, force: true }); } catch {}

    // Dead recorded pid rebinds the pointer.
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

// --- Resumed sessions, mux, pid_at, dir-keyed writes ---

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-sessions-stub-"));
// A copy of /bin/sleep is killed on arm64 macOS (platform binaries lose their
// signature), so the stand-in for claude is a shell script whose command line
// contains "claude".
fs.writeFileSync(path.join(stubDir, "claude"), '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
const { spawn, execFileSync } = require("child_process");
const stubs = [];
function spawnStubClaude() {
  const child = spawn(path.join(stubDir, "claude"), ["30"], { stdio: "ignore", detached: true });
  stubs.push(child);
  // fork returns before exec: wait until ps shows the stub's own command line
  for (let i = 0; i < 100; i++) {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    if (cmd.includes("claude")) break;
    execFileSync("/bin/sleep", ["0.02"]);
  }
  return child;
}
delete process.env.AGENTS_TEST_SKIP_IDENTITY;

// S1: a register for a known, ended id means the session runs again.
{
  const sid = `s1-${Date.now()}`;
  session.register({ session_id: sid, pid: 111111, cwd: "/tmp", agent: "conductor" });
  session.unregister(sid);
  const ended = session.find({ session_id: sid });
  const again = session.register({ session_id: sid, pid: 222222 });
  if (ended.ended_at && !again.registration.ended_at && again.registration.pid === 222222 &&
      !session.find({ session_id: sid }).ended_at) ok("S1: re-register clears ended_at and records the new pid");
  else fail_("S1: re-register should clear ended_at and record the new pid");
}

// S2: mux persists, and a later register without mux keeps it.
{
  const sid = `s2-${Date.now()}`;
  const mux = { kind: "zmx", name: "Conductor-abcd1234" };
  session.register({ session_id: sid, pid: 111111, cwd: "/tmp", agent: "conductor", mux });
  const stored = session.find({ session_id: sid });
  session.register({ session_id: sid, pid: 111112 });
  const kept = session.find({ session_id: sid });
  if (JSON.stringify(stored.mux) === JSON.stringify(mux) && JSON.stringify(kept.mux) === JSON.stringify(mux))
    ok("S2: mux is stored and survives a register without mux");
  else fail_("S2: mux should be stored and kept");
}

// S3: isLive measures the process start against pid_at when given, else created_at.
{
  const child = spawnStubClaude();
  const startedBefore = new Date().toISOString();
  const withPidAt = session.isLive({ pid: child.pid, pid_at: startedBefore, created_at: "2020-01-01T00:00:00Z" });
  const minuteBeforeStart = new Date(Date.now() - 60000).toISOString();
  const withoutPidAt = session.isLive({ pid: child.pid, created_at: minuteBeforeStart });
  if (withPidAt === true) ok("S3: a claude process started before pid_at reads live");
  else fail_("S3: a claude process started before pid_at should read live");
  if (withoutPidAt === false) ok("S3: with no pid_at, a process newer than created_at reads not live (reused pid)");
  else fail_("S3: without pid_at the created_at rule must still reject a newer process");
}

// S4: resume end to end — the second claude process starts long after created_at.
{
  const sid = `s4-${Date.now()}`;
  const a = spawnStubClaude();
  session.register({ session_id: sid, pid: a.pid, pid_at: new Date().toISOString(), cwd: "/tmp", agent: "conductor" });
  session.unregister(sid);
  execFileSync("/bin/sleep", ["1.2"]); // the resumed process starts seconds after created_at, past ps's one-second resolution
  const b = spawnStubClaude();
  const reg = session.register({ session_id: sid, pid: b.pid, pid_at: new Date(Date.now() + 5000).toISOString() }).registration;
  if (session.isLive(reg) && !reg.ended_at && !session.find({ session_id: sid }).ended_at)
    ok("S4: a resumed session reads live and has no ended_at");
  else fail_("S4: a resumed session should read live with no ended_at");
}

// S5: pid_at and mux are stored only when passed; a pid without pid_at drops a stored pid_at.
{
  const bare = `s5a-${Date.now()}`;
  session.register({ session_id: bare, cwd: "/tmp" });
  const bareReg = session.find({ session_id: bare });
  const cli = `s5b-${Date.now()}`;
  session.register({ session_id: cli, pid: 111111, cwd: "/tmp" });
  const cliReg = session.find({ session_id: cli });
  const had = `s5c-${Date.now()}`;
  session.register({ session_id: had, pid: 111111, pid_at: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
  const hadBefore = session.find({ session_id: had }).pid_at;
  session.register({ session_id: had, pid: 111112 });
  const hadAfter = session.find({ session_id: had });
  if (!("pid_at" in bareReg) && !("mux" in bareReg) && !("pid_at" in cliReg) && !("mux" in cliReg))
    ok("S5: no pid_at or mux key unless passed");
  else fail_("S5: pid_at and mux keys must be absent unless passed");
  if (hadBefore === "2026-01-01T00:00:00.000Z" && !("pid_at" in hadAfter))
    ok("S5: a pid without pid_at removes a stored pid_at");
  else fail_("S5: a pid without pid_at should remove the stored pid_at");
}

// S6: entries() carries each registration's dir; markEnded(dir) ends that dir only.
{
  const sid = `s6-${Date.now()}`;
  const dir = path.join(session.sessionsRoot(), "t1");
  session.register({ session_id: sid, terminal_id: "t1", session_dir: dir, pid: 111111, cwd: "/tmp", agent: "conductor" });
  const ended = session.markEnded(dir);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "registration.json"), "utf8"));
  const entry = session.entries().find((e) => e.registration.session_id === sid);
  if (ended === true && typeof onDisk.ended_at === "string" && !fs.existsSync(path.join(session.sessionsRoot(), sid)) &&
      entry && entry.dir === dir)
    ok("S6: markEnded writes ended_at into the given dir; entries() returns that dir");
  else fail_("S6: markEnded/entries should work on the launcher dir without creating <root>/<session_id>");
  if (session.markEnded(path.join(session.sessionsRoot(), "no-such-dir")) === false) ok("S6: markEnded on a missing dir returns false");
  else fail_("S6: markEnded on a missing dir should return false");
}

for (const child of stubs) { try { process.kill(-child.pid); } catch {} }
try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// Clean up isolated registry root
try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
