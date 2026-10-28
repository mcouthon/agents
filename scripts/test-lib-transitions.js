#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-transitions-tasks-"));
const { checkTransition, applyTransition, CAPS, LEGACY_STATUS_MAP, PHASE_STATUSES, formatMissingActions, MISSING_ACTIONS } = require("./lib/transitions");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// Create a temp task dir with a real plan file for file-existence guards
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transitions-test-"));
const planDir = path.join(tmpDir, "plan");
fs.mkdirSync(planDir, { recursive: true });
fs.writeFileSync(path.join(planDir, "phase-1.md"), "# Phase 1 Plan");
fs.writeFileSync(path.join(planDir, "phase-2.md"), "# Phase 2 Plan");

function makePhase(overrides) {
  return Object.assign({
    id: 1, name: "Test", status: "not_started", owner: null,
    blocked_by: [], parallel_group: "", plan_path: "", manifest: [],
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
    commits: [], branch: "", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
    started: "", completed: "",
  }, overrides);
}

const PASSING_TESTS = [{ cmd: "npm test", exit: 0, summary: "ok" }];

// Reports a phase carries once its build, both reviews and its tests are on record.
function evidenceReports(overrides) {
  return Object.assign({
    explorer: null, committer: null,
    reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "" },
    builder: { files_touched: [], verification: PASSING_TESTS, deviations: [], summary: "" },
    tests: { verification: PASSING_TESTS },
    code_review: { kind: "code", verdict: "pass", issues: [], summary: "" },
  }, overrides);
}

function makeTask(overrides) {
  return Object.assign({
    schema: 2, slug: "test", number: 1, title: "Test", status: "in_progress",
    mode: "full", knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    phases: [], checkpoints: [], flags: [], created: "", updated: "",
  }, overrides);
}

// --- Legal transitions with guards satisfied ---

// not_started → planned (plan_path exists, resolved against taskDir)
{
  const phase = makePhase({ plan_path: "plan/phase-1.md" });
  const task = makeTask({ phases: [phase] });
  const ctx = { taskDir: tmpDir };
  const r = checkTransition("not_started", "planned", phase, task, ctx);
  if (r.ok) ok("not_started → planned with plan_path set (resolved against taskDir)");
  else fail_("not_started → planned should be ok: " + r.reason);
}

// not_started → planned (plan_path set but file missing in taskDir → guard fails)
{
  const phase = makePhase({ plan_path: "plan/nonexistent.md" });
  const task = makeTask({ phases: [phase] });
  const ctx = { taskDir: tmpDir };
  const r = checkTransition("not_started", "planned", phase, task, ctx);
  if (!r.ok && r.reason.includes("not found")) ok("not_started → planned rejected when plan file missing in taskDir");
  else fail_("not_started → planned should fail when file missing in taskDir: " + r.reason);
}

// not_started → planned (no plan_path → guard fails)
{
  const phase = makePhase({ plan_path: "" });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("not_started", "planned", phase, task, {});
  if (!r.ok && r.missing.includes("plan_path")) ok("not_started → planned rejected without plan_path");
  else fail_("not_started → planned should fail without plan_path");
}

