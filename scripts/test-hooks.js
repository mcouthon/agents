"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const hook = require("./lib/hook");
const guards = require("./lib/guards");
const { validateReport } = require("./lib/report");
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-hooks-tasks-"));
const { applyTransition, checkTransition } = require("./lib/transitions");
const stateOps = require("./lib/state-ops");
const taskLib = require("./lib/task");
const { renderStateMd } = require("./lib/render");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Temp task fixture
// ---------------------------------------------------------------------------

function makeTempTask(phases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-hook-test-"));
  const task = {
    schema: 2,
    slug: "test-task",
    number: 999,
    title: "Test Task",
    status: "in_progress",
    mode: "full",
    knobs: { ...taskLib.DEFAULT_KNOBS },
    binding: {},
    lease: {},
    last_writer: {},
    phases: phases || [
      { id: 1, name: "P0: setup", status: "done", blocked_by: [], reports: {}, counters: {} },
      { id: 2, name: "P1: build", status: "in_progress", blocked_by: [1], manifest: ["src/a.js"], reports: {}, counters: {} },
    ],
    checkpoints: [],
    flags: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2), "utf8");
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log("hook tests\n");

// ---------------------------------------------------------------------------
// Report extraction
// ---------------------------------------------------------------------------

console.log("report extraction");
test("extractJsonReport: prose around JSON block", () => {
  const msg = "Here is my report:\n\n```json\n{\"verdict\": \"pass\"}\n```\n\nDone.";
  const r = hook.extractJsonReport(msg);
  assert.ok(r.valid, "should be valid");
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: multiple blocks returns last", () => {
  const msg = "```json\n{\"verdict\": \"fail\"}\n```\n\nThen I fixed it:\n\n```json\n{\"verdict\": \"pass\"}\n```";
  const r = hook.extractJsonReport(msg);
  assert.ok(r.valid);
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: invalid JSON", () => {
  const msg = "```json\n{not valid json}\n```";
  const r = hook.extractJsonReport(msg);
  assert.ok(!r.valid);
  assert.ok(r.reason.includes("invalid JSON"), `reason: ${r.reason}`);
});

test("extractJsonReport: no block", () => {
  const r = hook.extractJsonReport("no report here");
  assert.ok(!r.valid);
  assert.ok(r.reason.includes("no JSON"));
});

test("extractJsonReport: empty message", () => {
  const r = hook.extractJsonReport("");
  assert.ok(!r.valid);
});

// ---------------------------------------------------------------------------
// Report schema: attributed_to (D31)
// ---------------------------------------------------------------------------

console.log("\nreport schema: attributed_to");
test("reviewer report with attributed_to: reviewer accepted", () => {
  const v = validateReport("reviewer", {
    verdict: "pass", issues: [], summary: "ok", attributed_to: "reviewer",
  });
  assert.ok(v.valid, v.errors.join("; "));
});

test("reviewer report with attributed_to: user accepted", () => {
  const v = validateReport("reviewer", {
    verdict: "pass", issues: [], summary: "user resolved", attributed_to: "user",
  });
  assert.ok(v.valid, v.errors.join("; "));
});

test("reviewer report with invalid attributed_to rejected", () => {
  const v = validateReport("reviewer", {
    verdict: "pass", issues: [], summary: "ok", attributed_to: "robot",
  });
  assert.ok(!v.valid);
  assert.ok(v.errors.some((e) => e.includes("attributed_to")), v.errors.join("; "));
});

test("reviewer report without attributed_to still valid", () => {
  const v = validateReport("reviewer", { verdict: "pass", issues: [], summary: "ok" });
  assert.ok(v.valid);
});

// ---------------------------------------------------------------------------
// Transitions: reviewer_verdict_pass with user-attributed pass (D31)
// ---------------------------------------------------------------------------

console.log("\ntransitions: user-attributed verdict");
test("reviewer_verdict_pass: user-attributed pass satisfies planned → reviewed", () => {
  const phase = { id: 2, status: "planned", reports: { reviewer: { verdict: "pass", attributed_to: "user", issues: [], summary: "user" } } };
  const task = { knobs: { review_plan: true, enforcement: "deny" }, phases: [phase] };
  const result = checkTransition("planned", "reviewed", phase, task, {});
  assert.ok(result.ok, result.reason);
});

test("reviewer_verdict_pass: reviewer-attributed pass also satisfies", () => {
  const phase = { id: 2, status: "planned", reports: { reviewer: { verdict: "pass", attributed_to: "reviewer", issues: [], summary: "r" } } };
  const task = { knobs: { review_plan: true, enforcement: "deny" }, phases: [phase] };
  const result = checkTransition("planned", "reviewed", phase, task, {});
  assert.ok(result.ok);
});

test("reviewer_verdict_pass: needs_work still fails", () => {
  const phase = { id: 2, status: "planned", reports: { reviewer: { verdict: "needs_work", attributed_to: "user", issues: [], summary: "u" } } };
  const task = { knobs: { review_plan: true, enforcement: "deny" }, phases: [phase] };
  const result = checkTransition("planned", "reviewed", phase, task, {});
  assert.ok(!result.ok);
});

