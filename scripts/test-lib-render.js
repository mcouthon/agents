#!/usr/bin/env node
"use strict";

// task.md's three rendered blocks: the marks, the gates on decision lines, the
// neutralisation, the placement rules (a Decision Log heading takes the
// decisions block), the byte-stable goldens, and a export --check over a hand
// edit. The tables come from scripts/fixtures/render/129.json.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS = __dirname;
const FIXTURES = path.join(SCRIPTS, "fixtures", "render");
const render = require("./lib/render");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const created = [];
function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-render-")));
  created.push(base);
  const sb = {
    base,
    home: path.join(base, "home"),
    tasks: path.join(base, "tasks"),
    sessions: path.join(base, "sessions"),
  };
  for (const d of [sb.home, sb.tasks, sb.sessions]) fs.mkdirSync(d, { recursive: true });
  sb.env = {
    ...process.env,
    HOME: sb.home, AGENTS_TASKS_ROOT: sb.tasks, AGENTS_SESSIONS_ROOT: sb.sessions,
    AGENTS_DB: path.join(base, "agents.db"),
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  // the in-process lib reads below must see this sandbox's roots, never the real ones
  Object.assign(process.env, sb.env);
  delete sb.env.AGENTS_SESSION_DIR;
  delete sb.env.CLAUDE_CODE_SESSION_ID;
  return sb;
}

function exportRun() {
  try { require("./lib/db-export").exportInPlace(); return { status: 0, stdout: "", stderr: "" }; }
  catch (e) { return { status: 1, stdout: "", stderr: String(e) }; }
}

function exportCheck() {
  try {
    const r = require("./lib/db-export").check();
    return { status: r.equal ? 0 : 1, stdout: JSON.stringify(r, null, 2), stderr: "" };
  } catch (e) { return { status: 1, stdout: "", stderr: String(e) }; }
}

/** Seed the task's tables from the fixture and write its plan files; returns the task dir. */
function seedFromFixture(sb, fix) {
  const db = require("./lib/db");
  const taskDir = path.join(sb.tasks, fix.repo_key, fix.dir_name);
  fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
  for (const [phaseId, file] of Object.entries(fix.plan_files || {})) {
    fs.writeFileSync(path.join(taskDir, "plan", file), `# Plan ${phaseId}\n\nThe body the approval binds to.\n`);
  }
  const taskId = db.createTaskRow({
    repoKey: fix.repo_key, dirName: fix.dir_name, taskDir, slug: fix.slug, number: fix.number,
    title: fix.title, tier: fix.tier, mode: fix.mode, created: fix.created,
    approvals: fix.approvals, land: fix.land, worktreePath: null, branch: null,
    phases: fix.phases.map((p) => ({ id: p.id, name: p.name, after: p.after })),
  });
  for (const m of fix.checkmarks) db.insertCheckmark(taskId, m.phase_id, m.session_id, m.checked_at);
  for (const d of fix.decisions) {
    let planHash = d.plan_hash === undefined ? null : d.plan_hash;
    if (d.plan_match) {
      const file = path.join(taskDir, "plan", fix.plan_files[String(d.phase_id)]);
      planHash = require("./lib/derive").planHash(fs.readFileSync(file, "utf8"));
    }
    db.insertDecision({
      task_id: taskId, phase_id: d.phase_id, choice: d.choice, gate: d.gate || null,
      plan_hash: planHash, quote: d.quote, recorded_by: d.recorded_by, decided_at: d.decided_at,
    });
  }
  for (const n of fix.notes) {
    db.insertNote({ task_id: taskId, phase_id: n.phase_id, text: n.text, session_id: "seed", at: n.at });
  }
  return { taskDir, taskId };
}

const fix = JSON.parse(fs.readFileSync(path.join(FIXTURES, "129.json"), "utf8"));

// ---------------------------------------------------------------------------
// The pure blocks
// ---------------------------------------------------------------------------

