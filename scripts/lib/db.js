"use strict";

/**
 * One SQLite file holds every task, phase, report, checkpoint, session and repo.
 *
 * DB mode is switched on by the file existing (`enabled()`): with no file every
 * write path behaves as before and nothing here creates it. Only
 * `open({ create: true })` (the import, test fixtures) creates the file.
 *
 * Each task / session / repo row keeps the exact JSON text its file holds in
 * `doc`; the other columns are projections for queries and are rewritten from
 * `doc` on every upsert.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const SCHEMA_VERSION = 1;
const DOT_NAME = ".agents.db";
/** Repos known only from disk (no index.json entry) get ord >= this and stay out of INDEX.md. */
const UNINDEXED_ORD = 1000000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS repos (
  key TEXT PRIMARY KEY, ord INTEGER NOT NULL, main_root TEXT, doc TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, repo_key TEXT NOT NULL, dir_name TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN ('active','archived','deleted')),
  task_dir TEXT NOT NULL, files_dir TEXT NOT NULL,
  slug TEXT, number INTEGER, title TEXT, status TEXT, tier TEXT, mode TEXT,
  created TEXT, updated TEXT, doc TEXT NOT NULL,
  UNIQUE (repo_key, dir_name));
CREATE TABLE IF NOT EXISTS phases (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  phase_id INTEGER, name TEXT, status TEXT, owner TEXT, branch TEXT, plan_path TEXT,
  landed_sha TEXT, started TEXT, completed TEXT, PRIMARY KEY (task_id, ord));
CREATE TABLE IF NOT EXISTS reports (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase_ord INTEGER NOT NULL,
  agent TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (task_id, phase_ord, agent));
CREATE TABLE IF NOT EXISTS checkpoints (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  checkpoint_id TEXT, phase INTEGER, type TEXT, chosen TEXT, doc TEXT NOT NULL,
  PRIMARY KEY (task_id, ord));
CREATE TABLE IF NOT EXISTS sessions (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT, terminal_id TEXT, repo_key TEXT, task_dir TEXT, agent TEXT, origin TEXT,
  cwd TEXT, pid INTEGER, created_at TEXT, updated_at TEXT, ended_at TEXT, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
  repo_key TEXT, task_id INTEGER, session_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phase_id INTEGER NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
  session_id TEXT NOT NULL, session_dir TEXT NOT NULL, resumed_from INTEGER,
  pid INTEGER, model TEXT, requested_model TEXT, budget_usd REAL, cwd TEXT NOT NULL, brief TEXT NOT NULL,
  stream_path TEXT NOT NULL, err_path TEXT NOT NULL, exit_path TEXT NOT NULL,
  transcript_path TEXT, exit_code INTEGER, subtype TEXT, terminal_reason TEXT,
  cost_usd REAL, duration_ms INTEGER, num_turns INTEGER, permission_denials TEXT,
  result_text TEXT, error TEXT, git_status TEXT, transition TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, reaping_at TEXT);
