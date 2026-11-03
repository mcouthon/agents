"use strict";

const { spawn } = require("child_process");
const { loadConfig } = require("./config");
const coe = require("./checkout-env");

function launch({ agent, sessionId, cwd, worktree, args }) {
  const config = loadConfig();
  const command = (config.launch && config.launch.command) || require("./adapter").forHarness().defaultCommand();
  const envFile = config.launch && config.launch.env_file;

  const cmdArgs = [];
  if (sessionId) cmdArgs.push("--session-id", sessionId);
  if (agent) cmdArgs.push("--agent", agent);
  if (worktree) cmdArgs.push("--worktree", worktree);
  if (args && args.length > 0) cmdArgs.push(...args);

  const runCwd = cwd || process.cwd();
  const E1 = coe.sessionEnv({ cwd: runCwd, launcherEnv: process.env, envFile });

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
