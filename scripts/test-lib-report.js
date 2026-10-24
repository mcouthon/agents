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
    extra_field: "kept",
  });
  if (r.valid && r.normalised.extra_field === "kept") ok("X1: an explorer report with an extra field validates and keeps the field");
  else fail_("X1: an explorer report with an extra field should validate and keep it: " + r.errors.join("; "));
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
  if (r.valid && r.normalised.extra_field === true) ok("X2: a consolidator report with an extra field validates");
  else fail_("X2: a consolidator report with an extra field should validate: " + r.errors.join("; "));
}

// --- One vocabulary: synonyms map onto the schema words; the schema still judges ---
const vocab = (verdict, issue) => validateReport("reviewer", { verdict, issues: issue ? [{ severity: "red", file: "a.js", line: null, text: "t", ...issue }] : [], summary: "s" });
const files = (files_touched) => validateReport("builder", { files_touched, verification: [], deviations: [], summary: "s" });

{
  const cases = [
    ["Pass", "pass"], ["Pass With Notes", "pass_with_notes"], ["pass-with-notes", "pass_with_notes"], ["PASS_WITH_NOTES", "pass_with_notes"],
    ["needs work", "needs_work"], ["Needs Work", "needs_work"], ["NEEDS_WORK", "needs_work"], ["needs-work", "needs_work"],
    ["FAIL", "fail"], ["Fail", "fail"], ["approved", "pass"],
  ];
  for (const [given, stored] of cases) {
    const r = vocab(given);
    if (r.valid && r.normalised.verdict === stored) ok(`X3: verdict ${JSON.stringify(given)} is stored as ${stored}`);
    else fail_(`X3: verdict ${JSON.stringify(given)} should be stored as ${stored}, got ${r.normalised.verdict} (${r.errors.join("; ")})`);
  }
}

{
  const cases = [["Red", "red"], ["RED", "red"], ["Yellow", "yellow"], ["WARNING", "yellow"], ["Warning", "yellow"], ["Blocking", "red"], ["HIGH", "red"], ["low", "yellow"]];
  for (const [given, stored] of cases) {
    const r = vocab("pass", { severity: given });
    if (r.valid && r.normalised.issues[0].severity === stored) ok(`X4: severity ${JSON.stringify(given)} is stored as ${stored}`);
    else fail_(`X4: severity ${JSON.stringify(given)} should be stored as ${stored} (${r.errors.join("; ")})`);
  }
}

{
  const cases = [
    ["BLOCKING — the step names no file", "needs_work"], ["BLOCKING - the step names no file", "needs_work"],
    ["BLOCKING: the step names no file", "needs_work"], ["APPROVED: minor notes", "pass"],
    ["APPROVED WITH SUGGESTIONS — rename the helper", "pass_with_notes"],
  ];
  for (const [given, stored] of cases) {
    const r = vocab(given);
    if (r.valid && r.normalised.verdict === stored) ok(`X5: verdict ${JSON.stringify(given)} is stored as ${stored}`);
    else fail_(`X5: verdict ${JSON.stringify(given)} should be stored as ${stored} (${r.errors.join("; ")})`);
  }
  const sev = vocab("pass", { severity: "Medium - naming" });
  if (sev.valid && sev.normalised.issues[0].severity === "yellow") ok("X5: severity \"Medium - naming\" is stored as yellow");
  else fail_("X5: severity \"Medium - naming\" should be stored as yellow: " + sev.errors.join("; "));
  const maybe = vocab("maybe");
  if (!maybe.valid && maybe.normalised.verdict === "maybe") ok("X5: a verdict that reduces to no known word is left as sent and refused");
  else fail_("X5: verdict \"maybe\" should stay as sent and be refused");
}

