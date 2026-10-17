"use strict";

/**
 * Aggregated tasks index: read, build, and list tasks from .tasks/tasks.json.
 * The index is a derived artifact rebuilt from individual state.json / task.json
 * files; this module provides the read/list surface for the tasks_list MCP tool.
 */

const fs = require("fs");
const path = require("path");
const store = require("./store");

function tasksIndexPath(projectDir) {
  return path.resolve(projectDir, ".tasks", "tasks.json");
}

function readTasksIndex(projectDir) {
  const indexPath = tasksIndexPath(projectDir);
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return null;
  }
}

function buildTasksIndex(projectDir) {
  return store.buildTasksIndex(projectDir);
}

function now() {
  return new Date().toISOString();
}

/**
 * Return the aggregated tasks index for a project directory.
 * If the persisted index is missing or malformed, it is computed on the fly.
 * Each entry gets an absolute task_dir_abs derived from the project root so
 * stale persisted indexes (written before that field existed) don't omit it.
 *
 * @param {string} projectDir - Resolved project root
 * @param {string|null} warning - Optional advisory warning to attach as a JSON field
 * @returns {object} The index object { updated, tasks: [...] }
 */
function listTasks(projectDir, warning) {
  let index = readTasksIndex(projectDir);
  if (!index) {
    index = { updated: now(), tasks: buildTasksIndex(projectDir) };
  }
  if (Array.isArray(index.tasks)) {
    for (const entry of index.tasks) {
      entry.task_dir_abs = path.resolve(projectDir, entry.dir);
    }
  }
  if (warning) index.warning = warning;
  return index;
}

module.exports = {
  tasksIndexPath,
  readTasksIndex,
  buildTasksIndex,
  listTasks,
};