function viewOfFixture() {
  const sb = sandbox();
  const { taskDir, taskId } = seedFromFixture(sb, fix);
  const view = require("./lib/task").viewOf(require("./lib/db").getTask(taskId));
  return { sb, taskDir, view };
}

{
  const { sb, taskDir, view } = viewOfFixture();
  const phases = render.phasesLines(view, taskDir);
  const line = (id) => phases.find((l) => l.startsWith(`- [`) && l.includes(`**${id}**`));
  check(line(1).startsWith("- [x] **1** S0 Freeze and snapshot · after — · plan [phase-1-s0-freeze-and-snapshot.md](plan/phase-1-s0-freeze-and-snapshot.md) · approved 2026-10-23 · accepted 2026-10-24"),
    `R1: a checked phase carries its mark, plan link and verdict dates (${line(1)})`);
  check(line(21).startsWith("- [-] **21** (unnamed) · after 20 · plan — · skipped 2026-10-30 (migrated)"), `R1: a nameless migrated skip renders [-] with (unnamed) and (migrated) (${line(21)})`);
  for (const id of [26, 27, 28]) {
    check(line(id).startsWith(`- [-] **${id}**`) && !line(id).includes("(migrated)"), `R1: an owner skip on ${id} renders [-] with no (migrated) (${line(id)})`);
  }
  check(line(27).includes("S3g: the hooks runbook"), "R1: the override keeps the phase line plain");
  check(line(30).startsWith("- [ ] **30** M2: the intent store and the fast index · after 29 · plan [phase-30-m2-intent-store-fast-index.md](plan/phase-30-m2-intent-store-fast-index.md) · approved — · accepted —"),
    `R1: an open phase renders [ ] with its plan link and em-dashes (${line(30)})`);

  const decisions = render.decisionsLines(view);
  const dline = (needle) => decisions.find((l) => l.includes(needle));
  check(dline("phase 27 · override") === "- **2026-10-28 09:02Z** · phase 27 · override", `R2: the override renders verbatim with no suffix (${dline("phase 27 · override")})`);
  check(dline("waived phase-plan") === "- **2026-10-30 14:40Z** · phase 30 · waived phase-plan (agent)", `R2: a waiver carries its gate and (agent) (${dline("waived phase-plan")})`);
  check(dline("answer task-plan") === "- **2026-10-30 14:41Z** · task · answer task-plan", `R2: a task-level answer renders task with its gate (${dline("answer task-plan")})`);
  check(dline("waived finalize") === "- **2026-10-30 14:42Z** · task · waived finalize (agent)", `R2: a task-level waiver renders task with (agent) (${dline("waived finalize")})`);
  check(dline("approve (migrated)") === "- **2026-10-30 15:00Z** · phase 22 · approve (migrated)", `R2: a migration-written approve carries (migrated) (${dline("approve (migrated)")})`);
  check(decisions.includes("  > stored status skipped, migrated 2026-10-30"), "R2: a quote renders on prefixed > lines");
  check(decisions.some((l) => l === "- **2026-10-30 12:00:00Z** · phase 4 · skip (migrated)") || decisions.some((l) => l.startsWith("- **2026-10-30 12:00Z** · phase 4 · skip (migrated)")),
    "R2: a migration-written skip carries (migrated)");

  const notes = render.notesLines(view);
  check(notes.includes("- **2026-10-29 18:21Z** · phase 29") && notes.includes("  > M1 ran as task 137; commits 71a7981 and 470db52"),
    "R3: a note renders its phase and quoted text");
  check(notes.includes("- **2026-10-30 09:00Z** · task"), "R3: a task-level note renders task");

  check(render.neutral("a<!--b-->c\nd") === "a<!—b—>c d", `R4: neutralisation flattens newlines and breaks comment tokens (${render.neutral("a<!--b-->c\nd")})`);
}

// ---------------------------------------------------------------------------
// Placement: the goldens
// ---------------------------------------------------------------------------

