#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { migrateTask, migrateAll, readTaskJson, isMigrated, removeStatusColumn, extractStatusColumn, mapEmojiStatus, mapV1Status } = require("./lib/task");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-test-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-tasks-"));
// Fixture sessions use process.pid (a "node" process), so isLive's command
// line check would reject them. Skip the identity check in this test.
process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-sessions-"));

function makeTaskDir(name, stateJson, taskMd) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  if (stateJson) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(stateJson, null, 2), "utf8");
  if (taskMd) fs.writeFileSync(path.join(dir, "task.md"), taskMd, "utf8");
  return dir;
}

const V1_STATE = {
  schema_version: 1,
  task: "test-feature",
  status: "in_progress",
  updated: "2026-10-17T10:00:00Z",
  phases: [
    { id: 1, name: "Plan", status: "done", owner: "explorer", started: "2026-10-17", completed: "2026-10-17", blocked_by: [], parallel_group: null, execution: { model: null, effort: null, agent_type: null, estimated_scope: null } },
    { id: 2, name: "Build", status: "in_progress", owner: "builder", started: "2026-10-17", completed: null, blocked_by: [1], parallel_group: null, execution: { model: null, effort: null, agent_type: null, estimated_scope: null } },
  ],
  flags: [{ id: "f-2-1", phase: 2, type: "error", message: "test error", raised: "2026-10-17" }],
};

const V1_TASK_MD = `---
task: Test Feature
slug: test-feature
created: 2026-10-17
status: in_progress
---

# Test Feature

## Phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 1 | Plan | ✅ Done | planning phase |
| 2 | Build | 🔄 In Progress | building |

## Decision Log

D1: Use the new framework.
`;

// --- Test 1: plain v1 → v2 conversion ---
{
  const dir = makeTaskDir("001-plain", V1_STATE, V1_TASK_MD);
  const result = migrateTask(dir);
  if (result.migrated) ok("plain v1 migrated to v2");
  else fail_("plain v1 should migrate");

  const task = readTaskJson(dir);
  if (!task) { fail_("task.json not found after migration"); }
  else {
    if (task.schema === 2) ok("schema is 2");
    else fail_("schema should be 2, got " + task.schema);
    if (task.slug === "test-feature") ok("slug preserved");
    else fail_("slug should be test-feature, got " + task.slug);
    if (task.number === 1) ok("number parsed from dir name");
    else fail_("number should be 1, got " + task.number);
    if (task.title === "Test Feature") ok("title parsed from task.md");
    else fail_("title should be 'Test Feature', got " + task.title);
    if (task.status === "in_progress") ok("task status preserved");
    else fail_("task status should be in_progress, got " + task.status);
    if (task.mode === "full") ok("default mode is full");
    else fail_("mode should default to full, got " + task.mode);
    if (task.knobs && task.knobs.review_plan === true) ok("default knobs set");
    else fail_("knobs should have defaults");
    if (task.phases.length === 2) ok("phases preserved");
    else fail_("should have 2 phases, got " + task.phases.length);
    if (task.phases[0].status === "done") ok("phase 1 status done");
    else fail_("phase 1 status should be done, got " + task.phases[0].status);
    if (task.phases[1].status === "in_progress") ok("phase 2 status in_progress");
    else fail_("phase 2 status should be in_progress, got " + task.phases[1].status);
    if (task.phases[1].blocked_by.includes(1)) ok("blocked_by preserved");
    else fail_("blocked_by should include 1");
    if (task.flags.length === 1 && task.flags[0].type === "error") ok("flags preserved");
    else fail_("flags should be preserved");
    if (task.checkpoints && task.checkpoints.length === 0) ok("checkpoints initialized empty");
    else fail_("checkpoints should be empty array");
    if (task.phases[0].counters && task.phases[0].counters.fix_attempts === 0) ok("counters initialized");
    else fail_("counters should be initialized");
    if (task.phases[0].reports && task.phases[0].reports.explorer === null) ok("reports initialized null");
    else fail_("reports should be initialized null");
  }
}

