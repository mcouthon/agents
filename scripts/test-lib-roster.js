#!/usr/bin/env node
"use strict";
// `a ls`: the roster of active tasks with their live sessions, through the CLI.
// Isolation: nothing here may touch the real HOME, config, git config, zmx or sessions.

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

const ROSTER_KEYS = ["advice", "attention", "branch", "dir", "disposition", "landed_sha", "live", "main_root", "mode",
  "number", "repo_key", "slug", "status", "tier", "title", "updated", "warnings", "worktree"];

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
  return dir;
}

// Point every root at fresh dirs; `withDb` creates the database (DB mode), else file mode.
function useRoots(label, { withDb }) {
  const root = mk(label);
  process.env.AGENTS_TASKS_ROOT = path.join(root, "tasks");
  process.env.AGENTS_SESSIONS_ROOT = path.join(root, "sessions");
  process.env.AGENTS_DB = path.join(root, "agents.db");
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  if (withDb) db.open({ create: true });
}

function mkTask(key, slug, title, patch) {
  const created = taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" });
  if (patch) {
    const task = taskLib.readTaskJson(created.task_dir);
    patch(task);
    taskLib.writeTaskJson(created.task_dir, task);
  }
  return created.task_dir;
}
const markDone = (t) => { t.status = "done"; t.phases.forEach((p) => { p.status = "done"; }); };
const openCheckpoint = (t) => {
  t.phases[0].status = "planned";
  t.checkpoints.push({ id: "c-1-approve_plan-1", phase: 1, type: "approve_plan", question: "Approve the plan?", options: ["Approve", "Revise"], chosen: null, opened_at: "2026-01-01T00:00:00.000Z", resolved_at: null });
};

function archive(key, dirName, dir) {
  if (db.enabled()) { db.setTaskDisposition({ repoKey: key.key, dirName, disposition: "archived" }); return; }
  const dest = path.join(process.env.AGENTS_TASKS_ROOT, "archive", key.key, dirName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
}

function register(fields) {
  const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, fields.terminal_id);
  return session.register({ origin: "cli", initiator: "user", cwd: "/tmp", agent: "conductor", session_dir: dir, ...fields });
}

// Fixture one: three active tasks (done, open checkpoint, planned) and an archived one.
function fixtureOne(withDb) {
  useRoots(withDb ? "one-db" : "one-file", { withDb });
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    done: mkTask(key, "shipped", "Shipped", markDone),
    checkpoint: mkTask(key, "asks", "Asks", openCheckpoint),
    planned: mkTask(key, "fresh", "Fresh"),
  };
  const gone = mkTask(key, "old", "Old");
  archive(key, "004-old", gone);
  return { key, repoDir, dirs };
}

// L1
const one = fixtureOne(true);
{
  const byDefault = json(["ls"]);
  check(byDefault.status === 0 && JSON.stringify(byDefault.data.tasks.map((t) => t.number)) === "[2,3]",
    `L1: the default lists the two not-done tasks, the done one absent (${byDefault.data && byDefault.data.tasks.map((t) => t.number)})`);
  const r = json(["ls", "--all"]);
  const tasks = r.data && r.data.tasks;
  const byNumber = Object.fromEntries((tasks || []).map((t) => [t.number, t]));
  check(r.status === 0 && Array.isArray(tasks) && tasks.length === 3, `L1: --all lists the three active tasks, the archived one absent (exit ${r.status}, ${tasks && tasks.length})`);
  check(tasks && tasks.every((t) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(ROSTER_KEYS)), "L1: every row has exactly the roster entry keys");
  check(tasks && tasks.every((t) => t.advice && typeof t.advice.move === "string" && !("next" in t)), "L1: every row carries advice and no next key");
  check(byNumber[1] && ["close", "land"].includes(byNumber[1].advice.move), `L1: a done task's advice is close or land (${byNumber[1] && byNumber[1].advice.move})`);
  check(tasks && tasks.every((t) => t.attention === (t.advice.question !== null)), "L1: attention is true exactly when the advice asks the owner a question");
  check(byNumber[3] && byNumber[3].main_root === one.key.main_root && byNumber[3].repo_key === "github.com/acme/acme" && byNumber[3].tier === "standard", "L1: rows carry repo_key, main_root and tier");
  check(byNumber[3] && byNumber[3].advice.advice.length > 0 && Array.isArray(byNumber[3].advice.warnings), "L1: the advice is a sentence with a warnings list");
  check(r.data && Array.isArray(r.data.sessions) && r.data.sessions.length === 0, "L1: no sessions registered, none listed");
}