test("applyTransition: user-attributed pass transitions under deny", () => {
  const phase = { id: 2, status: "planned", reports: { reviewer: { verdict: "pass", attributed_to: "user", issues: [], summary: "user" } } };
  const task = { knobs: { review_plan: true, enforcement: "deny" }, phases: [phase] };
  applyTransition(phase, "reviewed", task, {});
  assert.strictEqual(phase.status, "reviewed");
});

// ---------------------------------------------------------------------------
// git-guard: evalCommand for every agent type
// ---------------------------------------------------------------------------

console.log("\ngit-guard policy");
const prPolicy = { push: "pr", base: "main", remote: "github.com/o/r" };
const directPolicy = { push: "direct", base: "main", remote: "github.com/o/r" };

test("git push origin main in pr repo → deny", () => {
  const r = guards.evalCommand("git push origin main", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("git push origin feature in direct repo (external) → allow (branch push, not base)", () => {
  const r = guards.evalCommand("git push origin feature", { agentType: null, policy: directPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "allow");
});

test("gh pr create in direct repo → deny", () => {
  const r = guards.evalCommand("gh pr create --title t", { agentType: "builder", policy: directPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("gh pr create in pr repo → allow", () => {
  const r = guards.evalCommand("gh pr create --title t", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "allow");
});

test("AGENTS_LAND=1 git push origin main (env prefix in command) → still deny without process env", () => {
  const r = guards.evalCommand("AGENTS_LAND=1 git push origin main", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("git push --force → deny for all", () => {
  const r = guards.evalCommand("git push -f origin feature", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("git commit --no-verify → deny for all", () => {
  const r = guards.evalCommand("git commit --no-verify -m m", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("git -C /tmp/repo status → deny for all", () => {
  const r = guards.evalCommand("git -C /tmp/repo status", { agentType: "explorer", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("builder git commit → deny", () => {
  const r = guards.evalCommand("git commit -m wip", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("conductor git push (any write) → deny", () => {
  const r = guards.evalCommand("git push origin feature", { agentType: "conductor", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("explorer git status (read) → allow", () => {
  const r = guards.evalCommand("git status", { agentType: "explorer", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "allow");
});

test("explorer git push (write) → deny", () => {
  const r = guards.evalCommand("git push origin feature", { agentType: "explorer", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("git push origin main with AGENTS_LAND process env + land lock → allow", () => {
  const r = guards.evalCommand("git push origin main", { agentType: "builder", policy: prPolicy, agentsLand: true, landLockHeld: true });
  assert.strictEqual(r.decision, "allow");
});

test("git push origin main with AGENTS_LAND but no land lock → deny", () => {
  const r = guards.evalCommand("git push origin main", { agentType: "builder", policy: prPolicy, agentsLand: true, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("gh pr create with mission initiator → rewrite to add --draft", () => {
  const r = guards.evalCommand("gh pr create --title t", { agentType: "courier", policy: prPolicy, initiator: "mission", agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "rewrite");
});

test("gh pr merge with mission initiator → deny", () => {
  const r = guards.evalCommand("gh pr merge 1", { agentType: "courier", policy: prPolicy, initiator: "mission", agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

test("non-git command → allow", () => {
  const r = guards.evalCommand("npm test", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "allow");
});

test("git add -A → deny for all", () => {
  const r = guards.evalCommand("git add -A", { agentType: "builder", policy: prPolicy, agentsLand: false, landLockHeld: false });
  assert.strictEqual(r.decision, "deny");
});

// ---------------------------------------------------------------------------
// git-guard handler (via handleGitGuard)
// ---------------------------------------------------------------------------

console.log("\ngit-guard handler");
test("handleGitGuard: push to base in pr repo → deny output", () => {
  const r = hook.handleGitGuard(
    { tool_input: { command: "git push origin main" } },
    { agentType: "builder", taskDir: "/tmp/x", policy: prPolicy, agentsLand: false, landLockHeld: false }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleGitGuard: unbound session git status → allow (policy applies but reads allowed)", () => {
  const r = hook.handleGitGuard(
    { tool_input: { command: "git status" } },
    { agentType: null, taskDir: null, policy: prPolicy, agentsLand: false, landLockHeld: false }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision === "allow");
});

test("handleGitGuard: git status (read) → allow (no deny output)", () => {
  const r = hook.handleGitGuard(
    { tool_input: { command: "git status" } },
    { agentType: "builder", taskDir: "/tmp/x", policy: prPolicy, agentsLand: false, landLockHeld: false }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision === "allow");
});

// ---------------------------------------------------------------------------
// spawn-guard handler
// ---------------------------------------------------------------------------

console.log("\nspawn-guard handler");

function makeSpawnPayload(subagentType, prompt) {
  return { tool_input: { subagent_type: subagentType, prompt: prompt || "do the work" } };
}

test("handleSpawnGuard: explorer spawning researcher → allow + rewrite", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleSpawnGuard(makeSpawnPayload("researcher"), {
      agentType: "explorer", taskDir: dir, projectDir: dir,
    });
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.output.hookSpecificOutput.updatedInput, "should rewrite the prompt");
    assert.ok(r.output.hookSpecificOutput.updatedInput.prompt.includes("Task dir:"));
  } finally { cleanup(dir); }
});

test("handleSpawnGuard: explorer spawning builder → deny (not in allowed list)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleSpawnGuard(makeSpawnPayload("builder"), {
      agentType: "explorer", taskDir: dir, projectDir: dir,
    });
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleSpawnGuard: reviewer spawning anything → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleSpawnGuard(makeSpawnPayload("builder"), {
      agentType: "reviewer", taskDir: dir, projectDir: dir,
    });
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleSpawnGuard: unbound session → allow (no-op)", () => {
  const r = hook.handleSpawnGuard(makeSpawnPayload("builder"), {
    agentType: null, taskDir: null,
  });
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || !r.output.hookSpecificOutput.permissionDecision || r.output.hookSpecificOutput.permissionDecision === "allow");
});

// ---------------------------------------------------------------------------
// manifest-guard handler
// ---------------------------------------------------------------------------

console.log("\nmanifest-guard handler");

test("handleManifestGuard: builder writing inside manifest → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: path.join(path.dirname(path.dirname(dir)), "src", "a.js") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

test("handleManifestGuard: builder writing outside manifest → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: path.join(path.dirname(path.dirname(dir)), "src", "other.js") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleManifestGuard: reviewer writing anything outside task dir → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: "/tmp/some/random/file.js" } },
      { agentType: "reviewer", taskDir: dir, projectDir: "/tmp" }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleManifestGuard: editing task.json by hand → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: path.join(dir, "task.json") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleManifestGuard: write to sibling task dir in central root → deny (D25)", () => {
  const dir = makeTempTask();
  const siblingDir = path.join(path.dirname(dir), "002-other-task");
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: path.join(siblingDir, "task.json") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleManifestGuard: write to central root index.json → deny (D25)", () => {
  const dir = makeTempTask();
  const rootIndex = path.join(path.dirname(path.dirname(dir)), "index.json");
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: rootIndex } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleManifestGuard: write to central root INDEX.md → deny (D25)", () => {
  const dir = makeTempTask();
  const indexMd = path.join(path.dirname(path.dirname(dir)), "INDEX.md");
  try {
    const r = hook.handleManifestGuard(
      { tool_input: { file_path: indexMd } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// machine-owned-guard handler (D37)
// ---------------------------------------------------------------------------

console.log("\nmachine-owned-guard handler");

test("handleMachineOwnedGuard: conductor editing task.json → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(dir, "task.json") } },
      { agentType: "conductor", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("machine-owned"));
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: builder editing task.json → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(dir, "task.json") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: courier editing state.md → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(dir, "state.md") } },
      { agentType: "courier", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: unbound session editing task.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { file_path: "/some/dir/task.json" } },
    { agentType: null, taskDir: null, projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: editing tasks.json → deny", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(path.dirname(dir), "tasks.json") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: editing index.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { file_path: "/some/dir/index.json" } },
    { agentType: null, taskDir: null, projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: editing state.json.v1 → deny (glob match)", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { file_path: "/some/dir/state.json.v1" } },
    { agentType: null, taskDir: null, projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: editing plan file → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(dir, "plan", "phase-1.md") } },
      { agentType: "builder", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.output, "plan file should not be denied");
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: editing task.md → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleMachineOwnedGuard(
      { tool_input: { file_path: path.join(dir, "task.md") } },
      { agentType: "conductor", taskDir: dir, projectDir: path.dirname(path.dirname(dir)) }
    );
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.output, "task.md should not be denied");
  } finally { cleanup(dir); }
});

test("handleMachineOwnedGuard: Bash echo > task.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "echo x > /some/dir/task.json" } },
    { agentType: "builder", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("task.json"));
});

test("handleMachineOwnedGuard: Bash sed -i state.md → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "sed -i 's/x/y/' /some/dir/state.md" } },
    { agentType: "reviewer", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("state.md"));
});

test("handleMachineOwnedGuard: Bash tee tasks.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "echo x | tee /some/dir/tasks.json" } },
    { agentType: "conductor", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: Bash python -c naming task.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "python3 -c \"open('task.json','w')\"" } },
    { agentType: "builder", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: Bash node -e naming state.json → deny", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "node -e \"require('fs').writeFileSync('state.json','x')\"" } },
    { agentType: "builder", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleMachineOwnedGuard: Bash git status (read) → allow", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "git status" } },
    { agentType: "conductor", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output, "git status should not be denied");
});

test("handleMachineOwnedGuard: Bash cat task.json (read) → allow", () => {
  const r = hook.handleMachineOwnedGuard(
    { tool_input: { command: "cat task.json" } },
    { agentType: "conductor", taskDir: "/some/dir", projectDir: "/some/dir" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output, "cat task.json (read) should not be denied");
});

// ---------------------------------------------------------------------------
// report-parser handler
// ---------------------------------------------------------------------------

console.log("\nreport-parser handler");

test("handleReportParser: valid builder report → persisted", () => {
  const dir = makeTempTask();
  try {
    const msg = "Done.\n\n```json\n{\"files_touched\":[\"a.js\"],\"verification\":[{\"cmd\":\"npm test\",\"exit\":0,\"summary\":\"pass\"}],\"deviations\":[],\"summary\":\"done\"}\n```";
    const r = hook.handleReportParser(
      { last_assistant_message: msg, agent_type: "builder" },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
    const task = taskLib.readTaskJson(dir);
    assert.ok(task.phases[1].reports.builder, "builder report should be stored");
  } finally { cleanup(dir); }
});

test("handleReportParser: invalid JSON → block (exit 2)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleReportParser(
      { last_assistant_message: "```json\n{broken}\n```", agent_type: "builder" },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 2);
  } finally { cleanup(dir); }
});

test("handleReportParser: no JSON block → block (exit 2)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleReportParser(
      { last_assistant_message: "I am done, no report.", agent_type: "builder" },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 2);
  } finally { cleanup(dir); }
});

test("handleReportParser: user-attributed reviewer report → stored with attributed_to", () => {
  const dir = makeTempTask([
    { id: 1, name: "P0: plan", status: "planned", blocked_by: [], manifest: [], reports: {}, counters: {} },
  ]);
  try {
    const msg = "```json\n{\"verdict\":\"pass\",\"attributed_to\":\"user\",\"issues\":[],\"summary\":\"user resolved\"}\n```";
    const r = hook.handleReportParser(
      { last_assistant_message: msg, agent_type: "reviewer" },
      { agentType: "reviewer", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
    const task = taskLib.readTaskJson(dir);
    assert.strictEqual(task.phases[0].reports.reviewer.attributed_to, "user");
    assert.strictEqual(task.phases[0].status, "reviewed");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// courier-stop handler
// ---------------------------------------------------------------------------

console.log("\ncourier-stop handler");

test("handleCourierStop: courier session with valid report → persisted", () => {
  const dir = makeTempTask();
  try {
    const msg = "```json\n{\"files_touched\":[\"a.js\"],\"verification\":[{\"cmd\":\"npm test\",\"exit\":0,\"summary\":\"pass\"}],\"deviations\":[],\"summary\":\"done\"}\n```";
    const r = hook.handleCourierStop(
      { last_assistant_message: msg, agent_type: "builder" },
      { agentType: "courier", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

test("handleCourierStop: non-courier session → allow (no-op)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleCourierStop(
      { last_assistant_message: "no report" },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// conductor-stop handler
// ---------------------------------------------------------------------------

console.log("\nconductor-stop handler");

test("handleConductorStop: in_progress task → block (step != done)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleConductorStop({}, { agentType: "conductor", taskDir: dir, projectDir: dir });
    assert.strictEqual(r.exitCode, 2);
  } finally { cleanup(dir); }
});

test("handleConductorStop: all-done task → allow", () => {
  const dir = makeTempTask([
    { id: 1, name: "P0: done", status: "done", blocked_by: [], reports: {}, counters: {} },
  ]);
  try {
    const task = taskLib.readTaskJson(dir);
    task.status = "done";
    taskLib.writeTaskJson(dir, task);
    const r = hook.handleConductorStop({}, { agentType: "conductor", taskDir: dir, projectDir: dir });
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Flags: addFlag/clearFlag on task.json
// ---------------------------------------------------------------------------

console.log("\nflags: unified task.flags store");

test("addFlag writes task.flags in task.json", () => {
  const dir = makeTempTask();
  try {
    const result = stateOps.addFlag(dir, dir, 2, "needs_human", "test flag");
    const task = taskLib.readTaskJson(dir);
    assert.ok(task.flags.some((f) => f.type === "needs_human"), "flag should be in task.flags");
    assert.strictEqual(result.flagCount, 1);
  } finally { cleanup(dir); }
});

test("clearFlag removes from task.flags in task.json", () => {
  const dir = makeTempTask();
  try {
    stateOps.addFlag(dir, dir, 2, "needs_human", "test flag");
    const task1 = taskLib.readTaskJson(dir);
    const flagId = task1.flags[0].id;
    stateOps.clearFlag(dir, dir, flagId);
    const task2 = taskLib.readTaskJson(dir);
    assert.strictEqual(task2.flags.length, 0, "flag should be removed");
  } finally { cleanup(dir); }
});

test("addFlag renders state.md with the flag", () => {
  const dir = makeTempTask();
  try {
    stateOps.addFlag(dir, dir, 2, "needs_human", "visible flag");
    const stateMd = fs.readFileSync(path.join(dir, "state.md"), "utf8");
    assert.ok(stateMd.includes("needs_human"), "flag should appear in state.md");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Migrate: renders state.md with Status column
// ---------------------------------------------------------------------------

console.log("\nmigrate: renders state.md");

test("migrate --apply renders state.md with dedicated Status column", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-"));
  try {
    // Create a v1 state.json
    const state = {
      schema_version: 1, task: "migrate-test", status: "in_progress", updated: "2026-01-01",
      phases: [{ id: 1, name: "P0: test", status: "done", owner: null, started: null, completed: null, blocked_by: [], parallel_group: null, execution: {} }],
      flags: [],
    };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "task.md"), "---\ntask: migrate-test\nslug: migrate-test\ncreated: 2026-01-01\nstatus: in_progress\n---\n\n# migrate-test\n\n## Phases\n\n| # | Phase | Status | Notes |\n|---|---|---|---|\n| 1 | P0: test | ✅ Done |  |\n", "utf8");

    const result = taskLib.migrateTask(dir, { dryRun: false });
    assert.ok(result.migrated);
    const stateMd = fs.readFileSync(path.join(dir, "state.md"), "utf8");
    assert.ok(stateMd.includes("| # | Phase | Status | Notes |"), "should have a dedicated Status column");
    assert.ok(stateMd.includes("done"), "should show the status value");
  } finally { cleanup(dir); }
});

test("migrate dry-run writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-migrate-"));
  try {
    const state = {
      schema_version: 1, task: "dry-test", status: "planning", updated: "2026-01-01",
      phases: [{ id: 1, name: "P0: test", status: "not_started", owner: null, started: null, completed: null, blocked_by: [], parallel_group: null, execution: {} }],
      flags: [],
    };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "task.md"), "---\ntask: dry-test\n---\n\n# dry-test\n", "utf8");

    const result = taskLib.migrateTask(dir, { dryRun: true });
    assert.ok(result.dryRun);
    assert.ok(!fs.existsSync(path.join(dir, "task.json")), "dry-run should not write task.json");
    assert.ok(!fs.existsSync(path.join(dir, "state.md")), "dry-run should not write state.md");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Knobs: land + history
// ---------------------------------------------------------------------------

console.log("\nknobs: land + history");

test("setKnob accepts land=per_phase", () => {
  const dir = makeTempTask();
  try {
    const result = stateOps.setKnob(dir, dir, "land", "per_phase");
    assert.strictEqual(result.knob, "land");
    const task = taskLib.readTaskJson(dir);
    assert.strictEqual(task.knobs.land, "per_phase");
  } finally { cleanup(dir); }
});

test("setKnob accepts land=at_end", () => {
  const dir = makeTempTask();
  try {
    stateOps.setKnob(dir, dir, "land", "at_end");
    const task = taskLib.readTaskJson(dir);
    assert.strictEqual(task.knobs.land, "at_end");
  } finally { cleanup(dir); }
});

test("setKnob rejects invalid land value", () => {
  const dir = makeTempTask();
  try {
    assert.throws(() => stateOps.setKnob(dir, dir, "land", "never"), /Invalid value/);
  } finally { cleanup(dir); }
});

test("setKnob records history with by and at", () => {
  const dir = makeTempTask();
  try {
    stateOps.setKnob(dir, dir, "enforcement", "warn");
    const task = taskLib.readTaskJson(dir);
    assert.ok(task.knob_history && task.knob_history.length > 0, "history should be recorded");
    const entry = task.knob_history[task.knob_history.length - 1];
    assert.strictEqual(entry.knob, "enforcement");
    assert.strictEqual(entry.value, "warn");
    assert.ok(entry.by, "history entry should have 'by'");
    assert.ok(entry.at, "history entry should have 'at'");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// render: dedicated Status column
// ---------------------------------------------------------------------------

console.log("\nrender: Status column");

test("renderStateMd has a dedicated Status column", () => {
  const dir = makeTempTask();
  try {
    const task = taskLib.readTaskJson(dir);
    renderStateMd(dir, task, dir);
    const stateMd = fs.readFileSync(path.join(dir, "state.md"), "utf8");
    assert.ok(stateMd.includes("| # | Phase | Status | Notes |"), "should have Status column header");
    assert.ok(!/\(done\)/.test(stateMd), "status should not be folded into the Phase cell");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// write-guard: shell write-primitive detection (ADR-015, D13 guard table)
// ---------------------------------------------------------------------------

console.log("\nwrite-guard handler");

test("handleWriteGuard: explorer echo > file → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "foo" > file.js' } },
    { agentType: "explorer", taskDir: "/tmp/x", sessionId: "s1" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("read-only"));
});

test("handleWriteGuard: explorer echo >> file → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "foo" >> file.js' } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer tee file → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo foo | tee file.js' } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer sed -i → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "sed -i s/a/b/ file.js" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer touch → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "touch newfile.js" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer python -c open w → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "python3 -c \"open('f','w')\"" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer node -e writeFileSync → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'node -e "require(\'fs\').writeFileSync(\'f\',\'x\')"' } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer curl -o → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "curl -o file.txt http://example.com" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

test("handleWriteGuard: explorer git log (read) → allow", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "git log --oneline -5" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: explorer grep (read, quoted >) → allow", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: "grep 'a > b' file.js" } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: reviewer echo > file → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > f.js' } },
    { agentType: "reviewer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("verification"));
});

test("handleWriteGuard: committer echo > file → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > f.js' } },
    { agentType: "committer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("Edit tool"));
});

test("handleWriteGuard: builder echo > file → allow (not protected)", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > f.js' } },
    { agentType: "builder", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: conductor echo > file → allow (not protected)", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > f.js' } },
    { agentType: "conductor", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: unbound session → allow (no-op)", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > f.js' } },
    { agentType: null, taskDir: null }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: explorer echo > /dev/null → allow", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'echo "x" > /dev/null' } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleWriteGuard: explorer bash -c echo > file (wrapped) → deny", () => {
  const r = hook.handleWriteGuard(
    { tool_input: { command: 'bash -c "echo x > file.js"' } },
    { agentType: "explorer", taskDir: "/tmp/x" }
  );
  assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
});

// ---------------------------------------------------------------------------
// Guard exception: enforcement:warn knob (D32, Issue 3)
// ---------------------------------------------------------------------------

console.log("\nguard exception: enforcement knob");

test("handleGuardException: bound session, enforcement=deny → deny", () => {
  const dir = makeTempTask();
  try {
    taskLib.writeTaskJson(dir, (() => {
      const t = taskLib.readTaskJson(dir);
      t.knobs.enforcement = "deny";
      return t;
    })());
    const r = hook.handleGuardException(
      new Error("policy lookup failed"),
      { taskDir: dir, agentType: "builder", sessionId: "s1" },
      "git-guard"
    );
    assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(r.output.hookSpecificOutput.permissionDecisionReason.includes("enforcement unavailable"));
  } finally { cleanup(dir); }
});

test("handleGuardException: bound session, enforcement=warn → allow + warning", () => {
  const dir = makeTempTask();
  try {
    taskLib.writeTaskJson(dir, (() => {
      const t = taskLib.readTaskJson(dir);
      t.knobs.enforcement = "warn";
      return t;
    })());
    const r = hook.handleGuardException(
      new Error("policy lookup failed"),
      { taskDir: dir, agentType: "builder", sessionId: "s1" },
      "git-guard"
    );
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny",
      "warn should allow the tool call");
    const task = taskLib.readTaskJson(dir);
    const phase = task.phases.find((p) => p.status !== "done");
    assert.ok(phase.warnings && phase.warnings.length > 0, "warning should be appended to phase.warnings");
    assert.strictEqual(phase.warnings[0].guard, "git-guard");
    assert.ok(phase.warnings[0].reason.includes("policy lookup failed"));
    assert.ok(phase.warnings[0].session_id);
  } finally { cleanup(dir); }
});

test("handleGuardException: unbound session → allow (no-op)", () => {
  const r = hook.handleGuardException(
    new Error("boom"),
    { taskDir: null, agentType: null },
    "git-guard"
  );
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
});

test("handleGitGuard: exception under enforcement=warn → allow + warning", () => {
  const dir = makeTempTask();
  try {
    taskLib.writeTaskJson(dir, (() => {
      const t = taskLib.readTaskJson(dir);
      t.knobs.enforcement = "warn";
      return t;
    })());
    // Force an exception in the guard via a throwing policy getter.
    // The handler catches it and delegates to handleGuardException.
    const ctx = { agentType: "builder", taskDir: dir, sessionId: "s1", projectDir: dir };
    Object.defineProperty(ctx, "policy", {
      get() { throw new Error("policy resolution failed"); },
    });
    const r = hook.handleGitGuard(
      { tool_input: { command: "git push origin main" } },
      ctx
    );
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny",
      "warn should allow the tool call");
    const task = taskLib.readTaskJson(dir);
    const phase = task.phases.find((p) => p.status !== "done");
    assert.ok(phase.warnings && phase.warnings.length > 0, "git-guard warning should be appended");
    assert.strictEqual(phase.warnings[0].guard, "git-guard");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// checkpoint-capture: headless fallback (D18, Issue 2)
// ---------------------------------------------------------------------------

console.log("\ncheckpoint-capture: headless fallback");

test("handleCheckpointCapture: headless PreToolUse → deny with question as reason", () => {
  const dir = makeTempTask([
    { id: 1, name: "P0: plan", status: "planned", blocked_by: [], manifest: [], reports: {}, counters: {} },
  ]);
  try {
    taskLib.writeTaskJson(dir, (() => {
      const t = taskLib.readTaskJson(dir);
      t.knobs.approve = "ask";
      return t;
    })());
    const origEnv = process.env.CLAUDE_CODE_NON_INTERACTIVE;
    process.env.CLAUDE_CODE_NON_INTERACTIVE = "1";
    try {
      const r = hook.handleCheckpointCapture(
        {
          hook_event_name: "PreToolUse",
          tool_input: { question: "Approve the plan?", options: ["yes", "no"] },
        },
        { agentType: "conductor", taskDir: dir, sessionId: "s1", projectDir: dir }
      );
      assert.strictEqual(r.output.hookSpecificOutput.permissionDecision, "deny");
      assert.strictEqual(r.output.hookSpecificOutput.permissionDecisionReason, "Approve the plan?");
    } finally {
      if (origEnv === undefined) delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
      else process.env.CLAUDE_CODE_NON_INTERACTIVE = origEnv;
    }
    // Checkpoint should have been opened despite the deny.
    const task = taskLib.readTaskJson(dir);
    assert.ok(task.checkpoints && task.checkpoints.length > 0, "checkpoint should be opened");
    assert.strictEqual(task.checkpoints[0].question, "Approve the plan?");
    assert.strictEqual(task.checkpoints[0].chosen, null, "checkpoint should be unresolved");
  } finally { cleanup(dir); }
});

test("handleCheckpointCapture: interactive PreToolUse → allow (no deny)", () => {
  const dir = makeTempTask([
    { id: 1, name: "P0: plan", status: "planned", blocked_by: [], manifest: [], reports: {}, counters: {} },
  ]);
  try {
    taskLib.writeTaskJson(dir, (() => {
      const t = taskLib.readTaskJson(dir);
      t.knobs.approve = "ask";
      return t;
    })());
    const origEnv = process.env.CLAUDE_CODE_NON_INTERACTIVE;
    delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
    try {
      const r = hook.handleCheckpointCapture(
        {
          hook_event_name: "PreToolUse",
          tool_input: { question: "Approve the plan?", options: ["yes", "no"] },
        },
        { agentType: "conductor", taskDir: dir, sessionId: "s1", projectDir: dir }
      );
      assert.strictEqual(r.exitCode, 0);
      assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny",
        "interactive should not deny");
    } finally {
      if (origEnv !== undefined) process.env.CLAUDE_CODE_NON_INTERACTIVE = origEnv;
    }
  } finally { cleanup(dir); }
});

test("handleCheckpointCapture: headless but no task → allow (no-op)", () => {
  const origEnv = process.env.CLAUDE_CODE_NON_INTERACTIVE;
  process.env.CLAUDE_CODE_NON_INTERACTIVE = "1";
  try {
    const r = hook.handleCheckpointCapture(
      {
        hook_event_name: "PreToolUse",
        tool_input: { question: "Approve?", options: ["yes"] },
      },
      { agentType: "conductor", taskDir: null }
    );
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.output || !r.output.hookSpecificOutput || r.output.hookSpecificOutput.permissionDecision !== "deny");
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
    else process.env.CLAUDE_CODE_NON_INTERACTIVE = origEnv;
  }
});

// ---------------------------------------------------------------------------
// stop_hook_active: every Stop/SubagentStop handler passes immediately (D43)
// ---------------------------------------------------------------------------

console.log("\nstop_hook_active");
test("handleConductorStop: stop_hook_active=true → allow (not block)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleConductorStop(
      { stop_hook_active: true },
      { agentType: "conductor", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

test("handleConductorStop: stop_hook_active=true → additionalContext warning", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleConductorStop(
      { stop_hook_active: true },
      { agentType: "conductor", taskDir: dir, projectDir: dir }
    );
    assert.ok(r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.additionalContext,
      "should have additionalContext with the warning reason");
    assert.ok(r.output.hookSpecificOutput.additionalContext.includes("conductor-stop"),
      "warning should mention conductor-stop");
  } finally { cleanup(dir); }
});

test("handleCourierStop: stop_hook_active=true → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleCourierStop(
      { stop_hook_active: true, last_assistant_message: "no report" },
      { agentType: "courier", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

test("handleQualityGate: stop_hook_active=true → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleQualityGate(
      { hook_event_name: "Stop", stop_hook_active: true },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

test("handleReportParser: stop_hook_active=true → allow", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleReportParser(
      { stop_hook_active: true, last_assistant_message: "```json\n{}```" },
      { agentType: "builder", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// conductor-stop: unresolvable agent type → fail open (D13)
// ---------------------------------------------------------------------------

console.log("\nconductor-stop: fail open");
test("handleConductorStop: null agentType → allow (fail open)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleConductorStop(
      {},
      { agentType: null, taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0, "null agent type should fail open");
  } finally { cleanup(dir); }
});

test("handleConductorStop: unknown agent type → allow (fail open)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleConductorStop(
      {},
      { agentType: "unknown_agent", taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0, "unknown agent type should fail open");
  } finally { cleanup(dir); }
});

test("handleCourierStop: null agentType → allow (fail open)", () => {
  const dir = makeTempTask();
  try {
    const r = hook.handleCourierStop(
      { last_assistant_message: "no report" },
      { agentType: null, taskDir: dir, projectDir: dir }
    );
    assert.strictEqual(r.exitCode, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// blockStop writes reason to stderr (D43)
// ---------------------------------------------------------------------------

console.log("\nblockStop: stderr");
test("handleConductorStop: block writes reason to stderr", () => {
  const dir = makeTempTask();
  try {
    // Capture stderr
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    try {
      hook.handleConductorStop(
        {},
        { agentType: "conductor", taskDir: dir, projectDir: dir }
      );
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(stderrOutput.length > 0, "stderr should have output (reason visible)");
    assert.ok(stderrOutput.includes("No state advance"), `stderr should contain reason, got: ${stderrOutput}`);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// resolveSession: agent_type normalised to lowercase (D13)
// runHook from a real registration file with capitalised agent name
// ---------------------------------------------------------------------------

console.log("\nresolveSession: case normalisation");
test("runHook: capitalised 'Courier' in registration → courier guards apply", () => {
  const dir = makeTempTask();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-reg-test-"));
  try {
    // Write a registration with capitalised agent name
    fs.writeFileSync(path.join(sessionDir, "registration.json"), JSON.stringify({
      agent: "Courier",
      session_id: "test-sid",
      task_dir: dir,
      cwd: dir,
    }));
    const origSessionDir = process.env.AGENTS_SESSION_DIR;
    process.env.AGENTS_SESSION_DIR = sessionDir;
    try {
      const session = hook.resolveSession();
      assert.strictEqual(session.agent_type, "courier",
        "resolveSession should lowercase 'Courier' → 'courier'");
      assert.strictEqual(session.task_dir, dir);
    } finally {
      if (origSessionDir) process.env.AGENTS_SESSION_DIR = origSessionDir;
      else delete process.env.AGENTS_SESSION_DIR;
    }

    // Courier gets quality-gate + courier-stop (not conductor-stop)
    const guards = require("./lib/guards").guardsFor("courier");
    assert.ok(guards.stop.includes("courier-stop"), "courier stop includes courier-stop");
    assert.ok(guards.stop.includes("quality-gate"), "courier stop includes quality-gate");
    assert.ok(!guards.stop.includes("conductor-stop"), "courier stop does NOT include conductor-stop");
  } finally {
    cleanup(dir);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  }
});

test("runHook: capitalised 'Conductor' in registration → conductor guards apply", () => {
  const dir = makeTempTask();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-reg-test-"));
  try {
    fs.writeFileSync(path.join(sessionDir, "registration.json"), JSON.stringify({
      agent: "Conductor",
      session_id: "test-sid",
      task_dir: dir,
      cwd: dir,
    }));
    const origSessionDir = process.env.AGENTS_SESSION_DIR;
    process.env.AGENTS_SESSION_DIR = sessionDir;
    try {
      const session = hook.resolveSession();
      assert.strictEqual(session.agent_type, "conductor",
        "resolveSession should lowercase 'Conductor' → 'conductor'");

      // Conductor gets conductor-stop (not courier-stop)
      const guards = require("./lib/guards").guardsFor("conductor");
      assert.ok(guards.stop.includes("conductor-stop"), "conductor stop includes conductor-stop");
      assert.ok(!guards.stop.includes("courier-stop"), "conductor stop does NOT include courier-stop");
    } finally {
      if (origSessionDir) process.env.AGENTS_SESSION_DIR = origSessionDir;
      else delete process.env.AGENTS_SESSION_DIR;
    }
  } finally {
    cleanup(dir);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  }
});

test("runHook: no registration, no agent_type in payload → fail open (null)", () => {
  // No AGENTS_SESSION_DIR, no agent_type in payload → agentType is null
  const origSessionDir = process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_DIR;
  try {
    const session = hook.resolveSession();
    assert.strictEqual(session.agent_type, null);
    const guards = require("./lib/guards").guardsFor(null);
    assert.deepStrictEqual(guards.stop, [], "null agent → EXTERNAL_GUARDS, no stop hooks");
  } finally {
    if (origSessionDir) process.env.AGENTS_SESSION_DIR = origSessionDir;
  }
});

test("runHook: payload agent_type fallback when registration has no agent", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-reg-test-"));
  try {
    fs.writeFileSync(path.join(sessionDir, "registration.json"), JSON.stringify({
      session_id: "test-sid",
      task_dir: null,
    }));
    const origSessionDir = process.env.AGENTS_SESSION_DIR;
    process.env.AGENTS_SESSION_DIR = sessionDir;
    try {
      const session = hook.resolveSession();
      assert.strictEqual(session.agent_type, null,
        "no agent in registration → null");
      // runHook should use payload.agent_type as fallback
      const r = hook.runHook("conductor-stop", { agent_type: "Conductor" });
      // agent_type in payload is lowercased and used; but task_dir is null → allow
      assert.strictEqual(r.exitCode, 0);
    } finally {
      if (origSessionDir) process.env.AGENTS_SESSION_DIR = origSessionDir;
      else delete process.env.AGENTS_SESSION_DIR;
    }
  } finally {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// courier-stop: walks a fixture task to done and closes it (D15/D34)
// ---------------------------------------------------------------------------

console.log("\ncourier-stop: base-branch advancement");
test("courierStopAdvance: implemented phase on base branch → done + closed", () => {
  const { execFileSync } = require("child_process");
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-courier-advance-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

    const { repoKey } = require("./lib/repo");
    const key = repoKey(repoDir);
    const { createTask } = require("./lib/task");
    const r = createTask({
      repo: key, title: "Courier Test", slug: "courier-test",
      mode: "fast", session_id: "test-courier",
    });

    // Simulate the Courier's work: advance to implemented and make a commit
    const task = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
    task.phases[0].status = "implemented";
    task.phases[0].reports = { explorer: null, builder: { files_touched: ["README.md"], verification: [], deviations: [], summary: "done" }, reviewer: null, committer: null };
    task.status = "in_progress";
    fs.writeFileSync(path.join(r.task_dir, "task.json"), JSON.stringify(task, null, 2), "utf8");

    // Make a commit on the base branch
    fs.writeFileSync(path.join(repoDir, "CHANGE.txt"), "change\n");
    execFileSync("git", ["add", "CHANGE.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "courier change"], { cwd: repoDir });

    // Run courierStopAdvance
    hook.courierStopAdvance({ taskDir: r.task_dir, projectDir: repoDir, sessionId: "test-courier" });

    // For minor tier, the task should be closed (moved to trash) — dir gone.
    if (!fs.existsSync(r.task_dir)) {
      // Task was closed and moved to trash — that's the expected outcome.
      console.log("  ok - courierStopAdvance: phase advanced to done, minor task closed (moved to trash)");
    } else {
      // Task dir still exists — check the phase status
      const updated = JSON.parse(fs.readFileSync(path.join(r.task_dir, "task.json"), "utf8"));
      if (updated.phases[0].status === "done") {
        console.log("  ok - courierStopAdvance: phase done (close not triggered, acceptable)");
      } else {
        assert.fail(`expected done or closed, got phase status ${updated.phases[0].status}`);
      }
    }
  } finally {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
});

console.log(`\n${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
