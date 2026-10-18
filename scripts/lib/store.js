"use strict";

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { validateSessionId } = require("./session");
const taskLib = require("./task");

function now() {
  return new Date().toISOString();
}

function resolveStatePath(taskDir, projectDir) {
  if (path.isAbsolute(taskDir)) return path.resolve(taskDir, "state.json");
  const resolved = path.resolve(projectDir, taskDir, "state.json");
  const safeRoot = path.resolve(projectDir);
  if (!resolved.startsWith(safeRoot + path.sep) && resolved !== safeRoot) {
    throw new Error(`task_dir "${taskDir}" resolves outside project directory`);
  }
  return resolved;
}

function stateTmpPath(taskDir, projectDir, sessionId) {
  validateSessionId(sessionId);
  const dir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
  return path.join(dir, `.state.${sessionId}.tmp`);
}

function readState(taskDir, projectDir) {
  const statePath = resolveStatePath(taskDir, projectDir);
  if (!fs.existsSync(statePath)) {
    const err = new Error(`state.json not found at ${statePath}. Run state_init first.`);
    err.notFound = true;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse state.json at ${statePath}: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid state.json at ${statePath}: expected a plain object`);
  }
  if (!Array.isArray(parsed.phases) || !Array.isArray(parsed.flags)) {
    throw new Error(`Invalid state.json at ${statePath}: missing phases/flags array`);
  }
  return parsed;
}

function writeState(taskDir, state, projectDir, sessionId) {
  const statePath = resolveStatePath(taskDir, projectDir);
  const tmpPath = stateTmpPath(taskDir, projectDir, sessionId);
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, statePath);
}

function tasksIndexPath(projectDir) {
  return path.resolve(projectDir, ".tasks", "tasks.json");
}

function tasksIndexTmpPath(projectDir, sessionId) {
  validateSessionId(sessionId);
  return path.resolve(projectDir, ".tasks", `.tasks.json.${sessionId}.tmp`);
}

function buildTasksIndex(projectDir) {
  const tasksRoot = path.resolve(projectDir, ".tasks");
  if (!fs.existsSync(tasksRoot)) return [];
  const entries = [];
  for (const name of fs.readdirSync(tasksRoot)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(tasksRoot, name);
    // D33: read task.json (migrate-on-touch for unmigrated v1 dirs).
    // Malformed v1 state.json dirs are skipped (migrateTask returns skipped
    // without writing), so they never appear in the index.
    let task = null;
    if (taskLib.isMigrated(dir)) {
      task = taskLib.readTaskJson(dir);
    } else if (fs.existsSync(taskLib.stateJsonPath(dir))) {
      try {
        const r = taskLib.migrateTask(dir, { dryRun: false });
        if (r.migrated || (r.skipped && r.reason === "already-migrated")) {
          task = taskLib.readTaskJson(dir);
        }
      } catch {
        // skip unreadable/malformed
      }
    }
    if (!task) continue;

    const phases = task.phases || [];
    const totalPhases = phases.length;
    const completedPhases = phases.filter((p) => p.status === "done").length;
    const currentPhaseObj = phases.find(
      (p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped"
    );
    const currentPhase = currentPhaseObj
      ? {
          id: currentPhaseObj.id,
          name: currentPhaseObj.name,
          status: currentPhaseObj.status,
          owner: currentPhaseObj.owner,
        }
      : null;
    entries.push({
      slug: task.slug,
      dir: path.relative(projectDir, dir),
      task_dir_abs: dir,
      status: task.status,
      schema: task.schema,
      total_phases: totalPhases,
      completed_phases: completedPhases,
      current_phase: currentPhase,
      flags: (task.flags || []).length,
      updated: task.updated,
    });
  }
  return entries;
}

function readIndex(projectDir) {
  const indexPath = tasksIndexPath(projectDir);
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return null;
  }
}

function rebuildIndex(projectDir, sessionId) {
  const holder = { session_id: sessionId, pid: process.pid };
  return withLock(path.resolve(projectDir, ".tasks"), holder, () => {
    return doRebuildIndex(projectDir, sessionId);
  });
}

function doRebuildIndex(projectDir, sessionId) {
  const entries = buildTasksIndex(projectDir);
  const index = { updated: now(), tasks: entries };
  const tmpPath = tasksIndexTmpPath(projectDir, sessionId);
  const tasksDir = path.resolve(projectDir, ".tasks");
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmpPath, tasksIndexPath(projectDir));
  return index;
}

module.exports = {
  readState,
  writeState,
  readIndex,
  rebuildIndex,
  doRebuildIndex,
  buildTasksIndex,
  tasksIndexPath,
  now,
  resolveStatePath,
};
