#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { createTask } = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-task-test-")));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-tasks-root-"));

function makeRepo(name) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// Test 1: createTask assigns sequential numbers
{
  const repo = makeRepo("sequential");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "First", slug: "first", session_id: "s1" });
  const r2 = createTask({ repo: key, title: "Second", slug: "second", session_id: "s2" });
  if (r1.number === 1 && r2.number === 2) ok("createTask assigns sequential numbers 1, 2");
  else fail_(`numbers should be 1,2 got ${r1.number},${r2.number}`);
  if (r1.slug === "001-first" && r2.slug === "002-second") ok("slugs are zero-padded NNN-slug");
  else fail_(`slugs should be 001-first, 002-second got ${r1.slug}, ${r2.slug}`);
}

// Test 2: createTask writes task.md skeleton
{
  const repo = makeRepo("skeleton");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Test Task", slug: "test-task", description: "A test", session_id: "s" });
  const md = fs.readFileSync(path.join(r.task_dir, "task.md"), "utf8");
  if (md.includes("# Test Task")) ok("task.md contains the title as heading");
  else fail_("task.md should contain title");
  if (md.includes("A test")) ok("task.md contains the description");
  else fail_("task.md should contain description");
  if (md.includes("## Phases")) ok("task.md has Phases section");
  else fail_("task.md should have Phases section");
  if (md.includes("## Decision Log")) ok("task.md has Decision Log section");
  else fail_("task.md should have Decision Log section");
}

// Test 3: createTask writes task.json v2 (D33: no state.json)
{
  const repo = makeRepo("state");
  const key = repoKey(repo);
  const r = createTask({
    repo: key, title: "State Test", slug: "state-test",
    mode: "fast", phases: [{ id: 1, name: "Phase 1" }],
    session_id: "s",
  });
  // D33: createTask produces task.json, NOT state.json.
  if (fs.existsSync(path.join(r.task_dir, "state.json"))) fail_("createTask should NOT create state.json (D33)");
  else ok("createTask produces no state.json (D33)");
  if (!fs.existsSync(path.join(r.task_dir, "task.json"))) fail_("createTask should create task.json");
  else ok("createTask creates task.json");
  if (fs.existsSync(path.join(r.task_dir, "state.md"))) fail_("createTask should not render state.md");
  else ok("createTask renders no state.md");
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.schema === 2) ok("task.json has schema 2");
  else fail_("task.json should have schema 2, got " + task.schema);
  if (task.status === "planning") ok("task.json status is 'planning'");
  else fail_("task.json status should be 'planning'");
  if (task.mode === "fast") ok("task.json has mode field");
  else fail_("task.json should have mode field");
  if (task.phases.length === 1 && task.phases[0].status === "not_started") ok("task.json has phases with not_started");
  else fail_("task.json phases should be not_started");
  if (Array.isArray(task.flags) && task.flags.length === 0) ok("task.json has empty flags array");
  else fail_("task.json should have empty flags");
  if (task.slug === "state-test") ok("task.json slug preserved");
  else fail_("task.json slug should be state-test, got " + task.slug);
}

// Test 4: createTask with same slug creates incrementing numbers
{
  const repo = makeRepo("same-slug");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Same", slug: "same", session_id: "s" });
  const r2 = createTask({ repo: key, title: "Same", slug: "same", session_id: "s" });
  if (r1.number !== r2.number) ok("same slug gets different numbers (NNN increments)");
  else fail_("should get different numbers for same slug");
  if (r1.task_dir !== r2.task_dir) ok("same slug creates different directories");
  else fail_("should create different directories");
}

// Test 5: createTask without slug uses bare NNN directory name
{
  const repo = makeRepo("no-slug");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "No Slug", session_id: "s" });
  if (r.slug === "001") ok("createTask without slug uses bare NNN");
  else fail_(`slug should be '001', got '${r.slug}'`);
}

// Test 6: nextTaskNumber counts bare-NNN dirs (no hyphen) correctly
{
  const repo = makeRepo("bare-then-slug");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Bare", session_id: "s" });
  const r2 = createTask({ repo: key, title: "Slugged", slug: "slugged", session_id: "s" });
  if (r1.number === 1 && r2.number === 2) ok("bare-NNN then slugged: numbers are 1, 2");
  else fail_(`numbers should be 1,2 got ${r1.number},${r2.number}`);
  if (r1.slug === "001" && r2.slug === "002-slugged") ok("bare-NNN then slugged: slugs are 001, 002-slugged");
  else fail_(`slugs should be 001, 002-slugged got ${r1.slug}, ${r2.slug}`);
}

