#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const session = require("./lib/session");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const testId = `test-${Date.now()}`;
const testId2 = `test2-${Date.now()}`;

// Test 1: register creates registration.json
{
  const reg = session.register({
    session_id: testId,
    pid: process.ppid,
    cwd: "/tmp",
    agent: "conductor",
  });
  if (reg.session_id === testId) ok("register returns registration with session_id");
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
  session.register({ session_id: testId2, pid: 99999, cwd: "/tmp", agent: "builder" });
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

// Test 7: unregister removes session
{
  session.unregister(testId2);
  const found = session.find({ session_id: testId2 });
  if (found === null) ok("unregister removes the session");
  else fail_("unregister should remove the session");
}

// Cleanup
session.unregister(testId);
const tidSession = session.find({ terminal_id: "term-1" });
if (tidSession) session.unregister(tidSession.session_id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
