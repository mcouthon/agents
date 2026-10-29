"use strict";

/**
 * Worktree operations: add, remove, list, clean, reap, survey, occupied.
 *
 * One creation path (`a worktree add`), one removal policy (`removalBlocker`).
 * Path: <root>/<repo-name>/<NNN>-<slug> (`worktreePath`), branch: wt/<NNN>-<slug>;
 * <root> is `worktrees_root` in ~/.agents/config.json, else ~/.agents/worktrees.
 * Worktrees made before the root existed stay where git registered them.
 * In database mode `add` symlinks the main checkout's `.tasks` into the new
 * worktree (excluded through info/exclude, so the worktree stays clean).
 * In every mode `add` also links the main checkout's untracked `.env*` files
 * (`env_links`).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy } = require("./policy");

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(repoDir, args) {
  try {
    execFileSync("git", ["-C", repoDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function isDirty(wtPath) {
  try {
    return git(wtPath, ["status", "--porcelain"]).length > 0;
  } catch {
    return true;
  }
}

function currentBranch(wtPath) {
  try {
    return git(wtPath, ["branch", "--show-current"]);
  } catch {
    return "";
  }
}

function isAncestor(repoDir, sha, ref) {
  return gitOk(repoDir, ["merge-base", "--is-ancestor", sha, ref]);
}

function parseWorktrees(repoDir) {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  const wts = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      wts.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length);
    } else if (line === "") {
      cur = null;
    }
  }
  return wts;
}

function shortBranch(ref) {
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

/**
 * The directory holding every engine worktree: `worktrees_root` from the agents config (a leading `~`
 * is HOME, a relative path resolves against the config file's directory), else ~/.agents/worktrees.
 */
function worktreesRoot() {
  const config = require("./config");
  const knob = config.loadConfig().worktrees_root;
  if (typeof knob !== "string" || !knob.trim()) return path.join(os.homedir(), ".agents", "worktrees");
  const v = knob.trim();
  if (v === "~" || v.startsWith("~/")) return path.join(os.homedir(), v.slice(1));
  return path.resolve(path.dirname(config.agentsConfigPath()), v);
}

/** Where the worktree `name` (`<NNN>-<slug>` for a task, else the chosen name) of the repo `key` lives. */
function worktreePath(key, name) {
  return path.join(worktreesRoot(), path.basename(key.main_root), name);
}

/** Branch and path of a task dir's worktree. */
function taskWorktree(key, taskDir) {
  const dirName = path.basename(taskDir);
  const match = dirName.match(/^(\d{3})-(.+)$/);
  const name = match ? `${match[1]}-${match[2]}` : `${dirName}-task`;
  return { branch: `wt/${name}`, path: worktreePath(key, name) };
}

/**
 * Add a worktree.
 * @param {object} opts
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {string} [opts.taskDir] - Task directory (task-bound worktree)
 * @param {string} [opts.name] - Name for non-task-bound worktree
 * @param {boolean} [opts.force] - Skip manifest overlap check
 * @returns {{branch: string, path: string, tasks_link: string, env_links: string[]}}
 */