// Test 7: tier on createTask
{
  const repo = makeRepo("tier-default");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Standard Task", slug: "std", session_id: "s" });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.tier === "standard") ok("createTask default tier is standard");
  else fail_(`tier should be 'standard', got '${task.tier}'`);

  const repo2 = makeRepo("tier-strategic");
  const key2 = repoKey(repo2);
  const r2 = createTask({ repo: key2, title: "Strat", slug: "strat", tier: "strategic", session_id: "s" });
  const task2 = JSON.parse(fs.readFileSync(path.join(r2.task_dir, "task.json"), "utf8"));
  if (task2.tier === "strategic") ok("createTask --tier strategic persists");
  else fail_(`tier should be 'strategic', got '${task2.tier}'`);

  const repo3 = makeRepo("tier-fast");
  const key3 = repoKey(repo3);
  const r3 = createTask({ repo: key3, title: "Courier", slug: "cour", mode: "fast", session_id: "s" });
  const task3 = JSON.parse(fs.readFileSync(path.join(r3.task_dir, "task.json"), "utf8"));
  if (task3.tier === "minor") ok("createTask mode=fast defaults tier to minor");
  else fail_(`tier should be 'minor' for fast mode, got '${task3.tier}'`);
}

// Test 8: isTaskDone — done predicate (every phase landed/failed/skipped/done)
{
  const { isTaskDone } = require("./lib/task");
  const doneTask = { phases: [{ status: "landed" }, { status: "landed" }] };
  if (isTaskDone(doneTask)) ok("isTaskDone: all phases landed → true");
  else fail_("isTaskDone: all landed should be true");

  const partialTask = { phases: [{ status: "landed" }, { status: "in_progress" }] };
  if (!isTaskDone(partialTask)) ok("isTaskDone: one in_progress → false");
  else fail_("isTaskDone: one in_progress should be false");

  const emptyTask = { phases: [] };
  if (!isTaskDone(emptyTask)) ok("isTaskDone: no phases → false");
  else fail_("isTaskDone: no phases should be false");

  const mixedDone = { phases: [{ status: "failed" }, { status: "skipped" }] };
  if (isTaskDone(mixedDone)) ok("isTaskDone: failed+skipped → true");
  else fail_("isTaskDone: failed+skipped should be true");
}

// Test 10 (TC1, TC2): closeTask archives by default and trashes on the explicit {delete}
{
  const { closeTask } = require("./lib/task");
  const doneTask = (name, tier) => {
    const repo = makeRepo(name);
    const key = repoKey(repo);
    const r = createTask({ repo: key, title: "Close Task", slug: name, tier, session_id: "s", phases: [{id: 1, name: "P1"}] });
    const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
    task.phases.forEach((p) => { p.status = "landed"; });
    fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");
    return { key, dir: r.task_dir };
  };

  const minor = doneTask("close-minor", "minor");
  const result = closeTask({ taskDir: minor.dir, repoKeyObj: minor.key });
  if (result.action === "archive" && result.archivePath && fs.existsSync(result.archivePath)) ok("TC1: closeTask archives a done minor task");
  else fail_(`TC1: minor close should archive, got ${JSON.stringify(result)}`);
  if (!fs.existsSync(minor.dir)) ok("TC1: the minor task dir is gone from its place");
  else fail_("TC1: minor task dir should have moved");

  const std = doneTask("close-std", "standard");
  const stdResult = closeTask({ taskDir: std.dir, repoKeyObj: std.key });
  if (stdResult.action === "archive") ok("TC1: closeTask archives a standard task with nothing distilled");
  else fail_(`TC1: standard close should archive, got ${stdResult.action}`);

  const del = doneTask("close-delete", "minor");
  const delResult = closeTask({ taskDir: del.dir, repoKeyObj: del.key, delete: true });
  if (delResult.action === "delete" && delResult.trashed_to && fs.existsSync(delResult.trashed_to)) ok("TC2: closeTask({delete: true}) trashes the task");
  else fail_(`TC2: delete close should trash, got ${JSON.stringify(delResult)}`);
  if (!fs.existsSync(del.dir)) ok("TC2: the task dir is removed after delete");
  else fail_("TC2: task dir should not exist after delete");

  const strat = doneTask("close-strat", "strategic");
  let stratResult = null;
  try { stratResult = closeTask({ taskDir: strat.dir, repoKeyObj: strat.key }); } catch (e) { stratResult = { error: e.message }; }
  if (stratResult.action === "archive" && !fs.existsSync(strat.dir)) ok("TC3: a strategic task with nothing distilled is archived, not refused");
  else fail_(`TC3: strategic close should archive: ${JSON.stringify(stratResult)}`);
}

