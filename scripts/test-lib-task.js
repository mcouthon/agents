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
  check(read.dir === r.task_dir && read.repo_key === key.key && Array.isArray(read.phases) && read.decisions !== undefined,
    "central-only: read returns the derived structure (the Design-4 view)");
  check(read.slug === "central" && read.phases.length === 1 && read.approvals === "none", "central-only: the view carries the phases and approvals none (the new-task default)");
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
  check(view.phases[0].checked === true && view.phases[1].checked === false && "status" in view.phases[0] === false, "checkPhase: only the checked phase reads checked in the view");
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

  const repo4 = makeRepo("close-folderless");
  const key4 = repoKey(repo4);
  const r4 = createTask({ repo: key4, title: "Gone", slug: "gone", tier: "minor", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  fs.rmSync(r4.task_dir, { recursive: true, force: true });
  let gone = null;
  let goneErr = null;
  try { gone = closeTask({ taskDir: r4.task_dir, repoKeyObj: key4 }); } catch (e) { goneErr = e; }
  check(gone && gone.action === "archive" && gone.archivePath === null && gone.folder === "missing",
    `closeTask: a row whose folder is gone archives the row only, saying folder missing (${goneErr ? goneErr.message : JSON.stringify(gone)})`);
  check(!fs.existsSync(r4.task_dir) && !fs.existsSync(path.join(process.env.AGENTS_TASKS_ROOT, "archive", key4.key)),
    "closeTask: the folderless close creates no folder anywhere");
  const row4 = db.getTask(db.taskIdOf(r4.task_dir));
  check(row4 && row4.disposition === "archived" && row4.task_dir === r4.task_dir,
    "closeTask: the folderless row reads archived, its task_dir unchanged");
}

// The single close: the task's row places the dir, its repo answers, and a folderless row closes
{
  const repoA = makeRepo("close-row-a");
  const repoB = makeRepo("close-row-b");
  const keyA = repoKey(repoA);
  const keyB = repoKey(repoB);
  const b = createTask({ repo: keyB, title: "Elsewhere", slug: "elsewhere", session_id: "s", phases: [{ id: 1, name: "P1" }] });

  // B's task closed from A's checkout: the folder moves under B's archive, the row reads archived
  const closed = cli(["task", "close", "--task-dir", b.task_dir, "--json"], { cwd: repoA });
  const out = JSON.parse(closed.out || "{}");
  const underB = path.join(process.env.AGENTS_TASKS_ROOT, "archive", keyB.key, "001-elsewhere");
  check(closed.status === 0 && out.action === "archive" && out.archivePath === underB,
    `close row: B's task closes from A's checkout under B's archive (${closed.status}: ${JSON.stringify(out)})`);
  check(fs.existsSync(underB) && !fs.existsSync(b.task_dir), "close row: the folder moved, the old dir is gone");
  const rowB = db.getTask(db.taskIdOf(underB));
  check(rowB && rowB.disposition === "archived" && rowB.task_dir === underB, "close row: B's row reads archived at the archive dir");
  check(!fs.existsSync(path.join(process.env.AGENTS_TASKS_ROOT, "archive", keyA.key)),
    "close row: nothing is created under A's archive");

  // a dir with no row is refused not_found (exit 4, as task read)
  const unknown = path.join(process.env.AGENTS_TASKS_ROOT, keyB.key, "999-never-made");
  const refused = cli(["task", "close", "--task-dir", unknown, "--json"], { cwd: repoA });
  const refusedOut = JSON.parse(refused.out || "{}");
  check(refused.status === 4 && refusedOut.error === "not_found",
    `close row: a dir with no row refuses not_found, exit 4 (${refused.status}: ${JSON.stringify(refusedOut)})`);

  // a row whose folder is gone closes in the database alone, from any checkout
  const repoC = makeRepo("close-row-c");
  const keyC = repoKey(repoC);
  const c = createTask({ repo: keyC, title: "Folderless", slug: "folderless", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  fs.rmSync(c.task_dir, { recursive: true, force: true });
  const folderless = cli(["task", "close", "--task-dir", c.task_dir, "--json"], { cwd: repoA });
  const fout = JSON.parse(folderless.out || "{}");
  check(folderless.status === 0 && fout.action === "archive" && fout.archivePath === null && fout.folder === "missing",
    `close row: a folderless row closes as archive/missing (${folderless.status}: ${JSON.stringify(fout)})`);
  check(!fs.existsSync(c.task_dir) && !fs.existsSync(path.join(process.env.AGENTS_TASKS_ROOT, "archive", keyC.key)),
    "close row: the folderless close creates no folder anywhere");
  const rowC = db.getTask(db.taskIdOf(c.task_dir));
  check(rowC && rowC.disposition === "archived" && rowC.task_dir === c.task_dir,
    "close row: the folderless row reads archived, its task_dir unchanged");
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

// The default list over the derived status: an all-checked task without a landing stays listed (it wants a land)
{
  const repo = makeRepo("default-list");
  // a bare origin (so the repo key is stable) and one commit ahead of it: the
  // task has unlanded work once its phase is checked
  const bare = path.join(T, "default-list-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "wip.txt"), "w\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "wip"], { cwd: repo });
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "All", slug: "all", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const ls = cli(["ls", "--json", "--repo", repo]).json();
  check(ls.tasks.some((t) => path.basename(t.dir) === "001-all"), "the default list shows the open task");
  checkPhase({ taskDir: r.task_dir, phaseId: 1 });
  const ls2 = cli(["ls", "--json", "--repo", repo]).json();
  const mine = ls2.tasks.find((t) => path.basename(t.dir) === "001-all");
  check(Boolean(mine) && mine.task_status === "open", "an all-checked task with no landing stays listed as open (the derived status)");
  check(Boolean(mine) && mine.advice && mine.advice.move === "land", "its advice moves to land");
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

// The batch close: an unresolved.json as --apply writes it, closed on the owner's word.
{
  const crypto = require("crypto");
  const { DatabaseSync } = (() => { const o = process.emitWarning; process.emitWarning = () => {}; try { return require("node:sqlite"); } finally { process.emitWarning = o; } })();
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-batchclose-")));
  for (const d of ["home", "tasks", "sessions"]) fs.mkdirSync(path.join(R, d));
  const repo = makeRepo("batchclose-repo");
  const key = repoKey(repo);
  const env = {
    ...process.env,
    HOME: path.join(R, "home"), AGENTS_TASKS_ROOT: path.join(R, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(R, "sessions"), AGENTS_DB: path.join(R, "agents.db"),
    AGENTS_TEST_SKIP_IDENTITY: "1",
  };
  const child = (args) => cli([...args, "--json"], { env });
  const rows = () => {
    const d = new DatabaseSync(env.AGENTS_DB, { readOnly: true });
    try { return d.prepare("SELECT * FROM tasks ORDER BY dir_name").all(); } finally { d.close(); }
  };
  const listing = (roots) => {
    const out = [];
    const walk = (label, dir) => {
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === ".lock" || (e.name === "trash" && dir === path.dirname(roots[label]))) continue;
          walk(label, p);
        } else if (e.isFile()) {
          // task.md is excluded: the close renders the finalize answer into it, by design
          if (e.name !== "task.md") {
            out.push(`${label}:${path.relative(roots[label], p)} ${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16)}`);
          }
        }
      }
    };
    for (const [label, root] of Object.entries(roots)) walk(label, root);
    return out.join("\n");
  };
  const ROOTS = { T: path.join(R, "tasks"), S: path.join(R, "sessions") };

  // five all-checked unresolved tasks, then the --apply that writes unresolved.json
  const names = ["001-a", "002-b", "003-c", "004-d", "005-e"];
  for (const [i, name] of names.entries()) {
    const made = child(["task", "new", "--title", name, "--slug", name.slice(4), "--repo", repo, "--phases-json", JSON.stringify([{ id: 1, name: "One" }])]);
    check(made.status === 0, `batch: ${name} is created (${made.status}: ${made.err.slice(0, 80)})`);
    child(["task", "check", "--task-dir", JSON.parse(made.out).task_dir, "--phase-id", "1", "--repo", repo]);
  }
  check(rows().length === 5, `batch: five rows in the database (${rows().length})`);
  const applied = child(["task", "import", "--apply"]);
  const appliedOut = JSON.parse(applied.out);
  check(applied.status === 0 && appliedOut.unresolved_json && appliedOut.unresolved.length === 5,
    `batch: the apply writes unresolved.json with the five (${applied.status}: ${applied.err.slice(0, 120)})`);
  check(/unresolved\.json$/.test(appliedOut.unresolved_json) && appliedOut.close_line === `a task close --batch ${appliedOut.unresolved_json} --quote "<owner's words>"`,
    `batch: the apply prints the one batch-close line (${appliedOut.close_line})`);
  const bundle = path.dirname(appliedOut.unresolved_json);

  // one task gains a phase and a checkmark since; one gets a live session; one moves outside the root
  const dirsOf = (name) => rows().find((r) => r.dir_name === name);
  child(["task", "add-phases", "--task-dir", dirsOf("003-c").task_dir, "--repo", repo, "--phases-json", JSON.stringify([{ id: 2, name: "Rework", after: [1] }])]);
  child(["task", "check", "--task-dir", dirsOf("003-c").task_dir, "--phase-id", "2", "--repo", repo]);
  fs.mkdirSync(path.join(env.AGENTS_SESSIONS_ROOT, "live-d"));
  fs.writeFileSync(path.join(env.AGENTS_SESSIONS_ROOT, "live-d", "registration.json"),
    JSON.stringify({ session_id: "live-d", repo_key: key.key, task_dir: dirsOf("004-d").task_dir, agent: "conductor", pid: process.pid, created_at: "2026-10-31T10:00:00.000Z" }) + "\n");
  const outside = path.join(`${R}-other`, "005-e");
  fs.mkdirSync(outside, { recursive: true });
  {
    const d = new DatabaseSync(env.AGENTS_DB);
    d.prepare("UPDATE tasks SET task_dir = ? WHERE dir_name = '005-e'").run(outside);
    d.close();
  }
  const before = listing(ROOTS);
  const beforeRows = rows();

  // without --quote nothing changes
  const unquoted = child(["task", "close", "--batch", appliedOut.unresolved_json]);
  check(unquoted.status === 2 && /owner's words/.test(unquoted.err), `batch: without --quote it exits 2 (${unquoted.status}: ${unquoted.err.slice(0, 80)})`);
  check(listing(ROOTS) === before && JSON.stringify(rows()) === JSON.stringify(beforeRows), "batch: the unquoted refusal changes nothing");

  // with the owner's words: the two unchanged close, the others say why
  const closed = child(["task", "close", "--batch", appliedOut.unresolved_json, "--quote", "close them"]);
  const closedOut = JSON.parse(closed.out || "{}");
  check(closed.status === 0 && closedOut.text === "closed 2, not closed 3",
    `batch: the line reads closed 2, not closed 3 (${closed.status}: ${JSON.stringify(closedOut.text)})`);
  const byDir = Object.fromEntries((closedOut.not_closed || []).map((c) => [c.dir, c.reason]));
  check(byDir["003-c"] === "changed, not closed" && byDir["004-d"] === "in use" && byDir["005-e"] === "outside sandbox",
    `batch: each not-closed task carries its reason (${JSON.stringify(byDir)})`);
  const afterRows = rows();
  const rowOf = (name, list) => list.find((r) => r.dir_name === name);
  for (const name of ["001-a", "002-b"]) {
    const after = rowOf(name, afterRows);
    const before2 = rowOf(name, beforeRows);
    const changedCols = Object.keys(after).filter((c) => after[c] !== before2[c]);
    check(after.disposition === "archived" && /archive/.test(after.task_dir) && JSON.stringify(changedCols.sort()) === JSON.stringify(["disposition", "task_dir"]),
      `batch: ${name} archived with only disposition and task_dir changed (${JSON.stringify(changedCols)})`);
    const dd = new DatabaseSync(env.AGENTS_DB, { readOnly: true });
    const answers = dd.prepare("SELECT * FROM decisions WHERE task_id = ? AND choice = 'answer'").all(after.id);
    const closes = dd.prepare("SELECT count(*) AS n FROM events WHERE task_id = ? AND kind = 'close'").get(after.id);
    dd.close();
    check(answers.length === 1 && answers[0].phase_id === null && answers[0].gate === "finalize" && answers[0].quote === "close them",
      `batch: ${name} holds one task-level finalize answer with the owner's words`);
    check(closes.n === 1, `batch: ${name} holds one close event`);
    const ls = child(["ls", after.task_dir, "--all", "--repo", repo]);
    check(ls.status === 0 && JSON.parse(ls.out).dir === after.task_dir, `batch: a ls ${name} --all names the archive dir (${ls.status})`);
  }
  for (const name of ["003-c", "004-d"]) {
    const after = rowOf(name, afterRows);
    const before2 = rowOf(name, beforeRows);
    check(after.disposition === "active" && after.task_dir === before2.task_dir, `batch: ${name} stays untouched`);
  }

  // the manifest gains the archive moves; undo.sh puts both folders back
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  const archiveMoves = manifest.ops.filter((o) => o.op === "move" && /archive/.test(o.to));
  check(archiveMoves.length === 2 && archiveMoves.every((m) => /00[12]-/.test(m.from)),
    `batch: the manifest holds the two archive moves (${JSON.stringify(archiveMoves.map((m) => m.from))})`);
  const undo = spawnSync("sh", [path.join(bundle, "undo.sh")], { encoding: "utf8" });
  check(undo.status === 0 && /restored \d+, skipped 0/.test(undo.stdout),
    `batch: undo.sh restores and exits 0 (${undo.status}: ${undo.stdout.trim().slice(0, 80)})`);
  const diff = (a, b) => {
    const A = new Set(a.split("\n")), B = new Set(b.split("\n"));
    return [...A].filter((x) => !B.has(x)).concat([...B].filter((x) => !A.has(x))).slice(0, 6);
  };
  check(listing(ROOTS) === before, `batch: after undo the recursive listing equals the pre-close state (${JSON.stringify(diff(listing(ROOTS), before))})`);

  fs.rmSync(R, { recursive: true, force: true });
  fs.rmSync(`${R}-other`, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
