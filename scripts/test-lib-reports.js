"use strict";

// Isolation: nothing here may touch the real HOME, config, git config or live PAV.
(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-iso-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_HOOKS_FLAG: path.join(t, "no-flag"),
    AGENTS_DB: path.join(t, "agents.db"),
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "A", "AGENTS_HOOKS_OFF"]) delete process.env[k];
})();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { extractJsonReport, extractJsonCandidates, validateReport, renderSkeleton, renderSkeletonNotes } = require("./lib/report");
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

function makeTempTask(phases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-report-test-"));
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

console.log("report, flag, knob and skeleton tests\n");

// ---------------------------------------------------------------------------
// Report extraction
// ---------------------------------------------------------------------------

console.log("report extraction");
test("extractJsonReport: prose around JSON block", () => {
  const msg = "Here is my report:\n\n```json\n{\"verdict\": \"pass\"}\n```\n\nDone.";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, "should be valid");
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: multiple blocks returns last", () => {
  const msg = "```json\n{\"verdict\": \"fail\"}\n```\n\nThen I fixed it:\n\n```json\n{\"verdict\": \"pass\"}\n```";
  const r = extractJsonReport(msg);
  assert.ok(r.valid);
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: invalid JSON", () => {
  const msg = "```json\n{not valid json}\n```";
  const r = extractJsonReport(msg);
  assert.ok(!r.valid);
  assert.ok(r.reason.includes("invalid JSON"), `reason: ${r.reason}`);
});

test("extractJsonReport: no block", () => {
  const r = extractJsonReport("no report here");
  assert.ok(!r.valid);
  assert.ok(r.reason.includes("no JSON"));
});

test("extractJsonReport: empty message", () => {
  const r = extractJsonReport("");
  assert.ok(!r.valid);
});

// ---------------------------------------------------------------------------
// extractJsonReport: lenient parsing (D50 item 2)
// ---------------------------------------------------------------------------

console.log("\nextractJsonReport: lenient parsing");
test("extractJsonReport: skeleton pasted verbatim (with // comments) parses", () => {
  // The old skeleton shape carried // comments inside the fence; the lenient
  // parser strips them so a verbatim paste still parses.
  const msg = "Done.\n\n```json\n{\n  \"files_touched\": [\"...\"], // Every file the builder modified\n  \"verification\": [{ \"cmd\": \"...\", \"exit\": 0, \"summary\": \"...\" }],\n  \"deviations\": [],\n  \"summary\": \"...\" // One-paragraph implementation summary\n}\n```";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse: ${r.reason}`);
  assert.deepStrictEqual(r.report.files_touched, ["..."]);
});

test("extractJsonReport: rendered skeleton fence parses verbatim", () => {
  // The new skeleton is valid JSON; pasted verbatim it must parse.
  const skeleton = renderSkeleton("builder");
  const msg = `Here is my report.\n\n\`\`\`json\n${skeleton}\n\`\`\``;
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse: ${r.reason}`);
  assert.ok(Array.isArray(r.report.files_touched));
});

test("extractJsonReport: trailing commas stripped", () => {
  const msg = "```json\n{\n  \"verdict\": \"pass\",\n  \"issues\": [],\n  \"summary\": \"ok\",\n}\n```";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse: ${r.reason}`);
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: bare object (no fence) parses", () => {
  // The agent stripped the fence but kept the object at the end.
  const msg = "I'm done.\n\n{\"verdict\":\"pass\",\"issues\":[],\"summary\":\"ok\"}";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse bare object: ${r.reason}`);
  assert.strictEqual(r.report.verdict, "pass");
});

