#!/usr/bin/env node
// E2E test for state-server.js -- MCP tools over task.json v2 (D33).
//
// Exercises every MCP tool (state_init, state_read, state_update, state_flag,
// state_clear_flag, state_prime, state_add_phases, tasks_list, task_set)
// over JSON-RPC/stdio exactly like the live Claude Code client. Uses legal v2
// operations: owner/task_status updates (no transition guard), flags, terminal
// transitions (failed/skipped — no guard), and task_set. The full planned →
// landed → done lifecycle (plan_path, reviewer verdicts, commits, landing) is
// exercised by test-lib-transitions.js and the A4 hooks; this test verifies the
// MCP surface itself works end-to-end on task.json.
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
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-e2e-tasks-"));
const taskSlug = "lifecycle";
const taskRelDir = "test-e2e-lifecycle";

// D35: tasks live at the central root. Compute the absolute path for verification.
const { repoKey } = require("./lib/repo");
const { tasksRoot } = require("./lib/tasks-root");
const e2eKey = repoKey(tmpDir);
const taskAbsDir = path.join(tasksRoot(e2eKey), taskRelDir);

// ---------------------------------------------------------------------------
// JSON-RPC helpers
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
  const e2eEnv = { ...process.env, CLAUDE_PROJECT_DIR: tmpDir };
  const proc = spawn(process.execPath, ["scripts/state-server.js"], {
    env: e2eEnv,
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

  const initId = msgId;
  send(makeCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-runner", version: "1.0" },
  }));
  await waitFor(initId);

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

  function readTaskFile() {
    return JSON.parse(fs.readFileSync(path.join(taskAbsDir, "task.json"), "utf8"));
  }

  console.log("=== E2E Test: MCP tools over task.json v2 ===\n");

  // ---------------------------------------------------------------------------
  // Step 1: state_init creates task.json (D33: not state.json) with 4 phases
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
      fail(1, "state_init creates task.json with 4 phases", "success", errMsg(resp));
    } else if (!fs.existsSync(path.join(taskAbsDir, "task.json"))) {
      fail(1, "state_init creates task.json with 4 phases", "task.json exists", "missing");
    } else if (fs.existsSync(path.join(taskAbsDir, "state.json"))) {
      fail(1, "state_init creates task.json with 4 phases", "no state.json (D33)", "state.json exists");
    } else {
      pass(1, "state_init creates task.json with 4 phases (no state.json, D33)");
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: state_read returns the v2 task with correct initial state
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_read", { project_dir: tmpDir, task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(2, "state_read returns v2 task with initial state", "success", errMsg(resp));
    } else {
      const task = JSON.parse(resp.result.content[0].text);
      const allNotStarted = task.phases.every((p) => p.status === "not_started");
      const p2 = task.phases.find((p) => p.id === 2);
      const p3 = task.phases.find((p) => p.id === 3);
      const p4 = task.phases.find((p) => p.id === 4);
      const depsOk =
        JSON.stringify(p2?.blocked_by) === "[1]" &&
        JSON.stringify(p3?.blocked_by) === "[2]" &&
        JSON.stringify(p4?.blocked_by) === "[2]" &&
        p3?.parallel_group === "A" && p4?.parallel_group === "A";
      if (task.schema !== 2) {
        fail(2, "state_read returns v2 task with initial state", "schema=2", `schema=${task.schema}`);
      } else if (task.slug !== taskSlug) {
        fail(2, "state_read returns v2 task with initial state", `slug=${taskSlug}`, `slug=${task.slug}`);
      } else if (task.status !== "planning") {
        fail(2, "state_read returns v2 task with initial state", "status=planning", `status=${task.status}`);
      } else if (!allNotStarted) {
        fail(2, "state_read returns v2 task with initial state", "all not_started", "some changed");
      } else if (!depsOk) {
        fail(2, "state_read returns v2 task with initial state", "blocked_by + parallel_group", "mismatch");
      } else {
        pass(2, "state_read returns v2 task with correct initial state");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: state_update sets owner + started (no transition guard)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      owner: "builder",
      started: true,
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(3, "state_update sets owner + started", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      const p1 = task.phases.find((p) => p.id === 1);
      if (p1?.owner !== "builder") {
        fail(3, "state_update sets owner + started", "owner=builder", `owner=${p1?.owner}`);
      } else if (!p1?.started) {
        fail(3, "state_update sets owner + started", "started set", "started=null");
      } else {
        pass(3, "state_update sets owner + started (no transition guard)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: state_update sets task_status (task-level, no phase transition)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      task_status: "in_progress",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(4, "state_update sets task_status in_progress", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      if (task.status !== "in_progress") {
        fail(4, "state_update sets task_status in_progress", "status=in_progress", `status=${task.status}`);
      } else {
        pass(4, "state_update sets task_status in_progress");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: state_flag adds a flag (error on phase 3)
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
      fail(5, "state_flag adds flag (error on phase 3)", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      const flag = task.flags[0];
      if (task.flags.length !== 1) {
        fail(5, "state_flag adds flag (error on phase 3)", "1 flag", `${task.flags.length} flags`);
      } else if (!flag.id.startsWith("f-3-")) {
        fail(5, "state_flag adds flag (error on phase 3)", "id starts f-3-", flag.id);
      } else if (flag.type !== "error") {
        fail(5, "state_flag adds flag (error on phase 3)", "type=error", flag.type);
      } else {
        generatedFlagId = flag.id;
        pass(5, "state_flag adds flag (error on phase 3)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6: state_prime returns `a next` JSON (D33: v2 returns computeNext)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_prime", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(6, "state_prime returns a-next JSON", "success", errMsg(resp));
    } else {
      const prime = JSON.parse(resp.result.content[0].text);
      if (!prime.step) {
        fail(6, "state_prime returns a-next JSON", "step present", `step=${prime.step}`);
      } else if (!Array.isArray(prime.phase_ids)) {
        fail(6, "state_prime returns a-next JSON", "phase_ids array", `phase_ids=${prime.phase_ids}`);
      } else if (!prime.reason) {
        fail(6, "state_prime returns a-next JSON", "reason present", `reason=${prime.reason}`);
      } else {
        pass(6, "state_prime returns a-next JSON (step, phase_ids, reason)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 7: state_clear_flag removes the flag by ID
  // ---------------------------------------------------------------------------
  {
    if (!generatedFlagId) {
      fail(7, "state_clear_flag removes flag", "flag ID from step 5", "undefined");
    } else {
      const id = msgId;
      send(makeToolCall("state_clear_flag", {
        task_dir: taskRelDir,
        flag_id: generatedFlagId,
      }));
      const resp = await waitFor(id);
      if (isError(resp)) {
        fail(7, "state_clear_flag removes flag", "success", errMsg(resp));
      } else {
        const task = readTaskFile();
        if (task.flags.length !== 0) {
          fail(7, "state_clear_flag removes flag", "0 flags", `${task.flags.length} flags`);
        } else {
          pass(7, "state_clear_flag removes flag by ID");
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 8: state_add_phases appends a new phase 5
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_add_phases", {
      task_dir: taskRelDir,
      phases: [{ id: 5, name: "Release", blocked_by: [1] }],
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(8, "state_add_phases appends phase 5", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      const p5 = task.phases.find((p) => p.id === 5);
      if (task.phases.length !== 5) {
        fail(8, "state_add_phases appends phase 5", "5 phases", `${task.phases.length} phases`);
      } else if (!p5 || p5.status !== "not_started") {
        fail(8, "state_add_phases appends phase 5", "phase 5 not_started", `status=${p5?.status}`);
      } else if (JSON.stringify(p5.blocked_by) !== "[1]") {
        fail(8, "state_add_phases appends phase 5", "blocked_by=[1]", JSON.stringify(p5.blocked_by));
      } else {
        pass(8, "state_add_phases appends phase 5 with blocked_by");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 9: task_set sets a knob (enforcement: warn)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("task_set", {
      task_dir: taskRelDir,
      knob: "enforcement",
      value: "warn",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(9, "task_set sets enforcement=warn", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      if (task.knobs?.enforcement !== "warn") {
        fail(9, "task_set sets enforcement=warn", "enforcement=warn", `enforcement=${task.knobs?.enforcement}`);
      } else {
        pass(9, "task_set sets enforcement=warn");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 10: state_update transitions phase 1 to failed (terminal, no guard)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_update", {
      task_dir: taskRelDir,
      phase_id: 1,
      phase_status: "failed",
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(10, "state_update transitions phase 1 to failed", "success", errMsg(resp));
    } else {
      const task = readTaskFile();
      const p1 = task.phases.find((p) => p.id === 1);
      if (p1?.status !== "failed") {
        fail(10, "state_update transitions phase 1 to failed", "status=failed", `status=${p1?.status}`);
      } else {
        pass(10, "state_update transitions phase 1 to failed (terminal, no guard)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 11: state_update transitions remaining phases to skipped (terminal)
  // ---------------------------------------------------------------------------
  {
    let stepOk = true;
    let stepMsg = "";
    for (const phaseId of [2, 3, 4, 5]) {
      const id = msgId;
      send(makeToolCall("state_update", {
        task_dir: taskRelDir,
        phase_id: phaseId,
        phase_status: "skipped",
      }));
      const resp = await waitFor(id);
      if (isError(resp)) { stepOk = false; stepMsg = `phase ${phaseId}: ${errMsg(resp)}`; }
    }
    if (!stepOk) {
      fail(11, "state_update transitions phases 2-5 to skipped", "success", stepMsg);
    } else {
      const task = readTaskFile();
      const allTerminal = task.phases.every(
        (p) => p.status === "failed" || p.status === "skipped" || p.status === "done"
      );
      if (!allTerminal) {
        fail(11, "state_update transitions phases 2-5 to skipped", "all terminal", task.phases.map((p) => p.status).join(","));
      } else {
        pass(11, "state_update transitions phases 2-5 to skipped (terminal)");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 12: task auto-completes to done when all phases are terminal
  // ---------------------------------------------------------------------------
  {
    const task = readTaskFile();
    if (task.status !== "done") {
      fail(12, "Task auto-completes to done", "status=done", `status=${task.status}`);
    } else {
      pass(12, "Task auto-completes to done when all phases are failed/skipped");
    }
  }

  // ---------------------------------------------------------------------------
  // Step 13: state_prime on the completed task returns step=done
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_prime", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(13, "state_prime on completed task returns done", "success", errMsg(resp));
    } else {
      const prime = JSON.parse(resp.result.content[0].text);
      if (prime.step !== "done") {
        fail(13, "state_prime on completed task returns done", "step=done", `step=${prime.step}`);
      } else {
        pass(13, "state_prime on completed task returns step=done");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 14: tasks_list includes the completed task
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("tasks_list", { project_dir: tmpDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(14, "tasks_list includes completed task", "success", errMsg(resp));
    } else {
      const index = JSON.parse(resp.result.content[0].text);
      const entry = index.tasks.find((t) => t.slug === taskSlug);
      if (!entry) {
        fail(14, "tasks_list includes completed task", `entry slug=${taskSlug}`, "not found");
      } else if (entry.status !== "done") {
        fail(14, "tasks_list includes completed task", "status=done", `status=${entry.status}`);
      } else if (!entry.task_dir_abs || !path.isAbsolute(entry.task_dir_abs)) {
        fail(14, "tasks_list includes completed task", "absolute task_dir_abs", `task_dir_abs=${entry.task_dir_abs}`);
      } else {
        pass(14, "tasks_list includes completed task with status=done and task_dir_abs");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 15: state_read on the completed task returns full v2 task
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_read", { task_dir: taskRelDir }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      fail(15, "state_read on completed task", "success", errMsg(resp));
    } else {
      const task = JSON.parse(resp.result.content[0].text);
      if (task.status !== "done") {
        fail(15, "state_read on completed task", "status=done", `status=${task.status}`);
      } else if (task.phases.length !== 5) {
        fail(15, "state_read on completed task", "5 phases", `${task.phases.length} phases`);
      } else {
        pass(15, "state_read on completed task returns full v2 task");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 16: state_init rejects duplicate creation (idempotency guard)
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_init", {
      task_dir: taskRelDir,
      slug: taskSlug,
      phases: [{ id: 1, name: "setup" }],
    }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      pass(16, "state_init rejects duplicate creation (idempotency)");
    } else {
      fail(16, "state_init rejects duplicate creation (idempotency)", "error", "success");
    }
  }

  // ---------------------------------------------------------------------------
  // Step 17: state_read rejects path traversal in task_dir
  // ---------------------------------------------------------------------------
  {
    const id = msgId;
    send(makeToolCall("state_read", { task_dir: "../../../etc" }));
    const resp = await waitFor(id);
    if (isError(resp)) {
      pass(17, "state_read rejects path traversal in task_dir");
    } else {
      fail(17, "state_read rejects path traversal in task_dir", "error", "success");
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

  const total = passed + failed;
  console.log(`\nResult: ${passed}/${total} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
