"use strict";

/**
 * One SQLite file holds every task, phase, checkmark, decision, note, session
 * and repo. The database is the one source of declared intent; status and
 * landing are derived on read, never stored. The file is always on: the first
 * open creates it, and a schema-1 file migrates on its first open by this
 * engine (the home default only under the installed engine; db-migrate.js).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const dbMigrate = require("./db-migrate");

const SCHEMA_VERSION = 2;
const DOT_NAME = ".agents.db";
/** Repos known only from disk (no index entry) get ord >= this and stay out of the root index. */
const UNINDEXED_ORD = 1000000;

/** The event kinds that carry a task's intent: recency, the cache key and the sweep's grace read only these. */
const INTENT_KINDS = [
  "task_new", "add_phases", "check", "decide", "note", "knob",
  "land", "close", "start", "resume", "migrate",
];

/** The v2 DDL. The migrator reuses the per-table statements for its rebuild. */
const CREATE_TABLES = {
  schema_version: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`,
  repos: `CREATE TABLE IF NOT EXISTS repos (
  key TEXT PRIMARY KEY, ord INTEGER NOT NULL, main_root TEXT, doc TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  tasks: `CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, repo_key TEXT NOT NULL, dir_name TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN ('active','archived','deleted')),
  task_dir TEXT NOT NULL,
  slug TEXT, number INTEGER, title TEXT, tier TEXT, mode TEXT, created TEXT,
  approvals TEXT, land TEXT, worktree_path TEXT, branch TEXT,
  UNIQUE (repo_key, dir_name));`,
  phases: `CREATE TABLE IF NOT EXISTS phases (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase_id INTEGER NOT NULL,
  ord INTEGER NOT NULL, name TEXT, after TEXT,
  PRIMARY KEY (task_id, phase_id));`,
  checkmarks: `CREATE TABLE IF NOT EXISTS checkmarks (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase_id INTEGER NOT NULL,
  session_id TEXT NOT NULL, checked_at TEXT NOT NULL,
  UNIQUE (task_id, phase_id));`,
  notes: `CREATE TABLE IF NOT EXISTS notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase_id INTEGER,
  text TEXT NOT NULL, session_id TEXT, at TEXT NOT NULL);`,
  sessions: `CREATE TABLE IF NOT EXISTS sessions (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT, terminal_id TEXT, repo_key TEXT, task_dir TEXT, agent TEXT, origin TEXT,
  cwd TEXT, pid INTEGER, created_at TEXT, updated_at TEXT, ended_at TEXT, doc TEXT NOT NULL);`,
  events: `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
  repo_key TEXT, task_id INTEGER, session_id TEXT, detail TEXT);`,
  decisions: `CREATE TABLE IF NOT EXISTS decisions (
  decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phase_id INTEGER, choice TEXT NOT NULL, gate TEXT, plan_hash TEXT, quote TEXT NOT NULL,
  recorded_by TEXT, decided_at TEXT NOT NULL);`,
  pending_folds: `CREATE TABLE IF NOT EXISTS pending_folds (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, path TEXT NOT NULL);`,
};

const CREATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS decisions_task ON decisions (task_id, phase_id);",
  "CREATE INDEX IF NOT EXISTS tasks_repo ON tasks (repo_key, disposition);",
  "CREATE INDEX IF NOT EXISTS sessions_repo ON sessions (repo_key);",
  "CREATE INDEX IF NOT EXISTS events_task ON events (task_id, id);",
  "CREATE INDEX IF NOT EXISTS notes_task ON notes (task_id);",
];

const SCHEMA = Object.values(CREATE_TABLES).join("\n") + "\n" + CREATE_INDEXES.join("\n");

/** v1-only names a v2 open drops when it finds them (an M1 `a` can recreate some of these on a v2 file). */
const V1_TABLES = ["runs", "reports", "checkpoints"];
const V1_TASK_COLUMNS = ["next_json", "awaiting", "status", "doc", "updated", "files_dir"];
const V1_INDEXES = ["runs_task", "runs_status"];

// ---------------------------------------------------------------------------
// Paths
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

/** Drop every v1-only table, index and column when present; idempotent. */
function reAssert(conn) {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of V1_TABLES) {
    if (tables.includes(t)) conn.raw.exec(`DROP TABLE ${t}`);
  }
  const indexes = conn.all("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  for (const ix of V1_INDEXES) {
    if (indexes.includes(ix)) conn.raw.exec(`DROP INDEX ${ix}`);
  }
  const taskColumns = conn.all("PRAGMA table_info(tasks)").map((c) => c.name);
  for (const col of V1_TASK_COLUMNS) {
    if (taskColumns.includes(col)) conn.raw.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  }
}

