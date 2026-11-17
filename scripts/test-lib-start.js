#!/usr/bin/env node
"use strict";
// `a start`, `a attach`: registration, worktree, occupancy, fetch/switch — the
// core shard of the former test-lib-start, split (with -resume, -sweep, -setup)
// when the suite outgrew every per-suite budget; the shards share one harness.
// With stub zmx and claude.
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
    "CLAUDE_ENV_DUMP", "ZMX_PATCH_RECORD", "ZMX_PATCH_PID", "STUB_ZMX_SETUP_EXIT", "STUB_ZMX_SETUP_FAIL_ON", "ZMX_FINISH_RECORD",
    "AGENTS_SETUP_TIMEOUT_MS", "AGENTS_SETUP_LAUNCH_BELT_MS"]) delete process.env[k];
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
  // Knob-gated: a run leg can simulate the runner's first act (its pid landing
  // in the record) so a stub-hosted pane holds a live pending record.
  'if [ "$1" = run ] && [ -n "$ZMX_PATCH_RECORD" ] && [ -n "$ZMX_PATCH_PID" ]; then',
  '  node -e \'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j.pid=Number(process.argv[2]);fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\\n")}catch(e){}\' "$ZMX_PATCH_RECORD" "$ZMX_PATCH_PID"',
  'fi',
  // A run into a Setup-<id8> pane creates that session in the list (zmx run
  // creates the session it types into), unless the run is made to fail — a
  // failed run creates no session. Agent-session panes stay unlisted: the
  // suite's liveness semantics have always treated launched agent panes as
  // absent. STUB_ZMX_SETUP_EXIT fails exactly the setup-pane run, so a leg can
  // break the bootstrap's launch while the agent session's own run succeeds.
  // STUB_ZMX_SETUP_FAIL_ON fails only the nth setup-pane run (ordinal counted
  // in $ZMX_SETUP_RUN_CALLS) — the double fault: the first launch sends but
  // never verifies, the retry's send itself fails. ZMX_FINISH_RECORD
  // terminalizes the named record as the line is sent — a bootstrap that
  // finishes inside the belt: no live pid, and no pane row (the session's
  // process has already left the list).
  'if [ "$1" = run ]; then',
  '  case "$2" in',
  '    Setup-*)',
  '      if [ -n "$STUB_ZMX_SETUP_EXIT" ]; then',
  '        printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  '        echo "cwd $PWD" >> "$ZMX_LOG"',
  '        exit "$STUB_ZMX_SETUP_EXIT"',
  '      fi',
  '      if [ -n "$STUB_ZMX_SETUP_FAIL_ON" ]; then',
  '        c=0',
  '        [ -f "$ZMX_SETUP_RUN_CALLS" ] && c=$(cat "$ZMX_SETUP_RUN_CALLS")',
  "        case \"$c\" in ''|*[!0-9]*) c=0 ;; esac",
  '        echo $((c + 1)) > "$ZMX_SETUP_RUN_CALLS"',
  '        if [ "$((c + 1))" -eq "$STUB_ZMX_SETUP_FAIL_ON" ]; then',
  '          printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  '          echo "cwd $PWD" >> "$ZMX_LOG"',
  '          exit 3',
  '        fi',
  '      fi',
  '      if [ -n "$ZMX_FINISH_RECORD" ]; then',
  '        node -e \'const fs=require("fs"),path=require("path");try{const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.state="complete";j.exit_code=0;j.finished_at=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(j,null,2)+"\\n");fs.writeFileSync(path.join(path.dirname(p),"setup-complete"),"")}catch(e){}\' "$ZMX_FINISH_RECORD"',
  '      elif [ "${STUB_ZMX_EXIT:-0}" = "0" ]; then',
  '        printf \'name=%s\\tpid=1\\tclients=0\\tcreated=1\\tcwd=/tmp\\n\' "$2" >> "$ZMX_LIST_FILE"',
  '      fi',
  '      ;;',
  '  esac',
  'fi',
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
// A dead pid the suite can plant into a record: spawnSync waits for the exit,
// so the process is reaped (a SIGKILLed detached child would stay a zombie
// under this suite's synchronous loop, and kill(pid, 0) would still succeed).
// Off the capture door: only the pid is read — no output ever is.
const deadPid = () => spawnSync("/bin/sleep", ["0.2"]).pid;
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
const gitdirOf = (wt) => execFileSync("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const readRecord = (wt) => JSON.parse(fs.readFileSync(path.join(gitdirOf(wt), "setup.json"), "utf8"));
// The record path a start's own launch will write, before the worktree's first
// start: git's per-worktree dir under the main checkout's .git.
const predictableRecord = (name) => path.join(cur.repoDir, ".git", "worktrees", name, "setup.json");
const plantRecord = (wt, fields) => {
  const gd = gitdirOf(wt);
  const rec = {
    v: 1, state: "pending", command: "true", pane_kind: "zmx", pane: null, pav_terminal_id: null,
    pid: null, log: path.join(gd, "setup.log"), started_at: nowIso(), ...fields,
  };
  fs.writeFileSync(path.join(gd, "setup.json"), JSON.stringify(rec, null, 2) + "\n");
  return rec;
};
const setupPaneRuns = () => zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Setup-"));
const markSetupDone = (wt) => { fs.writeFileSync(path.join(gitdirOf(wt), "setup-complete"), ""); };

function register(fields) {
  return session.register({
    origin: "cli", initiator: "user", agent: "conductor", cwd: cur.key.main_root, repo_key: cur.key.key,
    session_dir: path.join(cur.sessions, fields.terminal_id), ...fields,
  });
}

function cli(args, { env = {}, cwd } = {}) {
  return runCapture(process.execPath, [A, ...args], { cwd: cwd || cur.repoDir, timeout: 60000, env: { ...process.env, ...env } });
}
function cliJson(args, opts) { const r = cli([...args, "--json"], opts); return { ...r, data: r.status === 0 && r.out ? JSON.parse(r.out) : null }; }

// Every child whose stderr a check reads goes through this door. fd 2 lands in
// a per-call file the parent reads after exit: a sync pipe can drop a short
// stderr write under load while the child exits 0 (the macOS spawnSync race —
// a check then asserts content that never arrived); a file has no drain, no
// window, no race. stdout stays piped (r.out semantics unchanged). The door
// locks only the children that route through it — a raw spawn asserting stderr
// bypasses it (review catches that); the capture probe below catches the door
// itself regressing to a pipe.
function runCapture(file, args, opts = {}) {
  const errFile = path.join(T, `stderr-${++counter}.log`);
  const errFd = fs.openSync(errFile, "w");
  let r;
  try {
    r = spawnSync(file, args, { encoding: "utf8", ...opts, stdio: ["pipe", "pipe", errFd] });
  } finally {
    fs.closeSync(errFd);
  }
  const err = fs.readFileSync(errFile, "utf8");
  fs.unlinkSync(errFile);
  return { status: r.status, out: r.stdout, err };
}

// ST-cap: the door proves itself — the child reports its own fd 2 and a
// two-line write; both must arrive whole, byte-exact. fd 2 must be a regular
// file — anything else (a pipe, a socketpair, macOS spawnSync's default) is a
// sync-capture channel, and the child truthfully answers PIPE: the mechanism
// that lost ST30d's stderr under load, caught without waiting for the race
// to strike.
{
  const cap = runCapture(process.execPath, ["-e",
    "process.stderr.write('capture-probe\\n' + (require('fs').fstatSync(2).isFile() ? 'FILE' : 'PIPE') + '\\n')"]);
  check(cap.status === 0 && cap.err === "capture-probe\nFILE\n",
    `ST-cap: a child's stderr arrives whole through a file, never a sync pipe (${cap.status}: ${JSON.stringify(cap.err)})`);
}

// Calls a verb in process; a refusal comes back as `err` (with its exitCode).
function verb(name, argv, deps = {}) {
  try {
    return { res: start[name](start.parseArgs(argv, name), { cwd: cur.repoDir, ...deps }) };
  } catch (err) {
    return { err };
  }
}
const answers = (...replies) => { const asked = []; const ask = (q, choices) => { asked.push({ q, choices }); return replies.shift(); }; ask.asked = asked; return ask; };

// ---------------------------------------------------------------- zmx list parsing
// zmx 0.8.1 prints header lines without name=, indents every session line with
// two spaces, marks the current session's line with "→ " before name=, keeps
// ended sessions listed with an ended= field, and separates fields with tabs.
// The lines below are captured from a real `zmx list` (paths shortened).
{
  process.env.ZMX_LIST_FILE = path.join(T, "zmx-parse.txt");
  setZmx([
    "zmx\t\t0.8.1",
    "socket_dir\t/var/folders/zmx-501",
    "  name=Conductor-2eec64bc\tpid=15866\tclients=0\tcreated=1793528145\tcwd=file:///tmp/one",
    "→ name=Courier-0565b67e\tpid=63740\tclients=1\tcreated=1793528867\tcwd=file:///tmp/two",
    "  name=Courier-9f0e3210\tpid=72018\tclients=0\tcreated=1793529031\tcwd=file:///tmp\tended=1793529033\texit_code=0",
  ]);
  const parsed = start.zmxSessions();
  check(JSON.stringify(parsed) === JSON.stringify([
    { name: "Conductor-2eec64bc", ended: false },
    { name: "Courier-0565b67e", ended: false },
    { name: "Courier-9f0e3210", ended: true },
  ]), `ZMX1: zmxSessions reads zmx 0.8.1 lines: indent, current-session marker, tabs, ended (${JSON.stringify(parsed)})`);

  setZmx([]);
  check(JSON.stringify(start.zmxSessions()) === "[]", "ZMX2: an empty zmx list parses as [] (zmx knows no session)");

  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  check(start.zmxSessions() === null, "ZMX3: a missing zmx is null, not []");
  process.env.PATH = savedPath;
}

// ---------------------------------------------------------------- start
// ST1: the registration and the launch script.
fixture("st1");
{
  const r = cliJson(["start", "001", "--no-attach"]);
  const d = r.data;
  const id8 = d && d.session_id.slice(0, 8);
  const reg = d && readReg(d.session_dir);
  check(r.status === 0 && d && d.session_dir === path.join(cur.sessions, d.terminal_id), `ST1: registers under <sessions>/<terminal_id> (exit ${r.status}: ${r.err.trim()})`);
  check(reg && reg.task_dir === cur.tasks[1] && reg.origin === "cli" && reg.initiator === "user" && reg.agent === "conductor" && reg.pid === null && reg.mux.name === `Conductor-${id8}`,
    `ST1: the registration binds task 001 with no pid and the zmx name (${JSON.stringify(reg)})`);
  const scriptPath = d && path.join(d.session_dir, "launch.sh");
  const argvs = zmxRunArgvs();
  check(argvs.length === 1 && JSON.stringify(argvs[0]) === JSON.stringify(["run", `Conductor-${id8}`, "-d", "exec", "sh", scriptPath]), `ST1: one zmx run whose argv execs sh <script>, so the pane ends with claude (${JSON.stringify(argvs)})`);
  check(d && fs.existsSync(scriptPath) && (fs.statSync(scriptPath).mode & 0o777) === 0o600, `ST1: launch.sh is written mode 0600`);
  check(!zmxCalls().some((l) => l.startsWith("zmx attach")), "ST1: --no-attach does not attach");
}

// ST1v: a PAV-shaped launcher (foreign venv bin first on PATH, no VIRTUAL_ENV) with an allowed
// checkout-relative .envrc — the session gets the folder's own venv, not the launcher's.
fixture("st1v");
{
  // The repo's .envrc: export T_V and PATH_add the repo's own .venv/bin
  fs.mkdirSync(path.join(cur.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(cur.repoDir, ".envrc"), 'export T_V=x\nPATH_add .venv/bin\n');
  execFileSync("direnv", ["allow"], { cwd: cur.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });

  // PAV-shaped launcher: <pav>/bin first on PATH with pyvenv.cfg beside it, no VIRTUAL_ENV
  const pav = mk("pav-venv");
  fs.mkdirSync(path.join(pav, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pav, "pyvenv.cfg"), "home = /usr/bin\n");
  const pavPath = `${path.join(pav, "bin")}:${process.env.PATH}`;

  const dumpFile = path.join(cur.root, "st1v-dump.env");
  const r = cliJson(["start", "001", "--no-attach"], { env: { PATH: pavPath, CLAUDE_ENV_DUMP: dumpFile } });
  const d = r.data;
  check(r.status === 0, `ST1v: start succeeds with a PAV-shaped launcher (${r.status}: ${r.err.trim()})`);

  const scriptPath = d && path.join(d.session_dir, "launch.sh");
  check(d && fs.existsSync(scriptPath), `ST1v: launch.sh is written (${scriptPath})`);

  // launch.env-names: names only, no values
  const namesPath = d && path.join(d.session_dir, "launch.env-names");
  check(d && fs.existsSync(namesPath), `ST1v: launch.env-names is written`);
  if (d && fs.existsSync(namesPath)) {
    const names = fs.readFileSync(namesPath, "utf8").split("\n").filter(Boolean);
    check(names.includes("T_V") && names.includes("PATH"), "ST1v: launch.env-names has E1's keys");
    for (const name of names) check(!name.includes("="), `ST1v: launch.env-names is names-only (${name})`);
  }

  // Execute launch.sh under a simulated pane env — env -i clears PANE_JUNK
  const paneEnv = {
    TERM: "xterm-256color", ZMX_SESSION: "pane-zmx", HOME: process.env.HOME,
    PATH: "/usr/bin:/bin", PANE_JUNK: "junk",
    CLAUDE_LOG: process.env.CLAUDE_LOG, CLAUDE_ENV_DUMP: dumpFile,
  };
  const ran = runCapture("sh", [scriptPath], { env: paneEnv, timeout: HANG_GUARD_MS });
  check(ran.status === 0, `ST1v: launch.sh executes cleanly under the pane env (${ran.status}: ${ran.err.slice(-200)})`);

  // The dump equals E1 (what the agent sees)
  const dump = parseEnvNul(fs.readFileSync(dumpFile, "utf8"));
  check(dump.T_V === "x", `ST1v: T_V is present in the session env`);
  const pathEntries = (dump.PATH || "").split(":");
  check(pathEntries[0] === path.join(cur.repoDir, ".venv", "bin"), `ST1v: <repo>/.venv/bin is first on PATH (${pathEntries[0]})`);
  check(!pathEntries.includes(path.join(pav, "bin")), "ST1v: <pav>/bin is absent from the session PATH");
  check(!Object.keys(dump).some((k) => k.startsWith("DIRENV_")), "ST1v: no DIRENV_* in the session env");
  check(!("PANE_JUNK" in dump), "ST1v: PANE_JUNK does not reach the session (env -i clears it)");
  // The builder strips _/SHLVL/OLDPWD from E1; the stub's shell adds _ and SHLVL back,
  // so check the names file (E1's keys) instead of the dump for their absence.
  const namesContent = fs.readFileSync(namesPath, "utf8").split("\n").filter(Boolean);
  check(!namesContent.includes("_") && !namesContent.includes("SHLVL") && !namesContent.includes("OLDPWD"), "ST1v: no evaluation noise in E1 (names file)");
  check(!("VIRTUAL_ENV" in dump) && !("POETRY_ACTIVE" in dump), "ST1v: no venv markers in the session env");

  // The script self-removed; launch.env-names survives
  check(!fs.existsSync(scriptPath), "ST1v: launch.sh self-removed after execution");
  check(fs.existsSync(namesPath), "ST1v: launch.env-names survives after execution");
}

// ST2: attach after the run, unless inside zmx.
fixture("st2");
{
  const first = cli(["start", "001"]);
  const name = session.entries()[0].registration.mux.name;
  check(first.status === 0 && zmxRuns().length === 1 && zmxCalls().pop() === `zmx attach ${name}`, `ST2: the run is followed by zmx attach ${name} (${zmxCalls().pop()})`);
  const before = zmxCalls().length;
  const second = cli(["start", "002"], { env: { ZMX_SESSION: "x" } });
  const after = zmxCalls().slice(before);
  check(second.status === 0 && !after.some((l) => l.startsWith("zmx attach")) && /zmx attach Conductor-\w{8}/.test(second.out),
    `ST2: inside zmx nothing attaches and the command is printed (${JSON.stringify(second.out)})`);
}

// ST3: a Courier with a title makes a fast, minor task.
fixture("st3");
{
  const r = cliJson(["start", "--courier", "--title", "Fix typo", "--no-attach"]);
  const doc = r.data && taskLib.readTaskJson(r.data.task_dir);
  const reg = r.data && readReg(r.data.session_dir);
  check(doc && doc.mode === "fast" && doc.tier === "minor" && doc.title === "Fix typo", `ST3: the task is fast and minor (${doc && doc.mode}/${doc && doc.tier})`);
  check(reg && reg.task_dir === r.data.task_dir && reg.agent === "courier" && reg.mux.name.startsWith("Courier-"), "ST3: the registration binds the new task as a courier");
}

// ST4: a running session on the main checkout and no way to choose refuses and creates nothing.
fixture("st4");
{
  const claude = spawnClaude();
  register({ session_id: "aaaa0004-0000-4000-8000-000000000004", terminal_id: "t4", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const dbBefore = db.listTasks({ disposition: "active" }).length;
  const one = cli(["start", "002", "--no-attach"]);
  const two = cli(["start", "--title", "late", "--no-attach"]);
  check(one.status === 2 && one.err.includes("--worktree") && one.err.includes("--here"), `ST4: an occupied checkout refuses naming both flags (${one.status}: ${one.err.trim()})`);
  check(two.status === 2 && two.err.includes("--worktree") && two.err.includes("--here"), `ST4: a titled start refuses the same way (${two.status})`);
  check(session.entries().length === 1 && zmxCalls().length === 0, "ST4: no entry added and zmx never called");
  check(taskCount() === 2 && db.listTasks({ disposition: "active" }).length === dbBefore && !fs.existsSync(trashDir()), "ST4: no task created, none trashed");
}

// ST4b: the task itself is already running outside zmx.
fixture("st4b");
{
  const claude = spawnClaude();
  register({ session_id: "aaaa0041-0000-4000-8000-000000000041", terminal_id: "t41", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const refused = cli(["start", "001", "--no-attach"]);
  check(refused.status === 2 && refused.err.includes("a resume 001") && session.entries().length === 1 && zmxRuns().length === 0,
    `ST4b: without a TTY the refusal points to a resume 001 (${refused.status}: ${refused.err.trim()})`);
  const attach = verb("start", ["001", "--no-attach"], { ask: answers("attach") });
  check(attach.err && attach.err.exitCode === 4 && attach.err.message.includes("runs outside zmx") && zmxRuns().length === 0,
    `ST4b: choosing attach for a pid-only session is refused with exit 4 (${attach.err && attach.err.message})`);
  const cancel = verb("start", ["001", "--no-attach"], { ask: answers("cancel") });
  check(cancel.err && cancel.err.exitCode === 1 && session.entries().length === 1, "ST4b: cancel exits 1 and registers nothing");
}

// ST4c: choosing attach for a task running in zmx attaches to it.
fixture("st4c");
{
  setZmx([zl("Conductor-aaaa0040")]);
  register({ session_id: "aaaa0040-0000-4000-8000-000000000040", terminal_id: "t40", mux: { kind: "zmx", name: "Conductor-aaaa0040" }, task_dir: cur.tasks[1] });
  const r = verb("start", ["001", "--no-attach"], { ask: answers("attach") });
  check(!r.err && zmxCalls().pop() === "zmx attach Conductor-aaaa0040" && zmxRuns().length === 0, `ST4c: attach reaches the running zmx session (${zmxCalls().pop()}, ${r.err && r.err.message})`);
}

// ST4d: --repo names the repo while the cwd is outside any repo; a live session on the task is still found and attached.
// Live entries: one, aaaa0042 (zmx name Conductor-aaaa0042) on task 001. Listed zmx names: Conductor-aaaa0042 only.
// Isolation: AGENTS_DB, AGENTS_SESSIONS_ROOT and AGENTS_TASKS_ROOT are the fixture's own (set by fixture()).
fixture("st4d");
{
  const outside = mk("outside");
  setZmx([zl("Conductor-aaaa0042")]);
  register({ session_id: "aaaa0042-0000-4000-8000-000000000042", terminal_id: "t42", mux: { kind: "zmx", name: "Conductor-aaaa0042" }, task_dir: cur.tasks[1] });
  const refused = cli(["start", "001", "--repo", cur.repoDir, "--no-attach"], { cwd: outside });
  check(refused.status === 2 && refused.err.includes("a resume aaaa0042") && refused.err.includes("a resume 001-one") && zmxRuns().length === 0,
    `ST4d: the no-TTY refusal names an id8 that resolves from anywhere (${refused.status}: ${refused.err.trim()})`);
  const attached = verb("start", ["001", "--repo", cur.repoDir, "--no-attach"], { cwd: outside, ask: answers("attach") });
  check(!attached.err && zmxCalls().pop() === "zmx attach Conductor-aaaa0042" && zmxRuns().length === 0,
    `ST4d: answering attach from outside the repo attaches to the found entry (${zmxCalls().pop()}, ${attached.err && attached.err.message})`);
}

// ST5: --worktree gives the task its own worktree, reused on the next run.
fixture("st5", { defaultRoot: true });
{
  const first = cliJson(["start", "002", "--worktree", "--no-attach"]);
  const wt = path.join(process.env.HOME, ".agents", "worktrees", "acme", "002-two");
  const row = require("./lib/db").getTask(require("./lib/db").taskIdOf(cur.tasks[2]));
  check(first.status === 0 && first.data.cwd === wt && git(cur.key.main_root, "branch", "--list", "wt/002-two").includes("wt/002-two"),
    `ST5: the session runs in ~/.agents/worktrees/acme/002-two on branch wt/002-two (${first.status}: ${first.err.trim()})`);
  check(row.branch === "wt/002-two" && row.worktree_path === wt, `ST5: the row carries the worktree record (${JSON.stringify({ branch: row.branch, worktree_path: row.worktree_path })})`);
  check(!fs.existsSync(path.join(wt, ".tasks")) || fs.readdirSync(path.join(wt, ".tasks"), { withFileTypes: true }).every((e) => e.isSymbolicLink()), "ST5: the worktree's .tasks entries are symlinks");
  check(!fs.existsSync(path.join(cur.key.main_root, ".tasks")) || fs.readdirSync(path.join(cur.key.main_root, ".tasks"), { withFileTypes: true }).every((e) => e.isSymbolicLink()), "ST5: the main checkout's .tasks entries are symlinks");
  const second = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(second.status === 0 && second.data.cwd === wt, `ST5: the second run reuses the worktree (${second.status}: ${second.err.trim()})`);
}

// ST5b: argument forms, the passthrough and refusals.
fixture("st5b");
{
  const wt = wtPath("002-two");
  const a = cliJson(["start", "--worktree", "002", "--no-attach"]);
  const b = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(a.status === 0 && b.status === 0 && a.data.task_dir === cur.tasks[2] && b.data.task_dir === cur.tasks[2] && a.data.cwd === wt && b.data.cwd === wt && !zmxCalls().some((l) => l.startsWith("zmx attach")),
    `ST5b: the flag before or after the task binds 002 in the worktree (${a.status}/${b.status}: ${a.err.trim()}${b.err.trim()})`);
  const c = cli(["start", "002", "--worktree", "--no-attach", "--", "--model", "opus"]);
  const cRun = zmxRunArgvs().pop();
  const cScript = cRun && cRun[5] && fs.existsSync(cRun[5]) ? fs.readFileSync(cRun[5], "utf8") : "";
  check(c.status === 0 && cScript.includes("'--model' 'opus'"), `ST5b: arguments after -- reach claude (${c.status}: ${cScript.slice(-80)})`);
  const extra = cli(["start", "002", "003"]);
  const bogus = cli(["start", "002", "--bogus"]);
  check(extra.status === 2 && extra.err.includes("003"), `ST5b: a second positional exits 2 naming it (${extra.status}: ${extra.err.trim()})`);
  check(bogus.status === 2 && bogus.err.includes("--bogus"), `ST5b: an unknown flag exits 2 naming it (${bogus.status}: ${bogus.err.trim()})`);
  const calls = zmxCalls().length;
  const help = cli(["start", "--help"]);
  const helpBogus = cli(["start", "002", "--bogus", "--help"]);
  check(help.status === 0 && help.out.includes("Usage: a start") && helpBogus.status === 0 && helpBogus.out.includes("Usage: a start") && zmxCalls().length === calls,
    `ST5b: --help prints usage, exits 0 and runs nothing (${help.status}/${helpBogus.status})`);
}

// ST5c: a branch that outlived its worktree is checked out again with its commits.
fixture("st5c");
{
  const wt = wtPath("002-two");
  cli(["start", "002", "--worktree", "--no-attach"]);
  git(wt, "commit", "-q", "--allow-empty", "-m", "extra work");
  git(cur.key.main_root, "worktree", "remove", "--force", wt);
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0 && r.data.cwd === wt && git(wt, "rev-parse", "--abbrev-ref", "HEAD") === "wt/002-two" && git(wt, "log", "-1", "--format=%s") === "extra work",
    `ST5c: the old branch comes back with its commit (${r.status}: ${r.err.trim()})`);
  check(!fs.existsSync(path.join(wt, ".tasks")) || fs.readdirSync(path.join(wt, ".tasks"), { withFileTypes: true }).every((e) => e.isSymbolicLink()), "ST5c: the re-checkout's .tasks entries are symlinks");
}

// ST6: --here uses the occupied main checkout.
fixture("st6");
{
  const claude = spawnClaude();
  register({ session_id: "aaaa0006-0000-4000-8000-000000000006", terminal_id: "t6", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const r = cliJson(["start", "002", "--here", "--no-attach"]);
  check(r.status === 0 && r.data.cwd === cur.key.main_root && readReg(r.data.session_dir).cwd === cur.key.main_root, `ST6: --here runs in the main checkout (${r.status}: ${r.err.trim()})`);
}

// ST6b: a task whose wt/ branch is checked out goes to its worktree even with --here.
// Live entries: one claude on task 001 in the main checkout. zmx names listed: none.
fixture("st6b");
{
  const wt = wtPath("002-two");
  cli(["start", "002", "--worktree", "--no-attach"]);
  const claude = spawnClaude();
  register({ session_id: "aaaa006b-0000-4000-8000-00000000006b", terminal_id: "t6b", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const r = cliJson(["start", "002", "--here", "--no-attach"]);
  check(r.status === 0 && r.data.cwd === wt, `ST6b: --here still runs the task in its checked-out worktree (${r.status}: ${r.err.trim()}; cwd ${r.data && r.data.cwd})`);
}

// ST7: the occupancy question.
fixture("st7");
{
  const claude = spawnClaude();
  register({ session_id: "aaaa0007-0000-4000-8000-000000000007", terminal_id: "t7", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const ask = answers("worktree");
  const w = verb("start", ["002", "--no-attach", "--json"], { ask });
  check(w.res && w.res.json.cwd === wtPath("002-two") && ask.asked[0].choices.includes("worktree"), `ST7: answering worktree opens the worktree (${w.err && w.err.message})`);
  const entries = session.entries().length;
  const c1 = verb("start", ["001", "--no-attach"], { ask: answers("cancel") });
  const c2 = verb("start", ["--title", "gone", "--no-attach"], { ask: answers("cancel") });
  check(c1.err && c1.err.exitCode === 1 && c2.err && c2.err.exitCode === 1 && session.entries().length === entries && taskCount() === 2,
    `ST7: cancelling registers nothing and leaves no task (${c1.err && c1.err.exitCode}/${c2.err && c2.err.exitCode}, ${taskCount()} tasks)`);
}

// ST8: an unknown task.
fixture("st8");
{
  const refused = cli(["start", "nope", "--no-attach"]);
  check(refused.status === 2 && refused.err.includes("--title") && taskCount() === 2, `ST8: without a TTY the refusal names --title (${refused.status}: ${refused.err.trim()})`);
  const r = verb("start", ["nope", "--no-attach", "--json"], { ask: answers("yes") });
  const doc = r.res && taskLib.readTaskJson(r.res.json.task_dir);
  check(doc && doc.title === "nope" && readReg(r.res.json.session_dir).task_dir === r.res.json.task_dir, `ST8: answering yes creates and binds the task (${r.err && r.err.message})`);
}

// ST9: a failed zmx run is rolled back.
fixture("st9");
{
  const r = cli(["start", "--title", "fails", "--worktree", "--no-attach"], { env: { STUB_ZMX_EXIT: "1" } });
  const entries = session.entries();
  const trashed = fs.existsSync(trashDir()) && fs.readdirSync(trashDir()).some((day) => fs.readdirSync(path.join(trashDir(), day, cur.key.key)).includes("003-fails"));
  check(r.status !== 0, `ST9: the failed run exits non-zero (${r.status})`);
  check(entries.length === 1 && entries[0].registration.ended_at && path.basename(entries[0].dir) === entries[0].registration.terminal_id && !fs.existsSync(path.join(cur.sessions, entries[0].registration.session_id)),
    "ST9: the one registration is ended and no <session_id> dir appeared");
  check(trashed && !db.listTasks({ disposition: "active" }).some((t) => t.dir_name === "003-fails"), "ST9: the new task is in the trash and not active");
  check(!fs.existsSync(wtPath("003-fails")), "ST9: the worktree is gone");
}

// ST9b: without zmx claude runs in the foreground and nothing is rolled back.
fixture("st9b");
{
  const r = cli(["start", "--title", "ran", "--worktree", "--no-attach"], { env: { PATH: `${claudeOnlyBin}:/usr/bin:/bin`, STUB_CLAUDE_EXIT: "3" } });
  const entries = session.entries();
  check(r.status === 3 && claudeCalls().length === 1 && claudeCalls()[0].includes("--session-id"), `ST9b: the foreground claude's exit code is the verb's (${r.status}: ${r.err.trim()})`);
  check(taskCount() === 3 && fs.existsSync(wtPath("003-ran")) && entries.length === 1 && !entries[0].registration.ended_at, "ST9b: task, worktree and registration stay");
}

// ZMX4: a `zmx list` that times out once retries, so a start still goes through zmx (not the foreground).
fixture("zmx4");
{
  const callsFile = path.join(cur.root, "list-calls");
  fs.writeFileSync(callsFile, "");
  process.env.STUB_ZMX_LIST_SLOW_ONCE = "3";
  process.env.ZMX_LIST_CALLS = callsFile;
  const r = verb("start", ["001", "--here", "--no-attach"], {});
  delete process.env.STUB_ZMX_LIST_SLOW_ONCE;
  delete process.env.ZMX_LIST_CALLS;
  check(r.res && r.res.exitCode === 0, `ZMX4: the start succeeds after the retry (${r.err && r.err.message})`);
  check(claudeCalls().length === 0, `ZMX4: the agent runs in zmx, not the foreground (${claudeCalls().length} foreground claude call(s))`);
  check(zmxRuns().length === 1, `ZMX4: one zmx run was issued (${zmxRuns().length})`);
  check(fs.readFileSync(callsFile, "utf8").trim() === "2", `ZMX4: zmx list was called twice (one timed out, one retry)`);
}

// ZMX5: a `zmx list` that never answers in time refuses with zmx_timeout instead of the silent foreground branch.
fixture("zmx5");
{
  process.env.STUB_ZMX_LIST_SLOW_FOREVER = "7";
  const r = verb("start", ["001", "--here", "--no-attach"], {});
  delete process.env.STUB_ZMX_LIST_SLOW_FOREVER;
  check(r.err && r.err.code === "zmx_timeout" && r.err.exitCode === 2,
    `ZMX5: a start whose zmx list never answers refuses with zmx_timeout (${r.res ? "foreground exit " + r.res.exitCode : JSON.stringify(r.err && { code: r.err.code, exitCode: r.err.exitCode })})`);
  check(r.err && r.err.detail && typeof r.err.detail.remedy === "string",
    `ZMX5: the refusal names a remedy (${r.err && r.err.detail ? JSON.stringify(Object.keys(r.err.detail)) : "no detail"})`);
  check(claudeCalls().length === 0, `ZMX5: no foreground claude ran on a timed-out zmx list (${claudeCalls().length} call(s))`);
}

// ST10: the config's launch command and env file.
fixture("st10");
{
  const envFile = path.join(cur.root, "claude.env");
  fs.writeFileSync(envFile, "FKEY=fval\n");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: envFile } }));
  const a = cliJson(["start", "001", "--no-attach"]);
  const scriptPath = a.data && path.join(a.data.session_dir, "launch.sh");
  const argv = zmxRunArgvs().pop();
  check(a.status === 0 && argv && JSON.stringify(argv) === JSON.stringify(["run", a.data.mux.name, "-d", "exec", "sh", scriptPath]), `ST10: the zmx argv is the short script invocation (${a.status}: ${JSON.stringify(argv)})`);
  check(a.data && fs.readFileSync(scriptPath, "utf8").includes("'FKEY'='fval'"), `ST10: the env file key is merged into the launch script (not the typed line)`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: path.join(cur.root, "missing.env") } }));
  const runs = zmxRuns().length, entries = session.entries().length;
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 2 && b.err.includes(path.join(cur.root, "missing.env")) && zmxRuns().length === runs && session.entries().length === entries && taskCount() === 2,
    `ST10: a missing env file exits 2 naming it and changes nothing (${b.status}: ${b.err.trim()})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { command: "myclaude" } }));
  const c = cliJson(["start", "002", "--no-attach"]);
  const cScript = c.data && path.join(c.data.session_dir, "launch.sh");
  const cArgv = zmxRunArgvs().pop();
  check(c.status === 0 && JSON.stringify(cArgv) === JSON.stringify(["run", c.data.mux.name, "-d", "exec", "sh", cScript]), `ST10: launch.command replaces claude (${JSON.stringify(cArgv)})`);
  check(c.data && fs.readFileSync(cScript, "utf8").includes("'myclaude'"), `ST10: the launch script uses myclaude as argv[0]`);
}

// ST10b: a relative env file resolves against the config file's directory.
fixture("st10b");
{
  const cfgDir = path.join(cur.root, "cfg");
  fs.mkdirSync(path.join(cfgDir, "env"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "env", "claude.env"), "FKEY=fval\n");
  process.env.AGENTS_CONFIG_PATH = path.join(cfgDir, "config.json");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: "env/claude.env" } }));
  const a = cliJson(["start", "001", "--no-attach"]);
  const w = zmxRunArgvs().pop() || [];
  check(a.status === 0 && w.length === 6 && JSON.stringify([w[0], w[2], w[3], w[4]]) === JSON.stringify(["run", "-d", "exec", "sh"]), `ST10b: the zmx argv is the short script invocation (${a.status}: ${JSON.stringify(w)})`);
  check(a.data && fs.readFileSync(path.join(a.data.session_dir, "launch.sh"), "utf8").includes("'FKEY'='fval'"), `ST10b: the relative env file's key is in the launch script`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: "env/missing.env" } }));
  const runs = zmxRuns().length, entries = session.entries().length;
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 2 && b.err.includes(path.join(cfgDir, "env", "missing.env")) && zmxRuns().length === runs && session.entries().length === entries && taskCount() === 2,
    `ST10b: a missing relative env file exits 2 naming the resolved path (${b.status}: ${b.err.trim()})`);
  process.env.AGENTS_CONFIG_PATH = path.join(T, "cfg.json");
}

// ST11: arguments after -- reach claude (now in the launch script, not the typed line).
fixture("st11");
{
  const r = cli(["start", "001", "--no-attach", "--", "--model", "opus"]);
  const lastRun = zmxRunArgvs().pop();
  const scriptPath = lastRun && lastRun[5];
  check(r.status === 0 && scriptPath && fs.readFileSync(scriptPath, "utf8").includes("'--model' 'opus'"), `ST11: the passthrough reaches the launch script (${r.status}: ${r.err.trim()})`);
}

// ST12: the fetch before the run.
fixture("st12");
{
  const moved = cur.origin + ".moved";
  fs.renameSync(cur.origin, moved);
  const a = cli(["start", "001", "--no-attach"]);
  check(a.status === 0 && a.err.trim().split("\n").length === 1 && a.err.includes("fetch") && zmxRuns().length === 1, `ST12: a failed fetch warns once and the run goes on (${a.status}: ${a.err.trim()})`);
  fs.renameSync(moved, cur.origin);
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  git(second, "commit", "-q", "--allow-empty", "-m", "ahead");
  git(second, "push", "-q", "origin", "HEAD:main");
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 0 && (b.out + b.err).includes("local main is 1 commits behind origin/main")
    && (b.out + b.err).includes("pulled main forward 1 commits to origin/main")
    && git(cur.key.main_root, "rev-list", "--count", "main") === "2" && zmxRuns().length === 2,
    `ST12: a clean fast-forward on the main checkout pulls the base and the run goes on (${b.status}: ${b.out}${b.err})`);

  // 3: the same failed fetch on the worktree path — the cut would begin from a
  // ref the engine knows it failed to refresh: the start refuses, and no
  // worktree, task or session is left behind.
  fs.renameSync(cur.origin, moved);
  fs.rmSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), { force: true });
  const c = cli(["start", "002", "--worktree", "--no-attach", "--json"]);
  const cj = c.status === 2 && c.out ? JSON.parse(c.out) : null;
  check(c.status === 2 && cj && cj.error === "fetch_failed" && c.err.includes("could not fetch origin main")
    && c.err.includes("fix the remote or the network") && !fs.existsSync(wtPath("002-two")) && zmxRuns().length === 2,
    `ST12: a worktree start whose fetch ran and failed refuses (${c.status}: ${c.err.trim().slice(-160)})`);
  fs.renameSync(moved, cur.origin);
}