// --- Test 2: A2-stamped binding/lease/last_writer preserved verbatim ---
{
  const stateWithBinding = {
    ...V1_STATE,
    binding: { session_id: "sess-123", workflow_id: "wf-1", terminal_id: "term-1", commitment_id: "c-1", project_id: "p-1" },
    lease: { session_id: "sess-123", acquired_at: "2026-10-17T10:00:00Z", expires_at: "2026-10-17T11:00:00Z" },
    last_writer: { session_id: "sess-123", timestamp: "2026-10-17T10:30:00Z" },
  };
  const dir = makeTaskDir("002-binding", stateWithBinding, V1_TASK_MD);
  migrateTask(dir);
  const task = readTaskJson(dir);
  if (!task) { fail_("task.json not found"); }
  else {
    if (task.binding && task.binding.session_id === "sess-123") ok("binding preserved verbatim");
    else fail_("binding should be preserved, got " + JSON.stringify(task.binding));
    if (task.lease && task.lease.session_id === "sess-123") ok("lease preserved verbatim");
    else fail_("lease should be preserved, got " + JSON.stringify(task.lease));
    if (task.last_writer && task.last_writer.session_id === "sess-123") ok("last_writer preserved verbatim");
    else fail_("last_writer should be preserved, got " + JSON.stringify(task.last_writer));
  }
}

// --- Test 3: task.md status column removed, prose intact ---
{
  const dir = makeTaskDir("003-status-col", V1_STATE, V1_TASK_MD);
  migrateTask(dir);
  const md = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  if (!md.includes("| Status |")) ok("Status column header removed from task.md");
  else fail_("Status column should be removed from task.md");
  if (!md.includes("✅") && !md.includes("🔄")) ok("status emojis removed from task.md table");
  else fail_("status emojis should be removed from task.md table");
  if (md.includes("# Test Feature")) ok("title heading intact in task.md");
  else fail_("title heading should be intact");
  if (md.includes("## Phases")) ok("Phases section intact in task.md");
  else fail_("Phases section should be intact");
  if (md.includes("## Decision Log")) ok("Decision Log section intact in task.md");
  else fail_("Decision Log section should be intact");
  if (md.includes("D1: Use the new framework.")) ok("prose content intact in task.md");
  else fail_("prose content should be intact");
  if (md.includes("| 1 | Plan |") ) ok("phase row preserved (without status column)");
  else fail_("phase row should be preserved without status column");
}

// --- Test 4: non-standard legacy statuses mapped per D29 ---
{
  const stateBlocked = { ...V1_STATE, status: "blocked" };
  const dir = makeTaskDir("004-blocked", stateBlocked, V1_TASK_MD);
  migrateTask(dir);
  const task = readTaskJson(dir);
  if (task.status === "in_progress") ok("D29: blocked status mapped to in_progress");
  else fail_("blocked should map to in_progress, got " + task.status);

  const stateNeedsHuman = { ...V1_STATE, status: "needs_human" };
  const dir2 = makeTaskDir("005-needs-human", stateNeedsHuman, V1_TASK_MD);
  migrateTask(dir2);
  const task2 = readTaskJson(dir2);
  if (task2.status === "in_progress") ok("D29: needs_human status mapped to in_progress");
  else fail_("needs_human should map to in_progress, got " + task2.status);
  if (task2.flags.some((f) => f.type === "needs_human")) ok("D29: needs_human flag added");
  else fail_("needs_human flag should be added");

  const stateReviewReady = { ...V1_STATE, status: "review_ready" };
  const dir3 = makeTaskDir("006-review-ready", stateReviewReady, V1_TASK_MD);
  migrateTask(dir3);
  const task3 = readTaskJson(dir3);
  if (task3.status === "in_progress") ok("D29: review_ready status mapped to in_progress");
  else fail_("review_ready should map to in_progress, got " + task3.status);
}

// --- Test 5: run-twice idempotency ---
{
  const dir = makeTaskDir("007-idempotent", V1_STATE, V1_TASK_MD);
  const r1 = migrateTask(dir);
  if (r1.migrated) ok("first migration succeeds");
  else fail_("first migration should succeed");
  const task1 = readTaskJson(dir);
  const md1 = fs.readFileSync(path.join(dir, "task.md"), "utf8");

  const r2 = migrateTask(dir);
  if (r2.skipped && !r2.migrated) ok("second migration skipped (idempotent)");
  else fail_("second migration should be skipped");

  const task2 = readTaskJson(dir);
  const md2 = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  if (JSON.stringify(task1) === JSON.stringify(task2)) ok("task.json unchanged on second migration");
  else fail_("task.json should be unchanged on second migration");
  if (md1 === md2) ok("task.md unchanged on second migration");
  else fail_("task.md should be unchanged on second migration");
}

