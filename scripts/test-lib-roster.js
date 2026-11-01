#!/usr/bin/env node
"use strict";
// `a ls`: the roster of active tasks with their live sessions, through the CLI,
// from the database's rows. Isolation: nothing here may touch the real HOME,
// config, git config, zmx or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-roster-")));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs", "bin"]) fs.mkdirSync(path.join(t, d));
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
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION"]) delete process.env[k];
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

const A = path.join(__dirname, "bin", "a");
const T = process.env.AGENTS_TEST_TMP;
let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

const ROSTER_KEYS = ["advice", "approvals", "attention", "branch", "current_phase", "dir", "landing", "live", "main_root",
  "migrated", "mode", "number", "phases_checked", "phases_total", "repo_key", "resumable", "slug", "task_status", "tier", "title", "updated", "worktree"];
const SESSION_KEYS = ["agent", "cwd", "main_root", "mux", "origin", "parent_session_id", "pid", "repo_key", "session_id", "session_state", "task_dir", "task_number", "task_status"];

// A zmx that prints the fixture in $ZMX_LIST_FILE for `list` and logs nothing else.
const stubBin = mk("stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"),
  '#!/bin/sh\ncase "$1" in\n  --version) echo "zmx 0.8.1" ;;\n  list) cat "$ZMX_LIST_FILE" ;;\nesac\n', { mode: 0o755 });
const zmxFile = path.join(T, "zmx-list.txt");
function setZmx(lines) { fs.writeFileSync(zmxFile, lines.map((l) => l + "\n").join("")); }
setZmx([]);

// A process whose command line contains "claude" (a copy of /bin/sleep would be
// killed on arm64 macOS, so it is a shell script), and one that does not.
const procDir = mk("procs");
fs.writeFileSync(path.join(procDir, "claude"), '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
const children = [];
function spawnProc(file, marker) {
  const child = spawn(file, ["60"], { stdio: "ignore", detached: true });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    if (cmd.includes(marker)) break;
    execFileSync("/bin/sleep", ["0.02"]);
  }
  return child;
}
function spawnClaude() { return spawnProc(path.join(procDir, "claude"), "claude"); }
function spawnNonClaude() { return spawnProc("/bin/sleep", "sleep 60"); }