// ST12b: the fetch throttle — refs/remotes/origin/main moves only when the fetch
// runs, so the ref value proves which path a start took. No wall clock anywhere.
// Every start rides --worktree: the throttle runs before the worktree decision
// and is path-independent, and a worktree start never touches the main checkout,
// so local main stays put and the behind counts below keep their meaning.
fixture("st12b");
{
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const track = () => git(cur.key.main_root, "rev-parse", "refs/remotes/origin/main").trim();
  const fh = () => path.join(cur.key.main_root, ".git", "FETCH_HEAD");

  push("ahead1");
  const ahead1 = git(second, "rev-parse", "HEAD");
  const a = cli(["start", "001", "--worktree", "--no-attach"]);
  check(a.status === 0 && track() === ahead1 && (a.out + a.err).includes("1 commits behind"),
    `ST12b: no FETCH_HEAD: the start fetches and reports behind (${a.status}: ${(a.out + a.err).trim().slice(-160)})`);

  push("ahead2");
  const ahead2 = git(second, "rev-parse", "HEAD");
  const b = cli(["start", "002", "--worktree", "--no-attach"]);
  check(b.status === 0 && track() === ahead1 && (b.out + b.err).includes("1 commits behind"),
    `ST12b: a fresh FETCH_HEAD skips the fetch: the ref stays at ahead1, the local check still warns (${b.status}: ${(b.out + b.err).trim().slice(-160)})`);

  const aged = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(fh(), aged, aged); // past the window
  const c = cli(["start", "001", "--worktree", "--no-attach"]);
  check(c.status === 0 && track() === ahead2 && (c.out + c.err).includes("2 commits behind"),
    `ST12b: a FETCH_HEAD older than the window fetches again and catches up (${c.status}: ${(c.out + c.err).trim().slice(-160)})`);

  push("ahead3");
  fs.writeFileSync(fh(), ""); // what git leaves after a failed fetch: empty, mtime now (measured)
  const d = cli(["start", "002", "--worktree", "--no-attach"]);
  check(d.status === 0 && track() === git(second, "rev-parse", "HEAD") && (d.out + d.err).includes("3 commits behind"),
    `ST12b: an empty FETCH_HEAD (a fetch that failed) never skips the fetch (${d.status}: ${(d.out + d.err).trim().slice(-160)})`);
}