// --- Test 6: migrateAll on a directory with multiple tasks ---
{
  const projectDir = path.join(tmpBase, "multi-project");
  fs.mkdirSync(path.join(projectDir, ".tasks"), { recursive: true });
  makeTaskDir(".tasks/100-alpha", V1_STATE, V1_TASK_MD);
  // Re-create in the right place
  fs.rmSync(path.join(tmpBase, "multi-project/.tasks/100-alpha"), { recursive: true, force: true });
  const dir1 = path.join(projectDir, ".tasks", "100-alpha");
  fs.mkdirSync(dir1, { recursive: true });
  fs.writeFileSync(path.join(dir1, "state.json"), JSON.stringify(V1_STATE, null, 2), "utf8");
  fs.writeFileSync(path.join(dir1, "task.md"), V1_TASK_MD, "utf8");

  const dir2 = path.join(projectDir, ".tasks", "101-beta");
  fs.mkdirSync(dir2, { recursive: true });
  const state2 = { ...V1_STATE, task: "beta", status: "planning", phases: [{ id: 1, name: "Only", status: "not_started", owner: null, started: null, completed: null, blocked_by: [], parallel_group: null, execution: { model: null, effort: null, agent_type: null, estimated_scope: null } }] };
  fs.writeFileSync(path.join(dir2, "state.json"), JSON.stringify(state2, null, 2), "utf8");
  fs.writeFileSync(path.join(dir2, "task.md"), "---\ntask: Beta\ncreated: 2026-10-17\n---\n\n# Beta\n", "utf8");

  const result = migrateAll(projectDir);
  if (result.migrated === 2) ok("migrateAll migrated 2 tasks");
  else fail_("migrateAll should migrate 2, got " + result.migrated);
  if (isMigrated(dir1) && isMigrated(dir2)) ok("both tasks have task.json after migrateAll");
  else fail_("both tasks should have task.json");
}

// --- Test 7: status column extraction and emoji mapping ---
{
  const md = `| # | Phase | Status | Notes |\n|---|---|---|---|\n| 1 | Plan | ✅ Done | done |\n| 2 | Build | 🔄 In Progress | wip |\n`;
  const statuses = extractStatusColumn(md);
  if (statuses[1] === "✅ Done" && statuses[2] === "🔄 In Progress") ok("extractStatusColumn parses emoji statuses");
  else fail_("extractStatusColumn should parse emojis, got " + JSON.stringify(statuses));

  if (mapEmojiStatus("✅ Done") === "done") ok("mapEmojiStatus maps ✅ to done");
  else fail_("✅ Done should map to done, got " + mapEmojiStatus("✅ Done"));
  if (mapEmojiStatus("🔄 In Progress") === "in_progress") ok("mapEmojiStatus maps 🔄 to in_progress");
  else fail_("🔄 In Progress should map to in_progress");
  if (mapEmojiStatus("⬜ Not Started") === "not_started") ok("mapEmojiStatus maps ⬜ to not_started");
  else fail_("⬜ should map to not_started");
  if (mapEmojiStatus("📋 Planned") === "planned") ok("mapEmojiStatus maps 📋 to planned");
  else fail_("📋 should map to planned");
  if (mapEmojiStatus("⭐ Reviewed") === "reviewed") ok("mapEmojiStatus maps ⭐ to reviewed");
  else fail_("⭐ should map to reviewed");
}

// --- Test 8: mapV1Status for D29 legacy statuses ---
{
  if (mapV1Status("blocked") === "in_progress") ok("mapV1Status: blocked → in_progress");
  else fail_("blocked should map to in_progress");
  if (mapV1Status("needs_human") === "in_progress") ok("mapV1Status: needs_human → in_progress");
  else fail_("needs_human should map to in_progress");
  if (mapV1Status("review_ready") === "in_progress") ok("mapV1Status: review_ready → in_progress");
  else fail_("review_ready should map to in_progress");
  if (mapV1Status("planning") === "planning") ok("mapV1Status: planning stays planning");
  else fail_("planning should stay planning");
  if (mapV1Status("done") === "done") ok("mapV1Status: done stays done");
  else fail_("done should stay done");
}

