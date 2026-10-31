"use strict";

/**
 * task.md's rendered blocks, exported from the database. `exportTask` is the
 * render every intent write ends with: the phases block into `<task_dir>/task.md`,
 * guarded by the sandbox root and skipped while the task's Markdown still sits
 * in a repo-local folder (a pending fold). `check` lists the files whose block
 * differs from the tables; `a export --check` exits 1 on any.
 */

const fs = require("fs");
const path = require("path");
const db = require("./db");

function skipLine(reason) {
  process.stderr.write(`export: ${reason}\n`);
}

/** Render a task's task.md from the tables; returns why it skipped when it did. */
function exportTask(taskId) {
  const taskLib = require("./task");
  const sandbox = require("./sandbox");
  const row = db.getTask(taskId);
  if (!row) return { skipped: true, reason: `no row ${taskId}` };
  if (row.disposition === "deleted") return { skipped: true, reason: `deleted row ${taskId}` };
  const fold = db.pendingFoldOf(taskId);
  if (fold) {
    skipLine(`pending fold for ${row.task_dir} (${fold}); not rendered`);
    return { skipped: true, reason: "pending fold" };
  }
  if (!sandbox.contains(row.task_dir)) {
    skipLine(`outside sandbox: ${row.task_dir}`);
    return { skipped: true, reason: "outside sandbox" };
  }
  const view = taskLib.viewOf(row);
  require("./render").renderTaskMdPhases(row.task_dir, view);
  return { skipped: false };
}

/** Re-render every non-deleted task's task.md; counts what rendered and what skipped. */
function exportInPlace() {
  let rendered = 0;
  const skipped = [];
  for (const row of db.listTasks()) {
    const out = exportTask(row.id);
    if (out.skipped) skipped.push({ task_dir: row.task_dir, reason: out.reason });
    else rendered++;
  }
  return { rendered, skipped };
}

/**
 * Compare every task's rendered block with the file: a file whose block differs
 * from the tables (or is missing) is listed; a task with a pending fold or a
 * task_dir outside the sandbox is not checked.
 */
function check() {
  const taskLib = require("./task");
  const sandbox = require("./sandbox");
  const render = require("./render");
  const diffs = [];
  let checked = 0;
  for (const row of db.listTasks()) {
    if (row.disposition === "deleted") continue;
    if (db.pendingFoldOf(row.id)) continue;
    if (!sandbox.contains(row.task_dir)) continue;
    const file = taskLib.taskMdPath(row.task_dir);
    if (!fs.existsSync(file)) { diffs.push({ path: file, kind: "missing" }); continue; }
    const text = fs.readFileSync(file, "utf8");
    const view = taskLib.viewOf(row);
    const next = render.withPhasesBlock(text, view);
    checked++;
    if (next === null || next !== text) diffs.push({ path: file, kind: "differs" });
  }
  return { equal: diffs.length === 0, diffs, checked };
}

module.exports = { exportTask, exportInPlace, check };