function cli(args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [A, ...args], {
    encoding: "utf8", cwd: cwd || T, timeout: 60000,
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, ZMX_LIST_FILE: zmxFile, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function json(args, opts) { const r = cli([...args, "--json"], opts); return { ...r, data: r.out ? JSON.parse(r.out) : null }; }

function makeRepo(name = "acme") {
  const dir = path.join(mk("repo"), name);
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", `https://github.com/acme/${name}.git`);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

// Point every root at fresh dirs.
function useRoots(label) {
  const root = mk(label);
  process.env.AGENTS_TASKS_ROOT = path.join(root, "tasks");
  process.env.AGENTS_SESSIONS_ROOT = path.join(root, "sessions");
  process.env.AGENTS_DB = path.join(root, "agents.db");
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  db.open({ create: true });
}

/** A task with one phase; `done` checks it; `asks` adds a plan so the advice asks for approval. */
function mkTask(key, slug, title, { done = false, asks = false, ageDays } = {}) {
  const created = taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" });
  const taskId = db.taskIdOf(created.task_dir);
  if (asks) {
    db.setTaskKnob(taskId, "approvals", "ask");
    fs.mkdirSync(path.join(created.task_dir, "plan"), { recursive: true });
    fs.writeFileSync(path.join(created.task_dir, "plan", "phase-1-build.md"), "# plan\n");
  }
  if (done) {
    db.setTaskKnob(taskId, "approvals", "ask");
    taskLib.checkPhase({ taskDir: created.task_dir, phaseId: 1 });
    const head = execFileSync("git", ["-C", key.main_root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    db.appendEvent({ kind: "land", taskId, detail: JSON.stringify({ head, migrated: true }) });
  }
  if (Number.isFinite(ageDays)) {
    const at = new Date(Date.now() - ageDays * 86400000).toISOString();
    const conn = db.open();
    conn.run("UPDATE events SET at = ? WHERE task_id = ?", at, taskId);
  }
  return created.task_dir;
}

function archive(key, dirName, dir) {
  db.setTaskDisposition({ repoKey: key.key, dirName, disposition: "archived" });
}

function register(fields) {
  const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, fields.terminal_id);
  return session.register({ origin: "cli", initiator: "user", cwd: "/tmp", agent: "conductor", session_dir: dir, ...fields });
}

// Fixture one: three active tasks (done, asking, plain) and an archived one.
function fixtureOne(label) {
  useRoots(label);
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    done: mkTask(key, "shipped", "Shipped", { done: true }),
    asks: mkTask(key, "asks", "Asks", { asks: true }),
    plain: mkTask(key, "fresh", "Fresh"),
  };
  const gone = mkTask(key, "old", "Old");
  archive(key, "004-old", gone);
  return { key, repoDir, dirs };
}

// L1
const one = fixtureOne("one-db");
{
  const byDefault = json(["ls"]);
  check(byDefault.status === 0 && JSON.stringify(byDefault.data.tasks.map((t) => t.number)) === "[2,3]",
    `L1: the default lists the two not-done tasks, the done one absent (${byDefault.data && byDefault.data.tasks.map((t) => t.number)})`);
  const r = json(["ls", "--all"]);
  const tasks = r.data && r.data.tasks;
  const byNumber = Object.fromEntries((tasks || []).map((t) => [t.number, t]));
  check(r.status === 0 && Array.isArray(tasks) && tasks.length === 3, `L1: --all lists the three active tasks, the archived one absent (exit ${r.status}, ${tasks && tasks.length})`);
  check(tasks && tasks.every((t) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(ROSTER_KEYS)), "L1: every row has exactly the roster entry keys");
  check(r.data && Number.isInteger(r.data.data_version) && r.data.data_version > 0 && typeof r.data.generated_at === "string",
    `L1: the payload carries data_version and generated_at (${r.data && r.data.data_version})`);
  check(tasks && tasks.every((t) => t.advice && typeof t.advice.move === "string" && typeof t.advice.text === "string" && !("next" in t)), "L1: every row carries advice (move and text) and no next key");
  check(byNumber[1] && byNumber[1].task_status === "done" && ["close", "land"].includes(byNumber[1].advice.move), `L1: a done task reads done with a close or land move (${byNumber[1] && byNumber[1].task_status})`);
  check(tasks && tasks.every((t) => t.attention === (t.advice.question !== null)), "L1: attention is true exactly when the advice asks the owner a question");
  check(byNumber[2] && byNumber[2].advice.question !== null && byNumber[2].attention === true, "L1: the asking task carries a question");
  check(byNumber[3] && byNumber[3].main_root === one.key.main_root && byNumber[3].repo_key === "github.com/acme/acme" && byNumber[3].tier === "standard", "L1: rows carry repo_key, main_root and tier");
  check(byNumber[3] && byNumber[3].advice.text.length > 0 && Array.isArray(byNumber[3].advice.warnings), "L1: the advice is a sentence with a warnings list");
  check(byNumber[3] && byNumber[3].current_phase && byNumber[3].current_phase.id === 1 && byNumber[3].current_phase.name === "Build", "L1: the row carries the current phase");
  check(tasks && tasks.every((t) => ["open", "in_progress", "done"].includes(t.task_status)), "L1: every row carries a task status word");
  check(r.data && Array.isArray(r.data.sessions) && r.data.sessions.length === 0, "L1: no sessions registered, none listed");
}

// Fixture two: five tasks; sessions are registered per scenario in their own roots.
function fixtureTwo() {
  useRoots("two");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    alpha: mkTask(key, "alpha", "Alpha"),
    bravo: mkTask(key, "bravo", "Bravo"),
    charlie: mkTask(key, "charlie", "Charlie", { done: true }),
    delta: mkTask(key, "delta", "Delta"),
    echo: mkTask(key, "echo", "Echo"),
  };
  return { key, repoDir, dirs };
}
function freshSessionsRoot(label) {
  process.env.AGENTS_SESSIONS_ROOT = mk(label);
  return process.env.AGENTS_SESSIONS_ROOT;
}
const rowOf = (data, n) => data.tasks.find((t) => t.number === n);
const SID_A = "aaaa0001-0000-4000-8000-000000000001";
const SID_B = "bbbb0002-0000-4000-8000-000000000002";

// L2 (pinned fixture, reused by L6)
const two = fixtureTwo();
const l2Root = freshSessionsRoot("sessions-l2");
const claudeA = spawnClaude();
// The zmx lines carry the real 0.8.1 shape: two-space indent, "→ " on the
// current session's line, tabs between fields, ended= on the dead session.
setZmx(["→ name=Conductor-aaaa0001\tpid=1\tclients=1\tcreated=1\tcwd=file:///tmp/one", "  name=Courier-bbbb0002\tpid=2\tclients=0\tcreated=1\tcwd=file:///tmp/two\tended=2\texit_code=0"]);
register({ session_id: SID_A, terminal_id: "ta", pid: claudeA.pid, pid_at: new Date().toISOString(), mux: { kind: "zmx", name: "Conductor-aaaa0001" }, task_dir: two.dirs.alpha, repo_key: two.key.key });
register({ session_id: SID_B, terminal_id: "tb", agent: "courier", pid: 1, mux: { kind: "zmx", name: "Courier-bbbb0002" }, task_dir: two.dirs.bravo, repo_key: two.key.key });
session.markEnded(path.join(l2Root, "tb"));
{
  const r = json(["ls"]);
  const alpha = rowOf(r.data, 1);
  check(alpha.live && alpha.live.session_id === SID_A && alpha.live.mux && alpha.live.mux.name === "Conductor-aaaa0001" && alpha.live.session_state === "live",
    `L2: the live session shows on its task with its zmx name (${JSON.stringify(alpha.live)})`);
  check(rowOf(r.data, 2).live === null && rowOf(r.data, 4).live === null, "L2: the ended session's task has no live session");
  const mine = r.data.sessions.filter((s) => s.session_id === SID_A);
  check(mine.length === 1 && mine[0].mux && mine[0].mux.name === "Conductor-aaaa0001",
    `L2: the live session's roster row carries its mux, the attach target (${JSON.stringify(mine[0] && mine[0].mux)})`);
}

// L6: the ids `a ls` shows as live equal the ones `a cc ls` lists as not ended.
{
  const ls = json(["ls"]).data;
  const lsIds = [...new Set([...ls.tasks.filter((t) => t.live).map((t) => t.live.session_id), ...ls.sessions.map((s) => s.session_id)])];
  const cc = json(["cc", "ls"]).data;
  const ccIds = cc.sessions.filter((s) => !s.ended_at).map((s) => s.session_id);
  check(JSON.stringify(lsIds) === JSON.stringify([SID_A]) && JSON.stringify(ccIds) === JSON.stringify([SID_A]),
    `L6: a ls and a cc ls agree on the live ids (ls ${JSON.stringify(lsIds)}, cc ${JSON.stringify(ccIds)})`);
  const noZmx = json(["cc", "ls", "--all"], { env: { PATH: "/usr/bin:/bin" } }).data;
  const a = noZmx.sessions.find((s) => s.session_id === SID_A);
  check(a && !a.ended_at, "L6: with zmx absent, a cc ls marks nothing ended");
}

// L3: liveness through zmx when the recorded pid is not claude (hooks off).
{
  freshSessionsRoot("sessions-l3");
  const sleeper = spawnNonClaude();
  const SID_D = "dddd0004-0000-4000-8000-000000000004";
  const SID_E = "cccc0003-0000-4000-8000-000000000003";
  register({ session_id: SID_D, terminal_id: "td", pid: sleeper.pid, mux: { kind: "zmx", name: "Courier-dddd0004" }, task_dir: two.dirs.delta, repo_key: two.key.key });
  setZmx(["name=Courier-dddd0004\tpid=4\tclients=0\tcreated=1\tcwd=/tmp"]);
  const listed = rowOf(json(["ls"]).data, 4);
  check(listed.live && listed.live.session_id === SID_D, "L3: a zmx-listed session reads live although its pid is not claude");
  setZmx(["name=Courier-dddd0004\tpid=4\tclients=0\tcreated=1\tcwd=/tmp\tended=9\texit_code=0"]);
  check(rowOf(json(["ls"]).data, 4).live === null, "L3: the same session with an ended zmx line reads not live");

  register({ session_id: SID_E, terminal_id: "te", agent: "courier", pid: sleeper.pid, task_dir: two.dirs.echo, repo_key: two.key.key });
  setZmx(["name=Courier-cccc0003\tpid=3\tclients=0\tcreated=1\tcwd=/tmp"]);
  const shim = rowOf(json(["ls"]).data, 5);
  check(shim.live && shim.live.session_id === SID_E && shim.live.mux && shim.live.mux.name === "Courier-cccc0003",
    `L3: a session with no mux matches a listed <Agent>-<id8> zmx name (${JSON.stringify(shim.live)})`);
}

// L4: text output.
{
  freshSessionsRoot("sessions-l4");
  const unbound = spawnClaude();
  const SID_C = "eeee0005-0000-4000-8000-000000000005";
  setZmx([]);
  register({ session_id: SID_C, terminal_id: "tc", pid: unbound.pid, pid_at: new Date().toISOString(), repo_key: two.key.key });
  const text = cli(["ls"]);
  const all = cli(["ls", "--all"]);
  check(text.status === 0 && !text.out.includes("003-charlie") && text.out.includes("001-alpha") && text.out.includes("005-echo"), `L4: text a ls omits the done task (exit ${text.status})`);
  check(all.out.includes("003-charlie"), "L4: a ls --all shows the done task");
  check(text.out.includes(SID_C.slice(0, 8)), "L4: a live session bound to no task is listed under the unbound sessions");
}

// L5: one task.
{
  const inRepo = { cwd: two.repoDir };
  const r = cli(["ls", "002"], inRepo);
  check(r.status === 0 && r.out.includes("Bravo") && /1\s+Build\s+\[open\]/.test(r.out) && /next/i.test(r.out), `L5: a ls 002 prints title, phases and the next step (exit ${r.status})`);
  const j = json(["ls", "bravo"], inRepo);
  check(j.status === 0 && j.data.number === 2 && j.data.title === "Bravo" && Array.isArray(j.data.phases) && j.data.phases.length === 1
    && j.data.phases[0].after !== undefined && j.data.phases[0].plan_file !== undefined && j.data.phases[0].plan_hash === null,
    `L5: --json carries the row with its phases (${JSON.stringify(j.data && j.data.phases)})`);
  const missing = cli(["ls", "nope"], inRepo);
  check(missing.status === 4 && missing.err.includes("nope"), `L5: an unknown task exits 4 naming it (exit ${missing.status}: ${missing.err.trim()})`);
  check(Array.isArray(j.data.decisions) && Array.isArray(j.data.notes) && j.data.last_land === null && j.data.landing !== undefined,
    "L5: the detail carries decisions, notes, last_land and landing");
  const bare = json(["ls", "2"], inRepo);
  check(bare.status === 0 && bare.data.number === 2 && bare.data.title === "Bravo", `L5: a bare number resolves to its task (exit ${bare.status})`);
}

// L5b: a slug shared by two tasks is ambiguous.
{
  useRoots("dup");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "twin", "First twin");
  mkTask(key, "twin", "Second twin");
  const r = cli(["ls", "twin"], { cwd: repoDir });
  check(r.status === 2 && r.err.includes("001-twin") && r.err.includes("002-twin") && r.out === "", `L5b: a shared slug exits 2 naming both tasks (exit ${r.status}: ${r.err.trim()})`);
  const byNumber = json(["ls", "002"], { cwd: repoDir });
  check(byNumber.status === 0 && byNumber.data.title === "Second twin", "L5b: the number still picks one of the twins");
}

// L5c: an exact slug wins over tasks whose slug merely ends with it.
{
  useRoots("slug-suffix");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "typo", "Exact typo");
  mkTask(key, "fix-typo", "Suffix typo");
  const r = json(["ls", "typo"], { cwd: repoDir });
  check(r.status === 0 && r.data.number === 1 && r.data.title === "Exact typo", `L5c: a slug equal to one task's slug resolves it, not ambiguous with 002-fix-typo (exit ${r.status}: ${r.err.trim()})`);
  const suffix = json(["ls", "fix-typo"], { cwd: repoDir });
  check(suffix.status === 0 && suffix.data.number === 2, `L5c: the longer slug still resolves its own task (exit ${suffix.status})`);
}