// L7: file mode gives the same rows (main_root from the root index.json).
{
  const dbRows = json(["ls", "--all"]).data.tasks;
  fixtureOne(false);
  const fileRun = json(["ls", "--all"]);
  // each fixture has its own checkout and tasks root: compare the paths by their last segment
  const strip = (rows) => rows.map(({ dir, updated, main_root, ...rest }) => ({ ...rest, dir: path.basename(dir), main_root: path.basename(main_root) }))
    .sort((a, b) => a.number - b.number);
  check(fileRun.status === 0 && JSON.stringify(strip(fileRun.data.tasks)) === JSON.stringify(strip(dbRows)),
    "L7: file mode lists the same rows as DB mode");
  check(fileRun.data.tasks.every((t) => typeof t.main_root === "string" && t.main_root.endsWith("/acme")), "L7: file-mode main_root comes from the root index");
}

// Fixture two: five tasks; sessions are registered per scenario in their own roots.
function fixtureTwo() {
  useRoots("two", { withDb: true });
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    alpha: mkTask(key, "alpha", "Alpha"),
    bravo: mkTask(key, "bravo", "Bravo"),
    charlie: mkTask(key, "charlie", "Charlie", markDone),
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
setZmx(["name=Conductor-aaaa0001\tpid=1\tclients=1\tcreated=1\tcwd=/tmp", "name=Courier-bbbb0002\tpid=2\tclients=0\tcreated=1\tcwd=/tmp\tended=2\texit_code=0"]);
register({ session_id: SID_A, terminal_id: "ta", pid: claudeA.pid, pid_at: new Date().toISOString(), mux: { kind: "zmx", name: "Conductor-aaaa0001" }, task_dir: two.dirs.alpha, repo_key: two.key.key });
register({ session_id: SID_B, terminal_id: "tb", agent: "courier", pid: 1, mux: { kind: "zmx", name: "Courier-bbbb0002" }, task_dir: two.dirs.bravo, repo_key: two.key.key });
session.markEnded(path.join(l2Root, "tb"));
{
  const r = json(["ls"]);
  const alpha = rowOf(r.data, 1);
  check(alpha.live && alpha.live.session_id === SID_A && alpha.live.mux && alpha.live.mux.name === "Conductor-aaaa0001" && alpha.live.state === "live",
    `L2: the live session shows on its task with its zmx name (${JSON.stringify(alpha.live)})`);
  check(rowOf(r.data, 2).live === null && rowOf(r.data, 4).live === null, "L2: the ended session's task has no live session");
}

// L6: the ids `a ls` shows as live equal the ones `a cc ls` lists as not ended.
{
  const ls = json(["ls"]).data;
  const lsIds = [...ls.tasks.filter((t) => t.live).map((t) => t.live.session_id), ...ls.sessions.map((s) => s.session_id)];
  const cc = json(["cc", "ls"]).data;
  const ccIds = cc.sessions.filter((s) => !s.ended_at).map((s) => s.session_id);
  check(JSON.stringify(lsIds) === JSON.stringify([SID_A]) && JSON.stringify(ccIds) === JSON.stringify([SID_A]),
    `L6: a ls and a cc ls agree on the live ids (ls ${JSON.stringify(lsIds)}, cc ls ${JSON.stringify(ccIds)})`);
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
  check(text.out.includes(SID_C.slice(0, 8)),"L4: a live session bound to no task is listed under the unbound sessions");
}

// L5: one task.
{
  const inRepo = { cwd: two.repoDir };
  const r = cli(["ls", "002"], inRepo);
  check(r.status === 0 && r.out.includes("Bravo") && /1\s+Build\s+\[not_started\]/.test(r.out) && /next/i.test(r.out), `L5: a ls 002 prints title, phases and the next step (exit ${r.status})`);
  const j = json(["ls", "bravo"], inRepo);
  check(j.status === 0 && j.data.number === 2 && j.data.task && j.data.task.title === "Bravo" && j.data.task.phases.length === 1, "L5: --json carries the row and the full task.json under task");
  const missing = cli(["ls", "nope"], inRepo);
  check(missing.status === 4 && missing.err.includes("nope"), `L5: an unknown task exits 4 naming it (exit ${missing.status}: ${missing.err.trim()})`);
  const bare = json(["ls", "2"], inRepo);
  check(bare.status === 0 && bare.data.number === 2 && bare.data.task.title === "Bravo", `L5: a bare number resolves to its task (exit ${bare.status})`);
}

// L5b: a slug shared by two tasks is ambiguous.
{
  useRoots("dup", { withDb: true });
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "twin", "First twin");
  mkTask(key, "twin", "Second twin");
  const r = cli(["ls", "twin"], { cwd: repoDir });
  check(r.status === 2 && r.err.includes("001-twin") && r.err.includes("002-twin") && r.out === "", `L5b: a shared slug exits 2 naming both tasks (exit ${r.status}: ${r.err.trim()})`);
  const byNumber = json(["ls", "002"], { cwd: repoDir });
  check(byNumber.status === 0 && byNumber.data.task.title === "Second twin", "L5b: the number still picks one of the twins");
}

