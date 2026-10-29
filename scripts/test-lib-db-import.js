#!/usr/bin/env node
"use strict";

// `a task import` and `a export` against a fixture laid out like a real
// ~/.agents (default paths under a temp HOME, no root overrides).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

const CLI = path.join(__dirname, "bin", "a");
const created = [];

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

function makeTask(slug, number) {
  return {
    schema: 2, slug, number, title: slug, status: "planning", mode: "full", tier: "standard",
    phases: [{ id: 1, name: "Only", status: "not_started" }],
    checkpoints: [], flags: [],
    created: "2026-10-01T10:00:00.000Z", updated: `2026-10-0${number + 1}T10:00:00.000Z`,
  };
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function putTask(root, rel, task, { trailingNewline = false } = {}) {
  const text = JSON.stringify(task, null, 2) + (trailingNewline ? "\n" : "");
  put(path.join(root, rel, "task.json"), text);
}

function putSession(sessions, id, repoKey) {
  const reg = { session_id: id, repo_key: repoKey, pid: 999999, created_at: "2026-10-01T10:00:00.000Z", agent: "conductor" };
  put(path.join(sessions, id, "registration.json"), JSON.stringify(reg, null, 2) + "\n");
}

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-importtest-")));
  created.push(home);
  const tasks = path.join(home, ".agents", "tasks");
  const sessions = path.join(home, ".agents", "sessions");
  putTask(tasks, "github.com/acme/one/001-plain", makeTask("001-plain", 1));
  putTask(tasks, "github.com/acme/one/002-newline", makeTask("002-newline", 2), { trailingNewline: true });
  put(path.join(tasks, "github.com/acme/one/003-v1/state.json"), JSON.stringify({ phases: [], flags: [] }));
  putTask(tasks, "path-0123abcd/001-stale", makeTask("001-stale", 1));
  putTask(tasks, "archive/github.com/acme/one/000-old", makeTask("000-old", 0));
  put(path.join(tasks, "index.json"), JSON.stringify({
    "github.com/acme/one": { main_root: "/work/one", last_seen: "2026-10-02T10:00:00.000Z" },
    "path-0123abcd": { main_root: "/work/p", last_seen: "2026-10-03T10:00:00.000Z" },
  }, null, 2));
  putSession(sessions, "s-a", "github.com/acme/one");
  putSession(sessions, "s-b", "path-0123abcd");
  put(path.join(sessions, "s-c", "attention.json"), "{}");

  const env = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("AGENTS_")) delete env[k];
  const fx = { home, tasks, sessions, env, dbFile: path.join(home, ".agents", "agents.db") };
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

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function importScratchDirs() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("agents-import-")).length;
}

const fx = fixture();
const before = snapshot(path.join(fx.home, ".agents"));

// B1: the dry run reports the load and writes nothing
{
  const scratchBefore = importScratchDirs();
  const r = fx.cli(["task", "import"]);
  const out = r.json();
  check(r.status === 0, `B1: dry run exits 0 (${r.status} ${r.stderr})`);
  check(out.tasks === 4 && out.sessions === 2 && out.repos === 2, "B1: counts are 4 tasks, 2 sessions, 2 repos");
  check(JSON.stringify(out.by_repo) === JSON.stringify({ "github.com/acme/one": 3, "path-0123abcd": 1 }),
    "B1: by_repo counts the archive under its key");
  check(out.skipped.length === 1 && out.skipped[0].reason === "v1-state-json-only"
    && out.skipped[0].path.endsWith("github.com/acme/one/003-v1"), "B1: the v1 state.json-only dir is skipped with its reason");
  check(out.mismatches.length === 0 && out.errors.length === 0, "B1: no mismatches and no errors");
  check(JSON.stringify(snapshot(path.join(fx.home, ".agents"))) === JSON.stringify(before), "B1: every fixture file is byte-unchanged and nothing new exists");
  check(!fs.existsSync(fx.dbFile) && !fs.existsSync(path.join(fx.home, ".agents", "trash")), "B1: no agents.db and no trash dir");
  check(importScratchDirs() === scratchBefore, "B1: no scratch dir is left in the temp dir");
}

