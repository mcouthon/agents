#!/usr/bin/env node
"use strict";

// The v1 → v2 migration: the installed-engine rule, the checked backup, the
// conversion of every stored phase status, the landing rules over a fixture
// repo, the orphan adoption, the concurrency lock. Every scenario runs in its
// own sandbox; nothing here touches a real root.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SCRIPTS = __dirname;
const LIB = path.join(SCRIPTS, "lib");
const A = path.join(SCRIPTS, "bin", "a");
const REPO = path.resolve(SCRIPTS, "..");

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const created = [];
function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-mig-")));
  created.push(base);
  const sb = { base };
  sb.home = path.join(base, "home");
  sb.tasks = path.join(base, "tasks");
  sb.sessions = path.join(base, "sessions");
  for (const d of [sb.home, sb.tasks, sb.sessions]) fs.mkdirSync(d);
  sb.env = {
    ...process.env,
    HOME: sb.home,
    AGENTS_TASKS_ROOT: sb.tasks,
    AGENTS_SESSIONS_ROOT: sb.sessions,
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  sb.dbFile = path.join(base, "agents.db");
  sb.env.AGENTS_DB = sb.dbFile;
  delete sb.env.AGENTS_SESSION_DIR;
  delete sb.env.CLAUDE_CODE_SESSION_ID;
  return sb;
}

/** Apply the v1 fixture to a fresh file, with $TASKS_ROOT rewritten and extra SQL appended. */
function seedV1(sb, extraSql = "") {
  const sql = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8")
    .replace(/\$TASKS_ROOT/g, sb.tasks) + (extraSql ? "\n" + extraSql : "");
  const db = new DatabaseSync(sb.dbFile);
  db.exec("PRAGMA foreign_keys=OFF"); // a planted violation must survive seeding
  db.exec(sql);
  db.close();
}

/** Seed a v1 file with HOME-only roots and a home-default database path. */
function seedHomeV1(home) {
  const dbDir = path.join(home, ".agents");
  fs.mkdirSync(path.join(dbDir, "tasks", "github.com", "acme", "one"), { recursive: true });
  const file = path.join(dbDir, "agents.db");
  const sql = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8")
    .replace(/\$TASKS_ROOT/g, path.join(dbDir, "tasks"));
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  return file;
}

const readDb = (file, sql, ...params) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare(sql).all(...params); } finally { d.close(); }
};

function childEnv(env) {
  return {
    ...env,
    PATH: process.env.PATH,
  };
}