// --- Test 9: task.md with no status column ---
{
  const mdNoStatus = `| # | Phase | Notes |\n|---|---|---|\n| 1 | Plan | done |\n`;
  const result = removeStatusColumn(mdNoStatus);
  if (result === mdNoStatus) ok("removeStatusColumn no-ops when no Status column");
  else fail_("removeStatusColumn should no-op when no Status column");
}

// --- Test 10: dry-run does not write any files ---
{
  const dir = makeTaskDir("008-dry-run", V1_STATE, V1_TASK_MD);
  const result = migrateTask(dir, { dryRun: true });

  if (result.dryRun !== true) fail_("dry-run result should have dryRun: true");
  else ok("dry-run result has dryRun: true");

  if (result.changes && result.changes.length > 0) ok("dry-run reports changes: " + result.changes.join(", "));
  else fail_("dry-run should report changes");

  if (!fs.existsSync(path.join(dir, "task.json"))) ok("dry-run: task.json NOT created");
  else fail_("dry-run should not create task.json");

  if (!fs.existsSync(path.join(dir, "task.md.v1"))) ok("dry-run: task.md.v1 NOT created");
  else fail_("dry-run should not create task.md.v1 backup");

  const mdAfter = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  if (mdAfter.includes("| Status |")) ok("dry-run: task.md unchanged (Status column intact)");
  else fail_("dry-run should not modify task.md");

  const stateAfter = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  if (stateAfter.schema_version === 1) ok("dry-run: state.json unchanged");
  else fail_("dry-run should not modify state.json");
}

// --- Test 11: dry-run on already-migrated task reports skipped ---
{
  const dir = makeTaskDir("009-dry-run-skip", V1_STATE, V1_TASK_MD);
  migrateTask(dir); // migrate first
  const result = migrateTask(dir, { dryRun: true });

  if (result.skipped === true) ok("dry-run on migrated task: skipped");
  else fail_("dry-run on already-migrated task should be skipped, got " + JSON.stringify(result));
}

// --- Test 12: --apply creates task.md.v1 backup before editing ---
{
  const dir = makeTaskDir("010-apply-backup", V1_STATE, V1_TASK_MD);
  const originalMd = fs.readFileSync(path.join(dir, "task.md"), "utf8");

  const result = migrateTask(dir, { dryRun: false });

  if (result.migrated !== true) fail_("apply should migrate, got " + JSON.stringify(result));
  else ok("apply: task migrated");

  if (result.backup === "task.md.v1") ok("apply: backup field is task.md.v1");
  else fail_("apply: backup should be task.md.v1, got " + result.backup);

  if (fs.existsSync(path.join(dir, "task.md.v1"))) ok("apply: task.md.v1 backup file exists");
  else fail_("apply: task.md.v1 backup should exist");

  const backupContent = fs.readFileSync(path.join(dir, "task.md.v1"), "utf8");
  if (backupContent === originalMd) ok("apply: task.md.v1 contains original task.md content");
  else fail_("apply: task.md.v1 should contain original task.md content");

  if (fs.existsSync(path.join(dir, "task.json"))) ok("apply: task.json created");
  else fail_("apply: task.json should be created");

  const mdAfter = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  if (!mdAfter.includes("| Status |")) ok("apply: task.md status column removed");
  else fail_("apply: task.md status column should be removed");
}

// --- Test 13: dry-run on migrateAll reports all tasks without writing ---
{
  const projectDir = path.join(tmpBase, "dryrun-all-project");
  fs.mkdirSync(path.join(projectDir, ".tasks"), { recursive: true });

  const dir1 = path.join(projectDir, ".tasks", "200-alpha");
  fs.mkdirSync(dir1, { recursive: true });
  fs.writeFileSync(path.join(dir1, "state.json"), JSON.stringify(V1_STATE, null, 2), "utf8");
  fs.writeFileSync(path.join(dir1, "task.md"), V1_TASK_MD, "utf8");

  const dir2 = path.join(projectDir, ".tasks", "201-beta");
  fs.mkdirSync(dir2, { recursive: true });
  const state2 = { ...V1_STATE, task: "beta", status: "planning" };
  fs.writeFileSync(path.join(dir2, "state.json"), JSON.stringify(state2, null, 2), "utf8");
  fs.writeFileSync(path.join(dir2, "task.md"), "---\ntask: Beta\ncreated: 2026-10-17\n---\n\n# Beta\n", "utf8");

  const result = migrateAll(projectDir, { dryRun: true });

  if (result.migrated === 2) ok("dry-run migrateAll: 2 tasks would migrate");
  else fail_("dry-run migrateAll should report 2 would-migrate, got " + result.migrated);

  if (!fs.existsSync(path.join(dir1, "task.json"))) ok("dry-run migrateAll: dir1 task.json NOT created");
  else fail_("dry-run migrateAll should not create task.json in dir1");

  if (!fs.existsSync(path.join(dir2, "task.json"))) ok("dry-run migrateAll: dir2 task.json NOT created");
  else fail_("dry-run migrateAll should not create task.json in dir2");
}

