#!/usr/bin/env node
"use strict";

const { validateReport } = require("./lib/report");

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

{
  const r = validateReport("committer", {
    commits: [{ files: ["src/a.js"] }],
  });
  if (!r.valid && r.errors.some((e) => e.includes("message"))) ok("committer report missing message fails");
  else fail_("committer report without message should fail");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
