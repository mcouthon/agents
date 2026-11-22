"use strict";

/**
 * The machine-wide test slots: `a check` and `a land` take one before running
 * a test command, so several worktrees' suites cannot all run at once.
 *
 * A pool of N lock directories under ~/.agents/test-slots/ (N is `tests.slots`
 * in the config, default 2, read on every poll). A run that finds the pool
 * full queues oldest first: every run first writes a waiting marker
 * (waiting/<pid>.json) and may take a free slot only while no older live
 * marker exists, so no waiter is passed over. A marker whose pid is dead, or
 * older than the wait cap, is ignored. A wait past the cap refuses
 * `test_slot_busy`; the run is never skipped.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { tryAcquireLock, removeLockDir, readHolder, isPidAlive, sleepMs } = require("./lock");
const { loadConfig, agentsConfigPath } = require("./config");
const { tasksRootBase } = require("./tasks-root");
const { fail } = require("./start");
const adapter = require("./adapter").forHarness();

const DEFAULT_SLOTS = 2;
const DEFAULT_WAIT_MS = 300000;
const POLL_MS = 100;
/** A waiting marker older than the wait cap plus this cannot belong to a live waiter. */
const MARKER_GRACE_MS = 10000;

const poolDir = () => path.join(os.homedir(), ".agents", "test-slots");
const slotPath = (i) => path.join(poolDir(), `${i}.lock`);
const waitingDir = () => path.join(poolDir(), "waiting");
const markerPath = (pid) => path.join(waitingDir(), `${pid}.json`);

function refusal(code, message, remedy) {
  return fail(2, `${message}\nRemedy: ${remedy}`, code, { remedy });
}

/** The longest to wait for a slot; `AGENTS_SLOT_WAIT_MS` replaces the 300 s default. */
function waitMs() {
  const ms = Number(process.env.AGENTS_SLOT_WAIT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_WAIT_MS;
}

/** `tests.slots` from the config: unset reads as 2, anything but a positive integer refuses. */
function slotCount() {
  const tests = loadConfig().tests;
  const n = tests ? tests.slots : undefined;
  if (n === undefined || n === null) return DEFAULT_SLOTS;
  if (Number.isInteger(n) && n > 0) return n;
  const file = agentsConfigPath();
  throw refusal("test_slots_invalid", `tests.slots in ${file} is ${JSON.stringify(n)}, not a positive whole number.`, `set tests.slots in ${file} to a whole number of 1 or more`);
}

function registerWaiter(entry) {
  fs.mkdirSync(waitingDir(), { recursive: true });
  const tmp = `${markerPath(entry.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, markerPath(entry.pid));
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

const unregisterWaiter = (pid) => removeFile(markerPath(pid));

function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Live waiting markers, oldest first; a dead or over-age marker is removed as it is seen. */
function liveWaiters() {
  let files;
  try { files = fs.readdirSync(waitingDir()).filter((f) => f.endsWith(".json")); } catch { return []; }
  const oldestPossible = Date.now() - waitMs() - MARKER_GRACE_MS;
  const live = [];
  for (const f of files) {
    const file = path.join(waitingDir(), f);
    const marker = readMarker(file);
    if (marker && isPidAlive(marker.pid) && marker.since_ms >= oldestPossible) live.push(marker);
    else removeFile(file);
  }
  return live.sort((a, b) => a.since_ms - b.since_ms || a.pid - b.pid);
}

function isOldest(pid) {
  const first = liveWaiters()[0];
  return first === undefined || first.pid === pid;
}

/** The slot index taken, or null while the pool is full or an older waiter goes first. A later load gate adds its condition here. */
function tryAdmit(holder) {
  const n = slotCount();
  if (!isOldest(holder.pid)) return null;
  fs.mkdirSync(poolDir(), { recursive: true });
  const taken = { ...holder, since: new Date().toISOString() };
  for (let i = 0; i < n; i++) {
    if (tryAcquireLock(slotPath(i), taken)) return i;
  }
  return null;
}

/** The live holders across the pool, slot order. */
function holders() {
  let names;
  try { names = fs.readdirSync(poolDir()).filter((f) => /^\d+\.lock$/.test(f)); } catch { return []; }
  return names
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => readHolder(path.join(poolDir(), f)))
    .filter((h) => h && isPidAlive(h.pid));
}

function describeHolder(h) {
  const minutes = Math.floor((Date.now() - Date.parse(h.since)) / 60000);
  return `${h.task} (${h.verb}, pid ${h.pid}) since ${new Date(h.since).toTimeString().slice(0, 8)} (${minutes} m ago)`;
}

function describeQueue(held, n) {
  return `waiting for a test slot (${held.length} of ${n} in use): ${held.map(describeHolder).join("; ")}`;
}

const queueSignature = (held) => held.map((h) => h.pid).sort().join(",");

function formatWait(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

const waitNote = (waitedMs, blockers) => `waited ${formatWait(waitedMs)} for a slot held by task ${blockers.join(", ")}`;

function busyRefusal(held, n, self) {
  const ahead = liveWaiters().filter((w) => w.pid !== self.pid && w.since_ms < self.since_ms).map((w) => w.task);
  const queued = ahead.length > 0 ? ` Waiting ahead of this run: ${ahead.join(", ")}.` : "";
  return refusal(
    "test_slot_busy",
    `No test slot freed within ${formatWait(waitMs())}. ${describeQueue(held, n)}.${queued}`,
    `run it again when a slot frees, or raise tests.slots in ${agentsConfigPath()} (now ${n}); if a holder is gone, remove its directory under ${poolDir()}`,
  );
}

/** Wait for a slot; returns `{ slot, note }`, `note` set when the pool was full and the run queued. */
function waitForSlot(holder, startMs) {
  const blockers = [];
  let printed = null;
  while (true) {
    const slot = tryAdmit(holder);
    if (slot !== null) return { slot, note: blockers.length > 0 ? waitNote(Date.now() - startMs, blockers) : undefined };
    const n = slotCount();
    const held = holders();
    if (held.length >= n && queueSignature(held) !== printed) {
      process.stderr.write(`${describeQueue(held, n)}\n`);
      printed = queueSignature(held);
      if (blockers.length === 0) blockers.push(...new Set(held.map((h) => h.task)));
    }
    if (Date.now() - startMs >= waitMs()) throw busyRefusal(held, n, { pid: holder.pid, since_ms: startMs });
    sleepMs(POLL_MS);
  }
}

/**
 * Run `fn` holding one test slot. Returns `{ value, slot_wait }`; `slot_wait`
 * says how long the run queued and behind whom, absent when it did not.
 */
function withTestSlot({ verb, taskDir }, fn) {
  const startMs = Date.now();
  const holder = {
    session_id: adapter.ownSessionId(),
    pid: process.pid,
    task: path.relative(tasksRootBase(), taskDir),
    verb,
  };
  let admitted;
  try {
    registerWaiter({ pid: holder.pid, task: holder.task, since_ms: startMs });
    admitted = waitForSlot(holder, startMs);
  } finally {
    unregisterWaiter(holder.pid);
  }
  if (admitted.note) process.stderr.write(`${admitted.note}\n`);
  try {
    return { value: fn(), slot_wait: admitted.note };
  } finally {
    removeLockDir(slotPath(admitted.slot));
  }
}

module.exports = { withTestSlot, holders, slotCount, waitMs };
