#!/usr/bin/env node
"use strict";
// `a launch`, the occupancy rules, and the start/launch env paths: the second
// half of the former test-lib-start, split when that suite outgrew every
// per-suite budget (the CHANGELOG's "killed for silence" entry).
// Isolation: nothing here may touch the real HOME, config, git config, zmx or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-start-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "claudebin", "procs", "xdg-data"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    XDG_DATA_HOME: path.join(t, "xdg-data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "AGENTS_TEST_SKIP_IDENTITY",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "VIRTUAL_ENV", "POETRY_ACTIVE", "STUB_ZMX_EXIT", "STUB_ZMX_SNAP", "STUB_CLAUDE_EXIT",
    "CLAUDE_ENV_DUMP"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { HANG_GUARD_MS } = require("./hang-guard");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");
const BIN = path.join(__dirname, "bin");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const start = require("./lib/start");
const { repoKey } = require("./lib/repo");
const coe = require("./lib/checkout-env");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Stub zmx and claude: they log their argv, and the stub zmx answers `list` from $ZMX_LIST_FILE.
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  '  list)',
  '    [ -n "$ZMX_LIST_COUNT" ] && echo x >> "$ZMX_LIST_COUNT"',
  '    if [ -n "$STUB_ZMX_LIST_SLOW_FOREVER" ]; then sleep "$STUB_ZMX_LIST_SLOW_FOREVER"; exit 0; fi',
  '    if [ -n "$STUB_ZMX_LIST_SLOW_ONCE" ]; then',
  '      c=0',
  '      [ -f "$ZMX_LIST_CALLS" ] && c=$(cat "$ZMX_LIST_CALLS")',
  "      case \"$c\" in ''|*[!0-9]*) c=0 ;; esac",
  '      echo $((c + 1)) > "$ZMX_LIST_CALLS"',
  '      [ "$c" -eq 0 ] && { sleep "$STUB_ZMX_LIST_SLOW_ONCE"; exit 0; }',
  '    fi',
  '    [ -f "$ZMX_LIST_FILE" ] && cat "$ZMX_LIST_FILE"; exit 0 ;;',
  "esac",
  'if [ "$1" = run ] && [ -n "$STUB_ZMX_SNAP" ]; then cp "$STUB_ZMX_SNAP" "$ZMX_LOG.snap"; fi',
  'printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  'echo "cwd $PWD" >> "$ZMX_LOG"',
  'exit "${STUB_ZMX_EXIT:-0}"',
  "",
].join("\n"), { mode: 0o755 });
const claudeStub = [
  "#!/bin/sh",
  'echo "claude $*" >> "$CLAUDE_LOG"',
  'echo "cwd $PWD" >> "$CLAUDE_LOG"',
  'echo "AGENTS_SESSION_DIR=$AGENTS_SESSION_DIR" >> "$CLAUDE_LOG"',
  'echo "VENV=${VIRTUAL_ENV-unset},${POETRY_ACTIVE-unset}" >> "$CLAUDE_LOG"',
  'echo "PATH=$PATH" >> "$CLAUDE_LOG"',
  '[ -n "$CLAUDE_ENV_DUMP" ] && /usr/bin/env -0 > "$CLAUDE_ENV_DUMP"',
  'exit "${STUB_CLAUDE_EXIT:-0}"',
  "",
].join("\n");
fs.writeFileSync(path.join(stubBin, "claude"), claudeStub, { mode: 0o755 });
fs.writeFileSync(path.join(stubBin, "myclaude"), claudeStub, { mode: 0o755 });
const claudeOnlyBin = path.join(T, "claudebin");
fs.writeFileSync(path.join(claudeOnlyBin, "claude"), claudeStub, { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;

// A process whose command line contains "claude" (a copy of /bin/sleep would be killed on arm64 macOS).
const procDir = path.join(T, "procs");
fs.writeFileSync(path.join(procDir, "claude"), '#!/bin/sh\nsleep "$1"\n', { mode: 0o755 });
const children = [];
function spawnProc(file, marker) {
  const child = spawn(file, ["60"], { stdio: "ignore", detached: true });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    if (cmd.includes(marker)) break;
    execFileSync("/bin/sleep", ["0.02"]);
  }
  return child;
}
const spawnClaude = () => spawnProc(path.join(procDir, "claude"), "claude");
const spawnSleep = () => spawnProc("/bin/sleep", "sleep 60");
const nowIso = () => new Date().toISOString();
const pause = (s = 0.05) => execFileSync("/bin/sleep", [String(s)]);

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// The fixture: repo acme with a local bare origin and two open tasks, fresh roots and logs.
let cur;
// Every fixture's repo is named acme, so each gets its own worktrees root; `defaultRoot` keeps ~/.agents/worktrees.
function fixture(label, { defaultRoot = false } = {}) {
  const root = mk(label);
  Object.assign(process.env, {
    AGENTS_TASKS_ROOT: path.join(root, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
    AGENTS_DB: path.join(root, "agents.db"),
    ZMX_LOG: path.join(root, "zmx.log"),
    CLAUDE_LOG: path.join(root, "claude.log"),
    ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
  });
  const wtRoot = defaultRoot ? path.join(process.env.HOME, ".agents", "worktrees") : path.join(root, "worktrees");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, defaultRoot ? "{}" : JSON.stringify({ worktrees_root: wtRoot }));
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  db.open({ create: true });
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repoDir = path.join(root, "work", "acme");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
  git(repoDir, "remote", "add", "origin", origin);
  git(repoDir, "push", "-q", "-u", "origin", "main");
  git(repoDir, "remote", "set-head", "origin", "main");
  const key = repoKey(repoDir);
  const mkTask = (slug, title) => taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  const tasks = { 1: mkTask("one", "One"), 2: mkTask("two", "Two") };
  cur = { root, origin, repoDir, key, tasks, wtRoot, sessions: process.env.AGENTS_SESSIONS_ROOT, tasksRoot: process.env.AGENTS_TASKS_ROOT };
  return cur;
}

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
function parseEnvNul(output) {
  const env = {};
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
// The stub logs one argv word per line and closes each call with its `cwd` line; this assumes no word contains a newline.
function zmxArgvs() {
  const calls = [];
  let words = [];
  for (const l of readLog(process.env.ZMX_LOG)) {
    if (l.startsWith("cwd ")) { calls.push(words); words = []; } else words.push(l);
  }
  return calls;
}
const zmxRunArgvs = () => zmxArgvs().filter((w) => w[0] === "run");
const zmxCalls = () => zmxArgvs().map((w) => "zmx " + w.join(" "));
const zmxRuns = () => zmxCalls().filter((l) => l.startsWith("zmx run "));
const claudeCalls = () => readLog(process.env.CLAUDE_LOG).filter((l) => l.startsWith("claude "));
const lastCwd = () => readLog(process.env.ZMX_LOG).filter((l) => l.startsWith("cwd ")).pop();
const zl = (name, ended) => `name=${name}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp${ended ? "\tended=2\texit_code=0" : ""}`;
const setZmx = (lines) => fs.writeFileSync(process.env.ZMX_LIST_FILE, lines.map((l) => l + "\n").join(""));
const readReg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "registration.json"), "utf8"));
const regBytes = (dir) => fs.readFileSync(path.join(dir, "registration.json"), "utf8");
const taskCount = () => fs.readdirSync(path.join(cur.tasksRoot, cur.key.key)).filter((n) => /^\d{3}-/.test(n)).length;
const trashDir = () => path.join(path.dirname(cur.tasksRoot), "trash");
const wtPath = (name) => path.join(cur.wtRoot, "acme", name);

