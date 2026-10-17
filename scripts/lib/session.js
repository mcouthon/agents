"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Registry root. Overridable via AGENTS_SESSIONS_ROOT so tests can isolate
// against a tmpdir and never write to the real ~/.agents/sessions.
function sessionsRoot() {
  return process.env.AGENTS_SESSIONS_ROOT || path.join(os.homedir(), ".agents", "sessions");
}

function validateSessionId(sid) {
  if (!sid || typeof sid !== "string") {
    throw new Error("Invalid session id: must be a non-empty string");
  }
  if (/[/\\\0]/.test(sid) || sid.includes("..")) {
    throw new Error("Invalid session id: must not contain path separators or traversal sequences");
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registrationPath(sessionDir) {
  return path.join(sessionDir, "registration.json");
}

function readRegistration(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(registrationPath(sessionDir), "utf8"));
  } catch {
    return null;
  }
}

function writeRegistration(sessionDir, reg) {
  fs.mkdirSync(sessionDir, { recursive: true });
  reg.updated_at = new Date().toISOString();
  fs.writeFileSync(registrationPath(sessionDir), JSON.stringify(reg, null, 2) + "\n", "utf8");
}

function resolveSessionDir(sessionId) {
  if (process.env.AGENTS_SESSION_DIR) return process.env.AGENTS_SESSION_DIR;
  return path.join(sessionsRoot(), sessionId);
}

function mintId() {
  return crypto.randomUUID();
}

function register(params) {
  validateSessionId(params.session_id);
  const dir = resolveSessionDir(params.session_id);
  const existing = readRegistration(dir);
  const now = new Date().toISOString();

  let reg;
  if (existing) {
    reg = existing;
    if (params.source === "clear" || params.source === "fork") {
      if (!reg.session_history) reg.session_history = [];
      if (reg.session_id && reg.session_id !== params.session_id) {
        reg.session_history.push(reg.session_id);
      }
    }
    reg.session_id = params.session_id;
    if (params.pid !== undefined) reg.pid = params.pid;
    if (params.transcript_path !== undefined) reg.transcript_path = params.transcript_path;
    if (params.agent) reg.agent = params.agent;
    if (params.repo_key) reg.repo_key = params.repo_key;
    if (params.cwd) reg.cwd = params.cwd;
    if (params.task_dir !== undefined) reg.task_dir = params.task_dir || null;
    if (params.origin) reg.origin = params.origin;
    if (params.terminal_id !== undefined) reg.terminal_id = params.terminal_id || null;
    if (params.workflow_id !== undefined) reg.workflow_id = params.workflow_id ?? null;
    if (params.commitment_id !== undefined) reg.commitment_id = params.commitment_id || null;
    if (params.project_id !== undefined) reg.project_id = params.project_id || null;
    if (params.initiator !== undefined) reg.initiator = params.initiator || null;
    if (params.tmux !== undefined) reg.tmux = params.tmux;
    reg.updated_at = now;
  } else {
    reg = {
      schema: 1,
      origin: params.origin || "external",
      terminal_id: params.terminal_id || null,
      session_id: params.session_id,
      workflow_id: params.workflow_id ?? null,
      task_dir: params.task_dir || null,
      commitment_id: params.commitment_id || null,
      project_id: params.project_id || null,
      initiator: params.initiator || null,
      agent: params.agent || null,
      repo_key: params.repo_key || null,
      cwd: params.cwd || null,
      pid: params.pid || null,
      transcript_path: params.transcript_path || null,
      tmux: params.tmux || null,
      created_at: now,
      updated_at: now,
    };
    if ((params.source === "clear" || params.source === "fork") && params.previous_session_id) {
      reg.session_history = [params.previous_session_id];
    }
  }

  writeRegistration(dir, reg);

  let leaseResult = null;
  if (params.task_dir && params.project_dir) {
    leaseResult = claimLease({
      task_dir: params.task_dir,
      project_dir: params.project_dir,
      session_id: params.session_id,
      pid: params.pid,
      lease_ttl_ms: params.lease_ttl_ms,
    });
  }

  return { registration: reg, lease: leaseResult, session_dir: dir };
}

function unregister(session_id) {
  const dir = resolveSessionDir(session_id);
  const reg = readRegistration(dir);
  if (!reg) return false;

  reg.ended_at = new Date().toISOString();
  reg.updated_at = reg.ended_at;
  writeRegistration(dir, reg);

  if (reg.task_dir) {
    releaseLease({ task_dir: reg.task_dir, project_dir: deriveProjectDir(reg), session_id });
  }
  return true;
}

function touch(session_id) {
  const dir = resolveSessionDir(session_id);
  const reg = readRegistration(dir);
  if (!reg) return false;

  reg.updated_at = new Date().toISOString();
  writeRegistration(dir, reg);

  if (reg.task_dir) {
    renewLease({ task_dir: reg.task_dir, project_dir: deriveProjectDir(reg), session_id });
  }
  return true;
}

function deriveProjectDir(reg) {
  if (reg.cwd) {
    try {
      return require("./repo").repoKey(reg.cwd).main_root;
    } catch {}
  }
  return process.cwd();
}

