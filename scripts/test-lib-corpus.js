#!/usr/bin/env node
"use strict";

// The corpus: every live shape the migrator met, as fixtures under
// scripts/fixtures/corpus, seeded as v1 rows in one pass, migrated by the
// first open and read back through `a ls <task> --json` — the derived view the
// plan's exit checks describe. git runs through a counting wrapper; gh is a
// stub.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SCRIPTS = __dirname;
const A = path.join(SCRIPTS, "bin", "a");
const FIXTURES = path.join(SCRIPTS, "fixtures", "corpus");
const ORDER = ["sdr-197", "task-136", "pav-295", "agents-129", "merged-pr", "agents-128", "agents-100"];

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const created = [];
const mktmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
};

// the counting git wrapper, and a gh stub that prints $GH_OUT
const GUARD = mktmp("agents-corpus-git-");
const GIT_LOG = path.join(GUARD, "git.log");
const GH_OUT = path.join(GUARD, "gh.out");
fs.writeFileSync(path.join(GUARD, "git"), `#!/bin/sh\nprintf '%s' "$(pwd)" >> '${GIT_LOG}'\nprintf ' %s' "$@" >> '${GIT_LOG}'\nprintf '\\n' >> '${GIT_LOG}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(GUARD, "gh"), `#!/bin/sh\ncat '${GH_OUT}'\nexit 0\n`, { mode: 0o755 });
const gitLines = () => (fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, "utf8").split("\n").filter(Boolean) : []);

const T = mktmp("agents-corpus-");
const HOME = path.join(T, "home");
const TASKS = path.join(T, "tasks");
const SESSIONS = path.join(T, "sessions");
const DB = path.join(T, "agents.db");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });
Object.assign(process.env, {
  HOME, AGENTS_TASKS_ROOT: TASKS, AGENTS_SESSIONS_ROOT: SESSIONS, AGENTS_DB: DB,
  PATH: `${GUARD}:${process.env.PATH}`,
  AGENTS_TEST_SKIP_IDENTITY: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});
delete process.env.AGENTS_SESSION_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".claude", "repo-policies.json"), "{}");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const withDate = (repo, date, ...args) => spawnSync("git", ["-C", repo, ...args],
  { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, stdio: ["ignore", "pipe", "pipe"] }).status === 0;
const run = (args) => {
  const r = spawnSync("node", [A, ...args, "--json"], { encoding: "utf8", timeout: 120000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
};

/** A fixture repo: main with the fixture's commits (distinct dates) and a bare origin inside it, reachable by a single-segment repo key. The init commit predates every fixture's dates so commit-counting advice reads no commits of its own. */
function makeRepo(fix) {
  const dir = path.join(T, `repo-${fix.name}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  git(dir, "add", ".");
  withDate(dir, "2026-08-01T10:00:00", "commit", "-q", "-m", "init");
  const shas = [git(dir, "rev-parse", "HEAD")];
  git(dir, "init", "-q", "--bare", "-b", "main", path.join(dir, `${fix.name}.origin`));
  git(dir, "remote", "add", "origin", `${fix.name}.origin`);
  for (let i = 0; i < (fix.commits || 0); i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}\n`);
    git(dir, "add", ".");
    withDate(dir, `2026-09-${String(10 + i).padStart(2, "0")}T10:00:00`, "commit", "-q", "-m", `c${i}`);
    shas.push(git(dir, "rev-parse", "HEAD"));
  }
  git(dir, "push", "-q", "origin", "main");
  git(dir, "remote", "set-head", "origin", "main");
  if (fix.policy !== "unlisted") {
    const policies = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "repo-policies.json"), "utf8"));
    policies[dir] = fix.policy;
    fs.writeFileSync(path.join(HOME, ".claude", "repo-policies.json"), JSON.stringify(policies, null, 2));
  }
  return { dir, repoKey: `${fix.name}.origin`, shas };
}