function register(fields) {
  return session.register({
    origin: "cli", initiator: "user", agent: "conductor", cwd: cur.key.main_root, repo_key: cur.key.key,
    session_dir: path.join(cur.sessions, fields.terminal_id), ...fields,
  });
}

function cli(args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: cwd || cur.repoDir, timeout: 60000, env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function cliJson(args, opts) { const r = cli([...args, "--json"], opts); return { ...r, data: r.status === 0 && r.out ? JSON.parse(r.out) : null }; }

// Calls a verb in process; a refusal comes back as `err` (with its exitCode).
function verb(name, argv, deps = {}) {
  try {
    return { res: start[name](start.parseArgs(argv, name), { cwd: cur.repoDir, ...deps }) };
  } catch (err) {
    return { err };
  }
}
const answers = (...replies) => { const asked = []; const ask = (q, choices) => { asked.push({ q, choices }); return replies.shift(); }; ask.asked = asked; return ask; };

// ST-foreground-line: without zmx, the foreground path runs the same canonical line (exec sh '<script>').
{
  const f = fixture("stfg");
  const dumpFile = path.join(f.root, "fg-dump.env");
  const r = cli(["start", "001", "--no-attach"], { env: { PATH: `${claudeOnlyBin}:/usr/bin:/bin`, CLAUDE_ENV_DUMP: dumpFile } });
  check(r.status === 0, `ST-foreground-line: the foreground start succeeds (${r.status}: ${r.err.trim()})`);
  const entries = session.entries();
  const lastEntry = entries[entries.length - 1];
  const scriptPath = path.join(lastEntry.dir, "launch.sh");
  const namesPath = path.join(lastEntry.dir, "launch.env-names");
  check(!fs.existsSync(scriptPath), "ST-foreground-line: the script self-removed after the foreground run");
  check(fs.existsSync(namesPath), "ST-foreground-line: launch.env-names survives");
  if (fs.existsSync(dumpFile)) {
    const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
    check(!("VIRTUAL_ENV" in dump) && !("POETRY_ACTIVE" in dump), "ST-foreground-line: no venv markers in the foreground session");
    check(dump.AGENTS_SESSION_DIR === lastEntry.dir, `ST-foreground-line: AGENTS_SESSION_DIR is the session dir (${dump.AGENTS_SESSION_DIR})`);
  } else {
    check(false, "ST-foreground-line: the claude stub wrote an env dump");
  }
}

// ST-env-blocked: a not-allowed .envrc refuses with envrc_blocked; nothing registered, no zmx run.
{
  const f = fixture("steb");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  const entriesBefore = session.entries().length;
  const runsBefore = zmxRuns().length;
  const r = cli(["start", "001", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "envrc_blocked", `ST-env-blocked: refuses with envrc_blocked (${r.status}: ${JSON.stringify(body)})`);
  check(session.entries().length === entriesBefore && zmxRuns().length === runsBefore, "ST-env-blocked: nothing registered, no zmx run");
}

// ST-env-denied: a denied .envrc refuses with envrc_denied.
{
  const f = fixture("sted");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  execFileSync("direnv", ["deny"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r = cli(["start", "001", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "envrc_denied", `ST-env-denied: refuses with envrc_denied (${r.status}: ${JSON.stringify(body)})`);
}

// ST-env-failed: a failing .envrc refuses with envrc_failed.
{
  const f = fixture("stef");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "exit 7\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r = cli(["start", "001", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "envrc_failed", `ST-env-failed: refuses with envrc_failed (${r.status}: ${JSON.stringify(body)})`);
}

// ST-env-missing: no direnv on PATH + .envrc present refuses with direnv_missing.
{
  const f = fixture("stem");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r = cli(["start", "001", "--no-attach", "--json"], { cwd: f.repoDir, env: { PATH: `${stubBin}:/usr/bin:/bin` } });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "direnv_missing", `ST-env-missing: refuses with direnv_missing (${r.status}: ${JSON.stringify(body)})`);
}

// ST-env-worktree: main .envrc allowed + worktree start auto-allows the worktree's .envrc at its real path.
{
  const f = fixture("stewt", { defaultRoot: true });
  // Checkout-relative .envrc in the main checkout (untracked, so it arrives as a symlink in the worktree)
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\nPATH_add .venv/bin\n");
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });

  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST-env-worktree: start with --worktree succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  const wt = r.data && r.data.worktree;
  check(wt, `ST-env-worktree: the JSON carries the worktree path`);

  // The allow store has an entry for the worktree's realpath
  const allowDir = path.join(process.env.XDG_DATA_HOME, "direnv", "allow");
  const wtReal = fs.realpathSync(wt);
  const expectedEntry = `${wtReal}/.envrc\n`;
  let foundWtEntry = false;
  if (fs.existsSync(allowDir)) {
    for (const name of fs.readdirSync(allowDir)) {
      const content = fs.readFileSync(path.join(allowDir, name), "utf8");
      if (content === expectedEntry) foundWtEntry = true;
    }
  }
  check(foundWtEntry, `ST-env-worktree: the worktree's .envrc is allowed at its real path (${expectedEntry})`);

  // The session env came from the worktree's .envrc (the worktree's .venv/bin is on PATH)
  const dumpFile = path.join(f.root, "stewt-dump.env");
  const scriptPath = r.data && path.join(r.data.session_dir, "launch.sh");
  if (scriptPath && fs.existsSync(scriptPath)) {
    const paneEnv = { TERM: "xterm-256color", ZMX_SESSION: "z", HOME: process.env.HOME, PATH: "/usr/bin:/bin",
      CLAUDE_LOG: process.env.CLAUDE_LOG, CLAUDE_ENV_DUMP: dumpFile };
    spawnSync("sh", [scriptPath], { env: paneEnv, encoding: "utf8", timeout: HANG_GUARD_MS });
    if (fs.existsSync(dumpFile)) {
      const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
      check(dump.T_V === "x", "ST-env-worktree: T_V from the .envrc is in the session env");
      check((dump.PATH || "").split(":")[0] === path.join(wtReal, ".venv", "bin"), `ST-env-worktree: the worktree's .venv/bin is first on PATH (${(dump.PATH || "").split(":")[0]})`);
    }
  }

  // Bytes-differ: a real .envrc in the worktree that differs from main's → worktree_envrc_untrusted
  const f2 = fixture("stewt2");
  fs.writeFileSync(path.join(f2.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f2.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  // Create the worktree first, then replace the symlink with a different file
  const r2a = cliJson(["start", "001", "--worktree", "--no-attach"]);
  const wt2 = r2a.data && r2a.data.worktree;
  if (wt2) {
    fs.unlinkSync(path.join(wt2, ".envrc"));
    fs.writeFileSync(path.join(wt2, ".envrc"), "export T_V=different\n");
  }
  const r2 = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f2.repoDir });
  let body2 = null;
  try { body2 = JSON.parse(r2.out); } catch {}
  check(r2.status === 2 && body2 && body2.error === "worktree_envrc_untrusted", `ST-env-worktree: bytes-differ refuses worktree_envrc_untrusted (${r2.status}: ${JSON.stringify(body2)})`);
}

// ST-launch-cleanup: a failed zmx run removes launch.sh and launch.env-names (start).
{
  fixture("stlc");
  const r = cli(["start", "001", "--no-attach", "--json"], { env: { STUB_ZMX_EXIT: "1" } });
  const entries = session.entries();
  check(r.status !== 0, `ST-launch-cleanup: the failed run exits non-zero (${r.status})`);
  check(entries.length >= 1, `ST-launch-cleanup: a registration exists`);
  check(!fs.existsSync(path.join(entries[0].dir, "launch.sh")), "ST-launch-cleanup: launch.sh is absent after a failed zmx run (start)");
  check(!fs.existsSync(path.join(entries[0].dir, "launch.env-names")), "ST-launch-cleanup: launch.env-names is absent after a failed zmx run (start)");
}

// ST-launch-cleanup-resume: a failed zmx run removes launch.sh and launch.env-names (resume).
{
  const f = fixture("stlcr");
  const r0 = cliJson(["start", "001", "--no-attach"]);
  const dir = r0.data.session_dir, sid = r0.data.session_id, id8 = sid.slice(0, 8);
  const transcriptPath = path.join(f.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r0.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  const r = cli(["resume", "001", "--json"], { env: { STUB_ZMX_EXIT: "1" } });
  check(r.status !== 0, `ST-launch-cleanup-resume: the failed resume exits non-zero (${r.status})`);
  check(!fs.existsSync(path.join(dir, "launch.sh")), "ST-launch-cleanup-resume: launch.sh is absent after a failed zmx run (resume)");
  check(!fs.existsSync(path.join(dir, "launch.env-names")), "ST-launch-cleanup-resume: launch.env-names is absent after a failed zmx run (resume)");
}

// ST-launch-cleanup-eisdir: a pre-existing launch.env-names directory makes the second write fail;
// no launch.sh remains at rest (resume path).
{
  const f = fixture("stlce");
  const r0 = cliJson(["start", "001", "--no-attach"]);
  const dir = r0.data.session_dir, sid = r0.data.session_id, id8 = sid.slice(0, 8);
  const transcriptPath = path.join(f.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r0.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  const namesPath = path.join(dir, "launch.env-names");
  if (fs.existsSync(namesPath)) fs.unlinkSync(namesPath);
  fs.mkdirSync(namesPath);
  const r = cli(["resume", "001", "--json"]);
  check(r.status !== 0, `ST-launch-cleanup-eisdir: the resume with a directory at launch.env-names exits non-zero (${r.status})`);
  check(!fs.existsSync(path.join(dir, "launch.sh")), "ST-launch-cleanup-eisdir: no launch.sh remains after the second write fails (resume)");
}

// ST-env-worktree-pickup: a worktree start from a repo whose main checkout has untracked
// .env and .envrc — both land in the worktree as copies, the worktree's .envrc is
// auto-allowed, and the session env carries the .envrc's export.
{
  const f = fixture("stwt-pickup");
  fs.writeFileSync(path.join(f.repoDir, ".env"), "KEY=secret\n");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_WT=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const dumpFile = path.join(f.root, "stwt-pickup-dump.env");
  const r = cliJson(["start", "001", "--worktree", "--no-attach"], { env: { CLAUDE_ENV_DUMP: dumpFile } });
  check(r.status === 0, `ST-env-worktree-pickup: the worktree start succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  const wt = r.data && r.data.worktree;
  check(Boolean(wt), `ST-env-worktree-pickup: the JSON carries the worktree path (${JSON.stringify(r.data && r.data.worktree)})`);
  const wtReal = wt && fs.realpathSync(wt);

  // .env: a regular copy of the main checkout's file
  const envCopy = wtReal && path.join(wtReal, ".env");
  const envStat = envCopy && fs.existsSync(envCopy) && fs.lstatSync(envCopy);
  check(Boolean(envStat && envStat.isFile() && !envStat.isSymbolicLink()), `ST-env-worktree-pickup: .env in the worktree is a regular file, not a symlink (${envCopy})`);
  check(Boolean(envStat && envStat.isFile() && fs.readFileSync(envCopy, "utf8") === "KEY=secret\n"), "ST-env-worktree-pickup: the .env copy carries the main checkout's bytes");

  // .envrc: the same, beside it
  const envrcCopy = wtReal && path.join(wtReal, ".envrc");
  const envrcStat = envrcCopy && fs.existsSync(envrcCopy) && fs.lstatSync(envrcCopy);
  check(Boolean(envrcStat && envrcStat.isFile() && !envrcStat.isSymbolicLink()), `ST-env-worktree-pickup: .envrc in the worktree is a regular file, not a symlink (${envrcCopy})`);
  check(Boolean(envrcStat && envrcStat.isFile() && fs.readFileSync(envrcCopy, "utf8") === "export T_WT=x\n"), "ST-env-worktree-pickup: the .envrc copy carries the main checkout's bytes");

  // the worktree's .envrc is allowed by the start itself (the auto-allow)
  check(Boolean(envrcCopy && coe.isAllowed(envrcCopy)), `ST-env-worktree-pickup: the worktree's .envrc is direnv-allowed after the start (${envrcCopy})`);

  // E1 carries the .envrc's export: CLAUDE_ENV_DUMP rides E1 into the stub claude
  // (launch.sh's `env -i` discards the pane env), so the start itself carries it.
  const scriptPath = r.data && path.join(r.data.session_dir, "launch.sh");
  check(Boolean(scriptPath && fs.existsSync(scriptPath)), `ST-env-worktree-pickup: launch.sh is written (${scriptPath})`);
  const paneEnv = {
    TERM: "xterm-256color", HOME: process.env.HOME,
    PATH: "/usr/bin:/bin", CLAUDE_LOG: process.env.CLAUDE_LOG,
  };
  const ran = scriptPath && spawnSync("sh", [scriptPath], { env: paneEnv, encoding: "utf8", timeout: HANG_GUARD_MS });
  check(Boolean(ran && ran.status === 0), `ST-env-worktree-pickup: launch.sh executes cleanly under the pane env (${ran && ran.status}: ${ran && ran.stderr.slice(-200)})`);
  const dump = dumpFile && fs.existsSync(dumpFile) ? parseEnvNul(fs.readFileSync(dumpFile, "utf8")) : null;
  check(Boolean(dump && dump.T_WT === "x"), `ST-env-worktree-pickup: the session env carries the .envrc's T_WT (${dump && dump.T_WT})`);
}

// ST-env-worktree-main-not-allowed: main's .envrc not allowed refuses worktree_envrc_untrusted (main_not_allowed);
// the created worktree is rolled back (dir gone).
{
  const f = fixture("stwt-mna");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  const wt = wtPath("001-one");
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "worktree_envrc_untrusted", `ST-env-worktree-main-not-allowed: refuses worktree_envrc_untrusted (${r.status}: ${JSON.stringify(body)})`);
  check(body && body.reason === "main_not_allowed", `ST-env-worktree-main-not-allowed: the reason is main_not_allowed (${body && body.reason})`);
  check(!fs.existsSync(wt), `ST-env-worktree-main-not-allowed: the worktree directory is gone after the refusal`);
  check(session.entries().length === 0, "ST-env-worktree-main-not-allowed: nothing registered");
}

// ST-env-worktree-main-missing: main's .envrc missing while the worktree has a real file refuses
// worktree_envrc_untrusted (main_missing).
{
  const f = fixture("stwt-mm");
  const r0 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r0.status === 0, `ST-env-worktree-main-missing: first start succeeds (no .envrc) (${r0.status})`);
  const wt = r0.data && r0.data.worktree;
  fs.writeFileSync(path.join(wt, ".envrc"), "export T_V=x\n");
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "worktree_envrc_untrusted", `ST-env-worktree-main-missing: refuses worktree_envrc_untrusted (${r.status}: ${JSON.stringify(body)})`);
  check(body && body.reason === "main_missing", `ST-env-worktree-main-missing: the reason is main_missing (${body && body.reason})`);
}

// ST-env-worktree-deny: a deny at the worktree's .envrc path is respected; the deny entry survives.
{
  const f = fixture("stwt-deny");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r0 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r0.status === 0, `ST-env-worktree-deny: first start succeeds (${r0.status})`);
  const wt = r0.data && r0.data.worktree;
  const wtReal = fs.realpathSync(wt);
  const wtEnvrc = path.join(wtReal, ".envrc");
  if (fs.lstatSync(wtEnvrc).isSymbolicLink()) fs.unlinkSync(wtEnvrc);
  fs.writeFileSync(wtEnvrc, "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: wtReal, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  execFileSync("direnv", ["deny"], { cwd: wtReal, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "envrc_denied", `ST-env-worktree-deny: refuses envrc_denied (${r.status}: ${JSON.stringify(body)})`);
  check(coe.isDenied(wtEnvrc), `ST-env-worktree-deny: the deny entry is still present after the refusal`);
}

// ST-env-worktree-direnv-missing: direnv missing in the worktree trust path refuses direnv_missing.
{
  const f = fixture("stwt-dm");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  cliJson(["start", "001", "--worktree", "--no-attach"]);
  const direnvBinPath = execFileSync("which", ["direnv"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS }).trim();
  const direnvDir = path.dirname(direnvBinPath);
  const noDirenvPath = (process.env.PATH || "").split(":").filter((d) => {
    try { return fs.realpathSync(d) !== fs.realpathSync(direnvDir); } catch { return true; }
  }).join(":");
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f.repoDir, env: { PATH: noDirenvPath } });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "direnv_missing", `ST-env-worktree-direnv-missing: refuses direnv_missing (${r.status}: ${JSON.stringify(body)})`);
}

