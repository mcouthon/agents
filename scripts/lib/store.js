"use strict";

const fs = require("fs");
const path = require("path");
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
    const err = new Error(`state.json not found at ${statePath}. Pass the task dir \`a ls\` shows.`);
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

module.exports = {
  readState,
  writeState,
  now,
  resolveStatePath,
};
