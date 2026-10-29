"use strict";

/**
 * `a task import`: load today's task.json / registration.json / index.json
 * files into agents.db. Without `apply` it is a dry run that writes nothing
 * under the roots: it loads a throwaway database, renders the exports from it
 * and compares them with what the files say. With `apply` it refuses on any
 * unreadable task.json or unequal export, then creates the database and loads
 * it, moving each original into a dated trash bundle before the export takes
 * its place.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const exp = require("./db-export");

function listDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

/**
 * Find task dirs under the tasks root: `<key>/<dir>/task.json` and
 * `archive/<key>/<dir>/task.json`. Dot dirs and trash/ are skipped and a task
 * dir is not descended into. A dir holding only a v1 state.json is listed in
 * `skipped`.
 */
function scanRoot(root) {
  const tasks = [];
  const skipped = [];
  const walk = (dir, relParts, disposition) => {
    for (const name of listDirs(dir)) {
      if (disposition === "active" && relParts.length === 0 && (name === "archive" || name === "trash")) continue;
      const full = path.join(dir, name);
      if (relParts.length > 0 && fs.existsSync(path.join(full, "task.json"))) {
        const file = path.join(full, "task.json");
        const rec = { repoKey: relParts.join("/"), dirName: name, disposition, taskDir: full, raw: null, task: null, error: null };
        try {
          rec.raw = fs.readFileSync(file, "utf8");
          rec.task = JSON.parse(rec.raw);
          if (rec.task === null || typeof rec.task !== "object" || Array.isArray(rec.task)) {
            throw new Error("not a JSON object");
          }
        } catch (err) {
          rec.error = `${file}: ${err.message}`;
        }
        tasks.push(rec);
      } else if (relParts.length > 0 && fs.existsSync(path.join(full, "state.json"))) {
        skipped.push({ path: full, reason: "v1-state-json-only" });
      } else {
        walk(full, [...relParts, name], disposition);
      }
    }
  };
  if (fs.existsSync(root)) {
    if (fs.existsSync(path.join(root, "archive"))) walk(path.join(root, "archive"), [], "archived");
    walk(root, [], "active");
  }
  return { tasks, skipped };
}

/** Every `<id>/registration.json` under the sessions root, as text and parsed. */
function scanSessions(root) {
  const entries = [];
  if (fs.existsSync(root)) {
    for (const name of listDirs(root)) {
      const file = path.join(root, name, "registration.json");
      const raw = readIfExists(file);
      if (raw === null) continue;
      const entry = { entryId: name, dir: path.join(root, name), raw, reg: null, error: null };
      try {
        entry.reg = JSON.parse(raw);
        if (entry.reg === null || typeof entry.reg !== "object" || Array.isArray(entry.reg)) {
          throw new Error("not a JSON object");
        }
      } catch (err) {
        entry.error = `${file}: ${err.message}`;
      }
      entries.push(entry);
    }
  }
  return { entries };
}

function readIndex(errors) {
  const { rootIndexPath } = require("./tasks-root");
  const raw = readIfExists(rootIndexPath());
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed;
  } catch (err) {
    errors.push(`${rootIndexPath()}: ${err.message}`);
    return {};
  }
}

function loadRepos(scan, indexObj) {
  db.upsertRepos(indexObj);
  const extra = [...new Set(scan.tasks.map((t) => t.repoKey))].filter((k) => !(k in indexObj)).sort();
  extra.forEach((key, n) => db.ensureRepo(key, n));
}

function loadAll(scan, sessionScan, indexObj) {
  loadRepos(scan, indexObj);
  for (const t of scan.tasks) {
    if (t.error) continue;
    db.upsertTask({
      repoKey: t.repoKey, dirName: t.dirName, disposition: t.disposition,
      taskDir: t.taskDir, filesDir: t.taskDir, docText: t.raw,
    });
  }
  for (const s of sessionScan.entries) {
    if (!s.error) db.upsertSession(s.entryId, s.raw);
  }
}

function withTempDb(fn) {
  const { removeTempDir } = require("./trash");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-import-"));
  const file = path.join(dir, "agents.db");
  const previous = process.env.AGENTS_DB;
  process.env.AGENTS_DB = file;
  try {
    db.open({ create: true });
    return fn();
  } finally {
    db.close(file);
    if (previous === undefined) delete process.env.AGENTS_DB;
    else process.env.AGENTS_DB = previous;
    removeTempDir(dir);
  }
}

