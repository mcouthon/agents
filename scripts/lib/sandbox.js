"use strict";

// The sandbox guard: the process counts as sandboxed when any of
// AGENTS_TASKS_ROOT, AGENTS_SESSIONS_ROOT or AGENTS_DB is set. Every write that follows a path
// stored in a row (render, fold, move, fetch, push) stays inside the sandbox
// root, so a row that points outside a test's root can never move a real file.

const fs = require("fs");
const path = require("path");

/** True when this run is a sandbox (any root override is set). */
function isSandbox() {
  return Boolean(process.env.AGENTS_TASKS_ROOT || process.env.AGENTS_SESSIONS_ROOT || process.env.AGENTS_DB);
}

/**
 * The sandbox root: the real path of the tasks root's parent. Null when the
 * tasks root is unset (a sandbox that names no root contains nothing).
 */
function root() {
  if (!process.env.AGENTS_TASKS_ROOT) return null;
  try {
    return fs.realpathSync(path.dirname(process.env.AGENTS_TASKS_ROOT));
  } catch {
    return null;
  }
}

/**
 * The real path of `p`: the realpath of its nearest existing ancestor joined
 * with the remaining segments, so `/tmp` and `/private/tmp` compare equal and
 * a not-yet-created path still lands where it will exist.
 */
function realPathOf(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail); } catch { /* walk up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/** True when `p` may be written: always outside a sandbox, inside it only under the root. */
function contains(p) {
  if (!isSandbox()) return true;
  const r = root();
  if (r === null) return false;
  const rp = realPathOf(p);
  return rp === r || rp.startsWith(r + path.sep);
}

module.exports = { isSandbox, root, contains, realPathOf };