// ST12c: what the clean fast-forward requires — the pull fires only for a
// start that will run on the main checkout, free, on the base branch, with
// no tracked file touched; every miss leaves the checkout as today: warned
// behind, nothing moved, the session still runs.
fixture("st12c");
{
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const rmFetchHead = () => fs.rmSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), { force: true });
  const mainCount = () => git(cur.key.main_root, "rev-list", "--count", "main");
  const out = (r) => r.out + r.err;

  // a: dirty tracked file — the start refuses with the remedy; nothing runs,
  // nothing moves, the tree keeps its dirt.
  push("c1");
  rmFetchHead();
  fs.appendFileSync(path.join(cur.repoDir, "README.md"), "dirty\n");
  const a = cli(["start", "001", "--no-attach", "--json"]);
  const aj = a.status === 2 && a.out ? JSON.parse(a.out) : null;
  check(a.status === 2 && aj && aj.error === "dirty_tree" && a.err.includes("has uncommitted changes")
    && a.err.includes("--worktree") && mainCount() === "1" && !out(a).includes("pulled") && zmxRuns().length === 0
    && fs.readFileSync(path.join(cur.repoDir, "README.md"), "utf8").endsWith("dirty\n"),
    `ST12c: a dirty tree refuses the start (${a.status}: ${a.err.trim()})`);
  git(cur.repoDir, "checkout", "--", "README.md");

  // a2: the same dirt beside a live session — occupancy waives the whole gate
  // (the session's working state is its own); --here proceeds, no pull.
  rmFetchHead();
  fs.appendFileSync(path.join(cur.repoDir, "README.md"), "dirty\n");
  const claudeA = spawnClaude();
  register({ session_id: "aaaa12c2-0000-4000-8000-0000000000c2", terminal_id: "t12c2", pid: claudeA.pid, pid_at: nowIso(), task_dir: null });
  const runsBeforeA2 = zmxRuns().length;
  const a2 = cliJson(["start", "001", "--here", "--no-attach"]);
  check(a2.status === 0 && a2.data && a2.data.cwd === cur.key.main_root && mainCount() === "1"
    && !out(a2).includes("pulled") && zmxRuns().length === runsBeforeA2 + 1,
    `ST12c: a dirty tree beside a live session runs --here with no pull (${a2.status}: ${out(a2).trim()})`);
  claudeA.kill();
  pause(0.2);
  git(cur.repoDir, "checkout", "--", "README.md");

  // b: untracked files do not block — the pull fires and reports itself.
  push("c2");
  rmFetchHead();
  fs.writeFileSync(path.join(cur.repoDir, "scratch.txt"), "untracked");
  const runsBeforeB = zmxRuns().length;
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 0 && mainCount() === "3" && out(b).includes("pulled main forward 2 commits to origin/main") && zmxRuns().length === runsBeforeB + 1,
    `ST12c: untracked files do not block the fast-forward (${b.status}: ${out(b).trim()})`);

  // c: diverged — local main also has its own commit; no fast-forward exists.
  push("c3");
  const beforeLocal = git(cur.key.main_root, "rev-parse", "HEAD");
  git(cur.key.main_root, "commit", "-q", "--allow-empty", "-m", "local work");
  rmFetchHead();
  const runsBeforeC = zmxRuns().length;
  const c = cli(["start", "001", "--no-attach"]);
  check(c.status === 0 && mainCount() === "4" && out(c).includes("1 commits behind") && !out(c).includes("pulled") && zmxRuns().length === runsBeforeC + 1,
    `ST12c: a diverged base is left alone, warned (${c.status}: ${out(c).trim()})`);

  // d: a worktree start — fetch and warn only, the main checkout untouched, and
  // the cut comes from origin's fetched tip, not the (diverged) local main.
  push("c4");
  rmFetchHead();
  const d = cliJson(["start", "002", "--worktree", "--no-attach"]);
  const cutTip = git(cur.key.main_root, "rev-parse", "refs/remotes/origin/main");
  const localTip = git(cur.key.main_root, "rev-parse", "main");
  check(d.status === 0 && d.data && d.data.cwd === wtPath("002-two") && mainCount() === "4" && out(d).includes("2 commits behind") && !out(d).includes("pulled")
    && cutTip !== localTip && git(cur.key.main_root, "rev-parse", "wt/002-two") === cutTip
    && git(wtPath("002-two"), "log", "--oneline").includes("c4"),
    `ST12c: a worktree start never pulls the main checkout and cuts from origin (${d.status}: ${out(d).trim()})`);

  // e: --here beside a live session — never pull files out from under it.
  push("c5");
  rmFetchHead();
  const claude = spawnClaude();
  register({ session_id: "aaaa12c5-0000-4000-8000-0000000000c5", terminal_id: "t12c", pid: claude.pid, pid_at: nowIso(), task_dir: null });
  const e = cliJson(["start", "001", "--here", "--no-attach"]);
  check(e.status === 0 && e.data && e.data.cwd === cur.key.main_root && mainCount() === "4" && out(e).includes("3 commits behind") && !out(e).includes("pulled"),
    `ST12c: --here sharing a live session runs there but never pulls under it (${e.status}: ${out(e).trim()})`);
  claude.kill();
  pause(0.2);

  // f: preconditions pass but the merge cannot run — one warning, untouched, run continues.
  // Case c's local commit diverged main for good; restore the line the checkout
  // had before it so this start can reach the merge, then block that merge.
  git(cur.key.main_root, "reset", "-q", "--hard", beforeLocal);
  push("c6");
  rmFetchHead();
  fs.writeFileSync(path.join(cur.key.main_root, ".git", "index.lock"), "");
  const runsBeforeF = zmxRuns().length;
  const f = cli(["start", "001", "--no-attach"]);
  check(f.status === 0 && mainCount() === "3" && out(f).includes("could not fast-forward main") && !out(f).includes("pulled main forward") && zmxRuns().length === runsBeforeF + 1,
    `ST12c: a failed fast-forward warns once and touches nothing (${f.status}: ${out(f).trim()})`);
  fs.rmSync(path.join(cur.key.main_root, ".git", "index.lock"));

  // n: a fetch the window skips is a recent success by definition — the cut
  // proceeds from the recent tip, no fetch is attempted, nothing blocks.
  git(cur.key.main_root, "fetch", "origin", "main");
  fs.renameSync(cur.origin, cur.origin + ".moved");
  const n = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(n.status === 0 && n.data && n.data.cwd === wtPath("001-one") && !n.err.includes("could not fetch"),
    `ST12c: a window-skipped fetch never blocks the worktree cut (${n.status}: ${n.err.trim().slice(-160)})`);
  fs.renameSync(cur.origin + ".moved", cur.origin);
}