// planned → reviewed (reviewer verdict pass)
{
  const phase = makePhase({ status: "planned", plan_path: "plan/phase-1.md", reports: { explorer: null, builder: null, reviewer: { verdict: "pass", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("planned", "reviewed", phase, task, {});
  if (r.ok) ok("planned → reviewed with reviewer verdict pass");
  else fail_("planned → reviewed should be ok: " + r.reason);
}

// planned → reviewed (review_plan=false skips guard)
{
  const phase = makePhase({ status: "planned", reports: { explorer: null, builder: null, reviewer: null, committer: null } });
  const task = makeTask({ phases: [phase], knobs: { review_plan: false, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" } });
  const r = checkTransition("planned", "reviewed", phase, task, {});
  if (r.ok) ok("planned → reviewed skips guard when review_plan=false");
  else fail_("planned → reviewed should skip guard when review_plan=false: " + r.reason);
}

// planned → reviewed (reviewer verdict needs_work → guard fails)
{
  const phase = makePhase({ status: "planned", reports: { explorer: null, builder: null, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("planned", "reviewed", phase, task, {});
  if (!r.ok) ok("planned → reviewed rejected when reviewer verdict is needs_work");
  else fail_("planned → reviewed should fail with needs_work verdict");
}

// reviewed → approved (checkpoint resolved)
{
  const phase = makePhase({ id: 1, status: "reviewed" });
  const task = makeTask({ phases: [phase], checkpoints: [{ id: "c1", phase: 1, type: "approve_plan", question: "Approve?", options: ["approve"], chosen: "approve", opened_at: "", resolved_at: "2026-01-01T00:00:00Z" }] });
  const r = checkTransition("reviewed", "approved", phase, task, {});
  if (r.ok) ok("reviewed → approved with resolved checkpoint");
  else fail_("reviewed → approved should be ok: " + r.reason);
}

// reviewed → approved (approve=auto skips checkpoint)
{
  const phase = makePhase({ id: 1, status: "reviewed" });
  const task = makeTask({ phases: [phase], knobs: { review_plan: true, review_code: true, approve: "auto", commit: "per_phase", parallel: 3, enforcement: "deny" }, checkpoints: [] });
  const r = checkTransition("reviewed", "approved", phase, task, {});
  if (r.ok) ok("reviewed → approved auto when approve=auto");
  else fail_("reviewed → approved should be ok with approve=auto: " + r.reason);
}

// reviewed → approved (no checkpoint → guard fails)
{
  const phase = makePhase({ id: 1, status: "reviewed" });
  const task = makeTask({ phases: [phase], checkpoints: [] });
  const r = checkTransition("reviewed", "approved", phase, task, {});
  if (!r.ok && r.reason.includes("checkpoint")) ok("reviewed → approved rejected without checkpoint");
  else fail_("reviewed → approved should fail without checkpoint");
}

// approved → in_progress (deps done)
{
  const phase = makePhase({ id: 2, status: "approved", blocked_by: [1] });
  const dep = makePhase({ id: 1, status: "done" });
  const task = makeTask({ phases: [dep, phase] });
  const r = checkTransition("approved", "in_progress", phase, task, {});
  if (r.ok) ok("approved → in_progress with deps done");
  else fail_("approved → in_progress should be ok: " + r.reason);
}

// approved → in_progress (deps not done → guard fails)
{
  const phase = makePhase({ id: 2, status: "approved", blocked_by: [1] });
  const dep = makePhase({ id: 1, status: "in_progress" });
  const task = makeTask({ phases: [dep, phase] });
  const r = checkTransition("approved", "in_progress", phase, task, {});
  if (!r.ok && r.reason.includes("incomplete")) ok("approved → in_progress rejected with deps not done");
  else fail_("approved → in_progress should fail with deps not done");
}

// in_progress → implemented (builder report present)
{
  const phase = makePhase({ status: "in_progress", reports: { explorer: null, builder: { files_touched: [], verification: [], deviations: [], summary: "" }, reviewer: null, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("in_progress", "implemented", phase, task, {});
  if (r.ok) ok("in_progress → implemented with builder report");
  else fail_("in_progress → implemented should be ok: " + r.reason);
}

// in_progress → implemented (no builder report → guard fails)
{
  const phase = makePhase({ status: "in_progress", reports: { explorer: null, builder: null, reviewer: null, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("in_progress", "implemented", phase, task, {});
  if (!r.ok && r.missing.includes("reports.builder")) ok("in_progress → implemented rejected without builder report");
  else fail_("in_progress → implemented should fail without builder report");
}

// implemented → in_progress (review needs_work, under cap)
{
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, code_review: { kind: "code", verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("implemented", "in_progress", phase, task, {});
  if (r.ok) ok("implemented → in_progress with needs_work, under fix cap");
  else fail_("implemented → in_progress should be ok: " + r.reason);
}

// implemented → in_progress (fix cap reached → guard fails)
{
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 2, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, code_review: { kind: "code", verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("implemented", "in_progress", phase, task, {});
  if (!r.ok && r.reason.includes("cap")) ok("implemented → in_progress rejected at fix_attempts cap");
  else fail_("implemented → in_progress should fail at cap");
}

// implemented → committed (commits + code review pass)
{
  const phase = makePhase({ status: "implemented", commits: ["abc123"], reports: { explorer: null, builder: null, code_review: { kind: "code", verdict: "pass", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("implemented", "committed", phase, task, ctx);
  if (r.ok) ok("implemented → committed with commits and code review pass");
  else fail_("implemented → committed should be ok: " + r.reason);
}

// implemented → committed (no commits → guard fails)
{
  const phase = makePhase({ status: "implemented", commits: [], reports: { explorer: null, builder: null, reviewer: null, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("implemented", "committed", phase, task, {});
  if (!r.ok && r.missing.includes("commits")) ok("implemented → committed rejected without commits");
  else fail_("implemented → committed should fail without commits");
}

// implemented → committed (review_code=false skips guard)
{
  const phase = makePhase({ status: "implemented", commits: ["abc123"], reports: { explorer: null, builder: null, reviewer: null, committer: null } });
  const task = makeTask({ phases: [phase], knobs: { review_plan: true, review_code: false, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" } });
  const r = checkTransition("implemented", "committed", phase, task, {});
  if (r.ok) ok("implemented → committed skips code review when review_code=false");
  else fail_("implemented → committed should skip when review_code=false: " + r.reason);
}

// committed → landed (landed_sha is ancestor of base)
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "wt/1-test", landed_sha: "def456", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (r.ok) ok("committed → landed with landed_sha as ancestor of base");
  else fail_("committed → landed should be ok: " + r.reason);
}

// committed → landed fails without landed_sha
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "wt/1-test", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok) ok("committed → landed rejected without landed_sha");
  else fail_("committed → landed should fail without landed_sha");
}

// committed → landed fails when landed_sha is not ancestor of base
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], landed_sha: "def456", branch: "wt/1-test", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok) ok("committed → landed rejected when landed_sha not ancestor");
  else fail_("committed → landed should fail when landed_sha not ancestor");
}

// D34: committed → landed on base branch (branch == base) with commits but no
// landed_sha → guard derives landed_sha from the last commit, passes, sets
// phase.landed_sha as a side effect.
{
  const phase = makePhase({ status: "committed", commits: ["aaa111", "bbb222"], branch: "main", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (r.ok && phase.landed_sha === "bbb222") ok("committed → landed on base derives landed_sha from last commit");
  else fail_("committed → landed on base should derive landed_sha: ok=" + r.ok + " landed_sha=" + phase.landed_sha);
}

// D34: committed → landed on empty branch with commits but no landed_sha
{
  const phase = makePhase({ status: "committed", commits: ["aaa111"], branch: "", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (r.ok && phase.landed_sha === "aaa111") ok("committed → landed on empty branch derives landed_sha");
  else fail_("committed → landed on empty branch should derive landed_sha: ok=" + r.ok);
}

// D34: committed → landed on base branch with no commits → fails
{
  const phase = makePhase({ status: "committed", commits: [], branch: "main", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok && r.missing.includes("evidence:commits") && r.reason.includes("missing commits")) ok("committed → landed on base rejected without commits");
  else fail_("committed → landed on base should fail without commits: " + r.reason);
}

// D34: committed → landed on base branch, last commit not ancestor → fails,
// landed_sha is NOT set as a side effect
{
  const phase = makePhase({ status: "committed", commits: ["bad999"], branch: "main", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok && phase.landed_sha === undefined) ok("committed → landed on base rejected when last commit not ancestor (no side effect)");
  else fail_("committed → landed on base should fail and not set landed_sha: ok=" + r.ok + " landed_sha=" + phase.landed_sha);
}

// D34: committed → landed on a real branch (≠ base) with no landed_sha still
// fails with "run `a land` first" (the base-branch derivation does NOT fire)
{
  const phase = makePhase({ status: "committed", commits: ["aaa111"], branch: "wt/1-test", reports: evidenceReports() });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok && r.reason.includes("a land")) ok("committed → landed on real branch still requires a land");
  else fail_("committed → landed on real branch should fail with 'a land': " + r.reason);
}

// landed → done (no guard)
{
  const phase = makePhase({ status: "landed" });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("landed", "done", phase, task, {});
  if (r.ok) ok("landed → done unconditional");
  else fail_("landed → done should be ok: " + r.reason);
}

// --- Terminal transitions (any non-done → failed, skipped) ---
{
  for (const from of ["not_started", "planned", "reviewed", "approved", "in_progress", "implemented", "committed", "landed"]) {
    const phase = makePhase({ status: from });
    const task = makeTask({ phases: [phase] });
    const r1 = checkTransition(from, "failed", phase, task, {});
    if (r1.ok) ok(`${from} → failed allowed`);
    else fail_(`${from} → failed should be allowed`);
    const r2 = checkTransition(from, "skipped", phase, task, {});
    if (r2.ok) ok(`${from} → skipped allowed`);
    else fail_(`${from} → skipped should be allowed`);
  }
}

// done → failed not allowed
{
  const phase = makePhase({ status: "done" });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("done", "failed", phase, task, {});
  if (!r.ok) ok("done → failed rejected");
  else fail_("done → failed should be rejected");
}

// --- Illegal transitions ---
{
  const illegal = [
    ["not_started", "in_progress"],
    ["not_started", "done"],
    ["planned", "in_progress"],
    ["planned", "done"],
    ["reviewed", "in_progress"],
    ["reviewed", "done"],
    ["approved", "done"],
    ["in_progress", "done"],
    ["in_progress", "committed"],
    ["implemented", "done"],
    ["committed", "in_progress"],
    ["landed", "in_progress"],
  ];
  for (const [from, to] of illegal) {
    const phase = makePhase({ status: from });
    const task = makeTask({ phases: [phase] });
    const r = checkTransition(from, to, phase, task, {});
    if (!r.ok) ok(`illegal: ${from} → ${to} rejected`);
    else fail_(`${from} → ${to} should be rejected (illegal transition)`);
  }
}

// --- applyTransition side effects ---
{
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, code_review: { kind: "code", verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  applyTransition(phase, "in_progress", task, {});
  if (phase.status === "in_progress" && phase.counters.fix_attempts === 1) ok("applyTransition increments fix_attempts on implemented → in_progress");
  else fail_("fix_attempts should be 1 after transition, got " + phase.counters.fix_attempts);
}

{
  const phase = makePhase({ status: "landed" });
  const task = makeTask({ phases: [phase] });
  applyTransition(phase, "done", task, {});
  if (phase.completed) ok("applyTransition sets completed on → done");
  else fail_("completed should be set after → done");
}

// applyTransition increments review_passes on planned → reviewed
{
  const phase = makePhase({
    status: "planned", plan_path: "plan/phase-1.md",
    counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
    reports: { explorer: null, builder: null, reviewer: { verdict: "pass", issues: [], summary: "" }, committer: null },
  });
  const task = makeTask({ phases: [phase] });
  applyTransition(phase, "reviewed", task, {});
  if (phase.counters.review_passes === 1) ok("applyTransition increments review_passes on planned → reviewed");
  else fail_("review_passes should be 1, got " + phase.counters.review_passes);
}

// applyTransition sets structured error fields on rejection
{
  const phase = makePhase({ status: "not_started", plan_path: "" });
  const task = makeTask({ phases: [phase] });
  let caught = null;
  try {
    applyTransition(phase, "planned", task, {});
  } catch (err) {
    caught = err;
  }
  if (caught && caught.transitionError && caught.error && caught.from === "not_started" && caught.to === "planned" && Array.isArray(caught.missing))
    ok("applyTransition throws structured {error,from,to,missing} on rejection");
  else fail_("applyTransition should set structured error fields");
}

// D37: refusal text appends the exact action sentence for each missing key
{
  const phase = makePhase({ id: 6, status: "planned", plan_path: "plan/phase-6.md" });
  const task = makeTask({ phases: [phase] });
  const ctx = { taskDir: "/tmp/.tasks/128-test", sessionId: "s1" };
  let caught = null;
  try {
    applyTransition(phase, "reviewed", task, ctx);
  } catch (err) {
    caught = err;
  }
  if (caught && caught.message.includes("a report --task-dir /tmp/.tasks/128-test --phase-id 6 --agent reviewer"))
    ok("D37: planned → reviewed refusal includes `a report … --agent reviewer` sentence");
  else
    fail_("D37: refusal should include reviewer report sentence: " + (caught ? caught.message : "no error"));
}

// D37: formatMissingActions maps reports.reviewer to the reviewer sentence
{
  const phase = makePhase({ id: 3, status: "planned" });
  const actions = formatMissingActions(["reports.reviewer"], phase, { taskDir: "/tmp/.tasks/5-test" });
  if (actions.includes("spawn a Reviewer on phase 3") && actions.includes("a report --task-dir /tmp/.tasks/5-test --phase-id 3 --agent reviewer"))
    ok("D37: formatMissingActions maps reports.reviewer to reviewer action");
  else
    fail_("D37: formatMissingActions(reports.reviewer) = " + actions);
}

// D37: formatMissingActions maps commits to the state update sentence
{
  const phase = makePhase({ id: 2, status: "implemented" });
  const actions = formatMissingActions(["commits"], phase, { taskDir: "/tmp/.tasks/5-test" });
  if (actions.includes("a state update --task-dir /tmp/.tasks/5-test --phase-id 2 --phase-status committed --commits"))
    ok("D37: formatMissingActions maps commits to state update sentence");
  else
    fail_("D37: formatMissingActions(commits) = " + actions);
}

// D37: formatMissingActions maps checkpoint to AskUserQuestion sentence
{
  const phase = makePhase({ id: 1, status: "reviewed" });
  const actions = formatMissingActions(["checkpoint:approve_plan"], phase, {});
  if (actions.includes("AskUserQuestion") && actions.includes("checkpoint-capture"))
    ok("D37: formatMissingActions maps checkpoint to AskUserQuestion sentence");
  else
    fail_("D37: formatMissingActions(checkpoint) = " + actions);
}

// D37: formatMissingActions maps plan_path to Explorer sentence
{
  const phase = makePhase({ id: 4, status: "not_started" });
  const actions = formatMissingActions(["plan_path"], phase, { taskDir: "/tmp/.tasks/9-test" });
  if (actions.includes("spawn an Explorer on phase 4") && actions.includes("--agent explorer"))
    ok("D37: formatMissingActions maps plan_path to Explorer sentence");
  else
    fail_("D37: formatMissingActions(plan_path) = " + actions);
}

// D37: formatMissingActions maps deps (phase ids) to the deps sentence
{
  const phase = makePhase({ id: 5, status: "approved" });
  const actions = formatMissingActions(["2", "3"], phase, {});
  if (actions.includes("wait for phases 2, 3 to reach done/landed"))
    ok("D37: formatMissingActions maps deps to wait-for-phases sentence");
  else
    fail_("D37: formatMissingActions(deps) = " + actions);
}

// D37: MISSING_ACTIONS table covers all keys the guards emit
{
  const required = ["plan_path", "reports.explorer", "reports.builder", "reports.reviewer",
    "reports.reviewer.verdict", "checkpoint", "commits", "landed_sha", "deps", "cap"];
  const missing = required.filter((k) => !MISSING_ACTIONS[k]);
  if (missing.length === 0)
    ok("D37: MISSING_ACTIONS table has all required keys");
  else
    fail_("D37: MISSING_ACTIONS missing keys: " + missing.join(", "));
}

// --- D29 legacy status mapping ---
{
  if (LEGACY_STATUS_MAP.blocked === "in_progress") ok("D29: blocked maps to in_progress");
  else fail_("blocked should map to in_progress");
  if (LEGACY_STATUS_MAP.needs_human === "in_progress") ok("D29: needs_human maps to in_progress");
  else fail_("needs_human should map to in_progress");
  if (LEGACY_STATUS_MAP.review_ready === "in_progress") ok("D29: review_ready maps to in_progress");
  else fail_("review_ready should map to in_progress");
}

// --- Caps ---
{
  if (CAPS.review_passes === 1) ok("cap: review_passes = 1");
  else fail_("review_passes cap should be 1");
  if (CAPS.clarify_rounds === 1) ok("cap: clarify_rounds = 1");
  else fail_("clarify_rounds cap should be 1");
  if (CAPS.fix_attempts === 2) ok("cap: fix_attempts = 2");
  else fail_("fix_attempts cap should be 2");
  if (CAPS.ci_attempts === 5) ok("cap: ci_attempts = 5");
  else fail_("ci_attempts cap should be 5");
}

// --- D32: enforcement: warn vs deny ---

// Evidence guard (reviewer_verdict_pass) fails under warn → transition proceeds with warning
{
  const phase = makePhase({
    status: "planned",
    plan_path: "plan/phase-1.md",
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
  });
  const task = makeTask({
    phases: [phase],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" },
  });
  const ctx = { taskDir: tmpDir, sessionId: "test-session-1" };
  const r = checkTransition("planned", "reviewed", phase, task, ctx);
  if (!r.ok && r.kind === "evidence" && r.guard === "reviewer_verdict_pass")
    ok("warn: planned → reviewed fails evidence guard with kind=evidence");
  else fail_("warn: should return kind=evidence, guard=reviewer_verdict_pass, got: " + JSON.stringify(r));

  applyTransition(phase, "reviewed", task, ctx);
  if (phase.status === "reviewed") ok("warn: planned → reviewed proceeds despite evidence guard failure");
  else fail_("warn: planned → reviewed should proceed, got status: " + phase.status);

  if (phase.warnings && phase.warnings.length === 1) ok("warn: warning recorded for evidence guard failure");
  else fail_("warn: should have 1 warning, got: " + JSON.stringify(phase.warnings));

  if (phase.warnings && phase.warnings[0].guard === "reviewer_verdict_pass")
    ok("warn: warning has correct guard name");
  else fail_("warn: warning guard should be reviewer_verdict_pass");

  if (phase.warnings && phase.warnings[0].session_id === "test-session-1")
    ok("warn: warning has session_id from ctx");
  else fail_("warn: warning session_id should be test-session-1");

  if (phase.warnings && phase.warnings[0].reason && phase.warnings[0].at)
    ok("warn: warning has reason and timestamp");
  else fail_("warn: warning should have reason and at fields");
}

// Evidence guard (reviewer_verdict_pass) fails under deny → transition rejected
{
  const phase = makePhase({
    status: "planned",
    plan_path: "plan/phase-1.md",
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
  });
  const task = makeTask({
    phases: [phase],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
  });
  const ctx = { taskDir: tmpDir, sessionId: "test-session-2" };
  const r = checkTransition("planned", "reviewed", phase, task, ctx);
  if (!r.ok && r.kind === "evidence") ok("deny: planned → reviewed fails evidence guard");
  else fail_("deny: should fail with kind=evidence");

  let threw = false;
  try {
    applyTransition(phase, "reviewed", task, ctx);
  } catch (err) {
    threw = true;
    if (err.transitionError && err.from === "planned" && err.to === "reviewed")
      ok("deny: planned → reviewed throws structured error");
    else fail_("deny: should throw structured transition error");
  }
  if (!threw) fail_("deny: applyTransition should throw on evidence guard failure");
  if (phase.status !== "planned") fail_("deny: phase status should remain planned");
  else ok("deny: phase status unchanged after rejection");
  if (!phase.warnings || phase.warnings.length === 0) ok("deny: no warning recorded");
  else fail_("deny: should not record warnings");
}

// Artifact guard (plan_path_exists) fails under warn → still denied
{
  const phase = makePhase({ status: "not_started", plan_path: "plan/nonexistent.md" });
  const task = makeTask({
    phases: [phase],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" },
  });
  const ctx = { taskDir: tmpDir, sessionId: "test-session-3" };
  const r = checkTransition("not_started", "planned", phase, task, ctx);
  if (!r.ok && r.kind === "artifact" && r.guard === "plan_path_exists")
    ok("warn: artifact guard fails with kind=artifact");
  else fail_("warn: should return kind=artifact, guard=plan_path_exists, got: " + JSON.stringify(r));

  let threw = false;
  try {
    applyTransition(phase, "planned", task, ctx);
  } catch (err) {
    threw = true;
  }
  if (threw) ok("warn: artifact guard denies even under enforcement: warn");
  else fail_("warn: artifact guard should deny under warn");
  if (phase.status === "not_started" && (!phase.warnings || phase.warnings.length === 0))
    ok("warn: no warning recorded for artifact guard failure");
  else fail_("warn: artifact guard should not record warning or change status");
}

// Split guards: commits_recorded (artifact) + code_review_pass (evidence)
// commits_recorded fails (no commits) → artifact deny even under warn
{
  const phase = makePhase({
    status: "implemented",
    commits: [],
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
  });
  const task = makeTask({
    phases: [phase],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" },
  });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" }, sessionId: "test-4" };
  const r = checkTransition("implemented", "committed", phase, task, ctx);
  if (!r.ok && r.kind === "artifact" && r.guard === "commits_recorded")
    ok("warn: commits_recorded (artifact) fails first, kind=artifact");
  else fail_("warn: should fail with kind=artifact, guard=commits_recorded, got: " + JSON.stringify(r));
}

// commits_recorded passes, code_review_pass fails (evidence) → warn lets through
{
  const phase = makePhase({
    status: "implemented",
    commits: ["abc123"],
    reports: { explorer: null, builder: null, reviewer: null, committer: null },
  });
  const task = makeTask({
    phases: [phase],
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" },
  });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" }, sessionId: "test-5" };
  const r = checkTransition("implemented", "committed", phase, task, ctx);
  if (!r.ok && r.kind === "evidence" && r.guard === "code_review_pass")
    ok("warn: code_review_pass (evidence) fails after commits_recorded passes");
  else fail_("warn: should fail with kind=evidence, guard=code_review_pass, got: " + JSON.stringify(r));

  applyTransition(phase, "committed", task, ctx);
  if (phase.status === "committed") ok("warn: implemented → committed proceeds with code review warning");
  else fail_("warn: should proceed to committed, got: " + phase.status);
  if (phase.warnings && phase.warnings.length === 1 && phase.warnings[0].guard === "code_review_pass")
    ok("warn: code_review_pass warning recorded");
  else fail_("warn: should record code_review_pass warning, got: " + JSON.stringify(phase.warnings));
}

// Existing behavior preserved: commits + code review pass under deny
{
  const phase = makePhase({
    status: "implemented",
    commits: ["abc123"],
    reports: { explorer: null, builder: null, code_review: { kind: "code", verdict: "pass", issues: [], summary: "" }, committer: null },
  });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("implemented", "committed", phase, task, ctx);
  if (r.ok) ok("split guards: commits + code review pass → ok (backward compatible)");
  else fail_("split guards: should pass when both satisfied: " + r.reason);
}

// EVIDENCE_GUARDS and ARTIFACT_GUARDS exported
{
  const { EVIDENCE_GUARDS, ARTIFACT_GUARDS } = require("./lib/transitions");
  if (EVIDENCE_GUARDS.has("reviewer_verdict_pass") && EVIDENCE_GUARDS.has("code_review_pass"))
    ok("EVIDENCE_GUARDS includes reviewer_verdict_pass and code_review_pass");
  else fail_("EVIDENCE_GUARDS missing expected members");
  if (ARTIFACT_GUARDS.has("plan_path_exists") && ARTIFACT_GUARDS.has("commits_recorded"))
    ok("ARTIFACT_GUARDS includes plan_path_exists and commits_recorded");
  else fail_("ARTIFACT_GUARDS missing expected members");
  // No overlap
  let overlap = false;
  for (const g of EVIDENCE_GUARDS) if (ARTIFACT_GUARDS.has(g)) overlap = true;
  if (!overlap) ok("EVIDENCE_GUARDS and ARTIFACT_GUARDS are disjoint");
  else fail_("EVIDENCE_GUARDS and ARTIFACT_GUARDS should not overlap");
}

// D56: reviewed → planned revokes the review and clears the reviewer report
{
  const phase = makePhase({ status: "reviewed", plan_path: "plan/p.md",
    reports: { explorer: { plan_path: "plan/p.md" }, builder: null, committer: null, reviewer: { verdict: "pass", issues: [], summary: "test" } } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("reviewed", "planned", phase, task, {});
  if (r.ok) ok("D56: reviewed → planned is legal"); else fail_(`D56 check: ${r.reason}`);
  phase.counters.review_passes = 1;
  applyTransition(phase, "planned", task, {});
  if (phase.status === "planned" && phase.reports.reviewer === null && phase.counters.review_passes === 0) ok("D56: revoke clears the reviewer report and undoes its counted round");
  else fail_(`D56 apply: status=${phase.status} reviewer=${JSON.stringify(phase.reports.reviewer)}`);
}

const onBaseCtx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };

// TR1: a plan review alone cannot commit an implemented phase
{
  const phase = makePhase({ status: "implemented", commits: ["abc123"], reports: { explorer: null, builder: null, committer: null,
    reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "" } } });
  const r = checkTransition("implemented", "committed", phase, makeTask({ phases: [phase] }), onBaseCtx);
  if (!r.ok && r.missing.includes("reports.code_review")) ok("TR1: implemented → committed needs a code review, a plan review does not count");
  else fail_("TR1: expected missing reports.code_review, got " + JSON.stringify(r));
}

// TR2: needs_work in the plan-review slot cannot send an implemented phase back to the build
{
  const phase = makePhase({ status: "implemented", reports: { explorer: null, builder: null, committer: null,
    reviewer: { kind: "plan", verdict: "needs_work", issues: [], summary: "" } } });
  const r = checkTransition("implemented", "in_progress", phase, makeTask({ phases: [phase] }), {});
  if (!r.ok && r.missing.includes("reports.code_review.verdict")) ok("TR2: implemented → in_progress reads the code review, not the plan review");
  else fail_("TR2: expected rejection on reports.code_review.verdict, got " + JSON.stringify(r));
}

// TR3: the refusal names what is missing and how to get it, and nothing is written
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "main", reports: evidenceReports({ builder: null, tests: null }) });
  let caught = null;
  try { applyTransition(phase, "landed", makeTask({ phases: [phase] }), onBaseCtx); } catch (e) { caught = e; }
  const want = "Transition rejected: committed → landed. land refused for phase 1: missing tests. To proceed: spawn a Builder on phase 1 whose report lists each verification command with exit 0.";
  if (caught && caught.message === want && phase.status === "committed" && phase.landed_sha === undefined) ok("TR3: landing without test evidence is refused with one sentence and leaves the phase untouched");
  else fail_("TR3: got " + (caught ? caught.message : "no error") + " status=" + phase.status + " landed_sha=" + phase.landed_sha);
}

// TR4: a review written before kinds existed counts as both reviews on a committed phase
{
  const legacy = { explorer: null, committer: null,
    reviewer: { verdict: "pass_with_notes", issues: [], summary: "" },
    builder: { files_touched: [], verification: PASSING_TESTS, deviations: [], summary: "" } };
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "main", reports: legacy });
  const r = checkTransition("committed", "landed", phase, makeTask({ phases: [phase] }), onBaseCtx);
  const stamped = makePhase({ status: "committed", commits: ["abc123"], branch: "main",
    reports: { ...legacy, reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "" } } });
  const r2 = checkTransition("committed", "landed", stamped, makeTask({ phases: [stamped] }), onBaseCtx);
  if (r.ok && !r2.ok && r2.missing.includes("evidence:code review")) ok("TR4: an unstamped passing review lands a committed phase; a stamped plan review does not");
  else fail_("TR4: legacy=" + JSON.stringify(r) + " stamped=" + JSON.stringify(r2));
}

// TR5: the gate refuses under enforcement: warn and records no warning
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "main", reports: evidenceReports({ code_review: null }) });
  const task = makeTask({ phases: [phase], knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "warn" } });
  let caught = null;
  try { applyTransition(phase, "landed", task, onBaseCtx); } catch (e) { caught = e; }
  if (caught && caught.transitionError && phase.status === "committed" && !phase.warnings) ok("TR5: warn mode still refuses a landing with no code review");
  else fail_("TR5: caught=" + (caught && caught.message) + " status=" + phase.status + " warnings=" + JSON.stringify(phase.warnings));
}

// TR6: a later Builder that ran no checks keeps the earlier passing run as the test evidence
{
  const { persistReport } = require("./lib/report");
  const { writeTaskJson, readTaskJson } = require("./lib/task");
  const dir = fs.mkdtempSync(path.join(tmpDir, "tr6-"));
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "main", reports: { explorer: null, committer: null,
    reviewer: { kind: "plan", verdict: "pass", issues: [], summary: "" },
    code_review: { kind: "code", verdict: "pass", issues: [], summary: "" },
    builder: { files_touched: [], verification: PASSING_TESTS, deviations: [], summary: "built" } } });
  writeTaskJson(dir, makeTask({ phases: [phase] }));
  persistReport({ taskDir: dir, phaseId: 1, agentType: "builder", report: { files_touched: [], verification: [], deviations: [], summary: "replied" } });
  const stored = readTaskJson(dir).phases[0];
  const r = checkTransition("committed", "landed", stored, makeTask({ phases: [stored] }), onBaseCtx);
  if (JSON.stringify(stored.reports.tests.verification) === JSON.stringify(PASSING_TESTS) && stored.reports.builder.summary === "replied" && r.ok) ok("TR6: a pre-existing passing run survives a Builder hand-back that ran no checks");
  else fail_("TR6: tests=" + JSON.stringify(stored.reports.tests) + " r=" + JSON.stringify(r));
}

// TR7: a red entry marked with the exit it was meant to give is evidence, and a run needs a green entry besides
{
  const { landingEvidence } = require("./lib/transitions");
  const withRun = (verification) => {
    const reports = evidenceReports({ builder: { files_touched: [], verification, deviations: [], summary: "" }, tests: { verification } });
    const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "main", reports });
    return landingEvidence(phase, makeTask({ phases: [phase] }));
  };
  const redFirst = withRun([{ cmd: "t", exit: 1, expected_exit: 1, summary: "red" }, { cmd: "t", exit: 0, summary: "green" }]);
  const unmarkedRed = withRun([{ cmd: "t", exit: 1, summary: "red" }]);
  const onlyRed = withRun([{ cmd: "t", exit: 1, expected_exit: 1, summary: "red" }]);
  if (redFirst.length === 0) ok("TR7: a red-first entry with its expected exit plus a green entry is test evidence");
  else fail_("TR7: red-first run should be evidence, missing " + JSON.stringify(redFirst));
  if (unmarkedRed.join() === "tests") ok("TR7: an exit 1 with no expected_exit still lacks tests");
  else fail_("TR7: unmarked red should name tests, got " + JSON.stringify(unmarkedRed));
  if (onlyRed.join() === "tests") ok("TR7: a run of only red-first entries lacks tests");
  else fail_("TR7: only-red run should name tests, got " + JSON.stringify(onlyRed));
}

// TR8: a fast task's in_progress phase moves to implemented on engine-written tests; other tasks and other writers still need a Builder report
{
  const engineTests = { verification: PASSING_TESTS, written_by: { agent: "engine" } };
  const phase = (tests) => makePhase({ status: "in_progress", reports: { explorer: null, builder: null, reviewer: null, committer: null, tests } });
  const fastOk = checkTransition("in_progress", "implemented", phase(engineTests), { mode: "fast", phases: [], knobs: {} }, {});
  const fullNo = checkTransition("in_progress", "implemented", phase(engineTests), { mode: "full", phases: [], knobs: {} }, {});
  const handNo = checkTransition("in_progress", "implemented", phase({ verification: PASSING_TESTS, written_by: { agent: "builder" } }), { mode: "fast", phases: [], knobs: {} }, {});
  if (fastOk.ok) ok("TR8: engine-written tests move a fast task's phase to implemented");
  else fail_("TR8: fast task with engine tests should pass, got " + JSON.stringify(fastOk));
  if (!fullNo.ok && !handNo.ok) ok("TR8: a full task, or tests not written by the engine, still need the Builder report");
  else fail_("TR8: guard too loose: " + JSON.stringify({ fullNo, handNo }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
