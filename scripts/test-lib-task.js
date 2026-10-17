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

// Test 3: createTask writes state.json
{
  const repo = makeRepo("state");
  const key = repoKey(repo);
  const r = createTask({
    repo: key, title: "State Test", slug: "state-test",
    mode: "fast", phases: [{ id: 1, name: "Phase 1" }],
    session_id: "s",
  });
  const state = JSON.parse(fs.readFileSync(path.join(r.task_dir, "state.json"), "utf8"));
  if (state.schema_version === 1) ok("state.json has schema_version 1");
  else fail_("state.json should have schema_version 1");
  if (state.status === "planning") ok("state.json status is 'planning'");
  else fail_("state.json status should be 'planning'");
  if (state.mode === "fast") ok("state.json has mode field");
  else fail_("state.json should have mode field");
  if (state.phases.length === 1 && state.phases[0].status === "not_started") ok("state.json has phases with not_started");
  else fail_("state.json phases should be not_started");
  if (Array.isArray(state.flags) && state.flags.length === 0) ok("state.json has empty flags array");
  else fail_("state.json should have empty flags");
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

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