function summarize(scan, sessionScan, indexObj) {
  const good = scan.tasks.filter((t) => !t.error);
  const byRepo = {};
  for (const t of good) byRepo[t.repoKey] = (byRepo[t.repoKey] || 0) + 1;
  const keys = new Set([...Object.keys(indexObj), ...good.map((t) => t.repoKey)]);
  return {
    repos: keys.size,
    tasks: good.length,
    by_repo: Object.fromEntries(Object.entries(byRepo).sort(([a], [b]) => (a < b ? -1 : 1))),
    sessions: sessionScan.entries.filter((s) => !s.error).length,
    skipped: scan.skipped,
  };
}

function gatherErrors(scan, sessionScan, indexErrors) {
  return [
    ...indexErrors,
    ...scan.tasks.filter((t) => t.error).map((t) => t.error),
    ...sessionScan.entries.filter((s) => s.error).map((s) => s.error),
  ];
}

function dryRun(scan, sessionScan, indexObj) {
  return withTempDb(() => {
    loadAll(scan, sessionScan, indexObj);
    const cmp = exp.compareTrees(exp.filesTree(scan), exp.dbTree());
    return cmp.diffs;
  });
}

function unlinkIfExists(file) {
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

/**
 * Load the files into the database. Re-running is the recovery for anything
 * that landed during a previous run: it only moves originals whose bytes
 * differ from the export, or tasks the database did not have yet.
 */
function importAll({ apply = false } = {}) {
  const { tasksRootBase } = require("./tasks-root");
  const { sessionsRoot } = require("./session");
  const root = tasksRootBase();
  const dbFile = db.dbPath();

  const indexErrors = [];
  const scan = scanRoot(root);
  const sessionScan = scanSessions(sessionsRoot());
  const indexObj = readIndex(indexErrors);
  const errors = gatherErrors(scan, sessionScan, indexErrors);
  const result = {
    apply, refused: false, db: dbFile,
    ...summarize(scan, sessionScan, indexObj),
    mismatches: dryRun(scan, sessionScan, indexObj),
    errors,
    trashed_to: null,
  };
  if (!apply) return result;
  if (errors.length > 0 || result.mismatches.length > 0) {
    result.refused = true;
    return result;
  }

  const created = !fs.existsSync(dbFile);
  db.open({ create: true });
  const finalErrors = [];
  const scan2 = scanRoot(root);
  const sessionScan2 = scanSessions(sessionsRoot());
  const indexObj2 = readIndex(finalErrors);
  finalErrors.push(...gatherErrors(scan2, sessionScan2, []));
  if (finalErrors.length > 0) {
    if (created) {
      db.close(dbFile);
      for (const suffix of ["", "-wal", "-shm"]) unlinkIfExists(dbFile + suffix);
    }
    return { ...result, refused: true, errors: finalErrors };
  }

  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  const bundle = exp.makeBundle("agents-import");
  const known = new Map(db.listTasks().filter((r) => r.disposition !== "deleted")
    .map((r) => [`${r.repo_key}|${r.dir_name}`, r]));
  const knownSessions = new Map(db.listSessions().map((r) => [r.entry_id, r]));

  loadRepos(scan2, indexObj2);
  for (const t of scan2.tasks) {
    const rel = exp.taskRel(t.disposition, t.repoKey, t.dirName);
    withLock(t.taskDir, holder, () => {
      const jsonFile = path.join(t.taskDir, "task.json");
      const raw = fs.readFileSync(jsonFile, "utf8");
      const row = known.get(`${t.repoKey}|${t.dirName}`);
      const isNew = !row;
      if (isNew || row.doc !== raw || row.task_dir !== t.taskDir || row.disposition !== t.disposition) {
        db.upsertTask({
          repoKey: t.repoKey, dirName: t.dirName, disposition: t.disposition,
          taskDir: t.taskDir, filesDir: t.taskDir, docText: raw,
        });
      }
      if (isNew) bundle.keep(path.join(rel, "task.json"), jsonFile);
    });
  }
  for (const s of sessionScan2.entries) {
    const row = knownSessions.get(s.entryId);
    if (!row || row.doc !== s.raw) db.upsertSession(s.entryId, s.raw);
  }

  const counts = db.counts();
  db.appendEvent({ kind: "import", detail: JSON.stringify({ tasks: counts.tasks, sessions: counts.sessions }) });
  return { ...result, ...summarize(scan2, sessionScan2, indexObj2), trashed_to: bundle.path };
}

module.exports = { scanRoot, scanSessions, importAll };
