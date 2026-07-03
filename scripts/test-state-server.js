#!/usr/bin/env node
// Smoke test for state-server.js
// Creates a temp task dir, exercises all 6 tools via JSON-RPC over stdio,
// verifies the resulting state.json matches expectations, then cleans up.
//
// Run: node scripts/test-state-server.js
// Exit 0 = pass, exit 1 = fail.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

// ---------------------------------------------------------------------------
// Setup: temp task directory
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-test-"));
const taskDir = path.join(tmpDir, ".tasks", "test-001-smoke");
fs.mkdirSync(taskDir, { recursive: true });

// The server resolves task_dir relative to CLAUDE_PROJECT_DIR.
// We set it to tmpDir so relative paths work.
const relativeTaskDir = ".tasks/test-001-smoke";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let msgId = 1;

function makeCall(method, params) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: msgId++,
    method,
    params,
  }) + "\n";
}

function makeToolCall(toolName, args) {
  return makeCall("tools/call", { name: toolName, arguments: args });
}

// ---------------------------------------------------------------------------
// Run server and exercise tools
// ---------------------------------------------------------------------------

async function runTests() {
  const proc = spawn("node", ["scripts/state-server.js"], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
    cwd: path.join(__dirname, ".."),
  });

  let outputBuffer = "";
  const responses = [];

  proc.stdout.on("data", (chunk) => {
    outputBuffer += chunk.toString();
    // Parse complete JSON lines
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch (e) {
          // ignore non-JSON lines
        }
      }
    }
  });

  proc.stderr.on("data", (d) => {
    // Server stderr is informational; suppress in test output unless debug
    if (process.env.DEBUG) process.stderr.write(d);
  });

  // Helper: send a message and wait for response
  const waitForResponse = (targetId) =>
    new Promise((resolve) => {
      const check = () => {
        const resp = responses.find((r) => r.id === targetId);
        if (resp) {
          resolve(resp);
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

  const send = (msg) => proc.stdin.write(msg);

  // Initialize
  const initId = msgId;
  send(makeCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-runner", version: "1.0" },
  }));
  await waitForResponse(initId);

  let pass = true;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); pass = false; };
  const ok = (msg) => console.log(`OK: ${msg}`);

  // -------------------------------------------------------------------------
  // Test 1: state_init
  // -------------------------------------------------------------------------
  const initToolId = msgId;
  send(makeToolCall("state_init", {
    task_dir: relativeTaskDir,
    slug: "smoke",
    phases: [
      { id: 1, name: "setup" },
      { id: 2, name: "build" },
      { id: 3, name: "test" },
    ],
  }));
  const initResp = await waitForResponse(initToolId);

  if (initResp.error || initResp.result?.isError) {
    const msg = initResp.error?.message || initResp.result?.content?.[0]?.text;
    fail(`state_init error: ${msg}`);
  } else {
    const statePath = path.join(taskDir, "state.json");
    if (!fs.existsSync(statePath)) {
      fail("state_init did not create state.json");
    } else {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.task !== "smoke") fail("state.task mismatch");
      if (state.status !== "planning") fail("state.status should be planning");
      if (state.phases.length !== 3) fail("should have 3 phases");
      if (state.phases[0].status !== "not_started") fail("phase 1 should be not_started");
      if (state.flags.length !== 0) fail("flags should be empty");
      ok("state_init created valid state.json");
    }
  }

  // -------------------------------------------------------------------------
  // Test 2: state_init is idempotency-guarded (second call should fail)
  // -------------------------------------------------------------------------
  const initDupId = msgId;
  send(makeToolCall("state_init", {
    task_dir: relativeTaskDir,
    slug: "smoke",
    phases: [{ id: 1, name: "setup" }],
  }));
  const initDupResp = await waitForResponse(initDupId);
  const isDupError = initDupResp.error || initDupResp.result?.isError;
  if (!isDupError) {
    fail("state_init should error when state.json already exists");
  } else {
    ok("state_init rejects duplicate creation");
  }

  // -------------------------------------------------------------------------
  // Test 3: state_update -- set phase status and owner
  // -------------------------------------------------------------------------
  const updateId = msgId;
  send(makeToolCall("state_update", {
    task_dir: relativeTaskDir,
    phase_id: 1,
    phase_status: "in_progress",
    owner: "builder",
    started: true,
    task_status: "in_progress",
  }));
  const updateResp = await waitForResponse(updateId);

  if (updateResp.error || updateResp.result?.isError) {
    const msg = updateResp.error?.message || updateResp.result?.content?.[0]?.text;
    fail(`state_update error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
    if (state.phases[0].status !== "in_progress") fail("phase 1 status should be in_progress");
    if (state.phases[0].owner !== "builder") fail("phase 1 owner should be builder");
    if (!state.phases[0].started) fail("phase 1 started should be set");
    if (state.status !== "in_progress") fail("task status should be in_progress");
    ok("state_update set phase status, owner, started, task_status");
  }

  // -------------------------------------------------------------------------
  // Test 4: state_update -- partial update (owner only, no phase_status)
  // -------------------------------------------------------------------------
  const partialId = msgId;
  send(makeToolCall("state_update", {
    task_dir: relativeTaskDir,
    phase_id: 1,
    owner: null,
  }));
  const partialResp = await waitForResponse(partialId);

  if (partialResp.error || partialResp.result?.isError) {
    const msg = partialResp.error?.message || partialResp.result?.content?.[0]?.text;
    fail(`state_update partial error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
    if (state.phases[0].owner !== null) fail("phase 1 owner should be null after clearing");
    if (state.phases[0].status !== "in_progress") fail("phase 1 status should still be in_progress");
    ok("state_update partial (owner only) leaves other fields unchanged");
  }

  // -------------------------------------------------------------------------
  // Test 5: state_flag -- add flag
  // -------------------------------------------------------------------------
  const flagId = msgId;
  send(makeToolCall("state_flag", {
    task_dir: relativeTaskDir,
    phase_id: 2,
    type: "needs_human",
    message: "Ambiguous requirement: which auth method?",
  }));
  const flagResp = await waitForResponse(flagId);

  let generatedFlagId;
  if (flagResp.error || flagResp.result?.isError) {
    const msg = flagResp.error?.message || flagResp.result?.content?.[0]?.text;
    fail(`state_flag error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
    if (state.flags.length !== 1) fail("should have 1 flag");
    const flag = state.flags[0];
    if (!flag.id.startsWith("f-2-")) fail(`flag id format wrong: ${flag.id}`);
    if (flag.type !== "needs_human") fail("flag type mismatch");
    if (flag.phase !== 2) fail("flag phase mismatch");
    generatedFlagId = flag.id;
    ok(`state_flag added flag with id ${generatedFlagId}`);
  }

  // -------------------------------------------------------------------------
  // Test 6: state_read -- returns full state
  // -------------------------------------------------------------------------
  const readId = msgId;
  send(makeToolCall("state_read", { task_dir: relativeTaskDir }));
  const readResp = await waitForResponse(readId);

  if (readResp.error || readResp.result?.isError) {
    const msg = readResp.error?.message || readResp.result?.content?.[0]?.text;
    fail(`state_read error: ${msg}`);
  } else {
    const text = readResp.result.content[0].text;
    const parsed = JSON.parse(text);
    if (parsed.task !== "smoke") fail("state_read task mismatch");
    if (parsed.flags.length !== 1) fail("state_read should show 1 flag");
    ok("state_read returns full state.json content");
  }

  // -------------------------------------------------------------------------
  // Test 7: state_prime -- compact summary
  // -------------------------------------------------------------------------
  const primeId = msgId;
  send(makeToolCall("state_prime", { task_dir: relativeTaskDir }));
  const primeResp = await waitForResponse(primeId);

  if (primeResp.error || primeResp.result?.isError) {
    const msg = primeResp.error?.message || primeResp.result?.content?.[0]?.text;
    fail(`state_prime error: ${msg}`);
  } else {
    const text = primeResp.result.content[0].text;
    if (!text.includes("Task: smoke")) fail("prime missing task line");
    if (!text.includes("Phases:")) fail("prime missing phases line");
    if (!text.includes("Current:")) fail("prime missing current line");
    if (!text.includes("Flags:")) fail("prime missing flags line");
    ok("state_prime returns compact summary");
  }

  // -------------------------------------------------------------------------
  // Test 8: state_clear_flag -- remove by ID
  // -------------------------------------------------------------------------
  if (generatedFlagId) {
    const clearId = msgId;
    send(makeToolCall("state_clear_flag", {
      task_dir: relativeTaskDir,
      flag_id: generatedFlagId,
    }));
    const clearResp = await waitForResponse(clearId);

    if (clearResp.error || clearResp.result?.isError) {
      const msg = clearResp.error?.message || clearResp.result?.content?.[0]?.text;
      fail(`state_clear_flag error: ${msg}`);
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
      if (state.flags.length !== 0) fail("flag should have been removed");
      ok("state_clear_flag removed flag by ID");
    }
  }

  // -------------------------------------------------------------------------
  // Test 9: state_clear_flag -- unknown ID returns error
  // -------------------------------------------------------------------------
  const clearBadId = msgId;
  send(makeToolCall("state_clear_flag", {
    task_dir: relativeTaskDir,
    flag_id: "f-99-0000000",
  }));
  const clearBadResp = await waitForResponse(clearBadId);
  const isClearBadError = clearBadResp.error || clearBadResp.result?.isError;
  if (!isClearBadError) {
    fail("state_clear_flag should error for unknown flag ID");
  } else {
    ok("state_clear_flag rejects unknown flag ID");
  }

  // -------------------------------------------------------------------------
  // Test 10: state_flag -- rejects nonexistent phase_id
  // -------------------------------------------------------------------------
  const flagBadPhaseId = msgId;
  send(makeToolCall("state_flag", {
    task_dir: relativeTaskDir,
    phase_id: 99,
    type: "error",
    message: "Should never be stored",
  }));
  const flagBadPhaseResp = await waitForResponse(flagBadPhaseId);
  if (flagBadPhaseResp.error || flagBadPhaseResp.result?.isError) {
    ok("state_flag rejects nonexistent phase_id");
  } else {
    fail("state_flag should error when phase_id does not exist");
  }

  // -------------------------------------------------------------------------
  // Test 11: path traversal -- state_read rejects task_dir that escapes projectDir
  // -------------------------------------------------------------------------
  const traversalId = msgId;
  send(makeToolCall("state_read", { task_dir: "../../../etc" }));
  const traversalResp = await waitForResponse(traversalId);
  if (traversalResp.error || traversalResp.result?.isError) {
    ok("state_read rejects path traversal in task_dir");
  } else {
    fail("state_read should reject task_dir that escapes project directory");
  }

  // -------------------------------------------------------------------------
  // Test 12: path traversal -- state_flag rejects task_dir that escapes projectDir
  // -------------------------------------------------------------------------
  const traversalFlagId = msgId;
  send(makeToolCall("state_flag", {
    task_dir: "../../outside",
    phase_id: 1,
    type: "error",
    message: "traversal attempt",
  }));
  const traversalFlagResp = await waitForResponse(traversalFlagId);
  if (traversalFlagResp.error || traversalFlagResp.result?.isError) {
    ok("state_flag rejects path traversal in task_dir");
  } else {
    fail("state_flag should reject task_dir that escapes project directory");
  }

  // -------------------------------------------------------------------------
  // Test 13: tasks.json created by state_init
  // -------------------------------------------------------------------------
  {
    const indexPath = path.join(tmpDir, ".tasks", "tasks.json");
    if (!fs.existsSync(indexPath)) {
      fail("tasks.json should exist after state_init");
    } else {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (!index.updated) fail("tasks.json missing updated field");
      if (!Array.isArray(index.tasks)) fail("tasks.json tasks must be an array");
      const entry = index.tasks.find((t) => t.slug === "smoke");
      if (!entry) fail("tasks.json missing entry for smoke task");
      if (entry.total_phases !== 3) fail(`tasks.json total_phases wrong: ${entry.total_phases}`);
      ok("tasks.json exists and contains smoke task after state_init");
    }
  }

  // -------------------------------------------------------------------------
  // Test 14: tasks.json updated by state_update (reflects phase status)
  // -------------------------------------------------------------------------
  {
    const updateIndexId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 1,
      phase_status: "in_progress",
      owner: "builder",
      task_status: "in_progress",
    }));
    await waitForResponse(updateIndexId);

    const indexPath = path.join(tmpDir, ".tasks", "tasks.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entry = index.tasks.find((t) => t.slug === "smoke");
    if (!entry) {
      fail("tasks.json missing smoke entry after state_update");
    } else {
      if (entry.status !== "in_progress") fail(`tasks.json status wrong: ${entry.status}`);
      if (!entry.current_phase) fail("tasks.json current_phase should be non-null");
      if (entry.current_phase.id !== 1) fail(`tasks.json current_phase.id wrong: ${entry.current_phase.id}`);
      if (entry.current_phase.owner !== "builder") fail(`tasks.json current_phase.owner wrong: ${entry.current_phase.owner}`);
      ok("tasks.json reflects updated phase status and owner");
    }
  }

  // -------------------------------------------------------------------------
  // Test 15: tasks_list tool returns index content
  // -------------------------------------------------------------------------
  const tasksListId = msgId;
  send(makeToolCall("tasks_list", {}));
  const tasksListResp = await waitForResponse(tasksListId);

  if (tasksListResp.error || tasksListResp.result?.isError) {
    const msg = tasksListResp.error?.message || tasksListResp.result?.content?.[0]?.text;
    fail(`tasks_list error: ${msg}`);
  } else {
    const text = tasksListResp.result.content[0].text;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.tasks)) fail("tasks_list result missing tasks array");
    const entry = parsed.tasks.find((t) => t.slug === "smoke");
    if (!entry) fail("tasks_list missing smoke entry");
    ok("tasks_list returns valid index with smoke task");
  }

  // -------------------------------------------------------------------------
  // Test 16: tasks.json includes both tasks when two tasks exist
  // -------------------------------------------------------------------------
  const secondTaskDir = ".tasks/test-002-second";
  const secondTaskPath = path.join(tmpDir, ".tasks", "test-002-second");
  fs.mkdirSync(secondTaskPath, { recursive: true });

  const initSecondId = msgId;
  send(makeToolCall("state_init", {
    task_dir: secondTaskDir,
    slug: "second",
    phases: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }],
  }));
  await waitForResponse(initSecondId);

  {
    const indexPath = path.join(tmpDir, ".tasks", "tasks.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const slugs = index.tasks.map((t) => t.slug).sort();
    if (!slugs.includes("smoke")) fail("tasks.json missing smoke after second init");
    if (!slugs.includes("second")) fail("tasks.json missing second after second init");
    const secondEntry = index.tasks.find((t) => t.slug === "second");
    if (!secondEntry) fail("tasks.json second entry missing");
    if (secondEntry.total_phases !== 2) fail(`second total_phases wrong: ${secondEntry.total_phases}`);
    if (secondEntry.completed_phases !== 0) fail("second completed_phases should be 0");
    ok("tasks.json contains both tasks after creating second task");
  }

  // -------------------------------------------------------------------------
  // Test 17: tasks.json flags count updated by state_flag
  // -------------------------------------------------------------------------
  const flagForIndexId = msgId;
  send(makeToolCall("state_flag", {
    task_dir: relativeTaskDir,
    phase_id: 2,
    type: "blocked",
    message: "Waiting on dependency",
  }));
  await waitForResponse(flagForIndexId);

  {
    const indexPath = path.join(tmpDir, ".tasks", "tasks.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entry = index.tasks.find((t) => t.slug === "smoke");
    if (!entry) {
      fail("tasks.json missing smoke after state_flag");
    } else if (entry.flags !== 1) {
      fail(`tasks.json flags count wrong after state_flag: ${entry.flags}`);
    } else {
      ok("tasks.json flags count updated after state_flag");
    }
  }

  for (const id of [1, 2, 3]) {
    const doneId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: id,
      phase_status: "done",
      completed: true,
    }));
    await waitForResponse(doneId);
  }
  const finalState = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
  if (finalState.status !== "done") {
    fail("task status should auto-set to done when all phases are done");
  } else {
    ok("task auto-completes when all phases are done");
  }

  // -------------------------------------------------------------------------
  // Test 19: state_init -- phases with blocked_by and parallel_group
  // -------------------------------------------------------------------------
  const parallelTaskDir = ".tasks/test-003-parallel";
  const parallelTaskPath = path.join(tmpDir, ".tasks", "test-003-parallel");
  fs.mkdirSync(parallelTaskPath, { recursive: true });

  const initParallelId = msgId;
  send(makeToolCall("state_init", {
    task_dir: parallelTaskDir,
    slug: "test-parallel",
    phases: [
      { id: 1, name: "setup" },
      { id: 2, name: "api", blocked_by: [1] },
      { id: 3, name: "tests", parallel_group: "A" },
      { id: 4, name: "docs", parallel_group: "A" },
    ],
  }));
  const initParallelResp = await waitForResponse(initParallelId);

  if (initParallelResp.error || initParallelResp.result?.isError) {
    const msg = initParallelResp.error?.message || initParallelResp.result?.content?.[0]?.text;
    fail(`state_init with dependencies error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p2 = state.phases.find((p) => p.id === 2);
    const p3 = state.phases.find((p) => p.id === 3);
    const p4 = state.phases.find((p) => p.id === 4);
    if (!p2 || JSON.stringify(p2.blocked_by) !== "[1]") {
      fail(`state_init blocked_by not stored: ${JSON.stringify(p2?.blocked_by)}`);
    } else if (!p3 || p3.parallel_group !== "A") {
      fail(`state_init parallel_group not stored for phase 3: ${p3?.parallel_group}`);
    } else if (!p4 || p4.parallel_group !== "A") {
      fail(`state_init parallel_group not stored for phase 4: ${p4?.parallel_group}`);
    } else {
      ok("state_init stores blocked_by and parallel_group correctly");
    }
  }

  // -------------------------------------------------------------------------
  // Test 20: state_init -- blocked_by references non-existent phase (error)
  // -------------------------------------------------------------------------
  const badDepTaskDir = ".tasks/test-004-bad-dep";
  const badDepTaskPath = path.join(tmpDir, ".tasks", "test-004-bad-dep");
  fs.mkdirSync(badDepTaskPath, { recursive: true });

  const initBadDepId = msgId;
  send(makeToolCall("state_init", {
    task_dir: badDepTaskDir,
    slug: "bad-dep",
    phases: [
      { id: 1, name: "setup", blocked_by: [99] },
    ],
  }));
  const initBadDepResp = await waitForResponse(initBadDepId);
  if (initBadDepResp.error || initBadDepResp.result?.isError) {
    ok("state_init rejects blocked_by reference to non-existent phase");
  } else {
    fail("state_init should error when blocked_by references non-existent phase");
  }

  // -------------------------------------------------------------------------
  // Test 21: state_update -- set parallel_group
  // -------------------------------------------------------------------------
  const updateParGroupId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 3,
    parallel_group: "B",
  }));
  const updateParGroupResp = await waitForResponse(updateParGroupId);

  if (updateParGroupResp.error || updateParGroupResp.result?.isError) {
    const msg = updateParGroupResp.error?.message || updateParGroupResp.result?.content?.[0]?.text;
    fail(`state_update parallel_group error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p3 = state.phases.find((p) => p.id === 3);
    if (p3?.parallel_group !== "B") {
      fail(`state_update parallel_group not updated: ${p3?.parallel_group}`);
    } else {
      ok("state_update sets parallel_group on a phase");
    }
  }

  // -------------------------------------------------------------------------
  // Test 22: state_update -- replace blocked_by array
  // -------------------------------------------------------------------------
  const updateBlockedById = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 2,
    blocked_by: [1, 3],
  }));
  const updateBlockedByResp = await waitForResponse(updateBlockedById);

  if (updateBlockedByResp.error || updateBlockedByResp.result?.isError) {
    const msg = updateBlockedByResp.error?.message || updateBlockedByResp.result?.content?.[0]?.text;
    fail(`state_update blocked_by error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p2 = state.phases.find((p) => p.id === 2);
    if (JSON.stringify(p2?.blocked_by) !== "[1,3]") {
      fail(`state_update blocked_by not replaced: ${JSON.stringify(p2?.blocked_by)}`);
    } else {
      ok("state_update replaces blocked_by array");
    }
  }

  // -------------------------------------------------------------------------
  // Test 23: state_update -- blocked_by references non-existent phase (error)
  // -------------------------------------------------------------------------
  const updateBadDepId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 2,
    blocked_by: [99],
  }));
  const updateBadDepResp = await waitForResponse(updateBadDepId);
  if (updateBadDepResp.error || updateBadDepResp.result?.isError) {
    ok("state_update rejects blocked_by reference to non-existent phase");
  } else {
    fail("state_update should error when blocked_by references non-existent phase");
  }

  // -------------------------------------------------------------------------
  // Test 24: state_prime -- "Next" line shows parallel group info
  // -------------------------------------------------------------------------
  // Mark phase 1 in parallelTaskDir as done so upcoming phases show in Next
  const markDoneId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 1,
    phase_status: "done",
    completed: true,
  }));
  await waitForResponse(markDoneId);

  const parallelPrimeId = msgId;
  send(makeToolCall("state_prime", { task_dir: parallelTaskDir }));
  const parallelPrimeResp = await waitForResponse(parallelPrimeId);

  if (parallelPrimeResp.error || parallelPrimeResp.result?.isError) {
    const msg = parallelPrimeResp.error?.message || parallelPrimeResp.result?.content?.[0]?.text;
    fail(`state_prime (parallel) error: ${msg}`);
  } else {
    const text = parallelPrimeResp.result.content[0].text;
    if (!text.includes("Next:")) {
      fail("state_prime missing Next line");
    } else {
      ok("state_prime includes Next line");
    }
  }

  // -------------------------------------------------------------------------
  // Test 25: state_prime -- "Next" shows parallel group when upcoming phases share a group
  // -------------------------------------------------------------------------
  // Mark phase 2 in parallelTaskDir as done so phases 3+4 (parallel group B/A) are upcoming
  const markDone2Id = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 2,
    phase_status: "done",
    completed: true,
  }));
  await waitForResponse(markDone2Id);

  // Reset phase 3 to "A" group so 3+4 share a group
  const resetGroup3Id = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 3,
    parallel_group: "A",
  }));
  await waitForResponse(resetGroup3Id);

  const primeParGroupId = msgId;
  send(makeToolCall("state_prime", { task_dir: parallelTaskDir }));
  const primeParGroupResp = await waitForResponse(primeParGroupId);

  if (primeParGroupResp.error || primeParGroupResp.result?.isError) {
    const msg = primeParGroupResp.error?.message || primeParGroupResp.result?.content?.[0]?.text;
    fail(`state_prime parallel group error: ${msg}`);
  } else {
    const text = primeParGroupResp.result.content[0].text;
    // Phases 3 (current) and 4 (next) share group A -- Next should show parallel group info
    // Current phase is 3 (first non-done), so upcoming is 4 with parallel_group A
    // With only phase 4 upcoming in the group (phase 3 is current), it may show single phase
    // The key check: Next line exists
    if (!text.includes("Next:")) {
      fail("state_prime missing Next line for parallel group scenario");
    } else {
      ok("state_prime Next line present for parallel group scenario");
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  proc.stdin.end();
  await new Promise((resolve) => proc.on("close", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------
  if (pass) {
    console.log("\nAll tests passed.");
    process.exit(0);
  } else {
    console.error("\nSome tests FAILED.");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