// L5d: a task read by its absolute dir uses its own repo, never the cwd's.
{
  useRoots("own-repo");
  const dirA = makeRepo("alpha");
  const dirB = makeRepo("beta");
  const keyB = repoKey(dirB);
  const bDir = mkTask(keyB, "elsewhere", "Elsewhere");
  const read = json(["task", "read", bDir], { cwd: dirA });
  check(read.status === 0 && read.data.main_root === keyB.main_root && read.data.repo_key === keyB.key,
    `L5d: task read of B's dir from A's checkout reports B's repo (${read.status}: ${read.data && read.data.repo_key})`);
  const lsAbs = json(["ls", bDir], { cwd: dirA });
  check(lsAbs.status === 0 && lsAbs.data.main_root === keyB.main_root && lsAbs.data.repo_key === keyB.key,
    `L5d: a ls of B's dir from A's checkout reports B's repo (${lsAbs.status}: ${lsAbs.data && lsAbs.data.repo_key})`);
}

// L9: several live sessions on one task: only the newest shows on the row, none is called unbound.
{
  useRoots("two-live");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dir = mkTask(key, "busy", "Busy");
  const older = spawnClaude(), newer = spawnClaude();
  const SID_OLD = "11110007-0000-4000-8000-000000000007";
  const SID_NEW = "22220008-0000-4000-8000-000000000008";
  setZmx([]);
  register({ session_id: SID_OLD, terminal_id: "to", pid: older.pid, pid_at: new Date().toISOString(), task_dir: dir, repo_key: key.key });
  execFileSync("/bin/sleep", ["0.05"]);
  register({ session_id: SID_NEW, terminal_id: "tn", pid: newer.pid, pid_at: new Date().toISOString(), task_dir: dir, repo_key: key.key });
  const j = json(["ls"], { cwd: repoDir });
  check(j.status === 0 && j.data.tasks[0].live && j.data.tasks[0].live.session_id === SID_NEW, `L9: the row shows the newer of two live sessions (${JSON.stringify(j.data.tasks[0].live)})`);
  check(JSON.stringify(j.data.sessions.map((s) => s.session_id).sort()) === JSON.stringify([SID_NEW, SID_OLD].sort())
    && j.data.sessions.every((s) => s.task_number === 1),
    `L9: every live session sits on its own row with its task's number (${JSON.stringify(j.data.sessions.map((s) => s.session_id))})`);
  check(j.data.tasks[0].advice.warnings.some((w) => w.includes("two sessions are bound to this task")),
    `L9: the two bound sessions warn, from the roster's one sessions read (${JSON.stringify(j.data.tasks[0].advice.warnings)})`);
  const text = cli(["ls"], { cwd: repoDir });
  check(text.out.includes(SID_OLD.slice(0, 8)) && !/\s22220008\b/.test(text.out),
    `L9: the text shows the owner on the row and the other session on its own line (${JSON.stringify(text.out)})`);
}

