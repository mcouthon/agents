#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { sweep, findDoneTasks, daysAgo } = require("./lib/tasks-sweep");
const { createTask } = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-sweep-test-")));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-sweep-tasks-"));
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-sweep-sessions-"));

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

function markDone(taskDir) {
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  task.phases.forEach((p) => { p.status = "landed"; });
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2), "utf8");
  return task;
}

function setConsolidator(taskDir, distilledTo) {
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  task.phases[0].reports = { consolidator: { distilled_to: distilledTo, proposals: [] } };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2), "utf8");
}

// --- Test 1: daysAgo computes age correctly ---
{
  const now = new Date().toISOString();
  const age = daysAgo(now);
  if (age < 0.01) ok("daysAgo: now → ~0 days");
  else fail_(`daysAgo: now should be ~0, got ${age}`);

  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  const age5 = daysAgo(old);
  if (age5 >= 4.9 && age5 <= 5.1) ok("daysAgo: 5 days ago → ~5");
  else fail_(`daysAgo: 5 days ago should be ~5, got ${age5}`);

  if (daysAgo(null) === Infinity) ok("daysAgo: null → Infinity");
  else fail_("daysAgo: null should be Infinity");
}

// --- Test 2: findDoneTasks finds tasks satisfying the done predicate ---
{
  const repo = makeRepo("find-done");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Done Minor", slug: "done-minor", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r1.task_dir);

  const r2 = createTask({ repo: key, title: "Active Task", slug: "active-task", tier: "standard", session_id: "s", phases: [{id: 1, name: "P1"}] });
  // r2 is not done (phase still not_started)

  const results = findDoneTasks(key);
  const slugs = results.map((r) => r.slug);
  if (slugs.includes("done-minor")) ok("findDoneTasks: finds done task");
  else fail_("findDoneTasks: should find 'done-minor'");
  if (!slugs.includes("active-task")) ok("findDoneTasks: excludes active task");
  else fail_("findDoneTasks: should not include 'active-task'");
}

// --- Test 3: findDoneTasks respects olderThanDays filter ---
{
  const repo = makeRepo("find-done-old");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Old Done", slug: "old-done", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r1.task_dir);
  // Set updated to 10 days ago
  const task = JSON.parse(fs.readFileSync(path.join(r1.task_dir, "task.json"), "utf8"));
  task.updated = new Date(Date.now() - 10 * 86400000).toISOString();
  fs.writeFileSync(path.join(r1.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const r2 = createTask({ repo: key, title: "Recent Done", slug: "recent-done", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r2.task_dir);

  const oldOnly = findDoneTasks(key, { olderThanDays: 5 });
  const oldSlugs = oldOnly.map((r) => r.slug);
  if (oldSlugs.includes("old-done")) ok("findDoneTasks: olderThan=5d includes 10-day-old task");
  else fail_("findDoneTasks: should include 10-day-old task with olderThan=5d");
  if (!oldSlugs.includes("recent-done")) ok("findDoneTasks: olderThan=5d excludes recent task");
  else fail_("findDoneTasks: should exclude recent task with olderThan=5d");

  const allDone = findDoneTasks(key);
  if (allDone.length === 2) ok("findDoneTasks: no filter finds both done tasks");
  else fail_(`findDoneTasks: no filter should find 2, got ${allDone.length}`);
}

// --- Test 4: sweep lists done tasks (dry-run) ---
{
  const repo = makeRepo("sweep-dryrun");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Sweep Me", slug: "sweep-me", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r1.task_dir);

  const result = sweep({ repoKeyObj: key, apply: false });
  if (result.listed.length === 1) ok("sweep dry-run: lists 1 done task");
  else fail_(`sweep dry-run: should list 1, got ${result.listed.length}`);
  if (result.closed.length === 0) ok("sweep dry-run: closes nothing");
  else fail_("sweep dry-run: closed should be empty");
  if (fs.existsSync(r1.task_dir)) ok("sweep dry-run: task dir remains");
  else fail_("sweep dry-run: task dir should remain");
}

// --- Test 5: sweep --apply closes done tasks by tier rule ---
{
  const repo = makeRepo("sweep-apply");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Minor Done", slug: "minor-done", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r1.task_dir);

  const r2 = createTask({ repo: key, title: "Strat Done", slug: "strat-done", tier: "strategic", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r2.task_dir);
  setConsolidator(r2.task_dir, ["docs/adr-sweep.md"]);

  const result = sweep({ repoKeyObj: key, apply: true });
  if (result.closed.length === 2) ok("sweep --apply: closes 2 done tasks");
  else fail_(`sweep --apply: should close 2, got ${result.closed.length}`);

  const minorResult = result.closed.find((c) => c.slug === "minor-done");
  if (minorResult && minorResult.action === "archive") ok("SW1: sweep --apply archives a done minor task");
  else fail_(`SW1: sweep --apply: minor should be archived, got ${JSON.stringify(minorResult)}`);
  if (!fs.existsSync(r1.task_dir)) ok("sweep --apply: minor task dir moved out of the tasks root");
  else fail_("sweep --apply: minor task dir should not exist at original location");
  if (minorResult && minorResult.archivePath && fs.existsSync(minorResult.archivePath)) ok("sweep --apply: minor task dir exists in the archive");
  else fail_(`sweep --apply: minor task should exist in the archive, got archivePath: ${minorResult && minorResult.archivePath}`);

  const stratResult = result.closed.find((c) => c.slug === "strat-done");
  if (stratResult && stratResult.action === "archive") ok("sweep --apply: strategic task archived");
  else fail_(`sweep --apply: strategic should be archived, got ${JSON.stringify(stratResult)}`);
}

// --- Test 6: sweep --older-than filters by age ---
{
  const repo = makeRepo("sweep-older");
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Old", slug: "old-sweep", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r1.task_dir);
  const task = JSON.parse(fs.readFileSync(path.join(r1.task_dir, "task.json"), "utf8"));
  task.updated = new Date(Date.now() - 10 * 86400000).toISOString();
  fs.writeFileSync(path.join(r1.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

  const r2 = createTask({ repo: key, title: "New", slug: "new-sweep", tier: "minor", session_id: "s", phases: [{id: 1, name: "P1"}] });
  markDone(r2.task_dir);

  const result = sweep({ repoKeyObj: key, apply: false, olderThanDays: 5 });
  const slugs = result.listed.map((t) => t.slug);
  if (slugs.includes("old-sweep") && !slugs.includes("new-sweep")) ok("sweep --older-than 5d: filters correctly");
  else fail_(`sweep --older-than 5d: should include old only, got ${JSON.stringify(slugs)}`);
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