test("extractJsonReport: bare object with trailing whitespace parses", () => {
  const msg = "prose before\n\n{\"verdict\":\"pass\",\"issues\":[],\"summary\":\"ok\"}   \n\n";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse: ${r.reason}`);
});

test("extractJsonReport: // inside a string value is not stripped", () => {
  const msg = "```json\n{\"summary\":\"see http://example.com/path\"}\n```";
  const r = extractJsonReport(msg);
  assert.ok(r.valid, `should parse: ${r.reason}`);
  assert.strictEqual(r.report.summary, "see http://example.com/path");
});

test("extractJsonReport: prose-only still blocks (no fence, no object)", () => {
  const r = extractJsonReport("I am done, nothing to parse here.");
  assert.ok(!r.valid);
  assert.ok(r.reason.includes("no JSON"), `reason: ${r.reason}`);
});

test("extractJsonReport: fence takes precedence over bare object", () => {
  const msg = "{\"verdict\":\"old\"}\n\n```json\n{\"verdict\":\"new\"}\n```";
  const r = extractJsonReport(msg);
  assert.ok(r.valid);
  assert.strictEqual(r.report.verdict, "new", "last fence wins over bare object");
});

// ---------------------------------------------------------------------------
// extractJsonCandidates + multi-fence schema selection (D50 item 2)
// ---------------------------------------------------------------------------

console.log("\nextractJsonCandidates: multi-fence selection");
test("extractJsonCandidates: returns all fences in document order", () => {
  const msg = "```json\n{\"a\":1}\n```\nprose\n```json\n{\"b\":2}\n```";
  const cs = extractJsonCandidates(msg);
  assert.strictEqual(cs.length, 2);
  assert.strictEqual(cs[0].report.a, 1);
  assert.strictEqual(cs[1].report.b, 2);
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
// D47(1): report skeleton rendering (renderSkeleton)
// ---------------------------------------------------------------------------

console.log("\nreport skeleton rendering");
test("renderSkeleton: builder skeleton is valid JSON with all required keys (no inline comments)", () => {
  const skeleton = renderSkeleton("builder");
  assert.ok(skeleton, "should return a skeleton");
  assert.ok(skeleton.includes("files_touched"), "should have files_touched");
  assert.ok(skeleton.includes("verification"), "should have verification");
  assert.ok(skeleton.includes("deviations"), "should have deviations");
  assert.ok(skeleton.includes("summary"), "should have summary");
  // D50 item 2: the fence content is valid JSON (no // comments inside).
  assert.ok(!skeleton.includes("//"), "skeleton must not contain // comments inside the fence");
  assert.doesNotThrow(() => JSON.parse(skeleton), "skeleton must parse as JSON");
});

test("renderSkeletonNotes: builder notes list each key with its description", () => {
  const notes = renderSkeletonNotes("builder");
  assert.ok(Array.isArray(notes) && notes.length === 5, "builder has 4 required keys and the phase_id note");
  assert.ok(notes[0].includes("phase_id"), "the first note asks for phase_id");
  assert.ok(notes.some((n) => n.includes("files_touched") && n.includes("modified")), "files_touched note");
  assert.ok(notes.every((n) => n.startsWith("- ")), "notes are a bullet list");
});

test("SK1: the committer skeleton names sha first; reviewer items keep their four keys; sha stays optional", () => {
  const { validateReport } = require("./lib/report");
  assert.deepStrictEqual(Object.keys(JSON.parse(renderSkeleton("committer")).commits[0]), ["sha", "files", "message"]);
  assert.deepStrictEqual(Object.keys(JSON.parse(renderSkeleton("reviewer")).issues[0]), ["severity", "file", "line", "text"]);
  assert.deepStrictEqual(Object.keys(JSON.parse(renderSkeleton("explorer")).open_questions[0]), ["question"]);
  assert.strictEqual(validateReport("committer", { commits: [{ files: [], message: "m" }] }).valid, true);
});

test("renderSkeletonNotes: unknown schema returns null", () => {
  assert.strictEqual(renderSkeletonNotes("nonexistent"), null);
});

test("renderSkeleton: explorer has all required keys", () => {
  const { renderSkeleton } = require("./lib/report");
  const skeleton = renderSkeleton("explorer");
  assert.ok(skeleton.includes("plan_path"));
  assert.ok(skeleton.includes("manifest"));
  assert.ok(skeleton.includes("open_questions"));
  assert.ok(skeleton.includes("summary"));
});

test("renderSkeleton: reviewer has verdict and issues", () => {
  const { renderSkeleton } = require("./lib/report");
  const skeleton = renderSkeleton("reviewer");
  assert.ok(skeleton.includes("verdict"));
  assert.ok(skeleton.includes("issues"));
  assert.ok(skeleton.includes("summary"));
});

test("renderSkeleton: committer has commits", () => {
  const { renderSkeleton } = require("./lib/report");
  const skeleton = renderSkeleton("committer");
  assert.ok(skeleton.includes("commits"));
});

test("renderSkeleton: unknown schema returns null", () => {
  const { renderSkeleton } = require("./lib/report");
  assert.strictEqual(renderSkeleton("nonexistent"), null);
});

// ---------------------------------------------------------------------------
// D47(1): generated agent files have "## Final report" with skeleton
// ---------------------------------------------------------------------------

console.log("\ngenerate.js: Final report section");
test("generated courier has ## Final report with builder + committer skeletons", () => {
  const gen = fs.readFileSync(path.join(__dirname, "..", "generated", "claude", "agents", "courier.md"), "utf8");
  assert.ok(gen.includes("## Final report"), "should have ## Final report section");
  assert.ok(gen.includes('"files_touched"'), "should have builder skeleton");
  assert.ok(gen.includes('"commits"'), "should have committer skeleton");
  assert.ok(gen.includes("Paste this JSON block"), "should have paste instruction");
  assert.ok(!gen.includes("## Delivery Report"), "should not have old Delivery Report section");
  assert.ok(!gen.includes("## JSON Report"), "should not have old JSON Report section");
});

test("generated builder has ## Final report with builder skeleton only", () => {
  const gen = fs.readFileSync(path.join(__dirname, "..", "generated", "claude", "agents", "builder.md"), "utf8");
  assert.ok(gen.includes("## Final report"), "should have ## Final report");
  assert.ok(gen.includes('"files_touched"'), "should have builder skeleton");
  assert.ok(!gen.includes('"commits"'), "should not have committer skeleton");
  assert.ok(!gen.includes("## JSON Report"), "should not have old JSON Report section");
});

test("generated explorer has ## Final report with explorer skeleton", () => {
  const gen = fs.readFileSync(path.join(__dirname, "..", "generated", "claude", "agents", "explorer.md"), "utf8");
  assert.ok(gen.includes("## Final report"), "should have ## Final report");
  assert.ok(gen.includes('"plan_path"'), "should have explorer skeleton");
  assert.ok(!gen.includes("## JSON Report"), "should not have old JSON Report section");
});

test("generated reviewer has ## Final report with reviewer skeleton", () => {
  const gen = fs.readFileSync(path.join(__dirname, "..", "generated", "claude", "agents", "reviewer.md"), "utf8");
  assert.ok(gen.includes("## Final report"), "should have ## Final report");
  assert.ok(gen.includes('"verdict"'), "should have reviewer skeleton");
  assert.ok(!gen.includes("## JSON Report"), "should not have old JSON Report section");
});

test("generated committer has ## Final report with committer skeleton", () => {
  const gen = fs.readFileSync(path.join(__dirname, "..", "generated", "claude", "agents", "committer.md"), "utf8");
  assert.ok(gen.includes("## Final report"), "should have ## Final report");
  assert.ok(gen.includes('"commits"'), "should have committer skeleton");
  assert.ok(!gen.includes("## JSON Report"), "should not have old JSON Report section");
});

console.log(`\n${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
