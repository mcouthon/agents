#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { computeNext, findEligiblePhases, ALL_STEPS, computeHow } = require("./lib/next");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// Create a temp task dir with a real plan file for artifact verification
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-test-"));
const planDir = path.join(tmpDir, "plan");
fs.mkdirSync(planDir, { recursive: true });
fs.writeFileSync(path.join(planDir, "phase-1.md"), "# Phase 1 Plan");

function makePhase(overrides) {
  return Object.assign({
    id: 1, name: "Phase 1", status: "not_started", owner: null,
    blocked_by: [], parallel_group: "", plan_path: "", manifest: [],
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
    commits: [], branch: "", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
    started: "", completed: "",
  }, overrides);
}

function makeTask(overrides) {
  return Object.assign({
    schema: 2, slug: "test", number: 1, title: "Test", status: "in_progress",
    mode: "full", knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    phases: [], checkpoints: [], flags: [], created: "", updated: "",
  }, overrides);
}

// not_started → plan
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "not_started" })] });
  const r = computeNext(task, {});
  if (r.step === "plan" && r.agent === "explorer" && r.phase_ids.includes(1)) ok("not_started → plan, agent=explorer");
  else fail_(`expected plan/explorer, got ${r.step}/${r.agent}`);
}

// planned → review_plan (plan_path resolved against taskDir)
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/phase-1.md" })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "review_plan" && r.agent === "reviewer") ok("planned → review_plan, agent=reviewer (taskDir resolves plan file)");
  else fail_(`expected review_plan/reviewer, got ${r.step}/${r.agent}`);
}

// planned with missing plan file → blocked (plan_path resolved against taskDir)
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/nonexistent.md" })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "blocked" && r.reason.includes("plan file missing")) ok("planned with missing plan file → blocked (taskDir resolution)");
  else fail_(`expected blocked, got ${r.step}: ${r.reason}`);
}

// planned with open questions → blocked (clarify checkpoint)
{
  const task = makeTask({ phases: [makePhase({
    id: 1, status: "planned", plan_path: "plan/phase-1.md",
    reports: { explorer: { plan_path: "plan/phase-1.md", manifest: [], open_questions: [{ question: "Which framework?", options: ["React", "Vue"] }], summary: "" }, builder: null, reviewer: null, committer: null },
    counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
  })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "blocked" && r.checkpoint && r.checkpoint.question.includes("Which framework")) ok("planned with open questions → blocked with clarify checkpoint");
  else fail_(`expected blocked/checkpoint, got ${r.step}`);
}

// reviewed (no checkpoint) → approve
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "reviewed" })] });
  const r = computeNext(task, {});
  if (r.step === "approve" && r.checkpoint) ok("reviewed without checkpoint → approve");
  else fail_(`expected approve, got ${r.step}`);
}

// reviewed (approve=auto) → build
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "reviewed" })], knobs: { review_plan: true, review_code: true, approve: "auto", commit: "per_phase", parallel: 3, enforcement: "deny" } });
  const r = computeNext(task, {});
  if (r.step === "build" && r.agent === "builder") ok("reviewed with approve=auto → build");
  else fail_(`expected build, got ${r.step}`);
}

// approved → build
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "approved" })] });
  const r = computeNext(task, {});
  if (r.step === "build" && r.agent === "builder") ok("approved → build, agent=builder");
  else fail_(`expected build, got ${r.step}`);
}

// in_progress → build
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "in_progress" })] });
  const r = computeNext(task, {});
  if (r.step === "build" && r.agent === "builder") ok("in_progress → build");
  else fail_(`expected build, got ${r.step}`);
}

// implemented (no reviewer) → review_code
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "implemented", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: null, committer: null } })] });
  const r = computeNext(task, {});
  if (r.step === "review_code" && r.agent === "reviewer") ok("implemented without reviewer → review_code");
  else fail_(`expected review_code, got ${r.step}`);
}

// implemented (review_code=false) → commit
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "implemented", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: null, committer: null } })], knobs: { review_plan: true, review_code: false, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" } });
  const r = computeNext(task, {});
  if (r.step === "commit" && r.agent === "committer") ok("implemented with review_code=false → commit");
  else fail_(`expected commit, got ${r.step}`);
}

