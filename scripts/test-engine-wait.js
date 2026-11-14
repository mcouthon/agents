#!/usr/bin/env node
"use strict";
// engine-wait: the coordinator's poll — wakes on watched tasks' engine facts and
// on unknown tasks coming online, never on the home task, the own session,
// unwatched tasks or message text. Driven end to end: the script runs as a child
// against isolated roots with a stub zmx, the world changes through the lib
// between polls. Isolation: nothing here may touch the real HOME, config, git
// config, zmx, sessions or database.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-engine-wait-")));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs", "stubbin", "procs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  // A root carrying this run's nonce is this run's — the residue scans below
  // never count a concurrent worktree's roots (its own nonce, or none) in the
  // shared os.tmpdir.
  if (process.env.AGENTS_TEST_SUITE_NONCE) fs.writeFileSync(path.join(t, "suite.nonce"), process.env.AGENTS_TEST_SUITE_NONCE);
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "AGENTS_TEST_SKIP_IDENTITY",
    "CLAUDE_CODE_SESSION_ID", "ZMX_SESSION", "ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const ENGINE_WAIT = path.join(__dirname, "bin", "engine-wait");
const T = process.env.AGENTS_TEST_TMP;
let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const pause = (s) => execFileSync("/bin/sleep", [String(s)]);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A zmx that answers `list` from $ZMX_LIST_FILE (the engine-wait child's roster
// reads liveness through it) and nothing else — no guard hits, no sessions.
const zmxFile = path.join(T, "zmx-list.txt");
process.env.ZMX_LIST_FILE = zmxFile;
fs.writeFileSync(path.join(T, "stubbin", "zmx"),
  '#!/bin/sh\ncase "$1" in\n  --version) echo "zmx 0.8.1"; exit 0 ;;\n  list) cat "$ZMX_LIST_FILE"; exit 0 ;;\nesac\nexit 97\n', { mode: 0o755 });
process.env.PATH = `${path.join(T, "stubbin")}:${process.env.PATH}`;
const zl = (name) => `name=${name}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp`;
function setZmx(names) { fs.writeFileSync(zmxFile, names.map((l) => l + "\n").join("")); }

// A live claude-looking process (a copy of /bin/sleep would be killed on arm64 macOS).
const procFile = path.join(T, "procs", "claude");
fs.writeFileSync(procFile, '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
// Every spawned child is registered here — the polls and the claude-looking sleeps —
// so no exit path strands one: waitExit kills a poll that outlives its budget, the
// final sweep kills whatever is still open. The claude sleeps run detached, so they
// die by process group.
const spawned = [];
function track(child, { detached = false } = {}) {
  const entry = { child, detached, closed: false };
  child.on("close", () => { entry.closed = true; });
  spawned.push(entry);
  return entry;
}
function killSpawned(entry) {
  try {
    if (entry.detached) process.kill(-entry.child.pid, "SIGKILL");
    else entry.child.kill("SIGKILL");
  } catch { /* already gone */ }
}

// Every exit path runs one sweep: the signal handlers (the runner's pid-only
// TERM, a Ctrl-C, check.sh's trap — a signal landing mid-await is deferred to
// the next loop turn, never lost) and the exit belt, which the promise paths
// below reach through process.exit. The sweep itself is fully synchronous,
// safe from a signal handler and an exit hook alike. Exit 128+signum is the
// runner's own convention — an interrupted run's suite line reads exit=143.
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const e of spawned) if (!e.closed) killSpawned(e);
  fs.rmSync(T, { recursive: true, force: true });
}
for (const [sig, num] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
  process.on(sig, () => { teardown(); process.exit(128 + num); });
}
process.on("exit", teardown);
function spawnClaude() {
  const child = spawn(procFile, ["60"], { stdio: "ignore", detached: true });
  track(child, { detached: true });
  for (let i = 0; i < 100; i++) {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    if (cmd.includes("claude")) break;
    execFileSync("/bin/sleep", ["0.02"]);
  }
  return child;
}

