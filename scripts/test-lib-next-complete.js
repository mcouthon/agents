"use strict";

/**
 * Phase 15 Step 9: Generated table test for `a next` completeness.
 *
 * For every reachable cell of (phase status × knobs × artifacts present ×
 * git facts), asserts the result is one of three shapes:
 * 1. An agent step (step names an agent)
 * 2. A checkpoint whose every option has a resolver case in checkpoint.js
 * 3. A how command — step is done/blocked/consolidate with how.tool not null,
 *    or a terminal state, or blocked with a how.command naming the fix
 *
 * Also includes a static assertion that every option string offered by
 * next.js checkpoints has a case in checkpoint.js's resolveCheckpoint switch.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-next-complete-"));
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-next-complete-sess-"));
process.env.AGENTS_LOGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-next-complete-logs-"));

const { computeNext, stepForPhase, findEligiblePhases } = require("./lib/next");
const { CAPS, TRANSITIONS } = require("./lib/transitions");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL - ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Static assertion: every checkpoint option in next.js has a resolver case
// ---------------------------------------------------------------------------

console.log("Static: checkpoint options have resolver cases");

const nextSrc = fs.readFileSync(path.join(__dirname, "lib", "next.js"), "utf8");
const cpSrc = fs.readFileSync(path.join(__dirname, "lib", "checkpoint.js"), "utf8");

// Extract option arrays from next.js: options: ["a", "b", "c"]
const optionRegex = /options:\s*\[([^\]]+)\]/g;
let match;
const allOptions = new Set();
while ((match = optionRegex.exec(nextSrc)) !== null) {
  const items = match[1].split(",").map((s) => s.trim().replace(/["'`]/g, "")).filter(Boolean);
  for (const item of items) allOptions.add(item);
}

// Check each option has a resolver case in checkpoint.js
for (const opt of allOptions) {
  const hasCase = cpSrc.includes(`chosen === "${opt}"`) || cpSrc.includes(`chosen === '${opt}'`);
  assert(hasCase, `checkpoint option "${opt}" has a resolver case in checkpoint.js`);
}

// ---------------------------------------------------------------------------
// Helper: create a temp git repo and task fixture
// ---------------------------------------------------------------------------

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-next-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

function makeTaskDir() {
  const root = process.env.AGENTS_TASKS_ROOT;
  const name = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTask(dir, task) {
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
}

function makeTask(phases, opts = {}) {
  return {
    title: opts.title || "Test Task",
    slug: opts.slug || "test-task",
    number: opts.number || 1,
    status: opts.status || "planning",
    phases: phases,
    knobs: opts.knobs || {},
    mode: opts.mode,
    checkpoints: opts.checkpoints || [],
    reports: opts.reports || {},
    ...opts,
  };
}

function makePhase(id, status, opts = {}) {
  return {
    id,
    name: opts.name || `Phase ${id}`,
    status,
    blocked_by: opts.blocked_by || [],
    counters: opts.counters || { review_passes: 0, clarify_rounds: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0 },
    reports: opts.reports || {},
    plan_path: opts.plan_path,
    manifest: opts.manifest || [],
    commits: opts.commits,
    landed_sha: opts.landed_sha,
    branch: opts.branch,
    ...opts,
  };
}

const REPORTING_STEPS = new Set(["plan", "review_plan", "build", "review_code", "fix", "commit", "land", "resolve_conflicts"]);

function assertShape(result, label) {
  // Shape 1: agent step
  if (result.agent && REPORTING_STEPS.has(result.step)) {
    assert(true, `${label}: agent step (${result.step}/${result.agent})`);
    return;
  }
  // Shape 2: checkpoint with resolvable options
  if (result.checkpoint && result.checkpoint.options) {
    for (const opt of result.checkpoint.options) {
      assert(allOptions.has(opt), `${label}: checkpoint option "${opt}" is in the known options set`);
    }
    assert(true, `${label}: checkpoint (${result.checkpoint.options.join(",")})`);
    return;
  }
  // Shape 3: how command — any step with how.tool not null is actionable
  if (result.how && result.how.tool !== null) {
    assert(true, `${label}: how command (${result.how.tool})`);
    return;
  }
  // Terminal states
  if (result.step === "done" || result.step === "consolidate") {
    assert(true, `${label}: terminal/consolidate step`);
    return;
  }
  if (result.step === "blocked") {
    assert(result.how && (result.how.tool !== null || result.how.command !== null),
      `${label}: blocked has a how (tool=${result.how && result.how.tool}, cmd=${result.how && result.how.command})`);
    return;
  }
  assert(false, `${label}: result is none of the three shapes (step=${result.step}, agent=${result.agent})`);
}

// ---------------------------------------------------------------------------
// Table test: every reachable cell
// ---------------------------------------------------------------------------

console.log("\nTable test: every reachable cell");

const gitRepo = makeGitRepo();
const gitFacts = require("./lib/next").collectGitFacts(gitRepo);
const base = gitFacts.base;
const headSha = execFileSync("git", ["-C", gitRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const PHASE_STATUSES = ["not_started", "planned", "reviewed", "approved", "in_progress", "implemented", "committed", "landed", "done", "failed", "skipped"];

const KNOB_COMBOS = [
  { review_plan: true, review_code: true, approve: "ask", enforcement: "deny" },
  { review_plan: false, review_code: true, approve: "ask", enforcement: "deny" },
  { review_plan: true, review_code: false, approve: "auto", enforcement: "deny" },
  { review_plan: false, review_code: false, approve: "auto", enforcement: "deny" },
];

const MODES = [undefined, "fast"];

for (const mode of MODES) {
  for (const knobs of KNOB_COMBOS) {
    for (const status of PHASE_STATUSES) {
      const label = `mode=${mode || "full"}, knobs=${JSON.stringify(knobs)}, status=${status}`;
      const dir = makeTaskDir();

      // Artifact states: plan_path present/missing
      const planPath = (status === "planned" || status === "reviewed" || status === "approved") ? "plan/phase-1.md" : undefined;
      if (planPath) {
        fs.mkdirSync(path.join(dir, "plan"), { recursive: true });
        fs.writeFileSync(path.join(dir, planPath), "# Plan\n");
      }

      // Commits present/missing
      const commits = (status === "committed" || status === "landed" || status === "done") ? [headSha] : undefined;
      const landedSha = (status === "landed" || status === "done") ? headSha : undefined;

      // Reports
      const reports = {};
      if (status === "implemented" || status === "committed") {
        reports.builder = { files_touched: [], verification: [], deviations: [], summary: "built" };
      }

      const phase = makePhase(1, status, {
        plan_path: planPath,
        commits,
        landed_sha: landedSha,
        reports,
        branch: undefined, // on base branch
      });

      const task = makeTask([phase], { knobs, mode });
      writeTask(dir, task);

      try {
        const result = computeNext(task, {
          projectDir: gitRepo,
          taskDir: dir,
          gitFacts,
        });
        assertShape(result, label);
      } catch (err) {
        assert(false, `${label}: computeNext threw: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// F17: fast-mode specific assertions
// ---------------------------------------------------------------------------

console.log("\nF17: fast-mode lifecycle");

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "not_started");
  const task = makeTask([phase], { mode: "fast", knobs: { review_plan: false, review_code: false, approve: "auto" } });
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.step === "build" && result.agent === "builder", "fast mode not_started → build/builder (not plan/explorer)");
  assert(result.pending_transitions && result.pending_transitions.includes("not_started -> in_progress"), "fast mode has pending transition");
}

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "not_started");
  const task = makeTask([phase], { knobs: { review_plan: false, review_code: false, approve: "auto" } });
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.step === "plan" && result.agent === "explorer", "full mode with review_plan=false → plan/explorer (knob alone doesn't trigger fast)");
}

// ---------------------------------------------------------------------------
// F14/F15: checkpoint options have types
// ---------------------------------------------------------------------------

console.log("\nF14/F15: checkpoint types");

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "planned", {
    counters: { review_passes: CAPS.review_passes + 1, clarify_rounds: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0 },
    reports: { reviewer: { verdict: "fail", issues: [], summary: "fail" } },
    plan_path: "plan/phase-1.md",
  });
  fs.mkdirSync(path.join(dir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan/phase-1.md"), "# Plan\n");
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.checkpoint && result.checkpoint.type === "review_cap", "review_cap checkpoint has type");
  assert(result.checkpoint && result.checkpoint.options.includes("approve_anyway"), "review_cap has approve_anyway");
  assert(result.checkpoint && result.checkpoint.options.includes("force_replan"), "review_cap has force_replan");
}

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "implemented", {
    counters: { review_passes: 0, clarify_rounds: 0, fix_attempts: CAPS.fix_attempts + 1, autofix_ran: false, ci_attempts: 0 },
    reports: { code_review: { kind: "code", verdict: "needs_work", issues: [], summary: "needs work" }, builder: { files_touched: [], verification: [], deviations: [], summary: "built" } },
  });
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.checkpoint && result.checkpoint.type === "fix_cap", "fix_cap checkpoint has type");
  assert(result.checkpoint && result.checkpoint.options.includes("force_retry"), "fix_cap has force_retry");
  assert(result.checkpoint && result.checkpoint.options.includes("abort"), "fix_cap has abort");
}

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "implemented", {
    reports: { code_review: { kind: "code", verdict: "fail", issues: [], summary: "fail" }, builder: { files_touched: [], verification: [], deviations: [], summary: "built" } },
  });
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.checkpoint && result.checkpoint.type === "review_fail", "review_fail checkpoint has type");
  assert(result.checkpoint && result.checkpoint.options.includes("replan"), "review_fail has replan");
  assert(result.checkpoint && result.checkpoint.options.includes("abort"), "review_fail has abort");
}

// ---------------------------------------------------------------------------
// F16: committed on base auto-advances with pending_transitions
// ---------------------------------------------------------------------------

console.log("\nF16: committed on base auto-advances");

{
  const dir = makeTaskDir();
  const passingRun = [{ cmd: "npm test", exit: 0, summary: "ok" }];
  const phase = makePhase(1, "committed", {
    commits: [headSha], landed_sha: headSha,
    reports: {
      reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "" },
      code_review: { kind: "code", verdict: "pass", issues: [], summary: "" },
      builder: { files_touched: [], verification: passingRun, deviations: [], summary: "built" },
      tests: { verification: passingRun },
    },
  });
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.step === "done", "committed on base with landed_sha → done");
  assert(result.pending_transitions && result.pending_transitions.length > 0, "done step has pending_transitions");
}

// ---------------------------------------------------------------------------
// Artifact-missing cells get a how (High 3)
// ---------------------------------------------------------------------------

console.log("\nArtifact-missing cells get a how");

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "planned", { plan_path: "plan/missing.md" });
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.step === "blocked", "missing plan_path → blocked");
  assert(result.how && result.how.command !== null, "missing plan_path → how has a command");
}

{
  const dir = makeTaskDir();
  const phase = makePhase(1, "committed", { commits: ["nonexistent-sha"] });
  const task = makeTask([phase]);
  writeTask(dir, task);
  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.step === "blocked", "missing commits → blocked");
  assert(result.how && result.how.command !== null, "missing commits → how has a command");
}

// ---------------------------------------------------------------------------
// D53: deferred-first cells (F6)
// ---------------------------------------------------------------------------

console.log("\nD53: deferred-first cells");

{
  const dir = makeTaskDir();
  const phases = [
    makePhase(1, "not_started", { blocked_by: [2] }),
    makePhase(2, "not_started"),
  ];
  const task = makeTask(phases);
  writeTask(dir, task);
  const eligible = findEligiblePhases(task);
  assert(eligible.length > 0 && eligible[0].id === 2, "blocked phase 1 defers to eligible phase 2");

  const result = computeNext(task, { projectDir: gitRepo, taskDir: dir, gitFacts });
  assert(result.phase_ids && result.phase_ids.includes(2), "computeNext returns phase 2 (not blocked phase 1)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