function initSchema(conn) {
  conn.raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
  conn.raw.exec(SCHEMA);
  reAssert(conn);
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
 * - create: make the file when it is missing (a fresh install gets its
 *   database on the first open).
 * - readonly: a separate, uncached read-only connection (doctor, tests); it
 *   never migrates.
 * A v1 file migrates here (db-migrate) unless it is the home default and this
 * engine is not the installed one, which refuses with exit 2.
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
  let version;
  try {
    version = dbMigrate.readVersion(p);
  } catch (err) {
    throw new Error(`agents.db at ${p} is not usable: ${err.message}`);
  }
  if (version !== null && version > SCHEMA_VERSION) {
    throw new Error(`agents.db schema v${version} is newer than this \`a\` (v${SCHEMA_VERSION}); run ./install.sh (${p})`);
  }
  if (version === 1) {
    const gate = dbMigrate.mayMigrate(p);
    if (!gate.ok) throw dbMigrate.refusalError(p, gate.engineRoot);
  }
  let conn;
  try {
    conn = new Conn(new DatabaseSync(p), p);
    conn.raw.exec("PRAGMA busy_timeout=5000");
    if (version === 1) dbMigrate.migrate(conn);
    initSchema(conn);
  } catch (err) {
    if (conn) { try { conn.raw.close(); } catch { /* already closed */ } }
    if (err.exitCode === 2 || /newer than this/.test(err.message)) throw err;
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

/** The write connection: the database is always on, so writes create the file. */
function write() {
  return open({ create: true });
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
// Events
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function str(v) { return v === undefined || v === null ? null : String(v); }

/**
 * A repo key as stored: the relative path under the tasks root, so a
 * path-shaped key (a local origin) loses its leading slash.
 */
function storedKey(k) {
  return String(k).replace(/\/{2,}/g, "/").replace(/^\//, "");
}

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

/** `max(id)` over every events row: `a ls --json`'s `data_version`. */
function maxEventId() {
  const row = write().get("SELECT max(id) AS n FROM events");
  return row && row.n !== null ? Number(row.n) : 0;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function listTasks({ disposition, repoKey } = {}) {
  const conn = write();
  // a path-shaped repo key (a local origin) loses its leading slash in the table
  const key = repoKey === undefined || repoKey === null ? null : storedKey(repoKey);
  let rows;
  if (disposition && key) rows = conn.all("SELECT * FROM tasks WHERE disposition = ? AND repo_key = ? ORDER BY repo_key, dir_name", disposition, key);
  else if (disposition) rows = conn.all("SELECT * FROM tasks WHERE disposition = ? ORDER BY repo_key, dir_name", disposition);
  else if (key) rows = conn.all("SELECT * FROM tasks WHERE repo_key = ? ORDER BY repo_key, dir_name", key);
  else rows = conn.all("SELECT * FROM tasks ORDER BY repo_key, dir_name");
  return rows.map((r) => ({ ...r }));
}

/** The `tasks.id` of a task dir, or null when it is outside the central root or has no row. */
function taskIdOf(taskDir) {
  const at = locate(taskDir);
  if (!at) return null;
  const row = write().get("SELECT id FROM tasks WHERE repo_key = ? AND dir_name = ?", at.repoKey, at.dirName);
  return row ? row.id : null;
}

function findTask(repoKey, dirName) {
  const row = write().get("SELECT * FROM tasks WHERE repo_key = ? AND dir_name = ?", storedKey(repoKey), dirName);
  return row ? { ...row } : null;
}

function getTask(taskId) {
  const row = write().get("SELECT * FROM tasks WHERE id = ?", taskId);
  return row ? { ...row } : null;
}

/** The highest task number a repo's rows carry, or null. */
function maxTaskNumber(repoKey) {
  const row = write().get("SELECT max(number) AS n FROM tasks WHERE repo_key = ?", storedKey(repoKey));
  return row ? row.n : null;
}

/** Insert a task row with its phases and its `task_new` event; returns the id. */
function createTaskRow({ repoKey, dirName, taskDir, slug, number, title, tier, mode, created, approvals, land, worktreePath, branch, phases }) {
  const conn = write();
  return conn.tx(() => {
    const info = conn.run(
      `INSERT INTO tasks (repo_key, dir_name, disposition, task_dir, slug, number, title, tier, mode,
         created, approvals, land, worktree_path, branch)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      storedKey(repoKey), dirName, taskDir, str(slug), Number.isInteger(number) ? number : null, str(title),
      str(tier), str(mode), str(created), str(approvals), str(land), str(worktreePath), str(branch)
    );
    const id = Number(info.lastInsertRowid);
    for (const [ord, p] of (phases || []).entries()) {
      conn.run("INSERT INTO phases (task_id, phase_id, ord, name, after) VALUES (?, ?, ?, ?, ?)",
        id, p.id, ord, str(p.name), JSON.stringify(Array.isArray(p.after) ? p.after : []));
    }
    appendEventOn(conn, { kind: "task_new", repoKey, taskId: id, detail: JSON.stringify({ dir: dirName }) });
    return id;
  });
}

/**
 * Upsert phases by id with their `add_phases` event: a new id appends after the
 * last; an existing id updates its name and after only, never its checkmark.
 */
function upsertPhases(taskId, phases) {
  const conn = write();
  return conn.tx(() => {
    for (const p of phases) {
      const existing = conn.get("SELECT task_id FROM phases WHERE task_id = ? AND phase_id = ?", taskId, p.id);
      if (existing) {
        conn.run("UPDATE phases SET name = ?, after = ? WHERE task_id = ? AND phase_id = ?",
          str(p.name), JSON.stringify(Array.isArray(p.after) ? p.after : []), taskId, p.id);
      } else {
        const ord = (conn.get("SELECT max(ord) AS n FROM phases WHERE task_id = ?", taskId) || {}).n;
        conn.run("INSERT INTO phases (task_id, phase_id, ord, name, after) VALUES (?, ?, ?, ?, ?)",
          taskId, p.id, (ord === null || ord === undefined ? -1 : ord) + 1, str(p.name), JSON.stringify(Array.isArray(p.after) ? p.after : []));
      }
    }
    appendEventOn(conn, { kind: "add_phases", taskId, detail: JSON.stringify(phases.map((p) => p.id)) });
    return listPhases(taskId);
  });
}

/** A task's phases, `after` parsed: [{phase_id, ord, name, after: []}]. */
function listPhases(taskId) {
  return write().all("SELECT * FROM phases WHERE task_id = ? ORDER BY ord, phase_id", taskId)
    .map((r) => ({ task_id: r.task_id, phase_id: r.phase_id, ord: r.ord, name: r.name, after: parseJsonArray(r.after) }));
}

function parseJsonArray(text) {
  if (text === null || text === undefined) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Insert a checkmark with its `check` event when the phase has none; false when it was already checked. */
function insertCheckmark(taskId, phaseId, sessionId, checkedAt) {
  const conn = write();
  return conn.tx(() => {
    const existing = conn.get("SELECT * FROM checkmarks WHERE task_id = ? AND phase_id = ?", taskId, phaseId);
    if (existing) return false;
    conn.run("INSERT INTO checkmarks (task_id, phase_id, session_id, checked_at) VALUES (?, ?, ?, ?)",
      taskId, phaseId, str(sessionId), checkedAt);
    appendEventOn(conn, { kind: "check", taskId, sessionId, detail: JSON.stringify({ phase_id: phaseId }) });
    return true;
  });
}

function checkmarkOf(taskId, phaseId) {
  const row = write().get("SELECT * FROM checkmarks WHERE task_id = ? AND phase_id = ?", taskId, phaseId);
  return row ? { ...row } : null;
}

/** A task's checkmarks: Map of phase_id to {session_id, checked_at}. */
function checkmarksOf(taskId) {
  const rows = write().all("SELECT * FROM checkmarks WHERE task_id = ?", taskId);
  const out = new Map();
  for (const r of rows) out.set(r.phase_id, { session_id: r.session_id, checked_at: r.checked_at });
  return out;
}

/** Record where a task's work lives (identity, not status; no event). */
function setTaskWorktree(taskId, { worktreePath, branch } = {}) {
  const conn = write();
  conn.tx(() => {
    if (worktreePath !== undefined) conn.run("UPDATE tasks SET worktree_path = ? WHERE id = ?", worktreePath || null, taskId);
    if (branch !== undefined) conn.run("UPDATE tasks SET branch = ? WHERE id = ?", branch || null, taskId);
  });
}

/** Rows whose branch or worktree_path names a worktree being removed. */
function tasksOnWorktree(branch, wtPath) {
  return write().all(
    "SELECT * FROM tasks WHERE (branch = ? AND branch IS NOT NULL) OR (worktree_path = ? AND worktree_path IS NOT NULL)",
    branch || "", wtPath || ""
  ).map((r) => ({ ...r }));
}

/** Set one of the two intent knobs with its `knob` event. */
function setTaskKnob(taskId, knob, value) {
  const conn = write();
  conn.tx(() => {
    conn.run(`UPDATE tasks SET ${knob} = ? WHERE id = ?`, value, taskId);
    appendEventOn(conn, { kind: "knob", taskId, detail: JSON.stringify({ knob, value }) });
  });
}

/** `max(at)` and `max(id)` over a task's intent events. */
function intentRecency(taskId) {
  const kinds = INTENT_KINDS.map(() => "?").join(", ");
  const row = write().get(`SELECT max(at) AS at, max(id) AS id FROM events WHERE task_id = ? AND kind IN (${kinds})`, taskId, ...INTENT_KINDS);
  return { at: row && row.at ? row.at : null, id: row && row.id ? Number(row.id) : null };
}

function setTaskDisposition({ repoKey, dirName, disposition, taskDir }) {
  const conn = write();
  conn.tx(() => {
    const row = conn.get("SELECT id FROM tasks WHERE repo_key = ? AND dir_name = ?", storedKey(repoKey), dirName);
    if (!row) return;
    conn.run(
      "UPDATE tasks SET disposition = ?, task_dir = COALESCE(?, task_dir) WHERE id = ?",
      disposition, taskDir || null, row.id
    );
    appendEventOn(conn, { kind: "close", repoKey, taskId: row.id, detail: disposition });
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
      appendEventOn(conn, { kind: "close", repoKey: row.repo_key, taskId: row.id, detail: "deleted" });
    }
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Insert a decision row and return its id. `phase_id` null means a task-level gate. */
function insertDecision({ task_id, phase_id, choice, gate, plan_hash, quote, recorded_by, decided_at }) {
  const info = write().run(
    "INSERT INTO decisions (task_id, phase_id, choice, gate, plan_hash, quote, recorded_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    task_id, phase_id === undefined ? null : phase_id, choice, str(gate), str(plan_hash), quote, str(recorded_by),
    decided_at || nowIso()
  );
  return Number(info.lastInsertRowid);
}

function listDecisions({ taskId } = {}) {
  const rows = taskId === undefined || taskId === null
    ? write().all("SELECT * FROM decisions ORDER BY decision_id")
    : write().all("SELECT * FROM decisions WHERE task_id = ? ORDER BY decision_id", taskId);
  return rows.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function insertNote({ task_id, phase_id, text, session_id, at }) {
  const info = write().run(
    "INSERT INTO notes (task_id, phase_id, text, session_id, at) VALUES (?, ?, ?, ?, ?)",
    task_id, phase_id === undefined ? null : phase_id, text, str(session_id), at || nowIso()
  );
  return Number(info.lastInsertRowid);
}

function listNotes(taskId) {
  return write().all("SELECT * FROM notes WHERE task_id = ? ORDER BY note_id", taskId).map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Pending folds
// ---------------------------------------------------------------------------

function pendingFoldOf(taskId) {
  const row = write().get("SELECT * FROM pending_folds WHERE task_id = ?", taskId);
  return row ? row.path : null;
}

function listPendingFolds() {
  return write().all("SELECT * FROM pending_folds ORDER BY task_id").map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Sessions and repos
// ---------------------------------------------------------------------------

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
 * The one repos store: merge `fields` into the key's doc, set `main_root` when
 * given, stamp `last_seen`, and give a new key (or one at `ord >=
 * UNINDEXED_ORD`) the next ord below `UNINDEXED_ORD`, as the index order did.
 */
function upsertRepo(key, fields = {}) {
  const conn = write();
  conn.tx(() => {
    const at = nowIso();
    key = storedKey(key);
    const row = conn.get("SELECT * FROM repos WHERE key = ?", key);
    const doc = { ...((row && JSON.parse(row.doc)) || {}), ...fields, last_seen: at };
    let ord = row ? row.ord : UNINDEXED_ORD;
    if (!row || ord >= UNINDEXED_ORD) {
      const max = conn.get(`SELECT max(ord) AS n FROM repos WHERE ord < ${UNINDEXED_ORD}`);
      ord = (max && max.n !== null ? Number(max.n) : -1) + 1;
    }
    conn.run(
      `INSERT INTO repos (key, ord, main_root, doc, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET ord = excluded.ord, main_root = excluded.main_root,
         doc = excluded.doc, updated_at = excluded.updated_at`,
      key, ord, fields.main_root !== undefined ? str(fields.main_root) : (row && row.main_root) || null,
      JSON.stringify(doc), at
    );
    appendEventOn(conn, { kind: "repos.write", detail: JSON.stringify({ repos: 1 }) });
  });
}

function listSessions() {
  return write().all("SELECT * FROM sessions ORDER BY entry_id").map((r) => ({ ...r }));
}

function listRepos() {
  return write().all("SELECT * FROM repos ORDER BY ord, key").map((r) => ({ ...r }));
}

function repoOf(key) {
  const row = write().get("SELECT * FROM repos WHERE key = ?", key);
  return row ? { ...row } : null;
}

// ---------------------------------------------------------------------------
// Reads for the derived view
// ---------------------------------------------------------------------------

/** The `at` of the newest event of `kind` on a task, or null. */
function lastEventAt(taskId, kind) {
  const row = write().get("SELECT at FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1", taskId, kind);
  return row ? row.at : null;
}

/** A task's newest `land` event, detail parsed, or null. */
function lastLandEvent(taskId) {
  const row = write().get("SELECT * FROM events WHERE task_id = ? AND kind = 'land' ORDER BY id DESC LIMIT 1", taskId);
  if (!row) return null;
  let detail = {};
  try { detail = JSON.parse(row.detail || "{}"); } catch { /* detail stays empty */ }
  return { id: Number(row.id), at: row.at, ...detail };
}

// ---------------------------------------------------------------------------
// Counts, backup, doctor
// ---------------------------------------------------------------------------

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

/** Every `<db>.v1.bak*` beside the database, newest last (the migration's backups; doctor lists them). */
function v1BackupPaths(p) {
  try {
    const base = path.basename(p);
    return fs.readdirSync(path.dirname(p))
      .filter((n) => n.startsWith(`${base}.v1.bak`))
      .sort()
      .map((n) => path.join(path.dirname(p), n));
  } catch {
    return [];
  }
}

/** Read-only summary for doctor; never creates the file and never migrates. */
function describe() {
  const info = { path: null, present: false, schema_version: null, tasks: null, sessions: null,
    pending_folds: null, v1_backups: [], backup_age_hours: null, node_ok: nodeSqliteOk() };
  let p;
  try { p = dbPath(); } catch (err) { info.error = err.message; return info; }
  info.path = p;
  if (!fs.existsSync(p)) return info;
  info.present = true;
  info.v1_backups = v1BackupPaths(p);
  info.backup_age_hours = backupAge();
  if (!info.node_ok) return info;
  let conn;
  try {
    conn = open({ readonly: true });
    const v = conn.get("SELECT version FROM schema_version");
    info.schema_version = v ? v.version : null;
    info.tasks = conn.get("SELECT count(*) AS n FROM tasks").n;
    info.sessions = conn.get("SELECT count(*) AS n FROM sessions").n;
    if (info.schema_version === SCHEMA_VERSION) {
      info.pending_folds = conn.get("SELECT count(*) AS n FROM pending_folds").n;
    }
  } catch (err) {
    info.error = err.message;
  } finally {
    if (conn) { try { conn.raw.close(); } catch { /* already closed */ } }
  }
  return info;
}

module.exports = {
  SCHEMA_VERSION, UNINDEXED_ORD, INTENT_KINDS, CREATE_TABLES, CREATE_INDEXES, dbPath, open, close, locate, nodeSqliteOk,
  appendEvent, appendEventOn, maxEventId, lastEventAt, lastLandEvent,
  listTasks, taskIdOf, findTask, getTask, maxTaskNumber, createTaskRow, upsertPhases, listPhases,
  insertCheckmark, checkmarkOf, checkmarksOf, setTaskWorktree, tasksOnWorktree, setTaskKnob,
  intentRecency, setTaskDisposition, markDeletedUnder,
  insertDecision, listDecisions, insertNote, listNotes,
  pendingFoldOf, listPendingFolds,
  upsertSession, upsertRepo, listSessions, listRepos, repoOf,
  counts, backup, backupAge, describe, storedKey,
};