function useRoots(label) {
  const root = mk(label);
  process.env.AGENTS_TASKS_ROOT = path.join(root, "tasks");
  process.env.AGENTS_SESSIONS_ROOT = path.join(root, "sessions");
  process.env.AGENTS_DB = path.join(root, "agents.db");
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  db.open({ create: true });
  setZmx([]);
}

function makeRepo() {
  const dir = path.join(mk("repo"), "acme");
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# acme\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://github.com/acme/acme.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function mkTask(key, slug, title) {
  return taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
}

function register(fields) {
  const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, fields.terminal_id);
  return session.register({ origin: "cli", initiator: "user", cwd: "/tmp", agent: "conductor", session_dir: dir, ...fields });
}

/** A decide row plus its event, exactly what `a decide` writes, authored by `sessionId`. */
function decideRow(dir, sessionId, quote = "the owner's words verbatim") {
  const taskId = db.taskIdOf(dir);
  const decisionId = db.insertDecision({ task_id: taskId, phase_id: null, choice: "answer", gate: "finalize", plan_hash: null, quote, recorded_by: sessionId });
  db.appendEvent({ kind: "decide", repoKey: null, taskId, sessionId, detail: JSON.stringify({ decision_id: decisionId, phase_id: null, choice: "answer", gate: "finalize" }) });
  return decisionId;
}

function watchSet(homeDir, { watched = [], unwatched = [] } = {}) {
  const lines = ["## Watched", ...watched, "", "## Unwatched", ...unwatched, "", "## Log", ""];
  fs.writeFileSync(path.join(homeDir, "watch-set.md"), lines.join("\n") + "\n");
  // Derive the built world once and flush the facts cache into the live
  // tree: every poll armed over this world then runs its baseline on cache
  // hits, so a poll that dies by self-reap after a sweep removed the fixture
  // root flushes nothing — derive's exit flush (a recursive mkdir beside the
  // database) would otherwise resurrect the removed tree.
  require("./lib/roster").build({ all: true });
  require("./lib/derive").flushFacts();
}

// The poll child: stdout/stderr captured, `closed` set by the close event (all
// streams flushed), stillRunning/waitExit poll it synchronously.
function spawnWait(homeDir, { interval = "0.2", snapshot, own = "cccc0001-0000-4000-8000-000000000001", db } = {}) {
  const env = { ...process.env };
  if (own) env.CLAUDE_CODE_SESSION_ID = own; else delete env.CLAUDE_CODE_SESSION_ID;
  if (snapshot) env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS = snapshot; else delete env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS;
  if (db) env.AGENTS_DB = db;
  const child = spawn(process.execPath, [ENGINE_WAIT, path.resolve(homeDir), "--interval", interval], { env, stdio: ["ignore", "pipe", "pipe"] });
  track(child);
  const w = { child, closed: false, code: null, out: "", err: "" };
  child.stdout.on("data", (d) => { w.out += d; });
  child.stderr.on("data", (d) => { w.err += d; });
  child.on("close", (code) => { w.closed = true; w.code = code; });
  return w;
}
function waitExit(w, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline && !w.closed) await sleepMs(50);
    // A poll that outlives its budget is killed, never orphaned — the child has no
    // timeout of its own, and the check still fails with the captured out/err.
    if (!w.closed) { try { w.child.kill("SIGKILL"); } catch { /* already gone */ } }
    return w.closed;
  })();
}
function stillRunning(w, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline && !w.closed) await sleepMs(50);
    return !w.closed;
  })();
}
async function killWait(w) {
  try { w.child.kill("SIGKILL"); } catch { /* already gone */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !w.closed) await sleepMs(50);
}
function closedWithin(w, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline && !w.closed) await sleepMs(25);
    return w.closed;
  })();
}
// A poll is armed — its parent chain captured, the baseline snapshot and the
// event cursor read behind it — once its loop is running: the loop's first
// act is a synchronous /bin/sleep child, and nothing else in the poll's
// closure ever spawns one, so a sleep child of the poll's pid is positive
// proof (ps, the findSuitePoll pattern). A miss only delays; a false positive
// cannot happen.
async function pollLooping(pid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[2]) === pid && /^\/bin\/sleep\b/.test(m[3].trim())) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleepMs(40);
  }
}

