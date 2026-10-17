"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSIONS_ROOT = path.join(os.homedir(), ".agents", "sessions");

function validateSessionId(sid) {
  if (!sid || typeof sid !== "string") {
    throw new Error("Invalid session id: must be a non-empty string");
  }
  if (/[/\\\0]/.test(sid) || sid.includes("..")) {
    throw new Error("Invalid session id: must not contain path separators or traversal sequences");
  }
}

function register({ session_id, pid, terminal_id, cwd, agent, repo_key, task_dir, initiator }) {
  validateSessionId(session_id);
  const dir = path.join(SESSIONS_ROOT, session_id);
  fs.mkdirSync(dir, { recursive: true });
  const registration = {
    session_id,
    pid: pid || null,
    terminal_id: terminal_id || null,
    cwd: cwd || null,
    agent: agent || null,
    repo_key: repo_key || null,
    task_dir: task_dir || null,
    initiator: initiator || null,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(dir, "registration.json"),
    JSON.stringify(registration, null, 2) + "\n",
    "utf8"
  );
  return registration;
}

function unregister(session_id) {
  const dir = path.join(SESSIONS_ROOT, session_id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function list() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const sessions = [];
  for (const name of fs.readdirSync(SESSIONS_ROOT)) {
    if (name.startsWith(".")) continue;
    const regFile = path.join(SESSIONS_ROOT, name, "registration.json");
    if (!fs.existsSync(regFile)) continue;
    try {
      sessions.push(JSON.parse(fs.readFileSync(regFile, "utf8")));
    } catch {}
  }
  return sessions;
}

function find({ pid, session_id, terminal_id } = {}) {
  const sessions = list();
  if (session_id) return sessions.find((s) => s.session_id === session_id) || null;
  if (terminal_id) return sessions.find((s) => s.terminal_id === terminal_id) || null;
  if (pid !== undefined) return sessions.find((s) => s.pid === pid) || null;
  return null;
}

module.exports = { register, unregister, list, find, SESSIONS_ROOT, validateSessionId };
