"use strict";

/**
 * `a check`: run a command in the task's tree and record the result as a
 * `check_run` event. The tree must be clean (the recorded hash is the tree
 * it tested). Land skips a check whose last `check_run` pass matches its
 * own tree hash — the hash is the identity. The run takes one of the
 * machine-wide test slots (test-slot.js) and reads the hash inside it; a run
 * that queued returns `slot_wait`. `record: false` runs the command in a slot
 * on any tree and records nothing.
 */

const { spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const { withTestSlot } = require("./test-slot");
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

function refuseDirtyTree(tree) {
  const dirty = gitRun(["status", "--porcelain", "--untracked-files=no"], tree).stdout.trim();
  if (dirty) {
    throw refusal("dirty_tree", `${tree} has uncommitted changes:\n${dirty}`, "commit or stash, then check again");
  }
}

function recordCheckRun({ taskDir, command, treeHash, exit }) {
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) return null;
  db.appendEvent({
    kind: "check_run",
    taskId,
    sessionId: adapter.ownSessionId(),
    detail: JSON.stringify({ command, tree: treeHash, exit }),
  });
  const runs = db.listCheckRuns(taskId);
  return runs.length > 0 ? runs[0].at : null;
}

/**
 * @param {{taskDir: string, projectDir: string, command: string, capture?: boolean, record?: boolean}} opts
 * @returns {{command: string, tree: string|null, exit: number, at: string|null, recorded?: false, slot_wait?: string}}
 */
function check({ taskDir, projectDir, command, capture = false, record = true }) {
  if (!command || !command.trim()) {
    throw fail(2, "Usage: a check --task-dir <dir> [--repo <path>] -- <cmd>", "missing_command", {});
  }

  const key = repoKey(projectDir);
  const task = taskLib.readTaskJson(taskDir);
  const tree = require("./worktree").taskWorktreeOf(key, task, taskDir) || key.main_root;
  if (record) refuseDirtyTree(tree);

  const stdio = capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"];
  const { value: { treeHash, exit }, slot_wait } = withTestSlot({ verb: "check", taskDir }, () => {
    const treeHash = record ? gitRun(["rev-parse", "HEAD^{tree}"], tree).stdout.trim() : null;
    const r = spawnSync("zsh", ["-c", command], { cwd: tree, timeout: CHECK_TIMEOUT_MS, stdio });
    return { treeHash, exit: r.status === null ? 1 : r.status };
  });

  const waited = slot_wait && { slot_wait };
  if (!record) return { command, tree: null, exit, at: null, recorded: false, ...waited };
  const at = recordCheckRun({ taskDir, command, treeHash, exit });
  return { command, tree: treeHash, exit, at, ...waited };
}

module.exports = { check, CHECK_TIMEOUT_MS };
