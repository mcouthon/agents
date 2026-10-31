"use strict";

const fs = require("fs");
const path = require("path");

const MAX_WAIT_MS = 2000;
const INITIAL_DELAY_MS = 10;
const MAX_DELAY_MS = 100;
/** How long a lock directory with no holder file stays untouchable: the window between mkdir and the holder write. */
const HOLDERLESS_GRACE_MS = 10000;
/** The poll interval of a `wait: "until-free"` waiter. */
const UNTIL_FREE_POLL_MS = 100;

function removeLockDir(lockPath) {
  try { fs.unlinkSync(path.join(lockPath, "holder")); } catch {}
  try { fs.rmdirSync(lockPath); } catch {}
}

class LockHeldError extends Error {
  constructor(holder) {
    super(`Lock held by ${holder.session_id} (pid ${holder.pid})`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

function withLock(dir, holder, fn) {
  return withNamedLock(path.join(dir, ".lock"), holder, fn);
}

/**
 * Run `fn` under the named lock.
 * - default: throws `LockHeldError` after MAX_WAIT_MS of waiting.
 * - `opts.wait === "until-free"`: never throws; polls every 100 ms, printing
 *   `waiting for the <waitLabel> held by pid <n>` once, and returns
 *   `{ alreadyDone: true }` as soon as `opts.isDone()` says the work it waited
 *   for has happened.
 * A lock directory whose holder's pid is dead is reclaimed; one with no holder
 * file counts as free only after the holder-less grace, so two openers can no
 * longer both hold a lock.
 */
function withNamedLock(lockPath, holder, fn, opts = {}) {
  const startTime = Date.now();
  let delay = INITIAL_DELAY_MS;
  let warned = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (canReclaim(lockPath)) {
        removeLockDir(lockPath);
        continue;
      }
      if (opts.wait === "until-free") {
        if (opts.isDone && opts.isDone()) return { alreadyDone: true };
        if (!warned) {
          warned = true;
          const existing = readHolder(lockPath);
          const pid = existing && existing.pid ? String(existing.pid) : "unknown";
          process.stderr.write(`waiting for the ${opts.waitLabel || "lock"} held by pid ${pid}\n`);
        }
        sleepMs(UNTIL_FREE_POLL_MS);
        continue;
      }
      if (Date.now() - startTime >= MAX_WAIT_MS) {
        const existing = readHolder(lockPath);
        throw new LockHeldError(existing || { session_id: "unknown", pid: null });
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      continue;
    }

    try {
      fs.writeFileSync(path.join(lockPath, "holder"), JSON.stringify(holder), "utf8");
    } catch (err) {
      removeLockDir(lockPath);
      throw err;
    }

    try {
      return fn();
    } finally {
      removeLockDir(lockPath);
    }
  }
}

/** A lock is reclaimable when its holder's pid is dead, or its directory has sat holder-less past the grace. */
function canReclaim(lockDir) {
  const holder = readHolder(lockDir);
  if (holder) return holder.pid ? !isPidAlive(holder.pid) : true;
  let mtimeMs;
  try { mtimeMs = fs.statSync(lockDir).mtimeMs; } catch { return true; }
  return Date.now() - mtimeMs >= HOLDERLESS_GRACE_MS;
}

function readHolder(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "holder"), "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { sleepSync(ms); }
}

module.exports = { withLock, withNamedLock, canReclaim, isPidAlive, LockHeldError, removeLockDir, HOLDERLESS_GRACE_MS };