function runChild(env, args = ["ls", "--json"]) {
  const r = spawnSync("node", [A, ...args], { env: childEnv(env), encoding: "utf8", timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fixture repo with a local bare origin: main checked out, origin/main reachable. */
function makeRepo(sb, name = "direct") {
  const dir = path.join(sb.base, name);
  fs.mkdirSync(dir);
  git(sb.base, "init", "-q", "--bare", "-b", "main", `${dir}.origin`);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", `${dir}.origin`);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "remote", "set-head", "origin", "main");
  return dir;
}

/** Insert a v1 task row with an all-checked doc, listed direct in the child's policy file. */
function allCheckedTask(sb, { id, dirName, mainRoot, repoKey = "github.com/acme/one", landedShas = [], statuses = ["done"] }) {
  const taskDir = path.join(sb.tasks, repoKey, dirName);
  fs.mkdirSync(taskDir, { recursive: true });
  const phases = [];
  for (let i = 0; i < statuses.length; i++) {
    phases.push({ id: i + 1, name: `P${i + 1}`, status: statuses[i], blocked_by: i > 0 ? [i] : [], ...(landedShas[i] ? { landed_sha: landedShas[i] } : {}) });
  }
  const doc = {
    schema: 2, slug: dirName, number: id, title: dirName, status: "done", mode: "full", tier: "standard",
    knobs: {}, phases, worktree_path: "", created: "2026-10-01", updated: `2026-10-0${id}T10:00:00.000Z`,
  };
  const text = JSON.stringify(doc);
  const db = new DatabaseSync(sb.dbFile);
  db.prepare(`INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 'done', 'standard', 'full', '2026-10-01', ?, ?)`)
    .run(id, repoKey, dirName, taskDir, taskDir, dirName, id, dirName, doc.updated, text);
  for (const [ord, p] of phases.entries()) {
    db.prepare("INSERT INTO phases (task_id, ord, phase_id, name, status, landed_sha, completed) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, ord, p.id, p.name, p.status, p.landed_sha || null, p.completed || null);
  }
  db.close();
  return { taskDir, doc };
}

function listPolicy(sb, entries) {
  fs.mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(sb.home, ".agents", "repo-policies.json")), { recursive: true });
  fs.writeFileSync(path.join(sb.home, ".agents", "repo-policies.json"), JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// The basic conversion: seed, migrate through a verb, assert the v2 shape
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  const r = runChild(sb.env);
  check(r.status === 0, `a ls --json migrates a v1 file and exits 0 (${r.status}: ${r.stderr.trim().split("\n").pop()})`);
  check(Number(readDb(sb.dbFile, "SELECT version FROM schema_version")[0].version) === 2, "schema_version is 2");
  const tables = readDb(sb.dbFile, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name).sort();
  check(["runs", "reports", "checkpoints"].every((t) => !tables.includes(t)), "runs, reports and checkpoints are gone");
  check(["checkmarks", "notes", "pending_folds"].every((t) => tables.includes(t)), "checkmarks, notes and pending_folds exist");
  const taskCols = readDb(sb.dbFile, "PRAGMA table_info(tasks)").map((c) => c.name);
  for (const col of ["status", "doc", "files_dir", "updated", "next_json", "awaiting"]) {
    check(!taskCols.includes(col), `tasks has no ${col} column`);
  }
  const phaseCols = readDb(sb.dbFile, "PRAGMA table_info(phases)").map((c) => c.name);
  for (const col of ["status", "owner", "branch", "plan_path", "landed_sha", "started", "completed"]) {
    check(!phaseCols.includes(col), `phases has no ${col} column`);
  }
  const decisionCols = readDb(sb.dbFile, "PRAGMA table_info(decisions)").map((c) => c.name);
  for (const col of ["transition", "error", "consumed_at", "consumed_by"]) {
    check(!decisionCols.includes(col), `decisions has no ${col} column`);
  }
  check(["gate", "plan_hash"].every((c) => decisionCols.includes(c)), "decisions carries gate and plan_hash");
  const bak = sb.dbFile + ".v1.bak";
  const bakDb = new DatabaseSync(bak, { readOnly: true });
  check(Number(bakDb.prepare("SELECT version FROM schema_version").get().version) === 1
    && bakDb.prepare("PRAGMA quick_check").get().quick_check === "ok", "the .v1.bak opens as v1 and passes quick_check");
  bakDb.close();
  const tmps = fs.readdirSync(path.dirname(sb.dbFile)).filter((n) => n.includes(".v1.bak.tmp."));
  check(tmps.length === 0, "no .v1.bak.tmp.* remains");
}

// ---------------------------------------------------------------------------
// The installed-engine rule (C2): the home default migrates only under the installed engine
// ---------------------------------------------------------------------------
{
  // no current, no AGENTS_DB: refuse, byte-identical, no -wal, no .bak
  const sb = sandbox();
  const homeDb = seedHomeV1(sb.home);
  const before = fs.readFileSync(homeDb);
  const shaBefore = require("crypto").createHash("sha256").update(before).digest("hex");
  const env = { ...sb.env };
  for (const k of ["AGENTS_DB", "AGENTS_TASKS_ROOT", "AGENTS_SESSIONS_ROOT", "AGENTS_TEST_SKIP_IDENTITY"]) delete env[k];
  env.HOME = sb.home;
  const r = runChild(env);
  check(r.status === 2 && r.stderr.includes("./install.sh") && r.stderr.includes(REPO), `no current: exits 2 naming ./install.sh and the engine (${r.status}: ${r.stderr.trim().split("\n")[0]})`);
  const shaAfter = require("crypto").createHash("sha256").update(fs.readFileSync(homeDb)).digest("hex");
  check(shaAfter === shaBefore, "the v1 file is byte-identical after the refusal");
  check(!fs.existsSync(homeDb + "-wal") && !fs.existsSync(homeDb + ".v1.bak"), "no -wal and no .v1.bak appears");
  // the same with AGENTS_DB pointing at the home default, and with a dangling current
  const r2 = runChild({ ...env, AGENTS_DB: homeDb });
  check(r2.status === 2 && r2.stderr.includes("./install.sh"), "AGENTS_DB at the home default: the same refusal");
  fs.mkdirSync(path.join(sb.home, ".agents", "bin"), { recursive: true });
  fs.symlinkSync(path.join(sb.base, "no-such-snapshot"), path.join(sb.home, ".agents", "bin", "current"));
  const r3 = runChild(env);
  check(r3.status === 2 && r3.stderr.includes("./install.sh"), "a dangling current counts as not installed");

  // current → the checkout: the same command migrates
  fs.rmSync(path.join(sb.home, ".agents", "bin", "current"));
  fs.symlinkSync(REPO, path.join(sb.home, ".agents", "bin", "current"));
  const r4 = runChild(env);
  check(r4.status === 0 && Number(readDb(homeDb, "SELECT version FROM schema_version")[0].version) === 2
    && fs.existsSync(homeDb + ".v1.bak"), `current → the checkout: the engine migrates (${r4.status}: ${r4.stderr.trim().split("\n").pop()})`);

  // Y5: AGENTS_DB at a v1 file with a HOME without .agents never throws on the path comparison
  const sb2 = sandbox();
  seedV1(sb2);
  const r5 = runChild(sb2.env);
  check(r5.status === 0, `a HOME without .agents and a v1 AGENTS_DB elsewhere: no throw, it migrates (${r5.status}: ${r5.stderr.trim().split("\n").pop()})`);

  // no file at the home default: a fresh database is created, never migrated
  const sb3 = sandbox();
  const env3 = { ...sb.env };
  for (const k of ["AGENTS_DB", "AGENTS_TASKS_ROOT", "AGENTS_SESSIONS_ROOT", "AGENTS_TEST_SKIP_IDENTITY"]) delete env3[k];
  env3.HOME = sb3.home;
  const r6 = runChild(env3);
  const freshDb = path.join(sb3.home, ".agents", "agents.db");
  check(r6.status === 0 && fs.existsSync(freshDb) && Number(readDb(freshDb, "SELECT version FROM schema_version")[0].version) === 2,
    "no file at the home default: a fresh v2 database, no throw");
}

// ---------------------------------------------------------------------------
// Interrupted after the backup (D3)
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  const first = spawnSync("node", [A, "ls", "--json"], {
    env: { ...childEnv(sb.env), AGENTS_TEST_MIGRATE_EXIT_AFTER: "backup" }, encoding: "utf8", timeout: 60000,
  });
  check(first.status === 9, `the interrupted child exits 9 after linking the backup (${first.status})`);
  const bak = sb.dbFile + ".v1.bak";
  const firstBytes = fs.readFileSync(bak);
  const second = runChild(sb.env);
  check(second.status === 0 && Number(readDb(sb.dbFile, "SELECT version FROM schema_version")[0].version) === 2,
    `the second child migrates (${second.status}: ${second.stderr.trim().split("\n").pop()})`);
  check(fs.readFileSync(bak).equals(firstBytes), "the first .v1.bak is byte-identical to what the first child left");
  const stamped = fs.readdirSync(path.dirname(sb.dbFile)).filter((n) => /\.v1\.bak\.\d{8}T\d{6}Z$/.test(n));
  check(stamped.length === 1 && second.stderr.includes(stamped[0]), `a stamped second backup exists and stderr named it (${stamped.join(", ")})`);
  const bakDb = new DatabaseSync(path.join(path.dirname(sb.dbFile), stamped[0]), { readOnly: true });
  check(Number(bakDb.prepare("SELECT version FROM schema_version").get().version) === 1
    && bakDb.prepare("PRAGMA quick_check").get().quick_check === "ok", "the stamped backup opens as v1 and passes quick_check");
  bakDb.close();
  check(fs.readdirSync(path.dirname(sb.dbFile)).filter((n) => n.includes(".v1.bak.tmp.")).length === 0, "no .v1.bak.tmp.* remains");
}

// ---------------------------------------------------------------------------
// The backup's own refusal survives the wrapper: a copy that fails the health
// check surfaces bad_v1_backup_copy, not the generic v1_backup_failed
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  const r = runChild(sb.env); // a fresh file opens as schema 2, no migration
  check(r.status === 0 && Number(readDb(sb.dbFile, "SELECT version FROM schema_version")[0].version) === 2,
    `the backup-refusal case opens its file as schema 2 (${r.status})`);
  const migrate = require(path.join(LIB, "db-migrate"));
  process.env.AGENTS_DB = sb.dbFile; // the db lib reads the root per open, so point it here
  const dbLib = require(path.join(LIB, "db"));
  const conn = dbLib.open({ create: true });
  let err = null;
  try { migrate.takeBackup(conn, sb.dbFile); } catch (e) { err = e; }
  dbLib.close();
  check(err && err.code === "bad_v1_backup_copy" && /healthy schema-1 database/.test(err.message)
    && /Remedy:/.test(err.message) && err.exitCode === 2,
    `the copy check's refusal keeps its code, message and remedy through the wrapper (${err && err.code}: ${err && err.message.split("\n")[0]})`);
  const leftovers = fs.readdirSync(sb.base).filter((n) => n.includes(".v1.bak"));
  check(leftovers.length === 0, `no .v1.bak or temp file remains (${leftovers.join(", ")})`);
}

// ---------------------------------------------------------------------------
// A backup that fails stops the migration, the file still v1 (D3)
// ---------------------------------------------------------------------------
async function failingBackupCase() {
  const sb = sandbox();
  seedV1(sb);
  // a directory at the temp-backup path, planted while the child waits on the
  // migrate lock, makes the backup's unlink fail: the open names the v1 backup
  const lockDir = sb.dbFile + ".migrate";
  fs.mkdirSync(lockDir);
  const alive = { session_id: "test", pid: process.pid };
  fs.writeFileSync(path.join(lockDir, "holder"), JSON.stringify(alive));
  const child = require("child_process").spawn("node", [A, "ls", "--json"], { env: childEnv(sb.env), stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  check(await waitFor(/waiting for the v1 → v2 migration/, () => err, 15000), "a failing backup: the child waits on the migrate lock first");
  fs.mkdirSync(sb.dbFile + ".v1.bak.tmp." + child.pid);
  fs.writeFileSync(path.join(lockDir, "holder"), JSON.stringify({ session_id: "test", pid: 999999999 })); // a dead holder releases the lock
  const code = await new Promise((r) => child.on("close", r));
  check(code !== 0 && err.includes("v1 backup"), `a failing backup fails the open naming the backup path (${code}: ${err.trim().split("\n").pop().slice(0, 200)})`);
  check(Number(readDb(sb.dbFile, "SELECT version FROM schema_version")[0].version) === 1, "the file is still v1");
}

// ---------------------------------------------------------------------------
// Foreign keys (D7): every v1 decision survives with its id; a planted violation rolls back
// ---------------------------------------------------------------------------
async function foreignKeysCase() {
  const sb = sandbox();
  seedV1(sb);
  const r = runChild(sb.env);
  check(r.status === 0, `the seeded migration succeeds (${r.status})`);
  const v1 = new DatabaseSync(sb.dbFile + ".v1.bak", { readOnly: true });
  const v1Decisions = v1.prepare("SELECT decision_id, task_id, phase_id, choice, quote, decided_at FROM decisions ORDER BY decision_id").all();
  v1.close();
  const v2Decisions = readDb(sb.dbFile, "SELECT decision_id, task_id, phase_id, choice, quote, decided_at FROM decisions ORDER BY decision_id");
  check(JSON.stringify(v1Decisions) === JSON.stringify(v2Decisions.slice(0, v1Decisions.length)),
    "every v1 decision row is present with the same id, task, phase, choice, quote and decided_at");
  check(readDb(sb.dbFile, "SELECT id FROM tasks").every((row) => row.id >= 1), "every tasks row keeps its id");
  const probe = new DatabaseSync(sb.dbFile);
  probe.exec("PRAGMA foreign_keys=ON");
  check(probe.prepare("PRAGMA foreign_key_check").all().length === 0, "PRAGMA foreign_key_check prints nothing");
  probe.close();

  // a planted violation: a decision whose task has no row rolls the migration back
  const sb2 = sandbox();
  seedV1(sb2, `INSERT INTO decisions (decision_id, task_id, phase_id, choice, quote, decided_at) VALUES (90, 999, 1, 'answer', 'x', '2026-10-01T00:00:00.000Z');`);
  const r2 = runChild(sb2.env);
  check(r2.status !== 0 && /foreign_key_check|backup/.test(r2.stderr), `the planted violation fails the open (${r2.status}: ${r2.stderr.trim().split("\n").pop().slice(0, 90)})`);
  check(Number(readDb(sb2.dbFile, "SELECT version FROM schema_version")[0].version) === 1, "the violated file is still v1");
}

// ---------------------------------------------------------------------------
// The stored statuses convert (checkmarks, skips, approves); duplicates and bad rows survive
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  runChild(sb.env);
  // task 1 (001-every-status) carries every status once
  const marks = readDb(sb.dbFile, "SELECT phase_id, checked_at FROM checkmarks WHERE task_id = 1 ORDER BY phase_id");
  check(JSON.stringify(marks.map((m) => m.phase_id)) === JSON.stringify([1, 2, 3]),
    "committed, landed and done get exactly one checkmark each; skipped, descoped, failed, approved, in_progress, implemented and not_started get none");
  const decisions = readDb(sb.dbFile, "SELECT phase_id, choice, recorded_by FROM decisions WHERE task_id = 1 ORDER BY decision_id");
  check(decisions.filter((d) => d.choice === "skip").map((d) => d.phase_id).join() === "4,5"
    && decisions.every((d) => d.choice !== "skip" || d.recorded_by === "migration"), "skipped and descoped get one migration skip decision each");
  check(decisions.filter((d) => d.choice === "approve").map((d) => d.phase_id).join() === "7,8,9"
    && decisions.every((d) => d.choice !== "approve" || d.recorded_by === "migration"), "approved, in_progress and implemented get one migration approve each");
  check(decisions.filter((d) => d.phase_id === 6).length === 0, "failed gets nothing and reads open");
  // task 3's skipped phase already has a skip decision: no second row
  const t3 = readDb(sb.dbFile, "SELECT choice, recorded_by FROM decisions WHERE task_id = 3");
  check(t3.length === 1 && t3[0].recorded_by === "owner-session", "a phase already carrying a skip decision gets nothing more");
  // a nameless phase keeps its NULL name; blocked_by becomes after
  const names = readDb(sb.dbFile, "SELECT phase_id, name, after FROM phases WHERE task_id = 1 ORDER BY phase_id");
  check(names[9].name === "Not started" && JSON.parse(names[9].after).join() === "", "phases carry name and after");
  const notes = readDb(sb.dbFile, "SELECT phase_id, text FROM notes WHERE task_id = 2");
  check(notes.length === 1 && notes[0].text === "sits in the repo folder", "a doc's phases[].note becomes one notes row");
  const knobs = readDb(sb.dbFile, "SELECT approvals, land FROM tasks WHERE id = 1");
  check(knobs[0].approvals === "ask" && knobs[0].land === "per_phase", "knobs land in their columns");
  const knob2 = readDb(sb.dbFile, "SELECT approvals, land FROM tasks WHERE id = 2");
  check(knob2[0].approvals === null && knob2[0].land === null, "absent knobs become NULL (migrated)");
  const branch = readDb(sb.dbFile, "SELECT branch FROM tasks WHERE id = 1");
  check(branch[0].branch === "wt/001", "the first non-empty phases[].branch becomes tasks.branch");
  const fold = readDb(sb.dbFile, "SELECT path FROM pending_folds WHERE task_id = 2");
  check(fold.length === 1 && fold[0].path === "/work/acme/one/.tasks/002-fold", "a files_dir that differs from task_dir gets one pending_folds row");
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM pending_folds WHERE task_id = 1")[0].n === 0, "equal paths get no fold row");
}

// ---------------------------------------------------------------------------
// Duplicate ids and bad rows never abort the migration
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  const dup = {
    schema: 2, slug: "dup", number: 9, title: "Dup", status: "planning", mode: "full", tier: "standard", knobs: {},
    phases: [{ id: 3, name: "a", status: "planned", blocked_by: [] }, { id: 3, name: "b", status: "planned", blocked_by: [] }],
    worktree_path: "", created: "2026-10-01", updated: "2026-10-01T10:00:00.000Z",
  };
  const bad = { not: "json" };
  const taskDir4 = path.join(sb.tasks, "github.com/acme/one", "004-dup");
  fs.mkdirSync(taskDir4, { recursive: true });
  const taskDir5 = path.join(sb.tasks, "github.com/acme/one", "005-bad");
  fs.mkdirSync(taskDir5, { recursive: true });
  seedV1(sb, `
    INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
      VALUES (4, 'github.com/acme/one', '004-dup', 'active', '${taskDir4}', '${taskDir4}', 'dup', 4, 'Dup', 'planning', 'standard', 'full', '2026-10-01', '2026-10-01T10:00:00.000Z', '${JSON.stringify(dup).replace(/'/g, "''")}');
    INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
      VALUES (5, 'github.com/acme/one', '005-bad', 'active', '${taskDir5}', '${taskDir5}', 'bad', 5, 'Bad', 'planning', 'standard', 'full', '2026-10-01', '2026-10-01T10:00:00.000Z', '${JSON.stringify(bad).replace(/'/g, "''").replace(/"/g, '\\"').slice(1, -1)}');
    INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
      VALUES (6, 'github.com/acme/one', '006-bad-phase', 'active', '${path.join(sb.tasks, "github.com/acme/one", "006-bad-phase")}', '${path.join(sb.tasks, "github.com/acme/one", "006-bad-phase")}', 'badphase', 6, 'BadPhase', 'planning', 'standard', 'full', '2026-10-01', '2026-10-01T10:00:00.000Z', '{"schema":2,"slug":"bp","phases":[{"id":"x","name":"X","status":"planned","blocked_by":[]}],"updated":"2026-10-01T10:00:00.000Z"}');
  `);
  const r = runChild(sb.env);
  check(r.status === 0, `duplicate ids and bad rows never abort the migration (${r.status}: ${r.stderr.trim().split("\n").pop()})`);
  const dup3 = readDb(sb.dbFile, "SELECT phase_id, name FROM phases WHERE task_id = 4");
  check(dup3.length === 1 && dup3[0].name === "a", "a doc with two phases of id 3 keeps the first and drops the rest");
  const dupDetail = readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 4 AND kind = 'migrate'");
  check(/duplicate phase id 3/.test(dupDetail[0].detail), "the migrate event names the dropped duplicate");
  const badRow = readDb(sb.dbFile, "SELECT count(*) AS n FROM phases WHERE task_id = 5");
  check(readDb(sb.dbFile, "SELECT id FROM tasks WHERE id = 5").length === 1 && badRow[0].n === 0, "a bad doc keeps its row with no phases");
  check(/does not parse/.test(readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 5 AND kind = 'migrate'")[0].detail), "its migrate event carries the skipped reason");
  const badPhase = readDb(sb.dbFile, "SELECT count(*) AS n FROM phases WHERE task_id = 6");
  check(badPhase[0].n === 0 && /integer id/.test(readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 6 AND kind = 'migrate'")[0].detail),
    "a phase with a non-integer id is absent and its migrate event says why");
}

// ---------------------------------------------------------------------------
// Plan hashes: an approve decided after the plan's mtime binds to its body hash
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  const taskDir = path.join(sb.tasks, "github.com/acme/one", "007-hash");
  fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(taskDir, "plan", "phase-1-a.md"), "# Plan A\n\n- [ ] one\n");
  const early = new Date(Date.now() - 7200_000).toISOString();
  const late = new Date(Date.now() - 600_000).toISOString();
  const doc = {
    schema: 2, slug: "hash", number: 7, title: "Hash", status: "in_progress", mode: "full", tier: "standard",
    knobs: {}, phases: [{ id: 1, name: "One", status: "in_progress", blocked_by: [] }], worktree_path: "",
    created: "2026-10-01", updated: late,
  };
  fs.writeFileSync(path.join(taskDir, "plan", "phase-1-a.md"), "# Plan A\n\n- [ ] one\n");
  const mid = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(taskDir, "plan", "phase-1-a.md"), mid, mid);
  seedV1(sb, `
    INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
      VALUES (7, 'github.com/acme/one', '007-hash', 'active', '${taskDir}', '${taskDir}', 'hash', 7, 'Hash', 'in_progress', 'standard', 'full', '2026-10-01', '${late}', '${JSON.stringify(doc).replace(/'/g, "''")}');
    INSERT INTO decisions (decision_id, task_id, phase_id, choice, quote, recorded_by, decided_at)
      VALUES (10, 7, 1, 'approve', 'after the plan', 'owner', '${late}'), (11, 7, 1, 'reject', 'before the plan', 'owner', '${early}');
    INSERT INTO phases (task_id, ord, phase_id, name, status) VALUES (7, 0, 1, 'One', 'in_progress');
  `);
  const r = runChild(sb.env);
  check(r.status === 0, `the plan-hash migration succeeds (${r.status}: ${r.stderr.trim().split("\n").pop()})`);
  const rows = readDb(sb.dbFile, "SELECT decision_id, plan_hash FROM decisions WHERE task_id = 7 ORDER BY decision_id");
  const { planHash } = require(path.join(LIB, "derive"));
  const expected = planHash(fs.readFileSync(path.join(taskDir, "plan", "phase-1-a.md"), "utf8"));
  check(rows[0].plan_hash === expected, "an approve decided after the plan's mtime carries the plan's body hash");
  check(rows[1].plan_hash === null, "a reject decided before the plan's mtime carries NULL and reads approved stale");
}

// ---------------------------------------------------------------------------
// The landing rules over a fixture repo listed direct
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  const repo = makeRepo(sb, "direct-repo");
  const goneKey = "github.com/acme/gone";
  const goneRoot = path.join(sb.base, "gone");
  listPolicy(sb, { [repo]: "direct", [goneRoot]: "direct" });
  // a stored landing on base
  const head = git(repo, "rev-parse", "HEAD");
  allCheckedTask(sb, { id: 10, dirName: "010-stored", mainRoot: repo, landedShas: [head] });
  // a stored landing off base
  git(repo, "checkout", "-q", "-b", "off");
  fs.writeFileSync(path.join(repo, "off.txt"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "off base");
  const offHead = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main"); // off stays local: not on origin/main
  allCheckedTask(sb, { id: 11, dirName: "011-off", mainRoot: repo, landedShas: [offHead] });
  // a recorded landing on base, two tokens on two lines
  const withDate = (date, ...args) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: date }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const c1 = withDate("2026-10-01T10:00:00", "commit-tree", `${head}^{tree}`, "-p", head, "-m", "recorded one");
  const c2 = withDate("2026-10-01T11:00:00", "commit-tree", `${head}^{tree}`, "-p", c1, "-m", "recorded two");
  git(repo, "update-ref", "refs/heads/recorded-branch", c2);
  git(repo, "push", "-q", "origin", "recorded-branch:main"); // both commits are now on origin/main
  const rec = allCheckedTask(sb, { id: 12, dirName: "012-recorded", mainRoot: repo, statuses: ["done"] });
  fs.writeFileSync(path.join(rec.taskDir, "task.md"), `# Rec\n\nCommitted: ${c1.slice(0, 10)}\n\nCommits: ${c2.slice(0, 12)} and ${c1.slice(0, 8)}\n`);
  // a missing checkout: its own repo key whose main root is gone
  allCheckedTask(sb, { id: 13, dirName: "013-no-checkout", mainRoot: goneRoot, repoKey: goneKey, landedShas: [head] });
  // update the repos rows so the migrator can find the main roots
  const db = new DatabaseSync(sb.dbFile);
  db.prepare("UPDATE repos SET main_root = ?, doc = ? WHERE key = 'github.com/acme/one'")
    .run(repo, JSON.stringify({ main_root: repo, last_seen: "2026-10-01T00:00:00.000Z" }));
  db.prepare("INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, 2, ?, '{}', '2026-10-01T00:00:00.000Z')")
    .run(goneKey, goneRoot);
  db.close();

  const r = runChild(sb.env);
  check(r.status === 0, `the landing migration succeeds (${r.status}: ${r.stderr.trim().split("\n").pop()})`);

  // stored on base: one land event, detail head+migrated
  const land = readDb(sb.dbFile, "SELECT at, detail FROM events WHERE task_id = 10 AND kind = 'land'");
  check(land.length === 1 && JSON.parse(land[0].detail).head === head && JSON.parse(land[0].detail).migrated === true,
    "a stored landing commit on origin/main becomes one land event with head and migrated");
  // the derived read through the verb: landed, proof push, task_status done
  const lsTask = (name) => {
    const dir = path.join(sb.tasks, "github.com/acme/one", name);
    const r = runChild(sb.env, ["task", "read", "--task-dir", dir, "--json"]);
    try { return JSON.parse(r.stdout); } catch { return { error: r.status, stderr: r.stderr }; }
  };
  const read10 = lsTask("010-stored");
  check(read10.task_status === "done" && read10.landing && read10.landing.state === "landed" && read10.landing.proof === "push",
    `a task read --json reads landed, proof push, task_status done (${JSON.stringify(read10.landing)} ${read10.task_status})`);
  // off base: no land event, the reason in the migrate event
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 11 AND kind = 'land'")[0].n === 0, "a stored commit off base writes no land event");
  const m11 = readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 11 AND kind = 'migrate'");
  check(JSON.parse(m11[0].detail).landing === "not on base", "its migrate event records not on base");
  const read11 = lsTask("011-off");
  check(read11.task_status === "open" && read11.landing && read11.landing.state === "unresolved" && read11.landing.reason === "no land record",
    `a task read shows the off-base task unresolved (no land record) (${JSON.stringify(read11.landing)} ${read11.task_status})`);
  // recorded: a candidate in the migrate event, no land event
  const m12 = readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 12 AND kind = 'migrate'");
  const cand = JSON.parse(m12[0].detail).recorded;
  const noLand12 = readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 12 AND kind = 'land'")[0].n === 0;
  check(cand && cand.file === "task.md" && cand.head === c2 && noLand12,
    `the recorded rule records a candidate (head the newer by committer time) and writes no land event (cand ${cand ? JSON.stringify(cand).slice(0, 80) : "none"})`);
  check(cand && cand.lines.length === 2 && cand.lines[0].line === 3 && cand.lines[1].tokens.length === 2,
    "every matching line is listed with its number, text and tokens");
  // missing checkout
  const m13 = readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 13 AND kind = 'migrate'");
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 13 AND kind = 'land'")[0].n === 0
    && JSON.parse(m13[0].detail).landing === "no checkout", `a missing main_root gives no land event and the reason no checkout (${m13[0] ? m13[0].detail.slice(0, 80) : "no event"})`);

  // git failed: a main root that is no git repository (the sandbox shape)
  const sb2 = sandbox();
  seedV1(sb2);
  const fake = path.join(sb2.base, "fake-repo");
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, ".tasks"), "");
  listPolicy(sb2, { [fake]: "direct" });
  allCheckedTask(sb2, { id: 10, dirName: "010-stored", mainRoot: fake, landedShas: [head] });
  const db2 = new DatabaseSync(sb2.dbFile);
  db2.prepare("UPDATE repos SET main_root = ?, doc = ? WHERE key = 'github.com/acme/one'")
    .run(fake, JSON.stringify({ main_root: fake, last_seen: "2026-10-01T00:00:00.000Z" }));
  db2.close();
  const r2 = runChild(sb2.env);
  const m10b = readDb(sb2.dbFile, "SELECT detail FROM events WHERE task_id = 10 AND kind = 'migrate'");
  check(r2.status === 0 && readDb(sb2.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 10 AND kind = 'land'")[0].n === 0
    && JSON.parse(m10b[0].detail).landing === "git failed",
    `a main root that is not a git repository records git failed, no land event (${r2.status})`);
}

