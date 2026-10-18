#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { renderStateMd } = require("./lib/render");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agents-render-test-"));

// --- Test 1: basic state.md rendering ---
{
  const dir = path.join(tmpBase, "001-basic");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test-task", number: 42, title: "Test Task",
    status: "in_progress", mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    phases: [
      { id: 1, name: "Plan", status: "done", owner: "explorer", blocked_by: [], parallel_group: "", note: "", reports: {}, commits: [], counters: { review_passes: 0, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 }, started: "2026-01-01", completed: "2026-01-02" },
      { id: 2, name: "Build", status: "in_progress", owner: "builder", blocked_by: [1], parallel_group: "", note: "wip", reports: {}, commits: [], counters: { review_passes: 0, fix_attempts: 1, autofix_ran: true, ci_attempts: 0, clarify_rounds: 0 }, started: "2026-01-03", completed: "" },
    ],
    checkpoints: [],
    flags: [{ id: "f1", phase: 2, type: "error", message: "test error", raised: "2026-01-03" }],
    binding: { session_id: "sess-1" },
    lease: { session_id: "sess-1", acquired_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z" },
    last_writer: { session_id: "sess-1", timestamp: "2026-01-03T00:00:00Z" },
    created: "2026-01-01",
    updated: "2026-01-03T00:00:00Z",
  };

  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");

  if (md.includes("title: Test Task")) ok("state.md has title in frontmatter");
  else fail_("state.md should have title");
  if (md.includes("slug: test-task")) ok("state.md has slug in frontmatter");
  else fail_("state.md should have slug");
  if (md.includes("number: 42")) ok("state.md has number in frontmatter");
  else fail_("state.md should have number");
  if (md.includes("status: in_progress")) ok("state.md has status in frontmatter");
  else fail_("state.md should have status");
  if (md.includes("## Phases")) ok("state.md has Phases section");
  else fail_("state.md should have Phases section");
  if (md.includes("| Plan | done |")) ok("state.md shows phase status in table");
  else fail_("state.md should show phase status");
  if (md.includes("| Build | in_progress |")) ok("state.md shows in_progress phase");
  else fail_("state.md should show in_progress phase");
}

// --- Test 2: open checkpoints rendered ---
{
  const dir = path.join(tmpBase, "002-checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: {}, phases: [{ id: 1, name: "P", status: "reviewed", owner: null, blocked_by: [], parallel_group: "", note: "", reports: {}, commits: [], counters: {}, started: "", completed: "" }],
    checkpoints: [
      { id: "c1", phase: 1, type: "approve_plan", question: "Approve?", options: ["approve", "reject"], chosen: null, opened_at: "2026-01-01", resolved_at: null },
    ],
    flags: [], binding: {}, lease: {}, last_writer: {}, created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (md.includes("## Open Checkpoints")) ok("state.md has Open Checkpoints section");
  else fail_("state.md should have Open Checkpoints section");
  if (md.includes("approve_plan")) ok("state.md shows checkpoint type");
  else fail_("state.md should show checkpoint type");
  if (md.includes("Approve?")) ok("state.md shows checkpoint question");
  else fail_("state.md should show checkpoint question");
}

// --- Test 3: flags rendered ---
{
  const dir = path.join(tmpBase, "003-flags");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: {}, phases: [],
    checkpoints: [],
    flags: [
      { id: "f1", phase: 1, type: "needs_human", message: "land conflict", raised: "2026-01-01" },
      { id: "f2", phase: 2, type: "error", message: "build failed", raised: "2026-01-02" },
    ],
    binding: {}, lease: {}, last_writer: {}, created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (md.includes("## Flags")) ok("state.md has Flags section");
  else fail_("state.md should have Flags section");
  if (md.includes("needs_human")) ok("state.md shows needs_human flag");
  else fail_("state.md should show needs_human flag");
  if (md.includes("land conflict")) ok("state.md shows flag message");
  else fail_("state.md should show flag message");
}

// --- Test 4: counters rendered (non-zero only) ---
{
  const dir = path.join(tmpBase, "004-counters");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: {}, phases: [
      { id: 1, name: "P", status: "implemented", owner: null, blocked_by: [], parallel_group: "", note: "", reports: {}, commits: [], counters: { review_passes: 1, fix_attempts: 2, autofix_ran: true, ci_attempts: 3, clarify_rounds: 0 }, started: "", completed: "" },
    ],
    checkpoints: [], flags: [], binding: {}, lease: {}, last_writer: {}, created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (md.includes("## Counters")) ok("state.md has Counters section");
  else fail_("state.md should have Counters section");
  if (md.includes("fix_attempts") && md.includes("2")) ok("state.md shows fix_attempts counter");
  else fail_("state.md should show fix_attempts counter");
}

// --- Test 5: lease/binding rendered ---
{
  const dir = path.join(tmpBase, "005-lease");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: {}, phases: [], checkpoints: [], flags: [],
    binding: { session_id: "s1", workflow_id: "w1", terminal_id: "t1" },
    lease: { session_id: "s1", acquired_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z" },
    last_writer: { session_id: "s1", timestamp: "2026-01-01T00:30:00Z" },
    created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (md.includes("## Binding")) ok("state.md has Binding section");
  else fail_("state.md should have Binding section");
  if (md.includes("## Lease")) ok("state.md has Lease section");
  else fail_("state.md should have Lease section");
  if (md.includes("Last written by s1")) ok("state.md shows last_writer");
  else fail_("state.md should show last_writer");
}

// --- Test 6: warnings rendered (D32) ---
{
  const dir = path.join(tmpBase, "006-warnings");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: { enforcement: "warn" }, phases: [
      { id: 5, name: "Enforcement", status: "reviewed", owner: null, blocked_by: [], parallel_group: "", note: "", reports: {}, commits: [], counters: {}, started: "", completed: "",
        warnings: [
          { guard: "reviewer_verdict_pass", reason: "reviewer report not found", at: "2026-10-17T12:00:00Z", session_id: "sess-abc" },
          { guard: "code_review_pass", reason: "code reviewer report not found", at: "2026-10-17T13:00:00Z", session_id: "sess-abc" },
        ],
      },
    ],
    checkpoints: [], flags: [], binding: {}, lease: {}, last_writer: {}, created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (md.includes("## Warnings")) ok("state.md has Warnings section");
  else fail_("state.md should have Warnings section");
  if (md.includes("reviewer_verdict_pass")) ok("state.md shows guard name in warning");
  else fail_("state.md should show guard name");
  if (md.includes("reviewer report not found")) ok("state.md shows warning reason");
  else fail_("state.md should show warning reason");
  if (md.includes("sess-abc")) ok("state.md shows session_id in warning");
  else fail_("state.md should show session_id");
  if (md.includes("code_review_pass")) ok("state.md shows second warning");
  else fail_("state.md should show second warning");
}

// --- Test 7: no warnings section when phase has no warnings ---
{
  const dir = path.join(tmpBase, "007-no-warnings");
  fs.mkdirSync(dir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress", mode: "full",
    knobs: {}, phases: [{ id: 1, name: "P", status: "planned", owner: null, blocked_by: [], parallel_group: "", note: "", reports: {}, commits: [], counters: {}, started: "", completed: "" }],
    checkpoints: [], flags: [], binding: {}, lease: {}, last_writer: {}, created: "", updated: "",
  };
  renderStateMd(dir, task, "/tmp");
  const md = fs.readFileSync(path.join(dir, "state.md"), "utf8");
  if (!md.includes("## Warnings")) ok("state.md omits Warnings section when no warnings");
  else fail_("state.md should not have Warnings section when no warnings");
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