CREATE INDEX IF NOT EXISTS tasks_repo ON tasks (repo_key, disposition);
CREATE INDEX IF NOT EXISTS sessions_repo ON sessions (repo_key);
CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id, phase_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
`;

const LIVE_RUN_STATUSES = ["starting", "running", "reaping"];

/** Columns `updateRun` may set; `run_id`, `task_id` and `started_at` never change. */
const RUN_COLUMNS = [
  "phase_id", "agent", "status", "session_id", "session_dir", "resumed_from", "pid", "model", "requested_model", "budget_usd",
  "cwd", "brief", "stream_path", "err_path", "exit_path", "transcript_path", "exit_code", "subtype",
  "terminal_reason", "cost_usd", "duration_ms", "num_turns", "permission_denials", "result_text", "error",
  "git_status", "transition", "ended_at", "reaping_at",
];

// ---------------------------------------------------------------------------
// Paths and gate
// ---------------------------------------------------------------------------

/**
 * Where the database lives. Follows the root overrides so tests that isolate
 * the tasks or sessions root never reach the real file; refuses the home
 * default when AGENTS_TEST_SKIP_IDENTITY marks the process as a test.
 */
function dbPath() {
  if (process.env.AGENTS_DB) return path.resolve(process.env.AGENTS_DB);
  if (process.env.AGENTS_TASKS_ROOT) return path.join(process.env.AGENTS_TASKS_ROOT, DOT_NAME);
  if (process.env.AGENTS_SESSIONS_ROOT) return path.join(process.env.AGENTS_SESSIONS_ROOT, DOT_NAME);
  if (process.env.AGENTS_TEST_SKIP_IDENTITY) {
    throw new Error(
      "refusing the home-directory agents.db under AGENTS_TEST_SKIP_IDENTITY; " +
      "set AGENTS_DB, AGENTS_TASKS_ROOT or AGENTS_SESSIONS_ROOT"
    );
  }
  return path.join(os.homedir(), ".agents", "agents.db");
}

/** DB mode is on exactly when the database file exists. */
function enabled() {
  let p;
  try { p = dbPath(); } catch { return false; }
  return fs.existsSync(p);
}

// ---------------------------------------------------------------------------
// node:sqlite loading and connections
// ---------------------------------------------------------------------------

let sqliteMod = null;

function loadSqlite() {
  if (sqliteMod) return sqliteMod;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === "string" ? warning : (warning && warning.message) || "";
    if (/SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    sqliteMod = require("node:sqlite");
  } catch (err) {
    throw new Error(
      `the agents database needs node:sqlite (Node 22.5+); this is Node ${process.version}: ${err.message}`
    );
  } finally {
    process.emitWarning = original;
  }
  return sqliteMod;
}

function nodeSqliteOk() {
  try { loadSqlite(); return true; } catch { return false; }
}

function noDbError(p) {
  const err = new Error(`no database at ${p}; run \`a task import --apply\``);
  err.notFound = true;
  return err;
}

const conns = new Map();

class Conn {
  constructor(raw, file) {
    this.raw = raw;
    this.file = file;
    this.depth = 0;
  }

  all(sql, ...params) { return this.raw.prepare(sql).all(...params); }
  get(sql, ...params) { return this.raw.prepare(sql).get(...params); }
  run(sql, ...params) { return this.raw.prepare(sql).run(...params); }

  tx(fn) {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      try { this.raw.exec("ROLLBACK"); } catch { /* connection already unusable */ }
      throw err;
    } finally {
      this.depth = 0;
    }
  }
}

function initSchema(conn) {
  conn.raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
  conn.raw.exec(SCHEMA);
  const runColumns = conn.all("PRAGMA table_info(runs)").map((c) => c.name);
  if (!runColumns.includes("requested_model")) conn.raw.exec("ALTER TABLE runs ADD COLUMN requested_model TEXT");
  const row = conn.get("SELECT version FROM schema_version");
  if (!row) {
    conn.run("INSERT INTO schema_version (version) VALUES (?)", SCHEMA_VERSION);
  } else if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `agents.db schema v${row.version} is newer than this \`a\` (v${SCHEMA_VERSION}); run ./install.sh`
    );
  }
}

/**
 * Open (and memoise) the connection for the current dbPath().
 * - create: make the file when it is missing (the only way a database comes to be).
 * - readonly: a separate, uncached read-only connection (doctor, tests).
 * A 0-byte file counts as a new database; a non-database file throws naming the path.
 */
