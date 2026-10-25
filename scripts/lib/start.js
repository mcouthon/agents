"use strict";

// Session launch path: the facts about running sessions (zmx names, liveness),
// task lookup, and the `a start`, `a attach` and `a resume` verbs built on them.
//
// A verb takes parsed arguments and `{ ask, cwd }` and returns
// `{ exitCode, json, text }`; a refusal throws an Error carrying `exitCode`
// (1 cancelled, 2 refused, 4 not found).

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

function fail(exitCode, message) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

/**
 * The sessions `zmx list` knows: [{ name, ended }] (ended sessions included,
 * flagged). `null` when zmx is missing or fails: "no zmx facts", which is
 * different from `[]` ("zmx knows no session").
 */
function zmxSessions() {
  let out;
  try {
    out = execFileSync("zmx", ["list"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
  } catch {
    return null;
  }
  const sessions = [];
  for (const line of out.split("\n")) {
    const fields = line.split("\t");
    const nameField = fields.find((f) => f.startsWith("name="));
    if (!nameField) continue;
    sessions.push({ name: nameField.slice(5), ended: fields.some((f) => f.startsWith("ended=")) });
  }
  return sessions;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this registration a running session? Counts its process (the claude pid
 * recorded by a hook) and its zmx session, so a launcher entry stays visible
 * while hooks are off. A registration without `mux` is matched to a zmx
 * session named `<Agent>-<first 8 of the session id>[-rN]`, the name shell
 * launchers use without recording a mux.
 *
 * @param {object} reg - a registration
 * @param {{name: string, ended: boolean}[]|null} zmx - zmxSessions() result
 * @returns {{ live: boolean, zmxName: string|null }}
 */
function liveSession(reg, zmx) {
  if (!reg || reg.ended_at) return { live: false, zmxName: null };
  const names = (zmx || []).filter((z) => !z.ended).map((z) => z.name);
  let zmxName = null;
  if (reg.mux && reg.mux.kind === "zmx" && reg.mux.name) {
    if (names.includes(reg.mux.name)) zmxName = reg.mux.name;
  } else if (!reg.mux && reg.session_id) {
    const re = new RegExp(`-${escapeRegExp(String(reg.session_id).slice(0, 8))}(-r\\d+)?$`);
    zmxName = names.find((n) => re.test(n)) || null;
  }
  const live = require("./session").isLive(reg) || zmxName !== null;
  return { live, zmxName };
}

// The database stores a task's repo key as the relative path under the tasks root, so a
// path-shaped key (a local origin, "/tmp/x/origin") loses its leading slash there.
const storedKey = (k) => String(k).replace(/\/{2,}/g, "/").replace(/^\//, "");

function taskCandidates(key) {
  const db = require("./db");
  if (db.enabled()) {
    return db.listTasks({ disposition: "active" })
      .filter((r) => r.repo_key === storedKey(key.key))
      .map((r) => ({ name: r.dir_name, dir: r.task_dir }));
  }
  const root = require("./tasks-root").tasksRoot(key);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => !n.startsWith(".") && n !== "archive" && n !== "trash")
    .filter((n) => fs.existsSync(path.join(root, n, "task.json")))
    .map((n) => ({ name: n, dir: path.join(root, n) }));
}

/**
 * Find a task of the repo by number, `NNN-slug` or slug. Reads only (no
 * migration). Returns `{ name, dir }` or null; throws an error with
 * `.ambiguous` when a slug names several tasks.
 */
function resolveTask(input, key) {
  if (!input) return null;
  const candidates = taskCandidates(key);
  if (path.isAbsolute(input)) return candidates.find((c) => c.dir === input) || null;
  if (/^\d+$/.test(input)) {
    const padded = input.padStart(3, "0");
    return candidates.find((c) => c.name === padded || c.name.startsWith(padded + "-")) || null;
  }
  const exact = candidates.find((c) => c.name === input);
  if (exact) return exact;
  const exactSlug = candidates.filter((c) => c.name.replace(/^\d+-/, "") === input);
  if (exactSlug.length === 1) return exactSlug[0];
  const bySlug = (exactSlug.length ? exactSlug : candidates).filter((c) => c.name.endsWith("-" + input));
  if (bySlug.length > 1) {
    const err = new Error(`"${input}" names several tasks (${bySlug.map((c) => c.name).join(", ")}); use the number`);
    err.ambiguous = true;
    throw err;
  }
  return bySlug[0] || null;
}

// ---------------------------------------------------------------- arguments

const FLAG_SPECS = {
  start: {
    bool: { "--conductor": "conductor", "--courier": "courier", "--worktree": "worktree", "--here": "here", "--no-attach": "noAttach", "--json": "json" },
    value: { "--title": "title", "--repo": "repo" },
  },
  attach: { bool: {}, value: {} },
  resume: { bool: { "--no-attach": "noAttach", "--json": "json" }, value: {} },
};

/**
 * Parse the arguments of `a start`, `a attach` or `a resume`: one positional
 * (`target`), the verb's own flags, everything after `--` as `passthrough`.
 * Any other flag or a second positional is refused (exit 2).
 */
function parseArgs(argv, verb = "start") {
  const spec = FLAG_SPECS[verb];
  const out = { target: null, title: null, repo: null, conductor: false, courier: false, worktree: false, here: false, noAttach: false, json: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out.passthrough = argv.slice(i + 1); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (spec.value[name]) {
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined) throw fail(2, `${name} needs a value`);
        out[spec.value[name]] = value;
      } else if (spec.bool[name] && eq < 0) {
        out[spec.bool[name]] = true;
      } else {
        throw fail(2, `Unknown flag ${arg} for a ${verb}`);
      }
    } else if (out.target !== null) {
      throw fail(2, `a ${verb} takes one ${verb === "start" ? "task" : "task or session"}, got another: ${arg} (quote a multi-word title)`);
    } else {
      out.target = arg;
    }
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function warn(message) {
  process.stderr.write(message + "\n");
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

const sameDir = (a, b) => Boolean(a && b) && path.resolve(a) === path.resolve(b);
const agentName = (agent) => (agent ? agent[0].toUpperCase() + agent.slice(1) : "Session");
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function readLine() {
  const buf = Buffer.alloc(1);
  let line = "";
  while (fs.readSync(0, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]);
  return line;
}

/** Ask on the terminal; a choice is its number, its name or a unique prefix, empty means the first. */
function defaultAsk(question, choices) {
  if (!choices) {
    process.stderr.write(`${question}: `);
    return readLine().trim();
  }
  process.stderr.write(`${question} [${choices.join("/")}] `);
  const line = readLine().trim();
  if (!line) return choices[0];
  const n = Number(line);
  if (Number.isInteger(n) && choices[n - 1]) return choices[n - 1];
  const hits = choices.filter((c) => c === line || c.startsWith(line));
  return hits.length === 1 ? hits[0] : null;
}

function interaction(deps) {
  const interactive = Boolean(deps.ask) || Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return { interactive, ask: deps.ask || defaultAsk };
}

/** `launch.command` and the absolute `launch.env_file` (relative to the config file's directory); refuses an unreadable env file. */
function launchConfig() {
  const config = require("./config");
  const launch = config.loadConfig().launch || {};
  let envFile = null;
  if (launch.env_file) {
    envFile = path.isAbsolute(launch.env_file) ? launch.env_file : path.resolve(path.dirname(config.agentsConfigPath()), launch.env_file);
    let readable = false;
    try { fs.accessSync(envFile, fs.constants.R_OK); readable = fs.statSync(envFile).isFile(); } catch {}
    if (!readable) throw fail(2, `launch.env_file is not a readable file: ${envFile}`);
  }
  return { command: launch.command || "claude", envFile };
}

function launchLine(sessionDir, argv, envFile) {
  const prefix = envFile ? `set -a && . ${shellQuote(envFile)} && set +a && ` : "";
  return `${prefix}exec env AGENTS_SESSION_DIR=${shellQuote(sessionDir)} ${argv.map(shellQuote).join(" ")}`;
}

/** Every registration with its dir and liveness, newest first. */
function describeEntries(zmx) {
  const session = require("./session");
  return session.entries()
    .map((e) => ({ dir: e.dir, reg: e.registration, ...liveSession(e.registration, zmx) }))
    .sort((a, b) => String(b.reg.created_at || "").localeCompare(String(a.reg.created_at || "")));
}

function repoKeyOf(cwd, repo) {
  try {
    return require("./repo").repoKey(path.resolve(cwd, repo || "."));
  } catch (err) {
    throw fail(2, `Not inside a git repository: ${err.message}`);
  }
}

function fetchBase(key, base) {
  const run = (...args) => spawnSync("git", ["-C", key.main_root, ...args], { encoding: "utf8", timeout: 20000 });
  const fetched = run("fetch", "origin", base);
  if (fetched.error || fetched.status !== 0) {
    const why = (fetched.error ? fetched.error.message : fetched.stderr || "").trim().split("\n").join(" ");
    warn(`warning: could not fetch origin ${base} (${why})`);
    return;
  }
  if (run("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`).status !== 0) return;
  if (run("rev-parse", "--verify", "--quiet", `refs/heads/${base}`).status !== 0) return;
  const behind = Number(run("rev-list", "--count", `${base}..origin/${base}`).stdout.trim());
  if (behind > 0) warn(`local ${base} is ${behind} commits behind origin/${base}`);
}

/** Branch and path `worktree.add` derives for a task dir. */
function deriveWorktree(mainRoot, taskDir) {
  const dirName = path.basename(taskDir);
  const match = dirName.match(/^(\d{3})-(.+)$/);
  const num = match ? match[1] : dirName;
  const slug = match ? match[2] : "task";
  return { branch: `wt/${num}-${slug}`, path: path.resolve(mainRoot, "..", `${path.basename(mainRoot)}-wt-${num}-${slug}`) };
}

function listWorktrees(mainRoot) {
  try {
    const worktree = require("./worktree");
    return worktree.parseWorktrees(mainRoot).map((w) => ({ path: w.path, branch: worktree.shortBranch(w.branch) }));
  } catch {
    return [];
  }
}

function branchExists(mainRoot, branch) {
  return spawnSync("git", ["-C", mainRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

function openTasks(key) {
  const taskLib = require("./task");
  const rows = [];
  for (const c of taskCandidates(key)) {
    const doc = taskLib.readTaskJson(c.dir);
    if (doc && doc.status !== "done") rows.push({ ...c, number: Number.isInteger(doc.number) ? doc.number : 0, title: doc.title });
  }
  return rows.sort((a, b) => b.number - a.number);
}

// ---------------------------------------------------------------- resolution for attach and resume

/** The entry `input` names (a session or a task), live ones first, then newest first. */
function findEntry(input, cwd, { resumable }) {
  if (!input) throw fail(2, `a ${resumable ? "resume" : "attach"} needs a task or a session`);
  const zmx = zmxSessions();
  const descs = describeEntries(zmx);
  const isSession = (r) => r.terminal_id === input || r.session_id === input || (input.length >= 8 && String(r.session_id || "").startsWith(input));
  let matches = descs.filter((d) => isSession(d.reg));
  if (matches.length === 0) {
    let key = null;
    try { key = require("./repo").repoKey(cwd); } catch {}
    if (key) {
      let found = null;
      try {
        found = resolveTask(input, key);
      } catch (err) {
        if (err.ambiguous) throw fail(2, err.message);
        throw err;
      }
      if (found) matches = descs.filter((d) => sameDir(d.reg.task_dir, found.dir));
    }
  }
  if (resumable) matches = matches.filter((d) => d.reg.agent && !d.reg.parent_session_id);
  if (matches.length === 0) throw fail(4, `No session for ${input}`);
  const live = matches.filter((d) => d.live);
  return { entry: (live.length ? live : matches)[0], descs, zmx };
}

function attachText(name) {
  return `zmx attach ${name}`;
}

/** Attach to a zmx session, or just name the command (`printOnly`, or already inside zmx). */
function attachTo(name, printOnly) {
  if (printOnly || process.env.ZMX_SESSION) return { exitCode: 0, json: null, text: attachText(name) };
  spawnSync("zmx", ["attach", name], { stdio: "inherit" });
  return { exitCode: 0, json: null, text: null };
}

function outsideZmx(entry, input) {
  return fail(4, `Session ${input} runs outside zmx (pid ${entry.reg.pid}); switch to its terminal`);
}

/** `a attach <task|session>`: attach to the live zmx session. */
function attach(parsed, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const { entry } = findEntry(parsed.target, cwd, { resumable: false });
  if (entry.live && entry.zmxName) return attachTo(entry.zmxName, false);
  if (entry.live) throw outsideZmx(entry, parsed.target);
  throw fail(4, `No live session for ${parsed.target}; resume it with: a resume ${parsed.target}`);
}

// ---------------------------------------------------------------- start and resume

/** Finish a launch: print the summary line, then attach unless told not to. */
function finish(parsed, summary, name, json) {
  if (parsed.json) return { exitCode: 0, json, text: null };
  if (parsed.noAttach) return { exitCode: 0, json: null, text: summary };
  if (process.env.ZMX_SESSION) return { exitCode: 0, json: null, text: `${summary}\n${attachText(name)}` };
  process.stdout.write(summary + "\n");
  spawnSync("zmx", ["attach", name], { stdio: "inherit" });
  return { exitCode: 0, json: null, text: null };
}

function runZmx(name, line, cwd) {
  const r = spawnSync("zmx", ["run", name, "-d", "sh", "-c", line], { cwd, encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr || "").trim() || `exit ${r.status}`;
    throw fail(1, `zmx run failed: ${why}`);
  }
}

function runForeground(line, cwd) {
  const r = spawnSync("sh", ["-c", line], { cwd, stdio: "inherit" });
  if (r.error) throw fail(1, `could not start claude: ${r.error.message}`);
  return r.status === null ? 1 : r.status;
}

function rollback(state, key) {
  const worktree = require("./worktree");
  const trash = require("./trash");
  const attempt = (what, fn) => { try { fn(); } catch (err) { warn(`rollback: ${what} failed: ${err.message}`); } };
  if (state.sessionDir) attempt("ending the registration", () => require("./session").markEnded(state.sessionDir));
  if (state.createdWorktree) attempt("removing the worktree", () => worktree.remove({ projectDir: key.main_root, path: state.createdWorktree, force: true }));
  if (state.createdTask) {
    attempt("trashing the task", () => trash.trashDir(state.createdTask.task_dir, key.key));
    const files = state.createdTask.files_dir;
    if (files && files !== state.createdTask.task_dir && fs.existsSync(files)) attempt("trashing the task files", () => trash.trashDir(files, key.key));
  }
}

/** Decide which task `a start` works on: `{ existing, pendingTitle }`; creates nothing. */
function chooseTask(parsed, key, io) {
  if (parsed.target && parsed.title) throw fail(2, "give a task or --title, not both");
  if (parsed.target) {
    let existing = null;
    try {
      existing = resolveTask(parsed.target, key);
    } catch (err) {
      if (err.ambiguous) throw fail(2, err.message);
      throw err;
    }
    if (existing) return { existing, pendingTitle: null };
    if (!io.interactive) throw fail(2, `No task ${parsed.target} in ${key.key}; create one with --title "${parsed.target}"`);
    if (io.ask(`No task ${parsed.target} in ${key.key}. Create a task titled "${parsed.target}"?`, ["yes", "no"]) !== "yes") throw fail(1, "Cancelled");
    return { existing: null, pendingTitle: parsed.target };
  }
  if (parsed.title) return { existing: null, pendingTitle: parsed.title };
  if (!io.interactive) throw fail(2, "a start needs a <task> or --title");
  const open = openTasks(key).slice(0, 9);
  const picked = io.ask("Which task?", [...open.map((t) => t.name), "new task"]);
  if (!picked) throw fail(1, "Cancelled");
  if (picked !== "new task") return { existing: open.find((t) => t.name === picked), pendingTitle: null };
  const title = io.ask("Title for the new task", null);
  if (!title) throw fail(1, "Cancelled");
  return { existing: null, pendingTitle: title };
}

/** Refuse or ask when the task already has a live session; returns an attach result when the user chooses to attach. */
function checkRunning(existing, descs, io) {
  const running = descs.find((d) => d.live && sameDir(d.reg.task_dir, existing.dir) && d.reg.session_id !== process.env.CLAUDE_CODE_SESSION_ID);
  if (!running) return null;
  const who = `${agentName(running.reg.agent)} session ${running.zmxName || `pid ${running.reg.pid}`}`;
  const id8 = running.reg.session_id.slice(0, 8);
  if (!io.interactive) throw fail(2, `Task ${existing.name} already has a live ${who}; attach with: a attach ${id8} (or a attach ${existing.name} from inside the repo)`);
  const answer = io.ask(`Task ${existing.name} already has a live ${who}. [a]ttach / [c]ancel`, ["attach", "cancel"]);
  if (answer !== "attach") throw fail(1, "Cancelled");
  if (running.zmxName) return attachTo(running.zmxName, false);
  throw outsideZmx({ reg: running.reg }, id8);
}

/** Does this task run in a worktree? An existing task whose branch is checked out goes there; otherwise the flags, then the occupancy question. */
function chooseWorktree(parsed, key, existing, descs, io) {
  if (existing) {
    const listed = listWorktrees(key.main_root).find((w) => w.branch === deriveWorktree(key.main_root, existing.dir).branch);
    if (listed) return true;
  }
  if (parsed.here) return false;
  const root = realpath(key.main_root);
  const occupants = descs.filter((d) => d.live && d.reg.cwd && realpath(d.reg.cwd) === root && d.reg.session_id !== process.env.CLAUDE_CODE_SESSION_ID);
  if (parsed.worktree) return true;
  if (occupants.length === 0) return false;
  const o = occupants[0].reg;
  const busy = `Checkout ${key.main_root} has a live ${agentName(o.agent)} on ${o.task_dir ? path.basename(o.task_dir) : "no task"}`;
  if (!io.interactive) throw fail(2, `${busy}; pass --worktree to use a worktree or --here to share the checkout`);
  const answer = io.ask(`${busy}. [w]orktree / [h]ere / [c]ancel`, ["worktree", "here", "cancel"]);
  if (answer === "worktree") return true;
  if (answer === "here") return false;
  throw fail(1, "Cancelled");
}

function preflightWorktree(key, existing, io) {
  const target = deriveWorktree(key.main_root, existing.dir);
  const registered = listWorktrees(key.main_root).some((w) => realpath(w.path) === realpath(target.path));
  if (fs.existsSync(target.path) && !registered) throw fail(2, `${target.path} exists but is not a worktree of this repo`);
  const overlaps = require("./worktree").checkManifestOverlap(key.main_root, existing.dir, key.key);
  if (overlaps.length === 0) return;
  const names = overlaps.map((o) => `${o.task} (${o.files.join(", ")})`).join("; ");
  if (!io.interactive) throw fail(2, `Manifest overlap with live tasks: ${names}`);
  if (io.ask(`Manifest overlap with live tasks: ${names}. Continue?`, ["continue", "cancel"]) !== "continue") throw fail(1, "Cancelled");
}

/** Give the task its worktree: reuse, check out a surviving branch, or create it. Returns its path. */
function ensureWorktree(key, taskDir, state) {
  const worktree = require("./worktree");
  const target = deriveWorktree(key.main_root, taskDir);
  const listed = listWorktrees(key.main_root).find((w) => w.branch === target.branch);
  if (listed) return listed.path;
  if (branchExists(key.main_root, target.branch)) {
    execFileSync("git", ["-C", key.main_root, "worktree", "add", target.path, target.branch], { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
    state.createdWorktree = target.path;
    worktree.recordWorktreeInTask(taskDir, target.branch, target.path, key.main_root);
    worktree.linkRepoFiles(key.main_root, target.path);
    return target.path;
  }
  const added = worktree.add({ projectDir: key.main_root, taskDir, force: true });
  state.createdWorktree = added.path;
  return added.path;
}

/**
 * `a start [task | --title T]`: bind a task, register a session and run claude in zmx
 * (or in the foreground without zmx).
 */
function start(parsed, deps = {}) {
  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const session = require("./session");
  const io = interaction(deps);
  const cwd = deps.cwd || process.cwd();
  if (parsed.conductor && parsed.courier) throw fail(2, "--conductor and --courier exclude each other");
  if (parsed.worktree && parsed.here) throw fail(2, "--worktree and --here exclude each other");
  const agent = parsed.courier ? "Courier" : "Conductor";
  const key = repoKeyOf(cwd, parsed.repo);
  const launch = launchConfig();

  fetchBase(key, require("./policy").resolvePolicy(key.main_root).base);

  const { existing, pendingTitle } = chooseTask(parsed, key, io);
  const zmx = zmxSessions();
  const descs = describeEntries(zmx);
  if (existing) {
    const attached = checkRunning(existing, descs, io);
    if (attached) return attached;
  }
  const useWorktree = chooseWorktree(parsed, key, existing, descs, io);
  if (existing && useWorktree) preflightWorktree(key, existing, io);

  const state = { createdTask: null, createdWorktree: null, sessionDir: null };
  let rollbackNeeded = true;
  try {
    let taskDir;
    if (existing) {
      taskDir = existing.dir;
    } else {
      state.createdTask = require("./task").createTask({
        repo: key,
        title: pendingTitle,
        slug: slugify(pendingTitle) || undefined,
        mode: parsed.courier ? "fast" : undefined,
        tier: parsed.courier ? "minor" : undefined,
        phases: [],
        description: "",
      });
      taskDir = state.createdTask.task_dir;
    }

    const runCwd = useWorktree ? ensureWorktree(key, taskDir, state) : key.main_root;
    const sessionId = session.mintId();
    const terminalId = session.mintId();
    const name = zmx !== null ? `${agent}-${sessionId.slice(0, 8)}` : null;
    const registered = session.register({
      session_id: sessionId, terminal_id: terminalId, session_dir: path.join(session.sessionsRoot(), terminalId),
      origin: "cli", initiator: "user", agent, cwd: runCwd, repo_key: key.key, task_dir: taskDir,
      ...(name ? { mux: { kind: "zmx", name } } : {}),
    });
    state.sessionDir = registered.session_dir;

    const argv = [launch.command, "--session-id", sessionId, "--agent", agent, "--add-dir", require("./tasks-root").tasksRootBase(), ...parsed.passthrough];
    const line = launchLine(registered.session_dir, argv, launch.envFile);
    const json = {
      session_id: sessionId, terminal_id: terminalId, session_dir: registered.session_dir, task_dir: taskDir, cwd: runCwd,
      worktree: useWorktree ? runCwd : null, mux: name ? { kind: "zmx", name } : null, attach: name ? attachText(name) : null,
    };
    if (!name) {
      const status = runForeground(line, runCwd);
      rollbackNeeded = false;
      return { exitCode: status, json: parsed.json ? json : null, text: parsed.json ? null : `Session ${sessionId.slice(0, 8)} (${agent}) on ${path.basename(taskDir)} in ${runCwd}` };
    }
    runZmx(name, line, runCwd);
    rollbackNeeded = false;
    return finish(parsed, `Session ${name} (${agent}) on ${path.basename(taskDir)} in ${runCwd}`, name, json);
  } finally {
    if (rollbackNeeded) rollback(state, key);
  }
}

/** The zmx name a resumed session runs under: its base name, or the lowest free `-r<k>`. */
function resumeName(reg, agent, zmx) {
  const base = (reg.mux && reg.mux.name ? reg.mux.name : `${agent}-${String(reg.session_id).slice(0, 8)}`).replace(/-r\d+$/, "");
  const known = new Set((zmx || []).map((z) => z.name));
  if (!known.has(base)) return base;
  let k = 1;
  while (known.has(`${base}-r${k}`)) k++;
  return `${base}-r${k}`;
}

/** `a resume <task|session>`: attach to it when live, else run `claude --resume` in a fresh zmx session. */
function resume(parsed, deps = {}) {
  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const session = require("./session");
  const cwd = deps.cwd || process.cwd();
  const { entry, descs, zmx } = findEntry(parsed.target, cwd, { resumable: true });
  if (entry.live && entry.zmxName) return attachTo(entry.zmxName, parsed.noAttach);
  if (entry.live) throw outsideZmx(entry, parsed.target);

  const sid = entry.reg.session_id;
  const id8 = String(sid).slice(0, 8);
  const twin = descs.find((d) => d.dir !== entry.dir && d.reg.session_id === sid && d.live);
  if (twin) {
    throw fail(4, twin.zmxName
      ? `Session ${id8} is already live in ${twin.dir}; attach with: a attach ${id8}`
      : `Session ${id8} is already live in ${twin.dir} (pid ${twin.reg.pid}, outside zmx); a attach ${id8} cannot reach it, switch to its terminal`);
  }

  const launch = launchConfig();
  const agent = agentName(entry.reg.agent);
  const runCwd = entry.reg.cwd || cwd;
  const argv = [launch.command, "--resume", sid, "--agent", agent, "--add-dir", require("./tasks-root").tasksRootBase(), ...parsed.passthrough];
  const line = launchLine(entry.dir, argv, launch.envFile);
  const summary = (label) => `Session ${label} (${agent}) resumed in ${runCwd}`;
  if (zmx === null) {
    const status = runForeground(line, runCwd);
    return { exitCode: status, json: null, text: summary(id8) };
  }

  const name = resumeName(entry.reg, agent, zmx);
  const regFile = path.join(entry.dir, "registration.json");
  const previous = fs.readFileSync(regFile, "utf8");
  session.register({ session_id: sid, session_dir: entry.dir, mux: { kind: "zmx", name }, pid: null });
  try {
    runZmx(name, line, runCwd);
  } catch (err) {
    fs.writeFileSync(regFile, previous, "utf8");
    const db = require("./db");
    if (db.enabled()) db.upsertSession(path.basename(entry.dir), previous);
    throw err;
  }
  const json = {
    session_id: sid, terminal_id: entry.reg.terminal_id || null, session_dir: entry.dir, task_dir: entry.reg.task_dir || null,
    cwd: runCwd, mux: { kind: "zmx", name }, attach: attachText(name),
  };
  return finish(parsed, summary(name), name, json);
}

module.exports = { zmxSessions, liveSession, resolveTask, parseArgs, start, attach, resume };