{
  const grouped = files({ modified: ["a.js"], added: ["b.js"] });
  if (grouped.valid && JSON.stringify(grouped.normalised.files_touched) === '["a.js","b.js"]') ok("X6: grouped files_touched become one flat list in key order");
  else fail_("X6: grouped files_touched should flatten to [a.js, b.js]: " + grouped.errors.join("; "));
  const deduped = files({ modified: ["a.js"], deleted: ["b.js", "a.js"] });
  if (deduped.valid && JSON.stringify(deduped.normalised.files_touched) === '["a.js","b.js"]') ok("X6: a path in two groups is listed once");
  else fail_("X6: duplicates across groups should be dropped");
  for (const [label, bad] of [["a string value", { modified: "a.js" }], ["a non-string entry", { modified: ["a.js", 3] }], ["an empty object", {}]]) {
    const r = files(bad);
    if (!r.valid && r.errors.includes("root.files_touched: expected array, got object")) ok(`X6: files_touched with ${label} is refused`);
    else fail_(`X6: files_touched with ${label} should be refused as an object: ${r.errors.join("; ")}`);
  }
}

{
  const num = vocab("pass", { line: 42 });
  if (num.valid && num.normalised.issues[0].line === "42") ok("X7: a numeric issue line is stored as a string");
  else fail_("X7: line 42 should be stored as \"42\": " + num.errors.join("; "));
  const str = vocab("pass", { line: "7" });
  const nul = vocab("pass", { line: null });
  if (str.valid && str.normalised.issues[0].line === "7" && nul.valid && nul.normalised.issues[0].line === null) ok("X7: a string line and a null line are unchanged");
  else fail_("X7: string and null lines should be unchanged");
}