// implemented (reviewer needs_work) → fix
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "implemented", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null } })] });
  const r = computeNext(task, {});
  if (r.step === "fix" && r.agent === "builder") ok("implemented with needs_work → fix");
  else fail_(`expected fix, got ${r.step}`);
}

// implemented (reviewer pass) → commit
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "implemented", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: { verdict: "pass", issues: [], summary: "" }, committer: null } })] });
  const r = computeNext(task, {});
  if (r.step === "commit" && r.agent === "committer") ok("implemented with reviewer pass → commit");
  else fail_(`expected commit, got ${r.step}`);
}

// committed → land (direct repo)
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "committed", commits: ["abc123"], branch: "wt/1-test" })] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, currentBranch: () => "wt/1-test", base: "main" }, policy: { push: "direct" } };
  const r = computeNext(task, ctx);
  if (r.step === "land") ok("committed on direct repo → land");
  else fail_(`expected land, got ${r.step}`);
}

// landed → consolidate (D36: done predicate fires when all phases landed)
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "landed" })] });
  const r = computeNext(task, {});
  if (r.step === "consolidate") ok("landed → consolidate");
  else fail_(`expected consolidate, got ${r.step}`);
}

// zero phases → blocked, not consolidate (D15)
{
  const task = makeTask({ phases: [] });
  const r = computeNext(task, { taskDir: "/tmp/test-task" });
  if (r.step === "blocked") ok("zero phases → blocked (not consolidate)");
  else fail_(`expected blocked for zero phases, got ${r.step}`);
  if (r.reason === "task has no phases") ok("zero phases reason = 'task has no phases'");
  else fail_(`expected reason 'task has no phases', got '${r.reason}'`);
  if (r.how && r.how.tool === "Bash" && r.how.command.includes("a state add-phases"))
    ok("zero phases how points to a state add-phases");
  else fail_(`expected how.tool=Bash with add-phases, got ${JSON.stringify(r.how)}`);
}

// all done → consolidate
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "done" }), makePhase({ id: 2, status: "done" })] });
  const r = computeNext(task, {});
  if (r.step === "consolidate") ok("all done → consolidate");
  else fail_(`expected consolidate, got ${r.step}`);
}

// blocked by deps
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "in_progress" }), makePhase({ id: 2, status: "approved", blocked_by: [1] })] });
  const r = computeNext(task, {});
  // Phase 1 is the first eligible (in_progress), not blocked
  if (r.step === "build" && r.phase_ids.includes(1)) ok("first eligible phase (in_progress) not blocked by deps");
  else fail_(`expected build for phase 1, got ${r.step} for ${r.phase_ids}`);
}

// artifact missing → blocked (plan_path resolved against taskDir)
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/nonexistent.md" })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "blocked" && r.reason.includes("plan file missing")) ok("planned with missing plan file → blocked (taskDir resolution)");
  else fail_(`expected blocked, got ${r.step}: ${r.reason}`);
}

// parallel batching: three adjacent phases in group B
{
  const phases = [
    makePhase({ id: 1, status: "done" }),
    makePhase({ id: 3, status: "not_started", parallel_group: "B" }),
    makePhase({ id: 4, status: "not_started", parallel_group: "B" }),
    makePhase({ id: 5, status: "not_started", parallel_group: "B" }),
  ];
  const task = makeTask({ phases });
  const r = computeNext(task, {});
  if (r.phase_ids.length === 3 && r.phase_ids.includes(3) && r.phase_ids.includes(4) && r.phase_ids.includes(5)) ok("three adjacent phases in group B batched together");
  else fail_(`expected [3,4,5], got ${JSON.stringify(r.phase_ids)}`);
}

// parallel batching with cap: parallel=2
{
  const phases = [
    makePhase({ id: 1, status: "done" }),
    makePhase({ id: 3, status: "not_started", parallel_group: "B" }),
    makePhase({ id: 4, status: "not_started", parallel_group: "B" }),
    makePhase({ id: 5, status: "not_started", parallel_group: "B" }),
  ];
  const task = makeTask({ phases, knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 2, enforcement: "deny" } });
  const r = computeNext(task, {});
  if (r.phase_ids.length === 2 && r.phase_ids.includes(3) && r.phase_ids.includes(4)) ok("parallel=2 caps batch at 2 phases");
  else fail_(`expected [3,4], got ${JSON.stringify(r.phase_ids)}`);
}