// ST12d: the branch switch — a main-path start that finds a side branch moves
// it back to base when the branch is fully landed (merged into the freshly
// fetched origin tip, its task closed; a taskless branch needs only the merge),
// and refuses with a reason and remedy otherwise. The open/closed pair shares
// one plant: the open task refuses first, the close flips it to the switch.
fixture("st12d");
{
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const rmFetchHead = () => fs.rmSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), { force: true });
  const branch = () => git(cur.key.main_root, "branch", "--show-current");
  const mainCount = () => git(cur.key.main_root, "rev-list", "--count", "main");
  const out = (r) => r.out + r.err;
  const closeTask = (taskDir) => {
    const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), cur.key.key);
    fs.mkdirSync(archiveBase, { recursive: true });
    fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
    db.setTaskDisposition({ repoKey: cur.key.key, dirName: path.basename(taskDir), disposition: "archived" });
  };

  // 2: the task is open — merged, but not closed: the start refuses.
  git(cur.key.main_root, "branch", "wt/001-one", "origin/main");
  git(cur.key.main_root, "checkout", "-q", "wt/001-one");
  rmFetchHead();
  const r2 = cli(["start", "002", "--no-attach", "--json"]);
  const r2j = r2.status === 2 && r2.out ? JSON.parse(r2.out) : null;
  check(r2.status === 2 && r2j && r2j.error === "side_branch" && r2.err.includes("task 001-one is not closed")
    && r2.err.includes("--worktree") && branch() === "wt/001-one" && mainCount() === "1" && zmxRuns().length === 0,
    `ST12d: an open task's branch does not switch — the start refuses (${r2.status}: ${r2.err.trim()})`);

  // 1: the close flips it — the same branch now switches back and pulls.
  push("d1");
  closeTask(cur.tasks[1]);
  rmFetchHead();
  const r1 = cli(["start", "002", "--no-attach"]);
  check(r1.status === 0 && out(r1).includes("switched to main (wt/001-one is fully landed)")
    && branch() === "main" && out(r1).includes("pulled main forward 1 commits to origin/main")
    && mainCount() === "2" && zmxRuns().length === 1,
    `ST12d: a fully-landed closed task's branch switches to base (${r1.status}: ${out(r1).trim()})`);

  // 3: a branch with a local-only commit — not merged: the start refuses.
  git(cur.key.main_root, "checkout", "-q", "-b", "side");
  git(cur.key.main_root, "commit", "-q", "--allow-empty", "-m", "local only");
  rmFetchHead();
  const r3 = cli(["start", "002", "--no-attach"]);
  check(r3.status === 2 && r3.err.includes("not merged into origin/main") && r3.err.includes("--worktree")
    && branch() === "side" && zmxRuns().length === 1,
    `ST12d: an unmerged branch refuses (${r3.status}: ${r3.err.trim()})`);
  git(cur.key.main_root, "checkout", "-q", "main");
  git(cur.key.main_root, "branch", "-D", "side");

  // 4: a taskless branch at a spent tip — merged alone is enough to switch.
  push("d4");
  git(cur.key.main_root, "branch", "side", "origin/main");
  git(cur.key.main_root, "checkout", "-q", "side");
  rmFetchHead();
  const r4 = cli(["start", "002", "--no-attach"]);
  check(r4.status === 0 && out(r4).includes("switched to main (side is fully landed)")
    && branch() === "main" && out(r4).includes("pulled main forward 1 commits to origin/main")
    && zmxRuns().length === 2,
    `ST12d: a taskless merged branch switches and pulls (${r4.status}: ${out(r4).trim()})`);

  // 5: merged and closed — the switch would fire, but an untracked file
  // squats on a path main's tree owns: git refuses the checkout, the start
  // refuses carrying git's why, and nothing is created.
  fs.writeFileSync(path.join(cur.key.main_root, "clash.txt"), "main's copy\n");
  git(cur.key.main_root, "add", "clash.txt");
  git(cur.key.main_root, "commit", "-q", "-m", "clash");
  git(cur.key.main_root, "checkout", "-q", "wt/001-one");
  fs.writeFileSync(path.join(cur.key.main_root, "clash.txt"), "untracked copy\n");
  rmFetchHead();
  const r5 = cli(["start", "002", "--no-attach"]);
  check(r5.status === 2 && r5.err.includes("could not switch") && r5.err.includes("would be overwritten by checkout")
    && branch() === "wt/001-one" && mainCount() === "4" && !fs.existsSync(wtPath("002-two"))
    && taskCount() === 1 && zmxRuns().length === 2,
    `ST12d: a checkout git cannot make refuses the start with git's why (${r5.status}: ${r5.err.trim()})`);
}

