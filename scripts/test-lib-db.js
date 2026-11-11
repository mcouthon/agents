#!/usr/bin/env node
"use strict";

// agents.db: the always-on database, the schema, the doctor and backup lines.
// Every scenario runs in its own temp HOME and roots.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

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

// A1: a fresh database has the v2 schema, WAL mode, the busy timeout, and prints nothing
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
    "  cols: Object.fromEntries(c.all(\"SELECT name FROM sqlite_master WHERE type = 'table'\").map((t) =>",
    "    [t.name, c.all('PRAGMA table_info(' + JSON.stringify(t.name) + ')').map((r) => r.name)])),",
    "}));",
  ].join("\n");
  const r = spawnSync("node", ["-e", probe], { env: sb.env, encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  check(out.mode === "wal", "A1: journal mode is wal");
  check(out.busy === 5000, "A1: busy timeout is 5000");
  check(out.versions.length === 1 && out.versions[0].version === 2, "A1: exactly one schema_version row, 2");
  check(["checkmarks", "events", "notes", "pending_folds", "phases", "repos", "sessions", "tasks", "decisions"]
    .every((t) => out.tables.includes(t)), "A1: the v2 tables exist");
  const banned = ["status", "files_dir", "updated", "next_json", "awaiting", "plan_path", "landed_sha", "started", "completed"];
  const stored = [
    ...Object.entries(out.cols).flatMap(([table, cols]) => cols.filter((n) => banned.includes(n)).map((n) => `${table}.${n}`)),
    ...(out.cols.tasks || []).includes("doc") ? ["tasks.doc"] : [],
  ];
  check(stored.length === 0, `A1: no table names a stored status or a v1 projection (${stored.join(", ")})`);
  check(!["runs", "reports", "checkpoints"].some((t) => out.tables.includes(t)), "A1: runs, reports and checkpoints do not exist");
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

// A3: the database is always on — the first write creates it
{
  const sb = sandbox();
  const dir = createTask(sb);
  check(fs.existsSync(sb.dbFile), "A3: the first task write creates the database");
  check(sb.readDb("SELECT count(*) AS n FROM tasks")[0].n === 1, "A3: the row is there");
  check(!fs.existsSync(path.join(dir, "task.json")), "A3: no task.json is written anywhere");
  check(fs.existsSync(path.join(dir, "task.md")), "A3: the task's Markdown sits centrally");
}

// A4: the writers land in the tables with their events
{
  const sb = sandbox();
  const dir = createTask(sb, { slug: "demo", phases: 2 });
  sb.cli(["task", "set", "--task-dir", dir, "--knob", "land", "--value", "at_end"]);
  const rows = sb.readDb("SELECT * FROM tasks");
  check(rows.length === 1 && rows[0].land === "at_end" && rows[0].approvals === "none", "A4: the row carries the knobs (approvals none for a new task)");
  const phases = sb.readDb("SELECT phase_id, name, after FROM phases ORDER BY ord");
  check(phases.length === 2 && phases[0].phase_id === 1 && JSON.parse(phases[1].after).join() === "", "A4: phases rows carry after");
  const kinds = sb.readDb("SELECT kind FROM events ORDER BY id").map((r) => r.kind);
  check(kinds.includes("task_new") && kinds.includes("knob"), `A4: the intent events are appended (${kinds.join(",")})`);
  const r = sb.cli(["task", "check", "--task-dir", dir, "--phase-id", "1"]);
  check(r.status === 0 && sb.readDb("SELECT count(*) AS n FROM checkmarks")[0].n === 1, "A4: a task check writes one checkmark");
  check(sb.readDb("SELECT kind FROM events WHERE kind = 'check'").length === 1, "A4: the check appends its event");
}

// A5: a session registration is stored byte for byte
{
  const sb = sandbox();
  const r = sb.cli(["session", "register", "--session-id", "s1", "--agent", "conductor", "--cwd", sb.repo]);
  check(r.status === 0, `A5: session register succeeds (${r.status} ${r.stderr})`);
  const file = path.join(sb.env.AGENTS_SESSIONS_ROOT, "s1", "registration.json");
  const rows = sb.readDb("SELECT doc FROM sessions WHERE session_id = 's1'");
  check(rows.length === 1 && rows[0].doc === readJson(file), "A5: sessions row equals registration.json");
}

// A6: tasks doctrine stores its tiers in the repos table (the one repos store)
{
  const sb = sandbox();
  const r = sb.cli(["tasks", "doctrine", '{"default":"standard"}']);
  check(r.status === 0, `A6: tasks doctrine succeeds (${r.status} ${r.stderr})`);
  check(!fs.existsSync(path.join(sb.env.AGENTS_TASKS_ROOT, "index.json")), "A6: no index.json is written");
  const key = sb.readDb("SELECT key FROM repos")[0].key;
  const doc = JSON.parse(sb.readDb("SELECT doc FROM repos WHERE key = ?", key)[0].doc);
  check(doc.default_tiers && doc.default_tiers.default === "standard", "A6: the repos row carries the doctrine");
}

// A7: closing a done minor task marks its row archived
{
  const sb = sandbox();
  const dir = createTask(sb);
  sb.cli(["task", "check", "--task-dir", dir, "--phase-id", "1"]);
  const r = sb.cli(["task", "close", "--task-dir", dir]);
  check(r.status === 0, `A7: task close succeeds (${r.status} ${r.stderr})`);
  check(sb.readDb("SELECT disposition FROM tasks")[0].disposition === "archived", "A7: row disposition is archived");
  check(sb.readDb("SELECT kind FROM events WHERE kind = 'close'").length === 1, "A7: the close appends its event");
}

// A8: a file that is not a database fails the write loudly and writes nothing else
{
  const sb = sandbox();
  fs.writeFileSync(sb.dbFile, "this is not a database file at all");
  const r = sb.cli(["ls"], { json: false });
  check(r.status !== 0, "A8: the read exits non-zero");
  check(readJson(sb.dbFile) === "this is not a database file at all", "A8: the file is byte-unchanged");
  check(r.stderr.includes(sb.dbFile), `A8: stderr names the database path (${r.stderr.trim().split("\n")[0].slice(0, 90)})`);
}

// A9: a database from a newer schema refuses writes
{
  const sb = sandbox();
  sb.createDb();
  const dir = createTask(sb, { slug: "one" });
  const d = new DatabaseSync(sb.dbFile);
  d.exec("UPDATE schema_version SET version = 3");
  d.close();
  const r = sb.cli(["task", "set", "--task-dir", dir, "--knob", "land", "--value", "at_end"], { json: false });
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
  check(doctor.info.db.backup_age_hours !== null && doctor.info.db.backup_age_hours < 1, "A10: doctor reports a backup under an hour old (info.db)");
  const tracked = execFileSync("git", ["ls-files"], { cwd: sb.env.AGENTS_TASKS_ROOT, encoding: "utf8" });
  check(!/agents\.db/.test(tracked), `A10: git snapshot tracks no agents.db files (${tracked.split("\n").filter((f) => /agents\.db/.test(f)).join(",")})`);
}

// A11: a dir trashed outside closeTask is deleted in the database and stays gone
{
  const sb = sandbox();
  const dir = createTask(sb);
  const key = path.basename(path.dirname(dir));
  const probe = `require(${JSON.stringify(path.join(SCRIPTS, "lib", "trash"))}).trashDir(${JSON.stringify(dir)}, ${JSON.stringify(key)})`;
  execFileSync("node", ["-e", probe], { env: sb.env });
  check(sb.readDb("SELECT disposition FROM tasks")[0].disposition === "deleted", "A11: trashed task row is deleted");
  // check() and exportInPlace() resolve their database from the environment,
  // so they must run under sb.env — in-process they read the real machine's.
  const exportLib = path.join(SCRIPTS, "lib", "db-export");
  const exportProbe = (fn) => `console.log(JSON.stringify(require(${JSON.stringify(exportLib)}).${fn}()))`;
  const chk = JSON.parse(execFileSync("node", ["-e", exportProbe("check")], { env: sb.env, encoding: "utf8" }));
  check(chk.equal, `A11: export check passes (${JSON.stringify(chk.diffs || [])})`);
  execFileSync("node", ["-e", exportProbe("exportInPlace")], { env: sb.env });
  check(!fs.existsSync(dir), "A11: export does not recreate the trashed dir");
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
  check(r.status !== 0 && r.stderr.includes("refusing"), `A12: a write with only HOME set fails refusing the home default (${r.status})`);
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
  const info = JSON.parse(r.stdout).info.db;
  check(info.present === false && !fs.existsSync(sb2.dbFile), "A13: doctor reports db.present false and creates no file (info.db)");
}

// A14: doctor knows node:sqlite works, and package.json pins the node floor
{
  const sb = sandbox();
  const info = JSON.parse(sb.cli(["doctor"]).stdout).info.db;
  check(info.node_ok === true, "A14: doctor reports db.node_ok true (info.db)");
  const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", "package.json"), "utf8"));
  check(pkg.engines && pkg.engines.node === ">=22.5", "A14: package.json engines.node is >=22.5");
}

// A15: a v1 database migrates on the first open (the runs/reports/checkpoints tables go)
{
  const sb = sandbox();
  const seed = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8").replace(/\$TASKS_ROOT/g, sb.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(path.join(sb.env.AGENTS_TASKS_ROOT, "github.com", "acme", "one"), { recursive: true });
  const old = new DatabaseSync(sb.dbFile);
  old.exec("PRAGMA foreign_keys=OFF");
  old.exec(seed);
  old.close();
  const r = sb.cli(["next", "--task-dir", createTask(sb, { slug: "second" })]);
  check(r.status === 0, `A15: the first open migrates the v1 file (${r.status})`);
  check(Number(sb.readDb("SELECT version FROM schema_version")[0].version) === 2, "A15: the schema version is 2");
  check(sb.readDb("SELECT name FROM sqlite_master WHERE name = 'runs'").length === 0, "A15: runs is gone");
  const slugs = sb.readDb("SELECT slug FROM tasks ORDER BY slug").map((t) => t.slug).join();
  check(slugs === "every-status,fold,second,skipped-with-decision", `A15: the seeded tasks are still there (${slugs})`);
  check(fs.existsSync(sb.dbFile + ".v1.bak"), "A15: the backup sits beside the file");
}

// A18: doctor names the repos the roster leaves out — a gone main_root holding
// no active task — one action row each with the purge remedy; a gone root with
// an active task is not named.
{
  const sb = sandbox();
  sb.createDb();
  const goneRoot = path.join(sb.base, "gone-a");
  const movedRoot = path.join(sb.base, "gone-b");
  const movedTaskDir = path.join(sb.env.AGENTS_TASKS_ROOT, "github.com", "acme", "moved", "001-moved");
  fs.mkdirSync(movedTaskDir, { recursive: true });
  fs.writeFileSync(path.join(movedTaskDir, "task.md"), "# Moved\n");
  const opts = { repoKey: "github.com/acme/moved", dirName: "001-moved", taskDir: movedTaskDir, slug: "001-moved",
    number: 1, title: "Moved", tier: "standard", mode: "full", created: "2026-11-01", approvals: "none", land: "per_phase",
    worktreePath: null, branch: null, phases: [{ id: 1, name: "One" }] };
  const seed = `const db = require(${JSON.stringify(DB_LIB)}); db.open({ create: true });
    db.upsertRepo("github.com/acme/gone", { main_root: ${JSON.stringify(goneRoot)} });
    db.upsertRepo("github.com/acme/moved", { main_root: ${JSON.stringify(movedRoot)} });
    db.createTaskRow(${JSON.stringify(opts)});`;
  const seeded = spawnSync("node", ["-e", seed], { env: sb.env, encoding: "utf8" });
  check(seeded.status === 0, `A18: the gone repos seed cleanly (${seeded.status}, ${(seeded.stderr || "").slice(0, 120)})`);
  const doc = JSON.parse(sb.cli(["doctor"]).stdout);
  const named = (doc.actions || []).filter((a) => a.text.startsWith("repo "));
  check(named.length === 1 && named[0].text === `repo github.com/acme/gone (${goneRoot} gone)` && named[0].remedy === "purge: a doctor --clean",
    `A18: doctor names the task-less gone repo as an action row with the purge remedy, not the one holding an active task (${JSON.stringify(named)})`);
}

// A19: deleteRepo removes the repos row, appends a repos.write event counting
// -1, and leaves the sibling task, session and event rows untouched.
{
  const sb = sandbox();
  sb.createDb();
  const goneRoot = path.join(sb.base, "gone-c");
  const taskDir = path.join(sb.env.AGENTS_TASKS_ROOT, "github.com", "acme", "delete", "001-delete");
  fs.mkdirSync(taskDir, { recursive: true });
  const opts = { repoKey: "github.com/acme/delete", dirName: "001-delete", taskDir, slug: "001-delete",
    number: 1, title: "Delete", tier: "standard", mode: "full", created: "2026-11-01", approvals: "none", land: "per_phase",
    worktreePath: null, branch: null, phases: [{ id: 1, name: "One" }] };
  const seed = `const db = require(${JSON.stringify(DB_LIB)}); db.open({ create: true });
    db.upsertRepo("github.com/acme/delete", { main_root: ${JSON.stringify(goneRoot)} });
    db.upsertRepo("github.com/acme/stays", { main_root: ${JSON.stringify(sb.repo)} });
    db.createTaskRow(${JSON.stringify(opts)});
    db.upsertSession("e1", JSON.stringify({ session_id: "s1", repo_key: "github.com/acme/delete", agent: "conductor",
      created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }));`;
  const seeded = spawnSync("node", ["-e", seed], { env: sb.env, encoding: "utf8" });
  check(seeded.status === 0, `A19: the delete seed runs cleanly (${seeded.status}, ${(seeded.stderr || "").slice(0, 120)})`);
  const before = sb.readDb("SELECT count(*) AS n FROM events")[0].n;
  const del = `const db = require(${JSON.stringify(DB_LIB)}); db.open({ create: true });
    db.deleteRepo("github.com/acme/delete");`;
  const deleted = spawnSync("node", ["-e", del], { env: sb.env, encoding: "utf8" });
  check(deleted.status === 0, `A19: deleteRepo exits 0 (${deleted.status}, ${(deleted.stderr || "").slice(0, 120)})`);
  check(sb.readDb("SELECT key FROM repos ORDER BY key").map((r) => r.key).join(",") === "github.com/acme/stays",
    "A19: the gone row is deleted and the sibling row stays");
  check(sb.readDb("SELECT count(*) AS n FROM tasks")[0].n === 1, "A19: the deleted repo's task row stays");
  check(sb.readDb("SELECT session_id FROM sessions").map((r) => r.session_id).join(",") === "s1",
    "A19: the deleted repo's session row stays");
  const events = sb.readDb("SELECT kind, detail FROM events ORDER BY id");
  check(JSON.stringify(events[events.length - 1]) === JSON.stringify({ kind: "repos.write", detail: '{"repos":-1}' }),
    `A19: the last event is a repos.write counting -1 (${JSON.stringify(events[events.length - 1])})`);
  check(events.length === before + 1, `A19: exactly one event is appended (${before} -> ${events.length})`);
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
  // A16: two openers of a fresh database do not fight over the schema
  {
    const sb = sandbox();
    sb.createDb();
    const holder = new DatabaseSync(sb.dbFile);
    holder.exec("PRAGMA busy_timeout=5000");
    holder.exec("BEGIN IMMEDIATE");
    const second = runNode(sb, `const d = require(${JSON.stringify(DB_LIB)}); const c = d.open(); c.get("SELECT version FROM schema_version")`);
    await sleep(1500);
    holder.exec("COMMIT");
    holder.close();
    const r = await second;
    check(r.status === 0, `A16: an ordinary open finishes while a writer holds the lock (${r.status}, ${r.stderr.trim().split("\n").pop()})`);
  }

  // A17: an interrupted migration is completed by the next open (D3), one backup each attempt
  {
    const sb = sandbox();
    const seed = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8").replace(/\$TASKS_ROOT/g, sb.env.AGENTS_TASKS_ROOT);
    fs.mkdirSync(path.join(sb.env.AGENTS_TASKS_ROOT, "github.com", "acme", "one"), { recursive: true });
    const old = new DatabaseSync(sb.dbFile);
    old.exec("PRAGMA foreign_keys=OFF");
    old.exec(seed);
    old.close();
    const first = spawnSync("node", ["-e",
      `process.env.AGENTS_TEST_MIGRATE_EXIT_AFTER = "backup"; require(${JSON.stringify(DB_LIB)}).open();`],
      { env: sb.env, encoding: "utf8" });
    check(first.status === 9, `A17: the interrupted child exits 9 after the backup (${first.status})`);
    const second = runNode(sb, `require(${JSON.stringify(DB_LIB)}).open()`);
    await sleep(1000);
    const r = await second;
    check(r.status === 0, `A17: the next open completes the migration (${r.status})`);
    check(fs.readdirSync(path.dirname(sb.dbFile)).filter((n) => n.includes(".v1.bak")).length === 2,
      "A17: two backups exist, one per attempt");
  }
}

lockingCases().then(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
});
