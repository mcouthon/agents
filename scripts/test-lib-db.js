#!/usr/bin/env node
"use strict";

// agents.db: the gate, the DB-first write through the CLI, and the doctor and
// backup lines. Every scenario runs in its own temp HOME and roots.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { renderStateMdText } = require("./lib/render");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

const SCRIPTS = __dirname;
const CLI = path.join(SCRIPTS, "bin", "a");
const DB_LIB = path.join(SCRIPTS, "lib", "db");
const created = [];

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

function sandbox({ withDbEnv = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-dbtest-")));
  created.push(base);
  const env = {
    ...process.env,
    HOME: path.join(base, "home"),
    AGENTS_TASKS_ROOT: path.join(base, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(base, "sessions"),
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com",
  };
  if (withDbEnv) env.AGENTS_DB = path.join(base, "agents.db");
  else delete env.AGENTS_DB;
  delete env.AGENTS_SESSION_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.AGENTS_TASKS_ROOT, { recursive: true });
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const sb = { base, env, repo };
  sb.dbFile = env.AGENTS_DB || path.join(env.AGENTS_TASKS_ROOT, ".agents.db");
  sb.cli = (args, { json = true, input } = {}) => {
    const full = [CLI, ...args, "--repo", repo];
    if (json) full.push("--json");
    const r = spawnSync("node", full, { env, encoding: "utf8", input, timeout: 30000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  sb.createDb = () => execFileSync("node", ["-e", `require(${JSON.stringify(DB_LIB)}).open({create:true})`], { env });
  sb.readDb = (sql, ...params) => {
    const d = new DatabaseSync(sb.dbFile, { readOnly: true });
    try { return d.prepare(sql).all(...params); } finally { d.close(); }
  };
  return sb;
}

function createTask(sb, { slug = "demo", fast = true, phases = 1 } = {}) {
  const defs = JSON.stringify(Array.from({ length: phases }, (_, i) => ({ id: i + 1, name: `P${i + 1}` })));
  const args = ["task", "create", "--title", slug, "--slug", slug, "--phases-json", defs];
  if (fast) args.push("--mode", "fast", "--tier", "minor");
  const r = sb.cli(args);
  if (r.status !== 0) throw new Error(`task create failed: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout).task_dir;
}

function readJson(file) { return fs.readFileSync(file, "utf8"); }

// A1: a fresh database has the schema, WAL mode, the busy timeout, and prints nothing
{
  const sb = sandbox();
  const probe = [
    `const db = require(${JSON.stringify(DB_LIB)});`,
    "const c = db.open({ create: true });",
    "console.log(JSON.stringify({",
    "  mode: c.get('PRAGMA journal_mode').journal_mode,",
    "  busy: c.get('PRAGMA busy_timeout').timeout,",
    "  versions: c.all('SELECT version FROM schema_version'),",
    "  tables: c.all(\"SELECT name FROM sqlite_master WHERE type = 'table'\").map((r) => r.name).sort(),",
    "}));",
  ].join("\n");
  const r = spawnSync("node", ["-e", probe], { env: sb.env, encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  check(out.mode === "wal", "A1: journal mode is wal");
  check(out.busy === 5000, "A1: busy timeout is 5000");
  check(out.versions.length === 1 && out.versions[0].version === 1, "A1: exactly one schema_version row, 1");
  check(["checkpoints", "events", "phases", "repos", "reports", "runs", "sessions", "tasks"]
    .every((t) => out.tables.includes(t)), "A1: the eight tables exist");
  check(r.stderr === "", `A1: nothing printed to stderr (got ${JSON.stringify(r.stderr)})`);
  check((fs.statSync(sb.dbFile).mode & 0o777) === 0o600, "A1: database file is mode 0600");
}

// A2: the path follows the root overrides, then the home default
{
  const probe = `console.log(require(${JSON.stringify(DB_LIB)}).dbPath())`;
  const run = (env) => spawnSync("node", ["-e", probe], { env, encoding: "utf8" });
  const bare = { ...process.env };
  for (const k of ["AGENTS_DB", "AGENTS_TASKS_ROOT", "AGENTS_SESSIONS_ROOT", "AGENTS_TEST_SKIP_IDENTITY"]) delete bare[k];
  check(run({ ...bare, AGENTS_TASKS_ROOT: "/tmp/agents-a2/tasks" }).stdout.trim() === "/tmp/agents-a2/tasks/.agents.db",
    "A2: tasks root override puts the database inside it");
  check(run({ ...bare, AGENTS_SESSIONS_ROOT: "/tmp/agents-a2/sessions" }).stdout.trim() === "/tmp/agents-a2/sessions/.agents.db",
    "A2: sessions root override is used when it is the only one");
  check(run({ ...bare, AGENTS_DB: "/tmp/agents-a2/x.db", AGENTS_TASKS_ROOT: "/tmp/agents-a2/tasks" }).stdout.trim() === "/tmp/agents-a2/x.db",
    "A2: AGENTS_DB wins over the roots");
  check(run({ ...bare, HOME: "/tmp/agents-a2-home" }).stdout.trim() === "/tmp/agents-a2-home/.agents/agents.db",
    "A2: with no overrides the database is <HOME>/.agents/agents.db");
}

// A3: with no database file nothing creates one
{
  const sb = sandbox();
  const dir = createTask(sb);
  const r = sb.cli(["state", "update", "--task-dir", dir, "--phase-id", "1", "--phase-status", "in_progress"]);
  check(r.status === 0, "A3: state update works without a database");
  check(!fs.existsSync(sb.dbFile), "A3: no database file appears after create and update");
  check(fs.existsSync(path.join(dir, "task.json")), "A3: task.json is written as before");
}

// A4: with a database, task writes land in it and match the files
{
  const sb = sandbox();
  sb.createDb();
  const dir = createTask(sb, { slug: "demo", phases: 2 });
  sb.cli(["state", "update", "--task-dir", dir, "--phase-id", "1", "--phase-status", "in_progress"]);
  fs.mkdirSync(path.join(dir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan", "p.md"), "# p\n");
  const rep = sb.cli(["report", "--task-dir", dir, "--phase-id", "1", "--agent", "explorer"],
    { input: JSON.stringify({ plan_path: "plan/p.md", manifest: ["a.js"], open_questions: [], summary: "s" }) });
  const cp = sb.cli(["checkpoint", "open", "--task-dir", dir, "--phase-id", "1", "--type", "approve", "--question", "Go?"]);
  check(rep.status === 0 && cp.status === 0, `A4: report and checkpoint succeed (${rep.status}, ${cp.status})`);

  const text = readJson(path.join(dir, "task.json"));
  const rows = sb.readDb("SELECT * FROM tasks");
  check(rows.length === 1 && rows[0].doc === text, "A4: tasks.doc is byte-equal to task.json");
  const phases = sb.readDb("SELECT phase_id, status FROM phases ORDER BY ord");
  const onDisk = JSON.parse(text).phases.map((p) => ({ phase_id: p.id, status: p.status }));
  check(JSON.stringify(phases) === JSON.stringify(onDisk) && phases.length === 2, "A4: phases rows carry the on-disk statuses");
  check(sb.readDb("SELECT agent FROM reports").map((r) => r.agent).join() === "explorer", "A4: one explorer report row");
  check(sb.readDb("SELECT count(*) AS n FROM checkpoints")[0].n === 1, "A4: one checkpoint row");
  check(sb.readDb("SELECT count(*) AS n FROM events WHERE kind = 'task.write'")[0].n >= 4, "A4: at least 4 task.write events");
  check(readJson(path.join(dir, "state.md")) === renderStateMdText(JSON.parse(text)), "A4: state.md is current with task.json");
}

// A5: a session registration is stored byte for byte
{
  const sb = sandbox();
  sb.createDb();
  const r = sb.cli(["session", "register", "--session-id", "s1", "--agent", "conductor", "--cwd", sb.repo]);
  check(r.status === 0, `A5: session register succeeds (${r.status} ${r.stderr})`);
  const file = path.join(sb.env.AGENTS_SESSIONS_ROOT, "s1", "registration.json");
  const rows = sb.readDb("SELECT doc FROM sessions WHERE session_id = 's1'");
  check(rows.length === 1 && rows[0].doc === readJson(file), "A5: sessions row equals registration.json");
}

// A6: root index entries are mirrored into repos
{
  const sb = sandbox();
  sb.createDb();
  const r = sb.cli(["tasks", "doctrine", '{"default":"standard"}']);
  check(r.status === 0, `A6: tasks doctrine succeeds (${r.status} ${r.stderr})`);
  const index = JSON.parse(readJson(path.join(sb.env.AGENTS_TASKS_ROOT, "index.json")));
  const key = Object.keys(index)[0];
  const rows = sb.readDb("SELECT doc FROM repos WHERE key = ?", key);
  check(rows.length === 1 && JSON.stringify(JSON.parse(rows[0].doc)) === JSON.stringify(index[key]),
    "A6: repos row matches the index.json entry");
}

// A7: closing a done minor task marks its row archived
{
  const sb = sandbox();
  sb.createDb();
  const dir = createTask(sb);
  sb.cli(["state", "update", "--task-dir", dir, "--phase-id", "1", "--phase-status", "skipped"]);
  const r = sb.cli(["task", "close", "--task-dir", dir]);
  check(r.status === 0, `A7: task close succeeds (${r.status} ${r.stderr})`);
  check(sb.readDb("SELECT disposition FROM tasks")[0].disposition === "archived", "A7: row disposition is archived");
}

// A8: a file that is not a database fails the write loudly and leaves task.json alone
{
  const sb = sandbox();
  const dir = createTask(sb);
  const before = readJson(path.join(dir, "task.json"));
  fs.writeFileSync(sb.dbFile, "this is not a database file at all");
  const r = sb.cli(["state", "update", "--task-dir", dir, "--phase-id", "1", "--phase-status", "in_progress"], { json: false });
  check(r.status !== 0, "A8: state update exits non-zero");
  check(readJson(path.join(dir, "task.json")) === before, "A8: task.json is byte-unchanged");
  check(r.stderr.includes(sb.dbFile), "A8: stderr names the database path");
}

// A9: a database from a newer schema refuses writes
{
  const sb = sandbox();
  sb.createDb();
  const dir = createTask(sb);
  const d = new DatabaseSync(sb.dbFile);
  d.exec("UPDATE schema_version SET version = 2");
  d.close();
  const r = sb.cli(["state", "update", "--task-dir", dir, "--phase-id", "1", "--phase-status", "in_progress"], { json: false });
  check(r.status !== 0 && r.stderr.includes("newer than this `a`"), "A9: write fails with the newer-schema message");
}

// A10: backup of the database, its age in doctor, and the git snapshot ignoring it
{
  const sb = sandbox({ withDbEnv: false });
  sb.createDb();
  createTask(sb, { slug: "one" });
  check(sb.cli(["tasks", "backup", "--init"]).status === 0, "A10: backup --init succeeds");
  createTask(sb, { slug: "two" });
  const first = JSON.parse(sb.cli(["tasks", "backup"]).stdout);
  const bak = sb.dbFile + ".bak";
  check(first.db_backup && first.db_backup.backed_up === true && fs.existsSync(bak), "A10: first backup writes agents.db.bak");
  const mtime = fs.statSync(bak).mtimeMs;
  const second = JSON.parse(sb.cli(["tasks", "backup"]).stdout);
  check(second.db_backup.backed_up === false && fs.statSync(bak).mtimeMs === mtime, "A10: second backup leaves the young .bak alone");
  const doctor = JSON.parse(sb.cli(["doctor"]).stdout);
  check(doctor.db.backup_age_hours !== null && doctor.db.backup_age_hours < 1, "A10: doctor reports a backup under an hour old");
  const tracked = execFileSync("git", ["ls-files"], { cwd: sb.env.AGENTS_TASKS_ROOT, encoding: "utf8" });
  check(!/agents\.db/.test(tracked), `A10: git snapshot tracks no agents.db files (${tracked.split("\n").filter((f) => /agents\.db/.test(f)).join(",")})`);
}

// A11: a dir trashed outside closeTask is deleted in the database and stays gone
{
  const sb = sandbox();
  sb.createDb();
  const dir = createTask(sb);
  const key = path.basename(path.dirname(dir));
  const probe = `require(${JSON.stringify(path.join(SCRIPTS, "lib", "trash"))}).trashDir(${JSON.stringify(dir)}, ${JSON.stringify(key)})`;
  execFileSync("node", ["-e", probe], { env: sb.env });
  check(sb.readDb("SELECT disposition FROM tasks")[0].disposition === "deleted", "A11: trashed task row is deleted");
  const chk = sb.cli(["export", "--check"]);
  check(chk.status === 0, `A11: export --check exits 0 (${chk.status} ${chk.stdout})`);
  const exp = sb.cli(["export"]);
  check(exp.status === 0 && !fs.existsSync(dir), "A11: export does not recreate the trashed dir");
}

// A12: under the test identity flag the home default is refused and never opened
{
  const sb = sandbox();
  const env = { ...sb.env, HOME: path.join(sb.base, "home") };
  delete env.AGENTS_DB;
  delete env.AGENTS_TASKS_ROOT;
  delete env.AGENTS_SESSIONS_ROOT;
  const homeDb = path.join(env.HOME, ".agents", "agents.db");
  fs.mkdirSync(path.dirname(homeDb), { recursive: true });
  fs.writeFileSync(homeDb, "garbage that would fail loudly if opened");
  const probe = spawnSync("node", ["-e", `require(${JSON.stringify(DB_LIB)}).dbPath()`], { env, encoding: "utf8" });
  check(probe.status !== 0 && probe.stderr.includes("refusing"), "A12: dbPath refuses the home default");
  const r = spawnSync("node", [CLI, "task", "create", "--title", "t", "--slug", "t", "--repo", sb.repo, "--json"], { env, encoding: "utf8" });
  check(r.status === 0, `A12: a write with only HOME set still succeeds (${r.status} ${r.stderr})`);
  check(fs.readFileSync(homeDb, "utf8") === "garbage that would fail loudly if opened", "A12: the home database file was not touched");
}

// A13: a 0-byte file is a new database; doctor never creates one
{
  const sb = sandbox();
  fs.writeFileSync(sb.dbFile, "");
  createTask(sb);
  check(sb.readDb("SELECT count(*) AS n FROM tasks")[0].n === 1, "A13: 0-byte file was initialised and holds the task");

  const sb2 = sandbox();
  const r = sb2.cli(["doctor"]);
  const info = JSON.parse(r.stdout).db;
  check(info.present === false && !fs.existsSync(sb2.dbFile), "A13: doctor reports db.present false and creates no file");
}

// A14: doctor knows node:sqlite works, and package.json pins the node floor
{
  const sb = sandbox();
  const info = JSON.parse(sb.cli(["doctor"]).stdout).db;
  check(info.node_ok === true, "A14: doctor reports db.node_ok true");
  const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", "package.json"), "utf8"));
  check(pkg.engines && pkg.engines.node === ">=22.5", "A14: package.json engines.node is >=22.5");
}

// A15: a database from before the runs table gains it on the next open, keeps its tasks and stays at version 1
{
  const sb = sandbox();
  sb.createDb();
  createTask(sb);
  const old = new DatabaseSync(sb.dbFile);
  old.exec("DROP TABLE IF EXISTS runs");
  old.close();
  const before = sb.readDb("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'");
  const r = sb.cli(["next", "--task-dir", createTask(sb, { slug: "second" })]);
  const after = sb.readDb("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'");
  check(before.length === 0 && after.length === 1, `A15: the runs table is back after the next open (${r.status})`);
  const slugs = sb.readDb("SELECT slug FROM tasks ORDER BY slug").map((t) => t.slug).join();
  check(slugs === "demo,second", `A15: the task made before the drop is still there (${slugs})`);
  check(sb.readDb("SELECT version FROM schema_version").map((v) => v.version).join() === "1", "A15: the schema version is still 1");
}

// A16: a runs table made before requested_model existed gains the column on open, keeping its rows
{
  const sb = sandbox();
  sb.createDb();
  const old = new DatabaseSync(sb.dbFile);
  old.exec("ALTER TABLE runs DROP COLUMN requested_model");
  old.close();
  const before = sb.readDb("PRAGMA table_info(runs)").map((c) => c.name);
  sb.createDb();
  const after = sb.readDb("PRAGMA table_info(runs)").map((c) => c.name);
  check(!before.includes("requested_model") && after.includes("requested_model"), "A16: the next open adds runs.requested_model");
  check(sb.readDb("SELECT version FROM schema_version").map((v) => v.version).join() === "1", "A16: the schema version is still 1");
}

// A18: a tasks table made before the stored next step gains its two columns on open, keeping its rows
{
  const sb = sandbox();
  sb.createDb();
  createTask(sb, { slug: "kept" });
  const old = new DatabaseSync(sb.dbFile);
  old.exec("ALTER TABLE tasks DROP COLUMN next_json");
  old.exec("ALTER TABLE tasks DROP COLUMN awaiting");
  old.close();
  const before = sb.readDb("PRAGMA table_info(tasks)").map((c) => c.name);
  sb.createDb();
  const after = sb.readDb("PRAGMA table_info(tasks)").map((c) => c.name);
  check(!before.includes("next_json") && !before.includes("awaiting") && after.includes("next_json") && after.includes("awaiting"), "A18: the next open adds tasks.next_json and tasks.awaiting");
  check(sb.readDb("SELECT slug FROM tasks").map((t) => t.slug).join() === "kept" && sb.readDb("SELECT version FROM schema_version").map((v) => v.version).join() === "1", "A18: the task row is kept and the schema version is still 1");
}

// Runs `node -e <code>` against the sandbox's database; resolves { status, stderr, ms }.
function runNode(sb, code) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", ["-e", code], { env: sb.env });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stderr, ms: Date.now() - started }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lockingCases() {
  // A17: two openers of a database without requested_model do not both try to add it
  {
    const sb = sandbox();
    sb.createDb();
    const holder = new DatabaseSync(sb.dbFile);
    holder.exec("PRAGMA busy_timeout=5000");
    holder.exec("ALTER TABLE runs DROP COLUMN requested_model");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("ALTER TABLE runs ADD COLUMN requested_model TEXT");
    const second = runNode(sb, `require(${JSON.stringify(DB_LIB)}).open()`);
    await sleep(1500);
    holder.exec("COMMIT");
    holder.close();
    const r = await second;
    const cols = sb.readDb("PRAGMA table_info(runs)").map((c) => c.name).filter((n) => n === "requested_model");
    check(r.status === 0, `A17: the second opener of a database that was missing the column exits 0 (${r.status} ${r.stderr.trim().split("\n").pop()})`);
    check(cols.length === 1, `A17: requested_model is listed once (${cols.length})`);
  }

  // A19: opening a current database takes no write lock, so a held writer does not stall it
  {
    const sb = sandbox();
    sb.createDb();
    const holder = new DatabaseSync(sb.dbFile);
    holder.exec("BEGIN IMMEDIATE");
    const second = runNode(sb, `const d = require(${JSON.stringify(DB_LIB)}).open(); d.get("SELECT version FROM schema_version")`);
    await sleep(4000);
    holder.exec("COMMIT");
    holder.close();
    const r = await second;
    check(r.status === 0 && r.ms < 2000, `A19: an ordinary open finishes while a writer holds the lock (${r.status}, ${r.ms} ms)`);
  }
}

lockingCases().then(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
});
