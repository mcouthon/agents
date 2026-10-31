"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { withNamedLock } = require("./lock");

// Central tasks root. Always ~/.agents/tasks (D35 clean break — no knob,
// no symlink, no repo|central switch). AGENTS_TASKS_ROOT redirects the root
// for fixture tests so no test writes into the real ~/.agents/tasks.
function tasksRootBase() {
  return process.env.AGENTS_TASKS_ROOT || path.join(os.homedir(), ".agents", "tasks");
}

function tasksRoot(repoKeyObj) {
  return path.join(tasksRootBase(), repoKeyObj.key);
}

function rootLockPath() {
  return path.join(tasksRootBase(), ".root.lock");
}

function archiveRoot() {
  return path.join(tasksRootBase(), "archive");
}

function withRootLock(holder, fn) {
  return withNamedLock(rootLockPath(), holder, fn);
}

// The database stores a task's repo key as the relative path under the tasks root, so a
// path-shaped key (a local origin) loses its leading slash there.
const storedKey = (k) => String(k).replace(/\/{2,}/g, "/").replace(/^\//, "");

/**
 * The main checkout of the repo a task dir belongs to, from the `repos` table
 * (the one repos store); null when unknown or the folder is gone.
 */
function mainRootOf(taskDir) {
  const db = require("./db");
  const loc = db.locate(taskDir);
  if (!loc) return null;
  const row = db.repoOf(loc.repoKey);
  const mainRoot = row ? row.main_root : null;
  return mainRoot && fs.existsSync(mainRoot) ? mainRoot : null;
}

module.exports = {
  tasksRootBase,
  tasksRoot,
  rootLockPath,
  archiveRoot,
  withRootLock,
  mainRootOf,
  storedKey,
};
