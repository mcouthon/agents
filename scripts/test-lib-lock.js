#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { withLock, LockHeldError } = require("./lib/lock");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lock-test-"));

// Test 1: basic acquisition and release
{
  const dir = path.join(tmpDir, "basic");
  fs.mkdirSync(dir, { recursive: true });
  const holder = { session_id: "s1", pid: process.pid };
  const result = withLock(dir, holder, () => 42);
  if (result === 42) ok("withLock returns fn result");
  else fail_("withLock should return 42");
  if (!fs.existsSync(path.join(dir, ".lock"))) ok("lock dir removed after fn");
  else fail_("lock dir should be gone after fn");
}

// Test 2: stale reclaim (holder with dead pid)
{
  const dir = path.join(tmpDir, "stale");
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "holder"), JSON.stringify({ session_id: "dead", pid: 999999 }));
  const holder = { session_id: "s2", pid: process.pid };
  const result = withLock(dir, holder, () => "reclaimed");
  if (result === "reclaimed") ok("stale lock reclaimed (dead pid)");
  else fail_("stale lock should be reclaimed");
}

// Test 3: stale reclaim (no holder file)
{
  const dir = path.join(tmpDir, "no-holder");
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  fs.mkdirSync(lockDir);
  const holder = { session_id: "s3", pid: process.pid };
  const result = withLock(dir, holder, () => "ok");
  if (result === "ok") ok("lock reclaimed when holder file missing");
  else fail_("should reclaim lock with no holder file");
}

// Test 4: LockHeldError when lock held by live pid
{
  const dir = path.join(tmpDir, "contended");
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "holder"), JSON.stringify({ session_id: "live", pid: process.pid }));
  try {
    withLock(dir, { session_id: "s4", pid: process.pid }, () => "should-not-run");
    fail_("should throw LockHeldError");
  } catch (err) {
    if (err instanceof LockHeldError) ok("LockHeldError thrown when lock held by live pid");
    else fail_("expected LockHeldError, got " + err.name);
    if (err.holder && err.holder.session_id === "live") ok("LockHeldError has correct holder");
    else fail_("holder should be {session_id: 'live'}");
  }
}

// Test 5: fn can throw and lock is still released
{
  const dir = path.join(tmpDir, "throws");
  fs.mkdirSync(dir, { recursive: true });
  try {
    withLock(dir, { session_id: "s5", pid: process.pid }, () => {
      throw new Error("boom");
    });
  } catch (err) {
    if (err.message === "boom") ok("fn error propagated through withLock");
    else fail_("expected 'boom' error");
  }
  if (!fs.existsSync(path.join(dir, ".lock"))) ok("lock released after fn throws");
  else fail_("lock should be released even when fn throws");
}

// Test 6: sequential locks (acquire, release, acquire again)
{
  const dir = path.join(tmpDir, "sequential");
  fs.mkdirSync(dir, { recursive: true });
  const holder = { session_id: "s6", pid: process.pid };
  const r1 = withLock(dir, holder, () => 1);
  const r2 = withLock(dir, holder, () => 2);
  if (r1 === 1 && r2 === 2) ok("sequential lock acquisition works");
  else fail_("sequential locks should work");
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