// task done → step done
{
  const task = makeTask({ status: "done", phases: [makePhase({ id: 1, status: "done" })] });
  const r = computeNext(task, {});
  if (r.step === "done" && r.phase_ids.length === 0) ok("task done → step done, no phases");
  else fail_(`expected done, got ${r.step}`);
}

// ALL_STEPS completeness
{
  const expected = ["plan", "review_plan", "approve", "build", "review_code", "fix", "commit", "land", "resolve_conflicts", "pr", "ci_wait", "consolidate", "done", "blocked"];
  if (ALL_STEPS.length === expected.length && expected.every((s) => ALL_STEPS.includes(s))) ok("ALL_STEPS has all 14 steps");
  else fail_("ALL_STEPS is missing steps");
}

// D37: every computeNext result carries how: {tool, command}
{
  const cases = [
    { phases: [makePhase({ id: 1, status: "not_started" })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/phase-1.md" })], ctx: { taskDir: tmpDir } },
    { phases: [makePhase({ id: 1, status: "reviewed" })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "approved" })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "in_progress" })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "implemented", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: null, committer: null } })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "landed" })], ctx: {} },
    { phases: [makePhase({ id: 1, status: "done" }), makePhase({ id: 2, status: "done" })], ctx: {} },
  ];
  let allHaveHow = true;
  for (const c of cases) {
    const task = makeTask({ phases: c.phases });
    const r = computeNext(task, c.ctx);
    if (!r.how || typeof r.how.tool === "undefined" || typeof r.how.command === "undefined") {
      allHaveHow = false;
      fail_(`D37: step ${r.step} missing how field`);
    }
  }
  if (allHaveHow) ok("D37: every computeNext result carries how: {tool, command}");
}

// D37: computeHow maps each step to the right tool
{
  const planHow = computeHow("plan", { id: 1 }, { taskDir: "/tmp/t" });
  if (planHow.tool === "Agent" && planHow.command.includes("Explorer")) ok("D37: plan → Agent/Explorer");
  else fail_("D37: plan how = " + JSON.stringify(planHow));

  const reviewHow = computeHow("review_plan", { id: 6, plan_path: "plan/phase-6.md" }, { taskDir: "/tmp/t" });
  if (reviewHow.tool === "Agent" && reviewHow.command.includes("Reviewer") && reviewHow.command.includes("phase-6.md"))
    ok("D37: review_plan → Agent/Reviewer with plan path");
  else fail_("D37: review_plan how = " + JSON.stringify(reviewHow));

  const approveHow = computeHow("approve", { id: 1 }, {});
  if (approveHow.tool === "AskUserQuestion") ok("D37: approve → AskUserQuestion");
  else fail_("D37: approve how = " + JSON.stringify(approveHow));

  const commitMainHow = computeHow("commit", { id: 2, branch: "" }, { taskDir: "/tmp/t", gitFacts: { base: "main", currentBranch: () => "main" } });
  if (commitMainHow.tool === "Bash" && commitMainHow.command.includes("a state update") && commitMainHow.command.includes("--commits"))
    ok("D37: commit on main checkout → Bash/a state update --commits");
  else fail_("D37: commit main how = " + JSON.stringify(commitMainHow));

  const commitBranchHow = computeHow("commit", { id: 2, branch: "wt/2-test" }, { taskDir: "/tmp/t", gitFacts: { base: "main", currentBranch: () => "wt/2-test" } });
  if (commitBranchHow.tool === "Bash" && commitBranchHow.command.includes("a land"))
    ok("D37: commit on branch → Bash/a land");
  else fail_("D37: commit branch how = " + JSON.stringify(commitBranchHow));

  const landHow = computeHow("land", { id: 2 }, { taskDir: "/tmp/t" });
  if (landHow.tool === "Bash" && landHow.command.includes("a land")) ok("D37: land → Bash/a land");
  else fail_("D37: land how = " + JSON.stringify(landHow));

  const doneHow = computeHow("done", null, {});
  if (doneHow.tool === null && doneHow.command === null) ok("D37: done → null/null");
  else fail_("D37: done how = " + JSON.stringify(doneHow));

  const consolidateHow = computeHow("consolidate", null, {});
  if (consolidateHow.tool === "Skill" && consolidateHow.command.includes("consolidate-task"))
    ok("D37: consolidate → Skill/consolidate-task");
  else fail_("D37: consolidate how = " + JSON.stringify(consolidateHow));
}