// ---------------------------------------------------------------------------
// The scope of the landing rules (E2): active, all-checked, direct only
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  const repo = makeRepo(sb, "scope-repo");
  const second = makeRepo(sb, "scope-unlisted");
  listPolicy(sb, { [repo]: "direct" });
  const head = git(repo, "rev-parse", "HEAD");
  allCheckedTask(sb, { id: 20, dirName: "020-in-scope", mainRoot: repo, landedShas: [head] });
  // not all checked: one phase in_progress, task.md names a commit
  const partial = allCheckedTask(sb, { id: 21, dirName: "021-partial", mainRoot: repo, statuses: ["done", "in_progress"] });
  fs.writeFileSync(path.join(partial.taskDir, "task.md"), `Committed: ${head.slice(0, 10)}\n`);
  const db = new DatabaseSync(sb.dbFile);
  db.prepare("UPDATE repos SET main_root = ?, doc = ? WHERE key = 'github.com/acme/one'")
    .run(repo, JSON.stringify({ main_root: repo, last_seen: "2026-10-01T00:00:00.000Z" }));
  // archived and deleted all-checked with a stored commit
  const arch = allCheckedTask(sb, { id: 22, dirName: "022-archived", mainRoot: repo, landedShas: [head] });
  const del = allCheckedTask(sb, { id: 23, dirName: "023-deleted", mainRoot: repo, landedShas: [head] });
  db.exec(`UPDATE tasks SET disposition = 'archived' WHERE id = 22; UPDATE tasks SET disposition = 'deleted' WHERE id = 23;`);
  // an unlisted repo's all-checked task with a stored commit
  const unKey = "github.com/acme/unlisted";
  fs.mkdirSync(path.join(sb.tasks, unKey, "024-unlisted"), { recursive: true });
  const db2 = new DatabaseSync(sb.dbFile);
  const unDoc = { schema: 2, slug: "u", number: 24, title: "U", status: "done", mode: "full", tier: "standard", knobs: {}, phases: [{ id: 1, name: "One", status: "done", landed_sha: head, blocked_by: [] }], worktree_path: "", created: "2026-10-01", updated: "2026-10-01T00:00:00.000Z" };
  db2.prepare(`INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
    VALUES (24, ?, '024-unlisted', 'active', ?, ?, 'u', 24, 'U', 'done', 'standard', 'full', '2026-10-01', '2026-10-01T00:00:00.000Z', ?)`)
    .run(unKey, path.join(sb.tasks, unKey, "024-unlisted"), path.join(sb.tasks, unKey, "024-unlisted"), JSON.stringify(unDoc));
  db2.prepare("INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, 1, ?, '{}', '2026-10-01T00:00:00.000Z')").run(unKey, second);
  db2.close();
  const r = runChild(sb.env);
  check(r.status === 0, `the scope migration succeeds (${r.status})`);
  const lands = readDb(sb.dbFile, "SELECT task_id FROM events WHERE kind = 'land'");
  const candidates = readDb(sb.dbFile, "SELECT detail FROM events WHERE kind = 'migrate' AND detail LIKE '%recorded%'");
  check(lands.length === 1 && lands[0].task_id === 20, `only the in-scope task gets a land event (${JSON.stringify(lands)})`);
  check(candidates.length === 0, "no candidate for the not-all-checked, archived, deleted or unlisted tasks");
}

