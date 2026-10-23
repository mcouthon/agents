"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Pure helpers (easily testable, no side effects)
// ---------------------------------------------------------------------------

/**
 * Resolve the --worktree value for `a cc`.
 *
 * A bare --worktree (no value) with a bound task derives the worktree name
 * from the task directory basename (<NNN>-<slug>), matching `a worktree
 * add --task`.
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
 * Build the `a launch` argv that the cc tmux/zmx pane runs.
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

/**
 * Parse the `a cc` argv into a structured options object.
 *
 * Flags are parsed before any positional is treated as a prompt (D39).
 * The first positional "courier" is shorthand for `--agent Courier`.
 * Remaining positionals:
 *   - Conductor: first positional is a task slug
 *   - Courier: first positional is a prompt (title from first line, max 80 chars)
 *
 * @param {string[]} argv - The raw argv after `a cc` (i.e. process.argv.slice(3))
 * @returns {object} Parsed options
 */
function parseCcArgs(argv) {
  const opts = {
    agent: null,
    task: null,
    continueFlag: false,
    title: null,
    prompt: null,
    noWorktree: false,
    tmux: false,
    noAttach: false,
    json: false,
    passthrough: [],
    positionals: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      opts.passthrough = argv.slice(i + 1);
      break;
    }
    switch (arg) {
      case "--agent":
        opts.agent = argv[++i];
        break;
      case "--task":
        opts.task = argv[++i];
        break;
      case "--continue":
        opts.continueFlag = true;
        break;
      case "--title":
        opts.title = argv[++i];
        break;
      case "--no-worktree":
        opts.noWorktree = true;
        break;
      case "--tmux":
        opts.tmux = true;
        break;
      case "--no-attach":
        opts.noAttach = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--repo":
        opts.repo = argv[++i];
        break;
      default:
        if (arg.startsWith("--")) {
          // Unknown flag — pass through to passthrough
          opts.passthrough.push(arg);
        } else {
          opts.positionals.push(arg);
        }
        break;
    }
    i++;
  }

  // "courier" as first positional is shorthand for --agent Courier (D43).
  if (opts.positionals.length > 0 && opts.positionals[0] === "courier") {
    opts.agent = opts.agent || "courier";
    opts.positionals.shift();
  }

  return opts;
}

/**
 * Derive a title from a prompt's first line (max 80 chars).
 * @param {string} prompt
 * @returns {string}
 */
function deriveTitleFromPrompt(prompt) {
  if (!prompt) return null;
  const firstLine = prompt.split("\n")[0].trim();
  return firstLine.slice(0, 80);
}

/**
 * Pick the most recently active non-done task from a task index.
 * Used by `a cc --continue` (D38).
 * @param {object[]} tasks - Array of { slug, dir, status, updated, ... }
 * @returns {object|null} The best task or null
 */
function pickContinueTask(tasks) {
  if (!tasks || tasks.length === 0) return null;
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
  if (open.length === 0) return null;
  open.sort((a, b) => {
    const aTime = a.updated ? new Date(a.updated).getTime() : 0;
    const bTime = b.updated ? new Date(b.updated).getTime() : 0;
    return bTime - aTime;
  });
  return open[0];
}

/**
 * Check occupancy: find live sessions whose cwd realpath is the main checkout.
 * @param {object[]} sessions - From session.list()
 * @param {string} mainRoot - The repo's main checkout path
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {object[]} Live sessions on the main checkout
 */
function checkOccupancy(sessions, mainRoot, excludeSessionId) {
  const mainReal = fs.realpathSync(mainRoot);
  return sessions.filter((s) => {
    if (excludeSessionId && s.session_id === excludeSessionId) return false;
    if (!require("./session").isLive(s)) return false;
    if (!s.cwd) return false;
    try {
      return fs.realpathSync(s.cwd) === mainReal;
    } catch {
      return false;
    }
  });
}

/**
 * List tasks for a repo from the central root (for --continue).
 * @param {object} repoKeyObj - Result of repoKey()
 * @returns {object[]} Array of { slug, dir, status, tier, updated }
 */