// B2: --apply loads everything, keeps task.json bytes, bundles the originals
let applied;
{
  const r = fx.cli(["task", "import", "--apply"]);
  applied = r.json();
  check(r.status === 0 && applied.refused === false, `B2: apply exits 0 (${r.status} ${r.stderr})`);
  check(fx.readDb("SELECT count(*) AS n FROM tasks")[0].n === 4, "B2: the database holds 4 tasks");
  check(fx.readDb("SELECT count(*) AS n FROM sessions")[0].n === 2, "B2: the database holds 2 sessions");
  const after = snapshot(path.join(fx.home, ".agents"));
  const taskJsons = Object.keys(before).filter((k) => k.endsWith("task.json"));
  check(taskJsons.length === 4 && taskJsons.every((k) => after[k] === before[k]), "B2: every task.json is byte-equal, the trailing-newline one included");
  const bundle = applied.trashed_to;
  check(bundle !== null && fs.readFileSync(path.join(bundle, "github.com/acme/one/002-newline/task.json"), "utf8") === before["tasks/github.com/acme/one/002-newline/task.json"], "B2: bundle holds the original task.json bytes");
  const sessionKeys = Object.keys(before).filter((k) => k.startsWith("sessions/"));
  check(sessionKeys.length === 3 && sessionKeys.every((k) => after[k] === before[k]), "B2: session dirs and their files are untouched");
}

// B3: --check passes after the import and names a file edited behind the database's back
{
  const ok1 = fx.cli(["export", "--check"]);
  check(ok1.status === 0, `B3: export --check exits 0 after the import (${ok1.status} ${ok1.stdout})`);
  const file = path.join(fx.tasks, "github.com/acme/one/001-plain/task.json");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replace("001-plain", "edited-by-hand"));
  const bad = fx.cli(["export", "--check"], { json: false });
  check(bad.status === 1 && bad.stdout.includes("github.com/acme/one/001-plain/task.json"), `B3: a hand edit exits 1 and is named (${bad.status} ${bad.stdout})`);
  fs.writeFileSync(file, original);
}

// B4: --out renders the same tree elsewhere
{
  const out = path.join(fx.home, "out");
  const r = fx.cli(["export", "--out", out]);
  check(r.status === 0, `B4: export --out exits 0 (${r.status} ${r.stderr})`);
  for (const rel of ["github.com/acme/one/001-plain", "path-0123abcd/001-stale", "archive/github.com/acme/one/000-old"]) {
    check(fs.readFileSync(path.join(out, rel, "task.json"), "utf8") === fs.readFileSync(path.join(fx.tasks, rel, "task.json"), "utf8"), `B4: ${rel}/task.json equals the root's`);
  }
}

// B5: a second apply with nothing changed moves nothing
{
  const trashBefore = JSON.stringify(Object.keys(snapshot(path.join(fx.home, ".agents", "trash"))));
  const r = fx.cli(["task", "import", "--apply"]);
  const out = r.json();
  check(r.status === 0 && out.tasks === 4 && out.sessions === 2, "B5: re-run exits 0 with the same counts");
  check(out.trashed_to === null && JSON.stringify(Object.keys(snapshot(path.join(fx.home, ".agents", "trash")))) === trashBefore, "B5: no new trash bundle entries");
}

// B9: writes that landed outside the database are picked up by re-running
{
  putTask(fx.tasks, "github.com/acme/one/004-new", makeTask("004-new", 3));
  putSession(fx.sessions, "s-d", "github.com/acme/one");
  const r = fx.cli(["task", "import", "--apply"]);
  check(r.status === 0, `B9: re-run exits 0 (${r.status} ${r.stderr})`);
  check(fx.readDb("SELECT count(*) AS n FROM tasks")[0].n === 5, "B9: the new task is in the database");
  check(fx.readDb("SELECT count(*) AS n FROM sessions")[0].n === 3, "B9: the new session is in the database");
}

// B6: an unparseable task.json refuses the whole apply
{
  const bad = fixture();
  const file = path.join(bad.tasks, "github.com/acme/one/002-newline/task.json");
  fs.writeFileSync(file, "{not json");
  const r = bad.cli(["task", "import", "--apply"]);
  check(r.status === 1, `B6: apply exits 1 (${r.status})`);
  check(r.stdout.includes("002-newline/task.json"), "B6: the output names the file");
  check(!fs.existsSync(bad.dbFile) && !fs.existsSync(path.join(bad.home, ".agents", "trash")), "B6: no database and no trash bundle exist");
}

// B7: export without a database says how to get one
{
  const none = fixture();
  const r = none.cli(["export"], { json: false });
  check(r.status === 4 && r.stderr.includes("a task import --apply"), `B7: exit 4 with the import hint (${r.status} ${r.stderr})`);
}

// B8: both new commands print their flags
{
  const e = fx.cli(["export", "--help"], { json: false });
  const i = fx.cli(["task", "import", "--help"], { json: false });
  check(e.status === 0 && e.stdout.includes("--check") && e.stdout.includes("--out"), "B8: export --help lists --check and --out");
  check(i.status === 0 && i.stdout.includes("--apply"), "B8: task import --help lists --apply");
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
