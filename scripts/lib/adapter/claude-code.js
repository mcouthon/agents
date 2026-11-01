"use strict";

/**
 * The Claude Code adapter: the five functions and the boundary exports the
 * core needs instead of naming the harness. This is the only place outside
 * tests, templates and the installer that names the harness.
 */

const DEFAULT_COMMAND = "claude";
const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const PARENT_PID_ENV = "CLAUDE_PID";
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

/** The harness's own session id, or null. */
function ownSessionId() {
  return process.env[SESSION_ID_ENV] || null;
}

/** The harness env names the engine drops from spawned sessions. */
function droppedEnvNames() {
  const names = [SESSION_ID_ENV, PARENT_PID_ENV];
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) names.push(name);
  }
  return names;
}

/** Whether a command line looks like a live harness agent process. */
function agentProcessLooksLive(cmdLine) {
  if (!cmdLine || cmdLine.includes("bg-spare")) return false;
  return cmdLine.includes("claude");
}

/** The project directory env var, or null. */
function projectDirEnv() {
  return process.env[PROJECT_DIR_ENV] || null;
}

/** The harness's worktree directory marker. */
function harnessWorktrees() {
  return ".claude/worktrees/";
}

/** The harness's installed agents directory. */
function agentsDir() {
  return require("path").join(require("os").homedir(), ".claude", "agents");
}

/** The harness's installed hooks directory. */
function hooksDir() {
  return require("path").join(require("os").homedir(), ".claude", "hooks");
}

/** The hook handlers' names. */
const hookHandlers = ["session-register", "session-end"];

function hooksDisabled() {
  return require("./claude-code/common").hooksDisabled();
}
function hooksDisabledPath() {
  return require("./claude-code/common").hooksDisabledPath();
}
function hookLogPath() {
  return require("./claude-code/common").hookLogPath();
}
function hookHandler(name) {
  return require("./claude-code/" + name);
}
function installerModule() {
  return require("./claude-code/install");
}

/** The default launch command. */
function defaultCommand() {
  return DEFAULT_COMMAND;
}

/** The harness's short name (used in the generated/ directory path). */
function harnessName() {
  return "claude";
}

// The five functions (the argv build lands in commit 7; the launch and resume
// signatures are stable from this commit so the core calls them, not the
// harness command directly).

function launch({ agent, sessionId, passthrough }) {
  return [DEFAULT_COMMAND, "--session-id", sessionId, "--agent", agent, ...passthrough];
}

function resume(nativeId, { agent, passthrough }) {
  return [DEFAULT_COMMAND, "--resume", nativeId, "--agent", agent, ...passthrough];
}

/** How the session id reaches the registry (the SessionStart handler). */
function register(payload) {
  return require("./claude-code/session-register").run(payload);
}

/** The SessionEnd handler. */
function end(payload) {
  return require("./claude-code/session-end").run(payload);
}

/** The transcript path from a registration or {sessionId, cwd}. */
function transcript(regOrOpts) {
  if (regOrOpts && regOrOpts.transcript_path) return regOrOpts.transcript_path;
  return null;
}

module.exports = {
  ownSessionId, droppedEnvNames, agentProcessLooksLive,
  projectDirEnv, harnessWorktrees, hookHandlers, defaultCommand,
  agentsDir, hooksDir, harnessName,
  hooksDisabled, hooksDisabledPath, hookLogPath, hookHandler, installerModule,
  launch, resume, register, end, transcript,
};
