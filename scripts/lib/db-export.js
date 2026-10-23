"use strict";

/**
 * Exports rendered from agents.db: task.json (the stored text), state.md and
 * INDEX.md, laid out as `<key>/<dir>/…`, `archive/<key>/<dir>/…` and `INDEX.md`.
 * Trees are Maps of relative path to text so a comparison never touches disk.
 */

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { renderStateMdText, renderIndexMdText } = require("./render");

function taskRel(disposition, repoKey, dirName) {
  return disposition === "archived"
    ? path.join("archive", repoKey, dirName)
    : path.join(repoKey, dirName);
}

function sortedBy(rows, pick) {
  return rows.slice().sort((a, b) => (pick(a) < pick(b) ? -1 : pick(a) > pick(b) ? 1 : 0));
}

/**
 * INDEX.md rows in the order both sources must agree on: repos in index.json
 * order, then dirs in sorted name order; live sessions per repo key.
 * @param {string[]} repoOrder repo keys in index order
 * @param {{key: string, dirName: string, task: object}[]} activeTasks
 * @param {object[]} registrations parsed registration.json objects
 */
function indexRows(repoOrder, activeTasks, registrations) {
  const sessionLib = require("./session");
  const liveByKey = new Map();
  const liveFor = (key) => {
    if (!liveByKey.has(key)) {
      liveByKey.set(key, registrations.filter((r) => r.repo_key === key && sessionLib.isLive(r)));
    }
    return liveByKey.get(key);
  };
  const rows = [];
  for (const key of repoOrder) {
    const mine = sortedBy(activeTasks.filter((t) => t.key === key), (t) => t.dirName);
    for (const t of mine) rows.push({ key, task: t.task, liveSessions: liveFor(key) });
  }
  return rows;
}

/** The export tree rendered from the database. */
function dbTree() {
  const tree = new Map();
  const active = [];
  for (const row of db.listTasks()) {
    if (row.disposition === "deleted") continue;
    const rel = taskRel(row.disposition, row.repo_key, row.dir_name);
    const task = JSON.parse(row.doc);
    tree.set(path.join(rel, "task.json"), row.doc);
    tree.set(path.join(rel, "state.md"), renderStateMdText(task));
    if (row.disposition === "active") active.push({ key: row.repo_key, dirName: row.dir_name, task });
  }
  const repoOrder = db.listRepos().filter((r) => r.ord < db.UNINDEXED_ORD).map((r) => r.key);
  const regs = db.listSessions().map((s) => JSON.parse(s.doc));
  tree.set("INDEX.md", renderIndexMdText(indexRows(repoOrder, active, regs)));
  return tree;
}

/**
 * The same tree built from the files in a scan.
 * - "source": state.md is what the renderer would write for each task.json
 * - "live": state.md is whatever is on disk (absent when there is none)
 */
function filesTree(scan, sessionScan, { stateMd }) {
  const { readRootIndex } = require("./tasks-root");
  const tree = new Map();
  const active = [];
  for (const t of scan.tasks) {
    if (t.error) continue;
    const rel = taskRel(t.disposition, t.repoKey, t.dirName);
    tree.set(path.join(rel, "task.json"), t.raw);
    if (stateMd === "source") {
      tree.set(path.join(rel, "state.md"), renderStateMdText(t.task));
    } else {
      try { tree.set(path.join(rel, "state.md"), fs.readFileSync(path.join(t.taskDir, "state.md"), "utf8")); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    if (t.disposition === "active") active.push({ key: t.repoKey, dirName: t.dirName, task: t.task });
  }
  const regs = sessionScan.entries.filter((e) => !e.error).map((e) => e.reg);
  tree.set("INDEX.md", renderIndexMdText(indexRows(Object.keys(readRootIndex()), active, regs)));
  return tree;
}

/** `expected` against `actual`: missing = only in expected, extra = only in actual. */
function compareTrees(expected, actual) {
  const diffs = [];
  for (const [p, text] of expected) {
    if (!actual.has(p)) diffs.push({ path: p, kind: "missing" });
    else if (actual.get(p) !== text) diffs.push({ path: p, kind: "differs" });
  }
  for (const p of actual.keys()) {
    if (!expected.has(p)) diffs.push({ path: p, kind: "extra" });
  }
  diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { equal: diffs.length === 0, diffs };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.export.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** A dated trash bundle created on first use: `<trash>/<date>/<label>-<HHMMSS>/`. */
function makeBundle(label) {
  const { trashRoot } = require("./trash");
  const iso = new Date().toISOString();
  const base = path.join(trashRoot(), iso.slice(0, 10), `${label}-${iso.slice(11, 19).replace(/:/g, "")}`);
  let dir = null;
  return {
    get path() { return dir; },
    keep(relPath, srcFile) {
      if (!dir) {
        dir = base;
        for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
      }
      const dest = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
    },
  };
}

function buildTree(source) {
  if (source === "db") return dbTree();
  const imp = require("./db-import");
  const { tasksRootBase } = require("./tasks-root");
  const { sessionsRoot } = require("./session");
  const tree = filesTree(imp.scanRoot(tasksRootBase()), imp.scanSessions(sessionsRoot()), { stateMd: "source" });
  return tree;
}

function writeTree(outDir, tree) {
  for (const [rel, text] of tree) writeAtomic(path.join(outDir, rel), text);
  return { written: tree.size, out: outDir };
}

/** Render the tree for `source` ("db" or "files") into `outDir`. */
function renderExports(outDir, { source = "db" } = {}) {
  return writeTree(outDir, buildTree(source));
}

/**
 * Render every database task in place under the tasks root. A file whose bytes
 * differ is copied to a trash bundle first; deleted rows are never written.
 */
function exportInPlace() {
  const { tasksRootBase } = require("./tasks-root");
  const { withLock } = require("./lock");
  const root = tasksRootBase();
  const bundle = makeBundle("agents-export");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  let written = 0;
  let unchanged = 0;
  const tree = dbTree();
  const taskDirs = new Map();
  for (const row of db.listTasks()) {
    if (row.disposition !== "deleted") taskDirs.set(taskRel(row.disposition, row.repo_key, row.dir_name), true);
  }
  const put = (rel, text) => {
    const file = path.join(root, rel);
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (current === text) { unchanged++; return; }
    if (current !== null) bundle.keep(rel, file);
    writeAtomic(file, text);
    written++;
  };
  for (const [rel, text] of tree) {
    const dir = path.dirname(rel);
    if (taskDirs.has(dir)) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      withLock(path.join(root, dir), holder, () => put(rel, text));
    } else {
      put(rel, text);
    }
  }
  return { written, unchanged, trashed_to: bundle.path };
}

/** Compare the database exports with the live root; read-only. */
function check() {
  const imp = require("./db-import");
  const { tasksRootBase } = require("./tasks-root");
  const { sessionsRoot } = require("./session");
  const live = filesTree(imp.scanRoot(tasksRootBase()), imp.scanSessions(sessionsRoot()), { stateMd: "live" });
  return compareTrees(dbTree(), live);
}

module.exports = {
  taskRel, indexRows, dbTree, filesTree, compareTrees, buildTree, renderExports,
  exportInPlace, check, makeBundle, writeAtomic,
};
