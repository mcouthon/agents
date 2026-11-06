"use strict";

/**
 * Worktree operations: add, remove, list, reap, survey, sweep.
 *
 * One creation path (`a start`), one removal rule (`removalBlocker`): a
 * worktree is removable when its tree is clean, no live session runs inside
 * it, it holds no stray task notes, and either its task is done (every phase
 * checked and the landing landed) or its task is closed (disposition not
 * active). A non-task worktree keeps the merged-into-base leg.
 * Path: <root>/<repo-name>/<NNN>-<slug> (`worktreePath`), branch: wt/<NNN>-<slug>;
 * <root> is `worktrees_root` in ~/.agents/config.json, else ~/.agents/worktrees.
 * `add` copies the main checkout's untracked `.env*` files (`env_copies`) and
 * symlinks `.tasks/<NNN-slug>` in both the main checkout and the new worktree
 * (excluded through the shared info/exclude, so the worktree stays clean).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy } = require("./policy");
const { tasksRoot } = require("./tasks-root");

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
 * @returns {{branch: string, path: string, tasks_link: string, env_copies: string[]}}
 */
function add({ projectDir, taskDir, name, force }) {
  const key = repoKey(projectDir);
  const policy = resolvePolicy(key.main_root);
  const base = policy.base;

  let branch, wtPath;

  if (taskDir) {
    const taskAbsDir = path.isAbsolute(taskDir) ? taskDir : path.resolve(projectDir, taskDir);
    ({ branch, path: wtPath } = taskWorktree(key, taskAbsDir));
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
    linkTaskFolder(key.main_root, taskAbsDir);
    linkTaskFolder(wtPath, taskAbsDir);
  }

  return { branch, path: wtPath, env_copies: copyEnvFiles(key.main_root, wtPath) };
}

/**
 * Copy the main checkout's untracked root-level `.env*` files into a new
 * worktree. Tracked names arrive with git and names already present are kept; on
 * any doubt about tracking nothing is copied. Directory entries are skipped.
 * Writes no ignore rule. Never fails the worktree.
 * @returns {string[]} the names copied
 */
