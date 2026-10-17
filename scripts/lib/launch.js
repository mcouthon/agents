"use strict";

const { spawn } = require("child_process");
const { loadConfig } = require("./config");

function launch({ agent, sessionId, cwd, worktree, args }) {
  const config = loadConfig();
  const command = (config.launch && config.launch.command) || "claude";
  const envFile = config.launch && config.launch.env_file;

  const cmdArgs = [];
  if (sessionId) cmdArgs.push("--session-id", sessionId);
  if (agent) cmdArgs.push("--agent", agent);
  if (worktree) cmdArgs.push("--worktree", worktree);
  if (args && args.length > 0) cmdArgs.push(...args);

  let child;
  if (envFile) {
    const safeEnv = String(envFile).replace(/'/g, "'\\''");
    const shell = `set -a && source '${safeEnv}' && set +a && exec "$0" "$@"`;
    child = spawn("sh", ["-c", shell, command, ...cmdArgs], {
      cwd: cwd || process.cwd(),
      stdio: "inherit",
    });
  } else {
    child = spawn("sh", ["-c", 'exec "$0" "$@"', command, ...cmdArgs], {
      cwd: cwd || process.cwd(),
      stdio: "inherit",
    });
  }

  child.on("error", (err) => {
    process.stderr.write(`launch error: ${err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

module.exports = { launch };