// ---------------------------------------------------------------------------
// Orphans: a central task.json with no row is adopted; sandbox checks apply
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  const orphanDir = path.join(sb.tasks, "github.com/acme/one", "008-orphan");
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphan = {
    schema: 2, slug: "orphan", number: 8, title: "Orphan", status: "in_progress", mode: "full", tier: "standard",
    knobs: { approvals: "ask" }, phases: [{ id: 3, name: "a", status: "in_progress", blocked_by: [] }, { id: 3, name: "b", status: "planned", blocked_by: [] }],
    worktree_path: "", created: "2026-10-01", updated: "2026-10-01T10:00:00.000Z",
  };
  fs.writeFileSync(path.join(orphanDir, "task.json"), JSON.stringify(orphan, null, 2));
  const r = runChild(sb.env);
  check(r.status === 0, `the orphan adoption succeeds (${r.status}: ${r.stderr.trim().split("\n").pop()})`);
  const row = readDb(sb.dbFile, "SELECT id, title, approvals FROM tasks WHERE dir_name = '008-orphan'");
  check(row.length === 1 && row[0].title === "Orphan" && row[0].approvals === "ask", "an orphan central task.json gets a row");
  const oPhases = readDb(sb.dbFile, `SELECT phase_id, name FROM phases WHERE task_id = ${row[0].id}`);
  check(oPhases.length === 1 && oPhases[0].name === "a", "the orphan's duplicate ids keep the first");
  const oApprove = readDb(sb.dbFile, `SELECT choice, recorded_by FROM decisions WHERE task_id = ${row[0].id}`);
  check(oApprove.length === 1 && oApprove[0].choice === "approve" && oApprove[0].recorded_by === "migration", "the orphan's in_progress phase gets an approve row");

  // in a sandbox, adopted paths outside the root are stored NULL
  const sb2 = sandbox();
  seedV1(sb2);
  const outside = path.join(`${sb2.base}-other`, "wt", "orphan2");
  fs.mkdirSync(path.join(`${sb2.base}-other`, "wt"), { recursive: true });
  fs.mkdirSync(path.join(sb2.tasks, "github.com/acme/one", "009-orphan2"), { recursive: true });
  const orphan2 = {
    schema: 2, slug: "orphan2", number: 9, title: "Orphan2", status: "planning", mode: "full", tier: "standard",
    knobs: {}, phases: [], worktree_path: outside, files_dir: path.join(`${sb2.base}-other`, "fold"),
    created: "2026-10-01", updated: "2026-10-01T10:00:00.000Z",
  };
  fs.writeFileSync(path.join(sb2.tasks, "github.com/acme/one", "009-orphan2", "task.json"), JSON.stringify(orphan2, null, 2));
  const r2 = runChild(sb2.env);
  const row2 = readDb(sb2.dbFile, "SELECT id, worktree_path FROM tasks WHERE dir_name = '009-orphan2'");
  const folds = readDb(sb2.dbFile, `SELECT path FROM pending_folds WHERE task_id = ${row2[0].id}`);
  const det = readDb(sb2.dbFile, `SELECT detail FROM events WHERE task_id = ${row2[0].id} AND kind = 'migrate'`);
  check(row2.length === 1 && row2[0].worktree_path === null, "an adopted worktree_path outside the sandbox root is stored NULL");
  check(folds.length === 0, `no pending_folds row for an outside files_dir (${JSON.stringify(folds)})`);
  check(/outside sandbox: /.test(det[0].detail), "the migrate event names the outside paths");
}

