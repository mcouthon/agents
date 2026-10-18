#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkTransition, applyTransition, CAPS, LEGACY_STATUS_MAP, PHASE_STATUSES } = require("./lib/transitions");

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
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("implemented", "in_progress", phase, task, {});
  if (r.ok) ok("implemented → in_progress with needs_work, under fix cap");
  else fail_("implemented → in_progress should be ok: " + r.reason);
}

// implemented → in_progress (fix cap reached → guard fails)
{
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 2, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null } });
  const task = makeTask({ phases: [phase] });
  const r = checkTransition("implemented", "in_progress", phase, task, {});
  if (!r.ok && r.reason.includes("cap")) ok("implemented → in_progress rejected at fix_attempts cap");
  else fail_("implemented → in_progress should fail at cap");
}

// implemented → committed (commits + code review pass)
{
  const phase = makePhase({ status: "implemented", commits: ["abc123"], reports: { explorer: null, builder: null, reviewer: { verdict: "pass", issues: [], summary: "" }, committer: null } });
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
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "wt/1-test", landed_sha: "def456" });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (r.ok) ok("committed → landed with landed_sha as ancestor of base");
  else fail_("committed → landed should be ok: " + r.reason);
}

// committed → landed fails without landed_sha
{
  const phase = makePhase({ status: "committed", commits: ["abc123"], branch: "wt/1-test" });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => true, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok) ok("committed → landed rejected without landed_sha");
  else fail_("committed → landed should fail without landed_sha");
}

// committed → landed fails when landed_sha is not ancestor of base
{
  const phase = makePhase({ status: "committed", landed_sha: "def456", branch: "wt/1-test" });
  const task = makeTask({ phases: [phase] });
  const ctx = { gitFacts: { shaExists: () => true, isAncestor: () => false, base: "main" } };
  const r = checkTransition("committed", "landed", phase, task, ctx);
  if (!r.ok) ok("committed → landed rejected when landed_sha not ancestor");
  else fail_("committed → landed should fail when landed_sha not ancestor");
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
  const phase = makePhase({ status: "implemented", counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, reports: { explorer: null, builder: null, reviewer: { verdict: "needs_work", issues: [], summary: "" }, committer: null } });
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
    reports: { explorer: null, builder: null, reviewer: { verdict: "pass", issues: [], summary: "" }, committer: null },
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