// One baseline's worth, observed rather than gambled: the world changes land
// on a poll that has already derived the world — under load a poll's boot
// and baseline outlast any fixed sleep, and a change landing pre-baseline
// (the event cursor included) is invisible to it forever. Bounded, and the
// bound is reported: the return says whether the arming was observed within
// it. The stillRunning-negative sites assert it — a poll still in boot is
// silent vacuously, and a vacuous silence must never read green — while the
// positive sites consume it as a plain wait, their exit budgets judging an
// un-armed poll honestly on their own.
async function settle(w, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!w.closed && Date.now() < deadline) {
    if (await pollLooping(w.child.pid, 250)) return true;
  }
  return false;
}

// The kill-the-suite scenarios: a child suite is this file re-run under
// ENGINE_WAIT_ONLY, its poll discovered live through ps — the suite's own
// spawn shape (a direct node child), so the child's death orphans the poll
// exactly the way the pinned leak presented.

// Child suites root inside this suite's fixture tree: the parent's recursive rm
// takes child roots down on every teardown path — including the interrupt path,
// where the child dies to the sweep's SIGKILL and its own belt never runs.
// Every child is tagged with this run's nonce (minted once by the top run,
// inherited at every generation), so a leaked root can be told ours from a
// sibling worktree's by its content, not by the shared directory it lands in.
const SUITE_NONCE = process.env.AGENTS_TEST_SUITE_NONCE || require("crypto").randomUUID();
function oursRoot(dir) {
  try { return fs.readFileSync(path.join(dir, "suite.nonce"), "utf8").trim() === SUITE_NONCE; } catch { return false; }
}
const childTmp = path.join(T, "child-tmp");
function spawnSuite(labels, extraEnv = {}) {
  fs.mkdirSync(childTmp, { recursive: true });
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, ENGINE_WAIT_ONLY: labels, TMPDIR: childTmp, AGENTS_TEST_SUITE_NONCE: SUITE_NONCE, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  track(child);
  const s = { child, closed: false, code: null, out: "", err: "" };
  child.stdout.on("data", (d) => { s.out += d; });
  child.stderr.on("data", (d) => { s.err += d; });
  child.on("close", (code, signal) => { s.closed = true; s.code = code === null ? `signal ${signal}` : code; });
  return s;
}
async function findSuitePoll(childPid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[2]) !== childPid) continue;
      const argv = m[3].trim().split(/\s+/);
      const i = argv.findIndex((a) => a.includes("/scripts/bin/engine-wait"));
      if (i >= 0) return { pid: Number(m[1]), home: argv[i + 1] };
    }
    if (Date.now() >= deadline) return null;
    await sleepMs(50);
  }
}
async function suiteClosedWithin(s, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !s.closed) await sleepMs(50);
  return s.closed;
}
async function pidGoneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() >= deadline) return false;
    await sleepMs(50);
  }
}
// The poll's home sits under <fixture-root>/<label>-<n>/tasks/<repo>/<task>:
// split at the tasks root, and the parent of that is the child's mkdtemp root.
const suiteRootOf = (poll) => path.dirname(poll.home.split("/tasks/")[0]);

// ---------------------------------------------------------------- suites