// ---------------------------------------------------------------------------
// Concurrency (C13): B waits without throwing, one backup, migrated once
// ---------------------------------------------------------------------------
function waitFile(p, ms = 30000) {
  const t0 = Date.now();
  while (!fs.existsSync(p) && Date.now() - t0 < ms) {
    try { execFileSync("/bin/sleep", ["0.05"]); } catch { /* keep polling */ }
  }
  return fs.existsSync(p);
}

/** Wait until `re` matches the accumulated stream text, letting events fire between checks. */
async function waitFor(re, getText, ms = 20000) {
  const t0 = Date.now();
  while (!re.test(getText()) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return re.test(getText());
}

async function concurrencyCase() {
  const sb = sandbox();
  seedV1(sb);
  const bar = path.join(sb.base, "bar");
  fs.mkdirSync(bar);
  const procA = require("child_process").spawn("node", [A, "ls", "--json"], {
    env: { ...childEnv(sb.env), AGENTS_TEST_MIGRATE_BARRIER: bar }, stdio: ["ignore", "pipe", "pipe"],
  });
  check(waitFile(path.join(bar, "in-tx")), "interleaved: A sits inside its transaction holding the migrate lock");
  const B = require("child_process").spawn("node", [A, "ls", "--json"], {
    env: childEnv(sb.env), stdio: ["ignore", "pipe", "pipe"],
  });
  let bErr = "";
  B.stderr.on("data", (d) => { bErr += d; });
  check(await waitFor(/waiting for the v1 → v2 migration held by pid \d+/, () => bErr),
    `interleaved: B prints it is waiting, no LockHeldError (${bErr.trim().split("\n")[0]})`);
  await new Promise((r) => setTimeout(r, 2600)); // past MAX_WAIT_MS: B must not throw
  fs.writeFileSync(path.join(bar, "release"), "");
  const [ac, bc] = await Promise.all([
    new Promise((r) => procA.on("close", r)),
    new Promise((r) => B.on("close", r)),
  ]);
  check(ac === 0 && bc === 0, `interleaved: both exit 0 (A ${ac}, B ${bc})`);
  check(fs.readdirSync(path.dirname(sb.dbFile)).filter((n) => n.includes(".v1.bak")).length === 1, "interleaved: one backup");
  const migN = readDb(sb.dbFile, "SELECT count(*) AS n FROM decisions WHERE recorded_by = 'migration'")[0].n;
  check(migN === 5, `interleaved: the data is migrated once (no duplicate decisions) (got ${migN})`);
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE kind = 'migrate' AND task_id IS NOT NULL")[0].n === 3,
    "interleaved: one migrate event per task, no duplicates");
}

