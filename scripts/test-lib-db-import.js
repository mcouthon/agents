#!/usr/bin/env node
"use strict";

// `a task import`: the fold of the repo-local leftovers into the central
// folder, the trash bundle with manifest.json and undo.sh, the task.json and
// index.json moves, the recorded-commit confirmation and the unresolved list.
// Every scenario runs in one sandbox with fixture checkouts under it (and one
// outside, in a sibling root); git calls go through a counting wrapper.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const SCRIPTS = __dirname;
const A = path.join(SCRIPTS, "bin", "a");

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const created = [];
function mktmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
}

// the counting git wrapper: every call logged, then forwarded
const GUARD = mktmp("agents-import-guard-");
const GIT_LOG = path.join(GUARD, "git.log");
fs.writeFileSync(path.join(GUARD, "git"), `#!/bin/sh\nprintf '%s' "$(pwd)" >> '${GIT_LOG}'\nprintf ' %s' "$@" >> '${GIT_LOG}'\nprintf '\\n' >> '${GIT_LOG}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
const gitLines = () => (fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, "utf8").split("\n").filter(Boolean) : []);
const gitFetchLines = () => gitLines().filter((l) => l.includes(" fetch "));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const withDate = (repo, date, ...args) => spawnSync("git", ["-C", repo, ...args],
  { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: date }, stdio: ["ignore", "pipe", "pipe"] }).stdout.trim();

const readDb = (file, sql, ...params) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare(sql).all(...params); } finally { d.close(); }
};

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const putJson = (file, value) => put(file, JSON.stringify(value, null, 2) + "\n");

/** Apply the v1 DDL (no seed rows) to a fresh file, with $TASKS_ROOT rewritten. */
function seedV1Schema(file, tasksRoot) {
  const sql = fs.readFileSync(path.join(SCRIPTS, "fixtures", "db-v1.sql"), "utf8")
    .split("-- A repo every seed task belongs to")[0]
    .replace(/\$TASKS_ROOT/g, tasksRoot);
  const db = new DatabaseSync(file);
  db.exec(sql);
  return db;
}

/** A v1 task row (files_dir differing from task_dir becomes a pending fold). */
function seedTask(db, { id, repoKey, dirName, disposition = "active", taskDir, filesDir, statuses = ["not_started"], updated, doc = null }) {
  const phases = statuses.map((status, i) => ({ id: i + 1, name: `P${i + 1}`, status, blocked_by: i > 0 ? [i] : [] }));
  const text = JSON.stringify(doc || {
    schema: 2, slug: dirName, number: id, title: dirName, status: "planning", mode: "full", tier: "standard",
    knobs: {}, phases, worktree_path: "", created: "2026-10-01", updated,
  });
  db.prepare(`INSERT INTO tasks (id, repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode, created, updated, doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', 'standard', 'full', '2026-10-01', ?, ?)`)
    .run(id, repoKey, dirName, disposition, taskDir, filesDir, dirName, id, dirName, updated, text);
  for (const [ord, p] of phases.entries()) {
    db.prepare("INSERT INTO phases (task_id, ord, phase_id, name, status) VALUES (?, ?, ?, ?, ?)")
      .run(id, ord, p.id, p.name, p.status);
  }
}

/** Recursive (path, sha256) listing of the roots, pruning trash, the database and git internals. */
function listing(roots) {
  const out = [];
  const walk = (label, dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const rel = `${label}:${path.relative(roots[label], p)}`;
      const atRoot = path.dirname(p) === roots[label];
      if (e.isDirectory()) {
        if (e.name === ".git" || (e.name === "trash" && atRoot)) continue;
        walk(label, p);
      } else if (e.isSymbolicLink()) {
        out.push(`${rel} -> ${fs.readlinkSync(p)}`);
      } else if (e.isFile()) {
        if (/^agents\.(db|facts)/.test(e.name) && atRoot) continue;
        out.push(`${rel} ${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16)}`);
      }
    }
  };
  for (const [label, root] of Object.entries(roots)) walk(label, root);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const T = mktmp("agents-filestep-");
const TO = mktmp("agents-filestep-other-"); // the sibling root: outside the sandbox
const ALIAS = `${T}-alias`;
fs.symlinkSync(T, ALIAS);
const at = (...parts) => path.join(ALIAS, ...parts); // a path through the alias of the root

const HOME = path.join(T, "home");
const TASKS = path.join(T, "tasks");
const SESSIONS = path.join(T, "sessions");
const DB = path.join(T, "agents.db");
const CO1 = path.join(T, "co1");
const CO1WT = path.join(T, "co1-wt");
const CO2 = path.join(T, "co2");
const COR = path.join(T, "coR");
// the repo key coR's relative origin URL gives (its task dirs sit under it in the tasks root)
const RK = "coR.origin";
const CO3 = path.join(TO, "co3");

const env = {
  ...process.env,
  HOME, AGENTS_TASKS_ROOT: TASKS, AGENTS_SESSIONS_ROOT: SESSIONS, AGENTS_DB: DB,
  PATH: `${GUARD}:${process.env.PATH}`,
  AGENTS_TEST_SKIP_IDENTITY: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete env.AGENTS_SESSION_DIR;
delete env.CLAUDE_CODE_SESSION_ID;

const runA = (args, extraEnv = {}) => {
  const r = spawnSync("node", [A, ...args, "--json"], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 90000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* keep stdout raw */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => out };
};

const deadPid = spawnSync("node", ["-e", "0"]).pid;

// the checkouts
for (const dir of [CO1, CO2, CO3]) {
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  put(path.join(dir, "README.md"), "# r\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}
// coR: the direct repo; its bare origin sits inside the checkout, so the
// relative remote URL gives the single-segment repo key "coR.origin"
fs.mkdirSync(COR);
git(COR, "init", "-q", "-b", "main");
put(path.join(COR, "README.md"), "# r\n");
git(COR, "add", ".");
git(COR, "commit", "-q", "-m", "init");
git(COR, "init", "-q", "--bare", "-b", "main", path.join(COR, "coR.origin"));
git(COR, "remote", "add", "origin", "coR.origin");
git(COR, "push", "-q", "origin", "main");
git(COR, "remote", "set-head", "origin", "main");
// co1's worktree, its .tasks a symlink to the checkout's .tasks
git(CO1, "worktree", "add", "-q", "-b", "wt/co1", CO1WT);

// the repo-local leftovers (the v1 files_dir values go through the alias)
const L = (co, dir, ...rest) => path.join(ALIAS, path.relative(T, co), ".tasks", dir, ...rest);
put(L(CO1, "005-x", "task.md"), "local 005\n");
put(L(CO1, "005-x", "plan", "phase-1-a.md"), "local plan\n");
put(L(CO1, "005-x", "notes.md"), "note A\n");
putJson(L(CO1, "005-x", ".lock", "holder"), { session_id: "dead", pid: deadPid });
put(L(CO1, "006-y", "task.md"), "local 006\n");
put(L(CO1, "007-z", "task.md"), "local 007\n");
// 008-w: no leftover folder
put(L(CO1, "009-v", "task.md"), "local 009 v2\n");
put(L(CO2, "010-u", "task.md"), "local 010\n");
putJson(L(CO2, "011-t", ".lock", "holder"), { session_id: "live-lock", pid: process.pid });
put(L(CO2, "011-t", "task.md"), "local 011\n");
put(path.join(CO1, ".tasks", "canary.txt"), "loose canary\n");
put(L(CO1, "012-s", "task.md"), "local 012\n"); // no row
put(L(CO1, "013-r", "task.md"), "local 013\n"); // no row; the doctor names it
put(path.join(CO3, ".tasks", "014-q", "task.md"), "local 014\n");
put(path.join(CO3, ".tasks", "014-q", "task.json"), "{}\n");
fs.symlinkSync(path.join(CO1, ".tasks"), path.join(CO1WT, ".tasks"));

// the central folders
const C = (repoKey, dir) => path.join(TASKS, repoKey, dir);
put(at("tasks", "co1", "005-x", "task.md"), "central 005\n");
put(at("tasks", "co1", "005-x", "notes.md"), "note A\n"); // identical to the local one
put(at("tasks", "co1", "005-x", "task.json"), "{}\n");
// 006-y: no central folder
put(at("tasks", "co1", "009-v", "task.md"), "central 009\n");
put(at("tasks", "co1", "009-v", "task.repo-local.md"), "older local\n");
put(at("tasks", "co1", "009-v", "task.json"), "{}\n");
put(at("tasks", "co2", "010-u", "task.md"), "central 010\n");
put(at("tasks", "co2", "010-u", "task.json"), "{}\n");
put(at("tasks", "co2", "011-t", "task.md"), "central 011\n");
put(at("tasks", "co2", "011-t", "task.json"), "{}\n");
put(path.join(TO, "tasks", "co3", "014-q", "task.md"), "central 014\n");
put(path.join(TO, "tasks", "co3", "014-q", "task.json"), "{}\n");

// the recorded-commit commits: init -> c20a -> c20b -> c22 -> c24 -> c21 (origin/main at c21)
const head0 = git(COR, "rev-parse", "HEAD");
const c20a = withDate(COR, "2026-10-02T10:00:00", "commit-tree", `${head0}^{tree}`, "-p", head0, "-m", "c20a");
const c20b = withDate(COR, "2026-10-02T10:30:00", "commit-tree", `${head0}^{tree}`, "-p", c20a, "-m", "c20b");
const c22 = withDate(COR, "2026-10-02T11:00:00", "commit-tree", `${head0}^{tree}`, "-p", c20b, "-m", "c22");
const c24 = withDate(COR, "2026-10-02T11:30:00", "commit-tree", `${head0}^{tree}`, "-p", c22, "-m", "c24");
const c21 = withDate(COR, "2026-10-02T12:00:00", "commit-tree", `${head0}^{tree}`, "-p", c24, "-m", "c21");
git(COR, "push", "-q", "origin", `${c21}:main`);

for (const [dirName, lines] of [
  ["020-a", [`Committed: ${c20a.slice(0, 10)}`, `**Committed:** ${c20b.slice(0, 12)}`]],
  ["021-b", [`Commits: ${c21.slice(0, 10)}`]],
  ["022-c", [`Committed: ${c22.slice(0, 10)}`]],
  ["023-d", ["nothing recorded here"]],
  ["024-e", [`Committed: ${c24.slice(0, 10)}`]],
]) {
  put(path.join(TASKS, RK, dirName, "task.md"), `# ${dirName}\n\n${lines.join("\n")}\n`);
  put(path.join(TASKS, RK, dirName, "task.json"), "{}\n");
}

// the policy file lists coR direct
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".claude", "repo-policies.json"), JSON.stringify({ [COR]: "direct" }, null, 2));
// index.json: every key has a repos row
putJson(path.join(TASKS, "index.json"), {
  co1: { main_root: CO1, last_seen: "2026-10-01T10:00:00.000Z" },
  co2: { main_root: CO2, last_seen: "2026-10-01T10:00:00.000Z" },
  [RK]: { main_root: COR, last_seen: "2026-10-01T10:00:00.000Z" },
});

// the v1 database
const seed = seedV1Schema(DB, TASKS);
for (const [key, main] of [["co1", CO1], ["co2", CO2], [RK, COR]]) {
  seed.prepare("INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(key, key === "co1" ? 0 : key === "co2" ? 1 : 2, main, JSON.stringify({ main_root: main, last_seen: "2026-10-01T10:00:00.000Z" }), "2026-10-01T10:00:00.000Z");
}
seedTask(seed, { id: 5, repoKey: "co1", dirName: "005-x", taskDir: at("tasks", "co1", "005-x"), filesDir: L(CO1, "005-x"), updated: "2026-10-05T10:00:00.000Z" });
seedTask(seed, { id: 6, repoKey: "co1", dirName: "006-y", taskDir: at("tasks", "co1", "006-y"), filesDir: L(CO1, "006-y"), updated: "2026-10-06T10:00:00.000Z" });
seedTask(seed, { id: 7, repoKey: "co1", dirName: "007-z", disposition: "deleted", taskDir: at("tasks", "co1", "007-z"), filesDir: L(CO1, "007-z"), updated: "2026-10-07T10:00:00.000Z" });
seedTask(seed, { id: 8, repoKey: "co1", dirName: "008-w", taskDir: at("tasks", "co1", "008-w"), filesDir: L(CO1, "008-w"), updated: "2026-10-08T10:00:00.000Z" });
seedTask(seed, { id: 9, repoKey: "co1", dirName: "009-v", taskDir: at("tasks", "co1", "009-v"), filesDir: L(CO1, "009-v"), statuses: ["planned"], updated: "2026-10-09T10:00:00.000Z" });
seedTask(seed, { id: 10, repoKey: "co2", dirName: "010-u", taskDir: at("tasks", "co2", "010-u"), filesDir: L(CO2, "010-u"), updated: "2026-10-10T10:00:00.000Z" });
seedTask(seed, { id: 11, repoKey: "co2", dirName: "011-t", taskDir: at("tasks", "co2", "011-t"), filesDir: L(CO2, "011-t"), updated: "2026-10-11T10:00:00.000Z" });
seedTask(seed, { id: 14, repoKey: "co3", dirName: "014-q", taskDir: path.join(TO, "tasks", "co3", "014-q"), filesDir: path.join(CO3, ".tasks", "014-q"), updated: "2026-10-14T10:00:00.000Z" });
for (const [id, dirName] of [[20, "020-a"], [21, "021-b"], [22, "022-c"], [23, "023-d"], [24, "024-e"]]) {
  const taskDir = path.join(TASKS, RK, dirName);
  seedTask(seed, { id, repoKey: RK, dirName, taskDir, filesDir: taskDir, statuses: ["done"], updated: `2026-10-${id}T10:00:00.000Z` });
}
seed.close();

// the live session bound to 010-u (its task_dir through the alias, like the row)
putJson(path.join(SESSIONS, "s-u", "registration.json"), {
  session_id: "s-u", repo_key: "co2", task_dir: at("tasks", "co2", "010-u"), agent: "conductor",
  pid: process.pid, created_at: "2026-10-30T10:00:00.000Z", cwd: CO2,
});

const ROOTS = { T, O: TO };
const snapshot = () => listing(ROOTS);

// ---------------------------------------------------------------------------
// The migration, the note on 024-e, the dry run
// ---------------------------------------------------------------------------

{
  const r = runA(["ls", "--json", "--all"]);
  check(r.status === 0, `the first open migrates and lists (exit ${r.status}: ${r.stderr})`);
  check(readDb(DB, "SELECT version FROM schema_version")[0].version === 2, "the file is schema 2 after the first open");
  check(readDb(DB, "SELECT count(*) AS n FROM pending_folds")[0].n === 8, "the eight rows with differing files_dir hold pending folds");
}

{
  const r = runA(["task", "note", "--task-dir", path.join(TASKS, RK, "024-e"), "--phase-id", "1", "--text", "note after migration"]);
  check(r.status === 0, `a task note lands on 024-e (exit ${r.status}: ${r.stderr})`);
}

{
  runA(["task", "import"]); // warm the read cache; the listing below compares two dry runs
  const before = snapshot();
  const r = runA(["task", "import"]);
  check(r.status === 0, `the dry run exits 0 (${r.status}: ${r.stderr})`);
  const out = r.json();
  const rowOf = (dir) => out.fold.rows.find((x) => x.dir === dir) || {};
  check(rowOf("005-x").state === "fold"
    && rowOf("005-x").files.map((f) => `${f.rel}:${f.action}`).sort().join("|") === "notes.md:same|plan/phase-1-a.md:move|task.md:suffix",
    `005-x lists one move, one same and one suffix (${JSON.stringify(rowOf("005-x"))})`);
  check(rowOf("006-y").state === "create central", "006-y lists create central");
  check(rowOf("007-z").state === "deleted → trash", "007-z lists deleted → trash");
  check(rowOf("008-w").state === "missing", "008-w lists missing");
  check(rowOf("009-v").state === "fold" && rowOf("009-v").files.length === 1
    && rowOf("009-v").files[0].action === "suffix" && /task\.repo-local-2\.md$/.test(rowOf("009-v").files[0].to),
    `009-v lists a suffix to task.repo-local-2.md (${JSON.stringify(rowOf("009-v"))})`);
  check(rowOf("010-u").state === "in use" && rowOf("011-t").state === "in use", "010-u and 011-t list in use");
  check(rowOf("014-q").state === "outside sandbox", "014-q lists outside sandbox");
  check(out.loose.some((x) => x.path.endsWith("canary.txt")) && out.loose.some((x) => x.path.endsWith("012-s")) && out.loose.some((x) => x.path.endsWith("013-r")),
    "canary.txt, 012-s and 013-r list loose → trash");
  check(out.links.length === 1 && out.links[0].path === path.join(CO1WT, ".tasks"),
    "the worktree .tasks link lists link → trash");
  check(out.task_json.length === 9, `every task.json under the root lists (${out.task_json.length})`);
  check(out.index_json.missing_keys.length === 0, "index.json lists no missing keys");
  const cand = out.candidates;
  check(cand.length === 4 && cand.every((c) => c.key.startsWith(`${RK}/`)),
    `four candidates keyed <repo_key>/<dir> (${cand.map((c) => c.key).join(", ")})`);
  check(cand.find((c) => c.dir === "020-a").lines.length === 2, "020-a's candidate lists both lines");
  check(cand.find((c) => c.dir === "024-e").status === "changed since the migration", "024-e's candidate lists changed since the migration");
  check(cand.every((c) => c.on_base === true) && cand.every((c) => c.head),
    "each candidate carries its head and on base");
  check(out.planned_without_plan.some((x) => x.task === "co1/009-v" && x.phases.includes(1)),
    "the planned-without-plan list names 009-v phase 1");
  check(out.sessions.count === 1, "the sessions group counts the one registration");
  check(out.unresolved.map((u) => u.dir).sort().join(",") === "023-d,024-e"
    && out.unresolved.every((u) => u.reason === "no land record"),
    "the dry run lists 023-d and 024-e unresolved (no land record)");
  check(JSON.stringify(out.would_read) === JSON.stringify({ done: 3, of_direct: 5, unresolved: 2, direct: 2, other: 0 }),
    `the dry run's counts are done 3 of 5 direct, unresolved 2 (${JSON.stringify(out.would_read)})`);
  check(out.last_line === "would read done 3 of 5 direct, unresolved 2 (2 direct, 0 other)", "the last line reads as expected");
  check(snapshot() === before, "the dry run writes nothing (recursive listing identical)");
}

// the doctor warns while the folds are pending and a stray .tasks/013-r sits in a checkout
{
  const r = runA(["doctor"]);
  const out = r.json();
  const warns = (out.warnings || []).join("\n");
  check(warns.includes("010-u") && warns.includes("011-t"), "doctor warns naming the pending folds 010-u and 011-t");
  check(warns.includes("013-r"), `doctor warns for the checkout's stray .tasks/013-r (${warns.slice(0, 400)})`);
  check((out.db && out.db.pending_folds) === 8, `doctor's db info counts the pending folds (${out.db && out.db.pending_folds})`);
}

// the sandbox guard: an AGENTS_DB-only run folds nothing; a database outside the root refuses
{
  const noTasksRoot = { ...env };
  delete noTasksRoot.AGENTS_TASKS_ROOT;
  delete noTasksRoot.AGENTS_SESSIONS_ROOT;
  const r = spawnSync("node", [A, "task", "import", "--json"], { env: noTasksRoot, encoding: "utf8", timeout: 90000 });
  const out = JSON.parse(r.stdout);
  check(r.status === 0 && out.fold.rows.length === 8 && out.fold.rows.every((x) => x.state === "outside sandbox"),
    `with only AGENTS_DB set every row lists outside sandbox (${out.fold.rows.map((x) => x.state).join(", ")})`);
}

{
  const before = snapshot();
  const r = spawnSync("node", [A, "task", "import", "--apply", "--json"], {
    env: { ...env, AGENTS_DB: path.join(TO, "elsewhere", "agents.db") }, encoding: "utf8", timeout: 90000,
  });
  check(r.status === 2, `--apply with AGENTS_DB outside the root exits 2 (${r.status})`);
  check(/mixed roots/.test(r.stderr), `the refusal names mixed roots (${r.stderr.trim().slice(0, 120)})`);
  check(snapshot() === before, "the mixed-roots refusal changes nothing");
}

// ---------------------------------------------------------------------------
// The first --apply, and undo
// ---------------------------------------------------------------------------

let bundle1;
{
  const before = snapshot();
  const r = runA(["task", "import", "--apply"]);
  check(r.status === 0, `--apply exits 0 (${r.status}: ${r.stderr})`);
  const out = r.json();
  bundle1 = out.bundle;
  check(typeof bundle1 === "string" && fs.existsSync(path.join(bundle1, "manifest.json")), "the bundle path is printed and holds manifest.json");
  check(fs.existsSync(path.join(bundle1, "undo.sh")), "the bundle holds undo.sh");
  check(readFileSyncSafe(path.join(TASKS, "co1", "005-x", "plan", "phase-1-a.md")) === "local plan\n", "005-x's plan file moved into the central folder");
  check(readFileSyncSafe(path.join(TASKS, "co1", "005-x", "task.md")) === "central 005\n", "005-x's central task.md is unchanged");
  check(readFileSyncSafe(path.join(TASKS, "co1", "005-x", "task.repo-local.md")) === "local 005\n", "005-x's local task.md landed suffixed");
  check(readFileSyncSafe(path.join(TASKS, "co1", "005-x", "notes.md")) === "note A\n", "005-x's identical notes.md stayed central");
  check(readFileSyncSafe(path.join(TASKS, "co1", "009-v", "task.repo-local-2.md")) === "local 009 v2\n", "009-v's local bytes landed in task.repo-local-2.md");
  check(readFileSyncSafe(path.join(TASKS, "co1", "006-y", "task.md")) === "local 006\n", "006-y's central folder was created and holds the moved task.md");
  check(!fs.existsSync(path.join(CO1, ".tasks")), "the first checkout has no .tasks");
  const bundleFiles = walkFiles(bundle1);
  check(bundleFiles.some((f) => f.endsWith("005-x/notes.md")) && bundleFiles.some((f) => f.endsWith("005-x/.lock/holder")),
    "005-x's remainder (notes.md, the stale .lock) sits in the bundle");
  check(bundleFiles.some((f) => f.endsWith("canary.txt")) && bundleFiles.some((f) => f.endsWith("012-s/task.md"))
    && bundleFiles.some((f) => f.endsWith("013-r/task.md")) && bundleFiles.some((f) => f.endsWith("007-z/task.md")),
    "the loose entries and the deleted row's folder sit in the bundle");
  check(!fs.existsSync(path.join(CO1WT, ".tasks")) && bundleFiles.some((f) => f.endsWith("co1-wt/.tasks")),
    "the worktree's .tasks link is gone and sits in the bundle");
  check(fs.existsSync(path.join(CO2, ".tasks", "010-u", "task.md")) && fs.existsSync(path.join(CO2, ".tasks", "011-t", "task.md")),
    "the in-use rows keep their folders and the second checkout's .tasks");
  check(readFileSyncSafe(path.join(CO3, ".tasks", "014-q", "task.md")) === "local 014\n"
    && readFileSyncSafe(path.join(TO, "tasks", "co3", "014-q", "task.md")) === "central 014\n"
    && fs.existsSync(path.join(TO, "tasks", "co3", "014-q", "task.json")),
    "014-q's folder, task_dir and task.json are untouched");
  const folds = readDb(DB, "SELECT task_id FROM pending_folds ORDER BY task_id").map((x) => x.task_id);
  check(JSON.stringify(folds) === JSON.stringify([10, 11, 14]), `pending_folds holds only the in-use and outside rows (${folds})`);
  check(!fs.existsSync(path.join(TASKS, "co1", "005-x", "task.json")) && !fs.existsSync(path.join(TASKS, "index.json")),
    "no task.json and no index.json remains under the tasks root");
  const unres = JSON.parse(fs.readFileSync(out.unresolved_json, "utf8"));
  check(/unresolved\.json$/.test(out.unresolved_json)
    && unres.length === 5 && unres.every((u) => u.reason === "no land record"),
    `unresolved.json lists the five unresolved candidates and 023-d (${JSON.stringify(unres.map((u) => `${u.dir}:${u.reason}`))})`);
  check(!r.stdout.includes("--batch") && !r.stderr.includes("--batch"), "--apply prints no --batch line (the flag does not exist yet)");
  check(out.confirm === null, "without --confirm-recorded nothing is confirmed");
  check(readDb(DB, "SELECT count(*) AS n FROM decisions WHERE choice = 'answer'")[0].n === 0
    && readDb(DB, "SELECT count(*) AS n FROM events WHERE kind = 'land'")[0].n === 0,
    "without --confirm-recorded no decision and no land event is written");
  const fetches = gitFetchLines();
  check(fetches.length === 1 && fetches[0].includes(COR) && fetches[0].includes("origin main"),
    `one guarded fetch ran for the candidates' repo (${fetches.join("; ")})`);
  check(gitFetchLines().every((l) => !l.includes(CO3)), "no fetch ran for 014-q's repo");
  const after = snapshot();
  check(after !== before, "--apply moved files");
  const undo = spawnSync("sh", [path.join(bundle1, "undo.sh")], { encoding: "utf8" });
  check(undo.status === 0, `undo.sh exits 0 (${undo.stdout} ${undo.stderr})`);
  check(/restored [0-9]+, skipped 0/.test(undo.stdout), `undo.sh prints restored n, skipped 0 (${undo.stdout.trim()})`);
  check(snapshot() === before, "undo.sh restores the pre-apply recursive listing");
}

function readFileSyncSafe(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/** Every file and symlink under `dir`, as absolute paths. */
function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

// re-apply, then the skip case: a file recreated at a moved source path
// (the fold rows are gone after the first undo — rows are not undone — so the
// re-run moves the task.json and index.json files only)
{
  const r = runA(["task", "import", "--apply"]);
  check(r.status === 0, `the re-run of --apply exits 0 (${r.stderr})`);
  const bundle2 = r.json().bundle;
  check(bundle2 && bundle2 !== bundle1, `each --apply makes its own bundle (${bundle2})`);
  const recreated = path.join(TASKS, RK, "020-a", "task.json");
  put(recreated, "recreated task.json\n");
  const undo = spawnSync("sh", [path.join(bundle2, "undo.sh")], { encoding: "utf8" });
  check(undo.status === 1, `undo.sh exits 1 when a source path was recreated (${undo.status})`);
  check(undo.stdout.includes(`skipped, exists: ${recreated}`),
    `undo.sh prints the skipped path (${undo.stdout.trim().slice(0, 200)})`);
  check(readFileSyncSafe(recreated) === "recreated task.json\n"
    && readFileSyncSafe(path.join(bundle2, "files", ...recreated.slice(1).split("/"))) === "{}\n",
    "both files exist after the skip");
  const again = runA(["task", "import", "--apply"]);
  check(again.status === 0, `a fresh --apply after the skip exits 0 (${again.stderr})`);
}

// a second --apply changes nothing for the folded rows
{
  const before = snapshot();
  const r = runA(["task", "import", "--apply"]);
  const out = r.json();
  check(out.fold.rows.map((x) => x.dir).sort().join(",") === "010-u,011-t,014-q", `only the unresolvable rows list (${out.fold.rows.map((x) => `${x.dir}:${x.state}`).join(", ")})`);
  check(readDb(DB, "SELECT count(*) AS n FROM pending_folds")[0].n === 3, "pending_folds is unchanged");
  check(out.task_json.length === 0, "no task.json remains to move");
}

// ---------------------------------------------------------------------------
// The recorded-commit confirmation
// ---------------------------------------------------------------------------

let bundleConfirm;
{
  const r = runA(["task", "import", "--apply", "--confirm-recorded", "yes, those", "--except", `${RK}/021-b`]);
  check(r.status === 0, `--apply --confirm-recorded --except exits 0 (${r.status}: ${r.stderr})`);
  const out = r.json();
  bundleConfirm = out.bundle;
  const results = Object.fromEntries(out.confirm.results.map((x) => [x.dir, x.action]));
  check(results["020-a"] === "recorded" && results["022-c"] === "recorded", `020-a and 022-c record (${JSON.stringify(results)})`);
  check(results["021-b"] === "excepted", "021-b is left out by --except");
  check(results["024-e"] === "changed since the migration, not recorded", "024-e lists changed since the migration");
  for (const dirName of ["020-a", "022-c"]) {
    const rows = readDb(DB, "SELECT d.decision_id, d.phase_id, d.choice, d.gate, d.quote FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.dir_name = ? AND d.choice = 'answer'", dirName);
    check(rows.length === 1 && rows[0].phase_id === null && rows[0].gate === "finalize" && rows[0].quote === "yes, those",
      `${dirName} holds one task-level finalize answer with the owner's words`);
    const lands = readDb(DB, "SELECT e.at, e.detail FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.dir_name = ? AND e.kind = 'land'", dirName);
    check(lands.length === 1, `${dirName} holds one land event`);
    const detail = JSON.parse(lands[0].detail);
    const cand = dirName === "020-a" ? { head: c20b, lines: 2 } : { head: c22, lines: 1 };
    check(detail.head === cand.head && detail.migrated === true && detail.source.startsWith("task.md:")
      && detail.source.split(":")[1].split(",").length === cand.lines && Number.isInteger(detail.decision_id),
      `${dirName}'s land event names head, source lines and the decision`);
  }
  const ls20 = runA(["ls", path.join(TASKS, RK, "020-a"), "--repo", COR]);
  check(ls20.status === 0 && ls20.json().landing.state === "landed" && ls20.json().landing.proof === "push"
    && ls20.json().task_status === "done", "020-a reads landed, proof push, done");
  const ls22 = runA(["ls", path.join(TASKS, RK, "022-c"), "--repo", COR]);
  check(ls22.status === 0 && ls22.json().task_status === "done", "022-c reads done");
  const unres = JSON.parse(fs.readFileSync(out.unresolved_json, "utf8"));
  check(unres.map((u) => u.dir).sort().join(",") === "021-b,023-d,024-e", `unresolved.json lists 021-b, 023-d and 024-e (${unres.map((u) => u.dir)})`);
  const decisions = readDb(DB, "SELECT count(*) AS n FROM decisions WHERE choice = 'answer'")[0].n;
  const lands = readDb(DB, "SELECT count(*) AS n FROM events WHERE kind = 'land'")[0].n;
  check(decisions === 2 && lands === 2, `two answers and two land events in total (${decisions}/${lands})`);
}

// a second confirmation is idempotent
{
  const before = snapshot();
  const r = runA(["task", "import", "--apply", "--confirm-recorded", "yes, those", "--except", `${RK}/021-b`]);
  const out = r.json();
  const results = Object.fromEntries(out.confirm.results.map((x) => [x.dir, x.action]));
  check(results["020-a"] === "already recorded" && results["022-c"] === "already recorded", `the second confirmation lists both already recorded (${JSON.stringify(results)})`);
  check(readDb(DB, "SELECT count(*) AS n FROM decisions WHERE choice = 'answer'")[0].n === 2
    && readDb(DB, "SELECT count(*) AS n FROM events WHERE kind = 'land'")[0].n === 2,
    "the second confirmation writes no decision and no event");
}

// --except refusals, before step 1
for (const [label, value] of [["an unknown key", `${RK}/999-none`], ["a key with no repo_key", "021-b"]]) {
  const before = snapshot();
  const r = runA(["task", "import", "--apply", "--confirm-recorded", "x", "--except", value]);
  check(r.status === 2, `--except with ${label} exits 2 (${r.status})`);
  check(snapshot() === before, `--except with ${label} changes nothing`);
}

// a force-reset of origin/main: 021-b's commit leaves the base
{
  git(COR, "push", "-q", "--force", "origin", `${c24}:main`);
  const r = runA(["task", "import", "--apply", "--confirm-recorded", "round two"]);
  check(r.status === 0, `the confirmation after the force-reset exits 0 (${r.stderr})`);
  const out = r.json();
  const results = Object.fromEntries(out.confirm.results.map((x) => [x.dir, x.action]));
  check(results["020-a"] === "already recorded" && results["022-c"] === "already recorded", "020-a and 022-c list already recorded");
  check(results["021-b"] === "no longer on base", `021-b lists no longer on base (${JSON.stringify(results)})`);
  const rows = readDb(DB, "SELECT count(*) AS n FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.dir_name = '021-b'");
  check(rows[0].n === 0, "021-b gets no decision");
}

// ---------------------------------------------------------------------------
// The ending sessions fold; index.json keys; no candidates
// ---------------------------------------------------------------------------

{
  // the session ends and the lock holder dies: 010-u and 011-t fold, co2's .tasks empties
  const reg = path.join(SESSIONS, "s-u", "registration.json");
  const doc = JSON.parse(fs.readFileSync(reg, "utf8"));
  doc.ended_at = "2026-10-31T10:00:00.000Z";
  putJson(reg, doc);
  putJson(path.join(CO2, ".tasks", "011-t", ".lock", "holder"), { session_id: "dead-lock", pid: deadPid });
  const r = runA(["task", "import", "--apply"]);
  check(r.status === 0, `the third --apply exits 0 (${r.stderr})`);
  check(!fs.existsSync(path.join(CO2, ".tasks")), "the second checkout's .tasks is gone once its rows fold");
  const folds = readDb(DB, "SELECT task_id FROM pending_folds").map((x) => x.task_id);
  check(JSON.stringify(folds) === JSON.stringify([14]), `pending_folds holds only the outside row (${folds})`);
  const doc2 = runA(["doctor"]);
  const warns = ((doc2.json() || {}).warnings || []).join("\n");
  // co1's .tasks came back with the first undo (row changes are not undone by
  // the script), so its strays still warn; what this run folded no longer does
  check(!warns.includes("010-u") && !warns.includes("011-t") && warns.includes("014-q"),
    `doctor no longer warns for the folded rows and still names the outside one (${warns.slice(0, 400)})`);
}

{
  // a second sandbox: an index.json key with no repos row stays put
  const T2 = mktmp("agents-idx-");
  const db2 = path.join(T2, "agents.db");
  const tasks2 = path.join(T2, "tasks");
  fs.mkdirSync(tasks2, { recursive: true });
  const seed2 = seedV1Schema(db2, tasks2);
  seed2.prepare("INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES ('known', 0, ?, ?, ?)")
    .run(path.join(T2, "known"), "{}", "2026-10-01T00:00:00.000Z");
  seed2.close();
  putJson(path.join(tasks2, "index.json"), { known: {}, ghost: {} });
  put(path.join(tasks2, "known", "001-a", "task.json"), "{}\n");
  const env2 = { ...env, HOME: path.join(T2, "home"), AGENTS_TASKS_ROOT: tasks2, AGENTS_SESSIONS_ROOT: path.join(T2, "sessions"), AGENTS_DB: db2 };
  const r = spawnSync("node", [A, "task", "import", "--apply", "--json"], { env: env2, encoding: "utf8", timeout: 90000 });
  const out = JSON.parse(r.stdout);
  check(r.status === 1, `--apply exits 1 when an index.json key has no repos row (${r.status})`);
  check(out.index_json.missing_keys.join(",") === "ghost" && fs.existsSync(path.join(tasks2, "index.json")),
    "index.json stays and the missing key is listed");
  check(!fs.existsSync(path.join(tasks2, "known", "001-a", "task.json")), "the task.json still moved");
  // with the ghost key in repos, a later --apply moves index.json
  const seed3 = new DatabaseSync(db2);
  seed3.prepare("INSERT OR REPLACE INTO repos (key, ord, main_root, doc, updated_at) VALUES ('ghost', 5, ?, ?, ?)")
    .run(path.join(T2, "ghost"), "{}", "2026-10-01T00:00:00.000Z");
  seed3.close();
  const r2 = spawnSync("node", [A, "task", "import", "--apply", "--json"], { env: env2, encoding: "utf8", timeout: 90000 });
  const out2 = JSON.parse(r2.stdout);
  check(r2.status === 0 && !fs.existsSync(path.join(tasks2, "index.json")), "with every key in repos, index.json moves into the bundle");
}

{
  // a sandbox with no candidate: --confirm-recorded refuses the whole run
  const T3 = mktmp("agents-nocand-");
  const db3 = path.join(T3, "agents.db");
  const tasks3 = path.join(T3, "tasks");
  fs.mkdirSync(tasks3, { recursive: true });
  seedV1Schema(db3, tasks3).close();
  const env3 = { ...env, HOME: path.join(T3, "home"), AGENTS_TASKS_ROOT: tasks3, AGENTS_SESSIONS_ROOT: path.join(T3, "sessions"), AGENTS_DB: db3 };
  const before = listing({ T: T3 });
  const r = spawnSync("node", [A, "task", "import", "--apply", "--confirm-recorded", "yes", "--json"], { env: env3, encoding: "utf8", timeout: 90000 });
  check(r.status === 2, `--apply --confirm-recorded with no candidate exits 2 (${r.status})`);
  check(/no recorded candidates/.test(r.stderr), `the refusal names no recorded candidates (${r.stderr.trim().slice(0, 120)})`);
  check(listing({ T: T3 }) === before, "the refusal changes nothing on disk");
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