/** One v1 task row with its phases, decisions and plan files; {sha:N} resolves against the repo's commits. */
function seedV1(db, repo, { number, dirName, doc, decisions = [], planFiles = [] }) {
  const taskDir = path.join(TASKS, repo.repoKey, dirName);
  fs.mkdirSync(taskDir, { recursive: true });
  const resolve = (text) => String(text).replace(/\{sha:(\d+)\}/g, (m, i) => repo.shas[Number(i)] || m);
  const docText = JSON.stringify(doc, (k, v) => (typeof v === "string" ? resolve(v) : v));
  db.prepare(`INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)`)
    .run(number, repo.repoKey, dirName, taskDir, taskDir, doc.slug, number, doc.title,
      doc.tier || "standard", doc.mode || "full", doc.created, doc.updated, docText);
  for (const [ord, p] of doc.phases.entries()) {
    db.prepare("INSERT INTO phases (task_id, ord, phase_id, name, status, owner, branch, plan_path, landed_sha, started, completed) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?)")
      .run(number, ord, p.id, p.name, p.status, p.branch || null, p.landed_sha ? resolve(p.landed_sha) : null, p.completed || null);
  }
  for (const d of decisions) {
    db.prepare("INSERT INTO decisions (task_id, phase_id, choice, quote, recorded_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(number, d.phase_id, d.choice, d.quote, d.recorded_by, d.decided_at);
  }
  for (const id of planFiles) {
    fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
    const phase = (doc.phases || []).find((p) => p.id === id);
    const slug = String((phase && phase.name) || "plan").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
    fs.writeFileSync(path.join(taskDir, "plan", `phase-${id}-${slug}.md`), `# Phase ${id}\n\nThe body.\n`);
  }
  return { taskDir, taskId: number };
}

// One v1 seeding pass: every fixture's repo, rows and files, before any engine
// run migrates the file.
const R = {};
{
  const sql = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8")
    .split("-- A repo every seed task belongs to")[0]
    .replace(/\$TASKS_ROOT/g, TASKS);
  const db = new DatabaseSync(DB);
  db.exec(sql);
  for (const [ord, name] of ORDER.entries()) {
    const fix = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
    const repo = makeRepo(fix);
    db.prepare("INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(repo.repoKey, ord, repo.dir, JSON.stringify({ main_root: repo.dir, last_seen: fix.doc.updated }), fix.doc.updated);
    const seeded = seedV1(db, repo, { number: fix.number, dirName: fix.dir_name, doc: fix.doc, decisions: fix.decisions || [], planFiles: fix.plan_files || [] });
    R[name] = { fix, ...repo, seeded };
  }

  // sdr-197's M1 variant: an approved phase behind a done one, with and without its plan file
  const variant = R["sdr-197"].fix.m1_variant;
  R["sdr-197"].withPlan = seedV1(db, R["sdr-197"], { number: variant.number, dirName: variant.dir_name, doc: variant.doc, planFiles: variant.plan_files });
  R["sdr-197"].noPlan = seedV1(db, R["sdr-197"], { number: 1973, dirName: `${variant.dir_name}-2`, doc: { ...variant.doc, number: 1973 } });

  // task-136: its branch sits on base with no commits of its own
  git(R["task-136"].dir, "branch", `wt/${R["task-136"].fix.dir_name}`, "main");

  // the merged-PR task: a branch squash-merged to main, still unmerged itself
  {
    const { dir, fix } = R["merged-pr"];
    const branch = `wt/${fix.dir_name}`;
    git(dir, "checkout", "-q", "-b", branch);
    fs.writeFileSync(path.join(dir, "w1.txt"), "w1\n");
    git(dir, "add", ".");
    withDate(dir, "2026-10-03T10:00:00", "commit", "-q", "-m", "wip");
    fs.writeFileSync(path.join(dir, "w2.txt"), "w2\n");
    git(dir, "add", ".");
    withDate(dir, "2026-10-04T10:00:00", "commit", "-q", "-m", "done");
    const tip = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "--squash", branch);
    withDate(dir, "2026-10-05T10:00:00", "commit", "-q", "-m", "squashed");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "push", "-q", "origin", branch);
    fs.writeFileSync(GH_OUT, JSON.stringify([{ number: 9, url: "https://example/pr/9", mergedAt: "2026-10-06T10:00:00Z", headRefOid: tip }]));
  }

  // agents-100: its task.md phase table names every landing commit
  {
    const repo = R["agents-100"];
    const lines = repo.shas.slice(1).map((sha, i) => `| ${i + 1} | P${i + 1} | Committed: ${sha} |`);
    fs.writeFileSync(path.join(repo.seeded.taskDir, "task.md"), `# 100\n\n| # | Phase | Landing |\n|---|---|---|\n${lines.join("\n")}\n`);
  }
  db.close();
}

const readTask = (name) => run(["ls", R[name].seeded.taskDir, "--repo", R[name].dir]);