function add({ projectDir, taskDir, name, force }) {
  const key = repoKey(projectDir);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;

  let branch, wtPath;

  if (taskDir) {
    const taskAbsDir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
    ({ branch, path: wtPath } = taskWorktree(key, taskAbsDir));

    if (!force) {
      const overlaps = checkManifestOverlap(key.main_root, taskAbsDir, key.key);
      if (overlaps.length > 0) {
        const err = new Error("manifest overlap with live tasks");
        err.code = "MANIFEST_OVERLAP";
        err.exitCode = 21;
        err.overlaps = overlaps;
        throw err;
      }
    }
  } else {
    if (!name) throw new Error("either --task or --name is required");
    branch = `wt/${name}`;
    wtPath = worktreePath(key, name);
  }

  if (fs.existsSync(wtPath)) {
    throw new Error(`path already exists: ${wtPath}`);
  }
  if (gitOk(key.main_root, ["rev-parse", "--verify", `refs/heads/${branch}`])) {
    throw new Error(`branch already exists: ${branch}`);
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(key.main_root, ["worktree", "add", "-b", branch, wtPath, base]);

  if (taskDir) {
    const taskAbsDir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
    recordWorktreeInTask(taskAbsDir, branch, wtPath, key.main_root);
  }

  return { branch, path: wtPath, tasks_link: linkRepoFiles(key.main_root, wtPath), env_links: linkEnvFiles(key.main_root, wtPath) };
}

/**
 * Symlink the main checkout's untracked root-level `.env*` entries into a new
 * worktree. Tracked names arrive with git and names already present are kept; on
 * any doubt about tracking nothing is linked. Writes no ignore rule. Never fails
 * the worktree.
 * @returns {string[]} the names linked
 */
function linkEnvFiles(mainRoot, wtPath) {
  const linked = [];
  let names;
  try {
    names = fs.readdirSync(mainRoot).filter((n) => n.startsWith(".env")).sort();
  } catch {
    return linked;
  }
  for (const name of names) {
    if (!isUntracked(mainRoot, name)) continue;
    const link = path.join(wtPath, name);
    try {
      fs.lstatSync(link);
      continue;
    } catch (err) {
      if (err.code !== "ENOENT") continue;
    }
    try {
      const target = path.join(mainRoot, name);
      fs.symlinkSync(target, link, fs.statSync(target).isDirectory() ? "dir" : "file");
      linked.push(name);
    } catch {
      // a name that cannot be linked is skipped
    }
  }
  return linked;
}

/** True only when git says the name matches nothing it tracks; any other failure counts as tracked. */
function isUntracked(mainRoot, name) {
  try {
    execFileSync("git", ["-C", mainRoot, "ls-files", "--error-unmatch", "--", `:(literal)${name}`], { stdio: "pipe", encoding: "utf8" });
    return false;
  } catch (err) {
    return /did not match/.test(String(err.stderr || ""));
  }
}

/**
 * Link the main checkout's `.tasks` into a new worktree so repo-files task
 * Markdown is reachable there. Never fails the worktree.
 * @returns {string} "created" | "exists" | "skipped: <reason>" | "failed: <message>"
 */
function linkRepoFiles(mainRoot, wtPath) {
  try {
    if (!require("./db").enabled()) return "skipped: database off";
    const files = require("./tasks-root").ensureRepoFilesRoot(mainRoot);
    if (!files) return "skipped: no repo .tasks directory";
    const link = path.join(wtPath, ".tasks");
    try {
      fs.lstatSync(link);
      return "exists";
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    fs.symlinkSync(files, link, "dir");
    return "created";
  } catch (err) {
    return `failed: ${err.message}`;
  }
}

/**
 * Record branch and worktree_path in task.json for the bound task.
 * Stamps only non-terminal phases (done/failed/skipped/landed are left alone
 * — they already ran or will run elsewhere).
 */
function recordWorktreeInTask(taskDir, branch, wtPath, projectDir) {
  const taskLib = require("./task");
  if (!taskLib.isMigrated(taskDir)) return;
  const { withLock } = require("./lock");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  const TERMINAL = ["done", "failed", "skipped", "landed"];
  withLock(taskDir, holder, () => {
    const task = taskLib.readTaskJson(taskDir);
    if (!task) return;
    for (const phase of task.phases || []) {
      if (!phase.branch && !TERMINAL.includes(phase.status)) phase.branch = branch;
    }
    if (!task.worktree_path) task.worktree_path = wtPath;
    taskLib.writeTaskJson(taskDir, task);
  });
}

/**
 * Remove a worktree. Refuses if dirty or if branch has unlanded commits.
 * @param {object} opts
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {string} opts.path - Worktree path to remove
 * @param {boolean} [opts.force] - Skip safety checks
 * @returns {{removed: string, branch: string|null, branchDeleted: boolean}}
 */
function remove({ projectDir, path: wtPath, force }) {
  const key = repoKey(projectDir);
  const wtAbs = path.resolve(wtPath);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;

  if (!fs.existsSync(wtAbs)) {
    throw new Error(`worktree path does not exist: ${wtAbs}`);
  }

  if (!force && isDirty(wtAbs)) {
    const err = new Error("worktree has uncommitted changes; use --force to remove anyway");
    err.code = "DIRTY";
    throw err;
  }

  const branch = currentBranch(wtAbs);

  if (!force && branch && branch !== base) {
    const merged = isAncestor(key.main_root, branch, base);
    if (!merged) {
      // Check if any task phase in the central root has this branch landed
      const { tasksRoot } = require("./tasks-root");
      const taskLib = require("./task");
      const centralDir = tasksRoot(key);
      let landed = false;
      if (fs.existsSync(centralDir)) {
        for (const name of fs.readdirSync(centralDir)) {
          if (name.startsWith(".")) continue;
          const dir = path.join(centralDir, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          if (!taskLib.isMigrated(dir)) continue;
          const task = taskLib.readTaskJson(dir);
          if (!task) continue;
          const phase = (task.phases || []).find((p) => p.branch === branch);
          if (phase && phase.status === "landed") { landed = true; break; }
        }
      }
      if (!landed) {
        const err = new Error(
          `branch ${branch} has unlanded commits; land first or use --force`
        );
        err.code = "UNLANDED";
        throw err;
      }
    }
  }

  git(key.main_root, ["worktree", "remove", wtAbs]);
  git(key.main_root, ["worktree", "prune"]);

  let branchDeleted = false;
  if (branch && branch !== base && isAncestor(key.main_root, branch, base)) {
    try {
      git(key.main_root, ["branch", "-d", branch]);
      branchDeleted = true;
    } catch {}
  }

  // Clear branch/worktree_path from task.json phases in the central root
  // that referenced the removed branch (non-landed only).
  if (branch) {
    const { tasksRoot } = require("./tasks-root");
    const taskLib = require("./task");
    const { withLock } = require("./lock");
    const centralDir = tasksRoot(key);
    if (fs.existsSync(centralDir)) {
      const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
      for (const name of fs.readdirSync(centralDir)) {
        if (name.startsWith(".")) continue;
        const dir = path.join(centralDir, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (!taskLib.isMigrated(dir)) continue;
        try {
          withLock(dir, holder, () => {
            const task = taskLib.readTaskJson(dir);
            if (!task) return;
            let touched = false;
            for (const phase of task.phases || []) {
              if (phase.branch === branch && phase.status !== "landed") {
                phase.branch = "";
                phase.worktree_path = "";
                touched = true;
              }
            }
            if (wtAbs && task.worktree_path === wtAbs) {
              task.worktree_path = "";
              touched = true;
            }
            if (touched) {
              taskLib.writeTaskJson(dir, task);
            }
          });
        } catch {}
      }
    }
  }

  return { removed: wtAbs, branch, branchDeleted };
}

/**
 * List all worktrees.
 * @param {string} projectDir
 * @returns {object[]} Array of {path, branch, isMain}
 */
function list(projectDir) {
  const key = repoKey(projectDir);
  const wts = parseWorktrees(key.main_root);
  return wts.map((wt) => ({
    path: wt.path,
    branch: shortBranch(wt.branch),
    isMain: path.resolve(wt.path) === path.resolve(key.main_root),
  }));
}

/**
 * Sweep stale worktrees (merged branches, wt/* and .claude/worktrees/*).
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {boolean} [opts.dryRun] - Report only, do not remove
 * @returns {{removed: string[], skipped: object[]}}
 */
function clean({ projectDir, dryRun }) {
  const key = repoKey(projectDir);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;
  const wts = parseWorktrees(key.main_root);
  const live = liveRegistrations();

  const removed = [];
  const skipped = [];

  for (const wt of wts) {
    const isMain = path.resolve(wt.path) === path.resolve(key.main_root);
    if (isMain) continue;

    const branch = shortBranch(wt.branch);
    if (!branch) continue;

    const isWtBranch = branch.startsWith("wt/");
    const isClaudeWt = wt.path.includes(".claude/worktrees/");
    if (!isWtBranch && !isClaudeWt) continue;

    const reason = removalBlocker(key.main_root, base, { path: wt.path, branch }, live);
    if (reason) {
      skipped.push({ path: wt.path, branch, reason });
      continue;
    }

    if (dryRun) {
      removed.push({ path: wt.path, branch });
      continue;
    }

    try {
      git(key.main_root, ["worktree", "remove", wt.path]);
      removed.push({ path: wt.path, branch });
      try {
        git(key.main_root, ["branch", "-d", branch]);
      } catch {}
    } catch (err) {
      skipped.push({ path: wt.path, branch, reason: err.message });
    }
  }

  if (!dryRun) {
    try { git(key.main_root, ["worktree", "prune"]); } catch {}
  }

  return { removed, skipped };
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(p, dir) {
  const a = realOrResolved(p);
  const d = realOrResolved(dir);
  return a === d || a.startsWith(d + path.sep);
}

/** Registrations with a cwd that are live by the same test `a start` uses (the process, or its zmx session). */
function liveRegistrations() {
  const start = require("./start");
  const zmx = start.zmxSessions();
  return require("./session").list().filter((reg) => reg.cwd && start.liveSession(reg, zmx).live);
}

/**
 * Why the clean policy keeps the worktree `wt` ({path, branch}): its branch is not merged into
 * `base`, its tree is dirty, or one of the `live` registrations has its cwd inside it. Null when it may go.
 */
function removalBlocker(mainRoot, base, wt, live) {
  if (!wt.branch) return "detached HEAD";
  if (!isAncestor(mainRoot, wt.branch, base)) return `branch ${wt.branch} is not merged into ${base}`;
  if (isDirty(wt.path)) return "uncommitted changes";
  const occupant = live.find((reg) => isInside(reg.cwd, wt.path));
  if (occupant) {
    const id = String(occupant.session_id || occupant.terminal_id || "unknown").slice(0, 8);
    return `live session ${id} (${occupant.agent || "unknown agent"}) runs inside it`;
  }
  return null;
}

/**
 * Remove the worktree at `wtPath` and its branch when `removalBlocker` finds nothing; never forces.
 * @returns {{path: string, branch: string|null, removed: boolean, branch_deleted: boolean, reason?: string}}
 */
function reap({ projectDir, path: wtPath }) {
  const key = repoKey(projectDir);
  const base = resolvePolicy(key.main_root).base;
  const target = realOrResolved(wtPath);
  const listed = parseWorktrees(key.main_root).find((w) => realOrResolved(w.path) === target);
  const out = { path: wtPath, branch: listed ? shortBranch(listed.branch) : null, removed: false, branch_deleted: false };
  if (!listed || !fs.existsSync(listed.path)) return { ...out, reason: "not a worktree of this repo" };
  if (target === realOrResolved(key.main_root)) return { ...out, reason: "it is the main checkout" };
  const reason = removalBlocker(key.main_root, base, { path: listed.path, branch: out.branch }, liveRegistrations());
  if (reason) return { ...out, reason };
  try {
    const result = remove({ projectDir: key.main_root, path: listed.path, force: false });
    return { ...out, removed: true, branch_deleted: result.branchDeleted };
  } catch (err) {
    return { ...out, reason: err.message };
  }
}

/** The one line a verb prints for a `reap` result. */
function reapLine(result) {
  return result.removed ? `worktree removed: ${result.path}` : `worktree kept: ${result.path} (${result.reason})`;
}

/** The registered, non-main worktree of a task: its recorded worktree_path, else the one on its derived branch. */
function taskWorktreeOf(key, task, taskDir) {
  const wts = parseWorktrees(key.main_root).filter((w) => realOrResolved(w.path) !== realOrResolved(key.main_root));
  const recorded = task.worktree_path && wts.find((w) => realOrResolved(w.path) === realOrResolved(task.worktree_path));
  if (recorded) return recorded.path;
  const derived = taskWorktree(key, taskDir).branch;
  const onBranch = wts.find((w) => shortBranch(w.branch) === derived);
  return onBranch ? onBranch.path : null;
}

/** True when the task dir `name` has left the live tasks root by a close (archived, or closed in the database). */
function taskClosed(key, name) {
  const { tasksRoot, archiveRoot } = require("./tasks-root");
  if (fs.existsSync(path.join(tasksRoot(key), name))) return false;
  if (fs.existsSync(path.join(archiveRoot(), key.key, name))) return true;
  try {
    const db = require("./db");
    if (!db.enabled()) return false;
    const bare = (k) => String(k).replace(/^\//, "");
    return db.listTasks().some((t) => t.dir_name === name && t.disposition !== "active" && bare(t.repo_key) === bare(key.key));
  } catch {
    return false;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)).sort();
  } catch {
    return [];
  }
}

function shellWord(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The worktrees under the root (`<root>/<repo>/<name>`) that `a worktree clean` would remove or
 * that belong to a closed task, each with why it stays when it stays. Directories git does not list
 * as a worktree of the repo they point at are skipped.
 * @returns {{path: string, branch: string|null, repo: string, task: string|null, task_closed: boolean, removable: boolean, reason: string|null, clean: string|null}[]}
 */
function survey() {
  const rows = [];
  let live = null;
  for (const repoDir of subdirs(worktreesRoot())) {
    for (const dir of subdirs(repoDir)) {
      let mainRoot, key, listed;
      try {
        mainRoot = path.dirname(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
        key = repoKey(mainRoot);
        listed = parseWorktrees(key.main_root).find((w) => realOrResolved(w.path) === realOrResolved(dir));
      } catch {
        continue;
      }
      if (!listed || realOrResolved(listed.path) === realOrResolved(key.main_root)) continue;
      const branch = shortBranch(listed.branch);
      const named = branch && branch.match(/^wt\/(\d{3}-.+)$/);
      const task = named ? named[1] : null;
      const taskIsClosed = task ? taskClosed(key, task) : false;
      if (live === null) live = liveRegistrations();
      const reason = branch && !branch.startsWith("wt/")
        ? `branch ${branch} is not a wt/ branch`
        : removalBlocker(key.main_root, resolvePolicy(key.main_root).base, { path: listed.path, branch }, live);
      if (reason && !taskIsClosed) continue;
      rows.push({
        path: listed.path, branch, repo: key.main_root, task, task_closed: taskIsClosed,
        removable: !reason, reason, clean: reason ? null : `a worktree clean --repo ${shellWord(key.main_root)}`,
      });
    }
  }
  return rows;
}

/** The one line `a doctor` prints for a `survey` row. */
function surveyLine(row) {
  const closed = row.task_closed ? `task ${row.task} is closed; ` : "";
  return `${row.path} [${row.branch || "(detached)"}]: ${closed}${row.removable ? `removable; run: ${row.clean}` : `stays: ${row.reason}`}`;
}

/**
 * Check if the main checkout is occupied by a live session.
 * @param {string} projectDir
 * @returns {boolean}
 */
function occupied(projectDir) {
  const key = repoKey(projectDir);
  let session;
  try { session = require("./session"); } catch { return false; }
  const sessions = session.list();
  return sessions.some((s) =>
    !s.ended_at && s.pid && session.isPidAlive(s.pid) &&
    s.repo_key === key.key &&
    s.cwd && path.resolve(s.cwd) === path.resolve(key.main_root)
  );
}

/**
 * Check manifest overlap between a new task and all live tasks in the repo.
 * @param {string} projectDir - Repo main root
 * @param {string} newTaskDir - The new task's directory
 * @param {string} repoKeyValue - The repo key for filtering sessions
 * @returns {object[]} Array of {task, files} for each overlapping task
 */
function checkManifestOverlap(projectDir, newTaskDir, repoKeyValue) {
  const taskLib = require("./task");
  let session;
  try { session = require("./session"); } catch { return []; }

  const newTask = taskLib.readTaskJson(newTaskDir);
  if (!newTask) return [];
  const newManifests = new Set();
  for (const phase of newTask.phases || []) {
    for (const f of phase.manifest || []) newManifests.add(f);
  }
  if (newManifests.size === 0) return [];

  const liveSessions = session.list().filter((s) =>
    !s.ended_at && s.pid && session.isPidAlive(s.pid) &&
    s.repo_key === repoKeyValue && s.task_dir
  );

  const overlaps = [];
  for (const s of liveSessions) {
    if (path.resolve(s.task_dir) === path.resolve(newTaskDir)) continue;
    const otherTask = taskLib.readTaskJson(s.task_dir);
    if (!otherTask) continue;
    const otherManifests = new Set();
    for (const phase of otherTask.phases || []) {
      if (["done", "failed", "skipped", "landed"].includes(phase.status)) continue;
      for (const f of phase.manifest || []) otherManifests.add(f);
    }
    const shared = [...newManifests].filter((f) => otherManifests.has(f));
    if (shared.length > 0) {
      overlaps.push({ task: path.basename(s.task_dir), files: shared });
    }
  }
  return overlaps;
}

module.exports = {
  worktreesRoot,
  worktreePath,
  taskWorktree,
  add,
  linkEnvFiles,
  remove,
  list,
  clean,
  reap,
  reapLine,
  taskWorktreeOf,
  removalBlocker,
  survey,
  surveyLine,
  occupied,
  checkManifestOverlap,
  isDirty,
  isAncestor,
  parseWorktrees,
  shortBranch,
  currentBranch,
  recordWorktreeInTask,
  linkRepoFiles,
};