// L5c: an exact slug wins over tasks whose slug merely ends with it.
{
  useRoots("slug-suffix", { withDb: true });
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  mkTask(key, "typo", "Exact typo");
  mkTask(key, "fix-typo", "Suffix typo");
  const r = json(["ls", "typo"], { cwd: repoDir });
  check(r.status === 0 && r.data.number === 1 && r.data.task.title === "Exact typo", `L5c: a slug equal to one task's slug resolves it, not ambiguous with 002-fix-typo (exit ${r.status}: ${r.err.trim()})`);
  const suffix = json(["ls", "fix-typo"], { cwd: repoDir });
  check(suffix.status === 0 && suffix.data.number === 2, `L5c: the longer slug still resolves its own task (exit ${suffix.status})`);
}

// L9: several live sessions on one task: only the newest shows on the row, none is called unbound.
{
  useRoots("two-live", { withDb: true });
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
  check(j.data.sessions.length === 0, `L9: neither session is listed as unbound in --json (${JSON.stringify(j.data.sessions.map((s) => s.session_id))})`);
  const text = cli(["ls"], { cwd: repoDir });
  check(!text.out.includes(SID_OLD.slice(0, 8)), "L9: the older session is absent from the unbound text block");
}

// RO-D: a task's live session is its Conductor, not a dispatched run started after it; a task with only dispatched runs shows the newest.
{
  useRoots("two-dispatch", { withDb: true });
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
  check(rowAlone && rowAlone.live && rowAlone.live.session_id === SID_RUN_B && j.data.sessions.length === 0,
    `RO-D: a task with only dispatched runs shows the newest of them, and neither run is listed as unbound (${JSON.stringify(rowAlone && rowAlone.live && rowAlone.live.session_id)})`);
}

