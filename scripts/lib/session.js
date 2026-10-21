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

/**
 * Verify a registry entry is truly live (D38 item 6, D44).
 *
 * A bare pid check is not enough: after a tab is closed without SessionEnd,
 * the pid may be reused by a `claude bg-spare` daemon process. This function
 * verifies:
 *  1. The entry has no `ended_at` and has a pid.
 *  2. The pid is alive (signal 0).
 *  3. The process command line contains "claude" but not "bg-spare".
 *  4. The process start time is not later than the registration's `created_at`
 *     (a reused pid starts after the registration was created).
 *
 * Uses `ps -o lstart=,command= -p <pid>` (macOS).
 *
 * @param {object} entry - A registration object from list()
 * @returns {boolean}
 */
function isLive(entry) {
  if (!entry) return false;
  if (entry.ended_at) return false;
  if (!entry.pid) return false;
  if (!isPidAlive(entry.pid)) return false;
  // Test hook: skip process identity check in tests (test processes run
  // "node", not "claude", so the command line check would reject them).
  if (process.env.AGENTS_TEST_SKIP_IDENTITY === "1") return true;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "ps", ["-o", "lstart=,command=", "-p", String(entry.pid)],
      { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (!out) return false;
    // lstart is "Day Mon DD HH:MM:SS YYYY" (≤ 24 chars); command follows.
    const dateMatch = out.match(/^(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/);
    const cmdLine = dateMatch ? dateMatch[2] : out;
    // Process identity: must be a claude session, not a bg-spare daemon.
    if (cmdLine.includes("bg-spare")) return false;
    if (!cmdLine.includes("claude")) return false;
    // Start-time check: a reused pid starts after the registration's created_at.
    if (dateMatch && entry.created_at) {
      const procStart = new Date(dateMatch[1]).getTime();
      const regCreated = new Date(entry.created_at).getTime();
      if (!isNaN(procStart) && !isNaN(regCreated) && procStart > regCreated) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark lost sessions as ended (D43 self-heal, D45 reap).
 * A session is "lost" if it has no ended_at, is not live per isLive(),
 * and has a pid (so we know it was once running). Sets ended_at = now.
 * @returns {{ pruned: number, details: object[] }}
 */
function pruneLostSessions() {
  const sessions = list();
  let pruned = 0;
  const details = [];
  for (const s of sessions) {
    if (s.ended_at) continue;
    if (isLive(s)) continue;
    if (!s.pid) continue; // never pruned a session with no pid (could be a fixture)
    const dir = resolveSessionDir(s.session_id);
    s.ended_at = new Date().toISOString();
    s.updated_at = s.ended_at;
    writeRegistration(dir, s);
    pruned++;
    details.push({ session_id: s.session_id, pid: s.pid, ended_at: s.ended_at });
  }
  return { pruned, details };
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

// Resolve a session's directory by id. When AGENTS_SESSION_DIR is set it names
// the launcher's (PAV/a cc) registration dir; that dir belongs to the session
// it currently records, so it is returned only when its session_id matches.
// A nested process whose own id differs falls through to its own dir under
// the registry root (D28): unregister/touch then act on the caller's own id,
// never the parent's.
function resolveSessionDir(sessionId) {
  if (process.env.AGENTS_SESSION_DIR) {
    const reg = readRegistration(process.env.AGENTS_SESSION_DIR);
    if (reg && reg.session_id === sessionId) {
      return process.env.AGENTS_SESSION_DIR;
    }
  }
  return path.join(sessionsRoot(), sessionId);
}

function mintId() {
  return crypto.randomUUID();
}

function register(params) {
  validateSessionId(params.session_id);

  // D28: nested-session detection is pointer-based. Claude Code sets
  // CLAUDE_CODE_CHILD_SESSION=1 on every subprocess it spawns (hooks included),
  // so that env var cannot distinguish a nested `claude` from a top-level
  // session. The AGENTS_SESSION_DIR pointer can: a registration there whose pid
  // is live and foreign (not this process's pid) belongs to a running parent
  // session, so a different process running now is nested — it registers under
  // its own id with origin "external" and a parent_session_id link, leaving the
  // parent's registration and lease untouched. Otherwise the caller binds the
  // pointer: the same session, or a recorded pid that is null, dead, or this
  // process's (the /clear and crash-restart cases). Without a pointer every
  // session registers, nested or not.
  const pointerDir = process.env.AGENTS_SESSION_DIR || null;
  const pointer = pointerDir ? readRegistration(pointerDir) : null;
  let dir;
  let nested = false;
  let parentSessionId = null;
  if (pointer && pointer.session_id !== params.session_id) {
    const pointerPidAlive = pointer.pid && isPidAlive(pointer.pid);
    const pointerPidIsOurs = pointer.pid != null && pointer.pid === params.pid;
    if (pointerPidAlive && !pointerPidIsOurs) {
      nested = true;
      parentSessionId = pointer.session_id;
      dir = path.join(sessionsRoot(), params.session_id);
    } else {
      dir = pointerDir;
    }
  } else if (pointerDir) {
    dir = pointerDir;
  } else if (params.session_dir) {
    dir = params.session_dir;
  } else if (params.terminal_id) {
    // D7: the registry entry id is the terminal id when a launcher minted one,
    // else the session id. Launchers (a cc, PAV) call register without
    // AGENTS_SESSION_DIR in their own env; without this derivation the entry
    // would land at <root>/<session_id> while the pane's AGENTS_SESSION_DIR
    // points at <root>/<terminal_id>, so the hook finds an empty pointer and
    // creates a second, external entry — the launcher's own entry never
    // receives pid or transcript.
    dir = path.join(sessionsRoot(), params.terminal_id);
  } else {
    dir = path.join(sessionsRoot(), params.session_id);
  }

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
    if (params.agent) reg.agent = params.agent.toLowerCase();
    if (params.repo_key) reg.repo_key = params.repo_key;
    if (params.cwd) reg.cwd = params.cwd;
    if (params.task_dir !== undefined) reg.task_dir = params.task_dir || null;
    if (params.origin) reg.origin = params.origin;
    if (nested) reg.parent_session_id = parentSessionId;
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
      origin: nested ? "external" : (params.origin || "external"),
      terminal_id: params.terminal_id || null,
      session_id: params.session_id,
      workflow_id: params.workflow_id ?? null,
      task_dir: params.task_dir || null,
      commitment_id: params.commitment_id || null,
      project_id: params.project_id || null,
      initiator: params.initiator || null,
      agent: params.agent ? params.agent.toLowerCase() : null,
      repo_key: params.repo_key || null,
      cwd: params.cwd || null,
      pid: params.pid || null,
      transcript_path: params.transcript_path || null,
      tmux: params.tmux || null,
      created_at: now,
      updated_at: now,
    };
    if (nested) reg.parent_session_id = parentSessionId;
    if ((params.source === "clear" || params.source === "fork") && params.previous_session_id) {
      reg.session_history = [params.previous_session_id];
    }
  }

  writeRegistration(dir, reg);

  // Nested sessions never touch the pointer's lease; the parent holds the task.
  let leaseResult = null;
  if (!nested && params.task_dir && params.project_dir) {
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
  const taskLib = require("./task");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const ttl = lease_ttl_ms || DEFAULT_LEASE_TTL_MS;
  const holder = { session_id, pid: pid || process.pid };

  if (!fs.existsSync(taskDirAbs)) {
    return { claimed: false, reason: "no_task_dir" };
  }
  if (!fs.existsSync(taskLib.taskJsonPath(taskDirAbs))) {
    return { claimed: false, reason: "no_state" };
  }

  try {
    return withLock(taskDirAbs, holder, () => {
      let task;
      try {
        task = taskLib.loadTask(taskDirAbs);
      } catch {
        return { claimed: false, reason: "no_state" };
      }

      if (task.lease && task.lease.session_id && task.lease.session_id !== session_id) {
        const holderSession = find({ session_id: task.lease.session_id });
        if (holderSession && holderSession.pid && isPidAlive(holderSession.pid)) {
          return {
            claimed: false,
            reason: "held",
            holder: {
              session_id: task.lease.session_id,
              agent: holderSession.agent || null,
              acquired_at: task.lease.acquired_at || null,
            },
          };
        }
      }

      const now = new Date();
      task.lease = {
        session_id,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttl).toISOString(),
      };
      task.binding = { session_id, pid: pid || process.pid };
      task.updated = now.toISOString();
      taskLib.writeTaskJson(taskDirAbs, task);
      try { require("./render").renderStateMd(taskDirAbs, task, project_dir); } catch {}
      return { claimed: true, lease: task.lease };
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
  const taskLib = require("./task");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const ttl = lease_ttl_ms || DEFAULT_LEASE_TTL_MS;
  const holder = { session_id, pid: process.pid };

  if (!fs.existsSync(taskLib.taskJsonPath(taskDirAbs))) return false;

  try {
    return withLock(taskDirAbs, holder, () => {
      let task;
      try {
        task = taskLib.loadTask(taskDirAbs);
      } catch {
        return false;
      }

      if (task.lease && task.lease.session_id === session_id) {
        task.lease.expires_at = new Date(Date.now() + ttl).toISOString();
        task.binding = { session_id, pid: process.pid };
        task.updated = new Date().toISOString();
        taskLib.writeTaskJson(taskDirAbs, task);
        try { require("./render").renderStateMd(taskDirAbs, task, project_dir); } catch {}
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
  const taskLib = require("./task");
  const taskDirAbs = path.isAbsolute(task_dir) ? task_dir : path.resolve(project_dir, task_dir);
  const holder = { session_id, pid: process.pid };

  if (!fs.existsSync(taskLib.taskJsonPath(taskDirAbs))) return false;

  try {
    return withLock(taskDirAbs, holder, () => {
      let task;
      try {
        task = taskLib.loadTask(taskDirAbs);
      } catch {
        return false;
      }

      if (task.lease && task.lease.session_id === session_id) {
        task.lease = null;
        if (task.binding && task.binding.session_id === session_id) {
          task.binding = null;
        }
        task.updated = new Date().toISOString();
        taskLib.writeTaskJson(taskDirAbs, task);
        try { require("./render").renderStateMd(taskDirAbs, task, project_dir); } catch {}
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

function find({ pid, session_id, terminal_id, repo_key } = {}) {
  if (process.env.AGENTS_SESSION_DIR) {
    const reg = readRegistration(process.env.AGENTS_SESSION_DIR);
    if (reg) {
      if (session_id && reg.session_id === session_id) return reg;
      if (terminal_id && reg.terminal_id === terminal_id) return reg;
      if (pid !== undefined && reg.pid === pid) return reg;
    }
  }
  const sessions = list();
  if (repo_key) {
    const matching = sessions.filter((s) => s.repo_key === repo_key);
    if (session_id) return matching.find((s) => s.session_id === session_id) || null;
    if (terminal_id) return matching.find((s) => s.terminal_id === terminal_id) || null;
    if (pid !== undefined) return matching.find((s) => s.pid === pid) || null;
    return matching.length > 0 ? matching[0] : null;
  }
  if (session_id) return sessions.find((s) => s.session_id === session_id) || null;
  if (terminal_id) return sessions.find((s) => s.terminal_id === terminal_id) || null;
  if (pid !== undefined) return sessions.find((s) => s.pid === pid) || null;
  return null;
}

/**
 * Find all live sessions for a repo_key, optionally excluding one session.
 * Used by the migrate live-session refusal check (D35).
 * Returns array of session registration objects.
 */
function findLiveByRepoKey(repoKey, excludeSessionId) {
  const sessions = list();
  return sessions.filter((s) => {
    if (s.repo_key !== repoKey) return false;
    if (excludeSessionId && s.session_id === excludeSessionId) return false;
    return isLive(s);
  });
}

function postToPav(registration, port) {
  if (!port) return;
  const { execFileSync } = require("child_process");
  const data = JSON.stringify(registration);
  const id = registration.terminal_id || registration.session_id;
  const url = `http://localhost:${port}/api/coding/terminals/${id}/bind`;
  try {
    execFileSync("curl", ["-s", "-X", "POST", "-H", "Content-Type: application/json",
      "-d", data, "--connect-timeout", "1", "--max-time", "2", url],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
  } catch {}
}

module.exports = {
  register,
  unregister,
  touch,
  list,
  find,
  findLiveByRepoKey,
  claimLease,
  renewLease,
  releaseLease,
  isPidAlive,
  isLive,
  pruneLostSessions,
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