const INPUTS = [
  ["input-fresh.md", "fresh.md.golden"],
  ["input-markers.md", "markers.md.golden"],
  ["input-log.md", "log.md.golden"],
];

/** The prose of a file: its lines outside the three blocks and the template table, empties dropped. */
const proseOf = (text) => {
  const lines = text.split("\n");
  const out = [];
  let inBlock = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === render.PHASES_START || t === render.DECISIONS_START || t === render.NOTES_START) { inBlock++; continue; }
    if (t === render.PHASES_END || t === render.DECISIONS_END || t === render.NOTES_END) { inBlock--; continue; }
    if (inBlock > 0) continue;
    if (t === "| # | Phase | Notes |" || t === "|---|---|---|") continue;
    if (t === "") continue;
    out.push(t);
  }
  return out.join("\n");
};

for (const [input, goldenName] of INPUTS) {
  const sb = sandbox();
  const { taskDir } = seedFromFixture(sb, fix);
  const goldenPath = path.join(FIXTURES, goldenName);
  const inputText = fs.readFileSync(path.join(FIXTURES, input), "utf8");
  fs.writeFileSync(path.join(taskDir, "task.md"), inputText);
  const exported = exportRun();
  const out = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
  const golden = fs.existsSync(goldenPath) ? fs.readFileSync(goldenPath, "utf8") : null;
  check(exported.status === 0, `G1 ${input}: export exits 0 (${exported.status}: ${exported.stderr})`);
  check(golden !== null && out === golden,
    `G1 ${input}: the rendered file equals its golden byte for byte${golden === null ? " (golden missing)" : out === golden ? "" : `\n--- got:\n${out}\n--- want:\n${golden}`}`);
  check(proseOf(out) === proseOf(inputText), `G1 ${input}: the prose outside the blocks is unchanged (${proseOf(out).slice(0, 80)}…)`);
  const again = exportRun();
  const out2 = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
  check(again.status === 0 && out2 === out, `G1 ${input}: a second render changes nothing`);
  const chk = exportCheck();
  check(chk.status === 0, `G1 ${input}: export --check exits 0 after the render (${chk.status}: ${chk.stdout})`);

  // a hand edit inside the phases block: --check names the file, export restores it
  fs.writeFileSync(path.join(taskDir, "task.md"), out.replace("- [ ] **30**", "- [x] **30**"));
  const bad = exportCheck();
  check(bad.status === 1 && bad.stdout.includes(taskDir), `G2 ${input}: export --check exits 1 naming the hand-edited file (${bad.status})`);
  const fixed = exportRun();
  check(fixed.status === 0 && fs.readFileSync(path.join(taskDir, "task.md"), "utf8") === out, `G2 ${input}: export restores the blocks`);
}

// ---------------------------------------------------------------------------
// A task.md that does not exist: the export creates it in the fresh shape
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  const db = require("./lib/db");
  const { taskDir, taskId } = seedFromFixture(sb, fix);

  check(!fs.existsSync(path.join(taskDir, "task.md")), "G3: the seeded task has no task.md yet");
  const ex = exportRun();
  const back = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
  check(ex.status === 0 && back.includes(render.PHASES_START) && back.includes(render.DECISIONS_END) && back.includes(render.NOTES_END),
    `G3: the export recreates a missing task.md with the three blocks (${ex.status}: ${ex.stderr.slice(0, 120)})`);
  check(back.includes(`# ${fix.title}`) && back.includes("## Decision Log"), `G3: the recreated file carries the fresh shape's heading (${back.split("\n").slice(0, 4).join(" / ")})`);
  const chk = exportCheck();
  check(chk.status === 0, `G3: export --check exits 0 once the file is recreated (${chk.status}: ${chk.stdout.slice(0, 120)})`);

  // a row whose folder was never written: the export materializes it
  const orphanDir = path.join(sb.tasks, fix.repo_key, "077-never-written");
  db.createTaskRow({
    repoKey: fix.repo_key, dirName: "077-never-written", taskDir: orphanDir, slug: "never-written", number: 77,
    title: "Never written", tier: "standard", mode: "full", created: "2026-10-31",
    approvals: null, land: null, worktreePath: null, branch: null, phases: [{ id: 1, name: "One", after: [] }],
  });
  const ex2 = exportRun();
  const made = fs.readFileSync(path.join(orphanDir, "task.md"), "utf8");
  check(ex2.status === 0 && fs.existsSync(orphanDir) && made.includes(render.PHASES_START),
    `G3: the export materializes a row whose folder was never written (${ex2.status})`);
  const chk2 = exportCheck();
  check(chk2.status === 0, `G3: export --check exits 0 with both files in place (${chk2.status}: ${chk2.stdout.slice(0, 160)})`);
}