// Fixture recency: acme 001 fresh, 002 written 30 days ago, 003 done and fresh, 004 with no stamp,
// 005 archived; repo gone with one fresh task whose checkout is then removed.
function setDoc(dir, patch) {
  const doc = taskLib.readTaskJson(dir);
  patch(doc);
  db.upsertTask({ ...db.locate(dir), taskDir: dir, filesDir: dir, docText: JSON.stringify(doc) });
}
function fixtureRecency() {
  useRoots("recency", { withDb: true });
  const repoDir = makeRepo();
  const key = repoKey(repoDir);
  const dirs = {
    fresh: mkTask(key, "fresh", "Fresh"),
    stale: mkTask(key, "stale", "Stale"),
    shipped: mkTask(key, "shipped", "Shipped", markDone),
    undated: mkTask(key, "undated", "Undated"),
  };
  setDoc(dirs.stale, (d) => { d.updated = new Date(Date.now() - 30 * 86400000).toISOString(); });
  setDoc(dirs.undated, (d) => { delete d.updated; });
  archive(key, "005-old", mkTask(key, "old", "Old"));
  const goneDir = makeRepo("gone");
  const goneKey = repoKey(goneDir);
  const goneTask = mkTask(goneKey, "vanish", "Vanish");
  fs.rmSync(path.dirname(goneDir), { recursive: true, force: true });
  return { repoDir, key, dirs, goneKey, goneTask };
}
const rec = fixtureRecency();
const recSlugs = (data) => data.tasks.map((t) => path.basename(t.dir));

// L10: stale, done, undated and archived tasks and a vanished checkout are hidden by default.
{
  freshSessionsRoot("sessions-l10");
  setZmx([]);
  const j = json(["ls"], { cwd: rec.repoDir });
  check(j.status === 0 && JSON.stringify(recSlugs(j.data)) === JSON.stringify(["001-fresh"]),
    `L10: --json lists 001 only (${JSON.stringify(j.data && recSlugs(j.data))})`);
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.status === 0 && text.out.includes("001-fresh") && !/002-stale|003-shipped|004-undated/.test(text.out),
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
  check(JSON.stringify(recSlugs(j.data)) === JSON.stringify(["001-fresh", "002-stale", "003-shipped", "004-undated", "001-vanish"]),
    `L13: --all --json lists every active task, the archived one absent (${JSON.stringify(recSlugs(j.data))})`);
  const text = cli(["ls", "--all"], { cwd: rec.repoDir });
  check(["001-fresh", "002-stale", "003-shipped", "004-undated", "001-vanish"].every((s) => text.out.includes(s)) && !text.out.includes("005-old"),
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
  check(j.data.sessions.length === 0, "L11: the session is bound, not unbound");
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.out.includes("002-stale") && text.out.includes("Conductor-aaaa0010") && !text.out.includes("Sessions bound to no task"), "L11: text lists the stale task with its session");
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
  check(j.data.sessions.length === 0, "L14: the session is bound, not unbound");
  const text = cli(["ls"], { cwd: rec.repoDir });
  check(text.out.includes(`${rec.goneKey.key} (${rec.goneKey.main_root}, missing)`) && text.out.includes("001-vanish") && !text.out.includes("Sessions bound to no task"),
    `L14: text heads the vanished repo as missing and lists no unbound session (${JSON.stringify(text.out)})`);
  setZmx([]);
}

// L8: cost, 140 tasks in DB mode.
{
  useRoots("cost", { withDb: true });
  const key = repoKey(makeRepo());
  const template = taskLib.readTaskJson(mkTask(key, "seed", "Seed"));
  const base = process.env.AGENTS_TASKS_ROOT;
  for (let n = 2; n <= 140; n++) {
    const name = `${String(n).padStart(3, "0")}-job-${n}`;
    const phases = [1, 2].map((id) => ({ ...template.phases[0], id, name: `Step ${id}`, status: n > 130 ? "done" : "not_started", blocked_by: id === 2 ? [1] : [] }));
    const doc = { ...template, slug: name, number: n, title: `Job ${n}`, status: n > 130 ? "done" : "planning", phases, files_dir: undefined };
    db.upsertTask({ repoKey: key.key, dirName: name, taskDir: path.join(base, key.key, name), filesDir: path.join(base, key.key, name), docText: JSON.stringify(doc) });
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

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