// ---------------------------------------------------------------------------
// Git before the write lock: with a counting wrapper, every git call precedes in-tx
// ---------------------------------------------------------------------------
async function gitBeforeLockCase() {
  const sb = sandbox();
  seedV1(sb);
  const repo = makeRepo(sb, "count-repo");
  listPolicy(sb, { [repo]: "direct" });
  const head = git(repo, "rev-parse", "HEAD");
  allCheckedTask(sb, { id: 30, dirName: "030-count", mainRoot: repo, landedShas: [head] });
  const db = new DatabaseSync(sb.dbFile);
  db.prepare("UPDATE repos SET main_root = ?, doc = ? WHERE key = 'github.com/acme/one'")
    .run(repo, JSON.stringify({ main_root: repo, last_seen: "2026-10-01T00:00:00.000Z" }));
  db.close();
  const bar = path.join(sb.base, "bar4");
  fs.mkdirSync(bar);
  const bin = path.join(sb.base, "bin");
  fs.mkdirSync(bin);
  const gitLog = path.join(bar, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(gitLog)}\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const child = require("child_process").spawn("node", [A, "ls", "--json"], {
    env: { ...childEnv(sb.env), AGENTS_TEST_MIGRATE_BARRIER: bar, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  check(waitFile(path.join(bar, "in-tx")), "git-before-lock: the migrator reaches its transaction");
  const duringTx = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8") : "";
  // the child parks at the barrier inside its transaction: no git may run while it holds
  await new Promise((r) => setTimeout(r, 400));
  const stillHeld = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8") : "";
  fs.writeFileSync(path.join(bar, "release"), "");
  const code = await new Promise((r) => child.on("close", r));
  check(code === 0, `git-before-lock: the migration exits 0 (${code})`);
  check(duringTx.split("\n").filter(Boolean).length > 0, "git-before-lock: every git call of the migration ran before the transaction");
  check(duringTx === stillHeld, "git-before-lock: no git call ran inside the transaction");
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 30 AND kind = 'land'")[0].n === 1, "git-before-lock: the stored landing was recorded");
}

// ---------------------------------------------------------------------------
// A doc changed during the migration: no landing, changed during migration
// ---------------------------------------------------------------------------
async function changedDuringMigrationCase() {
  const sb = sandbox();
  seedV1(sb);
  const repo = makeRepo(sb, "change-repo");
  listPolicy(sb, { [repo]: "direct" });
  const head = git(repo, "rev-parse", "HEAD");
  allCheckedTask(sb, { id: 31, dirName: "031-changed", mainRoot: repo, landedShas: [head] });
  const db = new DatabaseSync(sb.dbFile);
  db.prepare("UPDATE repos SET main_root = ?, doc = ? WHERE key = 'github.com/acme/one'")
    .run(repo, JSON.stringify({ main_root: repo, last_seen: "2026-10-01T00:00:00.000Z" }));
  db.close();
  const bar = path.join(sb.base, "bar5");
  fs.mkdirSync(bar);
  fs.writeFileSync(path.join(bar, "stop-pre-tx"), "");
  const child = require("child_process").spawn("node", [A, "ls", "--json"], {
    env: { ...childEnv(sb.env), AGENTS_TEST_MIGRATE_BARRIER: bar }, stdio: ["ignore", "pipe", "pipe"],
  });
  check(waitFile(path.join(bar, "pre-tx")), "changed-during: the migrator waits at the pre-tx stop after the git pre-pass");
  const v1Row = readDb(sb.dbFile, "SELECT doc FROM tasks WHERE id = 31")[0];
  const changed = JSON.parse(v1Row.doc);
  changed.updated = "2026-10-02T10:00:00.000Z";
  const mut = new DatabaseSync(sb.dbFile);
  mut.prepare("UPDATE tasks SET doc = ? WHERE id = 31").run(JSON.stringify(changed));
  mut.close();
  fs.writeFileSync(path.join(bar, "release-pre-tx"), "");
  const code = await new Promise((r) => child.on("close", r));
  fs.writeFileSync(path.join(bar, "release"), "");
  check(code === 0, `changed-during: the migration completes (${code})`);
  check(readDb(sb.dbFile, "SELECT count(*) AS n FROM events WHERE task_id = 31 AND kind = 'land'")[0].n === 0,
    "changed-during: a task whose doc changed gets no land event");
  const det = readDb(sb.dbFile, "SELECT detail FROM events WHERE task_id = 31 AND kind = 'migrate'")[0].detail;
  check(JSON.parse(det).landing === "changed during migration", "changed-during: its migrate event records changed during migration");
}

// ---------------------------------------------------------------------------
// Holder-less locks: fresh is not reclaimable, 11 s old is
// ---------------------------------------------------------------------------
{
  const { canReclaim, HOLDERLESS_GRACE_MS } = require(path.join(LIB, "lock"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-lockgrace-"));
  const fresh = path.join(dir, "fresh");
  fs.mkdirSync(fresh);
  check(canReclaim(fresh) === false, "a holder-less lock created now is not reclaimable");
  const old = new Date(Date.now() - HOLDERLESS_GRACE_MS - 1000);
  fs.utimesSync(fresh, old, old);
  check(canReclaim(fresh) === true, "a holder-less lock past the grace is reclaimable");
}

// ---------------------------------------------------------------------------
// An M1 replay on a v2 file: the re-assert leaves a fresh v2 shape, rows intact
// ---------------------------------------------------------------------------
{
  const sb = sandbox();
  seedV1(sb);
  runChild(sb.env);
  const before = readDb(sb.dbFile, "SELECT id, repo_key, dir_name, title, approvals, land FROM tasks ORDER BY id");
  // today's v1 DDL and addColumns, each statement run, errors tolerated
  const v1 = new DatabaseSync(sb.dbFile);
  const v1Ddl = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8")
    .replace(/\$TASKS_ROOT/g, sb.tasks)
    .split(";\n").map((l) => l.trim()).filter((l) => l.startsWith("CREATE "));
  for (const stmt of v1Ddl) {
    try { v1.exec(stmt); } catch { /* tolerated, as an M1 a leaves it */ }
  }
  for (const stmt of ["ALTER TABLE runs ADD COLUMN requested_model TEXT", "ALTER TABLE tasks ADD COLUMN next_json TEXT", "ALTER TABLE tasks ADD COLUMN awaiting TEXT"]) {
    try { v1.exec(stmt); } catch { /* tolerated */ }
  }
  v1.close();
  const r = runChild(sb.env);
  check(r.status === 0, `a v2 open after the M1 replay succeeds (${r.status}: ${r.stderr.trim().split("\n").pop()})`);
  const fresh = sandbox();
  seedV1(fresh);
  runChild(fresh.env);
  const colsOf = (file, table) => readDb(file, `PRAGMA table_info(${table})`).map((c) => c.name).sort();
  const tablesOf = (file) => readDb(file, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name).sort();
  const idxOf = (file) => readDb(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((t) => t.name).sort();
  let same = true;
  for (const t of tablesOf(fresh.dbFile)) {
    if (tablesOf(sb.dbFile).includes(t) && JSON.stringify(colsOf(sb.dbFile, t)) !== JSON.stringify(colsOf(fresh.dbFile, t))) same = false;
  }
  check(tablesOf(sb.dbFile).join() === tablesOf(fresh.dbFile).join() && same, "the replayed file's tables and columns equal a fresh v2 file's");
  check(JSON.stringify(idxOf(sb.dbFile)) === JSON.stringify(idxOf(fresh.dbFile)), "the replayed file's indexes equal a fresh v2 file's");
  const after = readDb(sb.dbFile, "SELECT id, repo_key, dir_name, title, approvals, land FROM tasks ORDER BY id");
  check(JSON.stringify(before) === JSON.stringify(after), "every row is intact after the re-assert");
}

async function main() {
  await failingBackupCase();
  await foreignKeysCase();
  await concurrencyCase();
  await gitBeforeLockCase();
  await changedDuringMigrationCase();
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