// ---------------------------------------------------------------------------
// sdr 197: the recorded-now shape
// ---------------------------------------------------------------------------
{
  const r = readTask("sdr-197");
  const out = r.json();
  check(r.status === 0, `sdr-197: a ls <task> --json exits 0 (${r.status}: ${r.stderr.slice(0, 120)})`);
  check(out.task_status === "open" && out.current_phase && out.current_phase.id === 7,
    `sdr-197: open, current phase 7 (${out.task_status}/${out.current_phase && out.current_phase.id})`);
  check(out.advice.move === "plan" && out.migrated === true && out.approvals === "none",
    `sdr-197: move plan, migrated true (${out.advice.move}/${out.migrated}/${out.approvals})`);
  const checked = out.phases.filter((p) => p.checked).map((p) => p.id);
  check(JSON.stringify(checked) === JSON.stringify([1, 2, 3, 4, 5, 6]) && out.phases.find((p) => p.id === 1).skipped === true,
    `sdr-197: 1-6 checked with 1 a skip (${JSON.stringify(checked)})`);
  check(out.phases_checked === 6 && out.phases_total === 8 && out.resumable === null,
    `sdr-197: the row counts 6 of 8 checked, the skip among them, and no resumable session (${out.phases_checked}/${out.phases_total})`);

  // the M1 variant: an approved phase behind a done one, with and without its plan file
  const withPlan = run(["ls", R["sdr-197"].withPlan.taskDir, "--repo", R["sdr-197"].dir]).json();
  check(withPlan.current_phase && withPlan.current_phase.id === 5 && withPlan.advice.move === "build",
    `sdr-197 M1 variant with a plan: current 5, move build (${withPlan.current_phase && withPlan.current_phase.id}/${withPlan.advice.move})`);
  const noPlan = run(["ls", R["sdr-197"].noPlan.taskDir, "--repo", R["sdr-197"].dir]).json();
  check(noPlan.current_phase && noPlan.current_phase.id === 5 && noPlan.advice.move === "plan",
    `sdr-197 M1 variant without a plan: move plan (${noPlan.advice.move})`);
  check(withPlan.phases_checked === 5 && withPlan.phases_total === 6 && noPlan.phases_checked === 5 && noPlan.phases_total === 6,
    `sdr-197 M1 variants: 5 of 6 checked, the approved phase still open (${withPlan.phases_checked}/${withPlan.phases_total})`);
}

// ---------------------------------------------------------------------------
// task 136: a branch on base with no commits of its own
// ---------------------------------------------------------------------------
{
  const out = readTask("task-136").json();
  check(out.task_status === "open" && out.current_phase && out.current_phase.id === 1,
    `task-136: open, current 1 (${out.task_status}/${out.current_phase && out.current_phase.id})`);
  check(out.phases_checked === 0 && out.phases_total === 1 && out.resumable === null,
    `task-136: 0 of 1 phases checked before the check (${out.phases_checked}/${out.phases_total})`);
  run(["task", "check", "--task-dir", R["task-136"].seeded.taskDir, "--phase-id", "1"]);
  const after = readTask("task-136").json();
  check(after.task_status !== "done" && after.landing && after.landing.state === "unresolved"
    && after.landing.reason === "branch on base with no commits of its own",
    `task-136 after check: all checked, ancestry only reads unresolved (${JSON.stringify(after.landing)})`);
  check(after.phases_checked === 1 && after.phases_total === 1,
    `task-136 after check: 1 of 1 phases checked (${after.phases_checked}/${after.phases_total})`);
}

// ---------------------------------------------------------------------------
// pav 295: the phase fan
// ---------------------------------------------------------------------------
{
  const out = readTask("pav-295").json();
  check(out.current_phase && out.current_phase.id === 13 && out.advice.move === "build" && out.migrated === true,
    `pav-295: current 13, move build, migrated (${out.current_phase && out.current_phase.id}/${out.advice.move}/${out.migrated})`);
  check(out.phases_checked === 9 && out.phases_total === 13 && out.resumable === null,
    `pav-295: 9 of 13 phases checked (${out.phases_checked}/${out.phases_total})`);
  run(["task", "check", "--task-dir", R["pav-295"].seeded.taskDir, "--phase-id", "13"]);
  const after = readTask("pav-295").json();
  check(after.current_phase && after.current_phase.id === 12, `pav-295 after 13 checked: current 12 (${after.current_phase && after.current_phase.id})`);
  check(after.phases_checked === 10 && after.phases_total === 13,
    `pav-295 after 13 checked: 10 of 13 phases checked (${after.phases_checked}/${after.phases_total})`);
}