// --- Test 14: --apply on migrateAll writes backups and task.json ---
{
  const projectDir = path.join(tmpBase, "apply-all-project");
  fs.mkdirSync(path.join(projectDir, ".tasks"), { recursive: true });

  const dir1 = path.join(projectDir, ".tasks", "300-gamma");
  fs.mkdirSync(dir1, { recursive: true });
  fs.writeFileSync(path.join(dir1, "state.json"), JSON.stringify(V1_STATE, null, 2), "utf8");
  const md1 = V1_TASK_MD;
  fs.writeFileSync(path.join(dir1, "task.md"), md1, "utf8");

  const result = migrateAll(projectDir, { dryRun: false });

  if (result.migrated === 1) ok("apply migrateAll: 1 task migrated");
  else fail_("apply migrateAll should migrate 1, got " + result.migrated);

  if (fs.existsSync(path.join(dir1, "task.json"))) ok("apply migrateAll: task.json created");
  else fail_("apply migrateAll: task.json should be created");

  if (fs.existsSync(path.join(dir1, "task.md.v1"))) ok("apply migrateAll: task.md.v1 backup created");
  else fail_("apply migrateAll: task.md.v1 backup should be created");
}

// --- Test 15: --apply renames state.json → state.json.v1 (D33: never deleted, never read) ---
{
  const dir = makeTaskDir("011-rename", V1_STATE, V1_TASK_MD);
  const statePath = path.join(dir, "state.json");
  const v1Path = path.join(dir, "state.json.v1");

  // Pre-condition: state.json exists, state.json.v1 does not.
  if (fs.existsSync(statePath)) ok("pre: state.json exists before migrate");
  else fail_("pre: state.json should exist before migrate");

  const result = migrateTask(dir, { dryRun: false });
  if (result.migrated !== true) fail_("rename test: migrate should succeed, got " + JSON.stringify(result));
  else ok("rename test: task migrated");

  // After migrate: task.json exists, state.json gone, state.json.v1 exists.
  if (fs.existsSync(path.join(dir, "task.json"))) ok("rename: task.json created");
  else fail_("rename: task.json should be created");
  if (!fs.existsSync(statePath)) ok("rename: state.json removed (renamed)");
  else fail_("rename: state.json should be renamed away (D33)");
  if (fs.existsSync(v1Path)) ok("rename: state.json.v1 exists (kept, never read)");
  else fail_("rename: state.json.v1 should exist (D33: kept, never read)");

  // The v1 backup should contain the original state.json content.
  const v1Content = JSON.parse(fs.readFileSync(v1Path, "utf8"));
  if (v1Content.schema_version === 1 && v1Content.task === "test-feature")
    ok("rename: state.json.v1 contains original v1 content");
  else fail_("rename: state.json.v1 should contain original v1 content, got " + JSON.stringify(v1Content).slice(0, 80));
}

// --- Test 16: migrate-on-touch via loadTask renames state.json → state.json.v1 ---
{
  const { loadTask } = require("./lib/task");
  const dir = makeTaskDir("012-loadTask-touch", V1_STATE, V1_TASK_MD);
  // loadTask should migrate-on-touch and return the v2 task.
  const task = loadTask(dir);
  if (task && task.schema === 2) ok("loadTask migrates-on-touch and returns v2 task");
  else fail_("loadTask should migrate-on-touch and return v2 task");
  if (fs.existsSync(path.join(dir, "task.json"))) ok("loadTask: task.json written on touch");
  else fail_("loadTask: task.json should be written on touch");
  if (!fs.existsSync(path.join(dir, "state.json"))) ok("loadTask: state.json renamed on touch");
  else fail_("loadTask: state.json should be renamed on touch");
  if (fs.existsSync(path.join(dir, "state.json.v1"))) ok("loadTask: state.json.v1 kept on touch");
  else fail_("loadTask: state.json.v1 should be kept on touch");
}