function copyEnvFiles(mainRoot, wtPath) {
  const copied = [];
  let names;
  try {
    names = fs.readdirSync(mainRoot).filter((n) => n.startsWith(".env")).sort();
  } catch {
    return copied;
  }
  for (const name of names) {
    if (!isUntracked(mainRoot, name)) continue;
    const dest = path.join(wtPath, name);
    try {
      fs.lstatSync(dest);
      continue;
    } catch (err) {
      if (err.code !== "ENOENT") continue;
    }
    try {
      const target = path.join(mainRoot, name);
      if (fs.statSync(target).isDirectory()) continue;
      fs.copyFileSync(target, dest);
      copied.push(name);
    } catch {
      // a name that cannot be copied is skipped
    }
  }
  return copied;
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
 * Symlink the central task folder into `<repoRoot>/.tasks/<dirName>` (replacing
 * a dangling or existing link; a real directory is left alone) and append
 * `/.tasks/` to the shared `<git-common-dir>/info/exclude` once (idempotent,
 * shared by all worktrees of the repo). Convenience for `@` completion and
 * relative paths; the engine resolves tasks through the central root, not
 * this symlink.
 */
function linkTaskFolder(repoRoot, taskDir) {
  const dirName = path.basename(taskDir);
  const tasksDir = path.join(repoRoot, ".tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const link = path.join(tasksDir, dirName);
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(link);
    } else {
      return;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.symlinkSync(taskDir, link);
  try {
    let commonDir = git(repoRoot, ["rev-parse", "--git-common-dir"]);
    if (!path.isAbsolute(commonDir)) commonDir = path.resolve(repoRoot, commonDir);
    const exclude = path.join(commonDir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    let content = "";
    try { content = fs.readFileSync(exclude, "utf8"); } catch {}
    if (!content.includes("/.tasks/")) {
      const sep = content && !content.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(exclude, content + sep + "/.tasks/\n");
    }
  } catch {}
}

/**
 * Record where a task's work lives: worktree_path and branch on its row
 * (identity, not status; no event).
 */
function recordWorktreeInTask(taskDir, branch, wtPath, projectDir) {
  const db = require("./db");
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) return;
  db.setTaskWorktree(taskId, { worktreePath: wtPath, branch });
}

const TEARDOWN_TIMEOUT_MS = 120000;

/**
 * Run the repo's teardown command (the `setup` opposite) inside the worktree
 * right before its directory is removed. Never throws — a failure warns on
 * stderr and the removal proceeds. Null when the target is the main checkout
 * or no command is configured.
 * @returns {{command: string, exit_code: number|null}|null}
 */
function runTeardown(mainRoot, wtPath) {
  if (realOrResolved(wtPath) === realOrResolved(mainRoot)) return null;
  let command;
  try {
    command = require("./start").teardownCommand(repoKey(mainRoot));
  } catch {
    return null;
  }
  if (!command) return null;
  const out = { command, exit_code: null };
  try {
    const r = spawnSync("zsh", ["-c", command], {
      cwd: wtPath, encoding: "utf8", timeout: TEARDOWN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      env: require("./checkout-env").setupEnv(),
    });
    if (r.error) {
      process.stderr.write(`warning: teardown command could not run in ${wtPath}: ${r.error.message}; removing anyway\n`);
    } else {
      out.exit_code = r.status;
      if (r.status !== 0) {
        const tail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-5).join("\n");
        process.stderr.write(`warning: teardown command failed in ${wtPath} (exit ${r.status}); removing anyway\n${tail}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`warning: teardown command could not run in ${wtPath}: ${err.message}; removing anyway\n`);
  }
  return out;
}

/**
 * Remove a worktree. Refuses if dirty or if branch has unlanded commits.
 * @param {object} opts
 * @param {string} opts.projectDir - Any path inside the repo
 * @param {string} opts.path - Worktree path to remove
 * @param {boolean} [opts.force] - Skip safety checks
 * @returns {{removed: string, branch: string|null, branchDeleted: boolean, teardown?: {command: string, exit_code: number|null}}}
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

  if (!force) {
    const notes = strayTaskNotes(wtAbs);
    if (notes.length > 0) {
      const err = new Error(
        `worktree holds task notes in .tasks/${notes.join(", .tasks/")}; no verb folds; move them into ${tasksRoot(repoKey(projectDir))} by hand, or use --force to remove anyway`
      );
      err.code = "NOTES";
      throw err;
    }
  }

  const branch = currentBranch(wtAbs);

  if (!force && branch && branch !== base && !isAncestor(key.main_root, branch, base)) {
    // A task whose derived landing is landed may remove its worktree even when
    // git cannot show the merge (a squash, a PR).
    const db = require("./db");
    const landed = (db.tasksOnWorktree(branch, wtAbs) || []).some((row) => {
      try {
        const landing = require("./derive").landingOfTask(row);
        return landing !== null && landing.state === "landed";
      } catch { return false; }
    });
    if (!landed) {
      const err = new Error(
        `branch ${branch} has unlanded commits; land first or use --force`
      );
      err.code = "UNLANDED";
      throw err;
    }
  }

  const teardown = runTeardown(key.main_root, wtAbs);
  git(key.main_root, ["worktree", "remove", ...(force ? ["--force"] : []), wtAbs]);
  git(key.main_root, ["worktree", "prune"]);

  let branchDeleted = false;
  if (branch && branch !== base && isAncestor(key.main_root, branch, base)) {
    try {
      git(key.main_root, ["branch", "-d", branch]);
      branchDeleted = true;
    } catch {}
  }

  // Clear the worktree record of the tasks that named this branch or path
  // (identity: where the work lives; the worktree is gone).
  if (branch) {
    const db = require("./db");
    for (const row of db.tasksOnWorktree(branch, wtAbs)) {
      if (row.worktree_path && wtAbs && path.resolve(row.worktree_path) === path.resolve(wtAbs)) {
        db.setTaskWorktree(row.id, { worktreePath: null });
      }
      if (row.branch === branch) db.setTaskWorktree(row.id, { branch: null });
    }
  }

  const result = { removed: wtAbs, branch, branchDeleted };
  if (teardown) result.teardown = teardown;
  return result;
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

/** The NNN-* task folders a real (not symlinked) .tasks directory holds, else []. Symlinked entries are skipped. */
function strayTaskNotes(dir) {
  const tasks = path.join(dir, ".tasks");
  let st;
  try { st = fs.lstatSync(tasks); } catch { return []; }
  if (st.isSymbolicLink() || !st.isDirectory()) return [];
  try {
    return fs.readdirSync(tasks, { withFileTypes: true })
      .filter((e) => /^\d{3}-/.test(e.name) && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Why the one removal rule keeps the worktree `wt` ({path, branch}): its tree is
 * dirty, it holds task notes under a real .tasks, or one of the `live`
 * registrations has its cwd inside it. A task worktree (wt/<NNN>-<slug>) is
 * removable when its task is done (every phase checked and the landing landed)
 * or closed (disposition not active); a non-task worktree keeps the
 * merged-into-base leg. Null when it may go.
 */
function removalBlocker(mainRoot, base, wt, live) {
  if (!wt.branch) return "detached HEAD";
  const taskMatch = wt.branch.match(/^wt\/(\d{3}-.+)$/);
  if (!taskMatch && !isAncestor(mainRoot, wt.branch, base)) {
    return `branch ${wt.branch} is not merged into ${base}`;
  }
  if (isDirty(wt.path)) return "uncommitted changes";
  const notes = strayTaskNotes(wt.path);
  if (notes.length > 0) return `holds task notes in .tasks/${notes.join(", .tasks/")}`;
  const occupant = live.find((reg) => isInside(reg.cwd, wt.path));
  if (occupant) {
    const id = String(occupant.session_id || occupant.terminal_id || "unknown").slice(0, 8);
    return `live session ${id} (${occupant.agent || "unknown agent"}) runs inside it`;
  }
  if (taskMatch) {
    const status = taskDoneOrClosed(mainRoot, taskMatch[1]);
    if (status === null) {
      if (!isAncestor(mainRoot, wt.branch, base)) return `branch ${wt.branch} is not merged into ${base}`;
      return null;
    }
    if (status === true) return null;
    return `task ${taskMatch[1]} is not done`;
  }
  return null;
}

/** True when the task `name` is done (derived) or closed; null when the task is not in the database (treat as non-task). */
function taskDoneOrClosed(mainRoot, taskName) {
  try {
    const key = repoKey(mainRoot);
    if (taskClosed(key, taskName)) return true;
    const db = require("./db");
    const bare = (k) => String(k).replace(/^\//, "");
    const row = db.listTasks({ disposition: "active", repoKey: bare(key.key) }).find((r) => r.dir_name === taskName);
    if (!row) return null;
    const doc = require("./task").readTaskJson(row.task_dir);
    return require("./derive").taskStatusOf(row, doc) === "done";
  } catch {
    return null;
  }
}

/**
 * Every real .tasks/NNN-* stray in a repo's main checkout or one of its worktrees
 * (the doctor's stray-notes warnings; a worktree list that fails leaves the checkout's own).
 */
function strayNotesInRepo(mainRoot) {
  const out = [];
  if (!mainRoot || !fs.existsSync(mainRoot)) return out;
  for (const name of strayTaskNotes(mainRoot)) out.push(path.join(mainRoot, ".tasks", name));
  const r = require("child_process").spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: mainRoot, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status === 0) {
    for (const line of (r.stdout || "").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const w = line.slice("worktree ".length);
      if (path.resolve(w) === path.resolve(mainRoot)) continue;
      for (const name of strayTaskNotes(w)) out.push(path.join(w, ".tasks", name));
    }
  }
  return out;
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

/**
 * Sweep stale worktrees of the repo: every non-main `parseWorktrees` row (wt/*
 * and harness worktrees alike) that the one removal rule lets go is removed
 * with its branch. A throwing sweep produces warnings, never an exception.
 * @returns {{swept: {path: string, branch: string}[], warnings: string[]}}
 */
function sweepStale(mainRoot) {
  const swept = [];
  const warnings = [];
  try {
    const base = resolvePolicy(mainRoot).base;
    const wts = parseWorktrees(mainRoot);
    const live = liveRegistrations();
    const harnessMarker = require("./adapter").forHarness().harnessWorktrees();
    for (const wt of wts) {
      if (path.resolve(wt.path) === path.resolve(mainRoot)) continue;
      const branch = shortBranch(wt.branch);
      if (!branch) continue;
      if (!branch.startsWith("wt/") && !wt.path.includes(harnessMarker)) continue;
      const reason = removalBlocker(mainRoot, base, { path: wt.path, branch }, live);
      if (reason) continue;
      try {
        runTeardown(mainRoot, wt.path);
        git(mainRoot, ["worktree", "remove", wt.path]);
        swept.push({ path: wt.path, branch });
        try { git(mainRoot, ["branch", "-d", branch]); } catch {}
      } catch (err) {
        warnings.push(`could not remove ${wt.path}: ${err.message}`);
      }
    }
    try { git(mainRoot, ["worktree", "prune"]); } catch {}
  } catch (err) {
    warnings.push(`sweep failed: ${err.message}`);
  }
  return { swept, warnings };
}

/**
 * Run the one removal rule over every removable survey row across repos.
 * @returns {{removed: {path, branch, repo}[], kept: {path, branch, repo, reason}[]}}
 */
function cleanSurvey() {
  const rows = survey();
  const removed = [];
  const kept = [];
  for (const row of rows) {
    if (!row.removable) {
      kept.push({ path: row.path, branch: row.branch, repo: row.repo, reason: row.reason });
      continue;
    }
    try {
      const result = reap({ projectDir: row.repo, path: row.path });
      if (result.removed) removed.push({ path: row.path, branch: row.branch, repo: row.repo });
      else kept.push({ path: row.path, branch: row.branch, repo: row.repo, reason: result.reason });
    } catch (err) {
      kept.push({ path: row.path, branch: row.branch, repo: row.repo, reason: err.message });
    }
  }
  return { removed, kept };
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
 * The worktrees under the root (`<root>/<repo>/<name>`) and under any repo's
 * harness worktrees directory that `a doctor --clean` would remove or that
 * belong to a closed task, each with why it stays when it stays. Directories
 * git does not list as a worktree of the repo they point at are skipped.
 * @returns {{path: string, branch: string|null, repo: string, task: string|null, task_closed: boolean, removable: boolean, reason: string|null, clean: string|null}[]}
 */
function survey() {
  const rows = [];
  let live = null;
  const harnessMarker = require("./adapter").forHarness().harnessWorktrees();
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
      const reason = branch && !branch.startsWith("wt/") && !listed.path.includes(harnessMarker)
        ? `branch ${branch} is not a wt/ branch`
        : removalBlocker(key.main_root, resolvePolicy(key.main_root).base, { path: listed.path, branch }, live);
      if (reason && !taskIsClosed) continue;
      rows.push({
        path: listed.path, branch, repo: key.main_root, task, task_closed: taskIsClosed,
        removable: !reason, reason, clean: reason ? null : "a doctor --clean",
      });
    }
  }
  try {
    const db = require("./db");
    if (db.describe().present) {
      for (const repo of db.listRepos()) {
      if (!repo.main_root || !fs.existsSync(repo.main_root)) continue;
      let wts;
      try { wts = parseWorktrees(repo.main_root); } catch { continue; }
      for (const wt of wts) {
        if (path.resolve(wt.path) === path.resolve(repo.main_root)) continue;
        if (!wt.path.includes(harnessMarker)) continue;
        if (rows.some((r) => realOrResolved(r.path) === realOrResolved(wt.path))) continue;
        if (live === null) live = liveRegistrations();
        const branch = shortBranch(wt.branch);
        const reason = removalBlocker(repo.main_root, resolvePolicy(repo.main_root).base, { path: wt.path, branch }, live);
        rows.push({
          path: wt.path, branch, repo: repo.main_root, task: null, task_closed: false,
          removable: !reason, reason, clean: reason ? null : "a doctor --clean",
        });
        }
      }
    }
  } catch {}
  return rows;
}

/** The one line `a doctor` prints for a `survey` row. */
function surveyLine(row) {
  const closed = row.task_closed ? `task ${row.task} is closed; ` : "";
  return `${row.path} [${row.branch || "(detached)"}]: ${closed}${row.removable ? `removable; run: ${row.clean}` : `stays: ${row.reason}`}`;
}

module.exports = {
  worktreesRoot,
  worktreePath,
  taskWorktree,
  add,
  copyEnvFiles,
  linkTaskFolder,
  remove,
  list,
  reap,
  reapLine,
  sweepStale,
  cleanSurvey,
  taskWorktreeOf,
  removalBlocker,
  strayTaskNotes,
  strayNotesInRepo,
  survey,
  surveyLine,
  isDirty,
  isAncestor,
  parseWorktrees,
  shortBranch,
  currentBranch,
  recordWorktreeInTask,
};
