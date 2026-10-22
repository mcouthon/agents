"use strict";

/**
 * Phase 15 Step 9b: End-to-end fast-lifecycle test (D60 requirement 5).
 *
 * Drives the real CLI functions end to end: build → committed → landed → close.
 * No mocks of internal collaborators — uses real task.json, real transitions,
 * real git operations in a temp repo.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fast-life-tasks-"));
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fast-life-sess-"));
process.env.AGENTS_LOGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fast-life-logs-"));
process.env.AGENTS_TEST_SKIP_IDENTITY = "1";

const { computeNext, collectGitFacts, applyPendingTransitions } = require("./lib/next");
const { applyTransition } = require("./lib/transitions");
const taskLib = require("./lib/task");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; } else {
    failed++;
    console.error(`  FAIL - ${message}`);
  }
}

// Create a temp git repo
const gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fast-life-git-"));
execFileSync("git", ["init", "-b", "main"], { cwd: gitRepo, stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitRepo, stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["config", "user.name", "Test"], { cwd: gitRepo, stdio: ["ignore", "pipe", "pipe"] });
fs.writeFileSync(path.join(gitRepo, "README.md"), "# Test\n");
execFileSync("git", ["add", "."], { cwd: gitRepo, stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["commit", "-m", "init"], { cwd: gitRepo, stdio: ["ignore", "pipe", "pipe"] });

const gitFacts = collectGitFacts(gitRepo);
const headSha = execFileSync("git", ["-C", gitRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// Create a fast-mode task
const taskDir = path.join(process.env.AGENTS_TASKS_ROOT, "001-fast-test");
fs.mkdirSync(taskDir, { recursive: true });

const task = {
  title: "Fast Lifecycle Test",
  slug: "fast-test",
  number: 1,
  status: "in_progress",
  tier: "minor",
  mode: "fast",
  phases: [{
    id: 1,
    name: "Phase 1",
    status: "not_started",
    blocked_by: [],
    counters: { review_passes: 0, clarify_rounds: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0 },
    reports: {},
    manifest: [],
  }],
  knobs: { review_plan: false, review_code: false, approve: "auto", enforcement: "deny" },
  checkpoints: [],
};

taskLib.writeTaskJson(taskDir, task);

console.log("Fast lifecycle: build → committed → landed → close");

// Step 1: a next returns build for not_started fast-mode task
let result = computeNext(task, { projectDir: gitRepo, taskDir: taskDir, gitFacts, policy: { push: "direct", base: "main" } });
assert(result.step === "build", `not_started fast → step=build (got ${result.step})`);
assert(result.agent === "builder", `not_started fast → agent=builder (got ${result.agent})`);
assert(result.pending_transitions && result.pending_transitions.includes("not_started -> in_progress"),
  "not_started fast → has pending transition");

// Apply the pending transition (CLI path)
const ptResult = applyPendingTransitions(taskDir, result.pending_transitions, {
  projectDir: gitRepo, taskDir: taskDir, phaseId: 1, gitFacts, policy: { push: "direct", base: "main" },
});
assert(!ptResult.skipped, "pending transition applied (not skipped)");

// Re-read and verify the phase advanced
let updatedTask = taskLib.readTaskJson(taskDir);
let phase = updatedTask.phases[0];
assert(phase.status === "in_progress", `after pending transition: phase=in_progress (got ${phase.status})`);

// Step 2: record a commit and advance to committed
// Simulate the builder finishing: record a builder report, advance to implemented
phase.reports.builder = { files_touched: ["README.md"], verification: [{ cmd: "echo ok", exit: 0, summary: "ok" }], deviations: [], summary: "built" };
applyTransition(phase, "implemented", updatedTask, { taskDir: taskDir, projectDir: gitRepo, gitFacts });
assert(phase.status === "implemented", `after builder: phase=implemented (got ${phase.status})`);

// Record a commit
execFileSync("git", ["-C", gitRepo, "add", "."], { stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["-C", gitRepo, "commit", "-m", "test: fast lifecycle", "--allow-empty"], { stdio: ["ignore", "pipe", "pipe"] });
const commitSha = execFileSync("git", ["-C", gitRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

phase.commits = [commitSha];
const commitGitFacts = collectGitFacts(gitRepo);
applyTransition(phase, "committed", updatedTask, { taskDir: taskDir, projectDir: gitRepo, gitFacts: commitGitFacts });
assert(phase.status === "committed", `after commit: phase=committed (got ${phase.status})`);

taskLib.writeTaskJson(taskDir, updatedTask);

// Step 3: a next auto-advances committed → landed → done on base
result = computeNext(updatedTask, { projectDir: gitRepo, taskDir: taskDir, gitFacts: commitGitFacts, policy: { push: "direct", base: "main" } });
assert(result.step === "done", `committed on base → step=done (got ${result.step})`);
assert(result.pending_transitions && result.pending_transitions.includes("committed -> landed"),
  `committed on base → pending includes committed -> landed`);

// Apply the pending transitions
const advResult = applyPendingTransitions(taskDir, result.pending_transitions, {
  projectDir: gitRepo, taskDir: taskDir, phaseId: 1, gitFacts: commitGitFacts, policy: { push: "direct", base: "main" },
});
assert(!advResult.skipped, "auto-advance applied (not skipped)");

updatedTask = taskLib.readTaskJson(taskDir);
phase = updatedTask.phases[0];
assert(phase.status === "done", `after auto-advance: phase=done (got ${phase.status})`);

// Step 4: a next returns consolidate for a done task (D36)
result = computeNext(updatedTask, { projectDir: gitRepo, taskDir: taskDir, gitFacts: commitGitFacts });
assert(result.step === "consolidate" || result.step === "done", `done phase → step=consolidate or done (got ${result.step})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