// fix_attempts cap reached → blocked with checkpoint
{
  const task = makeTask({ phases: [makePhase({
    id: 1, status: "implemented",
    counters: { review_passes: 0, fix_attempts: 2, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
    reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null },
  })] });
  const r = computeNext(task, {});
  if (r.step === "blocked" && r.checkpoint && r.checkpoint.options.includes("skip"))
    ok("fix_attempts cap reached → blocked with checkpoint");
  else fail_(`expected blocked/checkpoint, got ${r.step}/${r.checkpoint ? r.checkpoint.id : "none"}`);
}
// review_passes cap exceeded (cap failing rounds tolerated, D55) → blocked with checkpoint
{
  const task = makeTask({ phases: [makePhase({
    id: 1, status: "planned", plan_path: "plan/phase-1.md",
    counters: { review_passes: 2, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
  })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "blocked" && r.checkpoint && r.checkpoint.options.includes("approve_anyway"))
    ok("review_passes cap reached → blocked with checkpoint");
  else fail_(`expected blocked/checkpoint, got ${r.step}/${r.checkpoint ? r.checkpoint.id : "none"}`);
}

// D32: warnings surfaced in computeNext output
{
  const task = makeTask({
    phases: [makePhase({
      id: 1, status: "reviewed", plan_path: "plan/phase-1.md",
      warnings: [
        { guard: "reviewer_verdict_pass", reason: "reviewer report not found", at: "2026-10-17T12:00:00Z", session_id: "sess-abc" },
      ],
    })],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" },
  });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.warnings && r.warnings.length === 1) ok("computeNext surfaces warnings from eligible phase");
  else fail_("computeNext should surface warnings, got: " + JSON.stringify(r.warnings));
  if (r.warnings && r.warnings[0].guard === "reviewer_verdict_pass" && r.warnings[0].phase === 1)
    ok("computeNext warning has guard and phase");
  else fail_("computeNext warning should have guard and phase fields");
}

// D32: warnings empty when no warnings on phases
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "not_started" })] });
  const r = computeNext(task, {});
  if (Array.isArray(r.warnings) && r.warnings.length === 0) ok("computeNext returns empty warnings array when no warnings");
  else fail_("computeNext should return empty warnings array, got: " + JSON.stringify(r.warnings));
}

// D32: warnings empty on done task
{
  const task = makeTask({ status: "done", phases: [makePhase({ id: 1, status: "done", warnings: [{ guard: "x", reason: "y", at: "z", session_id: "s" }] })] });
  const r = computeNext(task, {});
  if (Array.isArray(r.warnings) && r.warnings.length === 0) ok("computeNext returns empty warnings on done task");
  else fail_("computeNext should return empty warnings on done task, got: " + JSON.stringify(r.warnings));
}

// committed with conflict → resolve_conflicts
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "committed", commits: ["abc123"], branch: "wt/1-test", conflict: { files: ["conflict.txt"], base_sha: "b", branch_sha: "c", attempt: 1 } })] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, currentBranch: () => "wt/1-test", base: "main" } };
  const r = computeNext(task, ctx);
  if (r.step === "resolve_conflicts" && r.agent === "builder") ok("committed with conflict → resolve_conflicts, agent=builder");
  else fail_(`expected resolve_conflicts/builder, got ${r.step}/${r.agent}`);
}