function open({ create = false, readonly = false } = {}) {
  const p = dbPath();
  const { DatabaseSync } = loadSqlite();
  if (readonly) {
    if (!fs.existsSync(p)) throw noDbError(p);
    try {
      const raw = new DatabaseSync(p, { readOnly: true });
      raw.exec("PRAGMA busy_timeout=5000");
      return new Conn(raw, p);
    } catch (err) {
      throw new Error(`agents.db at ${p} cannot be opened read-only: ${err.message}`);
    }
  }
  if (conns.has(p)) return conns.get(p);
  if (!fs.existsSync(p)) {
    if (!create) throw noDbError(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.closeSync(fs.openSync(p, "wx", 0o600));
  }
  let conn;
  try {
    conn = new Conn(new DatabaseSync(p), p);
    initSchema(conn);
  } catch (err) {
    if (conn) { try { conn.raw.close(); } catch { /* already closed */ } }
    if (/newer than this/.test(err.message)) throw new Error(`${err.message} (${p})`);
    throw new Error(`agents.db at ${p} is not usable: ${err.message}`);
  }
  conns.set(p, conn);
  return conn;
}

/** Close every memoised connection, or only the one for `file`. */
function close(file) {
  for (const [p, conn] of conns) {
    if (file && p !== file) continue;
    try { conn.raw.close(); } catch { /* already closed */ }
    conns.delete(p);
  }
}

function write() {
  return open();
}

// ---------------------------------------------------------------------------
// Where a task dir sits in the root
// ---------------------------------------------------------------------------

/**
 * Map a task dir to its row identity, or null when it is outside the tasks
 * root or under trash/ (such dirs are written as files only).
 */
function locate(taskDir) {
  const { tasksRootBase } = require("./tasks-root");
  const rel = path.relative(tasksRootBase(), taskDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts[0] === "trash" || parts.length < 2) return null;
  if (parts[0] === "archive") {
    if (parts.length < 3) return null;
    return { repoKey: parts.slice(1, -1).join("/"), dirName: parts[parts.length - 1], disposition: "archived" };
  }
  return { repoKey: parts.slice(0, -1).join("/"), dirName: parts[parts.length - 1], disposition: "active" };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function str(v) { return v === undefined || v === null ? null : String(v); }

function appendEventOn(conn, { kind, repoKey, taskId, sessionId, detail }) {
  conn.run(
    "INSERT INTO events (at, kind, repo_key, task_id, session_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    nowIso(), kind, str(repoKey), taskId === undefined ? null : taskId, str(sessionId), str(detail)
  );
}

function appendEvent(evt) {
  const conn = write();
  conn.tx(() => appendEventOn(conn, evt));
}

/**
 * Insert or update a task row from the exact text of its task.json and rewrite
 * the phase, report and checkpoint projections in the same transaction.
 */
function upsertTask({ repoKey, dirName, disposition = "active", taskDir, filesDir, docText }) {
  const task = JSON.parse(docText);
  const conn = write();
  return conn.tx(() => {
    conn.run(
      `INSERT INTO tasks (repo_key, dir_name, disposition, task_dir, files_dir,
         slug, number, title, status, tier, mode, created, updated, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_key, dir_name) DO UPDATE SET
         disposition = excluded.disposition, task_dir = excluded.task_dir,
         files_dir = excluded.files_dir,
         slug = excluded.slug, number = excluded.number, title = excluded.title,
         status = excluded.status, tier = excluded.tier, mode = excluded.mode,
         created = excluded.created, updated = excluded.updated, doc = excluded.doc`,
      repoKey, dirName, disposition, taskDir,
      (typeof task.files_dir === "string" && task.files_dir) || filesDir || taskDir,
      str(task.slug), Number.isInteger(task.number) ? task.number : null, str(task.title),
      str(task.status), str(task.tier), str(task.mode), str(task.created), str(task.updated), docText
    );
    const { id } = conn.get("SELECT id FROM tasks WHERE repo_key = ? AND dir_name = ?", repoKey, dirName);
    conn.run("DELETE FROM phases WHERE task_id = ?", id);
    conn.run("DELETE FROM reports WHERE task_id = ?", id);
    conn.run("DELETE FROM checkpoints WHERE task_id = ?", id);

    const phases = Array.isArray(task.phases) ? task.phases : [];
    phases.forEach((p, ord) => {
      conn.run(
        `INSERT INTO phases (task_id, ord, phase_id, name, status, owner, branch, plan_path,
           landed_sha, started, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ord, Number.isInteger(p.id) ? p.id : null, str(p.name), str(p.status), str(p.owner),
        str(p.branch), str(p.plan_path), str(p.landed_sha), str(p.started), str(p.completed)
      );
      for (const [agent, report] of Object.entries(p.reports || {})) {
        if (report === null || report === undefined) continue;
        conn.run(
          "INSERT INTO reports (task_id, phase_ord, agent, doc) VALUES (?, ?, ?, ?)",
          id, ord, agent, JSON.stringify(report)
        );
      }
    });

    const cps = Array.isArray(task.checkpoints) ? task.checkpoints : [];
    cps.forEach((cp, ord) => {
      conn.run(
        `INSERT INTO checkpoints (task_id, ord, checkpoint_id, phase, type, chosen, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, ord, str(cp.id), Number.isInteger(cp.phase) ? cp.phase : null, str(cp.type),
        cp.chosen === null || cp.chosen === undefined ? null : String(cp.chosen), JSON.stringify(cp)
      );
    });

    appendEventOn(conn, {
      kind: "task.write", repoKey, taskId: id,
      detail: JSON.stringify(phases.map((p) => p.status)),
    });
    return id;
  });
}

function setTaskDisposition({ repoKey, dirName, disposition, taskDir }) {
  const conn = write();
  conn.tx(() => {
    const row = conn.get("SELECT id FROM tasks WHERE repo_key = ? AND dir_name = ?", repoKey, dirName);
    if (!row) return;
    conn.run(
      "UPDATE tasks SET disposition = ?, task_dir = COALESCE(?, task_dir) WHERE id = ?",
      disposition, taskDir || null, row.id
    );
    appendEventOn(conn, { kind: "task.close", repoKey, taskId: row.id, detail: disposition });
  });
}

/** Mark every live row whose task_dir is `dir` or lies under it as deleted. */
function markDeletedUnder(dir) {
  const conn = write();
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  conn.tx(() => {
    const rows = conn.all("SELECT id, repo_key, task_dir FROM tasks WHERE disposition != 'deleted'");
    for (const row of rows) {
      if (row.task_dir !== dir && !row.task_dir.startsWith(prefix)) continue;
      conn.run("UPDATE tasks SET disposition = 'deleted' WHERE id = ?", row.id);
      appendEventOn(conn, { kind: "task.close", repoKey: row.repo_key, taskId: row.id, detail: "deleted" });
    }
  });
}

function upsertSession(entryId, docText) {
  const reg = JSON.parse(docText);
  const conn = write();
  conn.tx(() => {
    conn.run(
      `INSERT INTO sessions (entry_id, session_id, terminal_id, repo_key, task_dir, agent, origin,
         cwd, pid, created_at, updated_at, ended_at, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET
         session_id = excluded.session_id, terminal_id = excluded.terminal_id,
         repo_key = excluded.repo_key, task_dir = excluded.task_dir, agent = excluded.agent,
         origin = excluded.origin, cwd = excluded.cwd, pid = excluded.pid,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         ended_at = excluded.ended_at, doc = excluded.doc`,
      entryId, str(reg.session_id), str(reg.terminal_id), str(reg.repo_key), str(reg.task_dir),
      str(reg.agent), str(reg.origin), str(reg.cwd), Number.isInteger(reg.pid) ? reg.pid : null,
      str(reg.created_at), str(reg.updated_at), str(reg.ended_at), docText
    );
    appendEventOn(conn, { kind: "session.write", repoKey: reg.repo_key, sessionId: reg.session_id });
  });
}

/**
 * Mirror the root index.json: keys in index order get ord 0..n-1. Repos not in
 * the index (found only on disk) keep their row and sort after.
 */
function upsertRepos(indexObj) {
  const conn = write();
  conn.tx(() => {
    const at = nowIso();
    Object.keys(indexObj).forEach((key, ord) => {
      const entry = indexObj[key] || {};
      conn.run(
        `INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET ord = excluded.ord, main_root = excluded.main_root,
           doc = excluded.doc, updated_at = excluded.updated_at`,
        key, ord, str(entry.main_root), JSON.stringify(entry), at
      );
    });
    appendEventOn(conn, { kind: "repos.write", detail: JSON.stringify({ repos: Object.keys(indexObj).length }) });
  });
}

/** Register a repo found only on disk (no index.json entry); the nth sorts after indexed repos. */
function ensureRepo(key, n) {
  const conn = write();
  conn.run(
    "INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, ?, NULL, '{}', ?) ON CONFLICT (key) DO NOTHING",
    key, UNINDEXED_ORD + n, nowIso()
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function listTasks({ disposition } = {}) {
  const conn = write();
  const rows = disposition
    ? conn.all("SELECT * FROM tasks WHERE disposition = ? ORDER BY repo_key, dir_name", disposition)
    : conn.all("SELECT * FROM tasks ORDER BY repo_key, dir_name");
  return rows.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Runs (headless agent runs started by `a run`)
// ---------------------------------------------------------------------------

/** The `tasks.id` of a task dir, or null when it is outside the central root or has no row. */
function taskIdOf(taskDir) {
  const at = locate(taskDir);
  if (!at) return null;
  const row = write().get("SELECT id FROM tasks WHERE repo_key = ? AND dir_name = ?", at.repoKey, at.dirName);
  return row ? row.id : null;
}

/**
 * Insert a run row and return `{ run_id, stream_path, err_path, exit_path }`.
 * The three path columns are set from the new run id inside the same
 * transaction, so no reader sees a row without them.
 */
function insertRun(fields, pathsFor) {
  const conn = write();
  return conn.tx(() => {
    const row = {
      status: "starting", resumed_from: null, pid: null, model: null, budget_usd: null,
      ...fields, stream_path: "", err_path: "", exit_path: "", started_at: nowIso(),
    };
    const cols = Object.keys(row);
    const info = conn.run(
      `INSERT INTO runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => (row[c] === undefined ? null : row[c]))
    );
    const runId = Number(info.lastInsertRowid);
    const paths = pathsFor(runId);
    conn.run("UPDATE runs SET stream_path = ?, err_path = ?, exit_path = ? WHERE run_id = ?",
      paths.stream_path, paths.err_path, paths.exit_path, runId);
    return { run_id: runId, ...paths };
  });
}

function updateRun(runId, fields) {
  const cols = Object.keys(fields).filter((c) => fields[c] !== undefined);
  const unknown = cols.filter((c) => !RUN_COLUMNS.includes(c));
  if (unknown.length > 0) throw new Error(`updateRun: unknown column ${unknown.join(", ")}`);
  if (cols.length === 0) return;
  write().run(
    `UPDATE runs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE run_id = ?`,
    ...cols.map((c) => fields[c]), runId
  );
}

/**
 * Take a live run to `reaping`. True for the one caller whose update changed
 * the row: a `starting` or `running` run, or a `reaping` one whose claim is
 * older than `staleBeforeIso`.
 */
function claimRun(runId, staleBeforeIso) {
  const info = write().run(
    `UPDATE runs SET status = 'reaping', reaping_at = ? WHERE run_id = ?
       AND (status IN ('starting', 'running') OR (status = 'reaping' AND reaping_at < ?))`,
    nowIso(), runId, staleBeforeIso
  );
  return Number(info.changes) === 1;
}

function getRun(runId) {
  const row = write().get(
    `SELECT runs.*, tasks.task_dir AS task_dir, tasks.files_dir AS files_dir
       FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE runs.run_id = ?`,
    runId
  );
  return row ? { ...row } : null;
}

/** Runs ordered by id; `live` keeps the `starting`, `running` and `reaping` ones, `taskId` one task's. */
function listRuns({ taskId, live } = {}) {
  const where = [];
  const params = [];
  if (taskId !== undefined && taskId !== null) { where.push("runs.task_id = ?"); params.push(taskId); }
  if (live) where.push(`runs.status IN (${LIVE_RUN_STATUSES.map(() => "?").join(", ")})`), params.push(...LIVE_RUN_STATUSES);
  const sql = `SELECT runs.*, tasks.task_dir AS task_dir, tasks.files_dir AS files_dir
    FROM runs JOIN tasks ON tasks.id = runs.task_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY runs.run_id`;
  return write().all(sql, ...params).map((r) => ({ ...r }));
}

function listSessions() {
  return write().all("SELECT * FROM sessions ORDER BY entry_id").map((r) => ({ ...r }));
}

function listRepos() {
  return write().all("SELECT * FROM repos ORDER BY ord, key").map((r) => ({ ...r }));
}

function counts() {
  const conn = write();
  const byDisp = Object.fromEntries(
    conn.all("SELECT disposition, count(*) AS n FROM tasks GROUP BY disposition").map((r) => [r.disposition, r.n])
  );
  return {
    tasks: conn.get("SELECT count(*) AS n FROM tasks").n,
    active: byDisp.active || 0,
    archived: byDisp.archived || 0,
    deleted: byDisp.deleted || 0,
    sessions: conn.get("SELECT count(*) AS n FROM sessions").n,
    repos: conn.get("SELECT count(*) AS n FROM repos").n,
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function backupPath() { return dbPath() + ".bak"; }

/** Hours since the last backup, or null when there is none. */
function backupAge() {
  try {
    return (Date.now() - fs.statSync(backupPath()).mtimeMs) / 3600000;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** VACUUM INTO a sibling .bak, skipped while the existing one is younger than maxAgeHours. */
function backup({ maxAgeHours = 24 } = {}) {
  const p = dbPath();
  if (!fs.existsSync(p)) return { backed_up: false, reason: "no-db" };
  const age = backupAge();
  if (age !== null && age < maxAgeHours) return { backed_up: false, reason: "fresh", age_hours: age };
  const tmp = p + ".bak.tmp";
  try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== "ENOENT") throw err; }
  write().run("VACUUM INTO ?", tmp);
  fs.renameSync(tmp, backupPath());
  return { backed_up: true, path: backupPath() };
}

/** Read-only summary for doctor; never creates the file. */
function describe() {
  const info = { path: null, present: false, schema_version: null, tasks: null, sessions: null,
    backup_age_hours: null, node_ok: nodeSqliteOk() };
  let p;
  try { p = dbPath(); } catch (err) { info.error = err.message; return info; }
  info.path = p;
  if (!fs.existsSync(p)) return info;
  info.present = true;
  info.backup_age_hours = backupAge();
  if (!info.node_ok) return info;
  let conn;
  try {
    conn = open({ readonly: true });
    const v = conn.get("SELECT version FROM schema_version");
    info.schema_version = v ? v.version : null;
    info.tasks = conn.get("SELECT count(*) AS n FROM tasks").n;
    info.sessions = conn.get("SELECT count(*) AS n FROM sessions").n;
  } catch (err) {
    info.error = err.message;
  } finally {
    if (conn) { try { conn.raw.close(); } catch { /* already closed */ } }
  }
  return info;
}

module.exports = {
  SCHEMA_VERSION, UNINDEXED_ORD, dbPath, enabled, open, close, locate, nodeSqliteOk,
  upsertTask, setTaskDisposition, markDeletedUnder, upsertSession, upsertRepos, ensureRepo,
  appendEvent, listTasks, listSessions, listRepos, counts,
  LIVE_RUN_STATUSES, taskIdOf, insertRun, updateRun, claimRun, getRun, listRuns,
  backup, backupAge, describe,
};