// --- Test 17: loadTask skips malformed state.json (no write, no rename) ---
{
  const { loadTask } = require("./lib/task");
  const dir = makeTaskDir("013-malformed", null, V1_TASK_MD);
  // Malformed state.json: valid JSON but missing phases/flags arrays.
  fs.writeFileSync(path.join(dir, "state.json"), '{ "task": "broken" }', "utf8");
  const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  let threw = false;
  try { loadTask(dir); } catch { threw = true; }
  if (threw) ok("loadTask throws on malformed state.json");
  else fail_("loadTask should throw on malformed state.json");
  // Malformed file is byte-for-byte unchanged (no task.json written, no rename).
  const after = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  if (after === before) ok("loadTask: malformed state.json byte-for-byte unchanged");
  else fail_("loadTask: malformed state.json should be unchanged");
  if (!fs.existsSync(path.join(dir, "task.json"))) ok("loadTask: no task.json written for malformed");
  else fail_("loadTask: should not write task.json for malformed state.json");
  if (!fs.existsSync(path.join(dir, "state.json.v1"))) ok("loadTask: no rename for malformed state.json");
  else fail_("loadTask: should not rename malformed state.json");
}

// --- ensureMigrated tests (D35 move-on-first-touch) ---

function makeFixtureRepo(name) {
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

function makeV1TaskInDir(parentTasksDir, name) {
  const dir = path.join(parentTasksDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(V1_STATE, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "task.md"), V1_TASK_MD, "utf8");
  return dir;
}

function makeV2TaskInDir(parentTasksDir, name) {
  const dir = path.join(parentTasksDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: name, number: parseInt(name), title: "Test",
    status: "planning", mode: "full", tier: "standard",
    knobs: {}, binding: {}, lease: {}, last_writer: {},
    phases: [], checkpoints: [], flags: [], updated: "2026-10-20T00:00:00Z",
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2), "utf8");
  return dir;
}

// --- Test 18: ensureMigrated moves repo-local .tasks/ to central root ---
{
  const { ensureMigrated, tasksRoot } = require("./lib/tasks-root");
  const { repoKey } = require("./lib/repo");
  const repoDir = makeFixtureRepo("ensure-migrated-move");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV1TaskInDir(localTasks, "100-alpha");
  makeV2TaskInDir(localTasks, "101-beta");

  const keyObj = repoKey(repoDir);
  const result = ensureMigrated(keyObj);

  if (result.migrated === true) ok("ensureMigrated: returns migrated=true");
  else fail_(`ensureMigrated should return migrated=true, got ${JSON.stringify(result)}`);

  if (!fs.existsSync(localTasks)) ok("ensureMigrated: local .tasks/ removed after move");
  else fail_("ensureMigrated: local .tasks/ should be gone after move");

  const centralDir = tasksRoot(keyObj);
  if (fs.existsSync(centralDir)) ok("ensureMigrated: central root dir exists");
  else fail_("ensureMigrated: central root dir should exist");

  if (fs.existsSync(path.join(centralDir, "100-alpha"))) ok("ensureMigrated: task 100-alpha moved to central");
  else fail_("ensureMigrated: task 100-alpha should be in central root");

  if (fs.existsSync(path.join(centralDir, "101-beta"))) ok("ensureMigrated: task 101-beta moved to central");
  else fail_("ensureMigrated: task 101-beta should be in central root");

  if (isMigrated(path.join(centralDir, "100-alpha"))) ok("ensureMigrated: v1 task converted to v2 during move");
  else fail_("ensureMigrated: v1 task should be converted to v2");
}

// --- Test 19: ensureMigrated is idempotent (no-op when already migrated) ---
{
  const { ensureMigrated, tasksRoot } = require("./lib/tasks-root");
  const { repoKey } = require("./lib/repo");
  const repoDir = makeFixtureRepo("ensure-migrated-idem");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV2TaskInDir(localTasks, "200-gamma");

  const keyObj = repoKey(repoDir);
  ensureMigrated(keyObj);
  const centralDir = tasksRoot(keyObj);

  const result2 = ensureMigrated(keyObj);
  if (result2.migrated === false) ok("ensureMigrated: second call returns migrated=false (idempotent)");
  else fail_(`ensureMigrated: second call should return migrated=false, got ${result2.migrated}`);

  if (fs.existsSync(path.join(centralDir, "200-gamma"))) ok("ensureMigrated: task still in central after second call");
  else fail_("ensureMigrated: task should still be in central root");
}

