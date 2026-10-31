"use strict";

/**
 * `a task import`: re-index the registration.json files under the sessions
 * root into the `sessions` table. Without `--apply` it lists what it would
 * index and writes nothing; with `--apply` it upserts each entry. The fold of
 * the repo-local leftovers, the task.json and index.json moves, the
 * recorded-commit confirmation and the unresolved list arrive with the file
 * step (the `--apply` that follows the install-day migration).
 */

const fs = require("fs");
const path = require("path");

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

function importAll({ apply = false } = {}) {
  const { sessionsRoot } = require("./session");
  const db = require("./db");
  const scan = scanSessions(sessionsRoot());
  const good = scan.entries.filter((s) => !s.error);
  const result = {
    apply,
    db: db.dbPath(),
    sessions: good.length,
    skipped: scan.entries.filter((s) => s.error).map((s) => ({ path: s.dir, reason: s.error })),
    errors: scan.entries.filter((s) => s.error).map((s) => s.error),
  };
  if (!apply) return result;
  db.open({ create: true });
  for (const s of good) db.upsertSession(s.entryId, s.raw);
  return result;
}

module.exports = { scanSessions, importAll };
