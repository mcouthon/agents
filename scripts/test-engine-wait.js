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
const children = [];
const procFile = path.join(T, "procs", "claude");
fs.writeFileSync(procFile, '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
function spawnClaude() {
  const child = spawn(procFile, ["60"], { stdio: "ignore", detached: true });
  children.push(child);
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
}

// The poll child: stdout/stderr captured, `closed` set by the close event (all
// streams flushed), stillRunning/waitExit poll it synchronously.
function spawnWait(homeDir, { interval = "0.2", snapshot, own = "cccc0001-0000-4000-8000-000000000001", db } = {}) {
  const env = { ...process.env };
  if (own) env.CLAUDE_CODE_SESSION_ID = own; else delete env.CLAUDE_CODE_SESSION_ID;
  if (snapshot) env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS = snapshot; else delete env.ENGINE_WAIT_SNAPSHOT_INTERVAL_SECS;
  if (db) env.AGENTS_DB = db;
  const child = spawn(process.execPath, [ENGINE_WAIT, path.resolve(homeDir), "--interval", interval], { env, stdio: ["ignore", "pipe", "pipe"] });
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
// one baseline's worth: the child has derived the world by now
const settle = () => sleepMs(1200);

// ---------------------------------------------------------------- suites

async function scenarios() {

// W1: a decide on a watched task, by another session — the wake carries the id, never the quote.
{
  useRoots("w1");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle();
  const decisionId = decideRow(alpha, "aaaa0009-0000-4000-8000-000000000009");
  check(await waitExit(w, 4000), `W1: the poll exits on a watched decide (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=decide decision_id=${decisionId} task=${alpha}`,
    `W1: the wake line is the decide id and the task dir (${JSON.stringify(w.out.trim())})`);
  check(!w.out.includes("the owner's words"), "W1: no quote text anywhere in the output");
}

// W2: the own session's decide and the home task's decide never wake the poll.
{
  useRoots("w2");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const own = "cccc0002-0000-4000-8000-000000000002";
  const w = spawnWait(home, { own });
  await settle();
  decideRow(alpha, own);
  db.appendEvent({ kind: "note", taskId: db.taskIdOf(home), sessionId: "aaaa0002", detail: JSON.stringify({ phase_id: null }) });
  decideRow(home, "aaaa0002-0000-4000-8000-000000000002");
  check(await stillRunning(w, 2500), `W2: neither the own decide nor the home task's rows wake it (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W3: an unwatched task's event never wakes (a dir under both headings reads unwatched), nor does an unknown task's.
{
  useRoots("w3");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  const charlie = mkTask(key, "charlie", "Charlie");
  watchSet(home, { watched: [alpha, bravo], unwatched: [bravo] });
  const w = spawnWait(home);
  await settle();
  decideRow(bravo, "aaaa0003-0000-4000-8000-000000000003");
  decideRow(charlie, "aaaa0003-0000-4000-8000-000000000004");
  check(await stillRunning(w, 2500), `W3: an unwatched (under both headings) and an unknown task's decides wake nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W4: a watched task's session going needs_input wakes; a child session's does not.
{
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
  await settle();
  session.recordSignal(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw4"), { message: "waiting", kind: "idle_prompt" });
  check(await waitExit(w, 4000), `W4: the poll exits on a watched session lighting needs_input (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=needs_input session=${SID} task=${alpha}`,
    `W4: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
}
{
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
  await settle();
  // the nested branch registers the child under <sessions>/<child id>, not the terminal id
  session.recordSignal(path.join(process.env.AGENTS_SESSIONS_ROOT, CHILD), { message: "waiting", kind: "permission_prompt" });
  check(await stillRunning(w, 2500), `W4b: a child registration lighting needs_input wakes nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W5: a watched task's session ending wakes; a dispatch-origin session's end does not.
{
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
  await settle();
  session.markEnded(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw5"));
  check(await waitExit(w, 4000), `W5: the poll exits on a watched session ending (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=session_end session=${SID} task=${alpha}`,
    `W5: the wake line is the session id and the task dir (${JSON.stringify(w.out.trim())})`);
}
{
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
  await settle();
  session.markEnded(path.join(process.env.AGENTS_SESSIONS_ROOT, "tw5b"));
  check(await stillRunning(w, 2500), `W5b: a dispatch-origin session ending wakes nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W6: a plan file appears with no event — the snapshot interval catches the advice flip.
{
  useRoots("w6");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home, { snapshot: "0.5" });
  await settle();
  fs.mkdirSync(path.join(alpha, "plan"));
  fs.writeFileSync(path.join(alpha, "plan", "phase-1-build.md"), "# the plan\n");
  check(await waitExit(w, 5000), `W6: the snapshot interval catches the plan file with no event (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  // The to-word is the engine's own commit-instant semantics; the wake's shape is the contract here.
  check(w.code === 0 && new RegExp(`^wake=advice from=plan to=\\w+ task=${alpha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(w.out.trim()),
    `W6: the wake line is the advice move change from plan (${JSON.stringify(w.out.trim())})`);
}

// W7: a task with no watch-set entry comes online — the ask.
{
  useRoots("w7");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const unknown = mkTask(key, "delta", "Delta");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle();
  const SID = "aaaa0007-0000-4000-8000-000000000007";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw7", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: unknown, repo_key: key.key });
  check(await waitExit(w, 4000), `W7: an unknown task coming online wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=task_online task=${unknown}`,
    `W7: the wake line is the task dir (${JSON.stringify(w.out.trim())})`);
}

// W8: an unwatched task relaunching stays silent — the standing no.
{
  useRoots("w8");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const bravo = mkTask(key, "bravo", "Bravo");
  watchSet(home, { watched: [alpha], unwatched: [bravo] });
  const w = spawnWait(home);
  await settle();
  const SID = "aaaa0008-0000-4000-8000-000000000008";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw8", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: bravo, repo_key: key.key });
  check(await stillRunning(w, 2500), `W8: a declined task relaunching wakes nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W9: a watched task gaining a new session wakes nothing task_online-shaped — its facts carry the signal.
{
  useRoots("w9");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle();
  const SID = "aaaa0009-0000-4000-8000-000000000009";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw9", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: alpha, repo_key: key.key });
  check(await stillRunning(w, 2500), `W9: a watched task's new session wakes nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W10: a dispatch-origin session on an unknown task is not a coming-online.
{
  useRoots("w10");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  const unknown = mkTask(key, "echo", "Echo");
  watchSet(home, { watched: [alpha] });
  const w = spawnWait(home);
  await settle();
  const SID = "aaaa0010-0000-4000-8000-000000000010";
  setZmx([zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw10", origin: "dispatch", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: unknown, repo_key: key.key });
  check(await stillRunning(w, 2500), `W10: a dispatch session on an unknown task wakes nothing (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W11: the home task's own session (the coordinator's) is never asked.
{
  useRoots("w11");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const home = mkTask(key, "home", "Home");
  const alpha = mkTask(key, "alpha", "Alpha");
  watchSet(home, { watched: [alpha] });
  const own = "cccc0011-0000-4000-8000-000000000011";
  const w = spawnWait(home, { own });
  await settle();
  setZmx([zl(`Coordinator-${own.slice(0, 8)}`)]);
  register({ session_id: own, terminal_id: "tw11", agent: "coordinator", mux: { kind: "zmx", name: `Coordinator-${own.slice(0, 8)}` }, task_dir: home, repo_key: key.key });
  check(await stillRunning(w, 2500), `W11: the home task's session is never asked (${w.out.trim() || w.err.trim().slice(0, 120)})`);
  await killWait(w);
}

// W12: a missing watch-set file means every task is unknown — the ask still fires for a task coming online.
{
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
  await settle();
  const SID = "bbbb0012-0000-4000-8000-000000000012";
  setZmx([zl(`Conductor-${SID_BASE.slice(0, 8)}`), zl(`Conductor-${SID.slice(0, 8)}`)]);
  register({ session_id: SID, terminal_id: "tw12f", mux: { kind: "zmx", name: `Conductor-${SID.slice(0, 8)}` }, task_dir: fresh, repo_key: key.key });
  check(await waitExit(w, 4000), `W12: with no watch-set file a task coming online still wakes the ask (${w.code}: ${w.out.trim() || w.err.trim().slice(0, 160)})`);
  check(w.code === 0 && w.out.trim() === `wake=task_online task=${fresh}`,
    `W12: the ask names the new task, not the baseline-online one (${JSON.stringify(w.out.trim())})`);
}

// W13: refusals — a missing database and a missing home dir both exit 2.
{
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

}

scenarios().then(
  () => {
    for (const c of children) { try { process.kill(-c.pid); } catch { /* already gone */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  },
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
);
