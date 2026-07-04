#!/usr/bin/env node
// E2E test for state-server.js -- full task lifecycle
//
// Simulates a realistic 4-phase task with parallel groups, flags, and
// auto-completion. Uses MCP-over-stdio (JSON-RPC) exactly like the live
// Claude Code client would.
//
// Run: node scripts/test-e2e.js
// Exit 0 = all pass, exit 1 = one or more failures.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

// ---------------------------------------------------------------------------
// Setup: temporary project root so CLAUDE_PROJECT_DIR is isolated
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-e2e-"));
const taskSlug = "lifecycle";
const taskRelDir = ".tasks/test-e2e-lifecycle";
const taskAbsDir = path.join(tmpDir, taskRelDir);
fs.mkdirSync(taskAbsDir, { recursive: true });

// ---------------------------------------------------------------------------
// JSON-RPC helpers (same pattern as test-state-server.js)
// ---------------------------------------------------------------------------

let msgId = 1;

function makeCall(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id: msgId++, method, params }) + "\n";
}

function makeToolCall(toolName, args) {
  return makeCall("tools/call", { name: toolName, arguments: args });
}

// ---------------------------------------------------------------------------
// Main test runner
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
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try { responses.push(JSON.parse(line)); } catch (_) {}
      }
    }
  });

  proc.stderr.on("data", (d) => {
    if (process.env.DEBUG) process.stderr.write(d);
  });

  const waitFor = (targetId) =>
    new Promise((resolve) => {
      const check = () => {
        const resp = responses.find((r) => r.id === targetId);
        if (resp) resolve(resp);
        else setTimeout(check, 10);
      };
      check();
    });

  const send = (msg) => proc.stdin.write(msg);

  // Initialize the MCP handshake
  const initId = msgId;
  send(makeCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-runner", version: "1.0" },
  }));
  await waitFor(initId);

  // ---------------------------------------------------------------------------
  // Test result tracking
  // ---------------------------------------------------------------------------

  let passed = 0;
  let failed = 0;

  function pass(n, label) {
    passed++;
    console.log(`${String(n).padStart(2)}. ✓ ${label}`);
  }

  function fail(n, label, expected, received) {
    failed++;
    console.log(`${String(n).padStart(2)}. ✗ ${label}`);
    if (expected !== undefined) console.log(`       expected: ${expected}`);
    if (received !== undefined) console.log(`       received: ${received}`);
  }

  function isError(resp) {
    return resp.error || resp.result?.isError;
  }

  function errMsg(resp) {
    return resp.error?.message || resp.result?.content?.[0]?.text || "(unknown error)";
  }

  function readStateFile() {
    return JSON.parse(fs.readFileSync(path.join(taskAbsDir, "state.json"), "utf8"));
  }

  console.log("=== E2E Test: Full Task Lifecycle ===\n");

  // ---------------------------------------------------------------------------
  // Step 1: Task creation -- state_init with 4 phases
  // (project_dir passed explicitly to exercise that code path)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_init", {
      project_dir: tmpDir,
      task_dir: taskRelDir,
      slug: taskSlug,
      phases: [
        { id: 1, name: "Setup" },
        { id: 2, name: "Core feature", blocked_by: [1] },
        { id: 3, name: "Tests", blocked_by: [2], parallel_group: "A" },
        { id: 4, name: "Docs", blocked_by: [2], parallel_group: "A" },
      ],
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(1, "Task created with 4 phases", "success", errMsg(resp));
    } else {
      const stateFile = path.join(taskAbsDir, "state.json");
      if (!fs.existsSync(stateFile)) {
        fail(1, "Task created with 4 phases", "state.json exists", "file missing");
      } else {
        pass(1, "Task created with 4 phases");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: Verify initial state -- state_read (project_dir passed explicitly)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_read", { project_dir: tmpDir, task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(2, "Initial state correct (all not_started, planning)", "success", errMsg(resp));
    } else {
      const state = JSON.parse(resp.result.content[0].text);
      const allNotStarted = state.phases.every((p) => p.status === "not_started");
      const p2 = state.phases.find((p) => p.id === 2);
      const p3 = state.phases.find((p) => p.id === 3);
      const p4 = state.phases.find((p) => p.id === 4);
      const depsOk =
        JSON.stringify(p2?.blocked_by) === "[2]"
          ? false // wrong
          : JSON.stringify(p2?.blocked_by) === "[1]" &&
            JSON.stringify(p3?.blocked_by) === "[2]" &&
            JSON.stringify(p4?.blocked_by) === "[2]" &&
            p3?.parallel_group === "A" &&
            p4?.parallel_group === "A";
      if (state.status !== "planning") {
        fail(2, "Initial state correct (all not_started, planning)", "status=planning", `status=${state.status}`);
      } else if (!allNotStarted) {
        fail(2, "Initial state correct (all not_started, planning)", "all not_started", "some phases have other status");
      } else if (!depsOk) {
        fail(2, "Initial state correct (all not_started, planning)", "blocked_by and parallel_group populated", "mismatch");
      } else {
        pass(2, "Initial state correct (all not_started, planning)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Plan Phase 1 -- state_update phase 1 -> planned
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      phase_status: "planned",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(3, "Phase 1 planned", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const p1 = state.phases.find((p) => p.id === 1);
      const othersUnchanged = state.phases.filter((p) => p.id !== 1).every((p) => p.status === "not_started");
      if (p1?.status !== "planned") {
        fail(3, "Phase 1 planned", "phase 1 status=planned", `status=${p1?.status}`);
      } else if (!othersUnchanged) {
        fail(3, "Phase 1 planned", "phases 2-4 still not_started", "some changed");
      } else {
        pass(3, "Phase 1 planned");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Review Phase 1 -- state_update phase 1 -> reviewed
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      phase_status: "reviewed",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(4, "Phase 1 reviewed", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const p1 = state.phases.find((p) => p.id === 1);
      if (p1?.status !== "reviewed") {
        fail(4, "Phase 1 reviewed", "phase 1 status=reviewed", `status=${p1?.status}`);
      } else {
        pass(4, "Phase 1 reviewed");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: Start Phase 1 -- in_progress + execution metadata
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      phase_status: "in_progress",
      owner: "builder",
      started: true,
      task_status: "in_progress",
      execution_model: "sonnet",
      execution_effort: "medium",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const p1 = state.phases.find((p) => p.id === 1);
      if (p1?.status !== "in_progress") {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "status=in_progress", `status=${p1?.status}`);
      } else if (p1?.owner !== "builder") {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "owner=builder", `owner=${p1?.owner}`);
      } else if (!p1?.started) {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "started date set", "started=null");
      } else if (state.status !== "in_progress") {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "task status=in_progress", `task status=${state.status}`);
      } else if (p1?.execution?.model !== "sonnet") {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "execution.model=sonnet", `${p1?.execution?.model}`);
      } else if (p1?.execution?.effort !== "medium") {
        fail(5, "Phase 1 in_progress (owner: builder, execution metadata set)", "execution.effort=medium", `${p1?.execution?.effort}`);
      } else {
        pass(5, "Phase 1 in_progress (owner: builder, execution metadata set)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6: Complete Phase 1
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      phase_status: "done",
      owner: null,
      completed: true,
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(6, "Phase 1 done", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const p1 = state.phases.find((p) => p.id === 1);
      if (p1?.status !== "done") {
        fail(6, "Phase 1 done", "phase 1 status=done", `status=${p1?.status}`);
      } else if (p1?.owner !== null) {
        fail(6, "Phase 1 done", "owner=null", `owner=${p1?.owner}`);
      } else if (!p1?.completed) {
        fail(6, "Phase 1 done", "completed date set", "completed=null");
      } else {
        pass(6, "Phase 1 done");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 7: Phase 2 rapid transitions: planned -> reviewed -> in_progress
  // ---------------------------------------------------------------------------
  {
    let stepOk = true;
    let stepMsg = "";

    // planned
    const planId = msgId;
    send(makeToolCall("state_update", { task_dir: taskRelDir, phase_id: 2, phase_status: "planned" }));
    const planResp = await waitFor(planId);
    if (isError(planResp)) { stepOk = false; stepMsg = `planned failed: ${errMsg(planResp)}`; }

    // reviewed
    const reviewId = msgId;
    send(makeToolCall("state_update", { task_dir: taskRelDir, phase_id: 2, phase_status: "reviewed" }));
    const reviewResp = await waitFor(reviewId);
    if (isError(reviewResp)) { stepOk = false; stepMsg = `reviewed failed: ${errMsg(reviewResp)}`; }

    // in_progress
    const startId = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 2,
      phase_status: "in_progress",
      owner: "builder",
      started: true,
    }));
    const startResp = await waitFor(startId);
    if (isError(startResp)) { stepOk = false; stepMsg = `in_progress failed: ${errMsg(startResp)}`; }

    if (!stepOk) {
      fail(7, "Phase 2 planned -> reviewed -> in_progress", "success", stepMsg);
    } else {
      const state = readStateFile();
      const p2 = state.phases.find((p) => p.id === 2);
      if (p2?.status !== "in_progress") {
        fail(7, "Phase 2 planned -> reviewed -> in_progress", "status=in_progress", `status=${p2?.status}`);
      } else {
        pass(7, "Phase 2 planned -> reviewed -> in_progress");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 8: Complete Phase 2
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 2,
      phase_status: "done",
      owner: null,
      completed: true,
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(8, "Phase 2 done", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const p2 = state.phases.find((p) => p.id === 2);
      if (p2?.status !== "done") {
        fail(8, "Phase 2 done", "phase 2 status=done", `status=${p2?.status}`);
      } else {
        pass(8, "Phase 2 done");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 9: Session prime check -- 2/4 complete, no blockers; verify parallel
  //         group A is stored in state (prime shows group info in Next line only
  //         when multiple upcoming phases share a group; at this point phase 3
  //         is "current" so only phase 4 appears in Next -- single, no group label)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_prime", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(9, "Session prime: 2/4 complete, parallel group A visible", "success", errMsg(resp));
    } else {
      const text = resp.result.content[0].text;
      const has2of4 = text.includes("2/4");
      const hasNoBlockers = text.includes("Blockers: None");
      // Parallel group lives in state.json; verify both phases carry group "A"
      const state = readStateFile();
      const p3 = state.phases.find((p) => p.id === 3);
      const p4 = state.phases.find((p) => p.id === 4);
      const groupsOk = p3?.parallel_group === "A" && p4?.parallel_group === "A";
      if (!has2of4) {
        fail(9, "Session prime: 2/4 complete, parallel group A visible", "2/4 in prime output", text);
      } else if (!hasNoBlockers) {
        fail(9, "Session prime: 2/4 complete, parallel group A visible", "Blockers: None in prime", text);
      } else if (!groupsOk) {
        fail(9, "Session prime: 2/4 complete, parallel group A visible", "phases 3+4 parallel_group=A in state", `p3=${p3?.parallel_group}, p4=${p4?.parallel_group}`);
      } else {
        pass(9, "Session prime: 2/4 complete, parallel group A visible");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 10: Plan + Review phases 3 & 4
  // ---------------------------------------------------------------------------
  {
    let stepOk = true;
    let stepMsg = "";

    for (const phaseId of [3, 4]) {
      const planId = msgId;
      send(makeToolCall("state_update", { task_dir: taskRelDir, phase_id: phaseId, phase_status: "planned" }));
      const planResp = await waitFor(planId);
      if (isError(planResp)) { stepOk = false; stepMsg = `phase ${phaseId} planned: ${errMsg(planResp)}`; }

      const reviewId = msgId;
      send(makeToolCall("state_update", { task_dir: taskRelDir, phase_id: phaseId, phase_status: "reviewed" }));
      const reviewResp = await waitFor(reviewId);
      if (isError(reviewResp)) { stepOk = false; stepMsg = `phase ${phaseId} reviewed: ${errMsg(reviewResp)}`; }
    }

    if (!stepOk) {
      fail(10, "Phases 3+4 planned and reviewed", "success", stepMsg);
    } else {
      const state = readStateFile();
      const p3 = state.phases.find((p) => p.id === 3);
      const p4 = state.phases.find((p) => p.id === 4);
      if (p3?.status !== "reviewed" || p4?.status !== "reviewed") {
        fail(10, "Phases 3+4 planned and reviewed", "both reviewed", `p3=${p3?.status}, p4=${p4?.status}`);
      } else {
        pass(10, "Phases 3+4 planned and reviewed");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 11: Start both parallel phases (Conductor fan-out)
  // ---------------------------------------------------------------------------
  {
    let stepOk = true;
    let stepMsg = "";

    const start3Id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 3,
      phase_status: "in_progress",
      owner: "builder",
      started: true,
    }));
    const start3Resp = await waitFor(start3Id);
    if (isError(start3Resp)) { stepOk = false; stepMsg = `phase 3 start: ${errMsg(start3Resp)}`; }

    const start4Id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 4,
      phase_status: "in_progress",
      owner: "builder",
      started: true,
    }));
    const start4Resp = await waitFor(start4Id);
    if (isError(start4Resp)) { stepOk = false; stepMsg = `phase 4 start: ${errMsg(start4Resp)}`; }

    if (!stepOk) {
      fail(11, "Phases 3+4 in_progress (parallel fan-out)", "success", stepMsg);
    } else {
      const state = readStateFile();
      const p3 = state.phases.find((p) => p.id === 3);
      const p4 = state.phases.find((p) => p.id === 4);
      if (p3?.status !== "in_progress" || p4?.status !== "in_progress") {
        fail(11, "Phases 3+4 in_progress (parallel fan-out)", "both in_progress", `p3=${p3?.status}, p4=${p4?.status}`);
      } else {
        pass(11, "Phases 3+4 in_progress (parallel fan-out)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 12: Add a flag -- error on phase 3
  // ---------------------------------------------------------------------------
  let generatedFlagId;
  {
    const id = msgId;
    send(makeToolCall("state_flag", {
      task_dir: taskRelDir,
      phase_id: 3,
      type: "error",
      message: "Build failed -- missing dependency",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(12, "Flag added (error on phase 3)", "success", errMsg(resp));
    } else {
      const state = readStateFile();
      const flag = state.flags[0];
      if (state.flags.length !== 1) {
        fail(12, "Flag added (error on phase 3)", "1 flag", `${state.flags.length} flags`);
      } else if (!flag.id.startsWith("f-3-")) {
        fail(12, "Flag added (error on phase 3)", "flag id starts with f-3-", flag.id);
      } else if (flag.type !== "error") {
        fail(12, "Flag added (error on phase 3)", "type=error", flag.type);
      } else {
        generatedFlagId = flag.id;
        pass(12, "Flag added (error on phase 3)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 13: Session prime with flag -- shows "1 active"
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_prime", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(13, "Session prime shows 1 active flag", "success", errMsg(resp));
    } else {
      const text = resp.result.content[0].text;
      if (!text.includes("1 active")) {
        fail(13, "Session prime shows 1 active flag", "'1 active' in output", text);
      } else {
        pass(13, "Session prime shows 1 active flag");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 14: Clear flag
  // ---------------------------------------------------------------------------
  {
    if (!generatedFlagId) {
      fail(14, "Flag cleared", "flag ID from step 12", "undefined (step 12 failed)");
    } else {
      const id = msgId;
      send(makeToolCall("state_clear_flag", {
        task_dir: taskRelDir,
        flag_id: generatedFlagId,
      }));
      const resp = await waitFor(id);
      if (isError(resp)) {
        fail(14, "Flag cleared", "success", errMsg(resp));
      } else {
        const state = readStateFile();
        if (state.flags.length !== 0) {
          fail(14, "Flag cleared", "0 flags", `${state.flags.length} flags`);
        } else {
          pass(14, "Flag cleared");
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 15: Complete phases 3 & 4 -- task should auto-complete
  // ---------------------------------------------------------------------------
  {
    let stepOk = true;
    let stepMsg = "";

    for (const phaseId of [3, 4]) {
      const doneId = msgId;
      send(makeToolCall("state_update", {
        task_dir: taskRelDir,
        phase_id: phaseId,
        phase_status: "done",
        owner: null,
        completed: true,
      }));
      const doneResp = await waitFor(doneId);
      if (isError(doneResp)) { stepOk = false; stepMsg = `phase ${phaseId} done: ${errMsg(doneResp)}`; }
    }

    if (!stepOk) {
      fail(15, "Phases 3+4 done -- task auto-completed", "success", stepMsg);
    } else {
      const state = readStateFile();
      const p3 = state.phases.find((p) => p.id === 3);
      const p4 = state.phases.find((p) => p.id === 4);
      if (p3?.status !== "done" || p4?.status !== "done") {
        fail(15, "Phases 3+4 done -- task auto-completed", "both done", `p3=${p3?.status}, p4=${p4?.status}`);
      } else if (state.status !== "done") {
        fail(15, "Phases 3+4 done -- task auto-completed", "task status=done", `task status=${state.status}`);
      } else {
        pass(15, "Phases 3+4 done -- task auto-completed");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 16: Final state_prime -- 4/4 complete, status done
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_prime", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(16, "Final prime: 4/4 complete, status done", "success", errMsg(resp));
    } else {
      const text = resp.result.content[0].text;
      const has4of4 = text.includes("4/4");
      const hasDone = text.toLowerCase().includes("done");
      if (!has4of4) {
        fail(16, "Final prime: 4/4 complete, status done", "4/4 in output", text);
      } else if (!hasDone) {
        fail(16, "Final prime: 4/4 complete, status done", "'done' in output", text);
      } else {
        pass(16, "Final prime: 4/4 complete, status done");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 17: tasks_list -- includes completed task (project_dir passed explicitly)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("tasks_list", { project_dir: tmpDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(17, "Tasks index includes completed task", "success", errMsg(resp));
    } else {
      const index = JSON.parse(resp.result.content[0].text);
      const entry = index.tasks.find((t) => t.slug === taskSlug);
      if (!entry) {
        fail(17, "Tasks index includes completed task", `entry with slug=${taskSlug}`, "entry not found");
      } else if (entry.completed_phases !== 4) {
        fail(17, "Tasks index includes completed task", "completed_phases=4", `completed_phases=${entry.completed_phases}`);
      } else if (entry.status !== "done") {
        fail(17, "Tasks index includes completed task", "status=done", `status=${entry.status}`);
      } else {
        pass(17, "Tasks index includes completed task");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 18: Cleanup
  // ---------------------------------------------------------------------------
  {
    proc.stdin.end();
    await new Promise((resolve) => proc.on("close", resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      pass(18, "Cleanup done");
    } catch (err) {
      fail(18, "Cleanup done", "no error", err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const total = passed + failed;
  console.log(`\nResult: ${passed}/${total} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
