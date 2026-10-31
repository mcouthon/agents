#!/usr/bin/env node
"use strict";

// `a task import`: re-index the registration.json files under the sessions
// root into the sessions table. Without `--apply` a dry run that writes
// nothing; with it each entry is upserted. (The fold and the file moves arrive
// with the install-day file step.)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const CLI = path.join(__dirname, "bin", "a");
const created = [];

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-importtest-")));
  created.push(home);
  const tasks = path.join(home, ".agents", "tasks");
  const sessions = path.join(home, ".agents", "sessions");
  put(path.join(sessions, "s-a", "registration.json"), JSON.stringify({ session_id: "s-a", repo_key: "github.com/acme/one", pid: 999999, created_at: "2026-10-01T10:00:00.000Z", agent: "conductor" }, null, 2) + "\n");
  put(path.join(sessions, "s-b", "registration.json"), JSON.stringify({ session_id: "s-b", repo_key: "github.com/acme/one", pid: 999998, created_at: "2026-10-02T10:00:00.000Z", agent: "courier" }, null, 2) + "\n");
  put(path.join(sessions, "s-c", "registration.json"), "{not json");
  put(path.join(sessions, "s-d", "attention.json"), "{}");

  const env = { ...process.env, HOME: home, AGENTS_TASKS_ROOT: tasks, AGENTS_SESSIONS_ROOT: sessions, AGENTS_DB: path.join(home, "agents.db") };
  for (const k of Object.keys(env)) if (k.startsWith("AGENTS_TEST")) delete env[k];
  const fx = { home, tasks, sessions, env, dbFile: env.AGENTS_DB };
  fx.cli = (args, { json = true } = {}) => {
    const r = spawnSync("node", [CLI, ...args, ...(json ? ["--json"] : [])], { env, encoding: "utf8", timeout: 60000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  fx.readDb = (sql) => {
    const d = new DatabaseSync(fx.dbFile, { readOnly: true });
    try { return d.prepare(sql).all(); } finally { d.close(); }
  };
  return fx;
}

const fx = fixture();

// B1: the dry run lists what it would index and writes nothing
{
  const r = fx.cli(["task", "import"]);
  const out = r.json();
  check(r.status === 0, `B1: dry run exits 0 (${r.status} ${r.stderr})`);
  check(out.sessions === 2, `B1: counts the two readable registrations (${out.sessions})`);
  check(out.skipped.length === 1 && out.skipped[0].path.endsWith(path.join("s-c")), "B1: the unparsable registration is skipped with its reason");
  check(!fs.existsSync(fx.dbFile), "B1: no database is created by the dry run");
}

// B2: --apply upserts each entry; re-running changes nothing
{
  const r = fx.cli(["task", "import", "--apply"]);
  check(r.status === 0, `B2: apply exits 0 (${r.status} ${r.stderr})`);
  check(fx.readDb("SELECT count(*) AS n FROM sessions")[0].n === 2, "B2: the database holds the two sessions");
  const doc = fx.readDb("SELECT doc FROM sessions WHERE session_id = 's-a'")[0].doc;
  check(doc === fs.readFileSync(path.join(fx.sessions, "s-a", "registration.json"), "utf8"), "B2: the stored doc is byte-equal to the registration file");
  const again = fx.cli(["task", "import", "--apply"]);
  check(again.status === 0 && fx.readDb("SELECT count(*) AS n FROM sessions")[0].n === 2, "B2: a second apply changes nothing");
  check(fx.readDb("SELECT count(*) AS n FROM events WHERE kind = 'session.write'")[0].n >= 4, "B2: session.write events moved data_version (index writes)");
}

// B3: a registration written after the first apply is picked up by re-running
{
  put(path.join(fx.sessions, "s-e", "registration.json"), JSON.stringify({ session_id: "s-e", repo_key: "github.com/acme/one", pid: 999997, created_at: "2026-10-03T10:00:00.000Z", agent: "conductor" }, null, 2) + "\n");
  const r = fx.cli(["task", "import", "--apply"]);
  check(r.status === 0, `B3: re-run exits 0 (${r.status} ${r.stderr})`);
  check(fx.readDb("SELECT count(*) AS n FROM sessions")[0].n === 3, "B3: the new session is in the database");
}

// B4: the help prints the flags
{
  const i = fx.cli(["task", "import", "--help"], { json: false });
  check(i.status === 0 && i.stdout.includes("--apply"), "B4: task import --help lists --apply");
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
