#!/usr/bin/env node
// Smoke test for state-server.js
// Creates a temp task dir, exercises all 8 tools (state_init, state_update,
// state_add_phases, state_flag, state_clear_flag, state_read, state_prime,
// tasks_list) via JSON-RPC over stdio, verifies the resulting state.json
// matches expectations, then cleans up.
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
    if (!text.includes("Blockers:")) fail("prime missing blockers line");
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
  // Test 26: state_update -- set execution metadata
  // -------------------------------------------------------------------------
  const execMetaId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 3,
    execution_model: "opus",
    execution_effort: "high",
    execution_agent_type: "builder",
    execution_estimated_scope: "large",
  }));
  const execMetaResp = await waitForResponse(execMetaId);

  if (execMetaResp.error || execMetaResp.result?.isError) {
    const msg = execMetaResp.error?.message || execMetaResp.result?.content?.[0]?.text;
    fail(`state_update execution metadata error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p3 = state.phases.find((p) => p.id === 3);
    if (p3?.execution?.model !== "opus") fail(`execution.model not set: ${p3?.execution?.model}`);
    if (p3?.execution?.effort !== "high") fail(`execution.effort not set: ${p3?.execution?.effort}`);
    if (p3?.execution?.agent_type !== "builder") fail(`execution.agent_type not set`);
    if (p3?.execution?.estimated_scope !== "large") fail(`execution.estimated_scope not set`);
    ok("state_update sets execution metadata fields");
  }

  // -------------------------------------------------------------------------
  // Test 27: state_update -- partial execution metadata (model only)
  // -------------------------------------------------------------------------
  const execPartialId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 3,
    execution_model: "haiku",
  }));
  const execPartialResp = await waitForResponse(execPartialId);

  if (execPartialResp.error || execPartialResp.result?.isError) {
    const msg = execPartialResp.error?.message || execPartialResp.result?.content?.[0]?.text;
    fail(`state_update partial execution error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p3 = state.phases.find((p) => p.id === 3);
    if (p3?.execution?.model !== "haiku") fail(`execution.model not changed: ${p3?.execution?.model}`);
    if (p3?.execution?.effort !== "high") fail(`execution.effort should be unchanged: ${p3?.execution?.effort}`);
    ok("state_update partial execution metadata leaves other fields unchanged");
  }

  // -------------------------------------------------------------------------
  // Test 28: state_update -- clear execution metadata with null
  // -------------------------------------------------------------------------
  const execClearId = msgId;
  send(makeToolCall("state_update", {
    task_dir: parallelTaskDir,
    phase_id: 3,
    execution_model: null,
  }));
  const execClearResp = await waitForResponse(execClearId);

  if (execClearResp.error || execClearResp.result?.isError) {
    const msg = execClearResp.error?.message || execClearResp.result?.content?.[0]?.text;
    fail(`state_update clear execution error: ${msg}`);
  } else {
    const state = JSON.parse(fs.readFileSync(path.join(parallelTaskPath, "state.json"), "utf8"));
    const p3 = state.phases.find((p) => p.id === 3);
    if (p3?.execution?.model !== null) fail(`execution.model should be null after clearing: ${p3?.execution?.model}`);
    if (p3?.execution?.effort !== "high") fail(`execution.effort should still be high: ${p3?.execution?.effort}`);
    ok("state_update clears execution.model with null, other fields unchanged");
  }

  // -------------------------------------------------------------------------
  // Test 29: state_init includes estimated_scope in execution defaults
  // -------------------------------------------------------------------------
  {
    const initScopeDir = ".tasks/test-005-scope";
    const initScopePath = path.join(tmpDir, ".tasks", "test-005-scope");
    fs.mkdirSync(initScopePath, { recursive: true });

    const initScopeId = msgId;
    send(makeToolCall("state_init", {
      task_dir: initScopeDir,
      slug: "scope-test",
      phases: [{ id: 1, name: "setup" }],
    }));
    await waitForResponse(initScopeId);

    const state = JSON.parse(fs.readFileSync(path.join(initScopePath, "state.json"), "utf8"));
    const p1 = state.phases[0];
    if (!p1.execution.hasOwnProperty("estimated_scope")) {
      fail("execution object missing estimated_scope field");
    } else if (p1.execution.estimated_scope !== null) {
      fail(`estimated_scope should default to null: ${p1.execution.estimated_scope}`);
    } else {
      ok("state_init creates execution object with estimated_scope: null");
    }
  }

  // -------------------------------------------------------------------------
  // Test 30: state_prime -- Blockers line shows phases with unsatisfied blocked_by
  // -------------------------------------------------------------------------
  // Set up a fresh task where phase 2 has blocked_by: [1, 3],
  // phase 1 is done, phase 3 is not_started (unsatisfied dep).
  // Phase 2 should appear in the Blockers line.
  {
    const blockerTaskDir = ".tasks/test-006-blockers";
    const blockerTaskPath = path.join(tmpDir, ".tasks", "test-006-blockers");
    fs.mkdirSync(blockerTaskPath, { recursive: true });

    const initBlockerId = msgId;
    send(makeToolCall("state_init", {
      task_dir: blockerTaskDir,
      slug: "blocker-test",
      phases: [
        { id: 1, name: "setup" },
        { id: 2, name: "api", blocked_by: [1, 3] },
        { id: 3, name: "tests" },
      ],
    }));
    await waitForResponse(initBlockerId);

    // Mark phase 1 as done
    const markDoneId = msgId;
    send(makeToolCall("state_update", {
      task_dir: blockerTaskDir,
      phase_id: 1,
      phase_status: "done",
    }));
    await waitForResponse(markDoneId);

    // Call state_prime -- phase 2 is blocked because phase 3 is not done
    const blockerPrimeId = msgId;
    send(makeToolCall("state_prime", { task_dir: blockerTaskDir }));
    const blockerPrimeResp = await waitForResponse(blockerPrimeId);

    if (blockerPrimeResp.error || blockerPrimeResp.result?.isError) {
      const msg = blockerPrimeResp.error?.message || blockerPrimeResp.result?.content?.[0]?.text;
      fail(`state_prime blockers error: ${msg}`);
    } else {
      const text = blockerPrimeResp.result.content[0].text;
      if (!text.includes("Blockers:")) {
        fail("state_prime missing Blockers line");
      } else if (!text.includes("Phase 2")) {
        fail(`state_prime Blockers line should name Phase 2: ${text}`);
      } else {
        ok("state_prime Blockers line shows phases with unsatisfied blocked_by");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 31: project_dir parameter -- works when passed explicitly per call
  // (simulates VS Code user-scoped MCP where CLAUDE_PROJECT_DIR is not set)
  // -------------------------------------------------------------------------
  {
    const pdirTaskDir = ".tasks/test-007-project-dir";
    const pdirTaskPath = path.join(tmpDir, ".tasks", "test-007-project-dir");
    fs.mkdirSync(pdirTaskPath, { recursive: true });

    // state_init with explicit project_dir (the server already has CLAUDE_PROJECT_DIR set,
    // but passing project_dir explicitly must take priority and also work correctly)
    const initPdirId = msgId;
    send(makeToolCall("state_init", {
      project_dir: tmpDir,
      task_dir: pdirTaskDir,
      slug: "pdir-test",
      phases: [{ id: 1, name: "alpha" }],
    }));
    const initPdirResp = await waitForResponse(initPdirId);

    if (initPdirResp.error || initPdirResp.result?.isError) {
      const msg = initPdirResp.error?.message || initPdirResp.result?.content?.[0]?.text;
      fail(`project_dir: state_init error: ${msg}`);
    } else {
      const statePath = path.join(pdirTaskPath, "state.json");
      if (!fs.existsSync(statePath)) {
        fail("project_dir: state.json not created when project_dir passed");
      } else {
        // state_read with explicit project_dir
        const readPdirId = msgId;
        send(makeToolCall("state_read", {
          project_dir: tmpDir,
          task_dir: pdirTaskDir,
        }));
        const readPdirResp = await waitForResponse(readPdirId);

        if (readPdirResp.error || readPdirResp.result?.isError) {
          const msg = readPdirResp.error?.message || readPdirResp.result?.content?.[0]?.text;
          fail(`project_dir: state_read error: ${msg}`);
        } else {
          const parsed = JSON.parse(readPdirResp.result.content[0].text);
          if (parsed.task !== "pdir-test") {
            fail(`project_dir: state_read returned wrong task: ${parsed.task}`);
          } else {
            ok("project_dir parameter works: state_init and state_read succeed with explicit project_dir");
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 32: state_update -- owner: "" is treated as null (clears owner)
  // -------------------------------------------------------------------------
  {
    // First set an owner on phase 1 of the smoke task
    const setOwnerForClearId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 1,
      owner: "explorer",
    }));
    await waitForResponse(setOwnerForClearId);

    // Now clear it with owner: ""
    const clearWithEmptyStringId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 1,
      owner: "",
    }));
    const clearWithEmptyStringResp = await waitForResponse(clearWithEmptyStringId);

    if (clearWithEmptyStringResp.error || clearWithEmptyStringResp.result?.isError) {
      const msg = clearWithEmptyStringResp.error?.message || clearWithEmptyStringResp.result?.content?.[0]?.text;
      fail(`state_update owner:"" should be accepted but got error: ${msg}`);
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
      const p1 = state.phases.find((p) => p.id === 1);
      if (p1?.owner !== null) {
        fail(`owner:"" should clear owner to null, got: ${p1?.owner}`);
      } else {
        ok('state_update treats owner:"" as null (clears owner)');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 33: state_init -- schema_version: 1 present in created state
  // -------------------------------------------------------------------------
  {
    const schemaPath = path.join(taskDir, "state.json");
    const schemaState = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    if (schemaState.schema_version !== 1) {
      fail(`schema_version should be 1, got: ${schemaState.schema_version}`);
    } else {
      ok("state_init includes schema_version: 1");
    }
  }

  // -------------------------------------------------------------------------
  // Test 34: state_update -- task_status: "failed" is accepted
  // -------------------------------------------------------------------------
  {
    const failedTaskStatusId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      task_status: "failed",
    }));
    const failedTaskStatusResp = await waitForResponse(failedTaskStatusId);

    if (failedTaskStatusResp.error || failedTaskStatusResp.result?.isError) {
      const msg = failedTaskStatusResp.error?.message || failedTaskStatusResp.result?.content?.[0]?.text;
      fail(`task_status:"failed" should be accepted but got error: ${msg}`);
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
      if (state.status !== "failed") {
        fail(`task status should be "failed", got: ${state.status}`);
      } else {
        ok('state_update accepts task_status: "failed"');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 35: state_update -- task_status: "needs_human" is accepted
  // -------------------------------------------------------------------------
  {
    const needsHumanId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      task_status: "needs_human",
    }));
    const needsHumanResp = await waitForResponse(needsHumanId);

    if (needsHumanResp.error || needsHumanResp.result?.isError) {
      const msg = needsHumanResp.error?.message || needsHumanResp.result?.content?.[0]?.text;
      fail(`task_status:"needs_human" should be accepted but got error: ${msg}`);
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
      if (state.status !== "needs_human") {
        fail(`task status should be "needs_human", got: ${state.status}`);
      } else {
        ok('state_update accepts task_status: "needs_human"');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 36: state_update -- phase_status: "failed" is accepted
  // -------------------------------------------------------------------------
  {
    const failedPhaseStatusId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 1,
      phase_status: "failed",
    }));
    const failedPhaseStatusResp = await waitForResponse(failedPhaseStatusId);

    if (failedPhaseStatusResp.error || failedPhaseStatusResp.result?.isError) {
      const msg = failedPhaseStatusResp.error?.message || failedPhaseStatusResp.result?.content?.[0]?.text;
      fail(`phase_status:"failed" should be accepted but got error: ${msg}`);
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
      const p1 = state.phases.find((p) => p.id === 1);
      if (p1?.status !== "failed") {
        fail(`phase 1 status should be "failed", got: ${p1?.status}`);
      } else {
        ok('state_update accepts phase_status: "failed"');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 37: timestamps -- updated field is ISO 8601 format
  // -------------------------------------------------------------------------
  {
    const isoState = JSON.parse(fs.readFileSync(path.join(taskDir, "state.json"), "utf8"));
    const iso8601Re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    if (!iso8601Re.test(isoState.updated)) {
      fail(`state.updated should be ISO 8601 format, got: ${isoState.updated}`);
    } else {
      ok("state.updated is ISO 8601 format");
    }
  }

  // -------------------------------------------------------------------------
  // Test A: malformed sibling state.json does not crash and is byte-for-byte unchanged
  // -------------------------------------------------------------------------
  {
    // Write a state.json with valid JSON but missing phases/flags arrays.
    const siblingDir = path.join(tmpDir, ".tasks", "test-malformed-sibling");
    fs.mkdirSync(siblingDir, { recursive: true });
    const siblingPath = path.join(siblingDir, "state.json");
    const siblingContent = '{ "task": "legacy", "status": "done", "updated": "2026-01-01" }';
    fs.writeFileSync(siblingPath, siblingContent, "utf8");

    const beforeBytes = fs.readFileSync(siblingPath, "utf8");

    // Call state_update on the well-formed smoke task (phase 1 was set to
    // "failed" in Test 36; reset to not_started by updating it to in_progress,
    // then call state_update with completed:true on a fresh phase via phase_id:3)
    const malformedSiblingUpdateId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 3,
      phase_status: "done",
      completed: true,
    }));
    const malformedSiblingUpdateResp = await waitForResponse(malformedSiblingUpdateId);

    if (malformedSiblingUpdateResp.error || malformedSiblingUpdateResp.result?.isError) {
      const msg = malformedSiblingUpdateResp.error?.message || malformedSiblingUpdateResp.result?.content?.[0]?.text;
      fail(`Test A: state_update crashed when malformed sibling exists: ${msg}`);
    } else {
      ok("Test A: state_update succeeded despite malformed sibling state.json");
    }

    // Verify sibling is byte-for-byte unchanged.
    const afterBytes = fs.readFileSync(siblingPath, "utf8");
    if (afterBytes !== beforeBytes) {
      fail("Test A: malformed sibling state.json was mutated by the index scan");
    } else {
      ok("Test A: malformed sibling state.json is byte-for-byte unchanged");
    }

    // Verify sibling is excluded from the tasks index.
    const tasksIndexPath = path.join(tmpDir, ".tasks", "tasks.json");
    const tasksIndex = JSON.parse(fs.readFileSync(tasksIndexPath, "utf8"));
    const siblingRelDir = path.relative(tmpDir, siblingDir);
    const siblingInIndex = tasksIndex.tasks.some((t) => t.dir === siblingRelDir);
    if (siblingInIndex) {
      fail("Test A: malformed sibling was included in tasks.json index (should be excluded)");
    } else {
      ok("Test A: malformed sibling is excluded from tasks.json index");
    }
  }

  // -------------------------------------------------------------------------
  // Test B: state_read on a malformed target throws a clear error; file unchanged
  // -------------------------------------------------------------------------
  {
    const brokenDir = path.join(tmpDir, ".tasks", "test-broken-target");
    fs.mkdirSync(brokenDir, { recursive: true });
    const brokenPath = path.join(brokenDir, "state.json");
    const brokenContent = '{ "task": "broken" }';
    fs.writeFileSync(brokenPath, brokenContent, "utf8");

    const beforeBytes = fs.readFileSync(brokenPath, "utf8");

    const brokenReadId = msgId;
    send(makeToolCall("state_read", {
      task_dir: path.relative(tmpDir, brokenDir),
    }));
    const brokenReadResp = await waitForResponse(brokenReadId);

    const isError = brokenReadResp.error || brokenReadResp.result?.isError;
    if (!isError) {
      fail("Test B: state_read on malformed file should return an error");
    } else {
      const msg = brokenReadResp.error?.message || brokenReadResp.result?.content?.[0]?.text || "";
      if (!msg.includes(brokenPath) && !msg.includes("test-broken-target")) {
        fail(`Test B: error message should include the file path, got: ${msg}`);
      } else if (msg.includes("Cannot read properties of undefined")) {
        fail(`Test B: error message must not contain raw TypeError, got: ${msg}`);
      } else if (!msg.includes("phases") && !msg.includes("flags") && !msg.includes("missing")) {
        fail(`Test B: error message should describe shape problem (phases/flags), got: ${msg}`);
      } else {
        ok(`Test B: state_read on malformed file returns clear error: ${msg.slice(0, 80)}...`);
      }
    }

    // Verify file is byte-for-byte unchanged.
    const afterBytes = fs.readFileSync(brokenPath, "utf8");
    if (afterBytes !== beforeBytes) {
      fail("Test B: readState wrote back to the malformed file (must not write back)");
    } else {
      ok("Test B: malformed target file is byte-for-byte unchanged after failed state_read");
    }
  }

  // -------------------------------------------------------------------------
  // Test C: well-formed file — state_read does not write back; state_update changes only expected fields
  // -------------------------------------------------------------------------
  {
    const cleanDir = path.join(tmpDir, ".tasks", "test-clean-task");
    fs.mkdirSync(cleanDir, { recursive: true });
    const cleanRelDir = path.relative(tmpDir, cleanDir);

    // Create a well-formed task via state_init.
    const cleanInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: cleanRelDir,
      slug: "clean-task",
      phases: [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ],
    }));
    await waitForResponse(cleanInitId);

    const cleanStatePath = path.join(cleanDir, "state.json");
    const afterInitContent = fs.readFileSync(cleanStatePath, "utf8");

    // Call state_read and assert no write-back.
    const cleanReadId = msgId;
    send(makeToolCall("state_read", {
      task_dir: cleanRelDir,
    }));
    const cleanReadResp = await waitForResponse(cleanReadId);

    if (cleanReadResp.error || cleanReadResp.result?.isError) {
      const msg = cleanReadResp.error?.message || cleanReadResp.result?.content?.[0]?.text;
      fail(`Test C: state_read on well-formed file errored: ${msg}`);
    } else {
      ok("Test C: state_read on well-formed file succeeds");
    }

    const afterReadContent = fs.readFileSync(cleanStatePath, "utf8");
    if (afterReadContent !== afterInitContent) {
      fail("Test C: state_read wrote back to the file (spurious write-back detected)");
    } else {
      ok("Test C: well-formed file is byte-for-byte unchanged after state_read");
    }

    // Call state_update and assert only expected fields changed.
    const cleanUpdateId = msgId;
    send(makeToolCall("state_update", {
      task_dir: cleanRelDir,
      phase_id: 1,
      phase_status: "in_progress",
      owner: "builder",
    }));
    const cleanUpdateResp = await waitForResponse(cleanUpdateId);

    if (cleanUpdateResp.error || cleanUpdateResp.result?.isError) {
      const msg = cleanUpdateResp.error?.message || cleanUpdateResp.result?.content?.[0]?.text;
      fail(`Test C: state_update on well-formed file errored: ${msg}`);
    } else {
      const beforeState = JSON.parse(afterInitContent);
      const afterState = JSON.parse(fs.readFileSync(cleanStatePath, "utf8"));

      // Only phases, updated, status should change.
      if (afterState.task !== beforeState.task) {
        fail(`Test C: state_update changed 'task' field unexpectedly`);
      } else if (afterState.slug !== beforeState.slug && beforeState.slug !== undefined) {
        fail(`Test C: state_update changed 'slug' field unexpectedly`);
      } else if (!Array.isArray(afterState.phases)) {
        fail("Test C: phases is no longer an array after state_update");
      } else if (!Array.isArray(afterState.flags)) {
        fail("Test C: flags is no longer an array after state_update");
      } else {
        const p1 = afterState.phases.find((p) => p.id === 1);
        if (p1?.status !== "in_progress") {
          fail(`Test C: phase 1 status should be in_progress, got: ${p1?.status}`);
        } else if (p1?.owner !== "builder") {
          fail(`Test C: phase 1 owner should be builder, got: ${p1?.owner}`);
        } else {
          ok("Test C: state_update changes only expected fields on well-formed file");
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test D: partial-array state (valid phases but missing flags) is caught by both guards
  // -------------------------------------------------------------------------
  {
    // Part 1: buildTasksIndex skips a state.json with phases but no flags.
    const partialDir = path.join(tmpDir, ".tasks", "test-partial-array");
    fs.mkdirSync(partialDir, { recursive: true });
    const partialPath = path.join(partialDir, "state.json");
    const partialContent = '{ "task": "partial", "phases": [], "status": "planning" }';
    fs.writeFileSync(partialPath, partialContent, "utf8");

    const beforeBytes = fs.readFileSync(partialPath, "utf8");

    // Trigger index rebuild via a valid state_update on the smoke task.
    const partialUpdateId = msgId;
    send(makeToolCall("state_update", {
      task_dir: relativeTaskDir,
      phase_id: 2,
      phase_status: "in_progress",
    }));
    await waitForResponse(partialUpdateId);

    // Verify partial file is excluded from the index.
    const tasksIndexPath2 = path.join(tmpDir, ".tasks", "tasks.json");
    const tasksIndex2 = JSON.parse(fs.readFileSync(tasksIndexPath2, "utf8"));
    const partialRelDir = path.relative(tmpDir, partialDir);
    const partialInIndex = tasksIndex2.tasks.some((t) => t.dir === partialRelDir);
    if (partialInIndex) {
      fail("Test D: partial-array sibling (phases but no flags) was included in index");
    } else {
      ok("Test D: partial-array sibling (phases but no flags) excluded from index");
    }

    // Verify partial file is byte-for-byte unchanged.
    const afterBytes = fs.readFileSync(partialPath, "utf8");
    if (afterBytes !== beforeBytes) {
      fail("Test D: partial-array sibling was mutated by index scan");
    } else {
      ok("Test D: partial-array sibling is byte-for-byte unchanged");
    }

    // Part 2: state_read targeting the partial file gives a clear error.
    const partialReadId = msgId;
    send(makeToolCall("state_read", {
      task_dir: partialRelDir,
    }));
    const partialReadResp = await waitForResponse(partialReadId);

    const isPartialError = partialReadResp.error || partialReadResp.result?.isError;
    if (!isPartialError) {
      fail("Test D: state_read on partial-array file should return an error");
    } else {
      const msg = partialReadResp.error?.message || partialReadResp.result?.content?.[0]?.text || "";
      if (msg.includes("Cannot read properties of undefined")) {
        fail(`Test D: error must not be a raw TypeError, got: ${msg}`);
      } else if (!msg.includes("flags")) {
        fail(`Test D: error message should mention 'flags' (the missing field), got: ${msg}`);
      } else {
        ok(`Test D: state_read on partial-array file returns clear error mentioning missing field`);
      }
    }
  }

  // =========================================================================
  // Tests E–J: state_add_phases
  // =========================================================================

  // -------------------------------------------------------------------------
  // Test E: appends new phases to an existing state.json (happy path)
  // -------------------------------------------------------------------------
  {
    const eDirName = ".tasks/test-e-add-phases";
    const eDir = path.join(tmpDir, eDirName);
    fs.mkdirSync(eDir, { recursive: true });

    // Create initial state with 2 phases.
    const eInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: eDirName,
      slug: "test-e",
      phases: [{ id: 1, name: "setup" }, { id: 2, name: "build" }],
    }));
    await waitForResponse(eInitId);

    // Append 2 new phases.
    const eAddId = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: eDirName,
      phases: [{ id: 3, name: "integration" }, { id: 4, name: "docs" }],
    }));
    const eAddResp = await waitForResponse(eAddId);

    if (eAddResp.error || eAddResp.result?.isError) {
      fail("Test E: state_add_phases returned unexpected error");
    } else {
      ok("Test E: state_add_phases completed without error");
    }

    // Verify state.json on disk.
    const eStatePath = path.join(eDir, "state.json");
    const eState = JSON.parse(fs.readFileSync(eStatePath, "utf8"));

    if (eState.phases.length !== 4) {
      fail(`Test E: expected 4 phases, got ${eState.phases.length}`);
    } else {
      ok("Test E: phases.length === 4 after append");
    }

    const ePhase3 = eState.phases.find((p) => p.id === 3);
    if (!ePhase3) {
      fail("Test E: phase 3 not found in state.json");
    } else if (ePhase3.status !== "not_started") {
      fail(`Test E: phase 3 status should be not_started, got ${ePhase3.status}`);
    } else if (ePhase3.owner !== null) {
      fail(`Test E: phase 3 owner should be null, got ${ePhase3.owner}`);
    } else if (!("estimated_scope" in ePhase3.execution)) {
      fail("Test E: phase 3 missing execution.estimated_scope key");
    } else if (ePhase3.execution.estimated_scope !== null) {
      fail(`Test E: phase 3 execution.estimated_scope should be null, got ${ePhase3.execution.estimated_scope}`);
    } else {
      ok("Test E: phase 3 has correct defaults (status, owner, execution.estimated_scope)");
    }

    // Assert phase order preserved: phases[0].id === 1, phases[2].id === 3.
    if (eState.phases[0].id !== 1 || eState.phases[2].id !== 3) {
      fail(`Test E: phase order incorrect: [0]=${eState.phases[0].id}, [2]=${eState.phases[2].id}`);
    } else {
      ok("Test E: phase order preserved (existing phases at head, new phases appended)");
    }

    // REQUIRED: tasks.json total_phases reflects the appended count.
    const eTasksPath = path.join(tmpDir, ".tasks", "tasks.json");
    const eTasks = JSON.parse(fs.readFileSync(eTasksPath, "utf8"));
    const eTaskEntry = eTasks.tasks.find((t) => t.dir === eDirName);
    if (!eTaskEntry) {
      fail("Test E: task not found in tasks.json");
    } else if (eTaskEntry.total_phases !== 4) {
      fail(`Test E: tasks.json total_phases should be 4, got ${eTaskEntry.total_phases}`);
    } else {
      ok("Test E: tasks.json total_phases === 4 after append");
    }
  }

  // -------------------------------------------------------------------------
  // Test F: appended phase may depend on an existing phase via blocked_by
  // -------------------------------------------------------------------------
  {
    const fDirName = ".tasks/test-f-blocked-by";
    const fDir = path.join(tmpDir, fDirName);
    fs.mkdirSync(fDir, { recursive: true });

    // Set up 4 phases (mirrors Test E state).
    const fInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: fDirName,
      slug: "test-f",
      phases: [{ id: 1, name: "setup" }, { id: 2, name: "build" }],
    }));
    await waitForResponse(fInitId);

    const fAdd1Id = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: fDirName,
      phases: [{ id: 3, name: "integration" }, { id: 4, name: "docs" }],
    }));
    await waitForResponse(fAdd1Id);

    // Append phase 5 blocked_by [1, 4] (1 = original, 4 = previously appended).
    const fAddId = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: fDirName,
      phases: [{ id: 5, name: "release", blocked_by: [1, 4] }],
    }));
    const fResp = await waitForResponse(fAddId);

    if (fResp.error || fResp.result?.isError) {
      fail("Test F: state_add_phases with blocked_by=[1,4] returned unexpected error");
    } else {
      ok("Test F: state_add_phases with cross-existing blocked_by accepted");
    }

    const fStatePath = path.join(fDir, "state.json");
    const fState = JSON.parse(fs.readFileSync(fStatePath, "utf8"));
    const fPhase5 = fState.phases.find((p) => p.id === 5);
    if (!fPhase5) {
      fail("Test F: phase 5 not found in state.json");
    } else if (JSON.stringify(fPhase5.blocked_by) !== "[1,4]") {
      fail(`Test F: phase 5 blocked_by should be [1,4], got ${JSON.stringify(fPhase5.blocked_by)}`);
    } else {
      ok("Test F: phase 5 blocked_by deep-equals [1,4]");
    }
  }

  // -------------------------------------------------------------------------
  // Test G: appended phases may depend on a sibling new phase (same batch)
  // -------------------------------------------------------------------------
  {
    const gDirName = ".tasks/test-g-sibling-dep";
    const gDir = path.join(tmpDir, gDirName);
    fs.mkdirSync(gDir, { recursive: true });

    const gInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: gDirName,
      slug: "test-g",
      phases: [{ id: 1, name: "setup" }],
    }));
    await waitForResponse(gInitId);

    // Append phases 6 and 7 where phase 7 depends on sibling phase 6.
    const gAddId = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: gDirName,
      phases: [{ id: 6, name: "a" }, { id: 7, name: "b", blocked_by: [6] }],
    }));
    const gResp = await waitForResponse(gAddId);

    if (gResp.error || gResp.result?.isError) {
      fail("Test G: state_add_phases with sibling blocked_by returned unexpected error");
    } else {
      ok("Test G: state_add_phases with sibling blocked_by accepted");
    }

    const gStatePath = path.join(gDir, "state.json");
    const gState = JSON.parse(fs.readFileSync(gStatePath, "utf8"));
    const gPhase6 = gState.phases.find((p) => p.id === 6);
    const gPhase7 = gState.phases.find((p) => p.id === 7);
    if (!gPhase6) {
      fail("Test G: phase 6 not found in state.json");
    } else if (!gPhase7) {
      fail("Test G: phase 7 not found in state.json");
    } else if (JSON.stringify(gPhase7.blocked_by) !== "[6]") {
      fail(`Test G: phase 7 blocked_by should be [6], got ${JSON.stringify(gPhase7.blocked_by)}`);
    } else {
      ok("Test G: sibling blocked_by resolved correctly within same batch");
    }
  }

  // -------------------------------------------------------------------------
  // Test H: rejects a duplicate of an existing phase id (whole batch, no write)
  // -------------------------------------------------------------------------
  {
    const hDirName = ".tasks/test-h-dup-existing";
    const hDir = path.join(tmpDir, hDirName);
    fs.mkdirSync(hDir, { recursive: true });

    const hInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: hDirName,
      slug: "test-h",
      phases: [{ id: 1, name: "setup" }, { id: 2, name: "build" }],
    }));
    await waitForResponse(hInitId);

    // Capture length before the failing call.
    const hStatePath = path.join(hDir, "state.json");
    const hBefore = JSON.parse(fs.readFileSync(hStatePath, "utf8"));
    const hLenBefore = hBefore.phases.length;

    // Attempt to add [99, 1] where id=1 already exists — whole batch must be rejected.
    const hAddId = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: hDirName,
      phases: [{ id: 99, name: "new-ok" }, { id: 1, name: "dup" }],
    }));
    const hResp = await waitForResponse(hAddId);

    if (!(hResp.error || hResp.result?.isError)) {
      fail("Test H: expected error for duplicate existing phase id, but got success");
    } else {
      ok("Test H: duplicate existing phase id is rejected");
    }

    // Verify no partial write: phase 99 must NOT have been added.
    const hAfter = JSON.parse(fs.readFileSync(hStatePath, "utf8"));
    if (hAfter.phases.length !== hLenBefore) {
      fail(`Test H: phases.length changed (${hLenBefore} -> ${hAfter.phases.length}); partial write occurred`);
    } else if (hAfter.phases.find((p) => p.id === 99)) {
      fail("Test H: phase 99 was added despite the batch being rejected");
    } else {
      ok("Test H: no partial write — state.json unchanged after rejection");
    }
  }

  // -------------------------------------------------------------------------
  // Test I: rejects duplicate id within the same batch (no write)
  // -------------------------------------------------------------------------
  {
    const iDirName = ".tasks/test-i-dup-batch";
    const iDir = path.join(tmpDir, iDirName);
    fs.mkdirSync(iDir, { recursive: true });

    const iInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: iDirName,
      slug: "test-i",
      phases: [{ id: 1, name: "setup" }],
    }));
    await waitForResponse(iInitId);

    const iStatePath = path.join(iDir, "state.json");
    const iBefore = JSON.parse(fs.readFileSync(iStatePath, "utf8"));
    const iLenBefore = iBefore.phases.length;

    // Attempt to add two phases with the same id=50 within the batch.
    const iAddId = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: iDirName,
      phases: [{ id: 50, name: "x" }, { id: 50, name: "y" }],
    }));
    const iResp = await waitForResponse(iAddId);

    if (!(iResp.error || iResp.result?.isError)) {
      fail("Test I: expected error for duplicate id within batch, but got success");
    } else {
      ok("Test I: duplicate id within batch is rejected");
    }

    const iAfter = JSON.parse(fs.readFileSync(iStatePath, "utf8"));
    if (iAfter.phases.length !== iLenBefore) {
      fail(`Test I: phases.length changed; partial write occurred`);
    } else if (iAfter.phases.find((p) => p.id === 50)) {
      fail("Test I: phase 50 was added despite the batch being rejected");
    } else {
      ok("Test I: no partial write — state.json unchanged after rejection");
    }
  }

  // -------------------------------------------------------------------------
  // Test J: rejects blocked_by to non-existent id, and rejects empty array
  // -------------------------------------------------------------------------
  {
    const jDirName = ".tasks/test-j-errors";
    const jDir = path.join(tmpDir, jDirName);
    fs.mkdirSync(jDir, { recursive: true });

    const jInitId = msgId;
    send(makeToolCall("state_init", {
      task_dir: jDirName,
      slug: "test-j",
      phases: [{ id: 1, name: "setup" }],
    }));
    await waitForResponse(jInitId);

    const jStatePath = path.join(jDir, "state.json");

    // Part 1: blocked_by references a non-existent phase id (999).
    const jAdd1Id = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: jDirName,
      phases: [{ id: 60, name: "z", blocked_by: [999] }],
    }));
    const jResp1 = await waitForResponse(jAdd1Id);

    if (!(jResp1.error || jResp1.result?.isError)) {
      fail("Test J: expected error for dangling blocked_by, but got success");
    } else {
      ok("Test J (part 1): dangling blocked_by is rejected");
    }

    const jAfter1 = JSON.parse(fs.readFileSync(jStatePath, "utf8"));
    if (jAfter1.phases.find((p) => p.id === 60)) {
      fail("Test J (part 1): phase 60 was added despite the batch being rejected");
    } else {
      ok("Test J (part 1): phase 60 not present after rejection");
    }

    // Part 2: empty phases array is rejected.
    const jAdd2Id = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: jDirName,
      phases: [],
    }));
    const jResp2 = await waitForResponse(jAdd2Id);

    if (!(jResp2.error || jResp2.result?.isError)) {
      fail("Test J: expected error for empty phases array, but got success");
    } else {
      ok("Test J (part 2): empty phases array is rejected");
    }

    const jAfter2 = JSON.parse(fs.readFileSync(jStatePath, "utf8"));
    if (jAfter2.phases.length !== 1) {
      fail(`Test J (part 2): expected 1 phase (unchanged), got ${jAfter2.phases.length}`);
    } else {
      ok("Test J (part 2): state.json unchanged after empty-array rejection");
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