function listTasksForRepo(repoKeyObj) {
  const { tasksRoot } = require("./tasks-root");
  const taskLib = require("./task");
  const root = tasksRoot(repoKeyObj);
  const entries = [];
  if (!fs.existsSync(root)) return entries;
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".") || name === "archive") continue;
    const dir = path.join(root, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!taskLib.isMigrated(dir)) continue;
    const task = taskLib.readTaskJson(dir);
    if (!task) continue;
    entries.push({
      slug: task.slug, dir, status: task.status,
      tier: task.tier || "standard",
      updated: task.updated,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Self-heal (D43)
// ---------------------------------------------------------------------------

/**
 * Sub-second self-heal run at the start of every launch (D43):
 *  1. Prune registry entries whose pid is dead or reused.
 *  2. Trash empty tasks (no phases, no plan, no reports) older than one hour.
 *  3. Quick `a doctor` check (hooks wired, `a` link present).
 * Stops with a clear message only when a repair is impossible.
 * @returns {{ pruned: number, trashed: number, doctorOk: boolean, warning?: string }}
 */
function selfHeal() {
  const sessionLib = require("./session");
  const result = { pruned: 0, trashed: 0, doctorOk: true, warning: null };

  // 1. Prune dead/reused sessions.
  try {
    const prune = sessionLib.pruneLostSessions();
    result.pruned = prune.pruned;
  } catch {}

  // 2. Trash empty tasks older than one hour.
  try {
    result.trashed = trashEmptyTasks();
  } catch {}

  // 3. Quick doctor check (hooks + `a` link).
  try {
    const aLink = path.join(os.homedir(), ".local", "bin", "a");
    if (!fs.existsSync(aLink)) {
      result.doctorOk = false;
      result.warning = "~/.local/bin/a not found — run ./install.sh";
    }
  } catch {}

  return result;
}

function trashEmptyTasks() {
  const { tasksRootBase } = require("./tasks-root");
  const taskLib = require("./task");
  const root = tasksRootBase();
  if (!fs.existsSync(root)) return 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let count = 0;
  for (const keyName of fs.readdirSync(root)) {
    if (keyName.startsWith(".") || keyName === "archive" || keyName === "trash") continue;
    const keyDir = path.join(root, keyName);
    try { if (!fs.statSync(keyDir).isDirectory()) continue; } catch { continue; }
    for (const taskName of fs.readdirSync(keyDir)) {
      if (taskName.startsWith(".")) continue;
      const taskDir = path.join(keyDir, taskName);
      try { if (!fs.statSync(taskDir).isDirectory()) continue; } catch { continue; }
      if (!taskLib.isMigrated(taskDir)) continue;
      const task = taskLib.readTaskJson(taskDir);
      if (!task) continue;
      // Empty: no phases, no plan, no reports.
      const hasPhases = (task.phases || []).length > 0;
      const hasReports = (task.phases || []).some((p) =>
        p.reports && Object.values(p.reports).some((r) => r !== null)
      );
      const hasPlan = (task.phases || []).some((p) => p.plan_path);
      if (hasPhases || hasReports || hasPlan) continue;
      // Older than one hour.
      const updated = task.updated ? new Date(task.updated).getTime() : 0;
      if (updated > oneHourAgo) continue;
      // Move to trash.
      const { trashDir } = require("./trash");
      try {
        trashDir(taskDir, keyName);
        count++;
      } catch {}
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Zmx helpers (D44)
// ---------------------------------------------------------------------------

function zmxAvailable() {
  try {
    execFileSync("zmx", ["--version"], { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function zmxVersionOk() {
  try {
    const out = execFileSync("zmx", ["--version"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
    }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const [, major, minor] = m.map(Number);
    // D44: pin ≥ 0.8.1 (warn that ≤ 0.8.1 replays only part of scrollback).
    return major > 0 || (major === 0 && minor >= 8);
  } catch {
    return false;
  }
}

function zmxList() {
  try {
    const out = execFileSync("zmx", ["list"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Launch orchestration
// ---------------------------------------------------------------------------

/**
 * The main `a cc` launch function.
 *
 * @param {object} opts
 * @param {string} opts.agent - "Conductor" | "Courier" (default: Conductor)
 * @param {string|null} opts.task - Task slug or dir
 * @param {boolean} opts.continueFlag - Pick most recently active non-done task
 * @param {string|null} opts.title - Title for Courier task creation
 * @param {string|null} opts.prompt - Positional prompt (for Courier title + forwarding)
 * @param {boolean} opts.noWorktree - Refuse if occupied instead of worktree
 * @param {boolean} opts.tmux - Use tmux instead of zmx
 * @param {boolean} opts.noAttach - Do not attach
 * @param {string[]} opts.passthrough - Args after `--` to forward to a launch
 * @param {string} [opts.repo] - Repo path (default: cwd)
 * @param {boolean} [opts.json] - JSON output
 * @returns {void}
 */
function launch(opts) {
  const sessionLib = require("./session");
  const { repoKey } = require("./repo");
  const { tasksRoot, ensureMigrated } = require("./tasks-root");

  // 1. Self-heal (D43).
  selfHeal();

  // 2. Resolve repo.
  const repoPath = opts.repo || ".";
  const key = repoKey(repoPath);
  const cwd = path.resolve(key.main_root);

  // 3. Ensure repo is migrated (D35 move-on-first-touch).
  try {
    ensureMigrated(key);
  } catch (err) {
    if (err.refused || err.failClosed) throw err;
  }

  // 4. Determine agent.
  const agent = (opts.agent || "Conductor").toLowerCase();
  const isCourier = agent === "courier";

  // 5. Resolve task.
  let taskDir = null;
  let createdTask = false;
  let promptForward = null;

  if (opts.task) {
    // Explicit --task.
    taskDir = resolveTaskInput(opts.task, key);
  } else if (isCourier) {
    // Courier: needs --task, --title, or a prompt (D38 item 3, D39).
    if (opts.title) {
      // --title given: create a minor task.
      const result = createCourierTask(opts.title, key);
      taskDir = result.task_dir;
      createdTask = true;
    } else if (opts.prompt) {
      // Positional prompt without --title: derive title from first line.
      const title = deriveTitleFromPrompt(opts.prompt);
      if (!title) throw new Error("Courier needs --task, --title or a prompt");
      const result = createCourierTask(title, key);
      taskDir = result.task_dir;
      createdTask = true;
      promptForward = opts.prompt;
    } else {
      throw new Error("Courier needs --task, --title or a prompt");
    }
  } else {
    // Conductor: --task, --continue, or positional slug.
    if (opts.continueFlag) {
      const tasks = listTasksForRepo(key);
      const picked = pickContinueTask(tasks);
      if (!picked) throw new Error("No open tasks for this repo (use --task <slug>)");
      taskDir = picked.dir;
    } else if (opts.positionals && opts.positionals.length > 0) {
      taskDir = resolveTaskInput(opts.positionals[0], key);
    } else {
      // No --task and no --continue: default to --continue (D43 common case).
      const tasks = listTasksForRepo(key);
      const picked = pickContinueTask(tasks);
      if (!picked) throw new Error("No open tasks for this repo (use --task <slug>)");
      taskDir = picked.dir;
    }
  }

  if (taskDir && !path.isAbsolute(taskDir)) {
    taskDir = path.resolve(key.main_root, taskDir);
  }

  // 6. Occupancy check (D38 item 1, D4).
  const sessions = sessionLib.list();
  const excludeId = process.env.CLAUDE_CODE_SESSION_ID || null;
  const occupants = checkOccupancy(sessions, key.main_root, excludeId);

  let worktree = null;
  if (occupants.length > 0) {
    if (opts.noWorktree) {
      const holder = occupants[0];
      throw new Error(
        `Checkout occupied by session ${holder.session_id || holder.terminal_id} ` +
        `(${holder.agent || "unknown"}). Use --worktree or stop that session first.`
      );
    }
    // Run in a task-bound worktree (D38 item 1).
    worktree = path.basename(taskDir);
  }

  // 7. Mint ids and register.
  const terminalId = sessionLib.mintId();
  const sid = sessionLib.mintId();
  const id8 = sid.slice(0, 8);
  const sessionDir = path.join(sessionLib.sessionsRoot(), terminalId);
  const tasksRootPath = tasksRoot(key);

  // Determine mux mode.
  const useZmx = !opts.tmux && zmxAvailable();
  const useTmux = opts.tmux || (!useZmx && tmuxAvailable());
  const muxName = useZmx
    ? `${agent}-${id8}`
    : useTmux
      ? `pav-t-${terminalId}`
      : null;

  sessionLib.register({
    session_id: sid,
    terminal_id: terminalId,
    session_dir: sessionDir,
    origin: "cli",
    initiator: "user",
    agent,
    cwd,
    repo_key: key.key,
    task_dir: taskDir,
    ...(useZmx
      ? { mux: { kind: "zmx", name: muxName } }
      : useTmux
        ? { tmux: { server: "pav", session: muxName } }
        : {}),
  });

  // 8. Build launch command.
  const launchCmd = buildLaunchCommand({
    agent, sessionId: sid, cwd, worktree, tasksRoot: tasksRootPath,
    passthrough: [...(promptForward ? [promptForward] : []), ...opts.passthrough],
  });

  // 9. Launch (zmx / tmux / foreground).
  try {
    if (useZmx) {
      launchZmx(muxName, sessionDir, launchCmd, cwd);
    } else if (useTmux) {
      launchTmux(muxName, sessionDir, launchCmd, cwd);
    } else {
      launchForeground(sessionDir, launchCmd, cwd);
      return; // foreground: launch.exec replaces this process
    }
  } catch (err) {
    // D43 rollback: clean up everything we created.
    rollback({ sessionDir, taskDir, createdTask, muxName, useZmx, useTmux, worktree, key });
    throw err;
  }

  // 10. Output.
  if (opts.json) {
    console.log(JSON.stringify({
      terminal_id: terminalId,
      session_id: sid,
      mux: useZmx ? { kind: "zmx", name: muxName } : { kind: "tmux", name: muxName },
      session_dir: sessionDir,
      task_dir: taskDir,
      worktree: worktree || null,
      add_dir: tasksRootPath,
    }, null, 2));
  } else {
    const muxKind = useZmx ? "zmx" : "tmux";
    console.log(`Session ${muxName} created (${muxKind}, terminal=${terminalId}, session=${sid})`);
    if (taskDir) console.log(`Task: ${path.basename(taskDir)}`);
  }

  // 11. Attach (or print the command).
  if (opts.noAttach) return;

  if (process.env.TMUX && useTmux) {
    // D42: inside tmux, don't nest; print the attach command.
    console.log(`a cc attach ${terminalId}`);
    return;
  }

  if (useZmx) {
    try {
      execSync(`zmx attach ${muxName}`, { stdio: "inherit" });
    } catch {}
  } else if (useTmux) {
    try {
      execSync(`tmux -L pav attach -t ${muxName}`, { stdio: "inherit" });
    } catch {}
  }
}

function resolveTaskInput(input, key) {
  const { tasksRoot } = require("./tasks-root");
  const root = tasksRoot(key);
  if (path.isAbsolute(input)) return input;
  if (/^\d+$/.test(input)) {
    if (fs.existsSync(root)) {
      const padded = input.padStart(3, "0");
      const match = fs.readdirSync(root).find((n) => n.startsWith(padded + "-"));
      if (match) return path.join(root, match);
    }
  }
  if (fs.existsSync(root)) {
    const match = fs.readdirSync(root).find((n) => n.endsWith("-" + input) || n === input);
    if (match) return path.join(root, match);
  }
  return path.join(root, input);
}

function createCourierTask(title, key) {
  const taskLib = require("./task");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return taskLib.createTask({
    repo: key,
    title,
    slug,
    mode: "fast",
    tier: "minor",
    phases: [],
    description: "",
  });
}

function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function launchZmx(name, sessionDir, launchCmd, cwd) {
  // D44: zmx run <name> -d "env AGENTS_SESSION_DIR=<entry> <launch cmd>"
  // The -d flag creates the session detached; the daemon is owned by launchd
  // and survives a terminal tab close.
  const envPrefix = `env AGENTS_SESSION_DIR=${sessionDir}`;
  const fullCmd = `${envPrefix} ${launchCmd.map(shellQuote).join(" ")}`;
  execFileSync("zmx", ["run", name, "-d", fullCmd], {
    cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
  });
}

function launchTmux(name, sessionDir, launchCmd, cwd) {
  // D42/D44: tmux path stays behind --tmux.
  // Quote every element of the launch command before send-keys (D38 live fix:
  // a title containing "(D38, D39)" made zsh print "unknown file attribute: 3").
  execSync(
    `tmux -L pav new-session -d -s ${shellQuote(name)} -c ${shellQuote(cwd)} ` +
    `-e AGENTS_SESSION_DIR=${shellQuote(sessionDir)}`,
    { stdio: "pipe" }
  );
  execSync(
    `tmux -L pav send-keys -t ${shellQuote(name)} ` +
    launchCmd.map((c) => shellQuote(c)).join(" ") + " Enter",
    { stdio: "pipe" }
  );
}

function launchForeground(sessionDir, launchCmd, cwd) {
  // D42: foreground TTY launch (no zmx, no tmux).
  // Export AGENTS_SESSION_DIR and exec a launch.
  process.env.AGENTS_SESSION_DIR = sessionDir;
  const { launch } = require("./launch");
  // Reconstruct launch args from the command array (strip leading "a", "launch").
  const launchArgs = launchCmd.slice(2); // after "a", "launch"
  // Parse out --agent, --session-id, --cwd, --worktree
  let agent = null, sessionId = null, worktree = null, worktreeFlag = null;
  const passthrough = [];
  for (let i = 0; i < launchArgs.length; i++) {
    if (launchArgs[i] === "--agent") agent = launchArgs[++i];
    else if (launchArgs[i] === "--session-id") sessionId = launchArgs[++i];
    else if (launchArgs[i] === "--cwd") { i++; /* skip, use cwd param */ }
    else if (launchArgs[i] === "--worktree") worktreeFlag = launchArgs[++i];
    else if (launchArgs[i] === "--") {
      passthrough.push(...launchArgs.slice(i + 1));
      break;
    } else {
      passthrough.push(launchArgs[i]);
    }
  }
  worktree = worktreeFlag;
  launch({ agent, sessionId, cwd, worktree, args: passthrough });
}

/**
 * D43 rollback: clean up everything a failed launch created.
 * @param {object} opts
 */
function rollback({ sessionDir, taskDir, createdTask, muxName, useZmx, useTmux, worktree, key }) {
  const sessionLib = require("./session");
  // Remove the registry entry.
  try {
    const reg = sessionLib.readRegistration(sessionDir);
    if (reg) {
      reg.ended_at = new Date().toISOString();
      sessionLib.writeRegistration(sessionDir, reg);
    }
  } catch {}
  // Kill the zmx/tmux session.
  if (useZmx && muxName) {
    try { execFileSync("zmx", ["kill", muxName], { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 }); } catch {}
  } else if (useTmux && muxName) {
    try { execSync(`tmux -L pav kill-session -t ${shellQuote(muxName)}`, { stdio: "pipe" }); } catch {}
  }
  // Trash the task we created.
  if (createdTask && taskDir) {
    try {
      const { trashDir } = require("./trash");
      trashDir(taskDir, key.key);
    } catch {}
  }
  // Remove the worktree.
  if (worktree && key) {
    try {
      const wtPath = path.join(path.dirname(key.main_root),
        `${path.basename(key.main_root)}-wt-${worktree}`);
      if (fs.existsSync(wtPath)) {
        require("./worktree").remove({ projectDir: key.main_root, path: wtPath, force: true });
      }
    } catch {}
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  resolveWorktree,
  buildLaunchCommand,
  parseCcArgs,
  deriveTitleFromPrompt,
  pickContinueTask,
  checkOccupancy,
  listTasksForRepo,
  selfHeal,
  trashEmptyTasks,
  zmxAvailable,
  zmxVersionOk,
  zmxList,
  launch,
  rollback,
  shellQuote,
};