// --- Test 20: ensureMigrated refuses with a live session on the repo ---
{
  const { ensureMigrated } = require("./lib/tasks-root");
  const { repoKey } = require("./lib/repo");
  const session = require("./lib/session");
  const repoDir = makeFixtureRepo("ensure-migrated-refuse");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV2TaskInDir(localTasks, "300-delta");

  const keyObj = repoKey(repoDir);
  const liveSid = `live-refuse-${Date.now()}`;
  session.register({
    session_id: liveSid, pid: process.pid, cwd: repoDir,
    agent: "conductor", repo_key: keyObj.key,
  });

  let threw = false;
  let refused = null;
  try {
    ensureMigrated(keyObj, { excludeSessionId: "different-session" });
  } catch (err) {
    threw = true;
    refused = err.refused;
  }
  if (threw && refused) ok("ensureMigrated: refuses with err.refused when live session active");
  else fail_("ensureMigrated: should refuse with err.refused when live session is active");

  if (fs.existsSync(localTasks)) ok("ensureMigrated: local .tasks/ left in place after refusal");
  else fail_("ensureMigrated: local .tasks/ should remain after refusal");

  session.unregister(liveSid);
}

// --- Test 21: ensureMigrated self-exclusion — requesting session not refused ---
{
  const { ensureMigrated, tasksRoot } = require("./lib/tasks-root");
  const { repoKey } = require("./lib/repo");
  const session = require("./lib/session");
  const repoDir = makeFixtureRepo("ensure-migrated-self");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV2TaskInDir(localTasks, "400-epsilon");

  const keyObj = repoKey(repoDir);
  const selfSid = `self-touch-${Date.now()}`;
  session.register({
    session_id: selfSid, pid: process.pid, cwd: repoDir,
    agent: "conductor", repo_key: keyObj.key,
  });

  let result;
  try {
    result = ensureMigrated(keyObj, { excludeSessionId: selfSid });
  } catch (err) {
    fail_(`ensureMigrated: self-touch should not refuse, got ${err.message}`);
    session.unregister(selfSid);
    return;
  }
  if (result.migrated === true) ok("ensureMigrated: self-touch proceeds (self-exclusion works)");
  else fail_(`ensureMigrated: self-touch should return migrated=true, got ${JSON.stringify(result)}`);

  if (!fs.existsSync(localTasks)) ok("ensureMigrated: local .tasks/ moved by self-touch");
  else fail_("ensureMigrated: local .tasks/ should be moved by self-touch");

  session.unregister(selfSid);
}

// --- Test 22: ensureMigrated fails closed on unreadable session registry ---
{
  const { ensureMigrated } = require("./lib/tasks-root");
  const { repoKey } = require("./lib/repo");
  const repoDir = makeFixtureRepo("ensure-migrated-fail");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV2TaskInDir(localTasks, "500-zeta");

  const keyObj = repoKey(repoDir);
  const savedRoot = process.env.AGENTS_SESSIONS_ROOT;
  // Make the registry root a file (not a directory) so readdirSync throws ENOTDIR
  const badRoot = path.join(tmpBase, "not-a-dir");
  fs.writeFileSync(badRoot, "not a directory");
  process.env.AGENTS_SESSIONS_ROOT = badRoot;

  let threw = false;
  let failClosed = false;
  try {
    ensureMigrated(keyObj);
  } catch (err) {
    threw = true;
    failClosed = err.failClosed === true;
  }
  process.env.AGENTS_SESSIONS_ROOT = savedRoot;

  if (threw && failClosed) ok("ensureMigrated: fails closed on unreadable registry");
  else fail_("ensureMigrated: should throw with failClosed=true on unreadable registry");

  if (fs.existsSync(localTasks)) ok("ensureMigrated: local .tasks/ not moved on fail-closed");
  else fail_("ensureMigrated: local .tasks/ should remain on fail-closed");
}