// RO-D: a task's live session is its Conductor, not a dispatched run started after it; a task with only dispatched runs shows the newest.
{
  useRoots("two-dispatch");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dir = mkTask(key, "driven", "Driven");
  const onlyRuns = mkTask(key, "alone", "Alone");
  const conductor = spawnClaude(), runA = spawnClaude(), runB = spawnClaude(), runC = spawnClaude();
  const SID_CONDUCTOR = "33330009-0000-4000-8000-000000000009";
  const SID_RUN = "4444000a-0000-4000-8000-00000000000a";
  const SID_RUN_A = "5555000b-0000-4000-8000-00000000000b";
  const SID_RUN_B = "6666000c-0000-4000-8000-00000000000c";
  setZmx([]);
  const stamp = new Date().toISOString();
  register({ session_id: SID_CONDUCTOR, terminal_id: "tc", pid: conductor.pid, pid_at: stamp, task_dir: dir, repo_key: key.key });
  execFileSync("/bin/sleep", ["0.05"]);
  register({ session_id: SID_RUN, terminal_id: "tr", origin: "dispatch", agent: "builder", pid: runA.pid, pid_at: stamp, task_dir: dir, repo_key: key.key });
  register({ session_id: SID_RUN_A, terminal_id: "tra", origin: "dispatch", agent: "explorer", pid: runB.pid, pid_at: stamp, task_dir: onlyRuns, repo_key: key.key });
  execFileSync("/bin/sleep", ["0.05"]);
  register({ session_id: SID_RUN_B, terminal_id: "trb", origin: "dispatch", agent: "reviewer", pid: runC.pid, pid_at: stamp, task_dir: onlyRuns, repo_key: key.key });
  const j = json(["ls"], { cwd: repoDir });
  const rowDriven = j.data.tasks.find((t) => t.slug === "driven");
  const rowAlone = j.data.tasks.find((t) => t.slug === "alone");
  check(j.status === 0 && rowDriven && rowDriven.live && rowDriven.live.session_id === SID_CONDUCTOR,
    `RO-D: a task with a live Conductor and a newer dispatched run shows the Conductor as live (${JSON.stringify(rowDriven && rowDriven.live && rowDriven.live.session_id)})`);
  check(rowAlone && rowAlone.live && rowAlone.live.session_id === SID_RUN_B,
    `RO-D: a task with only dispatched runs shows the newest of them (${JSON.stringify(rowAlone && rowAlone.live && rowAlone.live.session_id)})`);
  check(j.data.sessions.length === 4 && j.data.sessions.every((s) => s.session_state === "live"),
    `RO-D: every live session sits on its own row, none dropped (${j.data.sessions.length})`);
}

// Fixture recency: acme 001 fresh, 002 written 30 days ago, 003 done and fresh,
// 005 archived; repo gone with one fresh task whose checkout is then removed.
function fixtureRecency() {
  useRoots("recency");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    fresh: mkTask(key, "fresh", "Fresh"),
    stale: mkTask(key, "stale", "Stale", { ageDays: 30 }),
    shipped: mkTask(key, "shipped", "Shipped", { done: true }),
  };
  archive(key, "004-old", mkTask(key, "old", "Old"));
  const goneDir = makeRepo("gone");
  const goneKey = repoKey(goneDir);
  const goneTask = mkTask(goneKey, "vanish", "Vanish");
  fs.rmSync(path.dirname(goneDir), { recursive: true, force: true });
  return { repoDir, key, dirs, goneKey, goneTask };
}
const rec = fixtureRecency();
const recSlugs = (data) => data.tasks.map((t) => path.basename(t.dir));