// W1: a decide on a watched task, by another session — the wake carries the id, never the quote.
async function W1() {
  useRoots("w1");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle(w);
  const decisionId = decideRow(alpha, "aaaa0009-0000-4000-8000-000000000009");
  check(await waitExit(w, 4000), `W1: the poll exits on a watched decide (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
    `W1: the wake line is the decide id and the task dir (${JSON.stringify(w.out.trim())})`);
  check(!w.out.includes("the owner's words"), "W1: no quote text anywhere in the output");
}

// W2: the own session's decide and the home task's decide never wake the poll.
async function W2() {
  useRoots("w2");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const own = "cccc0002-0000-4000-8000-000000000002";
  const w = spawnWait(home, { own });
  const armed = await settle(w);
  decideRow(alpha, own);
  db.appendEvent({ kind: "note", taskId: db.taskIdOf(home), sessionId: "aaaa0002", detail: JSON.stringify({ phase_id: null }) });
  decideRow(home, "aaaa0002-0000-4000-8000-000000000002");
  check(armed && await stillRunning(w, 2500), `W2: neither the own decide nor the home task's rows wake it — the poll armed before the rows landed (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W3: an unwatched task's event never wakes (a dir under both headings reads unwatched), nor does an unknown task's.
async function W3() {
  useRoots("w3");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  const charlie = mkTask(key, "charlie", "Charlie");
  watchSet(home, { watched: [alpha, bravo], unwatched: [bravo] });
  const w = spawnWait(home);
  const armed = await settle(w);
  decideRow(bravo, "aaaa0003-0000-4000-8000-000000000003");
  decideRow(charlie, "aaaa0003-0000-4000-8000-000000000004");
  check(armed && await stillRunning(w, 2500), `W3: an unwatched (under both headings) and an unknown task's decides wake nothing — the poll armed before the decides landed (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W4: a watched task's session going needs_input wakes; a child session's does not.
async function W4() {
  useRoots("w4");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const SID = "aaaa0004-0000-4000-8000-000000000004";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw4", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  const w = spawnWait(home);
  await settle(w);
  session.recordSignal(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw4"), { message: "waiting", kind: "idle_prompt" });
  check(await waitExit(w, 4000), `W4: the poll exits on a watched session lighting needs_input (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=needs_input session=${SID} task=${alpha}`,
    `W4: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
}

// W4b (a child registration's needs_input): the W4 block's negative half.
async function W4b() {
  useRoots("w4b");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  // A child session: a live parent holds the pointer, the child registers under its own id.
  const claude = spawnClaude();
  const PARENT = "aaaa0014-0000-4000-8000-000000000014";
  const CHILD = "bbbb0014-0000-4000-8000-000000000014";
  register({ session_id: PARENT, terminal_id: "tw4bp", pid: claude.pid, pid_at: new Date().toISOString(), task_dir: alpha, repo_key: key.key });
  const savedDir = process.env.AGENTS_SESSION_DIR;
  try {
    process.env.AGENTS_SESSION_DIR = path.join(process.env.AGENTS_SESSIONS_ROOT, "tw4bp");
    setZmx([zl(`Conductor-${CHILD.slice(0, 8)}`)]);
    register({ session_id: CHILD, terminal_id: "tw4bc", mux: { kind: "zmx", name: `Conductor-${CHILD.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  } finally {
    // restoring `undefined` would store the literal string and poison every later register
    if (savedDir === undefined) delete process.env.AGENTS_SESSION_DIR;
    else process.env.AGENTS_SESSION_DIR = savedDir;
  }
  const w = spawnWait(home);
  const armed = await settle(w);
  // the nested branch registers the child under <sessions>/<child id>, not the terminal id
  session.recordSignal(path.join(process.env.AGENTS_SESSIONS_ROOT, CHILD), { message: "waiting", kind: "permission_prompt" });
  check(armed && await stillRunning(w, 2500), `W4b: a child registration lighting needs_input wakes nothing — the poll armed before the signal landed (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W5: a watched task's session ending wakes; a dispatch-origin session's end does not.
async function W5() {
  useRoots("w5");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const SID = "aaaa0005-0000-4000-8000-000000000005";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw5", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  const w = spawnWait(home);
  await settle(w);
  session.markEnded(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw5"));
  check(await waitExit(w, 4000), `W5: the poll exits on a watched session ending (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=session_end session=${SID} task=${alpha}`,
    `W5: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
}

// W5b (a dispatch session ending): the W5 block's negative half.
async function W5b() {
  useRoots("w5b");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const SID = "aaaa0025-0000-4000-8000-000000000025";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw5b", origin: "dispatch", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  const w = spawnWait(home);
  const armed = await settle(w);
  session.markEnded(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw5b"));
  check(armed && await stillRunning(w, 2500), `W5b: a dispatch-origin session ending wakes nothing — the poll armed before the end was marked (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W6: a plan file appears with no event — the snapshot interval catches the advice flip.
async function W6() {
  useRoots("w6");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { snapshot: "0.5" });
  await settle(w);
  fs.mkdirSync(path.join(alpha, "plan"));
  fs.writeFileSync(path.join(alpha, "plan", "phase-1-build.md"), "# the plan\n");
  check(await waitExit(w, 5000), `W6: the snapshot interval catches the plan file with no event (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  // The to-word is the engine's own commit-instant semantics; the wake's shape is the contract here.
  check(w.code === 0 && new RegExp(`^wake=advice from=plan to=\\w+ task=${alpha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(w.out.trim()),
    `W6: the wake line is the advice move change from plan (${JSON.stringify(w.out.trim())})`);
}

// W7: a task with no watch-set entry comes online — the ask.
async function W7() {
  useRoots("w7");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const unknown = mkTask(key, "delta", "Delta");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle(w);
  const SID = "aaaa0007-0000-4000-8000-000000000007";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw7", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: unknown, repo_key: key.key });
  check(await waitExit(w, 4000), `W7: an unknown task coming online wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=task_online task=${unknown}`,
    `W7: the wake line is the task dir (${JSON.stringify(w.out.trim())})`);
}

// W8: an unwatched task relaunching stays silent — the standing no.
async function W8() {
  useRoots("w8");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  watchSet(home, { watched: [alpha], unwatched: [bravo] });
  const w = spawnWait(home);
  const armed = await settle(w);
  const SID = "aaaa0008-0000-4000-8000-000000000008";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw8", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: bravo, repo_key: key.key });
  check(armed && await stillRunning(w, 2500), `W8: a declined task relaunching wakes nothing — the poll armed before the relaunch registered (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W9: a watched task gaining a new session wakes nothing task_online-shaped — its facts carry the signal.
async function W9() {
  useRoots("w9");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  const armed = await settle(w);
  const SID = "aaaa0009-0000-4000-8000-000000000009";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw9", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  check(armed && await stillRunning(w, 2500), `W9: a watched task's new session wakes nothing — the poll armed before the session registered (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W10: a dispatch-origin session on an unknown task is not a coming-online.
async function W10() {
  useRoots("w10");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const unknown = mkTask(key, "echo", "Echo");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  const armed = await settle(w);
  const SID = "aaaa0010-0000-4000-8000-000000000010";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw10", origin: "dispatch", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: unknown, repo_key: key.key });
  check(armed && await stillRunning(w, 2500), `W10: a dispatch session on an unknown task wakes nothing — the poll armed before the session registered (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W11: the home task's own session (the coordinator's) is never asked.
async function W11() {
  useRoots("w11");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const own = "cccc0011-0000-4000-8000-000000000011";
  const w = spawnWait(home, { own });
  const armed = await settle(w);
  setZmx([zl(`Coordinator-${own.slice(0, 8)}`)]);
  register({ session_id: own, terminal_id: "tw11", agent: "coordinator", mux: { kind: "zmx", name: `Coordinator-${own.slice(0, 8)}` }, task_dir: home, repo_key: key.key });
  check(armed && await stillRunning(w, 2500), `W11: the home task's session is never asked — the poll armed before the session registered (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W12: a missing watch-set file means every task is unknown — the ask still fires for a task coming online.
async function W12() {
  useRoots("w12");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const base = mkTask(key, "base", "Base");
  const fresh = mkTask(key, "fresh", "Fresh");
  const SID_BASE = "aaaa0012-0000-4000-8000-000000000012";
  setZmx([zl(`Conductor-${SID_BASE.slice(0, 8)}`)]);
  register({ session_id: SID_BASE, terminal_id: "tw12b", mux: { kind: "zmx", name: `Conductor-${SID_BASE.slice(0, 8)}` }, task_dir: base, repo_key: key.key });
  const w = spawnWait(home); // no watch-set.md: every task unknown, the baseline-online ones not re-asked
  await settle(w);
  const SID = "bbbb0012-0000-4000-8000-000000000012";
  setZmx([zl(`Conductor-${SID_BASE.slice(0, 8)}`), zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw12f", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: fresh, repo_key: key.key });
  check(await waitExit(w, 4000), `W12: with no watch-set file a task coming online still wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=task_online task=${fresh}`,
    `W12: the ask names the new task, not the baseline-online one (${JSON.stringify(w.out.trim())})`);
}

// W13: refusals — a missing database and a missing home dir both exit 2.
async function W13() {
  useRoots("w13");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const noDb = spawnWait(home, { db: path.join(mk("w13-nodb"), "missing.db") });
  check(await waitExit(noDb, 5000), "W13: a missing database refuses");
  check(noDb.code === 2 && /no database at/.test(noDb.err), `W13: the refusal names the missing database (exit ${noDb.code}: ${noDb.err.trim().slice(0, 120)})`);
  const noHome = spawnWait(path.join(mk("w13-nohome"), "gone"));
  check(await waitExit(noHome, 5000), "W13: a missing home dir refuses");
  check(noHome.code === 2 && /no such directory/.test(noHome.err), `W13: the refusal names the missing home dir (exit ${noHome.code}: ${noHome.err.trim().slice(0, 120)})`);
}

// W14: waitExit giving up on a world that cannot wake it kills the child — no orphan.
async function W14() {
  useRoots("w14");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home); // quiet world: nothing watched, nothing unknown, nothing can wake it
  const w = spawnWait(home);
  const armed = await settle(w);
  check(armed && !(await waitExit(w, 150)), "W14: a tiny budget gives up on a quiet world — the poll armed before the budget judged it");
  check(await closedWithin(w, 2000), "W14: the abandoned poll is killed shortly after the give-up");
}

// W15: a SIGTERM to the suite itself — the runner's pid-only kill — sweeps
// every tracked poll and removes the fixture root: the suite exits 143 (the
// runner's convention) leaving nothing behind.
async function W15() {
  const s = spawnSuite("W6");
  const poll = await findSuitePoll(s.child.pid, 15000);
  const root = poll ? suiteRootOf(poll) : null;
  try {
    check(Boolean(poll), `W15: the child suite's poll is discovered live (${(s.out + s.err).trim().slice(-80)})`);
    if (!poll) return;
    try { process.kill(s.child.pid, "SIGTERM"); } catch { /* already exiting */ }
    check(await suiteClosedWithin(s, 10000) && s.code === 143, `W15: the TERM'd suite exits 143 (${s.code}: ${s.err.trim().slice(0, 120)})`);
    check(await pidGoneWithin(poll.pid, 5000), "W15: the swept poll is gone");
    check(!fs.existsSync(root), "W15: the child's fixture root is removed");
  } finally {
    if (poll) { try { process.kill(poll.pid, "SIGKILL"); } catch { /* already gone */ } }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

// W16: a SIGKILL to the suite — no handler can run — the orphaned poll
// self-reaps on its own within one interval of the suite's death.
async function W16() {
  const s = spawnSuite("W6");
  const poll = await findSuitePoll(s.child.pid, 15000);
  const root = poll ? suiteRootOf(poll) : null;
  try {
    check(Boolean(poll), "W16: the child suite's poll is discovered live");
    if (!poll) return;
    // Orphan an armed poll: baseline done means its parent chain was
    // captured — a SIGKILL landing mid-boot instead orphans a poll that never
    // knew its parent, which cannot self-reap by design.
    await pollLooping(poll.pid, 10000);
    try { process.kill(s.child.pid, "SIGKILL"); } catch { /* already exiting */ }
    check(await suiteClosedWithin(s, 10000), `W16: the SIGKILLed suite closes (${s.code})`);
    check(await pidGoneWithin(poll.pid, 5000), "W16: the orphaned poll self-reaps after the suite's SIGKILL");
  } finally {
    if (poll) { try { process.kill(poll.pid, "SIGKILL"); } catch { /* already gone */ } }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

// W17: the direct self-reap, observable. An intermediate parent spawns the
// poll on a quiet world with the poll's stderr redirected to a file — the fd
// outlives the parent — and dies once the poll is booted (its first stderr
// line, written after the parent was captured). The poll must exit on its
// own and the file must carry the self-reap line: the exit contract the
// suite-kill variants cannot observe, at the exact direct-spawn shape of the
// pinned leak.
async function W17() {
  useRoots("w17");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home); // quiet world: nothing watched, nothing unknown, nothing can wake it
  const runDir = mk("w17-run");
  const errFile = path.join(runDir, "poll.err");
  const pidFile = path.join(runDir, "poll.pid");
  const script = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    `const err = fs.openSync(${JSON.stringify(errFile)}, 'w');`,
    `const child = spawn(process.execPath, ${JSON.stringify([ENGINE_WAIT, path.resolve(home), "--interval", "0.2"])}, { env: process.env, stdio: ['ignore', 'ignore', err] });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    `const boot = setInterval(() => { try { if (fs.readFileSync(${JSON.stringify(errFile)}, 'utf8').length > 0) { clearInterval(boot); process.exit(0); } } catch { /* not yet */ } }, 20);`,
    "setTimeout(() => process.exit(0), 3000);",
  ].join("\n");
  const mid = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  track(mid);
  let pollPid = 0;
  const bootDeadline = Date.now() + 5000;
  while (Date.now() < bootDeadline) {
    try { pollPid = Number(fs.readFileSync(pidFile, "utf8")); break; } catch { /* not yet */ }
    await sleepMs(50);
  }
  try {
    check(pollPid > 0, "W17: the intermediate spawns the poll and records its pid");
    if (pollPid > 0) {
      check(await pidGoneWithin(pollPid, 5000), "W17: the orphaned poll exits on its own within one interval");
      const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
      check(err.includes("engine-wait: parent gone, self-reaping"), `W17: the self-reap line lands on the poll's stderr (${err.trim().split("\n").slice(-1)[0].slice(0, 80)})`);
    }
  } finally {
    if (pollPid > 0) { try { process.kill(pollPid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

// W18: the fixture root is removed on every exit path — a child that runs
// green, and a child that dies on the catch path (the unknown-label throw).
async function W18() {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-engine-wait-")));
  const green = spawnSuite("W6");
  const poll = await findSuitePoll(green.child.pid, 15000);
  const root = poll ? suiteRootOf(poll) : null;
  try {
    check(Boolean(poll), "W18: the completing child's poll is discovered live");
    if (poll) {
      check(await suiteClosedWithin(green, 15000) && green.code === 0, `W18: the child runs W6 to green (${green.code})`);
      check(!fs.existsSync(root), "W18: a green child's fixture root is removed at exit");
    }
  } finally {
    if (poll) { try { process.kill(poll.pid, "SIGKILL"); } catch { /* already gone */ } }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }

  const bad = spawnSuite("NO-SUCH-SCENARIO");
  check(await suiteClosedWithin(bad, 15000) && bad.code === 1, `W18: an unknown ENGINE_WAIT_ONLY label exits 1 through the catch path (${bad.code}: ${bad.err.trim().slice(0, 120)})`);
  const freshOutside = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-engine-wait-") && !before.has(d) && oursRoot(path.join(os.tmpdir(), d)));
  const nestedResidue = fs.existsSync(childTmp) ? fs.readdirSync(childTmp).filter((d) => d.startsWith("agents-engine-wait-")) : [];
  check(freshOutside.length === 0, `W18: no child roots of this run outside the parent's tree (${freshOutside.join(", ")})`);
  check(nestedResidue.length === 0, `W18: the catch path cleans its nested root (${nestedResidue.join(", ")})`);
  for (const name of freshOutside) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  for (const name of nestedResidue) fs.rmSync(path.join(childTmp, name), { recursive: true, force: true });
}

// W19b (W19's child half): hold a grandchild suite live so W19 can interrupt
// this suite mid-child — the residual leak's exact shape. The marker carries
// this suite's root and the grandchild's pids/root, written only once the
// grandchild's poll is looping — armed, its parent chain captured, so the
// interrupt tests a self-reap that can actually fire (its root long since
// created). No marker (a full run): nothing to hold, a no-op.
async function W19b() {
  const marker = process.env.ENGINE_WAIT_HOLD_MARKER;
  if (!marker) return;
  const s = spawnSuite("W6,W2");
  const poll = await findSuitePoll(s.child.pid, 15000);
  if (poll && await pollLooping(poll.pid, 10000)) fs.writeFileSync(marker, JSON.stringify({
    root: T, grandchild: s.child.pid, poll: poll.pid, grandchildRoot: suiteRootOf(poll),
  }));
  try {
    await suiteClosedWithin(s, 30000);
  } finally {
    if (poll) { try { process.kill(poll.pid, "SIGKILL"); } catch { /* already gone */ } }
    try { s.child.kill("SIGKILL"); } catch { /* already gone */ }
    if (poll) fs.rmSync(suiteRootOf(poll), { recursive: true, force: true });
  }
}

// W19: the residual escape — a TERM to this suite's child while IT holds a
// grandchild suite live. The holder's belt runs, its sweep SIGKILLs the
// grandchild past the grandchild's belt, and the holder's exit skips W19b's
// finally: pre-fix the grandchild's root leaks in the real tmp. The leaked
// root is the red run's evidence — the finally spares exactly it, one dir,
// once, removed by hand after its shape is recorded.
async function W19() {
  const run = mk("w19");
  const marker = path.join(run, "hold.json");
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-engine-wait-")));
  const s = spawnSuite("W19b", { ENGINE_WAIT_HOLD_MARKER: marker });
  let hold = null;
  const holdDeadline = Date.now() + 20000;
  while (Date.now() < holdDeadline) {
    try { hold = JSON.parse(fs.readFileSync(marker, "utf8")); break; } catch { /* not yet */ }
    await sleepMs(50);
  }
  try {
    check(Boolean(hold), `W19: the child holds a live grandchild (${(s.out + s.err).trim().slice(-80)})`);
    if (!hold) return;
    let live = true;
    try { process.kill(hold.grandchild, 0); } catch { live = false; }
    check(live, "W19: the grandchild suite is live at the interrupt (the marker's precondition)");
    try { process.kill(s.child.pid, "SIGTERM"); } catch { /* already exiting */ }
    check(await suiteClosedWithin(s, 10000) && s.code === 143, `W19: the TERM'd suite exits 143 (${s.code})`);
    check(await pidGoneWithin(hold.poll, 5000), "W19: the grandchild's poll is gone (killed with its suite, self-reaping)");
    check(!fs.existsSync(hold.root), "W19: the holder's own fixture root is removed by its belt");
    check(!fs.existsSync(hold.grandchildRoot), "W19: the grandchild's root is removed — no child-suite root survives the interrupt");
    const residue = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-engine-wait-") && !before.has(d) && oursRoot(path.join(os.tmpdir(), d)));
    check(residue.length === 0, `W19: no fresh agents-engine-wait- dir of this run in the real tmp (${residue.join(", ")})`);
  } finally {
    if (hold) {
      for (const pid of [hold.grandchild, hold.poll]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      fs.rmSync(hold.root, { recursive: true, force: true });
      // deliberately NOT hold.grandchildRoot: pre-fix it is the red run's
      // evidence — one dir, once, removed by hand after its shape is recorded
    }
    try { s.child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// The registry in run order. The selector honors ENGINE_WAIT_ONLY — a single
// label or a comma list, how the kill-the-suite scenarios re-run this file as
// a child; unset runs every block in order; an unknown label throws, so the
// catch path is a real exit path.
const SCENARIOS = [
  ["W1", W1], ["W2", W2], ["W3", W3], ["W4", W4], ["W4b", W4b],
  ["W5", W5], ["W5b", W5b], ["W6", W6], ["W7", W7], ["W8", W8], ["W9", W9],
  ["W10", W10], ["W11", W11], ["W12", W12], ["W13", W13], ["W14", W14],
  ["W15", W15], ["W16", W16], ["W17", W17], ["W18", W18], ["W19b", W19b], ["W19", W19],
];

async function scenarios() {
  const only = process.env.ENGINE_WAIT_ONLY;
  const names = only && only.trim() ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (names) {
    const known = SCENARIOS.map(([label]) => label);
    for (const name of names) {
      if (!known.includes(name)) throw new Error(`unknown ENGINE_WAIT_ONLY label ${JSON.stringify(name)}; known: ${known.join(", ")}`);
    }
  }
  for (const [label, fn] of SCENARIOS) {
    if (!names || names.includes(label)) await fn();
  }
}

scenarios().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0); // the exit handler runs the teardown sweep
  },
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1); // ditto
  }
);