// ST12e: the fresh fetch on the pull — the fast-forward lands on the true tip,
// never the ≤10-minute-stale ref; a fetch that fails skips it with one warning.
fixture("st12e");
{
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const mainCount = () => git(cur.key.main_root, "rev-list", "--count", "main");
  const out = (r) => r.out + r.err;

  // 1: the window is fresh, the ref one push behind the true tip — the pull
  // fetches past the window and lands on the true tip.
  push("e1");
  git(cur.key.main_root, "fetch", "origin", "main");
  push("e2");
  const tip2 = git(second, "rev-parse", "HEAD");
  const r1 = cli(["start", "001", "--no-attach"]);
  check(r1.status === 0 && out(r1).includes("pulled main forward 2 commits to origin/main")
    && git(cur.key.main_root, "rev-parse", "main") === tip2
    && git(cur.key.main_root, "rev-parse", "refs/remotes/origin/main") === tip2 && mainCount() === "3"
    && zmxRuns().length === 1,
    `ST12e: the pull fetches fresh past the fetch window (${r1.status}: ${out(r1).trim()})`);

  // 2: the same fresh window, the origin gone — the fresh fetch fails, the
  // fast-forward is skipped with one warning, the session still runs.
  push("e3");
  git(cur.key.main_root, "fetch", "origin", "main");
  const moved = cur.origin + ".moved";
  fs.renameSync(cur.origin, moved);
  const r2 = cli(["start", "002", "--no-attach"]);
  check(r2.status === 0 && r2.err.includes("could not fetch origin main") && !out(r2).includes("pulled main forward")
    && mainCount() === "3" && zmxRuns().length === 2,
    `ST12e: a failed fresh fetch skips the fast-forward (${r2.status}: ${out(r2).trim()})`);
  fs.renameSync(moved, cur.origin);
}

