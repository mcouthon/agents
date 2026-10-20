#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { validateReport, persistReport } = require("./lib/report");
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-report-tasks-"));

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// --- Explorer report ---
{
  const r = validateReport("explorer", {
    plan_path: "plan/phase-1.md",
    manifest: ["src/a.js"],
    open_questions: [],
    summary: "A plan",
  });
  if (r.valid) ok("valid explorer report passes");
  else fail_("valid explorer report should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("explorer", {
    plan_path: "plan/phase-1.md",
    manifest: ["src/a.js"],
    summary: "A plan",
  });
  if (!r.valid && r.errors.some((e) => e.includes("open_questions"))) ok("explorer report missing open_questions fails");
  else fail_("explorer report without open_questions should fail");
}

{
  const r = validateReport("explorer", {
    plan_path: "plan/phase-1.md",
    manifest: ["src/a.js"],
    open_questions: [],
    summary: "A plan",
    extra_field: "bad",
  });
  if (!r.valid && r.errors.some((e) => e.includes("additional"))) ok("explorer report with extra field fails");
  else fail_("explorer report with extra field should fail");
}

// --- Reviewer report ---
{
  const r = validateReport("reviewer", {
    verdict: "pass",
    issues: [],
    summary: "Looks good",
  });
  if (r.valid) ok("valid reviewer report (pass) passes");
  else fail_("valid reviewer report should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("reviewer", {
    verdict: "pass_with_notes",
    issues: [{ severity: "yellow", file: "src/a.js", line: "10", text: "minor" }],
    summary: "Good with notes",
  });
  if (r.valid) ok("reviewer report with yellow issue and pass_with_notes passes");
  else fail_("reviewer report with pass_with_notes should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("reviewer", {
    verdict: "bad_verdict",
    issues: [],
    summary: "",
  });
  if (!r.valid && r.errors.some((e) => e.includes("verdict"))) ok("reviewer report with bad verdict fails");
  else fail_("reviewer report with bad verdict should fail");
}

{
  const r = validateReport("reviewer", {
    issues: [],
    summary: "",
  });
  if (!r.valid && r.errors.some((e) => e.includes("verdict"))) ok("reviewer report missing verdict fails");
  else fail_("reviewer report without verdict should fail");
}

{
  const r = validateReport("reviewer", {
    verdict: "pass",
    issues: [{ severity: "purple", file: "src/a.js", line: "1", text: "bad" }],
    summary: "",
  });
  if (!r.valid && r.errors.some((e) => e.includes("severity"))) ok("reviewer report with bad severity fails");
  else fail_("reviewer report with bad severity should fail");
}

// --- Builder report ---
{
  const r = validateReport("builder", {
    files_touched: ["src/a.js", "src/b.js"],
    verification: [{ cmd: "npm test", exit: 0, summary: "all pass" }],
    deviations: [],
    summary: "Done",
  });
  if (r.valid) ok("valid builder report passes");
  else fail_("valid builder report should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("builder", {
    files_touched: ["src/a.js"],
    verification: [{ cmd: "npm test", exit: 0, summary: "all pass" }],
    deviations: [],
  });
  if (!r.valid && r.errors.some((e) => e.includes("summary"))) ok("builder report missing summary fails");
  else fail_("builder report without summary should fail");
}

{
  const r = validateReport("builder", {
    files_touched: ["src/a.js"],
    verification: [{ cmd: "npm test", summary: "no exit" }],
    deviations: [],
    summary: "Done",
  });
  if (!r.valid && r.errors.some((e) => e.includes("exit"))) ok("builder report verification missing exit fails");
  else fail_("builder report verification without exit should fail");
}

// --- Committer report ---
{
  const r = validateReport("committer", {
    commits: [{ files: ["src/a.js"], message: "feat: add feature" }],
  });
  if (r.valid) ok("valid committer report passes");
  else fail_("valid committer report should pass: " + r.errors.join("; "));
}

// D34: committer report with optional sha field passes schema validation
{
  const r = validateReport("committer", {
    commits: [{ sha: "abc123", files: ["src/a.js"], message: "feat: add feature" }],
  });
  if (r.valid) ok("committer report with sha field passes");
  else fail_("committer report with sha should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("committer", {
    commits: [{ files: ["src/a.js"] }],
  });
  if (!r.valid && r.errors.some((e) => e.includes("message"))) ok("committer report missing message fails");
  else fail_("committer report without message should fail");
}

