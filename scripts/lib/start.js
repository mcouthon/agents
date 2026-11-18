"use strict";

// Session launch path: the facts about running sessions (zmx names, liveness),
// task lookup, and the `a start` and `a resume` verbs built on them.
//
// A verb takes parsed arguments and `{ ask, cwd }` and returns
// `{ exitCode, json, text }`; a refusal throws an Error carrying `exitCode`
// (1 cancelled, 2 refused, 4 not found).

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { expandShort } = require("./short-flags");
const adapter = require("./adapter").forHarness();
const coe = require("./checkout-env");
const pane = require("./pane");

/** A refusal: `code` and `detail` are what `--json` prints beside the message. */
function fail(exitCode, message, code, detail) {
  const err = new Error(message);
  err.exitCode = exitCode;
  if (code) err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** First-attempt budget: fast-fail when zmx is absent or the machine is responsive. */
const ZMX_LIST_TIMEOUT_MS = 2000;
// 2.5x the first budget: the trivial stub exceeded 2000 ms under check.sh's
// parallel load, so scheduling contention alone breaches it. 5000 ms gives a
// real `zmx list` (socket round-trip plus process spawn) headroom under load.
const ZMX_LIST_RETRY_TIMEOUT_MS = 5000;

function zmxList(timeoutMs) {
  return execFileSync("zmx", ["list"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
}

/**
 * The sessions `zmx list` knows: [{ name, ended }] (ended sessions included,
 * flagged). `null` when zmx is missing or fails: "no zmx facts", which is
 * different from `[]` ("zmx knows no session"). A timeout is neither — zmx is
 * there but slow (the machine is loaded) — so it is retried once at a larger
 * budget, and if it still times out, throws `zmx_timeout` instead of collapsing
 * into `null` (which would send `a start` down the silent foreground branch).
 */
function zmxSessions() {
  // Test knobs (AGENTS_ZMX_LIST_TIMEOUT_MS / ..._RETRY_TIMEOUT_MS) shrink both
  // budgets for a scenario that stubs a never-answering zmx; unset, the
  // production constants above apply — the timed-out-twice ladder never changes.
  const firstMs = parseInt(process.env.AGENTS_ZMX_LIST_TIMEOUT_MS, 10) || ZMX_LIST_TIMEOUT_MS;
  const retryMs = parseInt(process.env.AGENTS_ZMX_LIST_RETRY_TIMEOUT_MS, 10) || ZMX_LIST_RETRY_TIMEOUT_MS;
  let out;
  try {
    out = zmxList(firstMs);
  } catch (err) {
    if (err.code !== "ETIMEDOUT") return null;
    try {
      out = zmxList(retryMs);
    } catch (retryErr) {
      if (retryErr.code !== "ETIMEDOUT") return null;
      throw fail(2,
        "zmx list is slow (timed out twice); the machine may be loaded — retry a start in a moment",
        "zmx_timeout",
        { remedy: "wait for the load to ease and retry; if zmx still won't answer, run `zmx list` by hand or start the agent in this terminal without zmx" });
    }
  }
  const sessions = [];
  for (const line of out.split("\n")) {
    // zmx 0.8.1 indents every line and prefixes the current session's name key
    // with a marker ("→ "), so both the line and each tab-separated field are
    // trimmed and the name key may carry that non-key prefix.
    const fields = line.trim().split("\t").map((f) => f.trim());
    const nameField = fields.find((f) => /^[^=\w]*name=/.test(f));
    if (!nameField) continue;
    sessions.push({ name: nameField.slice(nameField.indexOf("name=") + 5), ended: fields.some((f) => f.startsWith("ended=")) });
  }
  return sessions;
}

/** True when the `zmx` binary is on PATH. The 30 s budget: at width the check
 * pool's own launch wave was observed pushing a healthy zmx's `--version` past
 * 5 s (a false "not installed" row, twice at pools 10 and 14) — 30 s sits far
 * beyond any load tail observed on this machine while a missing zmx still
 * fails instantly (ENOENT), so nothing healthy pays the wait. */
function zmxAvailable() {
  try {
    execFileSync("zmx", ["--version"], { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

/** True when zmx is at least version 0.8.1. */
function zmxVersionOk() {
  try {
    const out = execFileSync("zmx", ["--version"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const [, major, minor] = m.map(Number);
    return major > 0 || (major === 0 && minor >= 8);
  } catch {
    return false;
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this registration a running session? Counts its process (the harness agent pid
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

function taskCandidates(key, opts = {}) {
  const db = require("./db");
  const dispositions = opts.anyDisposition ? ["active", "archived"] : ["active"];
  const out = [];
  for (const disposition of dispositions) {
    for (const r of db.listTasks({ disposition, repoKey: storedKey(key.key) })) out.push({ name: r.dir_name, dir: r.task_dir });
  }
  return out;
}

/**
 * Find a task of the repo by number, `NNN-slug` or slug. Reads only (no
 * migration). Returns `{ name, dir }` or null; throws an error with
 * `.ambiguous` when a slug names several tasks.
 */
function resolveTask(input, key, opts = {}) {
  if (!input) return null;
  const candidates = taskCandidates(key, opts);
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
    bool: { "--conductor": "conductor", "--courier": "courier", "--coordinator": "coordinator", "--worktree": "worktree", "--here": "here", "--no-attach": "noAttach", "--json": "json" },
    value: { "--title": "title", "--repo": "repo" },
    short: { "-t": "--title", "-r": "--repo", "-c": "--conductor", "-k": "--courier", "-o": "--coordinator", "-w": "--worktree", "-e": "--here", "-n": "--no-attach", "-j": "--json" },
  },
  resume: { bool: { "--no-attach": "noAttach", "--json": "json" }, value: {}, short: { "-n": "--no-attach", "-j": "--json" } },
  restart: { bool: { "--no-attach": "noAttach", "--json": "json" }, value: {}, short: { "-n": "--no-attach", "-j": "--json" } },
};

/**
 * Parse the arguments of `a start` or `a resume`: one positional
 * (`target`), the verb's own flags, everything after `--` as `passthrough`.
 * Any other flag or a second positional is refused (exit 2).
 */
function parseArgs(argv, verb = "start") {
  const spec = FLAG_SPECS[verb];
  argv = expandShort(argv, spec.short, new Set(Object.keys(spec.value)), verb);
  const out = { target: null, title: null, repo: null, conductor: false, courier: false, coordinator: false, worktree: false, here: false, noAttach: false, json: false, passthrough: [] };
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
  // Not process.stdin.isTTY: touching process.stdin puts fd 0 in non-blocking mode and readLine's readSync then fails with EAGAIN.
  const tty = require("tty");
  const interactive = Boolean(deps.ask) || (tty.isatty(0) && tty.isatty(1));
  return { interactive, ask: deps.ask || defaultAsk };
}

/** The absolute `launch.env_file` (relative to the config file's directory); refuses an unreadable env file. */
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
  return { envFile };
}

/** The repo's worktree commands: `repos[key] = {setup, teardown}` — a field present
 *  with a value runs, "" opts out, absent means nothing configured. */
function repoCommands(key) {
  const config = require("./config").loadConfig();
  const entry = (config.repos || {})[key.key];
  const commands = entry && typeof entry === "object" ? entry : {};
  return { setup: commands.setup === undefined ? "" : commands.setup, teardown: commands.teardown === undefined ? "" : commands.teardown };
}

/** The worktree setup command for the repo: `repos[key].setup`; "" when nothing is configured. */
function setupCommand(key) {
  return repoCommands(key).setup;
}

/** The worktree teardown command for the repo: `repos[key].teardown`; "" when nothing is configured. */
function teardownCommand(key) {
  return repoCommands(key).teardown;
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

/** A fetch younger than this makes starts local-only: the behind-warning is advisory
 *  (a land re-fetches before landing), so it may be this stale. A constant, not a knob. */
const FETCH_WINDOW_MS = 10 * 60 * 1000;

/** True when the main root's last fetch succeeded inside the window: git rewrites
 *  FETCH_HEAD on every fetch and truncates it to empty when the fetch fails, so
 *  size > 0 means the last one succeeded. Missing, empty, stale or unreadable says fetch. */
function fetchedRecently(mainRoot) {
  try {
    const st = fs.statSync(path.join(mainRoot, ".git", "FETCH_HEAD"));
    return st.size > 0 && Date.now() - st.mtimeMs < FETCH_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Fetch the base ref, throttled to one run per fetch window. Returns how the
 *  fetch went: "fetched" (ran and succeeded), "recent" (skipped — a fetch
 *  succeeded inside the window), or "failed" (ran and failed; one warning —
 *  a worktree start refuses on this, the main path continues as before). */
function fetchBase(key, base) {
  const run = (...args) => spawnSync("git", ["-C", key.main_root, ...args], { encoding: "utf8", timeout: 20000 });
  let state = "recent";
  if (!fetchedRecently(key.main_root)) {
    const fetched = run("fetch", "origin", base);
    if (fetched.error || fetched.status !== 0) {
      const why = (fetched.error ? fetched.error.message : fetched.stderr || "").trim().split("\n").join(" ");
      warn(`warning: could not fetch origin ${base} (${why})`);
      return "failed";
    }
    state = "fetched";
  }
  if (run("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`).status !== 0) return state;
  if (run("rev-parse", "--verify", "--quiet", `refs/heads/${base}`).status !== 0) return state;
  const behind = Number(run("rev-list", "--count", `${base}..origin/${base}`).stdout.trim());
  if (behind > 0) warn(`local ${base} is ${behind} commits behind origin/${base}`);
  return state;
}

/** True when any live session (this caller's own included) runs in the main root. */
function liveInRoot(key, descs) {
  const root = realpath(key.main_root);
  return descs.some((d) => d.live && d.reg.cwd && realpath(d.reg.cwd) === root);
}

/** The gate a start that will run the agent on the main checkout passes first.
 *  A live session there (this caller's own included, unlike the occupancy
 *  question, which excludes it) waives everything: its working state is its
 *  own, and no file may move under it — `--here` beside a session keeps
 *  working, dirt included. Otherwise the tracked tree must be clean
 *  (untracked files never block) — dirt refuses `dirty_tree`, before anything
 *  is created, with `--worktree` the escape; the tasks root is the one
 *  exception, its tree resting dirty (the 15 s heartbeat outpaces the 900 s
 *  snapshot), so the gate commits the engine's own snapshot there — local
 *  only, the push stays the maintenance job's — and a start into the
 *  registry is never refused for dirt. The task's own main-checkout
 *  branch (a pr-policy start cut it, cutTaskBranch) is the side-branch rule's
 *  exception: a start on it continues there — the branch returns to base
 *  through the landed switch like any other. A checkout on any other side
 *  branch switches itself back to base when the branch is fully landed —
 *  merged into the freshly fetched `origin/<base>` tip and its task closed; a
 *  taskless branch needs only the merge — one visible line; a squash-merged
 *  PR leaves no ancestry git can show, and a done or closed task's branch
 *  (wt/ or t/) switches on its landing record alone. A spent t/ branch — the
 *  engine's own, never a human's — is deleted after the switch when git can
 *  prove the merge (a squash leaves the ref behind, inert, like a reaped
 *  worktree's). Anything less refuses `side_branch` naming why. On base, a
 *  behind count fast-forwards on a freshly fetched tip, never the
 *  ≤10-minute-stale ref (a fetch that fails warns once and skips; a diverged
 *  base stays silent — ff-only, no rebase ever). The rule mirrors a land's
 *  post-push fast-forward (land.js). */
function pullBase(key, base, descs, taskBranch = null) {
  const run = (...args) => spawnSync("git", ["-C", key.main_root, ...args], { encoding: "utf8", timeout: 20000 });
  if (liveInRoot(key, descs)) return;
  if (run("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") {
    if (realpath(key.main_root) === realpath(require("./tasks-root").tasksRootBase())) {
      // The tasks root never blocks a start: its tree rests dirty (the 15 s
      // heartbeat outpaces the 900 s snapshot), so the gate runs the engine's
      // own snapshot commit (backup.js — add -A honoring the excludes, the
      // index-lock retry) instead of refusing. Local only: the push stays the
      // maintenance job's, and a start must never wait on the network.
      const iso = new Date().toISOString();
      try {
        require("./backup").commitSnapshot(key.main_root, iso);
      } catch (err) {
        throw fail(2, `Checkout ${key.main_root} (the tasks root) is dirty and its auto-snapshot did not land (${err.message}); free the held lock or run a tasks backup by hand, then start again`, "dirty_tree");
      }
      process.stderr.write(`snapshot committed in ${key.main_root} (${iso})\n`);
    } else {
      throw fail(2, `Checkout ${key.main_root} has uncommitted changes; commit or stash them, or pass --worktree to start in a fresh worktree`, "dirty_tree");
    }
  }
  const branch = run("branch", "--show-current").stdout.trim();
  if (taskBranch && branch === taskBranch) return;
  let fresh = false; // the origin ref was just re-fetched inside this gate
  if (branch !== base) {
    const verdict = sideBranchVerdict(key, base, branch, taskBranch);
    if (verdict.fetchFailed) {
      warn(`warning: could not fetch origin ${base} (${verdict.fetchWhy})`);
      return;
    }
    fresh = verdict.fresh;
    const onDesc = branch || "a detached HEAD";
    if (verdict.why) {
      throw fail(2, `Checkout ${key.main_root} is on ${onDesc}, whose work is not fully landed (${verdict.why}); land or close it, return to ${base} by hand, or pass --worktree`, "side_branch");
    }
    const switched = run("checkout", base);
    if (switched.error || switched.status !== 0) {
      const why = (switched.error ? switched.error.message : switched.stderr || "").trim().split("\n").join(" ");
      throw fail(2, `could not switch ${key.main_root} to ${base}: ${why}`);
    }
    process.stderr.write(`switched to ${base} (${onDesc} is fully landed)\n`);
    const taskMatch = branch.match(/^(?:wt|t)\/(\d{3}-.+)$/);
    if (taskMatch && branch.startsWith("t/")) {
      run("branch", "-d", branch); // best effort: git declines a merge it cannot prove
    }
  }
  const behind = Number(run("rev-list", "--count", `${base}..origin/${base}`).stdout.trim());
  if (behind <= 0) return;
  if (Number(run("rev-list", "--count", `origin/${base}..${base}`).stdout.trim()) > 0) return;
  let count = behind;
  if (!fresh) {
    const fetched = run("fetch", "origin", base);
    if (fetched.error || fetched.status !== 0) {
      const why = (fetched.error ? fetched.error.message : fetched.stderr || "").trim().split("\n").join(" ");
      warn(`warning: could not fetch origin ${base} (${why})`);
      return;
    }
    count = Number(run("rev-list", "--count", `${base}..origin/${base}`).stdout.trim());
    if (count <= 0) return;
  }
  const merged = run("merge", "--ff-only", `origin/${base}`);
  if (merged.error || merged.status !== 0) {
    const why = (merged.error ? merged.error.message : merged.stderr || "").trim().split("\n").join(" ");
    warn(`warning: could not fast-forward ${base} (${why})`);
    return;
  }
  process.stderr.write(`pulled ${base} forward ${count} commits to origin/${base}\n`);
}

/**
 * The side-branch verdict for the main checkout: why the branch it sits on
 * holds work that is not fully landed, or null when the branch is base, the
 * task's own branch, or its work has landed. Read-only — the checkout it
 * names never moves here; the caller that switches is pullBase alone. The
 * origin ref is fetched first (only off base): the switch decision must not
 * read a window-stale ref — a PR merged inside the window would otherwise
 * turn a landed branch into a false refusal. A failed fetch reads "no
 * verdict" (fetchFailed): each caller warns and skips, never refuses — a
 * `--here` start never refuses on a fetch.
 */
function sideBranchVerdict(key, base, branch, taskBranch) {
  if (branch === base) return { fresh: false, why: null };
  if (taskBranch && branch === taskBranch) return { fresh: false, why: null };
  const run = (...args) => spawnSync("git", ["-C", key.main_root, ...args], { encoding: "utf8", timeout: 20000 });
  const fetched = run("fetch", "origin", base);
  if (fetched.error || fetched.status !== 0) {
    const why = (fetched.error ? fetched.error.message : fetched.stderr || "").trim().split("\n").join(" ");
    return { fetchFailed: true, fetchWhy: why, fresh: false, why: null };
  }
  const worktree = require("./worktree");
  const head = branch || "HEAD";
  const taskMatch = branch.match(/^(?:wt|t)\/(\d{3}-.+)$/);
  let why = null;
  if (!worktree.isAncestor(key.main_root, head, `origin/${base}`)) {
    // A squash-merged PR leaves no ancestry git can show: the task's landing
    // record is the truth — a done or closed task's branch is spent either way.
    if (!taskMatch || !["done", "closed"].includes(worktree.taskRemovalState(key.main_root, taskMatch[1]))) {
      why = `it is not merged into origin/${base}`;
    }
  } else if (taskMatch) {
    const state = worktree.taskRemovalState(key.main_root, taskMatch[1]);
    if (state === "done") why = `task ${taskMatch[1]} is done, not closed`;
    else if (state === "open") why = `task ${taskMatch[1]} is not closed`;
  }
  return { fresh: true, why };
}

/** Branch and path `worktree.add` derives for a task dir. */
function deriveWorktree(mainRoot, taskDir) {
  return require("./worktree").taskWorktree({ main_root: mainRoot }, taskDir);
}

/** Give the task's main-checkout work its own branch (t/<NNN-slug>,
 *  worktree.js) before the agent runs, so a pr land has a branch to open from:
 *  cut from base, or check out the surviving branch to continue a task. A live
 *  session sharing the checkout waives the cut (HEAD may not move under it)
 *  with one warning — the work then runs wherever the checkout sits and a land
 *  may refuse `no_branch`. Records the cut on `state` for the rollback. */
function cutTaskBranch(key, base, taskDir, descs, state) {
  const branch = require("./worktree").mainTaskBranch(taskDir);
  if (liveInRoot(key, descs)) {
    warn(`warning: a live session shares the checkout — the task branch ${branch} is not cut; a land may refuse no_branch`);
    return;
  }
  const run = (...args) => spawnSync("git", ["-C", key.main_root, ...args], { encoding: "utf8", timeout: 20000 });
  const current = run("branch", "--show-current").stdout.trim();
  if (current === branch) return;
  if (current !== base) {
    throw fail(2, `Checkout ${key.main_root} is on ${current || "a detached HEAD"}, not ${base}, so the task branch ${branch} is not cut there; return to ${base} by hand, or pass --worktree`, "side_branch");
  }
  const exists = run("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status === 0;
  const switched = run("checkout", ...(exists ? [branch] : ["-b", branch]));
  if (switched.error || switched.status !== 0) {
    const why = (switched.error ? switched.error.message : switched.stderr || "").trim().split("\n").join(" ");
    throw fail(2, `could not ${exists ? "check out" : "cut"} the task branch ${branch} in ${key.main_root}: ${why}`, "branch_cut_failed",
      { remedy: `cut it by hand (git checkout -b ${branch}), then start again` });
  }
  state.branchCut = { branch, base, created: !exists };
  process.stderr.write(`${exists ? "checked out" : "cut"} task branch ${branch} in ${key.main_root}\n`);
}

function listWorktrees(mainRoot) {
  try {
    const worktree = require("./worktree");
    return worktree.parseWorktrees(mainRoot).map((w) => ({ path: w.path, branch: worktree.shortBranch(w.branch) }));
  } catch {
    return [];
  }
}

function openTasks(key) {
  const db = require("./db");
  const taskLib = require("./task");
  const derive = require("./derive");
  const rows = [];
  for (const c of taskCandidates(key)) {
    const row = db.getTask(db.taskIdOf(c.dir));
    if (!row) continue;
    const doc = taskLib.readTaskJson(c.dir);
    if (derive.taskStatusOf(row, doc) === "done") continue;
    rows.push({ ...c, number: Number.isInteger(doc.number) ? doc.number : 0, title: doc.title });
  }
  return rows.sort((a, b) => b.number - a.number);
}

// ---------------------------------------------------------------- resolution for resume

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
      if (found) matches = descs.filter((d) => d.reg.origin !== "dispatch" && sameDir(d.reg.task_dir, found.dir));
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

function runZmx(name, scriptPath, cwd) {
  // zmx run types the line into the pane's login shell and appends its completion marker to the
  // same input line (`...; echo ZMX_TASK_COMPLETED:<id>:$?`). `exec` replaces that shell with the
  // agent process, so the session ends when the agent ends instead of leaving an empty shell — and
  // the marker after the `;` never runs, which is fine: nothing here may `zmx wait` on these.
  const r = spawnSync("zmx", ["run", name, "-d", "exec", "sh", scriptPath], { cwd, encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr || "").trim() || `exit ${r.status}`;
    throw fail(1, `zmx run failed: ${why}`, "spawn_failed");
  }
}

/**
 * The one wait that survives the concurrent setup: build the session's launch
 * env, and while a bootstrap is pending keep retrying once a second —
 * re-resolving the state each round — until the eval is green AND carries the
 * venv fingerprint (`venvFingerprint`, the variable names the main
 * checkout's .envrc yields): a bare `source <venv>/activate` evaluates green
 * without the venv, so a green eval alone cannot prove the venv exists.
 * Stops when the vars appear, when the state leaves pending (a failed
 * bootstrap whose env never went green refuses `setup_failed` with the
 * record's tail and pane; one that completes without the vars opens the
 * session as-is — the probe extends the wait, it never adds a refusal; an
 * eval that still fails rethrows the original `envrc_failed` — no masking),
 * or at the cap (`AGENTS_SETUP_TIMEOUT_MS` + 5 s slack; the runner's own
 * timeout bounds the honest case). A fingerprinted var present, wherever it
 * resolves, never waits — outside the worktree is assertWorktreeVenv's
 * refusal, not this probe's.
 */
function launchEnv(runCwd, envFile, venvFingerprint = []) {
  const tryEnv = () => coe.sessionEnv({ cwd: runCwd, launcherEnv: process.env, envFile });
  const wants = Array.isArray(venvFingerprint) ? venvFingerprint.filter(Boolean) : [];
  const venvPresent = (env) => wants.some((name) => env && name in env && env[name]);
  let green = null;    // a green eval in hand (a venvless one may wait below)
  let envrcErr = null; // the original envrc_failed, rethrown when nothing is pending to wait on
  try {
    green = tryEnv();
  } catch (err) {
    if (err.code !== "envrc_failed") throw err;
    envrcErr = err;
  }
  if (green && (wants.length === 0 || venvPresent(green))) return green;
  const setupLib = require("./setup");
  let st = setupLib.resolve(runCwd, {});
  if (st.state !== "pending") {
    if (envrcErr) throw envrcErr;
    return green; // green and venvless, but no bootstrap pending — open as-is
  }
  const paneBit = st.pane ? ` in ${st.pane}` : "";
  warn(`worktree setup: bootstrap running${paneBit} — waiting for the worktree's environment`);
  const knobMs = setupLib.timeoutMs();
  const capMs = knobMs + 5000;
  const deadline = Date.now() + capMs;
  for (;;) {
    execFileSync("/bin/sleep", ["1"]);
    try {
      const again = tryEnv();
      if (wants.length === 0 || venvPresent(again)) return again;
      green = again; // green but venvless: hold it for the leave-pending return
    } catch (again) {
      if (again.code !== "envrc_failed") throw again;
    }
    st = setupLib.resolve(runCwd, {});
    if (st.state !== "pending") {
      if (green) return green; // the state left pending with the vars absent — open as-is
      if (st.state === "failed") {
        const where = st.pane ? ` (pane ${st.pane})` : "";
        const why = st.tail || st.error || "";
        throw fail(2, `setup command failed in ${runCwd}${where}:\n${why}`, "setup_failed",
          {
            remedy: `fix it by hand in \`${runCwd}\`, then \`a setup run ${runCwd}\` (or \`a start\` again)`,
            exit_code: st.exit_code, pane: st.pane,
          });
      }
      throw envrcErr; // completed, but the eval still fails — the original refusal, no masking
    }
    if (Date.now() >= deadline) {
      const secs = Math.round(capMs / 1000);
      const where = st.pane ? ` (still running in pane ${st.pane})` : "";
      throw fail(2, `worktree setup did not finish within ${secs}s${where}`, "setup_failed",
        {
          remedy: `the bootstrap is still running${st.pane ? ` in ${st.pane}` : ""}; wait for it (\`a setup wait ${runCwd}\`), then \`a start\` again`,
        });
    }
  }
}

function runForeground(line, cwd) {
  const r = spawnSync("sh", ["-c", line], { cwd, stdio: "inherit" });
  if (r.error) throw fail(1, `could not start the agent: ${r.error.message}`);
  return r.status === null ? 1 : r.status;
}

/** Remove launch.sh and launch.env-names from the script's directory (best effort). */
function removeLaunchFiles(scriptPath) {
  if (!scriptPath) return;
  const dir = path.dirname(scriptPath);
  for (const f of ["launch.sh", "launch.env-names"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { warn(`removing ${f} failed: ${e.message}`); } }
  }
}

function rollback(state, key) {
  const worktree = require("./worktree");
  const trash = require("./trash");
  const attempt = (what, fn) => { try { fn(); } catch (err) { warn(`rollback: ${what} failed: ${err.message}`); } };
  if (state.branchCut) attempt(`returning the checkout to ${state.branchCut.base}`, () => {
    spawnSync("git", ["-C", key.main_root, "checkout", state.branchCut.base], { timeout: 20000 });
    if (state.branchCut.created) spawnSync("git", ["-C", key.main_root, "branch", "-D", state.branchCut.branch], { timeout: 20000 });
  });
  if (state.sessionDir) attempt("ending the registration", () => require("./session").markEnded(state.sessionDir));
  if (state.sessionDir) attempt("removing launch files", () => removeLaunchFiles(path.join(state.sessionDir, "launch.sh")));
  // Before the force remove: stop the bootstrap's pane (DELETE the PAV
  // terminal, or kill the own zmx session) so no bootstrap ever writes into a
  // removed tree — its exec'd runner goes down with the pane.
  if (state.setup) attempt("stopping the setup pane", () => require("./setup").stopPane(state.setup));
  if (state.createdWorktree) attempt("removing the worktree", () => worktree.remove({ projectDir: key.main_root, path: state.createdWorktree, force: true, reason: "a start's failure rollback" }));
  if (state.createdTask) attempt("trashing the task", () => trash.trashDir(state.createdTask.task_dir, key.key));
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
  const running = descs.find((d) => d.live && d.reg.origin !== "dispatch" && sameDir(d.reg.task_dir, existing.dir) && d.reg.session_id !== adapter.ownSessionId());
  if (!running) return null;
  const who = `${agentName(running.reg.agent)} session ${running.zmxName || `pid ${running.reg.pid}`}`;
  const id8 = running.reg.session_id.slice(0, 8);
  if (!io.interactive) throw fail(2, `Task ${existing.name} already has a live ${who}; resume it with: a resume ${id8} (or a resume ${existing.name} from inside the repo)`);
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
  const occupants = descs.filter((d) => d.live && d.reg.cwd && realpath(d.reg.cwd) === root && d.reg.session_id !== adapter.ownSessionId());
  if (parsed.worktree) return true;
  if (occupants.length === 0) return false;
  const o = occupants[0].reg;
  const busy = `Checkout ${key.main_root} has a live ${agentName(o.agent)} on ${o.task_dir ? path.basename(o.task_dir) : "no task"}`;
  if (!io.interactive) {
    throw fail(2, `${busy}; pass --worktree to use a worktree or --here to share the checkout`, "checkout_busy",
      { main_root: key.main_root, occupant: { session_id: o.session_id, agent: o.agent, task_dir: o.task_dir || null } });
  }
  const answer = io.ask(`${busy}. [w]orktree / [h]ere / [c]ancel`, ["worktree", "here", "cancel"]);
  if (answer === "worktree") return true;
  if (answer === "here") return false;
  throw fail(1, "Cancelled");
}

function preflightWorktree(key, existing, io) {
  const target = deriveWorktree(key.main_root, existing.dir);
  const registered = listWorktrees(key.main_root).some((w) => realpath(w.path) === realpath(target.path));
  if (fs.existsSync(target.path) && !registered) throw fail(2, `${target.path} exists but is not a worktree of this repo`);
}

/**
 * Give the task its worktree: reuse, check out a surviving branch, or create it —
 * through the one creation path. Reuse re-copies untracked `.env*` files lost since
 * creation (a worktree rebuilt outside the engine stays env-less otherwise).
 * Returns its path.
 */
function ensureWorktree(key, taskDir, state, live) {
  const worktree = require("./worktree");
  const target = deriveWorktree(key.main_root, taskDir);
  const listed = listWorktrees(key.main_root).find((w) => w.branch === target.branch);
  if (!listed) {
    try {
      const result = worktree.sweepStale(key.main_root, live);
      state.swept = result.swept;
      state.held = result.held;
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
    } catch (err) {
      process.stderr.write(`warning: sweep failed: ${err.message}\n`);
      state.swept = [];
    }
  }
  const ensured = worktree.ensureTaskWorktree({ projectDir: key.main_root, taskDir });
  if (ensured.state !== "reused") state.createdWorktree = ensured.path;
  if (ensured.env_copies.length > 0) {
    process.stderr.write(`worktree env: copied ${ensured.env_copies.join(", ")} into ${ensured.path}\n`);
  }
  return ensured.path;
}

/**
 * `a start [task | --title T]`: bind a task, register a session and run the agent in zmx
 * (or in the foreground without zmx).
 */
/** One intent event for a session verb that started or resumed a session (task id when bound). */
function appendSessionEvent(kind, { taskDir, sessionId, repoKey }) {
  const db = require("./db");
  const taskId = taskDir ? db.taskIdOf(taskDir) : null;
  db.appendEvent({
    kind, repoKey, taskId: taskId === null ? undefined : taskId, sessionId,
    detail: JSON.stringify({ session_id: sessionId, task_dir: taskDir || null }),
  });
}

function start(parsed, deps = {}) {
  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const session = require("./session");
  const io = interaction(deps);
  const cwd = deps.cwd || process.cwd();
  if ((parsed.conductor ? 1 : 0) + (parsed.courier ? 1 : 0) + (parsed.coordinator ? 1 : 0) > 1) {
    throw fail(2, "pick one of --conductor, --courier or --coordinator");
  }
  if (parsed.worktree && parsed.here) throw fail(2, "--worktree and --here exclude each other");
  const agent = parsed.courier ? "Courier" : parsed.coordinator ? "Coordinator" : "Conductor";
  const key = repoKeyOf(cwd, parsed.repo);
  const launch = launchConfig();

  const policy = require("./policy").resolvePolicy(key.main_root);
  const base = policy.base;
  const fetched = fetchBase(key, base);

  const { existing, pendingTitle } = chooseTask(parsed, key, io);
  const zmx = zmxSessions();
  if (zmx === null && parsed.json) {
    throw fail(2, "zmx is not available (zmx list failed); a start --json needs zmx, or run a start without --json to run the agent in this terminal", "zmx_unavailable");
  }
  const descs = describeEntries(zmx);
  // The create path hands the sweep these live registrations instead of re-walking the
  // registry (sweepStale would redo what describeEntries just did two frames up).
  const live = descs.filter((d) => d.live && d.reg.cwd).map((d) => d.reg);
  if (existing) {
    const attached = checkRunning(existing, descs, io);
    if (attached) return attached;
  }
  const useWorktree = chooseWorktree(parsed, key, existing, descs, io);
  // A worktree start cuts its branch from origin/<base>, so a fetch that ran
  // and failed refuses before anything is created; a window skip is a recent
  // success and never blocks.
  if (useWorktree) {
    if (fetched === "failed") {
      throw fail(2, `could not fetch origin ${base} from ${key.main_root}: the fetch failed; a worktree start cuts its branch from origin/${base} — fix the remote or the network, then start again`, "fetch_failed");
    }
  } else {
    pullBase(key, base, descs, existing ? require("./worktree").mainTaskBranch(existing.dir) : null);
  }
  if (existing && useWorktree) preflightWorktree(key, existing, io);

  const state = { createdTask: null, createdWorktree: null, sessionDir: null, swept: [], setup: null, branchCut: null };
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

    const runCwd = useWorktree ? ensureWorktree(key, taskDir, state, live) : key.main_root;

    // A pr-policy repo lands through a PR, so the task's main-checkout work
    // needs its own branch — cut it before the agent runs (a worktree start
    // already runs on wt/<NNN-slug>; direct and unlisted repos work on base).
    if (!useWorktree && policy.push === "pr") cutTaskBranch(key, base, taskDir, descs, state);

    // The venv fingerprint from the main checkout's .envrc — what the env
    // probe waits for while the bootstrap is pending.
    let venvFingerprint = [];
    if (useWorktree) {
      venvFingerprint = coe.ensureWorktreeEnvrc(key.main_root, runCwd);
    }

    // The ids mint before the setup launch: the setup pane is named off the session id.
    const sessionId = session.mintId();
    const terminalId = session.mintId();
    const name = zmx !== null ? `${agent}-${sessionId.slice(0, 8)}` : null;

    // The concurrent setup: resolve the record, then adopt a live bootstrap
    // (its pane's lifecycle belongs to the start that launched it —
    // state.setup, the rollback's kill handle, stays null) or launch one —
    // always in the engine's own Setup-<id8> zmx session, verified by the
    // belt; in-process, blocking and streaming, when zmx is absent or the
    // launch's own spawn fails. A launch that does not take never fails the
    // start: the record says failed, the warn says so, and the probe keeps
    // its semantics.
    let setupConfigured = null;
    if (useWorktree) {
      const { setup: cmd, teardown } = repoCommands(key);
      if (cmd && !teardown) {
        warn(`warning: ${key.key} has a worktree setup command but no teardown; add repos["${key.key}"].teardown in ~/.agents/config.json`);
      }
      if (cmd) {
        setupConfigured = cmd;
        const setupLib = require("./setup");
        const resolved = setupLib.resolve(runCwd, { zmx });
        if (resolved.state === "pending") {
          if (resolved.pane) warn(`worktree setup: already running in ${resolved.pane} (zmx attach ${resolved.pane})`);
        } else if (resolved.state !== "complete") {
          const runInProcess = () => {
            const out = setupLib.run(runCwd);
            if (out.state !== "complete") {
              const why = out.tail || out.error || "";
              throw fail(2, `setup command failed in ${runCwd}:\n${why}`, "setup_failed",
                { remedy: `fix it by hand in \`${runCwd}\`, then \`a start\` again` });
            }
          };
          if (zmx === null) {
            runInProcess();
          } else {
            const pane = `Setup-${sessionId.slice(0, 8)}`;
            setupLib.begin(runCwd, { command: cmd, paneKind: "zmx", pane });
            const launch = setupLib.launchZmxSession(runCwd, { pane });
            if (launch.launched) {
              // The pid landed — the pane is really hosting the bootstrap. A
              // bootstrap that already finished inside the belt has nothing
              // to kill and no line: nothing is running.
              if (launch.live) {
                state.setup = { kind: "zmx", pane };
                warn(`worktree setup: running in ${pane} (zmx attach ${pane})`);
              }
            } else if (launch.why === "spawn") {
              warn(`worktree setup: could not launch the zmx session (${launch.detail}); running the bootstrap in this terminal`);
              runInProcess();
            } else {
              warn(`worktree setup: the launch did not take — the bootstrap is not running; retry with a start, or run it by hand: a setup run ${runCwd}`);
            }
          }
        }
      }
    }

    const E1 = launchEnv(runCwd, launch.envFile, venvFingerprint);

    if (useWorktree) {
      coe.assertWorktreeVenv(E1, runCwd);
    }

    const registered = session.register({
      session_id: sessionId, terminal_id: terminalId, session_dir: path.join(session.sessionsRoot(), terminalId),
      origin: "cli", initiator: "user", agent, cwd: runCwd, repo_key: key.key, task_dir: taskDir,
      ...(name ? { mux: { kind: "zmx", name } } : {}),
      ...(parsed.previousSessionId ? { previous_session_id: parsed.previousSessionId } : {}),
    });
    state.sessionDir = registered.session_dir;
    appendSessionEvent("start", { taskDir, sessionId, repoKey: key.key });

    const argv = adapter.launch({ agent, sessionId, passthrough: parsed.passthrough });
    const { scriptPath, line } = coe.writeLaunchScript(registered.session_dir, E1, argv);
    // The setup state at return time, resolved against a fresh zmx list (the
    // start's own snapshot predates the Setup session's creation): setup_mux
    // names the hosting session only while it is listed and not ended — the
    // field a PAV-side pane task attaches through — and the summary bit
    // derives from the same fact, so the two never disagree. A zmx timeout
    // here degrades to no facts rather than failing a healthy start.
    let setupJson = null;
    let setupMux = null;
    if (setupConfigured) {
      let zmxNow = null;
      try { zmxNow = zmxSessions(); } catch { zmxNow = null; }
      const st = require("./setup").resolve(runCwd, { zmx: zmxNow });
      setupJson = {
        state: st.state, marker: st.marker, log: st.log,
        ...(st.pane ? { pane_kind: st.pane_kind, pane: st.pane } : {}),
      };
      if (st.state === "pending" && st.pane && zmxNow && zmxNow.some((z) => z.name === st.pane && !z.ended)) {
        setupMux = { kind: "zmx", name: st.pane };
      }
    }
    const json = {
      session_id: sessionId, terminal_id: terminalId, session_dir: registered.session_dir, task_dir: taskDir, cwd: runCwd,
      worktree: useWorktree ? runCwd : null, mux: name ? { kind: "zmx", name } : null, attach: name ? attachText(name) : null,
      swept: state.swept || [],
      held: state.held || [],
      ...(setupJson ? { setup: setupJson } : {}),
      setup_mux: setupMux,
    };
    const setupBit = setupMux ? `; setup in ${setupMux.name}` : "";
    if (!name) {
      const status = runForeground(line, runCwd);
      rollbackNeeded = false;
      return { exitCode: status, json: parsed.json ? json : null, text: parsed.json ? null : `Session ${sessionId.slice(0, 8)} (${agent}) on ${path.basename(taskDir)} in ${runCwd}${setupBit}` };
    }
    runZmx(name, scriptPath, runCwd);
    rollbackNeeded = false;
    if (agent === "Coordinator") kickFreshPane(name); // the seat's first move, submitted by the launcher itself
    return finish(parsed, `Session ${name} (${agent}) on ${path.basename(taskDir)} in ${runCwd}${setupBit}`, name, json);
  } catch (err) {
    if (rollbackNeeded) {
      err.detail = { ...err.detail, rolled_back: {
        task_dir: state.createdTask ? state.createdTask.task_dir : null,
        worktree: state.createdWorktree,
        session_dir: state.sessionDir,
      } };
    }
    throw err;
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

/** `a resume <task|session>`: attach to it when live, else run the agent's resume in a fresh zmx session. */
function resume(parsed, deps = {}) {
  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const cwd = deps.cwd || process.cwd();
  const { entry, descs, zmx } = findEntry(parsed.target, cwd, { resumable: true });
  if (entry.live && entry.zmxName) {
    if (!parsed.json) return attachTo(entry.zmxName, parsed.noAttach);
    const r = entry.reg;
    return { exitCode: 0, text: null, json: {
      session_id: r.session_id, terminal_id: r.terminal_id, session_dir: entry.dir, task_dir: r.task_dir || null, cwd: r.cwd || null,
      mux: { kind: "zmx", name: entry.zmxName }, attach: attachText(entry.zmxName), already_live: true,
    } };
  }
  if (entry.live) throw outsideZmx(entry, parsed.target);

  const sid = entry.reg.session_id;
  const id8 = String(sid).slice(0, 8);
  const twin = descs.find((d) => d.dir !== entry.dir && d.reg.session_id === sid && d.live);
  if (twin) {
    throw fail(4, twin.zmxName
      ? `Session ${id8} is already live in ${twin.dir}; resume it with: a resume ${id8}`
      : `Session ${id8} is already live in ${twin.dir} (pid ${twin.reg.pid}, outside zmx); a resume ${id8} cannot reach it, switch to its terminal`);
  }

  return resumeLaunch(entry, { parsed, cwd, envFile: launchConfig().envFile, zmx });
}

/**
 * The ended session's relaunch both resume verbs share — `a resume`'s whole
 * leg once its target is proven ended, and `a restart`'s re-entry when the
 * old conversation's transcript ended clean: the recorded cwd must exist
 * (the resume path's own refusal), no transcript means the session never had
 * a turn (the failed-resume rule — a restart never reaches it, its tail
 * check routes the shape to the cold start), then the env build (a worktree's
 * .envrc heal included) and the launch — foreground without zmx, else the
 * same-id registration under the resumed pane name with the byte-restore
 * rollback. A Coordinator entry kicks the seat's first move on the way out —
 * never fatal to the launch it follows.
 */
function resumeLaunch(entry, { parsed, cwd, envFile, zmx }) {
  const session = require("./session");
  const sid = entry.reg.session_id;
  const id8 = String(sid).slice(0, 8);
  const agent = agentName(entry.reg.agent);
  const runCwd = entry.reg.cwd || cwd;

  if (!fs.existsSync(runCwd)) {
    throw fail(2, `the recorded working directory no longer exists: ${runCwd}`, "cwd_missing",
      { remedy: "start fresh with `a start <task>`" });
  }

  // The failed-resume rule: refuse when no transcript exists (the session never
  // had a turn). The registration is left exactly as it was; nothing is deleted.
  const regTranscript = entry.reg.transcript_path;
  if (!regTranscript || !fs.existsSync(regTranscript)) {
    const computed = adapter.transcript({ sessionId: sid, cwd: runCwd });
    if (!computed || !fs.existsSync(computed)) {
      throw fail(4,
        `session ${id8} never had a turn — no transcript exists`,
        "no_transcript",
        { remedy: `start it fresh with \`a start <task>\` — or \`a start --title <title>\` when it had no task; the id and any transcript are kept` }
      );
    }
  }

  let isWorktree = false;
  let mainRoot = null;
  try {
    const key = require("./repo").repoKey(runCwd);
    mainRoot = key.main_root;
    isWorktree = realpath(runCwd) !== realpath(mainRoot);
  } catch {}

  let venvFingerprint = [];
  if (isWorktree && mainRoot) {
    const copied = require("./worktree").copyEnvFiles(mainRoot, runCwd);
    if (copied.length > 0) process.stderr.write(`worktree env: copied ${copied.join(", ")} into ${runCwd}\n`);
    venvFingerprint = coe.ensureWorktreeEnvrc(mainRoot, runCwd);
  }

  const E1 = launchEnv(runCwd, envFile, venvFingerprint);

  if (isWorktree) {
    coe.assertWorktreeVenv(E1, runCwd);
  }

  const argv = adapter.resume(sid, { agent, passthrough: parsed.passthrough });
  const summary = (label) => `Session ${label} (${agent}) resumed in ${runCwd}`;
  if (zmx === null) {
    const knownPath = path.join(entry.dir, "launch.sh");
    try {
      const { scriptPath, line } = coe.writeLaunchScript(entry.dir, E1, argv);
      const status = runForeground(line, runCwd);
      appendSessionEvent("resume", { taskDir: entry.reg.task_dir || null, sessionId: sid, repoKey: entry.reg.repo_key });
      return { exitCode: status, json: null, text: summary(id8) };
    } catch (err) {
      removeLaunchFiles(knownPath);
      throw err;
    }
  }

  const name = resumeName(entry.reg, agent, zmx);
  const regFile = path.join(entry.dir, "registration.json");
  const previous = fs.readFileSync(regFile, "utf8");
  session.register({ session_id: sid, session_dir: entry.dir, mux: { kind: "zmx", name }, pid: null });
  const knownPath = path.join(entry.dir, "launch.sh");
  try {
    const written = coe.writeLaunchScript(entry.dir, E1, argv);
    runZmx(name, written.scriptPath, runCwd);
  } catch (err) {
    removeLaunchFiles(knownPath);
    fs.writeFileSync(regFile, previous, "utf8");
    require("./db").upsertSession(path.basename(entry.dir), previous);
    throw err;
  }
  appendSessionEvent("resume", { taskDir: entry.reg.task_dir || null, sessionId: sid, repoKey: entry.reg.repo_key });
  if (agent === "Coordinator") kickFreshPane(name);
  const json = {
    session_id: sid, terminal_id: entry.reg.terminal_id || null, session_dir: entry.dir, task_dir: entry.reg.task_dir || null,
    cwd: runCwd, mux: { kind: "zmx", name }, attach: attachText(name),
  };
  return finish(parsed, summary(name), name, json);
}

// The exit poll's step, the same cadence pane-send's verify loop keeps.
const RESTART_POLL_STEP_SECS = "0.25";

// The one-line hand-off ask a renewal sends its live seat before anything is
// ended: the seat's own records duty (the coordinator template's) does the
// writing — a single line, one pane-send chunk, never slash-leading (pane-send
// refuses /clear-likes always).
const FLUSH_TEXT = "A renewal is replacing this seat: write your working context and hand-off to your task's records now, then end your turn.";

// The initiation kick's one line: the fresh seat's first move, leaning on the
// coordinator template's own Spawn section ("Re-derive, then arm") rather
// than teaching anything new — one pane-send chunk, never slash-leading.
const KICK_TEXT = "Take up your post: re-derive your world from the roster and your records, arm your poll, and end your turn on the one thing waiting on the owner.";

/**
 * Kick a freshly launched Coordinator seat into its first move, so a renewed
 * coordinator works unattended instead of sitting idle waiting for a first
 * message: wait for the pane's input box (the harness renders it seconds
 * after the pane spawns, a resumed conversation's history load longer), then
 * submit KICK_TEXT through pane-send — text plus the Enter, the one shared
 * send path. Never fatal and never retried: a refused kick names a shape
 * pane-send's floor refuses, and a blind second send is exactly what that
 * floor exists to prevent; whether the seat actually works is the watcher's
 * token check to decide.
 */
function kickFreshPane(name) {
  const readyMs = parseInt(process.env.AGENTS_KICK_READY_MS, 10) || 60000;
  const deadline = Date.now() + readyMs;
  for (;;) {
    let ready = false;
    try {
      const vt = pane.paneVtLines(name);
      const input = pane.inputLineOf(vt);
      ready = input !== null && input.empty && !pane.promptPresent(vt.map(pane.stripEscapes));
    } catch { /* the pane not yet in zmx — retried inside the budget */ }
    if (ready) break;
    if (Date.now() >= deadline) {
      warn(`kick: ${name} showed no empty input box within ${Math.round(readyMs / 1000)}s; the seat starts un-kicked`);
      return;
    }
    execFileSync("/bin/sleep", [RESTART_POLL_STEP_SECS]);
  }
  const verifySecs = parseInt(process.env.AGENTS_KICK_VERIFY_SECS, 10) || 10;
  const kicked = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "bin", "pane-send"), "send", name, KICK_TEXT,
    "--verify-secs", String(verifySecs),
  ], { encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }); // belt: pane-send's own waits are knobbed under this
  if (kicked.status === 0) {
    warn(`kick: the first move was submitted to ${name} and verified in its transcript`);
  } else if (kicked.status === 1) {
    warn(`kick: the first move was sent to ${name} but not verified within ${verifySecs}s — the watcher's token check decides`);
  } else {
    const why = String(kicked.stderr || "").split("\n").find((l) => l.trim());
    warn(`kick: pane-send refused the first move to ${name} (${why ? why.trim() : "no reason given"}); the seat starts un-kicked`);
  }
}

/**
 * `a restart <task|session>`: end a live Coordinator cleanly and start a fresh
 * one on the same task. The refusal classes the fresh start can hit that are
 * checkable without side effects — a closed task, an unlanded side branch, a
 * worktree's failed fetch — run before anything is ended, so a refusing
 * restart leaves the old seat live. The end flow asks a live seat to flush
 * its working context to the task records first (pane-send, a bounded wait),
 * then: /exit, a poll for the recorded end (the hook's, the pane's, or the
 * pid's), a zmx kill after the budget — forced after the plain one — and the
 * end is recorded only once observed; a kill that fails both rungs leaves the
 * session live and unrecorded, so a retry stays honest. The replacement
 * resumes the old conversation when its transcript ended clean (the shared
 * resume leg, the same session id, `resumed: true` in the JSON) and
 * cold-starts otherwise (`previous_session_id` names the old); either way the
 * fresh seat is kicked into its first move — the launcher's own duty, never
 * fatal to the launch it follows.
 */
function restart(parsed, deps = {}) {
  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const session = require("./session");
  const cwd = deps.cwd || process.cwd();
  if (!parsed.target) throw fail(2, "a restart needs a task or a session");
  const { entry, descs } = findEntry(parsed.target, cwd, { resumable: true });
  const reg = entry.reg;
  const sid = String(reg.session_id || "");
  const id8 = sid.slice(0, 8);
  if (String(reg.agent || "") !== "coordinator") {
    throw fail(2, `Session ${id8} is a ${agentName(reg.agent)} session; a restart replaces a coordinator session only (the fresh start reloads the coordinator's installed rules)`,
      "not_coordinator", { remedy: `reopen it with: a resume ${id8} (a resume keeps its conversation)` });
  }
  if (!reg.task_dir) {
    throw fail(4, `Session ${id8} has no recorded task; a restart re-derives the fresh start from the recorded task`,
      "no_task", { remedy: "start a replacement by hand: a start <task> --coordinator" });
  }
  // The co-occupancy pre-check runs before anything is ended: the replacement
  // start would refuse a task another live session holds, and a coordinator
  // ended with no replacement is the one outcome this verb must never produce.
  const occupant = descs.find((d) => d.live && d.reg.origin !== "dispatch" && d.dir !== entry.dir
    && d.reg.session_id !== sid && sameDir(d.reg.task_dir, reg.task_dir));
  if (occupant) {
    const occId8 = String(occupant.reg.session_id || "").slice(0, 8);
    const who = `${agentName(occupant.reg.agent)} session ${occupant.zmxName || `pid ${occupant.reg.pid}`}`;
    throw fail(2, `Task ${path.basename(reg.task_dir)} already has a live ${who}; a restart replaces a coordinator seat without taking the task from another session`,
      "task_occupied", { remedy: `resume or end it first: a resume ${occId8}, or /exit in its pane — then a restart again` });
  }

  // The fresh start's derivation, hoisted above the end flow: the prechecks
  // below read exactly what the re-entry start() will read — the repo row,
  // the repo key, the worktree-vs-here shape the recorded cwd decides — so a
  // refusal they find is one the fresh start would find post-end, with the
  // seat already gone. A checkout that no longer resolves (repoKey throwing)
  // skips them: that refusal is the start's own, with its remedy (a restart
  // that dies there keeps its typed refusal; the down-renewal is the seat's
  // recovery).
  const repoRow = require("./db").repoOf(reg.repo_key);
  const repoPath = (repoRow && repoRow.main_root) || reg.cwd || cwd;
  let mainRoot = repoPath;
  try { mainRoot = require("./repo").repoKey(repoPath).main_root; } catch {}
  const useWorktree = reg.cwd ? realpath(reg.cwd) !== realpath(mainRoot) : null;
  let startKey = null;
  try { startKey = require("./repo").repoKey(repoPath); } catch {}

  if (startKey) {
    // Precheck 1 — a closed task: the fresh start resolves the recorded task
    // over active candidates only, and a closed or archived task no longer
    // resolves; that refusal must fire here, while the seat still runs.
    if (!resolveTask(reg.task_dir, startKey)) {
      throw fail(2, `Task ${path.basename(reg.task_dir)} (the recorded task of session ${id8}) is closed or no longer active; a restart replaces the seat only with a fresh start on that task`,
        "task_gone",
        { remedy: `start a replacement by hand: a start --title <title> --coordinator — or restore the closed task first (its folder back in the tasks root, its row active again), then a restart again` });
    }
    const base = require("./policy").resolvePolicy(startKey.main_root).base;
    if (useWorktree === false) {
      // Precheck 2 — the unlanded side branch: the why-check half of the
      // start gate's branch block (sideBranchVerdict), read-only — the
      // precheck never switches branches. The healthy path (on base, or on
      // the task's own branch) reads no network at all; a fetch that fails
      // warns and skips exactly as the gate does.
      const branch = spawnSync("git", ["-C", startKey.main_root, "branch", "--show-current"], { encoding: "utf8", timeout: 20000 }).stdout.trim();
      const verdict = sideBranchVerdict(startKey, base, branch, require("./worktree").mainTaskBranch(reg.task_dir));
      if (verdict.fetchFailed) {
        warn(`warning: could not fetch origin ${base} (${verdict.fetchWhy})`);
      } else if (verdict.why) {
        throw fail(2, `Checkout ${startKey.main_root} is on ${branch || "a detached HEAD"}, whose work is not fully landed (${verdict.why}); the seat was left live — a restart ends it only once the fresh start can follow`,
          "side_branch",
          { remedy: `land or close that work, or return to ${base} by hand, then a restart again` });
      }
    }
    if (useWorktree === true) {
      // Precheck 3 — the worktree shape's broken fetch: a worktree start
      // cuts its branch from origin/<base> and refuses when the fetch ran
      // and failed. fetchBase is throttled, so this pre-warms the window —
      // the fresh start's own fetch skips inside it, no added latency.
      const fetched = fetchBase(startKey, base);
      if (fetched === "failed") {
        throw fail(2, `could not fetch origin ${base} from ${startKey.main_root}: the fetch failed; the seat was left live — a worktree restart cuts its branch from origin/${base}`,
          "fetch_failed",
          { remedy: `fix the remote or the network, then a restart again` });
      }
    }
  }

  if (entry.live) {
    if (!entry.zmxName) throw outsideZmx(entry, parsed.target);

    // The turn guard reads the transcript before the pane: evidence newer
    // than the newest turn-end marker proves a turn in flight, which a clean
    // /exit cannot interrupt. No facts at all proves nothing — a hooks-off
    // seat is not blocked forever.
    const transcriptPath = reg.transcript_path || adapter.transcript({ sessionId: sid, cwd: reg.cwd || cwd });
    const facts = transcriptPath ? require("./derive").transcriptTailFacts(transcriptPath) : null;
    if (facts && facts.newestEvidenceMs !== null &&
        (facts.newestMarkerMs === null || facts.newestEvidenceMs > facts.newestMarkerMs)) {
      throw fail(2, `Session ${id8} is mid-turn (the newest turn evidence is newer than the last turn end in its transcript)`,
        "turn_running", { remedy: "wait for the turn to end, then a restart again; a long turn can block the restart for as long as it runs" });
    }

    let vt;
    try { vt = pane.paneVtLines(entry.zmxName); }
    catch (err) { throw fail(2, err.message, "zmx_history_failed", { remedy: `check the pane (zmx attach ${entry.zmxName}), then a restart again` }); }
    const plain = vt.map(pane.stripEscapes);
    if (pane.promptPresent(plain)) {
      throw fail(2, `Session ${id8}'s pane ${entry.zmxName} holds an open permission prompt`,
        "prompt_pending", { remedy: `answer the prompt in its pane (zmx attach ${entry.zmxName}), then a restart again` });
    }
    const input = pane.inputLineOf(vt);
    if (input === null) {
      throw fail(2, `Session ${id8}'s pane ${entry.zmxName} shows no input box line; a restart cannot prove the input is empty`,
        "no_input_box", { remedy: `check the pane (zmx attach ${entry.zmxName}); once it shows the input box, a restart again` });
    }
    if (!input.empty) {
      throw fail(2, `Session ${id8}'s pane ${entry.zmxName} holds an unsent draft (last input line: ${JSON.stringify(input.line)})`,
        "draft_pending", { remedy: `answer or clear the draft in the pane (zmx attach ${entry.zmxName}), then a restart again` });
    }

    // The flush, before anything is ended: the seat is provably responsive
    // here (the guards just passed) — a pane that would ignore /exit would
    // ignore a flush sent after it just as deafly, so one flush before
    // everything makes every later kill preceded by it by construction. It
    // rides pane-send, the one shared send path. A refused flush (the gate,
    // a precondition) proceeds without it — the pending ask is itself a
    // durable record — and a deaf seat never blocks: the turn-end wait is
    // bounded by the flush budget, and the renewal proceeds on expiry.
    const flushMs = parseInt(process.env.AGENTS_RESTART_FLUSH_TIMEOUT_MS, 10) || 120000;
    const flushStartMs = Date.now();
    const flushRun = spawnSync(process.execPath, [
      path.resolve(__dirname, "..", "bin", "pane-send"), "send", entry.zmxName, FLUSH_TEXT,
      "--verify-secs", String(Math.min(2, flushMs / 1000)),
    ], { encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }); // belt: pane-send's own waits are all knobbed under this
    if (flushRun.status === 2) {
      const why = String(flushRun.stderr || "").split("\n").find((l) => l.trim());
      warn(`restart: the flush to ${entry.zmxName} was refused (${why ? why.trim() : "no reason given"}); proceeding without the hand-off`);
    } else if (transcriptPath && fs.existsSync(transcriptPath)) {
      // Exit 0: the submit verified in the transcript. Exit 1 (or a crash):
      // sent but unverified — the transcript write lags the Enter, and this
      // bounded wait is what decides. The evidence that counts as flushed is
      // the hand-off turn having ENDED: a turn-end marker at/after the
      // flush's submit, the same primitive the turn guard trusts.
      const flushDeadline = flushStartMs + flushMs;
      let flushed = false;
      while (Date.now() < flushDeadline) {
        const facts = require("./derive").transcriptTailFacts(transcriptPath);
        if (facts && facts.newestMarkerMs !== null && facts.newestMarkerMs >= flushStartMs) { flushed = true; break; }
        execFileSync("/bin/sleep", [RESTART_POLL_STEP_SECS]);
      }
      warn(flushed
        ? "restart: the old seat flushed its hand-off to the records"
        : `restart: the flush to ${entry.zmxName} did not land within ${Math.round(flushMs / 1000)}s; proceeding without the hand-off`);
    }

    const sendInput = (text) => {
      try {
        execFileSync("zmx", ["send", entry.zmxName], { input: text, encoding: "utf8", timeout: pane.ZMX_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        const why = err.stderr ? String(err.stderr).trim() : err.message;
        throw fail(1, `zmx send failed for ${entry.zmxName}: ${why}`, "spawn_failed",
          { remedy: `check the pane (zmx attach ${entry.zmxName}), then a restart again` });
      }
    };
    sendInput("/exit");
    execFileSync("/bin/sleep", ["0.5"], { stdio: ["ignore", "ignore", "ignore"] }); // the pre-Enter pause pane-send keeps
    sendInput("\r");

    const endedNow = () => {
      const reg2 = session.readRegistration(entry.dir);
      if (reg2 && reg2.ended_at) return true; // the hook recorded it
      let listed;
      try { listed = zmxSessions(); } catch { return Boolean(reg2 && reg2.pid && !session.isLive(reg2)); } // a zmx timeout: the pid signal only, this round
      if (listed !== null && !listed.some((z) => z.name === entry.zmxName && !z.ended)) return true; // pane gone or ended
      return Boolean(reg2 && reg2.pid && !session.isLive(reg2)); // the recorded pid is dead
    };
    const budgetMs = parseInt(process.env.AGENTS_RESTART_EXIT_TIMEOUT_MS, 10) || 10000;
    const deadline = Date.now() + budgetMs;
    while (!endedNow() && Date.now() < deadline) execFileSync("/bin/sleep", [RESTART_POLL_STEP_SECS]);
    let killed = false;
    let forced = false;
    if (!endedNow()) {
      const graceMs = parseInt(process.env.AGENTS_RESTART_KILL_GRACE_MS, 10) || 5000;
      let killErr = null;
      try { require("./setup").stopPane({ pane: entry.zmxName }); }
      catch (err) { killErr = err; }
      let grace = Date.now() + graceMs; // the kill's own budget
      while (!endedNow() && Date.now() < grace) execFileSync("/bin/sleep", [RESTART_POLL_STEP_SECS]);
      if (!endedNow()) {
        // The escalation: a pane that ignored /exit and survived a plain
        // kill (the wedged shape) is force-killed here, before the by-hand
        // refusal — so the unattended renewer can recover past it.
        try { require("./setup").stopPane({ pane: entry.zmxName, force: true }); killErr = null; }
        catch (err) { killErr = err; }
        grace = Date.now() + graceMs;
        while (!endedNow() && Date.now() < grace) execFileSync("/bin/sleep", [RESTART_POLL_STEP_SECS]);
        if (!endedNow()) {
          // The end stays unrecorded: the pane may still run, and a stamped
          // ended_at would read a live pane as exited and let a retry skip the
          // end flow and double-seat the task.
          throw fail(2, killErr
            ? `Session ${id8} did not end within ${Math.round(budgetMs / 1000)}s and its pane ${entry.zmxName} ignored /exit, a zmx kill and a forced kill (zmx kill ${entry.zmxName} --force failed: ${killErr.message})`
            : `Session ${id8} did not end within ${Math.round(budgetMs / 1000)}s and its pane ${entry.zmxName} still shows live after /exit, a zmx kill and a forced kill`,
            "kill_failed",
            { remedy: `end it by hand — zmx kill ${entry.zmxName} --force, or /exit inside its pane (zmx attach ${entry.zmxName}) — then a restart again` });
        }
        forced = true;
      }
      killed = true;
    }
    const regEnd = session.readRegistration(entry.dir);
    if (regEnd && !regEnd.ended_at) session.markEnded(entry.dir); // the engine records the end; the hook may already have
    warn(killed
      ? `restart: Coordinator session ${id8} did not exit within ${Math.round(budgetMs / 1000)}s; ${forced ? "force-killed" : "killed"} its zmx session ${entry.zmxName}`
      : `restart: Coordinator session ${id8} exited cleanly`);
  } else {
    warn(`restart: Coordinator session ${id8} had already ended`);
  }

  // The resume preference: the old conversation continues when its transcript
  // ended clean — a turn-end marker at/after the newest evidence, the same
  // tail fact the turn guard trusts — because the kick's shared floor can
  // submit a first move into exactly that shape. A mid-turn tail (the
  // conversation was killed mid-flight) or no transcript at all takes the
  // cold start: the interrupted tail's unrecorded work is lost exactly as a
  // cold restart always lost it.
  const oldTranscript = reg.transcript_path || adapter.transcript({ sessionId: sid, cwd: reg.cwd || cwd });
  let tailClean = false;
  if (oldTranscript && fs.existsSync(oldTranscript)) {
    const tailFacts = require("./derive").transcriptTailFacts(oldTranscript);
    tailClean = Boolean(tailFacts && tailFacts.newestMarkerMs !== null
      && (tailFacts.newestEvidenceMs === null || tailFacts.newestEvidenceMs <= tailFacts.newestMarkerMs));
  }
  if (tailClean) {
    const resumed = resumeLaunch(entry, { parsed, cwd, envFile: launchConfig().envFile, zmx: zmxSessions() });
    return parsed.json
      ? { exitCode: resumed.exitCode, json: { ...resumed.json, resumed: true }, text: null }
      : resumed;
  }

  // The fresh start: the coordinator's task, repo and run dir are the
  // registration's (derived above the end flow); the original's `--`
  // passthrough is not recorded anywhere and does not carry over — a
  // restart's own passthrough forwards instead.
  const result = start({
    target: reg.task_dir, title: null, repo: repoPath,
    conductor: false, courier: false, coordinator: true,
    worktree: useWorktree === true, here: useWorktree === false,
    noAttach: parsed.noAttach, json: parsed.json, passthrough: parsed.passthrough,
    previousSessionId: sid, // internal-only: parseArgs never produces it; FLAG_SPECS refuses it on the CLI
  }, deps);
  return parsed.json
    ? { exitCode: result.exitCode, json: { ...result.json, previous_session_id: sid }, text: null }
    : result;
}

/**
 * The checkout a headless run on `phase` starts in: the phase's branch worktree when it names a branch other
 * than `base` (refused when that branch has none), else the task's derived worktree when it exists, else the main root.
 */
module.exports = { zmxSessions, zmxAvailable, zmxVersionOk, liveSession, resolveTask, parseArgs, FLAG_SPECS, start, resume, restart, launchConfig, setupCommand, teardownCommand, fail, realpath };