// ST12f: the switch's task check reads the same three states as the removal
// rule (done, not closed refuses), and the switch fetches fresh — a merge
// younger than the fetch window still switches, where a stale-ref consult
// would falsely refuse.
fixture("st12f");
{
  const derive = require("./lib/derive");
  const wt = require("./lib/worktree");
  const taskDir = cur.tasks[1];
  const taskId = db.taskIdOf(taskDir);
  taskLib.checkPhase({ taskDir, phaseId: 1 });
  const added = wt.add({ projectDir: cur.repoDir, taskDir, force: true });
  git(cur.repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge");
  git(cur.repoDir, "push", "-q", "origin", "main");
  db.appendEvent({ kind: "land", repoKey: cur.key.key, taskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(cur.repoDir, "rev-parse", "HEAD"), pushed: true, pr_url: null }) });
  derive.invalidateTask(taskId);
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST12f: the planted task reads done");

  // 1: the branch is merged, the task done but not closed — the switch refuses.
  git(cur.repoDir, "worktree", "remove", added.path);
  git(cur.repoDir, "checkout", "-q", added.branch);
  const r1 = cli(["start", "002", "--no-attach"]);
  check(r1.status === 2 && r1.err.includes("task 001-one is done, not closed") && r1.err.includes("not fully landed")
    && r1.err.includes("--worktree") && git(cur.repoDir, "branch", "--show-current") === added.branch
    && zmxRuns().length === 0,
    `ST12f: a done, not-closed task's branch refuses the switch (${r1.status}: ${r1.err.trim()})`);

  // 2: close the task, then merge on the origin after the window went fresh —
  // the switch's own fetch catches the merge and the start switches and pulls.
  const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), cur.key.key);
  fs.mkdirSync(archiveBase, { recursive: true });
  fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
  db.setTaskDisposition({ repoKey: cur.key.key, dirName: path.basename(taskDir), disposition: "archived" });
  git(cur.repoDir, "checkout", "-q", "main");
  git(cur.repoDir, "fetch", "origin", "main");
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  git(second, "checkout", "-q", "-b", "wt/001-one");
  git(second, "commit", "-q", "--allow-empty", "-m", "b1");
  git(second, "push", "-q", "origin", "wt/001-one");
  git(second, "checkout", "-q", "main");
  git(second, "-c", "user.email=t@e", "-c", "user.name=t", "merge", "--no-ff", "-m", "merge b1", "wt/001-one");
  git(second, "push", "-q", "origin", "main");
  git(cur.repoDir, "fetch", "origin", "wt/001-one:wt/001-one");
  git(cur.repoDir, "checkout", "-q", "wt/001-one");
  const r2 = cli(["start", "002", "--no-attach"]);
  check(r2.status === 0 && (r2.out + r2.err).includes("switched to main (wt/001-one is fully landed)")
    && git(cur.repoDir, "branch", "--show-current") === "main"
    && (r2.out + r2.err).includes("pulled main forward 2 commits to origin/main") && zmxRuns().length === 1,
    `ST12f: a merge younger than the fetch window still switches (${r2.status}: ${(r2.out + r2.err).trim()})`);
}