// Test 10b: closing a task removes its merged, clean worktree; the CLI says why a dirty one stays
{
  const { closeTask } = require("./lib/task");
  const worktree = require("./lib/worktree");
  const wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-task-wts-")));
  process.env.AGENTS_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-task-cfg-")), "config.json");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ worktrees_root: wtRoot }));
  const landAll = (dir) => {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    doc.phases.forEach((p) => { p.status = "landed"; });
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(doc, null, 2), "utf8");
  };

  const repo = fs.realpathSync(makeRepo("close-wt"));
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Wt Task", slug: "wt-close", tier: "minor", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const made = worktree.add({ projectDir: repo, taskDir: r.task_dir, force: true });
  landAll(r.task_dir);
  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  if (made.path === path.join(wtRoot, "close-wt", path.basename(r.task_dir)) && result.worktree && result.worktree.removed === true && !fs.existsSync(made.path)) ok("closeTask: the task's merged, clean worktree is removed");
  else fail_(`closeTask should remove the worktree: ${JSON.stringify(result.worktree)} at ${made.path}`);

  const r2 = createTask({ repo: key, title: "Dirty Task", slug: "wt-dirty", tier: "minor", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  const made2 = worktree.add({ projectDir: repo, taskDir: r2.task_dir, force: true });
  fs.writeFileSync(path.join(made2.path, "wip.txt"), "x\n");
  landAll(r2.task_dir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-task-home-"));
  const cli = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "bin", "a"), "task", "close", "--task-dir", r2.task_dir, "--repo", repo],
    { encoding: "utf8", env: { ...process.env, HOME: home }, cwd: repo });
  if (cli.status === 0 && cli.stderr.includes(`worktree kept: ${made2.path} (uncommitted changes)\n`) && fs.existsSync(made2.path)) ok("a task close: a dirty worktree stays and the CLI prints why");
  else fail_(`a task close should keep the dirty worktree: ${cli.status} ${cli.stderr}`);
}

// Test 11: closeTask — strategic with distilled_to archived
{
  const { closeTask } = require("./lib/task");
  const { archiveRoot } = require("./lib/tasks-root");
  const repo = makeRepo("close-strategic-arch");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Strat Task", slug: "strat-arch", tier: "strategic", session_id: "s", phases: [{id: 1, name: "P1"}] });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  task.phases[0].reports = { consolidator: { distilled_to: ["docs/adr-999.md"], proposals: [] } };
  fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  if (result.action === "archive") ok("closeTask: strategic with distilled_to archived");
  else fail_(`strategic with distilled should archive, got ${result.action}`);

  const expectedArchive = path.join(archiveRoot(), key.key, path.basename(r.task_dir));
  if (fs.existsSync(expectedArchive)) ok("closeTask: strategic archive path correct");
  else fail_(`strategic archive should exist at ${expectedArchive}`);
  if (!fs.existsSync(r.task_dir)) ok("closeTask: strategic original dir removed after archive");
  else fail_("strategic original dir should be removed after archive");
}

// Test 13: closeTask — standard with distilled_to archived
{
  const { closeTask } = require("./lib/task");
  const { archiveRoot } = require("./lib/tasks-root");
  const repo = makeRepo("close-std-arch");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Std Arch", slug: "std-arch", tier: "standard", session_id: "s", phases: [{id: 1, name: "P1"}] });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  task.phases[0].reports = { consolidator: { distilled_to: ["docs/adr.md"], proposals: [] } };
  fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  if (result.action === "archive") ok("closeTask: standard with distilled_to archived");
  else fail_(`standard with distilled should archive, got ${result.action}`);
  const expectedArchive = path.join(archiveRoot(), key.key, path.basename(r.task_dir));
  if (fs.existsSync(expectedArchive)) ok("closeTask: standard archive path correct");
  else fail_(`standard archive should exist at ${expectedArchive}`);
}

// Test 14: closeTask — standard without distilled_to deleted
{
  const { closeTask } = require("./lib/task");
  const repo = makeRepo("close-std-del");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Std Del", slug: "std-del", tier: "standard", session_id: "s", phases: [{id: 1, name: "P1"}] });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  task.phases[0].reports = { consolidator: null };
  fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  if (result.action === "archive") ok("closeTask: standard without distilled_to archived");
  else fail_(`standard without distilled should archive, got ${result.action}`);
  if (!fs.existsSync(r.task_dir)) ok("closeTask: standard task dir moved after archive");
  else fail_("closeTask: standard task dir should have moved to the archive");
}