// ---------------------------------------------------------------------------
// Structure over hostile text (fences, markers, pipes, headings in quotes)
// ---------------------------------------------------------------------------

{
  const sb = sandbox();
  const hostile = JSON.parse(JSON.stringify(fix));
  hostile.decisions = [
    { phase_id: 5, choice: "answer", gate: "task-plan", quote: "```\ncode\n```\n~~~\nmore\n~~~\n<!-- phases:end -->\n| pipe |\n# heading", recorded_by: "owner", decided_at: "2026-10-30T10:00:00.000Z" },
    { phase_id: null, choice: "waived", gate: "finalize", quote: "a <!-- comment --> inside", recorded_by: "agent", decided_at: "2026-10-30T10:01:00.000Z" },
  ];
  hostile.notes = [
    { phase_id: 5, text: "```\nfenced note\n```\n<!-- notes:end -->", at: "2026-10-30T10:02:00.000Z" },
  ];
  hostile.phases = [{ id: 5, name: "Hostile <!-- name --> with | pipe", after: [] }];
  hostile.checkmarks = [];
  hostile.plan_files = {};
  const { taskDir } = seedFromFixture(sb, hostile);
  fs.writeFileSync(path.join(taskDir, "task.md"), "# Hostile\n\n## Phases\n\n| # | Phase | Notes |\n|---|---|---|\n");
  const exported = exportRun();
  const text = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
  check(exported.status === 0, "S1: the render of hostile text exits 0");
  const markers = [render.PHASES_START, render.PHASES_END, render.DECISIONS_START, render.DECISIONS_END, render.NOTES_START, render.NOTES_END];
  for (const m of markers) {
    check(text.split(m).length - 1 === 1, `S1: ${m} occurs exactly once`);
  }
  const between = (start, end) => {
    const body = text.slice(text.indexOf(start) + start.length, text.indexOf(end));
    return body.split("\n");
  };
  for (const [start, end] of [[render.DECISIONS_START, render.DECISIONS_END], [render.NOTES_START, render.NOTES_END]]) {
    const inner = between(start, end).slice(1, -1);
    check(inner.every((l) => l === "" || l.startsWith("- **") || l.startsWith("  > ")),
      `S1: every line between ${start} and its end is empty, - ** or > quoted`);
  }
  const phaseBody = between(render.PHASES_START, render.PHASES_END).slice(1, -1);
  check(phaseBody.every((l) => l === "" || l.startsWith("_Rendered") || /^- \[(x|-| )\] /.test(l)),
    "S1: every phases-block line is empty, the banner or a mark line");
  check(!text.includes("Hostile <!-- name -->") && text.includes("Hostile <!— name —>"), "S1: a comment token in a phase name is broken");
  const reread = render.renderTaskMdText(text, require("./lib/task").viewOf(require("./lib/db").getTask(require("./lib/db").taskIdOf(taskDir))), taskDir);
  check(reread !== null && reread.join("\n") === text, "S1: a re-render after reading the file back finds the same markers and produces the same bytes");
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