// L10: stale, done and archived tasks and a vanished checkout are hidden by default.
{
  freshSessionsRoot("sessions-l10");
  setZmx([]);
  const j = json(["ls"], { cwd: rec.repoDir });
  check(j.status === 0 && JSON.stringify(recSlugs(j.data)) === JSON.stringify(["001-fresh"]),
    `L10: --json lists 001 only (${JSON.stringify(j.data && recSlugs(j.data))})`);
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.status === 0 && text.out.includes("001-fresh") && !/002-stale|003-shipped/.test(text.out),
    `L10: text lists 001 only (${JSON.stringify(text.out)})`);
  const one = cli(["ls", "002"], { cwd: rec.repoDir });
  check(one.status === 0 && one.out.includes("Stale"), `L10: a ls 002 still prints the stale task (exit ${one.status}: ${one.err.trim()})`);
}

// L12: a vanished checkout hides its tasks; --all shows them under a header marking the root missing.
{
  const j = json(["ls"], { cwd: rec.repoDir });
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(!j.data.tasks.some((t) => t.repo_key === rec.goneKey.key) && !text.out.includes(rec.goneKey.key),
    "L12: the vanished repo has no row and no heading by default");
  const all = json(["ls", "--all"], { cwd: rec.repoDir });
  const goneRow = all.data.tasks.find((t) => t.repo_key === rec.goneKey.key);
  check(goneRow && goneRow.main_root === rec.goneKey.main_root, `L12: --all --json has the vanished repo's row with its main_root (${goneRow && goneRow.main_root})`);
  const allText = cli(["ls", "--all"], { cwd: rec.repoDir });
  check(allText.out.includes(`${rec.goneKey.key} (${rec.goneKey.main_root}, missing)`), `L12: --all text marks the missing root (${JSON.stringify(allText.out)})`);
  check(allText.out.includes(`${rec.key.key} (${rec.key.main_root})`), "L12: a present checkout's header carries no missing mark");
}

// L13: regression guard, --all must not over-filter.
{
  const j = json(["ls", "--all"], { cwd: rec.repoDir });
  check(JSON.stringify(recSlugs(j.data)) === JSON.stringify(["001-fresh", "002-stale", "003-shipped", "001-vanish"]),
    `L13: --all --json lists every active task, the archived one absent (${JSON.stringify(recSlugs(j.data))})`);
  const text = cli(["ls", "--all"], { cwd: rec.repoDir });
  check(["001-fresh", "002-stale", "003-shipped", "001-vanish"].every((s) => text.out.includes(s)) && !text.out.includes("004-old"),
    "L13: --all text lists every active task");
}

// L11: a stale task with a live session is listed, and the session counts as bound.
{
  freshSessionsRoot("sessions-l11");
  setZmx(["name=Conductor-aaaa0010\tpid=1\tclients=0\tcreated=1\tcwd=/tmp"]);
  register({ session_id: "aaaa0010-0000-4000-8000-000000000010", terminal_id: "t10", mux: { kind: "zmx", name: "Conductor-aaaa0010" }, task_dir: rec.dirs.stale, repo_key: rec.key.key });
  const j = json(["ls"], { cwd: rec.repoDir });
  const stale = j.data.tasks.find((t) => path.basename(t.dir) === "002-stale");
  check(stale && stale.live && stale.live.mux.name === "Conductor-aaaa0010", `L11: the stale task with a live session is listed (${JSON.stringify(stale && stale.live)})`);
  check(j.data.sessions.length === 1 && j.data.sessions[0].task_dir === rec.dirs.stale && j.data.sessions[0].session_state === "live",
    `L11: the bound session sits on its own row too (${JSON.stringify(j.data.sessions)})`);
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.out.includes("002-stale") && text.out.includes("Conductor-aaaa0010") && !text.out.includes("Live sessions"), "L11: text lists the stale task with its session");
}

// L14: a vanished checkout with a live session is listed, its header marks the root missing.
{
  freshSessionsRoot("sessions-l14");
  setZmx(["name=Conductor-aaaa0014\tpid=1\tclients=0\tcreated=1\tcwd=/tmp"]);
  register({ session_id: "aaaa0014-0000-4000-8000-000000000014", terminal_id: "t14", mux: { kind: "zmx", name: "Conductor-aaaa0014" }, task_dir: rec.goneTask, repo_key: rec.goneKey.key });
  const j = json(["ls"], { cwd: rec.repoDir });
  const row = j.data.tasks.find((t) => t.repo_key === rec.goneKey.key);
  check(row && row.live && row.live.mux.name === "Conductor-aaaa0014" && row.main_root === rec.goneKey.main_root,
    `L14: the vanished repo's task with a live session is listed with its main_root (${JSON.stringify(row && row.live)})`);
  check(j.data.sessions.length === 1 && j.data.sessions[0].task_number === 1,
    `L14: the bound session carries its task number (${JSON.stringify(j.data.sessions)})`);
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.out.includes(`${rec.goneKey.key} (${rec.goneKey.main_root}, missing)`) && text.out.includes("001-vanish") && !text.out.includes("Live sessions"),
    `L14: text heads the vanished repo as missing and lists no further session (${JSON.stringify(text.out)})`);
  setZmx([]);
}

