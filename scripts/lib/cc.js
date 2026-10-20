"use strict";

const path = require("path");

/**
 * Resolve the --worktree value for `a cc`.
 *
 * A bare --worktree (no value) with a bound task derives the worktree name
 * from the task directory basename (<NNN>-<slug>), matching `a worktree
 * add --task` so the WorktreeCreate hook binds the worktree to the task.
 * A bare --worktree without --task is an error.
 *
 * @param {object} opts
 * @param {true|string|undefined} opts.worktreeFlag - Raw --worktree arg (true when bare)
 * @param {string|null} opts.taskDir - Absolute task dir, or null
 * @returns {string|undefined} The worktree name, or undefined
 */
function resolveWorktree({ worktreeFlag, taskDir }) {
  if (worktreeFlag === true) {
    if (!taskDir) throw new Error("--worktree needs a name");
    return path.basename(taskDir);
  }
  return worktreeFlag || undefined;
}

/**
 * Build the `a launch` argv that the cc tmux pane runs.
 *
 * Always appends `-- --add-dir <tasksRoot>` (D25: task-file edits never
 * prompt) and forwards any caller passthrough args after `--`.
 *
 * @param {object} opts
 * @param {string} opts.agent
 * @param {string} opts.sessionId
 * @param {string} opts.cwd
 * @param {string|undefined} opts.worktree
 * @param {string} opts.tasksRoot - Central tasks root for the repo (D35)
 * @param {string[]} [opts.passthrough] - Extra args to forward to claude
 * @returns {string[]} The full argv (starts with "a", "launch", ...)
 */
function buildLaunchCommand({ agent, sessionId, cwd, worktree, tasksRoot, passthrough }) {
  const cmd = ["a", "launch", "--agent", agent, "--session-id", sessionId, "--cwd", cwd];
  if (worktree) cmd.push("--worktree", worktree);
  cmd.push("--", "--add-dir", tasksRoot);
  if (passthrough && passthrough.length > 0) cmd.push(...passthrough);
  return cmd;
}

module.exports = { resolveWorktree, buildLaunchCommand };