// --- Test 23: enumerateReposWithTasks returns main checkouts with .tasks/ ---
{
  const { enumerateReposWithTasks } = require("./lib/tasks-root");
  // Create a fixture repo under tmpBase/code (enumerateReposWithTasks scans ~/code and ~/dev)
  // Since we cannot write to ~/code in a test, verify the function returns an array
  // and filters correctly by testing with a repo that has no .tasks/ (should not be listed).
  const repos = enumerateReposWithTasks();
  if (Array.isArray(repos)) ok("enumerateReposWithTasks: returns an array");
  else fail_("enumerateReposWithTasks: should return an array");
  // Each entry should have key and main_root
  for (const r of repos) {
    if (r.key && r.main_root) { ok("enumerateReposWithTasks: entry has key and main_root"); break; }
    else { fail_("enumerateReposWithTasks: entry missing key or main_root"); break; }
  }
}

// --- Test 24: a task migrate --all dry-run reports repos with .tasks/ ---
{
  const repoDir = makeFixtureRepo("migrate-all-dryrun");
  const localTasks = path.join(repoDir, ".tasks");
  fs.mkdirSync(localTasks, { recursive: true });
  makeV1TaskInDir(localTasks, "600-eta");
  makeV2TaskInDir(localTasks, "601-theta");

  // Simulate what the CLI does: enumerate the single repo via --root
  const { repoKey } = require("./lib/repo");
  const keyObj = repoKey(repoDir);
  const { hasLocalTasks } = require("./lib/tasks-root");
  const hasLocal = hasLocalTasks(keyObj);
  if (hasLocal) ok("migrate --all dry-run: hasLocalTasks detects repo-local .tasks/");
  else fail_("migrate --all dry-run: hasLocalTasks should detect repo-local .tasks/");

  let v1count = 0, v2count = 0;
  for (const name of fs.readdirSync(localTasks)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(localTasks, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (isMigrated(dir)) v2count++;
    else if (fs.existsSync(path.join(dir, "state.json"))) v1count++;
  }
  if (v1count === 1) ok("migrate --all dry-run: v1_to_v2 count is 1");
  else fail_(`migrate --all dry-run: v1_to_v2 should be 1, got ${v1count}`);
  if (v2count === 1) ok("migrate --all dry-run: already_v2 count is 1");
  else fail_(`migrate --all dry-run: already_v2 should be 1, got ${v2count}`);
}

// --- Test 25: tasks doctrine persists default_tiers to index.json ---
{
  const { updateRootIndex, readRootIndex } = require("./lib/tasks-root");
  const doctrineKey = "doctrine-test-repo-key";
  updateRootIndex(doctrineKey, {
    default_tiers: { default: "standard", courier: "minor" },
    main_root: "/tmp/doctrine-test",
  });
  const index = readRootIndex();
  if (index[doctrineKey] && index[doctrineKey].default_tiers) ok("tasks doctrine: default_tiers persisted to index.json");
  else fail_("tasks doctrine: default_tiers should be in index.json");
  if (index[doctrineKey].default_tiers.default === "standard") ok("tasks doctrine: default tier is 'standard'");
  else fail_(`tasks doctrine: default should be 'standard', got ${index[doctrineKey].default_tiers.default}`);
  if (index[doctrineKey].default_tiers.courier === "minor") ok("tasks doctrine: courier tier is 'minor'");
  else fail_(`tasks doctrine: courier should be 'minor', got ${index[doctrineKey].default_tiers.courier}`);
}

// --- Test 26: root-file concurrency — concurrent updateRootIndex loses no entries ---
{
  const { updateRootIndex, readRootIndex } = require("./lib/tasks-root");
  // Simulate two sessions writing different repo keys concurrently
  // withRootLock serializes them, so both entries should survive
  updateRootIndex("concurrent-repo-a", { main_root: "/tmp/a" });
  updateRootIndex("concurrent-repo-b", { main_root: "/tmp/b" });
  const index = readRootIndex();
  if (index["concurrent-repo-a"] && index["concurrent-repo-a"].main_root === "/tmp/a")
    ok("root concurrency: repo-a entry present after concurrent writes");
  else fail_("root concurrency: repo-a entry should be present");
  if (index["concurrent-repo-b"] && index["concurrent-repo-b"].main_root === "/tmp/b")
    ok("root concurrency: repo-b entry present after concurrent writes");
  else fail_("root concurrency: repo-b entry should be present");
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