// ST12g: the pr main-checkout branch cut — a start that will run on the main
// checkout of a pr-policy repo cuts the task's own branch there (t/<NNN-slug>),
// so the work never sits on base and a land has its PR branch; the task's own
// branch is the side-branch rule's exception, a spent t/ branch switches back
// and deletes itself, and a squash-merged closed task switches on its record
// alone. Direct keeps working on base; a live session sharing the checkout
// waives the cut (HEAD may not move under it); a failed launch rolls the cut back.
fixture("st12g");
{
  const { POLICIES_PATH } = require("./lib/policy");
  const setPolicy = (v) => fs.writeFileSync(POLICIES_PATH, JSON.stringify({ [cur.key.main_root]: v }));
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const rmFetchHead = () => fs.rmSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), { force: true });
  const branch = () => git(cur.key.main_root, "branch", "--show-current");
  const hasRef = (b) => { try { git(cur.key.main_root, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); return true; } catch { return false; } };
  const out = (r) => r.out + r.err;
  const closeTask = (taskDir) => {
    const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), cur.key.key);
    fs.mkdirSync(archiveBase, { recursive: true });
    fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
    db.setTaskDisposition({ repoKey: cur.key.key, dirName: path.basename(taskDir), disposition: "archived" });
  };

  // 1: pr — the start cuts t/001-one from base and runs on it.
  setPolicy("pr");
  const mainTip = git(cur.key.main_root, "rev-parse", "main");
  const a = cli(["start", "001", "--no-attach"]);
  check(a.status === 0 && branch() === "t/001-one" && git(cur.key.main_root, "rev-parse", "t/001-one") === mainTip
    && out(a).includes("cut task branch t/001-one") && zmxRuns().length === 1,
    `ST12g: a pr main-checkout start cuts the task's branch and runs on it (${a.status}: ${out(a).trim()})`);

  // 2: the same task again — its own branch is checked out: the side-branch
  // rule yields (the carve-out) and the start continues on it.
  rmFetchHead();
  const b = cli(["start", "001", "--no-attach"]);
  check(b.status === 0 && branch() === "t/001-one" && !out(b).includes("switched to main") && zmxRuns().length === 2,
    `ST12g: a re-start on the task's own branch continues there (${b.status}: ${out(b).trim()})`);

  // 2b: a hand return to base mid-task — the surviving branch is checked out
  // to continue the task, not cut fresh.
  git(cur.key.main_root, "checkout", "-q", "main");
  rmFetchHead();
  const b2 = cli(["start", "001", "--no-attach"]);
  check(b2.status === 0 && branch() === "t/001-one" && out(b2).includes("checked out task branch t/001-one")
    && git(cur.key.main_root, "rev-parse", "t/001-one") === mainTip && zmxRuns().length === 3,
    `ST12g: a surviving t/ branch is checked out to continue the task (${b2.status}: ${out(b2).trim()})`);

  // 3: a different task while t/001-one is out — merged-at-tip but the task is
  // open: the refusal names it (one branch at a time in the main checkout).
  rmFetchHead();
  const c = cli(["start", "002", "--no-attach", "--json"]);
  const cj = c.status === 2 && c.out ? JSON.parse(c.out) : null;
  check(c.status === 2 && cj && cj.error === "side_branch" && c.err.includes("task 001-one is not closed")
    && branch() === "t/001-one" && zmxRuns().length === 3,
    `ST12g: another task's start refuses on the open task's branch (${c.status}: ${c.err.trim()})`);

  // 4: close task 001 — the t/ branch is spent (ancestor of origin/main): the
  // start switches back to base, deletes the engine's branch, pulls — and cuts
  // the new task's own branch, so the checkout ends on t/002-two.
  push("g4");
  closeTask(cur.tasks[1]);
  rmFetchHead();
  const d = cli(["start", "002", "--no-attach"]);
  check(d.status === 0 && out(d).includes("switched to main (t/001-one is fully landed)") && branch() === "t/002-two"
    && !hasRef("t/001-one") && out(d).includes("pulled main forward 1 commits to origin/main")
    && out(d).includes("cut task branch t/002-two") && zmxRuns().length === 4,
    `ST12g: a spent t/ branch switches back to base and deletes itself (${d.status}: ${out(d).trim()})`);

  // 5: direct — closing 002 spends its branch too: the direct start switches
  // back, deletes it, and cuts nothing (the work runs on base as before).
  setPolicy("direct");
  closeTask(cur.tasks[2]);
  rmFetchHead();
  const e = cli(["start", "--title", "Third", "--no-attach"]);
  check(e.status === 0 && branch() === "main" && !hasRef("t/002-two") && !out(e).includes("task branch")
    && zmxRuns().length === 5,
    `ST12g: a direct-policy start keeps the checkout on base (${e.status}: ${out(e).trim()})`);

  // 6: back to pr — a squash-merged closed task's t/ branch: no ancestry git
  // can show, the close is the truth — the switch fires anyway, the ref stays
  // (-d declines what git cannot prove; inert, like a reaped worktree's).
  const dirOf = (name) => path.join(cur.tasksRoot, cur.key.key, name);
  setPolicy("pr");
  git(cur.key.main_root, "checkout", "-q", "-b", "t/003-third");
  fs.writeFileSync(path.join(cur.key.main_root, "sq.txt"), "squashed\n");
  git(cur.key.main_root, "add", "sq.txt");
  git(cur.key.main_root, "commit", "-q", "-m", "task work");
  fs.writeFileSync(path.join(second, "sq.txt"), "squashed\n");
  git(second, "add", "sq.txt");
  git(second, "commit", "-q", "-m", "squash-landed");
  git(second, "push", "-q", "origin", "main");
  closeTask(dirOf("003-third"));
  rmFetchHead();
  const f = cli(["start", "--title", "Fifth", "--no-attach"]);
  check(f.status === 0 && out(f).includes("switched to main (t/003-third is fully landed)") && branch() === "t/004-fifth"
    && hasRef("t/003-third") && out(f).includes("pulled main forward 1 commits to origin/main") && zmxRuns().length === 6,
    `ST12g: a squash-merged closed t/ branch still switches back, ref kept (${f.status}: ${out(f).trim()})`);

  // 7: the cut rolls back — the task's branch is planted away by hand, a fresh
  // cut precedes a launch that fails: the rollback returns the checkout to base
  // and deletes the branch it created; the existing task survives.
  git(cur.key.main_root, "checkout", "-q", "main");
  git(cur.key.main_root, "branch", "-d", "t/004-fifth");
  rmFetchHead();
  const runs7 = zmxRuns().length;
  const g = cli(["start", "004", "--no-attach"], { env: { STUB_ZMX_EXIT: "1" } });
  check(g.status === 1 && branch() === "main" && !hasRef("t/004-fifth") && zmxRuns().length === runs7 + 1
    && taskCount() === 1,
    `ST12g: a failed launch rolls the cut back to base and deletes the branch (${g.status}: ${g.err.trim()})`);

  // 8: --here beside a live session (pr) — the cut is waived with one warning:
  // HEAD may not move under the session; the work runs where the checkout sits.
  const claude = spawnClaude();
  register({ session_id: "aaaa12g8-0000-4000-8000-0000000000g8", terminal_id: "t12g8", pid: claude.pid, pid_at: nowIso(), task_dir: null });
  const runs8 = zmxRuns().length;
  const h = cli(["start", "004", "--here", "--no-attach"]);
  check(h.status === 0 && branch() === "main" && !hasRef("t/004-fifth")
    && out(h).includes("the task branch t/004-fifth is not cut") && zmxRuns().length === runs8 + 1,
    `ST12g: a live session sharing the checkout waives the cut with one line (${h.status}: ${out(h).trim()})`);
  claude.kill();
  pause(0.2);
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