// ---------------------------------------------------------------------------
// agents 129: its skipped phases, under ask
// ---------------------------------------------------------------------------
{
  const out = readTask("agents-129").json();
  check(out.current_phase && out.current_phase.id === 30 && out.advice.move === "approve",
    `agents-129: current 30, move approve (${out.current_phase && out.current_phase.id}/${out.advice.move})`);
  check(out.advice.question !== null && out.attention === true, "agents-129: the advice asks and attention is true");
  check(out.phases_checked === 11 && out.phases_total === 12 && out.resumable === null,
    `agents-129: 11 of 12 phases checked, the nine skips among them (${out.phases_checked}/${out.phases_total})`);
  const skips = out.decisions.filter((d) => d.choice === "skip");
  const skippedIds = [...new Set(skips.map((d) => d.phase_id))].sort((a, b) => a - b);
  check(JSON.stringify(skippedIds) === JSON.stringify([4, 15, 16, 17, 18, 21, 26, 27, 28]),
    `agents-129: one skip decision on each skipped phase (${JSON.stringify(skippedIds)})`);
  check(skips.filter((d) => d.phase_id === 26).length === 1 && skips.filter((d) => d.phase_id === 4)[0].recorded_by === "migration",
    "agents-129: 26 keeps its one pre-existing skip, 4's is migration-written");
  run(["decide", "--task-dir", R["agents-129"].seeded.taskDir, "--phase-id", "30", "--choice", "approve", "--quote", "go"]);
  const after = readTask("agents-129").json();
  check(after.advice.move === "build", `agents-129 after approve: move build (${after.advice.move})`);
}

// ---------------------------------------------------------------------------
// the merged-PR task
// ---------------------------------------------------------------------------
{
  const out = readTask("merged-pr").json();
  check(out.task_status === "done" && out.landing && out.landing.state === "landed" && out.landing.proof === "pr",
    `merged-pr: done with the pr proof (${JSON.stringify(out.landing)})`);
  check(out.phases_checked === 1 && out.phases_total === 1 && out.resumable === null,
    `merged-pr: 1 of 1 phases checked (${out.phases_checked}/${out.phases_total})`);
  const list = run(["ls", "--repo", R["merged-pr"].dir]).json();
  check(!list.tasks.some((t) => path.basename(t.dir) === R["merged-pr"].fix.dir_name),
    "merged-pr: the done task leaves a ls's default list");
}

// ---------------------------------------------------------------------------
// agents 128: five stored landings on base, a dead branch
// ---------------------------------------------------------------------------
{
  const before = gitLines().length;
  const out = readTask("agents-128").json();
  check(out.task_status === "done" && out.landing && out.landing.state === "landed" && out.landing.proof === "push",
    `agents-128: done with the push proof (${JSON.stringify(out.landing)})`);
  check(out.phases_checked === 15 && out.phases_total === 15 && out.resumable === null,
    `agents-128: 15 of 15 phases checked (${out.phases_checked}/${out.phases_total})`);
  check(!gitLines().slice(before).some((l) => /merge-base|cherry|patch-id/.test(l) && /wt\/a6/.test(l)),
    "agents-128: no branch proof is attempted for the dead branch");
  const d = new DatabaseSync(DB, { readOnly: true });
  let lands = [];
  try { lands = d.prepare("SELECT detail FROM events WHERE kind = 'land' AND task_id = ?").all(R["agents-128"].seeded.taskId); } finally { d.close(); }
  check(lands.length === 1 && JSON.parse(lands[0].detail).head === R["agents-128"].shas[4],
    `agents-128: one migrated land event with the newest stored commit (${lands.length} events)`);
}

// ---------------------------------------------------------------------------
// agents 100: the recorded landing, confirmed by the owner's words
// ---------------------------------------------------------------------------
{
  const out = readTask("agents-100").json();
  check(out.task_status !== "done" && out.landing && out.landing.state === "unresolved" && out.landing.reason === "no land record",
    `agents-100 after the migration: a candidate, unresolved no land record (${JSON.stringify(out.landing)})`);
  check(out.phases_checked === 6 && out.phases_total === 6 && out.resumable === null,
    `agents-100: 6 of 6 phases checked (${out.phases_checked}/${out.phases_total})`);
  const applied = run(["task", "import", "--apply", "--confirm-recorded", "yes, those are the landings"]);
  check(applied.status === 0, `agents-100: the confirmed --apply exits 0 (${applied.status}: ${applied.stderr.slice(0, 160)})`);
  const after = readTask("agents-100").json();
  check(after.task_status === "done" && after.landing && after.landing.state === "landed" && after.landing.proof === "push",
    `agents-100 after --apply --confirm-recorded: landed, proof push, done (${JSON.stringify(after.landing)})`);
  check(after.phases_checked === 6 && after.phases_total === 6,
    `agents-100 after --apply: still 6 of 6 phases checked (${after.phases_checked}/${after.phases_total})`);
  const d = new DatabaseSync(DB, { readOnly: true });
  let answers = [];
  try { answers = d.prepare("SELECT * FROM decisions WHERE task_id = ? AND choice = 'answer'").all(R["agents-100"].seeded.taskId); } finally { d.close(); }
  check(answers.length === 1 && answers[0].gate === "finalize" && answers[0].phase_id === null
    && answers[0].quote === "yes, those are the landings",
    `agents-100: the owner's words recorded as one task-level finalize answer (${JSON.stringify(answers.map((a) => a.quote))})`);
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