{
  const strings = validateReport("committer", { commits: ["abc1234", "def5678"] });
  if (strings.valid && strings.normalised.commits[0].sha === "abc1234" && strings.normalised.commits[1].sha === "def5678" && Array.isArray(strings.normalised.commits[0].files)) ok("X8: commit SHA strings become commit objects carrying the sha");
  else fail_("X8: SHA strings should become objects: " + strings.errors.join("; "));
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

// --- D55: failing plan review is stored and counted, phase stays planned; revision clears it ---
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-d55-"));
  const taskDir = path.join(tmpDir, "task");
  fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(taskDir, "plan", "phase-1.md"), "# plan");
  const task = {
    schema: 2, slug: "d55", number: 1, title: "D55", status: "in_progress", mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: "P1", status: "planned", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "plan/phase-1.md", manifest: [], note: "",
      reports: { explorer: { plan_path: "plan/phase-1.md", manifest: [], open_questions: [], summary: "v1" }, builder: null, reviewer: null, committer: null },
      commits: [], branch: "", counters: {}, started: null, completed: null,
      landed_sha: null, warnings: [], conflict: null,
    }],
    checkpoints: [], flags: [], created: "", updated: "",
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2));
  let r;
  try {
    r = persistReport({ taskDir, phaseId: 1, agentType: "reviewer",
      report: { verdict: "fail", issues: [{ severity: "blocking", description: "x" }], summary: "blocking" } });
  } catch (e) { r = { error: e.message }; }
  const after = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0];
  if (!r.error && after.status === "planned" && after.reports.reviewer && after.reports.reviewer.verdict === "fail" && after.counters.review_passes === 1)
    ok("D55: failing plan review persisted, counted, phase stays planned");
  else fail_(`D55 persist: ${JSON.stringify({ err: r.error, status: after.status, rev: after.reports.reviewer, c: after.counters })}`);
  persistReport({ taskDir, phaseId: 1, agentType: "reviewer",
    report: { verdict: "fail", issues: [], summary: "same verdict again" } });
  const again = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0];
  if (again.counters.review_passes === 1) ok("D55: re-persisting a failing verdict does not burn the cap");
  else fail_(`D55 idempotent: review_passes=${again.counters.review_passes}`);
  const r2 = persistReport({ taskDir, phaseId: 1, agentType: "explorer",
    report: { plan_path: "plan/phase-1.md", manifest: ["a.js"], open_questions: [], summary: "v2" } });
  const after2 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0];
  if (r2.stored && after2.status === "planned" && after2.reports.reviewer === null && after2.reports.explorer.summary === "v2")
    ok("D55: revised plan clears the stale review verdict");
  else fail_(`D55 revise: ${JSON.stringify({ status: after2.status, rev: after2.reports.reviewer })}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- F8: written_by attribution ---
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-f8-"));
  const taskDir = path.join(tmpDir, "task");
  fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(taskDir, "plan", "phase-1.md"), "# plan");
  const task = {
    schema: 2, slug: "f8", number: 1, title: "F8", status: "in_progress", mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    binding: {}, lease: { session_id: "bound-sid" }, last_writer: {},
    phases: [{
      id: 1, name: "P1", status: "planned", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "plan/phase-1.md", manifest: [], note: "",
      reports: { explorer: { plan_path: "plan/phase-1.md", manifest: [], open_questions: [], summary: "v1" }, builder: null, reviewer: null, committer: null },
      commits: [], branch: "", counters: {}, started: null, completed: null,
      landed_sha: null, warnings: [], conflict: null,
    }],
    checkpoints: [], flags: [], created: "", updated: "",
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2));

  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    // F8a: written_by is recorded on the stored report
    process.env.CLAUDE_CODE_SESSION_ID = "bound-sid";
    persistReport({
      taskDir, phaseId: 1, agentType: "reviewer",
      report: { verdict: "pass", issues: [], summary: "ok" },
      ctx: { projectDir: tmpDir },
    });
    const after1 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
    const rev = after1.phases[0].reports.reviewer;
    if (rev && rev.written_by && rev.written_by.session_id === "bound-sid" && rev.written_by.agent === "reviewer")
      ok("F8: persistReport records written_by with session_id and agent");
    else
      fail_("F8: written_by not recorded: " + JSON.stringify(rev && rev.written_by));

    // F8d: a verdict from a session other than the one named in the task's lease is stored
    process.env.CLAUDE_CODE_SESSION_ID = "foreign-sid";
    const task2 = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
    task2.phases[0].status = "planned";
    task2.phases[0].reports.reviewer = null;
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task2, null, 2));
    let foreign;
    try {
      foreign = persistReport({
        taskDir, phaseId: 1, agentType: "reviewer",
        report: { verdict: "pass", issues: [], summary: "foreign" },
        ctx: { projectDir: tmpDir },
      });
    } catch (e) {
      foreign = { error: e.message };
    }
    const stored = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0].reports.reviewer;
    if (foreign.stored && stored && stored.written_by.session_id === "foreign-sid" && stored.summary === "foreign")
      ok("F8d: a verdict from a session other than the leased one is stored, attributed to its writer");
    else
      fail_("F8d: the foreign verdict should be stored: " + JSON.stringify(foreign));
  } finally {
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- F9: schema aliases (blocking→red, warning→yellow, description→text, summary optional) ---
{
  const r = validateReport("reviewer", {
    verdict: "needs_work",
    issues: [{ severity: "blocking", file: "src/a.js", line: "10", description: "bad code" }],
    summary: "needs work",
  });
  if (r.valid && r.normalised.issues[0].severity === "red" && r.normalised.issues[0].text === "bad code" && !r.normalised.issues[0].description)
    ok("F9: blocking→red, description→text normalised");
  else
    fail_("F9: alias normalisation failed: " + JSON.stringify(r.normalised));
}
{
  const r = validateReport("reviewer", {
    verdict: "pass",
    issues: [{ severity: "warning", file: "src/b.js", line: "5", description: "minor" }],
    summary: "ok",
  });
  if (r.valid && r.normalised.issues[0].severity === "yellow")
    ok("F9: warning→yellow normalised");
  else
    fail_("F9: warning alias failed: " + JSON.stringify(r.normalised));
}
{
  const r = validateReport("reviewer", {
    verdict: "fail",
    issues: [],
  });
  if (r.valid && r.normalised.summary === "")
    ok("F9: reviewer report with verdict but no summary defaults to empty string");
  else
    fail_("F9: summary default failed: valid=" + r.valid + ", summary=" + JSON.stringify(r.normalised.summary));
}

// --- phase_id: optional, 0 and missing mean "not stated" ---
const explorerBody = { plan_path: "plan/phase-9.md", manifest: ["a.js"], open_questions: [], summary: "plan" };
{
  const stated = validateReport("explorer", { ...explorerBody, phase_id: 9 });
  const zero = validateReport("explorer", { ...explorerBody, phase_id: 0 });
  const absent = validateReport("explorer", explorerBody);
  if (stated.valid && zero.valid && absent.valid) ok("P1: phase_id 9, phase_id 0 and no phase_id all validate");
  else fail_("P1: phase_id forms should validate: " + JSON.stringify([stated.errors, zero.errors, absent.errors]));
  const text = validateReport("explorer", { ...explorerBody, phase_id: "9" });
  if (!text.valid && text.errors.includes("root.phase_id: expected integer, got string")) ok("P1: a string phase_id is rejected as not an integer");
  else fail_("P1: string phase_id should fail with the integer error: " + JSON.stringify(text.errors));
}

function makeTask() {
  const dir = fs.mkdtempSync(path.join(process.env.AGENTS_TASKS_ROOT, "p2-"));
  const phase = (id) => ({ id, name: `P${id}`, status: "not_started", blocked_by: [], manifest: [], reports: {}, counters: {} });
  const task = {
    schema: 2, slug: "acme-task", number: 999, title: "Acme", status: "in_progress", mode: "full",
    knobs: {}, binding: {}, lease: {}, last_writer: {}, phases: [phase(5), phase(9)],
    checkpoints: [], flags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task, null, 2));
  fs.mkdirSync(path.join(dir, "plan"));
  fs.writeFileSync(path.join(dir, "plan", "phase-9.md"), "# plan\n");
  return dir;
}
const phaseOf = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")).phases.find((p) => p.id === id);
{
  const { submitReport } = require("./lib/report");
  const dir = makeTask();
  const clash = submitReport({ taskDir: dir, phaseId: 5, agentType: "explorer", report: { ...explorerBody, phase_id: 9 } });
  const untouched = phaseOf(dir, 5).status === "not_started" && phaseOf(dir, 9).status === "not_started";
  if (!clash.valid && clash.errors[0] === "phase_id 9 in the report does not match phase 5" && untouched) ok("P2: a stated phase_id that differs from the target phase stores nothing");
  else fail_("P2: mismatch should be refused and store nothing: " + JSON.stringify(clash));

  const zero = submitReport({ taskDir: dir, phaseId: 5, agentType: "explorer", report: { ...explorerBody, phase_id: 0 } });
  const none = submitReport({ taskDir: dir, phaseId: 9, agentType: "explorer", report: explorerBody });
  if (zero.valid && none.valid && phaseOf(dir, 5).status === "planned" && phaseOf(dir, 9).status === "planned") ok("P2: phase_id 0 and a missing phase_id store on the phase they are sent to");
  else fail_("P2: unstated phase_id should store normally: " + JSON.stringify([zero, none]));

  const match = submitReport({ taskDir: makeTask(), phaseId: 9, agentType: "explorer", report: { ...explorerBody, phase_id: 9 } });
  if (match.valid) ok("P2: a stated phase_id equal to the target phase is accepted");
  else fail_("P2: matching phase_id should be accepted: " + JSON.stringify(match));
}

// --- skeletons carry no numeric phase_id placeholder ---
{
  const { renderSkeleton, renderSkeletonNotes } = require("./lib/report");
  const skeleton = JSON.parse(renderSkeleton("explorer"));
  const notes = renderSkeletonNotes("builder");
  if (!("phase_id" in skeleton)) ok("P3: the explorer skeleton has no phase_id key to copy");
  else fail_("P3: skeleton must not carry phase_id");
  if (notes.length === 5 && notes[0].includes("phase_id")) ok("P3: builder notes lead with the phase_id note");
  else fail_("P3: builder notes should be 5 with phase_id first: " + JSON.stringify(notes));
}

// --- generated agents ask for phase_id and no longer describe the old hooks ---
{
  const agentsDir = path.join(__dirname, "..", "generated", "claude", "agents");
  const text = (n) => fs.readFileSync(path.join(agentsDir, `${n}.md`), "utf8");
  for (const name of ["explorer", "builder", "reviewer", "committer"]) {
    const t = text(name);
    if (t.includes("`phase_id`") && !t.includes("SubagentStop hook validates")) ok(`P4: ${name}.md asks for phase_id and drops the SubagentStop claim`);
    else fail_(`P4: ${name}.md should ask for phase_id and not claim a SubagentStop validator`);
  }
  if (!text("courier").includes("courier-stop")) ok("P4: courier.md no longer mentions the courier-stop hook anywhere");
  else fail_("P4: courier.md still mentions courier-stop");
  const conductor = text("conductor");
  const asks = conductor.split("Phase id: <N>").length - 1;
  if (asks === 1) ok("P5: conductor.md tells the Conductor to pass `Phase id: <N>` once");
  else fail_(`P5: conductor.md should hold the phase id instruction once, found ${asks}`);
  const literal = fs.readdirSync(agentsDir).filter((f) => /"phase_id": [01]\b/.test(fs.readFileSync(path.join(agentsDir, f), "utf8")));
  if (literal.length === 0) ok("P5: no generated agent file carries a literal phase_id 0 or 1");
  else fail_("P5: literal phase_id placeholder in " + literal.join(", "));
}

// --- the Conductor, Courier and phase-review templates follow the engine and carry the report blocks ---
{
  const { renderSkeleton, renderSkeletonNotes } = require("./lib/report");
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "generated", "claude", ...p), "utf8");
  const collapse = (s) => s.replace(/\s+/g, " ");
  const count = (hay, needle) => hay.split(needle).length - 1;
  const conductorRaw = read("agents", "conductor.md");
  const conductor = collapse(conductorRaw);

  const drifted = ["explorer", "reviewer", "builder", "committer"].filter((n) => {
    const skeleton = "```json\n" + renderSkeleton(n) + "\n```";
    return !conductorRaw.includes(skeleton) || !conductorRaw.includes(renderSkeletonNotes(n).join("\n"));
  });
  if (drifted.length === 0) ok("P6a: conductor.md carries every agent's current report skeleton and notes");
  else fail_("P6a: conductor.md report blocks drifted from the schemas for " + drifted.join(", "));

  const stale = [
    "[Adopt Suggestions]", "[Reject Suggestions]", "[Re-present Plan]",
    'phase_status: "planned"', 'phase_status: "reviewed"', 'phase_status: "done"',
    "`a state update`/`a report`", "Sync existing phase statuses", "Recon (not a review)",
    "Run git status --porcelain", '"✅ Done" via a lightweight', 'Explorer for "✅ Done"',
    "will be committed together with code and docs in step 2f", "task.md is authoritative",
  ].filter((s) => conductor.includes(s));
  if (stale.length === 0) ok("P6b: conductor.md no longer teaches the retired options, status writes and housekeeping spawns");
  else fail_("P6b: conductor.md still carries " + JSON.stringify(stale));
  const asks = count(conductor, "Then call `AskUserQuestion` with these options");
  if (asks === 1) ok("P6b: AskUserQuestion with listed options is asked once, at plan approval");
  else fail_(`P6b: expected one AskUserQuestion-with-options instruction, found ${asks}`);

  const options = conductor.includes("- `approve` — ") && conductor.includes("- `reject` — ");
  const reviewerSpawn = conductor.includes('Task(Reviewer, "Phase id: N. Use phase-review mode') && !conductor.includes('Task(Explorer, "Use phase-review mode');
  if (options && reviewerSpawn) ok("P6c: plan approval offers approve/reject and the plan review is a Reviewer spawn");
  else fail_(`P6c: plan approval options present=${options}, Reviewer plan-review spawn present=${reviewerSpawn}`);

  const courier = read("agents", "courier.md");
  const courierBad = ["--report-json", "`a state update`/`a report`", "a report --"].filter((s) => courier.includes(s));
  if (courier.includes("No heredocs anywhere") && courier.includes("run no `a report`") && courierBad.length === 0) ok("P6d: courier.md records no state and forbids heredocs");
  else fail_("P6d: courier.md should forbid heredocs and `a report`; stale text: " + JSON.stringify(courierBad));

  if (read("skills", "phase-review", "SKILL.md").includes("`pass_with_notes` for APPROVED WITH SUGGESTIONS")) ok("P6e: phase-review maps its verdicts onto the report words");
  else fail_("P6e: phase-review SKILL.md lacks the verdict mapping for the JSON report");

  const phaseIdAsks = count(conductorRaw, "Phase id: <N>");
  if (phaseIdAsks === 1) ok("P6f: conductor.md still states the `Phase id: <N>` rule once");
  else fail_(`P6f: expected the phase id rule once, found ${phaseIdAsks}`);

  const carveOut = "Temporary, remove when `a next` asks for the code review after every build: after every Builder hand-back, spawn the code Reviewer (2c.1)";
  const carveOuts = count(conductor, carveOut);
  if (carveOuts === 1) ok("P6g: the temporary mandatory code review line is present once, with its decided wording");
  else fail_(`P6g: expected the temporary review line once, found ${carveOuts}`);

  const spawns = conductorRaw.split(/Task\((?:Explorer|Builder|Reviewer|Committer), "/).slice(1).map((chunk) => chunk.split('")')[0]).filter((b) => !b.startsWith("[2c prompt for Phase"));
  const unreporting = spawns.filter((b) => !b.startsWith("Phase id: ") || !b.includes("report block from Report blocks"));
  if (spawns.length === 15 && unreporting.length === 0) ok("P6h: all 15 subagent spawns name their phase and end with their report block");
  else fail_(`P6h: ${spawns.length} spawns checked (want 15); without phase id or report block: ` + JSON.stringify(unreporting.map((b) => b.slice(0, 60))));

  const fresh = count(conductor, "after every subagent hand-back, every user answer and every owner prompt, call `state_prime`");
  if (fresh === 1) ok("P6i: the Conductor refreshes its position with state_prime after hand-backs, answers and owner prompts");
  else fail_(`P6i: expected the state_prime refresh rule once, found ${fresh}`);

  const consolidation = count(conductor, "Run it once; `a next` keeps saying `consolidate` until the task is closed");
  const consolidateSpawn = spawns.filter((b) => b.includes("Use consolidate-task mode") && b.startsWith("Phase id: "));
  if (consolidation === 1 && consolidateSpawn.length === 1) ok("P6j: consolidation runs once, last, and its spawn names a phase");
  else fail_(`P6j: consolidation rule count ${consolidation}, consolidation spawns with a phase id ${consolidateSpawn.length}`);

  const guidance = count(conductor, "**Committer** — for committing, pushing and the PR, and for Step 3's PR recon");
  if (guidance === 1 && conductor.includes("routes recon to Explorer") && conductor.includes("Need to verify an implementation")) ok("P6k: selection guidance sends Step 3's PR recon to the Committer");
  else fail_(`P6k: Committer guidance count ${guidance}; Reviewer and Explorer routing sentences must survive`);

  const openQuestions = count(conductor, "When `Reason:` says the phase has open questions from the Explorer: ask them in plain text");
  if (openQuestions === 1) ok("P6l: open Explorer questions are asked in plain text at the blocked step");
  else fail_(`P6l: expected the plain-text open-questions rule once, found ${openQuestions}`);

  const stops = count(conductor, "do NOT loop: `a next` stays `blocked` on them. Stop, tell the user in plain text that the questions remain open, and end your turn");
  if (stops === 1) ok("P6m: questions that survive the finalize Explorer end the turn instead of waiting on a block that never lifts");
  else fail_(`P6m: expected the stop-and-report rule once, found ${stops}`);

  const fixSpawns = count(conductor, "carrying the 2c prompt's `Phase id: N` and builder report block");
  if (fixSpawns === 2) ok("P6n: the auto-fix and Fix Issues Builder re-invokes carry the phase id and builder report block");
  else fail_(`P6n: expected 2 Builder re-invokes carrying the phase id and report block, found ${fixSpawns}`);

  const notApplied = count(conductor, "The temporary review line under Follow `a next` does not apply");
  if (notApplied === 2) ok("P6o: consolidation and Step 3 Builders say the temporary review line does not apply to them");
  else fail_(`P6o: expected 2 statements that the temporary review line does not apply, found ${notApplied}`);
}

// --- extraction of the report block from a final message ---
{
  const { extractJsonCandidates } = require("./lib/report");
  const message = 'Done.\n```json\n{\n  "a": 1, // note\n  "b": [2,],\n}\n```\nThen\n```json\n{"c": 3}\n```\n';
  const found = extractJsonCandidates(message);
  if (found.length === 2 && JSON.stringify(found[0].report) === '{"a":1,"b":[2]}' && found[1].report.c === 3) ok("E1: every fenced block is a candidate, comments and trailing commas stripped");
  else fail_("E1: expected two cleaned candidates: " + JSON.stringify(found));
  const bare = extractJsonCandidates('All done {"x": "}"}');
  if (bare.length === 1 && bare[0].report.x === "}") ok("E1: a bare trailing object is found when no fence exists");
  else fail_("E1: bare object not found: " + JSON.stringify(bare));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
