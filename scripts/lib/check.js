"use strict";

/**
 * `a check`: run a command in the task's tree and record the result as a
 * `check_run` event. The tree must be clean (the recorded hash is the tree
 * it tested). Land skips a check whose last `check_run` pass matches its
 * own tree hash — the hash is the identity.
 */

const { spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const taskLib = require("./task");
const db = require("./db");
const { fail } = require("./start");
const adapter = require("./adapter").forHarness();

const CHECK_TIMEOUT_MS = 850000;

function gitRun(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}

function refusal(code, message, remedy) {
  return fail(2, `${message}\nRemedy: ${remedy}`, code, { remedy });
}

/**
 * @param {{taskDir: string, projectDir: string, command: string, capture?: boolean}} opts
 * @returns {{command: string, tree: string, exit: number, at: string|null}}
 */
function check({ taskDir, projectDir, command, capture = false }) {
  if (!command || !command.trim()) {
    throw fail(2, "Usage: a check --task-dir <dir> [--repo <path>] -- <cmd>", "missing_command", {});
  }

  const key = repoKey(projectDir);
  const task = taskLib.readTaskJson(taskDir);
  const tree = require("./worktree").taskWorktreeOf(key, task, taskDir) || key.main_root;

  const dirty = gitRun(["status", "--porcelain", "--untracked-files=no"], tree).stdout.trim();
  if (dirty) {
    throw refusal("dirty_tree", `${tree} has uncommitted changes:\n${dirty}`, "commit or stash, then check again");
  }

  const treeHash = gitRun(["rev-parse", "HEAD^{tree}"], tree).stdout.trim();
  const stdio = capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"];
  const r = spawnSync("zsh", ["-c", command], { cwd: tree, timeout: CHECK_TIMEOUT_MS, stdio });
  const exit = r.status === null ? 1 : r.status;

  const taskId = db.taskIdOf(taskDir);
  let at = null;
  if (taskId !== null) {
    db.appendEvent({
      kind: "check_run",
      taskId,
      sessionId: adapter.ownSessionId(),
      detail: JSON.stringify({ command, tree: treeHash, exit }),
    });
    const runs = db.listCheckRuns(taskId);
    at = runs.length > 0 ? runs[0].at : null;
  }

  return { command, tree: treeHash, exit, at };
}

module.exports = { check, CHECK_TIMEOUT_MS };
