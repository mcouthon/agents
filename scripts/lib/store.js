"use strict";

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { validateSessionId } = require("./session");

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
    const stateFile = path.join(dir, "state.json");
    if (!fs.existsSync(stateFile)) continue;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      continue;
    }
    if (
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !Array.isArray(state.phases) ||
      !Array.isArray(state.flags)
    ) {
      continue;
    }
    const totalPhases = state.phases.length;
    const completedPhases = state.phases.filter((p) => p.status === "done").length;
    const currentPhaseObj = state.phases.find((p) => p.status !== "done");
    const currentPhase = currentPhaseObj
      ? {
          id: currentPhaseObj.id,
          name: currentPhaseObj.name,
          status: currentPhaseObj.status,
          owner: currentPhaseObj.owner,
        }
      : null;
    entries.push({
      slug: state.task,
      dir: path.relative(projectDir, dir),
      status: state.status,
      total_phases: totalPhases,
      completed_phases: completedPhases,
      current_phase: currentPhase,
      flags: state.flags.length,
      updated: state.updated,
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