function claimLease({ task_dir, project_dir, session_id, pid, lease_ttl_ms }) {
  const { withLock } = require("./lock");
  const store = require("./store");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const ttl = lease_ttl_ms || DEFAULT_LEASE_TTL_MS;
  const holder = { session_id, pid: pid || process.pid };

  if (!fs.existsSync(taskDirAbs)) {
    return { claimed: false, reason: "no_task_dir" };
  }
  const statePath = path.join(taskDirAbs, "state.json");
  if (!fs.existsSync(statePath)) {
    return { claimed: false, reason: "no_state" };
  }

  try {
    return withLock(taskDirAbs, holder, () => {
      let state;
      try {
        state = store.readState(task_dir, project_dir);
      } catch {
        return { claimed: false, reason: "no_state" };
      }

      if (state.lease && state.lease.session_id && state.lease.session_id !== session_id) {
        const holderSession = find({ session_id: state.lease.session_id });
        if (holderSession && holderSession.pid && isPidAlive(holderSession.pid)) {
          return {
            claimed: false,
            reason: "held",
            holder: {
              session_id: state.lease.session_id,
              agent: holderSession.agent || null,
              acquired_at: state.lease.acquired_at || null,
            },
          };
        }
      }

      const now = new Date();
      state.lease = {
        session_id,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttl).toISOString(),
      };
      state.binding = { session_id, pid: pid || process.pid };
      state.updated = store.now();
      store.writeState(task_dir, state, project_dir, session_id);
      return { claimed: true, lease: state.lease };
    });
  } catch (err) {
    if (err.name === "LockHeldError") {
      return { claimed: false, reason: "lock_held", holder: err.holder };
    }
    throw err;
  }
}

function renewLease({ task_dir, project_dir, session_id, lease_ttl_ms }) {
  const { withLock } = require("./lock");
  const store = require("./store");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const ttl = lease_ttl_ms || DEFAULT_LEASE_TTL_MS;
  const holder = { session_id, pid: process.pid };

  if (!fs.existsSync(path.join(taskDirAbs, "state.json"))) return false;

  try {
    return withLock(taskDirAbs, holder, () => {
      let state;
      try {
        state = store.readState(task_dir, project_dir);
      } catch {
        return false;
      }

      if (state.lease && state.lease.session_id === session_id) {
        state.lease.expires_at = new Date(Date.now() + ttl).toISOString();
        state.binding = { session_id, pid: process.pid };
        state.updated = store.now();
        store.writeState(task_dir, state, project_dir, session_id);
        return true;
      }
      return false;
    });
  } catch (err) {
    if (err.name === "LockHeldError") return false;
    throw err;
  }
}

function releaseLease({ task_dir, project_dir, session_id }) {
  const { withLock } = require("./lock");
  const store = require("./store");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const holder = { session_id, pid: process.pid };

  if (!fs.existsSync(path.join(taskDirAbs, "state.json"))) return false;

  try {
    return withLock(taskDirAbs, holder, () => {
      let state;
      try {
        state = store.readState(task_dir, project_dir);
      } catch {
        return false;
      }

      if (state.lease && state.lease.session_id === session_id) {
        state.lease = null;
        if (state.binding && state.binding.session_id === session_id) {
          state.binding = null;
        }
        state.updated = store.now();
        store.writeState(task_dir, state, project_dir, session_id);
        return true;
      }
      return false;
    });
  } catch (err) {
    if (err.name === "LockHeldError") return false;
    throw err;
  }
}

function list() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const regFile = path.join(root, name, "registration.json");
    if (!fs.existsSync(regFile)) continue;
    try {
      sessions.push(JSON.parse(fs.readFileSync(regFile, "utf8")));
    } catch {}
  }
  return sessions;
}

function find({ pid, session_id, terminal_id } = {}) {
  if (process.env.AGENTS_SESSION_DIR) {
    const reg = readRegistration(process.env.AGENTS_SESSION_DIR);
    if (reg) {
      if (session_id && reg.session_id === session_id) return reg;
      if (terminal_id && reg.terminal_id === terminal_id) return reg;
      if (pid !== undefined && reg.pid === pid) return reg;
    }
  }
  const sessions = list();
  if (session_id) return sessions.find((s) => s.session_id === session_id) || null;
  if (terminal_id) return sessions.find((s) => s.terminal_id === terminal_id) || null;
  if (pid !== undefined) return sessions.find((s) => s.pid === pid) || null;
  return null;
}

function postToPav(registration, port) {
  if (!port) return;
  const http = require("http");
  const data = JSON.stringify(registration);
  const id = registration.terminal_id || registration.session_id;
  const req = http.request({
    hostname: "localhost",
    port: port,
    path: `/api/coding/terminals/${id}/bind`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    timeout: 300,
  }, (res) => { res.resume(); });
  req.on("error", () => {});
  req.on("timeout", () => { req.destroy(); });
  req.write(data);
  req.end();
}

module.exports = {
  register,
  unregister,
  touch,
  list,
  find,
  claimLease,
  renewLease,
  releaseLease,
  isPidAlive,
  mintId,
  postToPav,
  readRegistration,
  writeRegistration,
  resolveSessionDir,
  sessionsRoot,
  validateSessionId,
  DEFAULT_LEASE_TTL_MS,
};

// Back-compat: callers that read session.SESSIONS_ROOT keep working and see
// the env-overridable root. Prefer sessionsRoot() in new code.
Object.defineProperty(module.exports, "SESSIONS_ROOT", {
  get: sessionsRoot,
  enumerable: true,
  configurable: true,
});
