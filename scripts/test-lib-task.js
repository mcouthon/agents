#!/usr/bin/env node
"use strict";

// Tasks from the database: central-only Markdown, the worktree record, the
// archive move, notes, numbering, the knobs, and the close. Every scenario runs
// in its own sandbox roots; nothing touches a real root.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-taskv2-")));
  for (const d of ["home", "tasks", "sessions", "xdg"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { createTask, addPhases, checkPhase, setKnob, closeTask, isTaskDone } = require("./lib/task");
const { repoKey } = require("./lib/repo");
const db = require("./lib/db");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");

function makeRepo(name) {
  const dir = path.join(T, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function cli(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: cwd || T, env: env || process.env, timeout: 30000 });
  return { status: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

// Central-only: no repo-local .tasks, no task.json anywhere, task.md central
{
  const repo = makeRepo("central-only");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Central", slug: "central", session_id: "s", phases: [{ id: 1, name: "One" }] });
  check(!fs.existsSync(path.join(repo, ".tasks")), "central-only: no <main_root>/.tasks is created");
  const exclude = path.join(repo, ".git", "info", "exclude");
  check(!fs.readFileSync(exclude, "utf8").includes(".tasks"), "central-only: info/exclude is unchanged");
  check(fs.existsSync(path.join(r.task_dir, "task.md")) && !fs.existsSync(path.join(r.task_dir, "task.json")), "central-only: task.md sits centrally, no task.json");
  const read = cli(["task", "read", "--task-dir", r.task_dir, "--repo", repo]).json();
  check(read.dir === undefined && read.task_dir === undefined && path.basename(read.phases ? "" : "") === "", "central-only: read returns the view");
  check(read.slug === "central" && read.phases.length === 1 && read.knobs.approvals === "none", "central-only: the view carries the phases and approvals none (the new-task default)");
}

// Numbers: sequential, from the database and the central folders
{
  const repo = makeRepo("numbers");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "First", slug: "first", session_id: "s1" });
  const r2 = createTask({ repo: key, title: "Second", slug: "second", session_id: "s2" });
  check(r1.number === 1 && r2.number === 2 && r1.slug === "001-first" && r2.slug === "002-second", `numbers: sequential with padded slugs (${r1.number}, ${r2.number})`);
  fs.mkdirSync(path.join(db.listTasks()[0] ? "" : "", ""), { recursive: true });
  const root = path.join(process.env.AGENTS_TASKS_ROOT, key.key);
  fs.mkdirSync(path.join(root, "1000-x"), { recursive: true });
  const r3 = createTask({ repo: key, title: "Third", session_id: "s3" });
  check(r3.number === 1001, `numbers: a central folder 1000-x makes the next 1001 (${r3.number})`);
}

// Tier and fast mode
{
  const repo = makeRepo("tiers");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Courier", slug: "cour", mode: "fast", session_id: "s" });
  const view = require("./lib/task").readTaskJson(r.task_dir);
  check(view.tier === "minor" && view.phases.length === 1 && view.phases[0].name === "Courier", "fast mode: one phase named after the title, tier minor");
  const r2 = createTask({ repo: key, title: "Strat", slug: "strat", tier: "strategic", session_id: "s" });
  check(require("./lib/task").readTaskJson(r2.task_dir).tier === "strategic", "an explicit tier is kept");
}

// addPhases upserts by id and never touches a checkmark
{
  const repo = makeRepo("add-phases");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Add", slug: "add", session_id: "s", phases: [{ id: 1, name: "One" }] });
  addPhases({ taskDir: r.task_dir, phases: [{ id: 1, name: "One renamed", after: [] }, { id: 2, name: "Two", after: [1] }] });
  const phases = db.listPhases(db.taskIdOf(r.task_dir));
  check(phases.length === 2 && phases[0].name === "One renamed" && phases[1].after.join() === "1", "addPhases: an existing id renames, a new id appends waiting on after");
  checkPhase({ taskDir: r.task_dir, phaseId: 1 });
  addPhases({ taskDir: r.task_dir, phases: [{ id: 1, name: "One again", after: [2] }] });
  check(db.checkmarksOf(db.taskIdOf(r.task_dir)).size === 1, "addPhases never removes a checkmark");
  let err = null;
  try { addPhases({ taskDir: r.task_dir, phases: [{ id: "x", name: "bad" }] }); } catch (e) { err = e; }
  check(err && /Remedy:/.test(err.message) && err.code === "bad_phase", "addPhases: a malformed phase is refused with a remedy");
}

// checkPhase: idempotent, one event; a refusal names the ids
{
  const repo = makeRepo("check");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Check", slug: "check", session_id: "s", phases: [{ id: 1, name: "One" }, { id: 2, name: "Two" }] });
  const taskId = db.taskIdOf(r.task_dir);
  const first = checkPhase({ taskDir: r.task_dir, phaseId: 1 });
  const second = checkPhase({ taskDir: r.task_dir, phaseId: 1 });
  check(first.checked_at === second.checked_at && db.checkmarksOf(taskId).size === 1, "checkPhase: idempotent, one checkmark");
  check(db.lastEventAt(taskId, "check") !== null, "checkPhase: the check event is appended");
  let err = null;
  try { checkPhase({ taskDir: r.task_dir, phaseId: 9 }); } catch (e) { err = e; }
  check(err && err.code === "unknown_phase" && /phases: 1, 2/.test(err.message) && /add_phases/.test(err.message), "checkPhase: an unknown id is refused naming the ids and add_phases");
  const view = require("./lib/task").readTaskJson(r.task_dir);
  check(view.phases[0].status === "done" && view.phases[1].status === "not_started", "checkPhase: only the checked phase reads done in the view");
  check(isTaskDone(view) === false, "isTaskDone: one unchecked phase is not done");
  checkPhase({ taskDir: r.task_dir, phaseId: 2 });
  check(isTaskDone(require("./lib/task").readTaskJson(r.task_dir)) === true, "isTaskDone: every phase checked is done");
}

// setKnob
{
  const repo = makeRepo("knobs");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Knob", slug: "knob", session_id: "s", phases: [{ id: 1, name: "One" }] });
  setKnob({ taskDir: r.task_dir, knob: "approvals", value: "ask" });
  setKnob({ taskDir: r.task_dir, knob: "land", value: "at_end" });
  const row = db.getTask(db.taskIdOf(r.task_dir));
  check(row.approvals === "ask" && row.land === "at_end", "setKnob: both knobs land in their columns");
  for (const [knob, value] of [["enforcement", "deny"], ["approvals", "maybe"]]) {
    let err = null;
    try { setKnob({ taskDir: r.task_dir, knob, value }); } catch (e) { err = e; }
    check(err && /Remedy:/.test(err.message), `setKnob: ${knob}=${value} is refused with a remedy`);
  }
}

// closeTask archives, moves the whole home, and stamps nothing on the repo
{
  const repo = makeRepo("close");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Close", slug: "close", tier: "minor", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  fs.mkdirSync(path.join(r.task_dir, "plan"));
  fs.writeFileSync(path.join(r.task_dir, "plan", "phase-1-a.md"), "# plan\n");
  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  const archived = result.archivePath;
  check(result.action === "archive" && archived && fs.existsSync(archived), "closeTask: archives the folder whole");
  check(fs.existsSync(path.join(archived, "task.md")) && fs.existsSync(path.join(archived, "plan", "phase-1-a.md")), "closeTask: task.md and plan/ move with the folder");
  const row = db.getTask(db.taskIdOf(r.task_dir));
  check(row.disposition === "archived" && row.task_dir === archived, "closeTask: the row's task_dir is the archived folder");
  const repoRow = db.repoOf(key.key);
  check(!("disposition" in JSON.parse(repoRow.doc)), "closeTask: no disposition is stamped on the repo");
  const read = cli(["ls", "close", "--all", "--json", "--repo", repo]).json();
  check(read.dir === archived, `closeTask: a ls <task> --all names the archived folder (${read.dir})`);
  const view = require("./lib/task").readTaskJson(archived);
  check(view.phases[0].plan_path === "plan/phase-1-a.md", "closeTask: the archived view still reads the plan");

  const repo2 = makeRepo("close-delete");
  const key2 = repoKey(repo2);
  const r2 = createTask({ repo: key2, title: "Del", slug: "del", tier: "minor", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const del = closeTask({ taskDir: r2.task_dir, repoKeyObj: key2, delete: true });
  check(del.action === "delete" && fs.existsSync(del.trashed_to) && !fs.existsSync(r2.task_dir), "closeTask: delete moves the folder to trash, never removes it");
  check(db.getTask(db.taskIdOf(r2.task_dir)).disposition === "deleted", "closeTask: the delete row is marked");

  const repo3 = makeRepo("close-no-row");
  const key3 = repoKey(repo3);
  const empty = path.join(process.env.AGENTS_TASKS_ROOT, key3.key, "empty-dir");
  fs.mkdirSync(empty, { recursive: true });
  let err = null;
  try { closeTask({ taskDir: empty, repoKeyObj: key3 }); } catch (e) { err = e; }
  check(err && err.notFound === true, "closeTask: a dir with no row refuses not_found");
}

// Notes: the notes table, newest last
{
  const repo = makeRepo("notes");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Notes", slug: "notes", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const decide = require("./lib/decide");
  decide.note({ taskDir: r.task_dir, phaseId: 1, text: "first" });
  decide.note({ taskDir: r.task_dir, phaseId: null, text: "task-level" });
  const taskId = db.taskIdOf(r.task_dir);
  const notes = db.listNotes(taskId);
  check(notes.length === 2 && notes[0].text === "first" && notes[1].phase_id === null, "notes: two rows, the task-level one last");
  const next = cli(["next", "--task-dir", r.task_dir, "--repo", repo, "--json"]).json();
  check(next.notes.length === 2 && next.notes[0].note === "first" && next.notes[1].note === "task-level",
    "notes: a next --json lists both, newest last, from the notes table");
}

// The default list between commits (the shim): every phase checked keeps a task off the open picker
{
  const repo = makeRepo("default-list");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "All", slug: "all", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const ls = cli(["ls", "--json", "--repo", repo]).json();
  check(ls.tasks.some((t) => path.basename(t.dir) === "001-all"), "the default list shows the open task");
  checkPhase({ taskDir: r.task_dir, phaseId: 1 });
  const ls2 = cli(["ls", "--json", "--repo", repo]).json();
  check(!ls2.tasks.some((t) => path.basename(t.dir) === "001-all"), "the default list drops the all-checked task (the shim)");
}

// The repos store: createTask registers the repo; doctrine stores tiers; mainRootOf reads the row
{
  const repo = makeRepo("repos");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Repos", slug: "repos", session_id: "s", phases: [] });
  const row = db.repoOf(key.key);
  const doc = JSON.parse(row.doc);
  check(row.main_root === repo && doc.last_seen && row.ord < db.UNINDEXED_ORD, "repos store: createTask registers main_root with an ord below UNINDEXED_ORD");
  check(!fs.existsSync(path.join(process.env.AGENTS_TASKS_ROOT, "index.json")), "repos store: no index.json is written");
  cli(["tasks", "doctrine", '{"default":"standard"}', "--repo", repo]);
  check(JSON.parse(db.repoOf(key.key).doc).default_tiers.default === "standard", "repos store: a tasks doctrine stores default_tiers in the doc");
  const { mainRootOf } = require("./lib/tasks-root");
  const sub = path.join(process.env.AGENTS_TASKS_ROOT, key.key, "004-no-row-yet");
  check(mainRootOf(r.task_dir) === repo, "repos store: mainRootOf reads the row's main_root");
  check(mainRootOf(sub) === repo, "repos store: a dir under the repo's central folder with no task row still resolves (repoFor)");
  fs.rmSync(repo, { recursive: true, force: true });
  check(mainRootOf(r.task_dir) === null, "repos store: a gone main_root folder reads null");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