// L8: cost, 140 tasks.
{
  useRoots("cost");
  const key = repoKey(makeRepo());
  mkTask(key, "seed", "Seed");
  const base = process.env.AGENTS_TASKS_ROOT;
  const conn = db.open();
  for (let n = 2; n <= 140; n++) {
    const name = `${String(n).padStart(3, "0")}-job-${n}`;
    const id = db.createTaskRow({
      repoKey: key.key, dirName: name, taskDir: path.join(base, key.key, name), slug: name, number: n,
      title: `Job ${n}`, tier: "standard", mode: "full", created: "2026-10-01", approvals: "none", land: "per_phase",
      worktreePath: null, branch: null,
      phases: [{ id: 1, name: "Step 1" }, { id: 2, name: "Step 2", after: [1] }],
    });
    if (n > 130) {
      db.insertCheckmark(id, 1, "s", new Date().toISOString());
      db.insertCheckmark(id, 2, "s", new Date().toISOString());
      const head = execFileSync("git", ["-C", key.main_root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      db.appendEvent({ kind: "land", taskId: id, detail: JSON.stringify({ head, migrated: true }) });
    }
  }
  const live = spawnClaude();
  freshSessionsRoot("sessions-l8");
  register({ session_id: "ffff0006-0000-4000-8000-000000000006", terminal_id: "tf", pid: live.pid, pid_at: new Date().toISOString(), task_dir: path.join(base, key.key, "005-job-5"), repo_key: key.key });
  setZmx([]);
  const t0 = process.hrtime.bigint();
  const j = json(["ls"]);
  const jsonMs = Number((process.hrtime.bigint() - t0) / 1000000n);
  const t1 = process.hrtime.bigint();
  const text = cli(["ls"]);
  const textMs = Number((process.hrtime.bigint() - t1) / 1000000n);
  const taskLines = text.out.split("\n").filter((l) => /^\d{3}-/.test(l)).length;
  const everything = json(["ls", "--all"]);
  console.log(`L8 timing: --json ${jsonMs} ms, text ${textMs} ms (140 tasks)`);
  check(j.status === 0 && j.data.tasks.length === 130, `L8: default --json lists the 130 open tasks (exit ${j.status}, ${j.data && j.data.tasks.length})`);
  check(everything.status === 0 && everything.data.tasks.length === 140, `L8: --all --json lists 140 tasks (${everything.data && everything.data.tasks.length})`);
  check(text.status === 0 && taskLines === 130, `L8: text lists the 130 open tasks (${taskLines})`);
  if (process.env.AGENTS_TEST_TIMING === "1") {
    check(jsonMs < 1000 && textMs < 1000, `L8: both runs finish under 1000 ms (json ${jsonMs}, text ${textMs})`);
  }
}

// P1: the repos field — every repos-table row, task-less ones included, in ord, key order.
{
  useRoots("repos-field");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "one", "One");
  const plainRoot = path.join(mk("plain-repo"), "checkout");
  fs.mkdirSync(plainRoot);
  db.upsertRepo("github.com/acme/aardvark", { main_root: plainRoot });
  const r = json(["ls", "--all"], { cwd: repoDir });
  check(r.status === 0 && JSON.stringify(r.data.repos) === JSON.stringify([
    { repo_key: key.key, main_root: key.main_root },
    { repo_key: "github.com/acme/aardvark", main_root: plainRoot },
  ]), `P1: repos holds both rows, the task-less one included, ord before key (${JSON.stringify(r.data && r.data.repos)})`);
}

// P2: resumable — the newest ended Conductor/Courier session bound to the task.
{
  useRoots("resumable");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirA = mkTask(key, "alpha", "Alpha");
  mkTask(key, "bravo", "Bravo");
  const root = freshSessionsRoot("sessions-p2");
  const SID_R1 = "12340011-0000-4000-8000-000000000011";
  const SID_R2 = "56780012-0000-4000-8000-000000000012";
  register({ session_id: SID_R1, terminal_id: "tr1", cwd: repoDir, task_dir: dirA, repo_key: key.key });
  session.markEnded(path.join(root, "tr1"));
  const endedRow = db.listSessions().find((s) => s.session_id === SID_R1);
  const r = json(["ls"], { cwd: repoDir });
  const a = rowOf(r.data, 1);
  check(r.status === 0 && a && a.resumable && a.resumable.session_id === SID_R1 && a.resumable.agent === "conductor"
    && a.resumable.ended_at === endedRow.ended_at && a.resumable.cwd === repoDir,
    `P2: the ended Conductor session reads as the task's resumable (${JSON.stringify(a && a.resumable)})`);
  check(rowOf(r.data, 2).resumable === null, "P2: a task with no ended session reads resumable null");
  execFileSync("/bin/sleep", ["0.05"]);
  register({ session_id: SID_R2, terminal_id: "tr2", cwd: repoDir, task_dir: dirA, repo_key: key.key });
  session.markEnded(path.join(root, "tr2"));
  const again = json(["ls"], { cwd: repoDir }).data;
  check(rowOf(again, 1).resumable.session_id === SID_R2,
    `P2: of two ended Conductor sessions the newer ended_at wins (${JSON.stringify(rowOf(again, 1).resumable)})`);
}

// P3: origin and main_root on every live session row.
{
  useRoots("origin-mainroot");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dir = mkTask(key, "bound", "Bound");
  freshSessionsRoot("sessions-p3");
  const claudeBound = spawnClaude();
  const claudeGhost = spawnClaude();
  const SID_O1 = "aaaa0013-0000-4000-8000-000000000013";
  const SID_O2 = "bbbb0014-0000-4000-8000-000000000014";
  const stamp = new Date().toISOString();
  register({ session_id: SID_O1, terminal_id: "to1", pid: claudeBound.pid, pid_at: stamp, task_dir: dir, repo_key: key.key });
  register({ session_id: SID_O2, terminal_id: "to2", pid: claudeGhost.pid, pid_at: stamp, origin: "external", repo_key: "github.com/acme/ghost" });
  const r = json(["ls"], { cwd: repoDir });
  const bound = r.data.sessions.find((s) => s.session_id === SID_O1);
  const ghost = r.data.sessions.find((s) => s.session_id === SID_O2);
  check(bound && bound.origin === "cli" && bound.main_root === key.main_root,
    `P3: a live session carries its registration origin and its repo's main_root (${JSON.stringify(bound && [bound.origin, bound.main_root])})`);
  check(ghost && ghost.origin === "external" && ghost.main_root === null,
    `P3: a session whose repo_key has no repos row reads main_root null (${JSON.stringify(ghost && [ghost.origin, ghost.main_root])})`);
}

// P4: ended_sessions — the rows ended within 24 hours, the older ones absent.
{
  useRoots("ended-window");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dir = mkTask(key, "ended", "Ended");
  const root = freshSessionsRoot("sessions-p4");
  const SID_RECENT = "cccc0015-0000-4000-8000-000000000015";
  const SID_OLD = "dddd0016-0000-4000-8000-000000000016";
  const atRecent = new Date(Date.now() - 3600000).toISOString();
  register({ session_id: SID_RECENT, terminal_id: "te1", cwd: repoDir, task_dir: dir, repo_key: key.key });
  register({ session_id: SID_OLD, terminal_id: "te2", cwd: repoDir, repo_key: key.key });
  session.markEnded(path.join(root, "te1"));
  session.markEnded(path.join(root, "te2"));
  const conn = db.open();
  conn.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", atRecent, SID_RECENT);
  conn.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", new Date(Date.now() - 48 * 3600000).toISOString(), SID_OLD);
  const r = json(["ls"], { cwd: repoDir });
  const ended = r.data && r.data.ended_sessions;
  check(r.status === 0 && Array.isArray(ended) && ended.length === 1,
    `P4: ended_sessions holds exactly the row ended one hour before, the two-day-old one absent (${JSON.stringify(ended)})`);
  check(ended && ended[0].session_id === SID_RECENT && ended[0].task_dir === dir && ended[0].agent === "conductor" && ended[0].ended_at === atRecent,
    `P4: the entry is the ended row's {session_id, task_dir, agent, ended_at} (${JSON.stringify(ended && ended[0])})`);
}

// P5: phases_checked and phases_total — the view's rule, a skip decision counting as checked.
{
  useRoots("phases-count");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirName = "001-eight";
  const dir = path.join(process.env.AGENTS_TASKS_ROOT, key.key, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.md"), "# Eight\n");
  const id = db.createTaskRow({
    repoKey: key.key, dirName, taskDir: dir, slug: dirName, number: 1, title: "Eight",
    tier: "standard", mode: "full", created: "2026-10-01", approvals: "none", land: "per_phase",
    worktreePath: null, branch: null,
    phases: Array.from({ length: 8 }, (_, k) => ({ id: k + 1, name: `P${k + 1}`, after: k > 0 ? [k] : [] })),
  });
  const at = new Date().toISOString();
  db.insertCheckmark(id, 1, "seed", at);
  db.insertCheckmark(id, 2, "seed", at);
  db.insertCheckmark(id, 3, "seed", at);
  db.insertDecision({ task_id: id, phase_id: 4, choice: "skip", quote: "not needed", recorded_by: "seed", decided_at: at });
  taskLib.createTask({ repo: key, title: "Empty", slug: "empty", mode: "full", tier: "standard", phases: [], description: "" });
  const r = json(["ls", "--all"], { cwd: repoDir });
  const eight = rowOf(r.data, 1);
  const empty = rowOf(r.data, 2);
  check(r.status === 0 && eight && eight.phases_checked === 4 && eight.phases_total === 8,
    `P5: three checkmarks and one skip decision read phases_checked 4 of 8 (${eight && `${eight.phases_checked}/${eight.phases_total}`})`);
  check(empty && empty.phases_checked === 0 && empty.phases_total === 0,
    `P5: a zero-phase task reads 0 of 0 (${empty && `${empty.phases_checked}/${empty.phases_total}`})`);
}

// P6: one golden payload — every new field together, the exact key sets and values.
{
  useRoots("golden");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirA = mkTask(key, "resumable", "Resumable");
  const dirB = mkTask(key, "plain", "Plain");
  db.insertCheckmark(db.taskIdOf(dirA), 1, "seed", new Date().toISOString());
  const plainRoot = path.join(mk("plain-repo"), "checkout");
  fs.mkdirSync(plainRoot);
  db.upsertRepo("github.com/acme/aardvark", { main_root: plainRoot });
  const root = freshSessionsRoot("sessions-p6");
  const claudeBound = spawnClaude();
  const claudeGhost = spawnClaude();
  const SID_LIVE = "aaaa0021-0000-4000-8000-000000000021";
  const SID_GHOST = "bbbb0022-0000-4000-8000-000000000022";
  const SID_EA = "cccc0023-0000-4000-8000-000000000023";
  const SID_EU = "dddd0024-0000-4000-8000-000000000024";
  const SID_OLD = "eeee0025-0000-4000-8000-000000000025";
  const atEA = new Date(Date.now() - 2 * 3600000).toISOString();
  const atEU = new Date(Date.now() - 1 * 3600000).toISOString();
  const atOld = new Date(Date.now() - 48 * 3600000).toISOString();
  const stamp = new Date().toISOString();
  register({ session_id: SID_LIVE, terminal_id: "tgl", pid: claudeBound.pid, pid_at: stamp, task_dir: dirA, repo_key: key.key });
  register({ session_id: SID_GHOST, terminal_id: "tgg", pid: claudeGhost.pid, pid_at: stamp, origin: "external", repo_key: "github.com/acme/ghost" });
  register({ session_id: SID_EA, terminal_id: "tea", cwd: repoDir, task_dir: dirA, repo_key: key.key });
  register({ session_id: SID_EU, terminal_id: "teu", agent: "courier", cwd: repoDir, repo_key: key.key });
  register({ session_id: SID_OLD, terminal_id: "teo", cwd: repoDir, task_dir: dirA, repo_key: key.key });
  session.markEnded(path.join(root, "tea"));
  session.markEnded(path.join(root, "teu"));
  session.markEnded(path.join(root, "teo"));
  const conn = db.open();
  conn.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", atEA, SID_EA);
  conn.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", atEU, SID_EU);
  conn.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", atOld, SID_OLD);
  const r = json(["ls", "--all"], { cwd: repoDir });
  const d = r.data;
  check(r.status === 0 && JSON.stringify(Object.keys(d).sort()) === JSON.stringify(
    ["data_version", "ended_sessions", "generated_at", "repos", "sessions", "tasks"]),
    `P6: the payload pins its top-level keys (${JSON.stringify(d && Object.keys(d || {}).sort())})`);
  check(d && JSON.stringify(d.repos) === JSON.stringify([
    { repo_key: key.key, main_root: key.main_root },
    { repo_key: "github.com/acme/aardvark", main_root: plainRoot },
  ]), `P6: repos pins both rows, ord before key (${JSON.stringify(d && d.repos)})`);
  check(d && d.tasks.every((t) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(ROSTER_KEYS)),
    "P6: every task row pins the extended roster key set");
  check(d && d.sessions.every((s) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(SESSION_KEYS)),
    "P6: every session row pins its key set");
  const bound = d && d.sessions.find((s) => s.session_id === SID_LIVE);
  const ghost = d && d.sessions.find((s) => s.session_id === SID_GHOST);
  check(bound && bound.origin === "cli" && bound.main_root === key.main_root,
    `P6: the bound live session carries origin cli and its repo's main_root (${JSON.stringify(bound && [bound.origin, bound.main_root])})`);
  check(ghost && ghost.origin === "external" && ghost.main_root === null,
    `P6: the ghost session carries origin external and main_root null (${JSON.stringify(ghost && [ghost.origin, ghost.main_root])})`);
  const rowA = d && d.tasks.find((t) => t.dir === dirA);
  const rowB = d && d.tasks.find((t) => t.dir === dirB);
  check(rowA && rowA.phases_checked === 1 && rowA.phases_total === 1
    && JSON.stringify(rowA.resumable) === JSON.stringify({ session_id: SID_EA, agent: "conductor", ended_at: atEA, cwd: repoDir }),
    `P6: the checked task pins phases 1 of 1 and its resumable session (${JSON.stringify(rowA && rowA.resumable)})`);
  check(rowB && rowB.phases_checked === 0 && rowB.phases_total === 1 && rowB.resumable === null,
    `P6: the task without an ended Conductor/Courier session reads resumable null (${JSON.stringify(rowB && rowB.resumable)})`);
  check(d && JSON.stringify(d.ended_sessions) === JSON.stringify([
    { session_id: SID_EU, task_dir: null, agent: "courier", ended_at: atEU },
    { session_id: SID_EA, task_dir: dirA, agent: "conductor", ended_at: atEA },
  ]), `P6: ended_sessions pins the two in-window rows newest first, unbound included, the old one absent (${JSON.stringify(d && d.ended_sessions)})`);
}

// P7: repos — a repo whose checkout is gone drops out of `repos` unless it holds
// an active task; an existing root stays listed, task-less or not.
{
  useRoots("repos-gone");
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "one", "One");
  const movedDir = makeRepo("moved");
  const movedKey = repoKey(movedDir);
  mkTask(movedKey, "moved", "Moved");
  db.upsertRepo(movedKey.key, { main_root: path.join(mk("gone-root"), "checkout") });
  db.upsertRepo("github.com/acme/gone", { main_root: path.join(mk("gone-too"), "checkout") });
  const plainRoot = path.join(mk("plain-root"), "checkout");
  fs.mkdirSync(plainRoot);
  db.upsertRepo("github.com/acme/taskless", { main_root: plainRoot });
  for (const mode of [[], ["--all"]]) {
    const r = json(["ls", ...mode], { cwd: repoDir });
    const keys = ((r.data || {}).repos || []).map((x) => x.repo_key);
    check(r.status === 0 && keys.includes(key.key) && keys.includes("github.com/acme/taskless")
      && keys.includes(movedKey.key) && !keys.includes("github.com/acme/gone"),
      `P7: ${mode.length === 0 ? "the default list" : "--all"} keeps the existing roots and the moved-checkout repo with its task, drops the task-less gone one (${JSON.stringify(keys)})`);
  }
}

// The child case: a registration whose doc holds parent_session_id is served with it.
{
  useRoots("sessions-child");
  const childSid = "child-bbbb0001";
  const parentSid = "parent-aaaa0000";
  const zmxName = "Builder-bbbb0001";
  setZmx([`  name=${zmxName}\tpid=1\tclients=1\tcreated=1\tcwd=file:///tmp`]);
  const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, "tc");
  fs.mkdirSync(dir, { recursive: true });
  const reg = {
    session_id: childSid, terminal_id: "tc", origin: "external", cwd: "/tmp",
    agent: "Builder", mux: { kind: "zmx", name: zmxName },
    parent_session_id: parentSid,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "registration.json"), JSON.stringify(reg, null, 2));
  db.upsertSession(path.basename(dir), JSON.stringify(reg));
  const r = json(["ls"]);
  const childSession = (r.data && r.data.sessions || []).find((s) => s.session_id === childSid);
  check(childSession && childSession.parent_session_id === parentSid,
    `the child session carries parent_session_id in a ls --json (${childSession ? JSON.stringify(childSession.parent_session_id) : "no session"})`);
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
