#!/usr/bin/env node
"use strict";
// engine-wait: the coordinator's poll — wakes on watched tasks' engine facts and
// on unknown tasks coming online, never on the home task, the own session,
// unwatched tasks or message text, and under --external also on a configured
// generic wake source (a stub script, never anything product-shaped). Driven
// end to end: the script runs as a child against isolated roots with a stub
// zmx, the world changes through the lib between polls. Isolation: nothing
// here may touch the real HOME, config, git config, zmx, sessions or database;
// the external scenarios go further — every spawn gets a fresh config file,
// so the shared cfg.json never carries a wake command.

// One whole slow family: the coordinator's poll. Its walls are load-shaped
// waits, so the suite runs only behind the timing gate — without
// AGENTS_TEST_TIMING=1 it is a no-op pass line in the battery.
if (process.env.AGENTS_TEST_TIMING !== "1") {
  console.log("engine-wait: whole suite gated (AGENTS_TEST_TIMING unset) — AGENTS_TEST_TIMING=1 zsh scripts/check.sh engine-wait");
  process.exit(0);
}

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
const world = require("./fixture-world");

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

// A generic fake external wake source — never anything product-shaped. Its
// modes are the real source's shapes: print-then-exit, banner-lines-before-
// payload, a long block, and a stateful run that crashes, exits empty, then
// prints (the long-poll timeout's re-arm path).
const WAKE_STUB = path.join(T, "stubs", "wake-stub.sh");
fs.mkdirSync(path.dirname(WAKE_STUB));
fs.writeFileSync(WAKE_STUB, [
  "#!/bin/sh",
  "case $1 in",
  '  print) sleep "$2"; echo "$3"; exit 0 ;;',
  '  banner) echo stub-banner-line; sleep "$2"; echo "$3"; exit 0 ;;',
  "  block) sleep 600 ;;",
  "  stateful)",
  '    d=$2; n=$(cat "$d/n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/n"',
  '    [ "$n" -eq 1 ] && echo stub-run-1-own-stderr >&2 && exit 1',
  '    [ "$n" -eq 2 ] && exit 0',
  "    echo stub-third-line; exit 0 ;;",
  "esac",
  "exit 64",
].join("\n"), { mode: 0o755 });
// The stub tree runs under this run's ps as a child of the poll, unreachable
// through the spawned registry once the poll is SIGKILLed — the suite's own
// pid-only-kill lesson — so the external scenarios and the teardown sweep by
// command-match on the stub path. The poll's own leash processes are not
// matched: they self-sweep and exit once their (killed) poll is gone.
function stubPids() {
  const pids = [];
  for (const line of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
    if (!line.includes(WAKE_STUB)) continue;
    const m = /^\s*(\d+)/.exec(line);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}
function killStrayStubs() {
  for (const pid of stubPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}
async function stubsGoneWithin(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (stubPids().length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(50);
  }
}
async function fileGoneWithin(p, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!fs.existsSync(p)) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(50);
  }
}
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
  killStrayStubs();
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
  return world.cloneRepo(T, "acme", path.join(mk("repo"), "acme"), "https://github.com/acme/acme.git");
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
// streams flushed), stillRunning/waitExit poll it synchronously. `external`
// arms the flag with a per-spawn config carrying that wake command ("" = the
// unconfigured-flagged shape); `configuredWake` writes the same per-spawn
// config but no flag — the config-without-the-flag scenarios.
function spawnWait(homeDir, { interval = "0.2", snapshot, own = "cccc0001-0000-4000-8000-000000000001", db, external, configuredWake } = {}) {
  const env = { ...process.env };
  if (own) env.CLAUDE_CODE_SESSION_ID = own; else delete env.CLAUDE_CODE_SESSION_ID;
  if (snapshot) env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS = snapshot; else delete env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS;
  if (db) env.AGENTS_DB = db;
  const wake = external !== undefined ? external : configuredWake;
  if (wake !== undefined) {
    const cfgPath = path.join(mk("wake-cfg"), "cfg.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ engine_wait: { external_wake: wake || null } }));
    env.AGENTS_CONFIG_PATH = cfgPath;
  }
  const args = [ENGINE_WAIT, path.resolve(homeDir), "--interval", interval];
  if (external !== undefined) args.push("--external");
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
// The negative-window budget: every armed poll loops at --interval 0.2, so a
// held window is proof counted in whole poll cycles — the 1200/600/500 ms
// windows below hold six/three/~two cycles per "prove nothing happens"
// scenario, and silence through them is the same proof the old 2500/1000/800
// held, at a quarter of the wait. Every other observation budget in this file
// (waitExit's wake waits, settle's arming watch, the gone/within sweeps) is
// 3x the quiet need: these are upper bounds that return the moment the event
// lands, so a quiet run pays nothing and a twin-battery storm — where a spawn
// can outlast 7 s — cannot false-fail a wake that did happen.
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
// act is a synchronous /bin/sleep child, and while the poll is alive in its
// loop nothing else in its closure spawns one — the sweep's spin sleeps
// (/bin/sleep 0.02) live only in the exit window, after the loop has ended —
// so a sleep child of a looping poll's pid is positive proof (ps, the
// findSuitePoll pattern). A miss only delays; against a looping poll a
// false positive cannot happen.
async function pollLooping(pid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[2]) === pid && /^\/bin\/sleep\b/.test(m[3].trim())) return true;
    }
    if (Date.now() >= deadline) return false;
    // The 100 ms scan step is observation cost only: it delays the sighting of
    // an already-armed poll by at most one step and saves most of the ps
    // spawns the old 40 ms cadence paid per settle.
    await sleepMs(100);
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
async function settle(w, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!w.closed && Date.now() < deadline) {
    if (await pollLooping(w.child.pid, 400)) return true;
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
  check(await waitExit(w, 12000), `W1: the poll exits on a watched decide (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
    `W1: the wake line is the decide id and the task dir (${JSON.stringify(w.out.trim())})`);
  check(!w.out.includes("the owner's words"), "W1: no quote text anywhere in the output");
}

// WX1: the decide-class window — every decide the poll must sit out (the own
// session's on a watched task, an unwatched task's — a dir under both
// headings reads unwatched — and an unknown task's) lands inside one armed
// window. Silence through the set is silence through each member: every
// member change landed while the poll was armed and is followed by the same
// 1200 ms of armed quiet the old per-member windows held (W2/W3), so a
// regression in any one member's exclusion still breaks the window.
async function WX1() {
  useRoots("wx1");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  const charlie = mkTask(key, "charlie", "Charlie");
  watchSet(home, { watched: [alpha, bravo], unwatched: [bravo] });
  const own = "cccc0002-0000-4000-8000-000000000002";
  const w = spawnWait(home, { own });
  const armed = await settle(w);
  decideRow(alpha, own);
  decideRow(bravo, "aaaa0003-0000-4000-8000-000000000003");
  decideRow(charlie, "aaaa0003-0000-4000-8000-000000000004");
  check(armed && await stillRunning(w, 1200), `WX1: the own session's, the unwatched task's and the unknown task's decides all land inside one armed window and none wakes it (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// WX2: the session-class window — every session lifecycle the poll must sit
// out (a watched task's new session, a dispatch session on an unknown task, a
// declined task relaunching, a child registration lighting needs_input, a
// dispatch-origin session ending) lands inside one armed window; silence
// through the set is silence through each member (the old W4b/W5b/W8/W9/W10
// windows, one world instead of five).
async function WX2() {
  useRoots("wx2");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  const echo = mkTask(key, "echo", "Echo");
  watchSet(home, { watched: [alpha], unwatched: [bravo] });
  // pre-arm setup: a live claude parent holding the pointer (W4b's shape), and
  // a live dispatch-origin session on the watched task whose end is a member.
  const claude = spawnClaude();
  const PARENT = "aaaa0014-0000-4000-8000-000000000014";
  const CHILD = "bbbb0014-0000-4000-8000-000000000014";
  register({ session_id: PARENT, terminal_id: "twx2p", pid: claude.pid, pid_at: new Date().toISOString(), task_dir: alpha, repo_key: key.key });
  const END = "aaaa0025-0000-4000-8000-000000000025";
  setZmx([zl(`Conductor-${END.slice(0, 8)}`)]);
  register({ session_id: END, terminal_id: "twx2e", origin: "dispatch", mux: { kind: "zmx", name: `Conductor-${END.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  const w = spawnWait(home);
  const armed = await settle(w);
  // member: a watched task's new session — its facts carry the signal (W9)
  const S9 = "aaaa0009-0000-4000-8000-000000000009";
  setZmx([zl(`Conductor-${END.slice(0, 8)}`), zl(`Conductor-${S9.slice(0, 8)}`)]);
  register({ session_id: S9, terminal_id: "twx2a", mux: { kind: "zmx", name: `Conductor-${S9.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  // member: a dispatch-origin session on an unknown task (W10)
  const S10 = "aaaa0010-0000-4000-8000-000000000010";
  setZmx([zl(`Conductor-${END.slice(0, 8)}`), zl(`Conductor-${S9.slice(0, 8)}`), zl(`Conductor-${S10.slice(0, 8)}`)]);
  register({ session_id: S10, terminal_id: "twx2b", origin: "dispatch", mux: { kind: "zmx", name: `Conductor-${S10.slice(0, 8)}` }, task_dir: echo, repo_key: key.key });
  // member: a declined task relaunching (W8)
  const S8 = "aaaa0008-0000-4000-8000-000000000008";
  setZmx([zl(`Conductor-${END.slice(0, 8)}`), zl(`Conductor-${S9.slice(0, 8)}`), zl(`Conductor-${S10.slice(0, 8)}`), zl(`Conductor-${S8.slice(0, 8)}`)]);
  register({ session_id: S8, terminal_id: "twx2c", mux: { kind: "zmx", name: `Conductor-${S8.slice(0, 8)}` }, task_dir: bravo, repo_key: key.key });
  // member: a child registration lighting needs_input (W4b) — the nested
  // branch registers the child under <sessions>/<child id>, not the terminal id
  const savedDir = process.env.AGENTS_SESSION_DIR;
  try {
    process.env.AGENTS_SESSION_DIR = path.join(process.env.AGENTS_SESSIONS_ROOT, "twx2p");
    setZmx([zl(`Conductor-${END.slice(0, 8)}`), zl(`Conductor-${S9.slice(0, 8)}`), zl(`Conductor-${S10.slice(0, 8)}`), zl(`Conductor-${S8.slice(0, 8)}`), zl(`Conductor-${CHILD.slice(0, 8)}`)]);
    register({ session_id: CHILD, terminal_id: "twx2ch", mux: { kind: "zmx", name: `Conductor-${CHILD.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  } finally {
    // restoring `undefined` would store the literal string and poison every later register
    if (savedDir === undefined) delete process.env.AGENTS_SESSION_DIR;
    else process.env.AGENTS_SESSION_DIR = savedDir;
  }
  session.recordSignal(path.join(process.env.AGENTS_SESSIONS_ROOT, CHILD), { message: "waiting", kind: "permission_prompt" });
  // member: a dispatch-origin session ending (W5b)
  session.markEnded(path.join(process.env.AGENTS_SESSIONS_ROOT, "twx2e"));
  check(armed && await stillRunning(w, 1200), `WX2: a watched task's new session, a dispatch session on an unknown task, a declined relaunch, a child needs_input and a dispatch session's end all land inside one armed window and none wakes it (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// WX3: the home-task window — the home task's own session registering (the
// coordinator's, W11) and its rows (a note event and a decide, W2's home half)
// land inside one armed window; silence through the set is silence through
// each member.
async function WX3() {
  useRoots("wx3");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const own = "cccc0011-0000-4000-8000-000000000011";
  const w = spawnWait(home, { own });
  const armed = await settle(w);
  setZmx([zl(`Coordinator-${own.slice(0, 8)}`)]);
  register({ session_id: own, terminal_id: "twx3", agent: "coordinator", mux: { kind: "zmx", name: `Coordinator-${own.slice(0, 8)}` }, task_dir: home, repo_key: key.key });
  db.appendEvent({ kind: "note", taskId: db.taskIdOf(home), sessionId: "aaaa0002", detail: JSON.stringify({ phase_id: null }) });
  decideRow(home, "aaaa0002-0000-4000-8000-000000000002");
  check(armed && await stillRunning(w, 1200), `WX3: the home task's own session, its note and its decide all land inside one armed window and none wakes it (${w.out.trim() || w.err.trim().slice(0, 120)})`);
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
  check(await waitExit(w, 12000), `W4: the poll exits on a watched session lighting needs_input (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=needs_input session=${SID} task=${alpha}`,
    `W4: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
}

// W4b (a child registration's needs_input) and W5b (a dispatch session ending):
// the W4/W5 blocks' negative halves — now WX2 members.

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
  check(await waitExit(w, 12000), `W5: the poll exits on a watched session ending (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=session_end session=${SID} task=${alpha}`,
    `W5: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
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
  check(await waitExit(w, 15000), `W6: the snapshot interval catches the plan file with no event (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
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
  check(await waitExit(w, 12000), `W7: an unknown task coming online wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=task_online task=${unknown}`,
    `W7: the wake line is the task dir (${JSON.stringify(w.out.trim())})`);
}

// W8 (an unwatched relaunch), W9 (a watched task's new session), W10 (a
// dispatch session on an unknown task) and W11 (the home task's own session):
// now WX2/WX3 members.

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
  check(await waitExit(w, 12000), `W12: with no watch-set file a task coming online still wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
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
  check(await waitExit(noDb, 15000), "W13: a missing database refuses");
  check(noDb.code === 2 && /no database at/.test(noDb.err), `W13: the refusal names the missing database (exit ${noDb.code}: ${noDb.err.trim().slice(0, 120)})`);
  const noHome = spawnWait(path.join(mk("w13-nohome"), "gone"));
  check(await waitExit(noHome, 15000), "W13: a missing home dir refuses");
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
  check(await closedWithin(w, 6000), "W14: the abandoned poll is killed shortly after the give-up");
}

// W15 (a plain TERM to the suite) and W16 (a plain SIGKILL): the weaker
// instances of the pair — W19 holds the TERM shape at its richest (a
// grandchild suite live under the TERM'd child) and W17 the orphaned poll's
// self-reap, observed directly at the exact direct-spawn shape of the
// pinned leak.

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
      check(await pidGoneWithin(pollPid, 15000), "W17: the orphaned poll exits on its own within one interval");
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
  // Discovery and close budgets sit at 30 s: a child's boot + repo clone +
  // watch-set build can outgrow 15 s under a loaded machine (observed at
  // 1-min load ~14-20), and a green child still running at the residue scan
  // below reads as leaked root. These are observation bounds only — discovery
  // returns on first sighting, so a quiet run pays nothing.
  const poll = await findSuitePoll(green.child.pid, 30000);
  const root = poll ? suiteRootOf(poll) : null;
  try {
    check(Boolean(poll), "W18: the completing child's poll is discovered live");
    if (poll) {
      check(await suiteClosedWithin(green, 30000) && green.code === 0, `W18: the child runs W6 to green (${green.code})`);
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
  const s = spawnSuite("W6,WX2");
  const poll = await findSuitePoll(s.child.pid, 30000);
  if (poll && await pollLooping(poll.pid, 30000)) fs.writeFileSync(marker, JSON.stringify({
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
  // The marker wait sits at 40 s: under load the grandchild's boot + W6 setup
  // can outgrow the discovery budget's old share of it (observed at 1-min
  // load ~14-20), and a marker that lands late must still be read.
  const holdDeadline = Date.now() + 40000;
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
    check(await pidGoneWithin(hold.poll, 15000), "W19: the grandchild's poll is gone (killed with its suite, self-reaping)");
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

// W20: the external wake — a configured generic stub prints and exits on a
// quiet engine, and the poll wakes on it alone, carrying the stub's line.
async function W20() {
  useRoots("w20");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home); // quiet world: no engine event can wake it
  const w = spawnWait(home, { external: `${WAKE_STUB} print 1 owner-reply` });
  try {
    check(await waitExit(w, 18000), `W20: the external source alone wakes the poll (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === "wake=external owner-reply",
      `W20: the wake line carries the stub's printed line (${JSON.stringify(w.out.trim())})`);
    check(await stubsGoneWithin(6000), "W20: the stub is swept on the wake exit");
    check(await fileGoneWithin(path.join(home, ".external-wake.out"), 6000), "W20: the output file is unlinked on the wake exit");
  } finally { killStrayStubs(); }
}

// W21: --external with nothing configured — a warn, never a refusal: the
// engine watch must not die because the away-channel source is missing.
async function W21() {
  useRoots("w21");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { external: "" });
  try {
    await settle(w);
    // No stillRunning row: the poll's survival through the unconfigured arm
    // is re-proven by the wake below — a poll that had exited or died could
    // not wake on the decide. The warn row reads stderr after the exit: the
    // stream is complete at close, so no boot-race buffers it.
    const decisionId = decideRow(alpha, "aaaa0021-0000-4000-8000-000000000021");
    check(await waitExit(w, 12000), `W21: the engine path still wakes on a watched decide (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
      `W21: the decide wake line is exactly today's shape (${JSON.stringify(w.out.trim())})`);
    check(/external source asked for; none configured in/.test(w.err), `W21: the warn names the missing source (${w.err.trim().split("\n").slice(-1)[0].slice(0, 80)})`);
  } finally { killStrayStubs(); }
}

// W22: the flag is the on/off — a configured source without --external is
// never even spawned.
async function W22() {
  useRoots("w22");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { configuredWake: `${WAKE_STUB} print 1 owner-reply` });
  try {
    const armed = await settle(w);
    check(armed && stubPids().length === 0, "W22: the configured source is never spawned without the flag");
    check(await stillRunning(w, 600), "W22: the poll keeps looping with the source unflagged");
    const decisionId = decideRow(alpha, "aaaa0022-0000-4000-8000-000000000022");
    check(await waitExit(w, 12000), `W22: an unflagged poll wakes on the engine path as today (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
      `W22: the wake line is the plain decide (${JSON.stringify(w.out.trim())})`);
  } finally { killStrayStubs(); }
}

// W23: the engine wake wins while the external child blocks — the exit sweeps
// the child's group and unlinks the output file.
async function W23() {
  useRoots("w23");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { external: `${WAKE_STUB} block` });
  try {
    await settle(w);
    const decisionId = decideRow(alpha, "aaaa0023-0000-4000-8000-000000000023");
    check(await waitExit(w, 12000), `W23: the engine wake fires while the source blocks (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
      `W23: the wake line is the decide alone — no external line (${JSON.stringify(w.out.trim())})`);
    check(await stubsGoneWithin(6000), "W23: the blocking source is swept on the engine wake");
    check(await fileGoneWithin(path.join(home, ".external-wake.out"), 6000), "W23: the output file is unlinked on the engine wake");
  } finally { killStrayStubs(); }
}

// W24: a crashing and an empty-exiting source both re-arm — the long-poll
// timeout's normal shape — until the third run prints and the wake carries it.
async function W24() {
  useRoots("w24");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home);
  const state = mk("w24-state");
  const w = spawnWait(home, { external: `${WAKE_STUB} stateful ${state}` });
  try {
    await settle(w);
    // No stillRunning row: surviving the crashing and empty exits IS the
    // re-arm, and the n=3 row below proves both re-arms happened.
    check(await waitExit(w, 24000), `W24: the third run's line wakes the poll (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === "wake=external stub-third-line",
      `W24: the wake line is the third run's printed line (${JSON.stringify(w.out.trim())})`);
    check(fs.readFileSync(path.join(state, "n"), "utf8").trim() === "3", "W24: all three stub runs happened (two re-arms)");
    check(w.err.includes("stub-run-1-own-stderr"), "W24: the crashing run's own stderr stays visible (inherited)");
  } finally { killStrayStubs(); }
}

// W25: a TERM'd poll leaves nothing behind — the leash sweeps the child's
// group and the file. No JS signal listener can run inside the synchronous
// loop (registering one swallows TERM outright), so the poll dies to the
// signal at once, as it always has, and the leash does the sweeping.
async function W25() {
  useRoots("w25");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home);
  const w = spawnWait(home, { external: `${WAKE_STUB} block` });
  try {
    const armed = await settle(w);
    check(armed && stubPids().length > 0, `W25: the armed poll holds a live source (${stubPids().length} stub procs)`);
    try { w.child.kill("SIGTERM"); } catch { /* already exiting */ }
    check((await closedWithin(w, 9000)) && w.code === null, `W25: the TERM'd poll exits at once by the signal, not swallowed into 143 (${w.code})`);
    check(await stubsGoneWithin(9000), "W25: the leash TERMs the source's group after the poll's death");
    check(await fileGoneWithin(path.join(home, ".external-wake.out"), 9000), "W25: the leash unlinks the output file after the poll's death");
  } finally { killStrayStubs(); }
}

// W26: both sources in one tick — the stub dies inside the arm's first
// interval and the decide lands before the first tick's reads, so one exit
// carries both lines, external first. The first tick is the only tick the
// poll ever takes: settle observes its sleep child, which spans the whole
// window the decide lands in.
async function W26() {
  useRoots("w26");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { interval: "1", external: `${WAKE_STUB} print 0.3 merged-payload` });
  try {
    await settle(w);
    const decisionId = decideRow(alpha, "aaaa0026-0000-4000-8000-000000000026");
    check(await waitExit(w, 18000), `W26: one exit carries both sources (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === `wake=external merged-payload\nwake=decide decision_id=${decisionId} task=${alpha}`,
      `W26: the external line is first, the engine line second (${JSON.stringify(w.out.trim())})`);
    check(await stubsGoneWithin(6000), "W26: the source is swept with the wake");
  } finally { killStrayStubs(); }
}

// W27: the payload is the child's LAST non-empty stdout line — real sources
// print banner lines before their payload. A banner that lands whole ticks
// before the payload neither wakes the poll nor becomes the payload.
async function W27() {
  useRoots("w27");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home);
  const w = spawnWait(home, { external: `${WAKE_STUB} banner 1 stub-payload-line` });
  try {
    check(await waitExit(w, 24000), `W27: the bannered source wakes the poll on its exit (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
    check(w.code === 0 && w.out.trim() === "wake=external stub-payload-line",
      `W27: the payload is the last non-empty line, not the banner (${JSON.stringify(w.out.trim())})`);
  } finally { killStrayStubs(); }
}

// W28: a KILL'd poll — no handler anywhere can run, not even a shell's —
// still leaves nothing behind: the leash owns this sweep alone. Between the
// KILL and this suite's reap the poll is a zombie that still answers kill -0,
// which is why the leash's watch pairs the probe with ps stat — the Z counts
// as dead — and the sweep fires: the source's group TERMed then KILLed, the
// output file unlinked.
async function W28() {
  useRoots("w28");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  watchSet(home);
  const w = spawnWait(home, { external: `${WAKE_STUB} block` });
  try {
    const armed = await settle(w);
    const heldLive = armed && stubPids().length > 0;
    try { w.child.kill("SIGKILL"); } catch { /* already exiting */ }
    check(heldLive && await stubsGoneWithin(9000) && await fileGoneWithin(path.join(home, ".external-wake.out"), 9000),
      `W28: the leash sweeps the KILL'd poll's source group and file (${stubPids().length} stub procs left)`);
  } finally { killStrayStubs(); }
}

// The registry in run order. The selector honors ENGINE_WAIT_ONLY — a single
// label or a comma list, how the kill-the-suite scenarios re-run this file as
// a child; unset runs every block in order; an unknown label throws, so the
// catch path is a real exit path.
const SCENARIOS = [
  ["W1", W1], ["WX1", WX1], ["WX2", WX2], ["WX3", WX3], ["W4", W4],
  ["W5", W5], ["W6", W6], ["W7", W7],
  ["W12", W12], ["W13", W13], ["W14", W14],
  ["W17", W17], ["W18", W18], ["W19b", W19b], ["W19", W19],
  ["W20", W20], ["W21", W21], ["W22", W22], ["W23", W23], ["W24", W24],
  ["W25", W25], ["W26", W26], ["W27", W27], ["W28", W28],
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