// committed with pr_open → ci_wait
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "committed", commits: ["abc123"], branch: "wt/1-test", pr_open: true, pr: { url: "https://example.com/pr/1", branch: "wt/1-test", base: "main" } })] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, currentBranch: () => "wt/1-test", base: "main" } };
  const r = computeNext(task, ctx);
  if (r.step === "ci_wait" && r.agent === null) ok("committed with pr_open → ci_wait, agent=null");
  else fail_(`expected ci_wait/null, got ${r.step}/${r.agent}`);
}

// committed with landed_sha on base → done
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "committed", commits: ["abc123"], branch: "wt/1-test", landed_sha: "landed-sha-123" })] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, currentBranch: () => "wt/1-test", base: "main" } };
  const r = computeNext(task, ctx);
  if (r.step === "done" && r.agent === null) ok("committed with landed_sha on base → done");
  else fail_(`expected done, got ${r.step}`);
}

// committed with land:at_end and non-committed siblings → blocked
{
  const task = makeTask({
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny", land: "at_end" },
    phases: [
      makePhase({ id: 1, status: "committed", commits: ["abc123"], branch: "wt/1-test" }),
      makePhase({ id: 2, status: "in_progress" }),
    ],
  });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, currentBranch: () => "wt/1-test", base: "main" } };
  const r = computeNext(task, ctx);
  if (r.step === "blocked" && r.agent === null) ok("committed with land:at_end and non-committed siblings → blocked");
  else fail_(`expected blocked, got ${r.step}`);
}

// D53: an earlier phase blocked by a later one defers; the later phase is current
{
  const task = makeTask({ phases: [
    makePhase({ id: 1, status: "planned", blocked_by: [3], plan_path: "plan/phase-1.md" }),
    makePhase({ id: 2, status: "done" }),
    makePhase({ id: 3, status: "not_started" }),
  ] });
  const el = findEligiblePhases(task);
  const r = computeNext(task, { taskDir: tmpDir });
  if (el.length === 1 && el[0].id === 3 && r.step === "plan" && r.phase_ids.includes(3)) ok("D53: blocked first phase defers to the eligible later phase");
  else fail_(`D53 expected plan on 3, got ${r.step} on ${JSON.stringify(r.phase_ids)}`);
}

// D55: planned + failing plan-review verdict → plan (Explorer revises), not review_plan
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/phase-1.md",
    reports: { explorer: { plan_path: "plan/phase-1.md" }, builder: null, committer: null,
      reviewer: { verdict: "fail", issues: [], summary: "blocking" } },
    counters: { review_passes: 1, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 } })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "plan" && r.agent === "explorer" && r.reason.includes("revise")) ok("D55: failing plan review → plan/explorer (revise)");
  else fail_(`D55 expected plan/explorer, got ${r.step}/${r.agent}: ${r.reason}`);
}

// D53: when no open phase is eligible, the earliest blocked phase is reported
{
  const task = makeTask({ phases: [
    makePhase({ id: 1, status: "not_started", blocked_by: [2] }),
    makePhase({ id: 2, status: "not_started", blocked_by: [1] }),
  ] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.step === "blocked" && r.phase_ids.includes(1) && r.reason.includes("blocked by incomplete")) ok("D53: no eligible phase → blocked on the earliest");
  else fail_(`D53 expected blocked on 1, got ${r.step} on ${JSON.stringify(r.phase_ids)}`);
}

// F14: review_cap checkpoint has type and all three options
{
  const task = makeTask({ phases: [makePhase({
    id: 1, status: "planned", plan_path: "plan/phase-1.md",
    counters: { review_passes: 2, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
  })] });
  const r = computeNext(task, { taskDir: tmpDir });
  if (r.checkpoint && r.checkpoint.type === "review_cap" &&
      r.checkpoint.options.includes("approve_anyway") &&
      r.checkpoint.options.includes("force_replan") &&
      r.checkpoint.options.includes("skip"))
    ok("F14: review_cap checkpoint has type and all three options (approve_anyway, force_replan, skip)");
  else
    fail_(`F14: expected review_cap with 3 options, got ${r.checkpoint ? r.checkpoint.type + "/" + JSON.stringify(r.checkpoint.options) : "none"}`);
}

// F15: review_fail checkpoint (verdict=fail on implemented) has type and options
{
  const task = makeTask({ phases: [makePhase({
    id: 1, status: "implemented",
    reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "built" }, reviewer: { verdict: "fail", issues: [], summary: "fail" }, committer: null },
  })] });
  const r = computeNext(task, {});
  if (r.checkpoint && r.checkpoint.type === "review_fail" &&
      r.checkpoint.options.includes("replan") &&
      r.checkpoint.options.includes("skip") &&
      r.checkpoint.options.includes("abort"))
    ok("F15: review_fail checkpoint has type and all three options (replan, skip, abort)");
  else
    fail_(`F15: expected review_fail with 3 options, got ${r.checkpoint ? r.checkpoint.type + "/" + JSON.stringify(r.checkpoint.options) : "none"}`);
}