// ST-venv-guard: a worktree start whose .envrc activates an outside venv refuses worktree_venv_outside;
// the main-checkout start in the same repo does not refuse (the guard is worktree-only).
{
  const f = fixture("stvg");
  // .envrc that activates an absolute venv outside the checkout
  const outside = mk("stvg-venv");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), `export VIRTUAL_ENV=${outside}\n`);
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });

  // Worktree start → refuses worktree_venv_outside
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { cwd: f.repoDir });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "worktree_venv_outside", `ST-venv-guard: worktree start refuses worktree_venv_outside (${r.status}: ${JSON.stringify(body)})`);
  check(session.entries().length === 0, "ST-venv-guard: nothing registered on the refusal");

  // Main-checkout start → no refusal (the guard is worktree-only)
  const r2 = cliJson(["start", "002", "--here", "--no-attach"], { cwd: f.repoDir });
  check(r2.status === 0, `ST-venv-guard: main-checkout start does not refuse (${r2.status}: ${r2.err.trim().slice(-200)})`);
}

// ST-resume-env: an edited .envrc is picked up on resume; a missing cwd refuses cwd_missing.
{
  const f = fixture("stre");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r = cliJson(["start", "001", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  // Give it a transcript so resume is allowed
  const transcriptPath = path.join(f.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);

  // Edit the .envrc and re-allow
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\nexport T_V2=y\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });

  const resumeScript = path.join(dir, "launch.sh");
  const res = cli(["resume", "001"]);
  check(res.status === 0, `ST-resume-env: resume succeeds after .envrc edit (${res.status}: ${res.err.trim()})`);
  check(fs.existsSync(resumeScript) && fs.readFileSync(resumeScript, "utf8").includes("'T_V2'='y'"), `ST-resume-env: the regenerated launch.sh carries the new T_V2`);

  // Missing cwd → refuses cwd_missing
  const f2 = fixture("stre2");
  fs.writeFileSync(path.join(f2.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f2.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const r2 = cliJson(["start", "001", "--no-attach"]);
  const dir2 = r2.data.session_dir, sid2 = r2.data.session_id, id82 = sid2.slice(0, 8);
  const transcriptPath2 = path.join(f2.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath2, "[]\n");
  register({ session_id: sid2, terminal_id: r2.data.terminal_id, session_dir: dir2, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath2, cwd: "/nonexistent/path/that/is/gone" });
  session.markEnded(dir2);
  setZmx([zl(`Conductor-${id82}`, true)]);
  const res2 = cli(["resume", "001", "--json"]);
  let body2 = null;
  try { body2 = JSON.parse(res2.out); } catch {}
  check(res2.status === 2 && body2 && body2.error === "cwd_missing", `ST-resume-env: missing cwd refuses cwd_missing (${res2.status}: ${JSON.stringify(body2)})`);
}

// ST-launch: a launch with a PAV-shaped launcher and an allowed .envrc gets the folder's own env;
// a blocked .envrc refuses with the same codes as start.
{
  const f = fixture("stl");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  // PAV-shaped launcher
  const pav = mk("stl-pav");
  fs.mkdirSync(path.join(pav, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pav, "pyvenv.cfg"), "home = /usr/bin\n");
  const pavPath = `${path.join(pav, "bin")}:${process.env.PATH}`;
  const dumpFile = path.join(f.root, "stl-dump.env");
  // a launch spawns the command with E1; the stub dumps its env
  const r = cli(["launch", "--agent", "conductor", "--cwd", f.repoDir, "--", "--session-id", "test-sid"], { env: { PATH: pavPath, CLAUDE_ENV_DUMP: dumpFile }, cwd: f.repoDir });
  check(r.status === 0, `ST-launch: launch with an allowed .envrc succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  if (fs.existsSync(dumpFile)) {
    const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
    check(dump.T_V === "x", "ST-launch: T_V from the .envrc is in the spawned command's env");
    check(!(dump.PATH || "").split(":").includes(path.join(pav, "bin")), "ST-launch: the pav venv bin is absent from the spawned command's PATH");
  } else {
    check(false, "ST-launch: the spawned command wrote an env dump");
  }

  // Blocked .envrc → refuses
  const f2 = fixture("stl2");
  fs.writeFileSync(path.join(f2.repoDir, ".envrc"), "export T_V=x\n");
  // Do NOT allow → blocked
  const r2 = cli(["launch", "--agent", "conductor", "--cwd", f2.repoDir], { cwd: f2.repoDir });
  check(r2.status === 2, `ST-launch: a blocked .envrc refuses (${r2.status}: ${r2.err.trim().slice(-200)})`);
  check(r2.err.includes("blocked"), `ST-launch: the refusal message names the blocked .envrc (${r2.err.trim().slice(-200)})`);
}

// ST-launch-nested: a launch from the same nested launcher env → the spawned dump has no CLAUDE_CODE_ key.
{
  const f = fixture("stln");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const dumpFile = path.join(f.root, "stln-dump.env");
  const nestedEnv = {
    CLAUDE_CODE_SESSION_ID: "parent-session-id",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PID: "99999",
    CLAUDE_ENV_DUMP: dumpFile,
  };
  const r = cli(["launch", "--agent", "conductor", "--cwd", f.repoDir, "--", "--session-id", "test-sid-ln"], { env: nestedEnv, cwd: f.repoDir });
  check(r.status === 0, `ST-launch-nested: launch from a nested launcher succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  if (fs.existsSync(dumpFile)) {
    const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
    const claudeCodeKeys = Object.keys(dump).filter((k) => k.startsWith("CLAUDE_CODE_"));
    check(claudeCodeKeys.length === 0, `ST-launch-nested: no CLAUDE_CODE_ key in the spawned dump (${claudeCodeKeys.join(", ") || "none"})`);
  } else {
    check(false, "ST-launch-nested: the spawned command wrote an env dump");
  }
}

// ST-nested-hygiene: a launcher carrying CLAUDE_CODE_SESSION_ID/CLAUDE_PID/AGENTS_LAND → none reaches the session.
{
  const f = fixture("stnh");
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "export T_V=x\n");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  const dumpFile = path.join(f.root, "stnh-dump.env");
  const nestedEnv = {
    CLAUDE_CODE_SESSION_ID: "parent-session-id",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PID: "99999",
    AGENTS_LAND: "1",
    CLAUDE_ENV_DUMP: dumpFile,
  };
  const r = cliJson(["start", "001", "--no-attach"], { env: nestedEnv, cwd: f.repoDir });
  check(r.status === 0, `ST-nested-hygiene: start succeeds with nested-harness vars (${r.status}: ${r.err.trim()})`);
  const scriptPath = r.data && path.join(r.data.session_dir, "launch.sh");
  if (scriptPath && fs.existsSync(scriptPath)) {
    const paneEnv = { TERM: "xterm-256color", ZMX_SESSION: "z", HOME: process.env.HOME, PATH: "/usr/bin:/bin",
      CLAUDE_LOG: process.env.CLAUDE_LOG, CLAUDE_ENV_DUMP: dumpFile };
    spawnSync("sh", [scriptPath], { env: paneEnv, encoding: "utf8", timeout: HANG_GUARD_MS });
    if (fs.existsSync(dumpFile)) {
      const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
      const claudeCodeKeys = Object.keys(dump).filter((k) => k.startsWith("CLAUDE_CODE_"));
      check(claudeCodeKeys.length === 0, `ST-nested-hygiene: no CLAUDE_CODE_ key reaches the session (${claudeCodeKeys.join(", ") || "none"})`);
      check(!("CLAUDE_PID" in dump), "ST-nested-hygiene: CLAUDE_PID does not reach the session");
      check(!("AGENTS_LAND" in dump), "ST-nested-hygiene: AGENTS_LAND does not reach the session");
    } else {
      check(false, "ST-nested-hygiene: the dump was written");
    }
  } else {
    check(false, "ST-nested-hygiene: launch.sh was written");
  }
}

// LO1-LO5: a launch occupancy refusal — exact-target matching like start.
{
  // LO1: a live registration on the target cwd → a launch refuses with checkout_busy, no spawn.
  fixture("lo1");
  {
    const claude = spawnClaude();
    register({ session_id: "aaaa1001-0000-4000-8000-000000000001", terminal_id: "lo1-occ", pid: claude.pid, pid_at: nowIso() });
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root, "--json"]);
    check(r.status === 2 && /has a live/.test(r.err) && /--here/.test(r.err), `LO1: a launch into an occupied cwd refuses with checkout_busy (${r.status}: ${r.err.trim().slice(0, 120)})`);
    let data = null;
    try { data = JSON.parse(r.out); } catch {}
    check(data && data.error === "checkout_busy", `LO1: the refusal carries the checkout_busy code (${data && data.error})`);
    check(data && data.occupant && data.occupant.session_id === "aaaa1001-0000-4000-8000-000000000001", `LO1: the refusal carries the occupant detail (${data && data.occupant && data.occupant.session_id})`);
    check(claudeCalls().length === 0, `LO1: no claude spawn (${claudeCalls().length})`);
  }

  // LO2: --here escape → the spawn happens.
  fixture("lo2");
  {
    const claude = spawnClaude();
    register({ session_id: "aaaa2002-0000-4000-8000-000000000002", terminal_id: "lo2-occ", pid: claude.pid, pid_at: nowIso() });
    const dumpFile = path.join(cur.root, "lo2-dump.env");
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root, "--here", "--", "--session-id", "lo2-sid"], { env: { CLAUDE_ENV_DUMP: dumpFile } });
    check(r.status === 0, `LO2: --here launches into an occupied cwd (${r.status}: ${r.err.trim().slice(0, 120)})`);
    check(claudeCalls().length > 0, `LO2: the spawn happened (${claudeCalls().length})`);
    if (fs.existsSync(dumpFile)) {
      const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
      check(!("CLAUDE_CODE_SESSION_ID" in dump), `LO2: the env dump is clean of CLAUDE_CODE_SESSION_ID`);
    }
  }

  // LO3: a live session on a different cwd → launches, no refusal.
  fixture("lo3");
  {
    const claude = spawnClaude();
    const otherDir = mk("lo3-other");
    register({ session_id: "aaaa3003-0000-4000-8000-000000000003", terminal_id: "lo3-occ", pid: claude.pid, pid_at: nowIso(), cwd: otherDir });
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root]);
    check(r.status === 0, `LO3: a launch into an unoccupied cwd succeeds (${r.status})`);
    check(claudeCalls().length > 0, `LO3: the spawn happened (${claudeCalls().length})`);
  }

  // LO4: a main-root occupant does not block a worktree launch.
  fixture("lo4");
  {
    const claude = spawnClaude();
    register({ session_id: "aaaa4004-0000-4000-8000-000000000004", terminal_id: "lo4-occ", pid: claude.pid, pid_at: nowIso() });
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root, "--worktree", "lo4-wt"]);
    check(r.status === 0, `LO4: a main-root occupant does not block a worktree launch (${r.status})`);
    check(claudeCalls().length > 0, `LO4: the spawn happened (${claudeCalls().length})`);
  }

  // LO5: the caller's own session id → no self-refusal.
  fixture("lo5");
  {
    const claude = spawnClaude();
    const ownSid = "aaaa5005-0000-4000-8000-000000000005";
    register({ session_id: ownSid, terminal_id: "lo5-occ", pid: claude.pid, pid_at: nowIso() });
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root], { env: { CLAUDE_CODE_SESSION_ID: ownSid } });
    check(r.status === 0, `LO5: a launch whose own session id matches the occupant does not self-refuse (${r.status})`);
    check(claudeCalls().length > 0, `LO5: the spawn happened (${claudeCalls().length})`);
  }

  // LO6: a live registration whose cwd is gone does not crash a launch for a different target.
  fixture("lo6");
  {
    const claude = spawnClaude();
    const goneDir = mk("lo6-gone");
    register({ session_id: "aaaa6006-0000-4000-8000-000000000006", terminal_id: "lo6-occ", pid: claude.pid, pid_at: nowIso(), cwd: goneDir });
    fs.rmSync(goneDir, { recursive: true, force: true });
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root]);
    check(r.status === 0, `LO6: a launch with a stale registration whose cwd is gone does not crash (${r.status}: ${r.err.trim().slice(0, 120)})`);
    check(claudeCalls().length > 0, `LO6: the spawn happened (${claudeCalls().length})`);
  }

  // LO7: a zmx timeout during a launch's occupancy check refuses exit 2 with the zmx_timeout code.
  fixture("lo7");
  {
    process.env.STUB_ZMX_LIST_SLOW_FOREVER = "7";
    const r = cli(["launch", "--agent", "conductor", "--cwd", cur.key.main_root, "--json"]);
    delete process.env.STUB_ZMX_LIST_SLOW_FOREVER;
    let data = null;
    try { data = JSON.parse(r.out); } catch {}
    check(r.status === 2 && data && data.error === "zmx_timeout", `LO7: a launch whose zmx list never answers refuses with zmx_timeout (${r.status}: ${data && data.error})`);
    check(claudeCalls().length === 0, `LO7: no claude spawn (${claudeCalls().length})`);
  }
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
