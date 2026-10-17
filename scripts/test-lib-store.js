#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { readState, writeState, stateTmpPath: _st, tasksIndexPath } = require("./lib/store");
const { validateSessionId } = require("./lib/session");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-store-test-")));
const CLI = path.join(__dirname, "bin", "a");

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

function makeTask(repo, slug) {
  const args = ["task", "create", "--title", "T", "--repo", repo, "--json",
    "--phases-json", '[{"id":1,"name":"Phase 1"}]'];
  if (slug) args.push("--slug", slug);
  const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// Issue 4: readState sets err.notFound when file is missing
// ---------------------------------------------------------------------------

{
  const repo = makeRepo("not-found");
  const key = repoKey(repo);
  let caught = null;
  try {
    readState(".tasks/999-nonexistent", key.main_root);
  } catch (err) {
    caught = err;
  }
  if (caught && caught.notFound === true) ok("readState sets notFound=true on missing state.json");
  else fail_("readState should set notFound=true on missing state.json");
}

// Issue 4: CLI exits 4 for task read on nonexistent task dir
{
  const repo = makeRepo("exit4");
  let exitCode = null;
  try {
    execFileSync("node", [CLI, "task", "read", "--task-dir", "nonexistent", "--repo", repo, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    exitCode = err.status;
  }
  if (exitCode === 4) ok("CLI task read exits 4 for nonexistent task dir");
  else fail_(`CLI task read should exit 4, got ${exitCode}`);
}

// ---------------------------------------------------------------------------
// Issue 5: validateSessionId rejects path traversal
// ---------------------------------------------------------------------------

{
  let threw = false;
  try { validateSessionId("../etc/passwd"); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects ../ traversal");
  else fail_("validateSessionId should reject ../ traversal");

  threw = false;
  try { validateSessionId("foo/bar"); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects forward slash");
  else fail_("validateSessionId should reject forward slash");

  threw = false;
  try { validateSessionId("foo\\bar"); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects backslash");
  else fail_("validateSessionId should reject backslash");

  threw = false;
  try { validateSessionId("foo\0bar"); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects null byte");
  else fail_("validateSessionId should reject null byte");

  threw = false;
  try { validateSessionId(".."); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects bare ..");
  else fail_("validateSessionId should reject bare ..");

  threw = false;
  try { validateSessionId("pid-12345"); } catch { threw = true; }
  if (!threw) ok("validateSessionId accepts safe pid-12345");
  else fail_("validateSessionId should accept pid-12345");

  threw = false;
  try { validateSessionId(""); } catch { threw = true; }
  if (threw) ok("validateSessionId rejects empty string");
  else fail_("validateSessionId should reject empty string");
}

// Issue 5: store.stateTmpPath rejects invalid sessionId
{
  const repo = makeRepo("traversal-tmp");
  const key = repoKey(repo);
  const taskDir = ".tasks/001-test";
  let threw = false;
  try {
    stateTmpPath(taskDir, key.main_root, "../evil");
  } catch { threw = true; }
  if (threw) ok("stateTmpPath rejects traversal sessionId");
  else fail_("stateTmpPath should reject traversal sessionId");
}

// Issue 5: session.register rejects invalid session_id
{
  const session = require("./lib/session");
  let threw = false;
  try {
    session.register({ session_id: "../evil", pid: 1, cwd: "/tmp" });
  } catch { threw = true; }
  if (threw) ok("session.register rejects traversal session_id");
  else fail_("session.register should reject traversal session_id");
}

// ---------------------------------------------------------------------------
// Issue 3: concurrent state updates serialize (no lost update)
// ---------------------------------------------------------------------------

// Test: 10 parallel `a state flag` commands — all 10 flags should survive
{
  const repo = makeRepo("concurrent-flags");
  const task = makeTask(repo, "concurrent");
  const taskDir = task.slug;
  const N = 10;
  const results = [];
  for (let i = 0; i < N; i++) {
    const r = spawnSync("node", [CLI, "state", "flag", "--task-dir", taskDir,
      "--phase-id", "1", "--type", "blocked", "--message", `flag-${i}`,
      "--repo", repo, "--json"], { encoding: "utf8", timeout: 10000 });
    results.push(r);
  }
  const allExited0 = results.every((r) => r.status === 0);
  if (allExited0) ok(`all ${N} parallel state flag commands succeeded`);
  else fail_(`some parallel state flag commands failed: statuses=${results.map((r) => r.status).join(",")}`);

  // Read final state and check all N flags are present
  const stateOut = execFileSync("node", [CLI, "task", "read", "--task-dir", taskDir,
    "--repo", repo, "--json"], { encoding: "utf8" });
  const state = JSON.parse(stateOut);
  if (state.flags.length === N) ok(`no lost update: all ${N} flags present in final state`);
  else fail_(`lost update detected: expected ${N} flags, got ${state.flags.length}`);

  // Check no duplicate flag IDs
  const flagIds = state.flags.map((f) => f.id);
  const uniqueIds = new Set(flagIds);
  if (uniqueIds.size === flagIds.length) ok(`no duplicate flag IDs (${flagIds.length} unique)`);
  else fail_(`duplicate flag IDs: ${flagIds.length} total, ${uniqueIds.size} unique`);
}

// Test: 50 sequential `a state update` commands — all succeed, final state valid
{
  const repo = makeRepo("sequential-50");
  const task = makeTask(repo, "seq50");
  const taskDir = task.slug;
  let succeeded = 0;
  for (let i = 0; i < 50; i++) {
    const r = spawnSync("node", [CLI, "state", "update", "--task-dir", taskDir,
      "--phase-id", "1", "--phase-status", "in_progress",
      "--repo", repo, "--json"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0) succeeded++;
  }
  if (succeeded === 50) ok("50 sequential state update commands all succeeded");
  else fail_(`sequential state update: ${succeeded}/50 succeeded`);

  // Final state should be valid
  const stateOut = execFileSync("node", [CLI, "task", "read", "--task-dir", taskDir,
    "--repo", repo, "--json"], { encoding: "utf8" });
  const state = JSON.parse(stateOut);
  if (state.phases[0].status === "in_progress") ok("final state valid after 50 updates");
  else fail_(`final state invalid: phase status=${state.phases[0].status}`);
}

// Cleanup
fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