// Test 15: closeTask archives a task whose phases are not checked
{
  const { closeTask } = require("./lib/task");
  const repo = makeRepo("close-not-done");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Not Done", slug: "not-done", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key });
  if (result.action === "archive" && !fs.existsSync(r.task_dir)) ok("closeTask: a task with an unchecked phase is archived, never refused");
  else fail_(`closeTask should archive an unchecked task: ${JSON.stringify(result)}`);
}

// Test 16: closeTask updates index.json disposition
{
  const { closeTask } = require("./lib/task");
  const { readRootIndex } = require("./lib/tasks-root");
  const repo = makeRepo("close-index-update");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Idx Update", slug: "idx-update", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  closeTask({ taskDir: r.task_dir, repoKeyObj: key, delete: true });
  const index = readRootIndex();
  if (index[key.key] && index[key.key].disposition === "deleted") ok("closeTask: index.json disposition=deleted after delete close");
  else fail_(`closeTask: index.json should have disposition=deleted, got ${JSON.stringify(index[key.key])}`);
}

// Test 17: createTask calls ensureMigrated first (D38 item 5)
// A repo with a repo-local .tasks/ should be migrated before creating a
// task in the central root. Without this, nextTaskNumber sees a half-moved
// repo and restarts numbering at 001.
{
  const { ensureMigrated } = require("./lib/tasks-root");
  const { hasLocalTasks } = require("./lib/tasks-root");
  const repo = makeRepo("ensure-migrated-test");

  // Create a repo-local .tasks/ with a v1 task (state.json, task.md)
  const localTasksDir = path.join(repo, ".tasks");
  fs.mkdirSync(path.join(localTasksDir, "042-old-task"), { recursive: true });
  fs.writeFileSync(
    path.join(localTasksDir, "042-old-task", "state.json"),
    JSON.stringify({ status: "planning", phases: [], flags: [] })
  );
  fs.writeFileSync(
    path.join(localTasksDir, "042-old-task", "task.md"),
    "---\ntask: Old Task\nslug: old-task\ncreated: 2026-10-01\nstatus: planning\n---\n\n# Old Task\n"
  );

  const key = repoKey(repo);
  if (!hasLocalTasks(key)) { fail_("T17: setup failed — .tasks/ not found"); }
  else {
    // createTask should call ensureMigrated, which moves .tasks/ to central
    // before creating the new task. The new task should get number 043, not 001.
    const r = createTask({ repo: key, title: "After Migrate", slug: "after-migrate", session_id: "s17" });
    if (r.number === 43) ok("T17: createTask calls ensureMigrated → numbering continues from existing (043, not 001)");
    else fail_(`T17: expected 043, got ${r.number}`);
    // Verify the old task was moved to central
    if (!hasLocalTasks(key)) ok("T17: repo-local .tasks/ removed after migrate");
    else fail_("T17: .tasks/ should be gone after ensureMigrated");
  }
}

// Test 18: fast mode creates one phase named after the title with correct knobs
{
  const repo = makeRepo("fast-mode");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Fix the bug", slug: "fix-bug", mode: "fast", session_id: "s18" });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.phases.length === 1) ok("T18: fast mode creates one phase");
  else fail_(`T18: expected 1 phase, got ${task.phases.length}`);
  if (task.phases[0].name === "Fix the bug") ok("T18: fast mode phase named after title");
  else fail_(`T18: phase name should be 'Fix the bug', got '${task.phases[0].name}'`);
  if (task.phases[0].status === "not_started") ok("T18: fast mode phase status not_started");
  else fail_(`T18: phase status should be not_started, got '${task.phases[0].status}'`);
  if (task.tier === "minor") ok("T18: fast mode tier=minor");
  else fail_(`T18: tier should be minor, got '${task.tier}'`);
}

// Test 19: fast mode with explicit phases keeps them (doesn't override)
{
  const repo = makeRepo("fast-explicit");
  const key = repoKey(repo);
  const r = createTask({
    repo: key, title: "Multi", slug: "multi", mode: "fast",
    phases: [{ id: 1, name: "P1" }, { id: 2, name: "P2" }],
    session_id: "s19",
  });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.phases.length === 2) ok("T19: fast mode with explicit phases keeps them");
  else fail_(`T19: expected 2 phases, got ${task.phases.length}`);
  if (task.knobs.land === "per_phase") ok("T19: fast mode with explicit phases keeps the default knobs");
  else fail_(`T19: knobs.land should be per_phase, got ${task.knobs.land}`);
}