// --- persistReport: committer SHAs copied into phase.commits (D34) ---
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-test-"));
  const taskDir = path.join(tmpDir, "task");
  fs.mkdirSync(taskDir, { recursive: true });
  const task = {
    schema: 2, slug: "test", number: 1, title: "T", status: "in_progress",
    mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: "P1", status: "implemented", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "",
      reports: { explorer: null, builder: null, reviewer: null, committer: null },
      commits: [], branch: "", counters: {}, started: null, completed: null,
      landed_sha: null, warnings: [], conflict: null,
    }],
    worktree_path: "", checkpoints: [], flags: [], created: "", updated: "",
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2));

  // committer report with sha objects
  const r1 = persistReport({
    taskDir, phaseId: 1, agentType: "committer",
    report: { commits: [{ sha: "abc123", files: ["f.js"], message: "m" }] },
    ctx: { projectDir: tmpDir },
  });
  const after1 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (after1.phases[0].commits.length === 1 && after1.phases[0].commits[0] === "abc123")
    ok("persistReport copies committer report commits[].sha into phase.commits");
  else fail_("persistReport should copy sha: got " + JSON.stringify(after1.phases[0].commits));

  // committer report with string commits
  const r2 = persistReport({
    taskDir, phaseId: 1, agentType: "committer",
    report: { commits: [{ sha: "def456", files: ["g.js"], message: "n" }] },
    ctx: { projectDir: tmpDir },
  });
  const after2 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (after2.phases[0].commits.length === 1 && after2.phases[0].commits[0] === "def456")
    ok("persistReport overwrites phase.commits with new committer report shas");
  else fail_("persistReport should overwrite: got " + JSON.stringify(after2.phases[0].commits));

  // committer report without sha → phase.commits unchanged
  const r3 = persistReport({
    taskDir, phaseId: 1, agentType: "committer",
    report: { commits: [{ files: ["h.js"], message: "no sha" }] },
    ctx: { projectDir: tmpDir },
  });
  const after3 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (after3.phases[0].commits.length === 1 && after3.phases[0].commits[0] === "def456")
    ok("persistReport leaves phase.commits unchanged when committer report has no shas");
  else fail_("persistReport should not clear commits: got " + JSON.stringify(after3.phases[0].commits));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Unknown agent type ---
{
  const r = validateReport("unknown_agent", {});
  if (!r.valid && r.errors.some((e) => e.includes("unknown"))) ok("unknown agent type fails");
  else fail_("unknown agent type should fail");
}

// --- Open questions with options ---
{
  const r = validateReport("explorer", {
    plan_path: "plan/phase-1.md",
    manifest: [],
    open_questions: [{ question: "Which?", options: ["A", "B"] }],
    summary: "",
  });
  if (r.valid) ok("explorer report with open_questions options passes");
  else fail_("explorer report with open_questions options should pass: " + r.errors.join("; "));
}

// --- Consolidator report schema (D36) ---
{
  const r = validateReport("consolidator", {
    distilled_to: ["docs/adr-013.md", "README.md"],
    proposals: ["Update instruction X", "Add convention Y"],
  });
  if (r.valid) ok("consolidator report with distilled_to + proposals passes");
  else fail_("consolidator report should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("consolidator", {
    distilled_to: [],
    proposals: [],
  });
  if (r.valid) ok("consolidator report with empty arrays passes");
  else fail_("consolidator report with empty arrays should pass: " + r.errors.join("; "));
}

{
  const r = validateReport("consolidator", {
    proposals: ["change X"],
  });
  if (!r.valid && r.errors.some((e) => e.includes("distilled_to"))) ok("consolidator report missing distilled_to fails");
  else fail_("consolidator report without distilled_to should fail");
}

{
  const r = validateReport("consolidator", {
    distilled_to: ["docs/x.md"],
    proposals: [],
    extra_field: true,
  });
  if (!r.valid && r.errors.some((e) => e.includes("extra_field"))) ok("consolidator report rejects additional properties");
  else fail_("consolidator report should reject additional properties: " + r.errors.join("; "));
}

// --- persistReport: consolidator report stored in phase.reports.consolidator ---
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-consolidator-"));
  const taskDir = path.join(tmpDir, "task");
  fs.mkdirSync(taskDir, { recursive: true });
  const task = {
    schema: 2, slug: "cons", number: 1, title: "C", status: "in_progress",
    mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: "P1", status: "landed", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "", manifest: [], note: "",
      reports: { explorer: null, builder: null, reviewer: null, committer: null, consolidator: null },
      commits: [], branch: "", counters: {}, started: null, completed: null,
      landed_sha: null, warnings: [], conflict: null,
    }],
    worktree_path: "", checkpoints: [], flags: [], created: "", updated: "",
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2));

  const r = persistReport({
    taskDir, phaseId: 1, agentType: "consolidator",
    report: { distilled_to: ["docs/adr-012.md"], proposals: ["Add tier lifecycle docs"] },
    ctx: { projectDir: tmpDir },
  });
  if (r.stored) ok("persistReport stores consolidator report");
  else fail_("persistReport should store consolidator report");

  const after = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  if (after.phases[0].reports.consolidator &&
      after.phases[0].reports.consolidator.distilled_to.length === 1 &&
      after.phases[0].reports.consolidator.distilled_to[0] === "docs/adr-012.md")
    ok("consolidator report persisted with distilled_to");
  else fail_("consolidator report not persisted correctly: " + JSON.stringify(after.phases[0].reports.consolidator));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
