"use strict";

const fs = require("fs");
const path = require("path");

const MAX_WAIT_MS = 2000;
const INITIAL_DELAY_MS = 10;
const MAX_DELAY_MS = 100;

class LockHeldError extends Error {
  constructor(holder) {
    super(`Lock held by ${holder.session_id} (pid ${holder.pid})`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

function withLock(dir, holder, fn) {
  const lockDir = path.join(dir, ".lock");
  const startTime = Date.now();
  let delay = INITIAL_DELAY_MS;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (canReclaim(lockDir)) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - startTime >= MAX_WAIT_MS) {
        const existing = readHolder(lockDir);
        throw new LockHeldError(existing || { session_id: "unknown", pid: null });
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      continue;
    }

    try {
      fs.writeFileSync(path.join(lockDir, "holder"), JSON.stringify(holder), "utf8");
    } catch (err) {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
      throw err;
    }

    try {
      return fn();
    } finally {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function canReclaim(lockDir) {
  const holder = readHolder(lockDir);
  if (!holder) return true;
  if (holder.pid && !isPidAlive(holder.pid)) return true;
  return false;
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

module.exports = { withLock, LockHeldError };