// Test 20: non-fast mode still creates zero phases by default
{
  const repo = makeRepo("full-mode");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Full", slug: "full", session_id: "s20" });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.phases.length === 0) ok("T20: non-fast mode creates zero phases by default");
  else fail_(`T20: expected 0 phases, got ${task.phases.length}`);
  if (task.knobs.land === "per_phase") ok("T20: non-fast mode keeps default knobs");
  else fail_(`T20: knobs.land should be per_phase, got ${task.knobs.land}`);
}

// Test 21: closeTask moves to trash (D40) instead of rm
{
  const { closeTask } = require("./lib/task");
  const { tasksRootBase } = require("./lib/tasks-root");
  const repo = makeRepo("close-trash");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Trash Test", slug: "trash-test", tier: "minor", session_id: "s21", phases: [{id: 1, name: "P1"}] });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const result = closeTask({ taskDir: r.task_dir, repoKeyObj: key, delete: true });
  if (result.action === "delete") ok("T21: minor task close action=delete");
  else fail_(`T21: expected delete, got ${result.action}`);
  if (result.trashed_to) ok("T21: closeTask returns trashed_to");
  else fail_(`T21: should return trashed_to, got ${JSON.stringify(result)}`);
  if (fs.existsSync(result.trashed_to)) ok("T21: task moved to trash");
  else fail_(`T21: trash path should exist: ${result.trashed_to}`);
  if (!fs.existsSync(r.task_dir)) ok("T21: original task dir removed");
  else fail_("T21: original task dir should not exist");
}

fs.rmSync(tmpBase, { recursive: true, force: true });
// Test 22: addPhases upserts by id and never changes a status
{
  const { addPhases } = require("./lib/task");
  const repo = makeRepo("add-phases");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Add", slug: "add", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const file = path.join(r.task_dir, "task.json");
  const seeded = JSON.parse(fs.readFileSync(file, "utf8"));
  seeded.phases[0].status = "committed";
  fs.writeFileSync(file, JSON.stringify(seeded, null, 2), "utf8");
  addPhases({ taskDir: r.task_dir, phases: [{ id: 1, name: "One renamed", after: [] }, { id: 2, name: "Two", after: [1] }] });
  const task = JSON.parse(fs.readFileSync(file, "utf8"));
  if (task.phases.length === 2 && task.phases[0].name === "One renamed" && task.phases[0].status === "committed") ok("T22: an existing id changes its name and keeps its status");
  else fail_(`T22: existing phase mishandled: ${JSON.stringify(task.phases[0])}`);
  if (task.phases[1].status === "not_started" && task.phases[1].blocked_by.join() === "1") ok("T22: a new id appends a not_started phase that waits on after");
  else fail_(`T22: new phase mishandled: ${JSON.stringify(task.phases[1])}`);
  let err = null;
  try { addPhases({ taskDir: r.task_dir, phases: [{ id: "x", name: "bad" }] }); } catch (e) { err = e; }
  if (err && /Remedy:/.test(err.message) && err.code === "bad_phase") ok("T22: a malformed phase is refused with a remedy");
  else fail_(`T22: malformed phase should be refused with a remedy: ${err && err.message}`);
}

// Test 23: setKnob accepts approvals and land only
{
  const { setKnob } = require("./lib/task");
  const repo = makeRepo("set-knob");
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Knob", slug: "knob", session_id: "s", phases: [{ id: 1, name: "One" }] });
  setKnob({ taskDir: r.task_dir, knob: "approvals", value: "none" });
  setKnob({ taskDir: r.task_dir, knob: "land", value: "at_end" });
  const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
  if (task.knobs.approvals === "none" && task.knobs.land === "at_end") ok("T23: approvals and land are set");
  else fail_(`T23: knobs not set: ${JSON.stringify(task.knobs)}`);
  for (const [knob, value] of [["enforcement", "deny"], ["approvals", "maybe"]]) {
    let err = null;
    try { setKnob({ taskDir: r.task_dir, knob, value }); } catch (e) { err = e; }
    if (err && /Remedy:/.test(err.message)) ok(`T23: ${knob}=${value} is refused with a remedy`);
    else fail_(`T23: ${knob}=${value} should be refused with a remedy`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