// F16/D60 req 2: computeNext purity — no task.json write, no mutating git op
{
  const tmpPurity = fs.mkdtempSync(path.join(os.tmpdir(), "next-purity-"));
  const taskDir = path.join(tmpPurity, "task");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskObj = makeTask({ phases: [makePhase({ id: 1, status: "committed", commits: ["abc123"], landed_sha: "landed-sha-123" })] });
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(taskObj, null, 2));
  const mtimeBefore = fs.statSync(path.join(taskDir, "task.json")).mtimeMs;
  const ctx = {
    taskDir,
    gitFacts: { shaExists: () => true, isAncestor: () => true, currentBranch: () => "main", base: "main" },
  };
  const r = computeNext(taskObj, ctx);
  const mtimeAfter = fs.statSync(path.join(taskDir, "task.json")).mtimeMs;
  if (r.step === "done" && mtimeAfter === mtimeBefore)
    ok("F16: computeNext(done-on-base) is pure — no task.json write");
  else if (r.step !== "done")
    fail_(`F16: expected step=done, got ${r.step}`);
  else
    fail_("F16: computeNext wrote task.json (mtime changed)");
  // Also verify the task object was not mutated
  const taskAfter = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (taskAfter.phases[0].status === "committed")
    ok("F16: computeNext did not mutate the phase status in task.json");
  else
    fail_(`F16: phase status changed to ${taskAfter.phases[0].status} (computeNext must not transition)`);
  fs.rmSync(tmpPurity, { recursive: true, force: true });
}

// F17: fast mode keyed off task.mode only, not review_plan
{
  const task = makeTask({
    mode: "full",
    knobs: { review_plan: false, review_code: false, approve: "auto", commit: "per_phase", parallel: 3, enforcement: "deny" },
    phases: [makePhase({ id: 1, status: "not_started" })],
  });
  const r = computeNext(task, {});
  if (r.step === "plan" && r.agent === "explorer")
    ok("F17: full mode with review_plan=false → plan/explorer (mode key, not knob)");
  else
    fail_(`F17: expected plan/explorer, got ${r.step}/${r.agent}`);
}
{
  const task = makeTask({
    mode: "fast",
    phases: [makePhase({ id: 1, status: "not_started" })],
  });
  const r = computeNext(task, {});
  if (r.step === "build" && r.agent === "builder")
    ok("F17: fast mode → build/builder regardless of knobs");
  else
    fail_(`F17: expected build/builder, got ${r.step}/${r.agent}`);
}

// F21: --explain output
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "not_started" })] });
  const r = computeNext(task, { explain: true });
  if (r.explain && r.explain.phase_id === 1 && r.explain.phase_status === "not_started" &&
      r.explain.step === "plan" && r.explain.agent === "explorer" && r.explain.matching_rule)
    ok("F21: --explain returns phase_id, phase_status, step, agent, matching_rule");
  else
    fail_(`F21: expected explain object, got ${JSON.stringify(r.explain)}`);
}
{
  const task = makeTask({ phases: [makePhase({ id: 1, status: "planned", plan_path: "plan/phase-1.md" })] });
  const r = computeNext(task, { taskDir: tmpDir, explain: true });
  if (r.explain && r.explain.artifacts && r.explain.artifacts.plan_path === true)
    ok("F21: --explain includes artifacts (plan_path present)");
  else
    fail_(`F21: expected artifacts.plan_path=true, got ${JSON.stringify(r.explain && r.explain.artifacts)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
