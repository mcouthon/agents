"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("./config");
const coe = require("./checkout-env");
const { fail, zmxSessions, liveSession, realpath } = require("./start");
const session = require("./session");
const adapter = require("./adapter").forHarness();

function launch({ agent, sessionId, cwd, worktree, here, args }) {
  const config = loadConfig();
  const command = (config.launch && config.launch.command) || adapter.defaultCommand();
  const envFile = config.launch && config.launch.env_file;

  const runCwd = cwd || process.cwd();

  // Occupancy check: refuse when a live registered session's cwd realpath
  // equals the target the new session will run in (the --cwd, or the harness
  // worktree path when --worktree is passed). --here skips it. Spawn-class:
  // a zmx timeout refuses with zmx_timeout, never degrades.
  if (!here) {
    const target = worktree
      ? path.join(realpath(runCwd), adapter.harnessWorktrees(), worktree)
      : realpath(runCwd);
    const zmx = zmxSessions();
    const occupants = session.list()
      .map((reg) => ({ reg, ...liveSession(reg, zmx) }))
      .filter((d) => d.live && d.reg.cwd && realpath(d.reg.cwd) === target && d.reg.session_id !== adapter.ownSessionId());
    if (occupants.length > 0) {
      const o = occupants[0].reg;
      const id8 = o.session_id.slice(0, 8);
      throw fail(2,
        `Checkout ${target} has a live ${o.agent || "agent"} session ${id8} (pid ${o.pid}); pass --here to share it, or --worktree <name> to run in a harness worktree`,
        "checkout_busy",
        { target, occupant: { session_id: o.session_id, agent: o.agent, task_dir: o.task_dir || null } });
    }
  }

  const E1 = coe.sessionEnv({ cwd: runCwd, launcherEnv: process.env, envFile });

  const cmdArgs = [];
  if (sessionId) cmdArgs.push("--session-id", sessionId);
  if (agent) cmdArgs.push("--agent", agent);
  if (worktree) cmdArgs.push("--worktree", worktree);
  if (args && args.length > 0) cmdArgs.push(...args);

  const child = spawn(command, cmdArgs, {
    env: E1,
    cwd: runCwd,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    process.stderr.write(`launch error: ${err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

module.exports = { launch };
