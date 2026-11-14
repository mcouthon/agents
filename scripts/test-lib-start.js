#!/usr/bin/env node
"use strict";
// `a start`, `a attach`, `a resume`: the session verbs, with stub zmx and claude.
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
  const ran = spawnSync("sh", [scriptPath], { env: paneEnv, encoding: "utf8", timeout: HANG_GUARD_MS });
  check(ran.status === 0, `ST1v: launch.sh executes cleanly under the pane env (${ran.status}: ${ran.stderr.slice(-200)})`);

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
}

// ST12b: the fetch throttle — refs/remotes/origin/main moves only when the fetch
// runs, so the ref value proves which path a start took. No wall clock anywhere.
fixture("st12b");
// A side branch: this fixture's starts must never pull (the pull requires the
// base branch), so local main stays put and the behind counts below keep their
// meaning. The throttle under test is HEAD-independent — fetchBase reads
// refs/heads/main, not HEAD.
git(cur.key.main_root, "checkout", "-q", "-b", "side");
{
  const second = path.join(cur.root, "second");
  git(cur.root, "clone", "-q", cur.origin, second);
  const push = (msg) => { git(second, "commit", "-q", "--allow-empty", "-m", msg); git(second, "push", "-q", "origin", "HEAD:main"); };
  const track = () => git(cur.key.main_root, "rev-parse", "refs/remotes/origin/main").trim();
  const fh = () => path.join(cur.key.main_root, ".git", "FETCH_HEAD");

  push("ahead1");
  const ahead1 = git(second, "rev-parse", "HEAD");
  const a = cli(["start", "001", "--no-attach"]);
  check(a.status === 0 && track() === ahead1 && (a.out + a.err).includes("1 commits behind"),
    `ST12b: no FETCH_HEAD: the start fetches and reports behind (${a.status}: ${(a.out + a.err).trim().slice(-160)})`);

  push("ahead2");
  const ahead2 = git(second, "rev-parse", "HEAD");
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 0 && track() === ahead1 && (b.out + b.err).includes("1 commits behind"),
    `ST12b: a fresh FETCH_HEAD skips the fetch: the ref stays at ahead1, the local check still warns (${b.status}: ${(b.out + b.err).trim().slice(-160)})`);

  const aged = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(fh(), aged, aged); // past the window
  const c = cli(["start", "001", "--no-attach"]);
  check(c.status === 0 && track() === ahead2 && (c.out + c.err).includes("2 commits behind"),
    `ST12b: a FETCH_HEAD older than the window fetches again and catches up (${c.status}: ${(c.out + c.err).trim().slice(-160)})`);

  push("ahead3");
  fs.writeFileSync(fh(), ""); // what git leaves after a failed fetch: empty, mtime now (measured)
  const d = cli(["start", "002", "--no-attach"]);
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

  // a: dirty tracked file — left alone, warned, run continues.
  push("c1");
  rmFetchHead();
  fs.appendFileSync(path.join(cur.repoDir, "README.md"), "dirty\n");
  const a = cli(["start", "001", "--no-attach"]);
  check(a.status === 0 && mainCount() === "1" && out(a).includes("1 commits behind") && !out(a).includes("pulled") && zmxRuns().length === 1,
    `ST12c: a dirty tree stays behind, warned and untouched (${a.status}: ${out(a).trim()})`);
  git(cur.repoDir, "checkout", "--", "README.md");

  // b: untracked files do not block — the pull fires and reports itself.
  push("c2");
  rmFetchHead();
  fs.writeFileSync(path.join(cur.repoDir, "scratch.txt"), "untracked");
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 0 && mainCount() === "3" && out(b).includes("pulled main forward 2 commits to origin/main") && zmxRuns().length === 2,
    `ST12c: untracked files do not block the fast-forward (${b.status}: ${out(b).trim()})`);

  // c: diverged — local main also has its own commit; no fast-forward exists.
  push("c3");
  const beforeLocal = git(cur.key.main_root, "rev-parse", "HEAD");
  git(cur.key.main_root, "commit", "-q", "--allow-empty", "-m", "local work");
  rmFetchHead();
  const c = cli(["start", "001", "--no-attach"]);
  check(c.status === 0 && mainCount() === "4" && out(c).includes("1 commits behind") && !out(c).includes("pulled") && zmxRuns().length === 3,
    `ST12c: a diverged base is left alone, warned (${c.status}: ${out(c).trim()})`);

  // d: a worktree start — fetch and warn only, the main checkout untouched.
  push("c4");
  rmFetchHead();
  const d = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(d.status === 0 && d.data && d.data.cwd === wtPath("002-two") && mainCount() === "4" && out(d).includes("2 commits behind") && !out(d).includes("pulled"),
    `ST12c: a worktree start never pulls the main checkout (${d.status}: ${out(d).trim()})`);

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
  const f = cli(["start", "001", "--no-attach"]);
  check(f.status === 0 && mainCount() === "3" && out(f).includes("could not fast-forward main") && !out(f).includes("pulled main forward") && zmxRuns().length === 6,
    `ST12c: a failed fast-forward warns once and touches nothing (${f.status}: ${out(f).trim()})`);
  fs.rmSync(path.join(cur.key.main_root, ".git", "index.lock"));
}

// ---------------------------------------------------------------- attach
// ST13: resume attaches to a live session (a resume handles both live and ended).
{
  fixture("st13a");
  setZmx([zl("Conductor-aaaa0130")]);
  register({ session_id: "aaaa0130-0000-4000-8000-000000000130", terminal_id: "t130", mux: { kind: "zmx", name: "Conductor-aaaa0130" }, task_dir: cur.tasks[1] });
  const a = cli(["resume", "001"]);
  check(a.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0130", `ST13a: a live zmx session is attached via resume (${a.status}: ${a.err.trim()})`);

  setZmx([zl("Conductor-aaaa0130", true)]);
  session.markEnded(path.join(cur.sessions, "t130"));
  const b = cli(["resume", "001", "--json"]);
  check(b.status === 4, `ST13b: an ended session with no transcript refuses resume (${b.status}: ${b.err.trim().slice(-120)})`);

  fixture("st13c");
  setZmx([zl("Courier-cccc0131")]);
  register({ session_id: "cccc0131-0000-4000-8000-000000000131", terminal_id: "t131", agent: "courier", task_dir: cur.tasks[1] });
  const c = cli(["resume", "001"]);
  check(c.status === 0 && zmxCalls().pop() === "zmx attach Courier-cccc0131", `ST13c: an entry with no mux matches its <Agent>-<id8> name (${c.status}: ${c.err.trim()})`);

  fixture("st13d");
  const claude = spawnClaude();
  register({ session_id: "aaaa0133-0000-4000-8000-000000000133", terminal_id: "t133", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const d = cli(["resume", "001"]);
  check(d.status === 4 && d.err.includes(`runs outside zmx (pid ${claude.pid})`) && zmxCalls().length === 0, `ST13d: a pid-only session cannot be attached (${d.status}: ${d.err.trim()})`);

  fixture("st13e");
  setZmx([zl("Conductor-aaaa0132"), zl("Conductor-bbbb0132", true)]);
  register({ session_id: "aaaa0132-0000-4000-8000-000000000132", terminal_id: "t132a", mux: { kind: "zmx", name: "Conductor-aaaa0132" }, task_dir: cur.tasks[1] });
  pause();
  register({ session_id: "bbbb0132-0000-4000-8000-000000000132", terminal_id: "t132b", mux: { kind: "zmx", name: "Conductor-bbbb0132" }, task_dir: cur.tasks[1] });
  session.markEnded(path.join(cur.sessions, "t132b"));
  const e = cli(["resume", "001"]);
  check(e.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0132", `ST13e: the live entry wins over the newer ended one (${e.status}: ${e.err.trim()})`);
}

// ---------------------------------------------------------------- resume
// ST14: resume in a fresh zmx session, with the registration written once, before the run.
function endedEntry() {
  const r = cliJson(["start", "001", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  const transcriptPath = path.join(cur.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  return { dir, sid, id8 };
}
{
  fixture("st14");
  const { dir, sid, id8 } = endedEntry();
  check(readReg(dir).ended_at && readReg(dir).pid === 99999, "ST14: the fixture entry is ended with a stale pid");
  const runsBefore = zmxRuns().length;
  const r = cli(["resume", "001"], { env: { STUB_ZMX_SNAP: path.join(dir, "registration.json") } });
  const run = zmxRunArgvs()[runsBefore] || [];
  const snap = JSON.parse(fs.readFileSync(process.env.ZMX_LOG + ".snap", "utf8"));
  const resumeScript = path.join(dir, "launch.sh");
  check(r.status === 0 && JSON.stringify(run) === JSON.stringify(["run", `Conductor-${id8}-r1`, "-d", "exec", "sh", resumeScript]) && lastCwd() === `cwd ${cur.key.main_root}`,
    `ST14: resume runs sh <launch.sh> under the next free name in the entry's cwd (${r.status}: ${r.err.trim()} ${JSON.stringify(run)})`);
  check(fs.existsSync(resumeScript) && fs.readFileSync(resumeScript, "utf8").includes(`'--resume' '${sid}'`), `ST14: the launch script carries the resume command`);
  check(snap.mux.name === `Conductor-${id8}-r1` && !("ended_at" in snap) && snap.pid === null && !("pid_at" in snap), `ST14: zmx run already saw the new mux, no ended_at, no pid (${JSON.stringify(snap)})`);
  check(regBytes(dir) === fs.readFileSync(process.env.ZMX_LOG + ".snap", "utf8") && !fs.existsSync(path.join(cur.sessions, sid)), "ST14: nothing is written after the run and no <session_id> dir appears");

  setZmx([zl(`Conductor-${id8}`, true), zl(`Conductor-${id8}-r1`)]);
  const runs = zmxRuns().length;
  const again = cli(["resume", "001"]);
  check(again.status === 0 && zmxCalls().pop() === `zmx attach Conductor-${id8}-r1` && zmxRuns().length === runs, `ST14: a resumed session that is live is attached, not run again (${zmxCalls().pop()})`);

  setZmx([zl(`Conductor-${id8}`, true), zl(`Conductor-${id8}-r1`, true)]);
  const third = cli(["resume", "001"]);
  const w3 = zmxRunArgvs().pop() || [];
  check(third.status === 0 && w3.length === 6 && JSON.stringify(w3.slice(0, 5)) === JSON.stringify(["run", `Conductor-${id8}-r2`, "-d", "exec", "sh"]), `ST14: after -r1 ended the next name is -r2 (${JSON.stringify(w3)})`);

  fixture("st14-fail");
  const e2 = endedEntry();
  const before = regBytes(e2.dir);
  const failed = cli(["resume", "001"], { env: { STUB_ZMX_EXIT: "1" } });
  const row = db.listSessions().find((s) => s.entry_id === path.basename(e2.dir));
  check(failed.status !== 0 && regBytes(e2.dir) === before && row && row.doc === before, `ST14: a failed zmx run restores the file and the database row byte for byte (${failed.status}: ${failed.err.trim()})`);
}

// ST14b: a live entry with no mux resumes by attaching.
{
  fixture("st14b");
  const sleeper = spawnSleep();
  setZmx([zl("Courier-dddd0004")]);
  register({ session_id: "dddd0004-0000-4000-8000-000000000004", terminal_id: "td4", agent: "courier", pid: sleeper.pid, task_dir: cur.tasks[1] });
  const r = cli(["resume", "001"]);
  check(r.status === 0 && zmxCalls().pop() === "zmx attach Courier-dddd0004" && zmxRuns().length === 0 && claudeCalls().length === 0, `ST14b: resume attaches to the live courier (${r.status}: ${r.err.trim()})`);
}

// ST14c: ended twins of one session id.
{
  fixture("st14c");
  const SID5 = "5555aaaa-0000-4000-8000-000000000005";
  setZmx([zl("Conductor-5555aaaa")]);
  register({ session_id: SID5, terminal_id: "t5", mux: { kind: "zmx", name: "Conductor-5555aaaa" }, task_dir: cur.tasks[1] });
  pause();
  const twinDir = path.join(cur.sessions, SID5);
  register({ session_id: SID5, terminal_id: "t5", mux: { kind: "zmx", name: "Conductor-5555aaaa" }, task_dir: cur.tasks[1], session_dir: twinDir });
  session.markEnded(twinDir);
  const twinBytes = regBytes(twinDir);
  const a1 = cli(["resume", "001"]);
  const a2 = cli(["resume", SID5]);
  const a3 = cli(["resume", "5555aaaa"]);
  const attaches = zmxCalls().filter((l) => l === "zmx attach Conductor-5555aaaa");
  check([a1, a2, a3].every((r) => r.status === 0) && attaches.length === 3 && zmxRuns().length === 0 && claudeCalls().length === 0 && regBytes(twinDir) === twinBytes,
    `ST14c: the live launcher entry wins over its newer ended twin (${a1.status}/${a2.status}/${a3.status}: ${a1.err.trim()})`);

  fixture("st14c-b");
  const SID6 = "6666bbbb-0000-4000-8000-000000000006";
  setZmx([zl("Courier-6666bbbb", true)]);
  register({ session_id: SID6, terminal_id: "ty", agent: "courier", mux: { kind: "zmx", name: "Courier-6666bbbb" }, task_dir: cur.tasks[2] });
  session.markEnded(path.join(cur.sessions, "ty"));
  const claude = spawnClaude();
  register({ session_id: SID6, terminal_id: "ty", agent: "courier", pid: claude.pid, pid_at: nowIso(), task_dir: null, session_dir: path.join(cur.sessions, SID6) });
  const tyBytes = regBytes(path.join(cur.sessions, "ty")), twinBytes2 = regBytes(path.join(cur.sessions, SID6));
  const b = cli(["resume", "002"]);
  check(b.status === 4 && b.err.includes("a resume 6666bbbb") && b.err.includes(`pid ${claude.pid}`) && zmxRuns().length === 0 && claudeCalls().length === 0
    && regBytes(path.join(cur.sessions, "ty")) === tyBytes && regBytes(path.join(cur.sessions, SID6)) === twinBytes2,
    `ST14c: a live twin refuses the resume, naming its pid (${b.status}: ${b.err.trim()})`);
}

// ST19: a registration an `a run` made (origin dispatch) is not the task's session for a start, a resume or an attach <task>.
function dispatchEntry(terminal, fields = {}) {
  return register({ session_id: `dddd0${terminal}-0000-4000-8000-000000000${terminal}`, terminal_id: `td${terminal}`, origin: "dispatch", initiator: "engine", agent: "builder", task_dir: cur.tasks[1], ...fields });
}
{
  fixture("st19a");
  const claude = spawnClaude();
  dispatchEntry("191", { pid: claude.pid, pid_at: nowIso() });
  const here = cliJson(["start", "001", "--here", "--no-attach"]);
  check(here.status === 0 && here.data && zmxRunArgvs().length === 1, `ST19a: a live dispatched run does not make a start refuse "already has a live" (${here.status}: ${here.err.trim()})`);

  fixture("st19b");
  const claudeB = spawnClaude();
  dispatchEntry("192", { pid: claudeB.pid, pid_at: nowIso() });
  const flagless = cli(["start", "001", "--no-attach"]);
  check(flagless.status === 2 && flagless.err.includes("Checkout") && flagless.err.includes("--worktree") && flagless.err.includes("--here") && !flagless.err.includes("already has a live"), `ST19b: the checkout the run occupies still raises the occupancy question (${flagless.status}: ${flagless.err.trim()})`);

  fixture("st19c");
  const ended = endedEntry();
  pause();
  const endedRun = dispatchEntry("193", { pid: 99999, pid_at: nowIso() });
  session.markEnded(endedRun.session_dir);
  const resumed = cli(["resume", "001"]);
  const resumeRun = zmxRunArgvs().pop() || [];
  const resumeScript = resumeRun[5] && fs.existsSync(resumeRun[5]) ? fs.readFileSync(resumeRun[5], "utf8") : "";
  check(resumed.status === 0 && resumeScript.includes(`'--resume' '${ended.sid}'`), `ST19c: a resume picks the Conductor, not the newer ended dispatch entry (${resumed.status}: ${resumed.err.trim()} ${resumeScript.slice(-80)})`);

  fixture("st19d");
  setZmx([zl("Conductor-aaaa0194")]);
  register({ session_id: "aaaa0194-0000-4000-8000-000000000194", terminal_id: "t194", mux: { kind: "zmx", name: "Conductor-aaaa0194" }, task_dir: cur.tasks[1] });
  pause();
  const claudeD = spawnClaude();
  dispatchEntry("195", { pid: claudeD.pid, pid_at: nowIso() });
  const attached = cli(["resume", "001"]);
  check(attached.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0194", `ST19d: a resume by task goes to the Conductor, not the newer live dispatch entry (${attached.status}: ${attached.err.trim()})`);

  const byId = cli(["resume", "dddd0195"]);
  check(byId.status === 4 && byId.err.includes(`runs outside zmx (pid ${claudeD.pid})`), `ST19d: an attach by the run's session id still finds it (${byId.status}: ${byId.err.trim()}) (guard)`);
}

// ST15: the wrappers.
{
  fixture("st15");
  const wrapper = (args) => spawnSync("sh", [path.join(BIN, "a-courier"), ...args], { encoding: "utf8", cwd: cur.repoDir, env: { ...process.env, PATH: `${stubBin}:${BIN}:${process.env.PATH}` } });
  const a = wrapper(["--title", "x", "--no-attach", "--json"]);
  const doc = a.status === 0 && taskLib.readTaskJson(JSON.parse(a.stdout).task_dir);
  check(doc && doc.mode === "fast" && doc.title === "x", `ST15: a-courier --title starts a courier task (${a.status}: ${a.stderr.trim()})`);
  const count = taskCount();
  const b = wrapper(["Fix", "typo", "--no-attach"]);
  check(b.status === 2 && b.stderr.includes("typo") && taskCount() === count, `ST15: an unquoted multi-word title exits 2 naming the extra word (${b.status}: ${b.stderr.trim()})`);
}

// ST16: an inherited AGENTS_SESSION_DIR never captures the new registration.
{
  fixture("st16");
  register({ session_id: "aaaa0016-0000-4000-8000-000000000016", terminal_id: "t16", task_dir: cur.tasks[2] });
  const other = path.join(cur.sessions, "t16");
  const before = regBytes(other);
  const r = cliJson(["start", "001", "--no-attach"], { env: { AGENTS_SESSION_DIR: other } });
  check(r.status === 0 && r.data.session_dir === path.join(cur.sessions, r.data.terminal_id) && r.data.session_dir !== other && regBytes(other) === before,
    `ST16: the new entry has its own dir and the other one is untouched (${r.status}: ${r.err.trim()})`);
}

// ST17: one-letter flags.
{
  const shortForm = start.parseArgs(["002", "-t", "x", "-w", "-n", "-j", "-r", "/r"]);
  const longForm = start.parseArgs(["002", "--title", "x", "--worktree", "--no-attach", "--json", "--repo", "/r"]);
  check(JSON.stringify(shortForm) === JSON.stringify(longForm) && shortForm.title === "x" && shortForm.worktree && shortForm.noAttach && shortForm.json && shortForm.repo === "/r",
    `ST17: -t -w -n -j -r parse like their long names (${JSON.stringify(shortForm)})`);
  check(start.parseArgs(["-t=x"]).title === "x", "ST17: -t=x gives the title");
  check(start.parseArgs(["-c"]).conductor && start.parseArgs(["-k"]).courier && start.parseArgs(["-e"]).here, "ST17: -c, -k and -e set conductor, courier and here");

  const bundled = verb("start", ["-wn"]);
  check(bundled.err && bundled.err.exitCode === 2 && bundled.err.message.includes("-w") && bundled.err.message.includes("-n"), `ST17: -wn is refused with exit 2 naming -w and -n (${bundled.err && bundled.err.message})`);
  const unknownShort = verb("start", ["-z"]);
  check(unknownShort.err && unknownShort.err.exitCode === 2 && unknownShort.err.message.includes("-z"), `ST17: -z is refused with exit 2 naming -z (${unknownShort.err && unknownShort.err.message})`);
  check(start.parseArgs(["-t", "-wn"]).title === "-wn", "ST17: the word after -t is its value even when it looks like a bundle");
  check(JSON.stringify(start.parseArgs(["001", "--", "-p", "x"]).passthrough) === JSON.stringify(["-p", "x"]), "ST17: words after -- reach claude untouched");

  const resumed = start.parseArgs(["-n", "-j"], "resume");
  check(resumed.noAttach && resumed.json, "ST17: a resume takes -n and -j");
  const resumeW = verb("resume", ["-w"]);
  check(resumeW.err && resumeW.err.exitCode === 2, "ST17: a resume refuses -w, which only a start takes");

  fixture("st17s");
  const s = cli(["s", "001", "-n", "-j"]);
  const sData = s.status === 0 ? JSON.parse(s.out) : null;
  const sRuns = zmxRuns(), sAttached = zmxCalls().some((l) => l.startsWith("zmx attach"));
  const sTaskDir = path.basename(cur.tasks[1]), sMain = cur.key.main_root;
  check(s.status === 0 && sData && path.basename(sData.task_dir) === sTaskDir && sRuns.length === 1 && !sAttached,
    `ST17: a s 001 -n -j starts task 001 detached (${s.status}: ${s.err.trim()})`);

  fixture("st17l");
  const l = cli(["start", "001", "--no-attach", "--json"]);
  const lData = l.status === 0 ? JSON.parse(l.out) : null;
  const lRuns = zmxRuns(), lAttached = zmxCalls().some((x) => x.startsWith("zmx attach"));
  check(l.status === 0 && sData && lData && s.err === l.err && JSON.stringify(Object.keys(sData).sort()) === JSON.stringify(Object.keys(lData).sort())
    && path.basename(lData.task_dir) === sTaskDir && sData.worktree === null && lData.worktree === null
    && sData.cwd === sMain && lData.cwd === cur.key.main_root && lRuns.length === 1 && !lAttached,
    `ST17: the short and the long start print the same shape and start the same way (${l.status}: ${l.err.trim()})`);
}

// ST18: the occupancy prompt reads a real answer from a piped stdin (no EAGAIN).
{
  fixture("st18");
  const claude = spawnClaude();
  register({ session_id: "aaaa0018-0000-4000-8000-000000000018", terminal_id: "t18", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const shim = path.join(cur.root, "tty-shim.js");
  const errFile = path.join(cur.root, "st18.err");
  fs.writeFileSync(shim, 'const tty = require("tty"); tty.isatty = (fd) => fd === 0 || fd === 1;\n');
  // "here" is written only once the prompt is on the child's stderr, so the child's read meets an empty pipe.
  const script = "E=\"$3\"; (i=0; until grep -q 'c\\]ancel' \"$E\" || [ $i -ge 100 ]; do sleep 0.1; i=$((i+1)); done; sleep 0.5; echo here) | \"$0\" --require \"$1\" \"$2\" start 002 --no-attach --json 2>\"$E\"";
  const r = spawnSync("sh", ["-c", script, process.execPath, shim, A, errFile], { cwd: cur.repoDir, encoding: "utf8", timeout: 60000, env: process.env });
  const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
  const data = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null;
  check(r.status === 0 && err.includes("[w]orktree / [h]ere / [c]ancel") && !err.includes("EAGAIN") && data && data.cwd === cur.key.main_root && data.worktree === null && zmxRuns().length === 1,
    `ST18: answering "here" at the occupancy prompt starts the session in the main checkout (exit ${r.status}: ${err.trim()})`);
}

// ST20: the busy-checkout refusal carries a code and the occupant under --json
{
  fixture("st20");
  const claude = spawnClaude();
  register({ session_id: "aaaa0020-0000-4000-8000-000000000020", terminal_id: "t20", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const r = cli(["start", "002", "--no-attach", "--json"]);
  let body = null;
  try { body = JSON.parse(r.out); } catch { /* checked below */ }
  check(r.status === 2 && body && body.error === "checkout_busy" && body.main_root === cur.key.main_root && body.occupant.session_id === "aaaa0020-0000-4000-8000-000000000020" && r.err.includes("--worktree") && r.err.includes("--here"),
    `ST20: a busy checkout under --json prints checkout_busy with the occupant and still explains on stderr (${r.status}: ${r.out.trim()})`);
}

// ST21: a start --json without zmx refuses before anything exists
{
  fixture("st21");
  const r = cli(["start", "--title", "ran", "--worktree", "--json"], { env: { PATH: `${claudeOnlyBin}:/usr/bin:/bin` } });
  let body = null;
  try { body = JSON.parse(r.out); } catch { /* checked below */ }
  check(r.status === 2 && body && body.error === "zmx_unavailable" && claudeCalls().length === 0, `ST21: --json without zmx refuses with zmx_unavailable and never runs claude (${r.status}: ${r.out.trim()}${r.err.trim()})`);
  check(taskCount() === 2 && !fs.existsSync(wtPath("003-ran")) && session.entries().length === 0, "ST21: no task, worktree or registration was created");
}

// ST22: a failed zmx run under --json reports what it rolled back
{
  fixture("st22");
  const r = cli(["start", "--title", "fails", "--worktree", "--no-attach", "--json"], { env: { STUB_ZMX_EXIT: "1" } });
  let body = null;
  try { body = JSON.parse(r.out); } catch { /* checked below */ }
  const entries = session.entries();
  const rb = body && body.rolled_back;
  check(r.status === 1 && body && body.error === "spawn_failed" && rb && rb.task_dir.endsWith("003-fails") && rb.worktree === wtPath("003-fails") && rb.session_dir === entries[0].dir,
    `ST22: the failed run prints spawn_failed with the task, worktree and session it rolled back (${r.status}: ${r.out.trim()})`);
  check(entries.length === 1 && entries[0].registration.ended_at && !fs.existsSync(wtPath("003-fails")), "ST22: the registration is ended and the worktree is gone");
}

// ST23: resume --json on a live target describes it and attaches nothing
{
  fixture("st23");
  const sleeper = spawnSleep();
  setZmx([zl("Courier-dddd0004")]);
  register({ session_id: "dddd0004-0000-4000-8000-000000000004", terminal_id: "td4", agent: "courier", pid: sleeper.pid, task_dir: cur.tasks[1] });
  const r = cli(["resume", "001", "--json"]);
  let body = null;
  try { body = JSON.parse(r.out); } catch { /* checked below */ }
  check(r.status === 0 && body && body.already_live === true && body.mux.name === "Courier-dddd0004" && body.session_id === "dddd0004-0000-4000-8000-000000000004" && !zmxCalls().some((l) => l.startsWith("zmx attach")),
    `ST23: resume --json on a live session prints it with already_live and does not attach (${r.status}: ${r.out.trim()})`);
}

// ST24: a Courier task records no start marker (start_sha is gone; land reads git)
{
  fixture("st24");
  const r = cliJson(["start", "--courier", "--title", "Fix x", "--no-attach"]);
  const doc = r.data && taskLib.readTaskJson(r.data.task_dir);
  check(doc && doc.phases.length === 1 && !doc.phases[0].start_sha, "ST24: a Courier task writes no start_sha on its phase");
}

// ST25: the failed-resume rule — a session with no transcript refuses exit 4.
{
  fixture("st25");
  const r = cliJson(["start", "001", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso() });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  const regBefore = regBytes(dir);
  const res = cli(["resume", "001", "--json"]);
  check(res.status === 4, `ST25: a resume with no transcript exits 4 (${res.status}: ${res.err.trim()})`);
  const body = res.out.trim() ? JSON.parse(res.out) : null;
  check(body && body.error === "no_transcript" && body.remedy && body.remedy.includes("start it fresh"),
    `ST25: the JSON names no_transcript and the fresh-start remedy (${JSON.stringify(body)})`);
  check(regBytes(dir) === regBefore, "ST25: the registration is byte-identical afterwards");
}

// ST26: a resume whose transcript exists runs as today (the byte-restore rollback stays).
{
  fixture("st26");
  const r = cliJson(["start", "001", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  const transcriptPath = path.join(cur.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  const res = cli(["resume", "001"]);
  check(res.status === 0, `ST26: a resume with an existing transcript runs (${res.status}: ${res.err.trim()})`);
  check(zmxRuns().length > 0, "ST26: zmx ran the resume");
}

// ST27: the start argv carries no --add-dir and the adapter's flags (now in the launch script).
{
  fixture("st27");
  cliJson(["start", "001", "--no-attach"]);
  const lastRun = zmxRunArgvs().pop();
  const scriptPath = lastRun && lastRun[lastRun.length - 1];
  const scriptContent = scriptPath && fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
  check(scriptContent && !scriptContent.includes("--add-dir"), `ST27: the launch script carries no --add-dir (${scriptPath})`);
  check(scriptContent.includes("--session-id") && scriptContent.includes("--agent"), "ST27: the adapter's flags are present in the launch script");
}

// ST28: --worktree copies .env* and links .tasks/<NNN-slug> in both the main checkout and the worktree.
{
  const f = fixture("st28");
  fs.writeFileSync(path.join(f.repoDir, ".env.local"), "KEY=secret\n");
  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST28: start --worktree succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  const wtDir = r.data && r.data.worktree;
  check(wtDir, `ST28: the JSON carries the worktree path (${JSON.stringify(r.data && r.data.worktree)})`);
  // .env.local is a regular copy of the main checkout's file in the worktree
  const envCopy = path.join(wtDir, ".env.local");
  const envStat = fs.existsSync(envCopy) && fs.lstatSync(envCopy);
  check(envStat && envStat.isFile() && !envStat.isSymbolicLink(), `ST28: .env.local in the worktree is a regular file, not a symlink (${envCopy})`);
  check(fs.readFileSync(envCopy, "utf8") === "KEY=secret\n", "ST28: the .env.local copy carries the main checkout's bytes");
  // .tasks/<NNN-slug> symlinks in both the main checkout and the worktree
  const taskDirName = path.basename(f.tasks[1]);
  const mainLink = path.join(f.repoDir, ".tasks", taskDirName);
  const wtLink = path.join(wtDir, ".tasks", taskDirName);
  check(fs.existsSync(mainLink) && fs.lstatSync(mainLink).isSymbolicLink(), `ST28: .tasks/${taskDirName} in the main checkout is a symlink (${mainLink})`);
  check(fs.existsSync(wtLink) && fs.lstatSync(wtLink).isSymbolicLink(), `ST28: .tasks/${taskDirName} in the worktree is a symlink (${wtLink})`);
  check(fs.realpathSync(mainLink) === fs.realpathSync(f.tasks[1]), "ST28: the main checkout's .tasks symlink points at the central folder");
  check(fs.realpathSync(wtLink) === fs.realpathSync(f.tasks[1]), "ST28: the worktree's .tasks symlink points at the central folder");
  // info/exclude carries /.tasks/ once
  const commonDir = git(f.repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const exclude = fs.readFileSync(path.join(commonDir, "info", "exclude"), "utf8");
  const count = (exclude.match(/\/\.tasks\//g) || []).length;
  check(count === 1, `ST28: info/exclude has exactly one /.tasks/ line (${count})`);
}

// ST29: the sweep before create removes a done, clean, unoccupied worktree and reports it.
{
  const f = fixture("st29");
  // Plant a done, clean, unoccupied worktree: check the phase, merge the branch, push, record a land event
  const db = require("./lib/db");
  const taskLib = require("./lib/task");
  const derive = require("./lib/derive");
  const wt = require("./lib/worktree");
  const taskDir = f.tasks[1];
  const taskId = db.taskIdOf(taskDir);
  taskLib.checkPhase({ taskDir, phaseId: 1 });
  const added = wt.add({ projectDir: f.repoDir, taskDir, force: true });
  git(f.repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge");
  git(f.repoDir, "push", "-q", "origin", "main");
  db.appendEvent({ kind: "land", repoKey: f.key.key, taskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(f.repoDir, "rev-parse", "HEAD"), pushed: true, pr_url: null }) });
  derive.invalidateTask(taskId);
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST29: the planted task reads done");
  const addedReal = fs.realpathSync(added.path);
  const marker = path.join(f.root, "st29-teardown.marker");
  const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
  cfg.repos = { [f.key.key]: { teardown: `pwd > ${marker}` } };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));

  // Start a new task with --worktree (triggers the sweep on the create path)
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST29: start succeeds after sweep (${r.status}: ${r.err.trim().slice(-200)})`);
  check(!fs.existsSync(added.path), "ST29: the done worktree is removed by the sweep");
  check(r.data && Array.isArray(r.data.swept) && r.data.swept.some((s) => s.path === added.path), `ST29: the swept array reports the removed worktree (${JSON.stringify(r.data && r.data.swept)})`);
  check(r.data && Array.isArray(r.data.swept) && r.data.swept.some((s) => s.path === added.path && s.teardown && s.teardown.exit_code === 0), `ST29: the swept row carries the teardown run (${JSON.stringify(r.data && r.data.swept)})`);
  check(fs.readFileSync(marker, "utf8").trim() === addedReal, "ST29: the start sweep runs the teardown inside the swept worktree");
}

// ST29b: a .claude/worktrees/* row of the repo joins the start sweep and is removed under the same rule.
{
  const f = fixture("st29b");
  git(f.repoDir, "branch", "harness-test");
  git(f.repoDir, "merge", "harness-test", "-m", "merge harness");
  git(f.repoDir, "push", "-q", "origin", "main");
  const harnessDir = path.join(f.repoDir, ".claude", "worktrees", "test");
  fs.mkdirSync(path.dirname(harnessDir), { recursive: true });
  git(f.repoDir, "worktree", "add", harnessDir, "harness-test");
  check(fs.existsSync(harnessDir), "ST29b: the harness worktree exists");
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST29b: start succeeds after sweep (${r.status}: ${r.err.trim().slice(-200)})`);
  check(!fs.existsSync(harnessDir), "ST29b: the harness worktree is removed by the sweep");
  check(r.data && Array.isArray(r.data.swept) && r.data.swept.some((s) => s.path === harnessDir), `ST29b: the swept array reports the removed harness worktree (${JSON.stringify(r.data && r.data.swept)})`);
}

// ST29c: a throwing sweep is a stderr warning and the start proceeds.
{
  const f = fixture("st29c");
  const db = require("./lib/db");
  const taskLib = require("./lib/task");
  const derive = require("./lib/derive");
  const wt = require("./lib/worktree");
  const taskDir = f.tasks[1];
  const taskId = db.taskIdOf(taskDir);
  taskLib.checkPhase({ taskDir, phaseId: 1 });
  const added = wt.add({ projectDir: f.repoDir, taskDir, force: true });
  git(f.repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge");
  git(f.repoDir, "push", "-q", "origin", "main");
  db.appendEvent({ kind: "land", repoKey: f.key.key, taskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(f.repoDir, "rev-parse", "HEAD"), pushed: true, pr_url: null }) });
  derive.invalidateTask(taskId);
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST29c: the planted task reads done");
  git(f.repoDir, "worktree", "lock", added.path, "--reason", "test");
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST29c: start succeeds despite the throwing sweep (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.err.includes("warning:"), `ST29c: the sweep failure is a stderr warning (${r.err.trim().slice(-200)})`);
  check(fs.existsSync(added.path), "ST29c: the locked worktree stays (the sweep could not remove it)");
  git(f.repoDir, "worktree", "unlock", added.path);
}

// ST29d: the create-path sweep uses the liveness the start already computed — the
// occupied worktree is kept and zmx list runs once for the whole cycle, not twice.
{
  const f = fixture("st29d");
  const db = require("./lib/db");
  const taskLib = require("./lib/task");
  const derive = require("./lib/derive");
  const wt = require("./lib/worktree");
  const taskDir = f.tasks[1];
  const taskId = db.taskIdOf(taskDir);
  taskLib.checkPhase({ taskDir, phaseId: 1 });
  const added = wt.add({ projectDir: f.repoDir, taskDir, force: true });
  git(f.repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge");
  git(f.repoDir, "push", "-q", "origin", "main");
  db.appendEvent({ kind: "land", repoKey: f.key.key, taskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(f.repoDir, "rev-parse", "HEAD"), pushed: true, pr_url: null }) });
  derive.invalidateTask(taskId);
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST29d: the planted task reads done");

  const claude = spawnClaude(); // a live session inside the done worktree
  register({ session_id: "dddd029d-0000-4000-8000-00000000029d", terminal_id: "t29d", pid: claude.pid, pid_at: nowIso(), cwd: added.path, task_dir: taskDir });
  process.env.ZMX_LIST_COUNT = path.join(f.root, "zmx-list-count");
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  const lists = readLog(process.env.ZMX_LIST_COUNT).length;
  delete process.env.ZMX_LIST_COUNT;
  check(r.status === 0, `ST29d: the create-path start succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  check(fs.existsSync(added.path), "ST29d: the live session's worktree is kept (the passed facts are used)");
  check(lists === 1, `ST29d: one zmx list for the whole cycle — the sweep did not re-walk the registry (${lists})`);
}

// ST29e: a teardown that did not complete holds the swept worktree — the start
// itself succeeds, the held array reports it with the run, and the worktree
// survives for the next sweep's retry.
{
  const f = fixture("st29e");
  const db = require("./lib/db");
  const taskLib = require("./lib/task");
  const derive = require("./lib/derive");
  const wt = require("./lib/worktree");
  const taskDir = f.tasks[1];
  const taskId = db.taskIdOf(taskDir);
  taskLib.checkPhase({ taskDir, phaseId: 1 });
  const added = wt.add({ projectDir: f.repoDir, taskDir, force: true });
  git(f.repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "merge", added.branch, "-m", "merge");
  git(f.repoDir, "push", "-q", "origin", "main");
  db.appendEvent({ kind: "land", repoKey: f.key.key, taskId, sessionId: "s", detail: JSON.stringify({ policy: "direct", branch: added.branch, head: git(f.repoDir, "rev-parse", "HEAD"), pushed: true, pr_url: null }) });
  derive.invalidateTask(taskId);
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST29e: the planted task reads done");

  const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
  cfg.repos = { [f.key.key]: { teardown: "sleep 2" } };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  const savedKnob = process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  if (savedKnob === undefined) delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS; else process.env.AGENTS_TEARDOWN_TIMEOUT_MS = savedKnob;
  check(r.status === 0, `ST29e: a held sweep does not fail the start (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.data && !(r.data.swept || []).some((s) => s.path === added.path), `ST29e: the swept array does not name the held worktree (${JSON.stringify(r.data && r.data.swept)})`);
  check(r.data && (r.data.held || []).some((h) => h.path === added.path && h.teardown && h.teardown.exit_code === null), `ST29e: the held array carries the incomplete run (${JSON.stringify(r.data && r.data.held)})`);
  check(fs.existsSync(added.path), "ST29e: the held worktree survives the start");
}

// ST30: the concurrent worktree setup (repos[key] = {setup}) — the bootstrap
// launches in the engine's own Setup-<id8> zmx session while the start returns,
// verified by the belt (the stub's run simulates the runner's first act — its
// pid landing — and creates the pane in the list, so the belt goes green); the
// record lives in the worktree's git dir; the marker keeps today's
// run-once/re-run semantics; a live bootstrap is adopted (its pane named), a
// dead one relaunched; a launch that does not take is reconciled to failed and
// never claimed as running.
{
  const f = fixture("st30");
  const noTeardown = "has a worktree setup command but no teardown";
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  const knobs = (pid) => ({ ZMX_PATCH_RECORD: predictableRecord("001-one"), ZMX_PATCH_PID: String(pid) });
  setRepos({ setup: "sleep 5" });

  // r1: the verified launch — the belt sees the runner's pid land
  const live1 = spawnSleep();
  const r = cliJson(["start", "001", "--worktree", "--no-attach"], { env: knobs(live1.pid) });
  const id8 = r.data && r.data.session_id.slice(0, 8);
  const pane = `Setup-${id8}`;
  const wt = r.data && r.data.worktree;
  const gd = wt && gitdirOf(wt);
  check(r.status === 0, `ST30: a start with a configured setup returns without waiting (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.err.includes(`warning: ${f.key.key} ${noTeardown}`), `ST30: a setup without a teardown warns on stderr (${r.err.trim().slice(-200)})`);
  check(r.err.split(noTeardown).length - 1 === 1, "ST30: the missing-teardown warning appears exactly once");
  check(r.data && r.data.setup && r.data.setup.state === "pending" && r.data.setup.pane === pane && r.data.setup.pane_kind === "zmx",
    `ST30: the JSON setup key says pending in the Setup pane (${JSON.stringify(r.data && r.data.setup)})`);
  check(r.data && r.data.setup && gd && r.data.setup.marker === path.join(gd, "setup-complete") && r.data.setup.log === path.join(gd, "setup.log"),
    "ST30: the JSON setup key carries the marker and log paths");
  check(r.data && r.data.setup_mux && r.data.setup_mux.kind === "zmx" && r.data.setup_mux.name === pane,
    `ST30: the JSON's setup_mux names the verified session (${JSON.stringify(r.data && r.data.setup_mux)})`);
  const runs = setupPaneRuns();
  check(runs.length === 1 && JSON.stringify(runs[0]) === JSON.stringify(["run", pane, "-d", "exec", process.execPath, A, "setup", "run", wt]),
    `ST30: one setup pane run whose argv execs the runner (${JSON.stringify(runs)})`);
  const rec = wt && fs.existsSync(path.join(gitdirOf(wt), "setup.json")) ? readRecord(wt) : null;
  check(rec && rec.state === "pending" && rec.pane_kind === "zmx" && rec.pane === pane && rec.pid === live1.pid && rec.command === "sleep 5",
    `ST30: the record is pending in the pane with the runner's pid (${JSON.stringify(rec)})`);
  check(r.err.split("\n").filter((l) => l.includes(pane)).length === 1, `ST30: stderr names the pane on exactly one line (${r.err.trim().slice(-200)})`);
  check(gd && !fs.existsSync(path.join(gd, "setup-complete")), "ST30: no marker while the bootstrap runs");

  // r2: the marker present → nothing launches, the JSON says complete, setup_mux is null
  plantRecord(wt, { state: "complete", exit_code: 0, finished_at: nowIso() });
  markSetupDone(wt);
  const runs2 = setupPaneRuns().length;
  const r2 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r2.status === 0 && setupPaneRuns().length === runs2, `ST30: a marker present launches nothing (${r2.status}: ${r2.err.trim().slice(-200)})`);
  check(r2.data && r2.data.setup && r2.data.setup.state === "complete" && !r2.data.setup.pane,
    `ST30: the JSON says complete with no pane identity (${JSON.stringify(r2.data && r2.data.setup)})`);
  check(r2.data && r2.data.setup_mux === null, `ST30: a complete setup reports setup_mux null (${JSON.stringify(r2.data && r2.data.setup_mux)})`);

  // r3: the marker deleted → the bootstrap relaunches on the reused worktree
  fs.unlinkSync(path.join(gd, "setup-complete"));
  const live3 = spawnSleep();
  const r3 = cli(["start", "001", "--worktree", "--no-attach"], { env: knobs(live3.pid) });
  let r3rec = null;
  try { r3rec = readRecord(wt); } catch {}
  check(r3.status === 0 && setupPaneRuns().length === runs2 + 1, `ST30: a deleted marker relaunches the bootstrap (${r3.status})`);
  check(r3rec && /^Setup-[0-9a-f]{8}$/.test(r3rec.pane) && r3rec.started_at > rec.started_at, `ST30: the record is rewritten for the relaunch (${JSON.stringify(r3rec)})`);
  check(r3rec && new RegExp(`; setup in ${r3rec.pane}$`).test(r3.out.trim()), `ST30: the summary appends the pane while pending (${r3.out.trim().slice(-90)})`);

  // r4: adoption — a pending record with a live pid launches nothing; the pane is named
  const live4 = spawnSleep();
  plantRecord(wt, { pane: "Setup-st30adopt", pid: live4.pid, command: "sleep 5" });
  setZmx([zl("Setup-st30adopt")]);
  const runs4 = setupPaneRuns().length;
  const r4 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r4.status === 0 && setupPaneRuns().length === runs4, `ST30: a live bootstrap is adopted, not relaunched (${r4.status})`);
  check(r4.data && r4.data.setup && r4.data.setup.state === "pending" && r4.data.setup.pane === "Setup-st30adopt",
    `ST30: the adopted JSON keeps the pending pane identity (${JSON.stringify(r4.data && r4.data.setup)})`);
  check(r4.err.includes("worktree setup: already running in Setup-st30adopt (zmx attach Setup-st30adopt)"),
    `ST30: the adopt line names the pane (${r4.err.trim().slice(-200)})`);
  check(!r4.err.includes("worktree setup: running in"), `ST30: an adopt launches no launch line on stderr (${r4.err.trim().slice(-200)})`);
  check(r4.data && r4.data.setup_mux && r4.data.setup_mux.name === "Setup-st30adopt",
    `ST30: the adopted JSON's setup_mux names the live pane (${JSON.stringify(r4.data && r4.data.setup_mux)})`);

  // r5: a stale pending record (dead pid, no marker) relaunches
  plantRecord(wt, { pane: "Setup-st30stale", pid: deadPid(), command: "sleep 5" });
  const live5 = spawnSleep();
  const r5 = cliJson(["start", "001", "--worktree", "--no-attach"], { env: knobs(live5.pid) });
  let r5rec = null;
  try { r5rec = readRecord(wt); } catch {}
  check(r5.status === 0 && setupPaneRuns().length === runs4 + 1, `ST30: a dead pid relaunches the bootstrap (${r5.status})`);
  check(r5rec && r5rec.pane !== "Setup-st30stale", "ST30: the stale record is rewritten by the relaunch");

  // r6: a launch that does not take — the belt expires twice, the record reconciles to failed
  plantRecord(wt, { state: "failed", exit_code: 9, error: "planted", finished_at: nowIso() });
  const runs6 = setupPaneRuns().length;
  const condBefore6 = zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length;
  const r6 = cliJson(["start", "001", "--worktree", "--no-attach"], { env: { AGENTS_SETUP_LAUNCH_BELT_MS: "300" } });
  let r6rec = null;
  try { r6rec = readRecord(wt); } catch {}
  const runsAfter6 = setupPaneRuns();
  check(r6.status === 0, `ST30: a launch that does not take never fails the start (${r6.status}: ${r6.err.trim().slice(-200)})`);
  check(runsAfter6.length === runs6 + 2, `ST30: the belt retries once — two setup run argvs (${runsAfter6.length - runs6})`);
  check(new Set(runsAfter6.slice(-2).map((w) => w[1])).size === 1, `ST30: both attempts name the same pane (${JSON.stringify(runsAfter6.slice(-2).map((w) => w[1]))})`);
  check(r6rec && r6rec.state === "failed" && /launch did not take/.test(r6rec.error || ""),
    `ST30: the record reconciles to failed with the launch error (${JSON.stringify(r6rec && [r6rec.state, r6rec.error])})`);
  check(!r6.err.includes("running in"), `ST30: stderr never claims a running pane for a dead launch (${r6.err.trim().slice(-200)})`);
  check(r6.err.includes("the launch did not take"), `ST30: the honest line says the launch did not take (${r6.err.trim().slice(-200)})`);
  check(r6.data && r6.data.setup && r6.data.setup.state === "failed" && r6.data.setup_mux === null,
    `ST30: the JSON says failed with setup_mux null (${JSON.stringify(r6.data && [r6.data.setup && r6.data.setup.state, r6.data && r6.data.setup_mux])})`);
  check(zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length === condBefore6 + 1,
    "ST30: the agent session still launches beside the failed bootstrap");

  // r6b: the double fault — attempt 0's run sends but no pid lands (the belt
  // expires), attempt 1's run itself fails: the record must reconcile to
  // failed and the start continue, never hand its still-pending record to the
  // in-process fallback, whose double-run guard would refuse it and fail the
  // start.
  plantRecord(wt, { state: "failed", exit_code: 9, error: "planted", finished_at: nowIso() });
  const runCalls6b = path.join(f.root, "setup-run-calls.txt");
  fs.writeFileSync(runCalls6b, "0\n");
  const runs6b = setupPaneRuns().length;
  const condBefore6b = zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length;
  const r6b = cliJson(["start", "001", "--worktree", "--no-attach"],
    { env: { AGENTS_SETUP_LAUNCH_BELT_MS: "300", STUB_ZMX_SETUP_FAIL_ON: "2", ZMX_SETUP_RUN_CALLS: runCalls6b } });
  let r6brec = null;
  try { r6brec = readRecord(wt); } catch {}
  check(r6b.status === 0, `ST30: a double-fault launch never fails the start (${r6b.status}: ${r6b.err.trim().slice(-300)})`);
  check(setupPaneRuns().length === runs6b + 2, `ST30: the double fault still runs both attempts (${setupPaneRuns().length - runs6b})`);
  check(r6brec && r6brec.state === "failed" && /launch did not take/.test(r6brec.error || "") && /zmx run failed/.test(r6brec.error || ""),
    `ST30: the double fault reconciles to failed naming the retry's fault (${JSON.stringify(r6brec && [r6brec.state, r6brec.error])})`);
  check(!r6b.err.includes("could not launch"), `ST30: no spawn-fallback warn on a double fault (${r6b.err.trim().slice(-300)})`);
  check(!r6b.err.includes("a setup is already running"), `ST30: the fallback never refuses the reconciled record (${r6b.err.trim().slice(-300)})`);
  check(r6b.err.includes("the launch did not take"), `ST30: the honest line covers the double fault (${r6b.err.trim().slice(-300)})`);
  check(r6b.data && r6b.data.setup && r6b.data.setup.state === "failed" && r6b.data.setup_mux === null,
    `ST30: the double fault's JSON says failed with setup_mux null (${JSON.stringify(r6b.data && [r6b.data.setup && r6b.data.setup.state, r6b.data && r6b.data.setup_mux])})`);
  check(zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length === condBefore6b + 1,
    "ST30: the agent session still launches beside the double fault");

  // r7: an ended pane row does not hold a pending record — the relaunch fires
  plantRecord(wt, { pane: "Setup-st30end", command: "sleep 5" });
  setZmx([zl("Setup-st30end", true)]);
  const live7 = spawnSleep();
  const runs7 = setupPaneRuns().length;
  const r7 = cliJson(["start", "001", "--worktree", "--no-attach"], { env: knobs(live7.pid) });
  let r7rec = null;
  try { r7rec = readRecord(wt); } catch {}
  check(r7.status === 0 && setupPaneRuns().length === runs7 + 1, `ST30: an ended pane row relaunches the bootstrap (${r7.status})`);
  check(r7rec && /^Setup-[0-9a-f]{8}$/.test(r7rec.pane) && r7rec.pane !== "Setup-st30end",
    `ST30: the ended pane's record is rewritten (${JSON.stringify(r7rec && r7rec.pane)})`);
  check(r7.data && r7rec && r7.data.setup_mux && r7.data.setup_mux.name === r7rec.pane,
    `ST30: setup_mux names the new session, never the ended one (${JSON.stringify(r7.data && r7.data.setup_mux)})`);

  // A configured teardown silences the warning
  setRepos({ setup: "true", teardown: "true" });
  const r8 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r8.status === 0 && !r8.err.includes(noTeardown), `ST30: a configured teardown silences the warning (${r8.err.trim().slice(-200)})`);

  // No setup at all → no warning, no pane, no setup key, setup_mux null
  setRepos({ teardown: "true" });
  const runs9 = setupPaneRuns().length;
  const r9 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r9.status === 0 && !r9.err.includes(noTeardown) && setupPaneRuns().length === runs9 && !(r9.data && ("setup" in r9.data)),
    `ST30: no setup configured → no warning, no pane, no setup key (${r9.err.trim().slice(-200)})`);
  check(r9.data && r9.data.setup_mux === null, `ST30: no setup configured → setup_mux null (${JSON.stringify(r9.data && r9.data.setup_mux)})`);

  // Opt-out: a setup of "" runs nothing
  setRepos({ setup: "" });
  const runs10 = setupPaneRuns().length;
  const r10 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r10.status === 0 && !r10.err.includes(noTeardown) && setupPaneRuns().length === runs10 && !(r10.data && ("setup" in r10.data)),
    "ST30: an empty setup opts out");
  check(r10.data && r10.data.setup_mux === null, `ST30: an opted-out setup reports setup_mux null (${JSON.stringify(r10.data && r10.data.setup_mux)})`);

  // A main-checkout start carries no setup surface
  setRepos({ setup: "true", teardown: "true" });
  const r11 = cliJson(["start", "002", "--no-attach"]);
  check(r11.status === 0 && !(r11.data && ("setup" in r11.data)) && r11.data && r11.data.setup_mux === null,
    `ST30: a main-checkout start carries no setup key and setup_mux null (${JSON.stringify(r11.data && r11.data.setup_mux)})`);
}

// ST30b: the runner verb `a setup run <worktree>` — the same core the panes
// host, run in the foreground: the outcome record, the pipefail fidelity, the
// timeout knob, the double-run guard and the worktree refusal; the setup env
// is the clean base.
{
  const f = fixture("st30b");
  const markerFile = path.join(f.root, "setup-ran.txt");
  const dumpFile = path.join(f.root, "setup-dump.env");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  setRepos({ setup: "" });
  const r0 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  const wt = r0.data && r0.data.worktree;
  const gd = wt && gitdirOf(wt);
  check(r0.status === 0 && wt, `ST30b: the worktree exists (${r0.status}: ${r0.err.trim().slice(-200)})`);

  // Success + the clean base env (the pavEnv legs, re-pointed at the runner)
  const pav = mk("st30b-pav");
  fs.mkdirSync(path.join(pav, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pav, "pyvenv.cfg"), "home = /usr/bin\n");
  const pavEnv = { PATH: `${path.join(pav, "bin")}:${process.env.PATH}`, VIRTUAL_ENV: pav };
  const setupCmd = `touch ${markerFile} && /usr/bin/env -0 > ${dumpFile}`;
  setRepos({ setup: setupCmd, teardown: "true" });
  const b1 = cli(["setup", "run", wt], { env: pavEnv });
  check(b1.status === 0, `ST30b: a successful runner exits 0 (${b1.status}: ${b1.err.trim().slice(-200)})`);
  const rec = gd && fs.existsSync(path.join(gd, "setup.json")) ? readRecord(wt) : null;
  check(rec && rec.state === "complete" && rec.exit_code === 0 && rec.command === setupCmd && typeof rec.pid === "number",
    `ST30b: the record is complete with the exit code (${JSON.stringify(rec)})`);
  check(gd && fs.existsSync(path.join(gd, "setup-complete")) && fs.existsSync(path.join(gd, "setup.log")) && fs.existsSync(markerFile),
    "ST30b: the marker, the log and the command's own marker file are written");
  const dump = fs.existsSync(dumpFile) ? parseEnvNul(fs.readFileSync(dumpFile, "utf8")) : {};
  check(!("VIRTUAL_ENV" in dump), "ST30b: the setup env has no VIRTUAL_ENV (clean base)");
  check(!("POETRY_ACTIVE" in dump), "ST30b: the setup env has no POETRY_ACTIVE (clean base)");
  check(!(dump.PATH || "").split(":").includes(path.join(pav, "bin")), "ST30b: the setup PATH has no pav venv bin (structural strip)");

  // Failure: the verb exits with the command's status; the record carries code and tail
  if (fs.existsSync(path.join(gd, "setup-complete"))) fs.unlinkSync(path.join(gd, "setup-complete"));
  setRepos({ setup: "echo boom; exit 7", teardown: "true" });
  const b2 = cli(["setup", "run", wt]);
  let rec2 = null;
  try { rec2 = readRecord(wt); } catch {}
  check(b2.status === 7, `ST30b: the runner exits with the command's status (${b2.status})`);
  check(rec2 && rec2.state === "failed" && rec2.exit_code === 7 && /boom/.test(rec2.tail || ""), `ST30b: the failed record carries the exit code and the tail (${JSON.stringify(rec2)})`);
  check(!fs.existsSync(path.join(gd, "setup-complete")), "ST30b: a failed run leaves no marker");

  // Pipefail fidelity: a pipeline's failure inside the command survives the runner's own tee
  setRepos({ setup: "false | tee /dev/null", teardown: "true" });
  const b3 = cli(["setup", "run", wt]);
  let rec3 = null;
  try { rec3 = readRecord(wt); } catch {}
  check(b3.status === 1 && rec3 && rec3.exit_code === 1, `ST30b: pipefail preserves a pipeline's failure (${b3.status})`);

  // The timeout knob
  setRepos({ setup: "sleep 5", teardown: "true" });
  const b4 = cli(["setup", "run", wt], { env: { AGENTS_SETUP_TIMEOUT_MS: "300" } });
  let rec4 = null;
  try { rec4 = readRecord(wt); } catch {}
  check(b4.status === 1, `ST30b: a timed-out runner exits non-zero (${b4.status})`);
  check(rec4 && rec4.state === "failed" && rec4.exit_code === null && rec4.error === "spawnSync zsh ETIMEDOUT", `ST30b: the timeout record (${JSON.stringify(rec4)})`);
  check(!fs.existsSync(path.join(gd, "setup-complete")), "ST30b: a timed-out run leaves no marker");

  // The double-run guard: a live bootstrap refuses, naming the pane
  const busy = spawnSleep();
  plantRecord(wt, { pane: "Setup-st30busy", pid: busy.pid, command: "sleep 5" });
  const b5 = cli(["setup", "run", wt]);
  check(b5.status === 2 && b5.err.includes("Setup-st30busy"), `ST30b: a live bootstrap refuses the runner naming the pane (${b5.status}: ${b5.err.trim().slice(-200)})`);

  // Outside a worktree: the main checkout and a non-repo dir both refuse
  const outside = mk("st30b-outside");
  const b6a = cli(["setup", "run", f.repoDir]);
  const b6b = cli(["setup", "run", outside]);
  check(b6a.status === 2 && b6b.status === 2, `ST30b: the main checkout and a non-repo dir refuse the runner (${b6a.status}/${b6b.status})`);

  // The runner recognizes its own launch record: a begin-shaped pending record
  // (pid null, fresh, its pane listed) naming the very zmx session the runner
  // was exec'd into (its ZMX_SESSION) is this launch, not a competing bootstrap
  // — the 19:44 shape, where the guard read the launcher's own record back and
  // the pane died before its first write.
  setRepos({ setup: "true", teardown: "true" });
  setZmx([zl("Setup-selfrec")]);
  plantRecord(wt, { pane: "Setup-selfrec" });
  const b7 = cli(["setup", "run", wt], { env: { ZMX_SESSION: "Setup-selfrec" } });
  let b7rec = null;
  try { b7rec = readRecord(wt); } catch {}
  check(b7.status === 0, `ST30b: the runner proceeds through its own launch record (${b7.status}: ${b7.err.trim().slice(-200)})`);
  check(b7rec && b7rec.state === "complete" && typeof b7rec.pid === "number",
    `ST30b: the record completes with the runner's own pid (${JSON.stringify(b7rec && [b7rec.state, b7rec.pid])})`);
  check(gd && fs.existsSync(path.join(gd, "setup-complete")), "ST30b: the marker lands through the own-record launch");

  // The carve-out's boundary: the same record without the session match still
  // refuses — a hand runner outside the pane is the guard's purpose.
  if (gd && fs.existsSync(path.join(gd, "setup-complete"))) fs.unlinkSync(path.join(gd, "setup-complete"));
  plantRecord(wt, { pane: "Setup-selfrec" });
  const b8 = cli(["setup", "run", wt]);
  check(b8.status === 2 && b8.err.includes("Setup-selfrec"),
    `ST30b: a hand runner outside the pane still refuses the launch gap (${b8.status}: ${b8.err.trim().slice(-200)})`);

  // The carve-out's pid term: a LIVE pid in the very pane the runner sits in
  // is a concurrent bootstrap, not a launch gap — a hand runner typed into
  // the Setup pane while the real bootstrap runs still refuses, named by pane.
  const busyInPane = spawnSleep();
  plantRecord(wt, { pane: "Setup-selfrec", pid: busyInPane.pid, command: "sleep 5" });
  const b9 = cli(["setup", "run", wt], { env: { ZMX_SESSION: "Setup-selfrec" } });
  check(b9.status === 2 && b9.err.includes("pane Setup-selfrec"),
    `ST30b: a live pid in the runner's own pane still refuses (${b9.status}: ${b9.err.trim().slice(-200)})`);
}

// ST30c: pane-liveness for legacy pav-shaped records — resolve reads the record
// and the zmx list, never PAV's roster: the launch-gap belt adopts a fresh
// pid-less record whose pane is listed (a pav-t-<uuid> pane is still a zmx
// session, still attachable — setup_mux reports it); a past-grace or unlisted
// pane relaunches; a live pid is the truth even when the pane is gone from the
// list — but then there is nothing to attach to, and setup_mux says null.
{
  const f = fixture("st30c");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  const r0 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  const wt = r0.data && r0.data.worktree;
  check(r0.status === 0 && wt, `ST30c: the worktree exists (${r0.status}: ${r0.err.trim().slice(-200)})`);
  setRepos({ setup: "true", teardown: "true" });
  const knobs = (pid) => ({ ZMX_PATCH_RECORD: predictableRecord("001-one"), ZMX_PATCH_PID: String(pid) });

  // The launch-gap belt: a fresh pid-less pav record with the pane listed → adopt
  setZmx([zl("pav-t-st30c1")]);
  plantRecord(wt, { pane_kind: "pav", pane: "pav-t-st30c1" });
  const runs1 = setupPaneRuns().length;
  const r1 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r1.status === 0 && setupPaneRuns().length === runs1, `ST30c: a fresh listed pane is adopted (${r1.status})`);
  check(r1.data && r1.data.setup && r1.data.setup.state === "pending" && r1.data.setup.pane === "pav-t-st30c1" && r1.data.setup.pane_kind === "pav",
    `ST30c: the adopted JSON names the pav pane (${JSON.stringify(r1.data && r1.data.setup)})`);
  check(r1.data && r1.data.setup_mux && r1.data.setup_mux.name === "pav-t-st30c1",
    `ST30c: an adopted legacy pane is still an attachable zmx session (${JSON.stringify(r1.data && r1.data.setup_mux)})`);

  // Past the launch grace → relaunch
  plantRecord(wt, { pane_kind: "pav", pane: "pav-t-st30c1", started_at: new Date(Date.now() - 40000).toISOString() });
  const live2 = spawnSleep();
  const r2 = cliJson(["start", "001", "--worktree", "--no-attach"], { env: knobs(live2.pid) });
  check(r2.status === 0 && setupPaneRuns().length === runs1 + 1, `ST30c: a 40 s-old pid-less record relaunches (${r2.status})`);

  // The pane absent from the list → relaunch
  setZmx([]);
  plantRecord(wt, { pane_kind: "pav", pane: "pav-t-st30c1" });
  const live3 = spawnSleep();
  const r3 = cliJson(["start", "001", "--worktree", "--no-attach"], { env: knobs(live3.pid) });
  check(r3.status === 0 && setupPaneRuns().length === runs1 + 2, `ST30c: an unlisted pane relaunches (${r3.status})`);

  // A live pid is the truth even with the pane gone from the list
  const live = spawnSleep();
  plantRecord(wt, { pane_kind: "pav", pane: "pav-t-st30c4", pid: live.pid });
  const r4 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r4.status === 0 && setupPaneRuns().length === runs1 + 2 && r4.data && r4.data.setup && r4.data.setup.state === "pending",
    `ST30c: a live pid keeps the record pending though the pane is unlisted (${JSON.stringify(r4.data && r4.data.setup)})`);
  check(r4.data && r4.data.setup_mux === null,
    `ST30c: nothing to attach to — setup_mux null beside a pending pid (${JSON.stringify(r4.data && r4.data.setup_mux)})`);
}

// ST30d: the env probe — the start opens beside a real running bootstrap: the
// worktree's .envrc needs an artifact the bootstrap creates (a venv), the
// runner is the real `a setup run` spawned in the background, and the start
// adopts it, waits through the probe and returns with the session registered
// in the worktree while the bootstrap is still mid-flight.
{
  const f = fixture("st30d");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  // The .envrc fails its evaluation until the bootstrap creates the worktree's
  // venv — the `|| exit 1` makes the missing activate a real envrc failure
  // (a bare source of a missing file does not fail direnv's eval).
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "source .venv/bin/activate || exit 1\n");
  // The main checkout is bootstrapped (its .envrc evaluates); the worktree's
  // .venv is what the bootstrap creates.
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), "");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  setRepos({ setup: "sleep 1; mkdir -p .venv/bin && touch .venv/bin/activate; sleep 3", teardown: "true" });
  const ensured = require("./lib/worktree").ensureTaskWorktree({ projectDir: f.repoDir, taskDir: f.tasks[1] });
  const wt = ensured.path;
  check(fs.existsSync(wt), "ST30d: the worktree exists");

  const runner = spawn(process.execPath, [A, "setup", "run", wt], { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const gdD = gitdirOf(wt);
  const recordFile = path.join(gdD, "setup.json");
  let pendingSeen = false;
  for (let i = 0; i < 100 && !pendingSeen; i++) {
    pause(0.1);
    try { if (JSON.parse(fs.readFileSync(recordFile, "utf8")).state === "pending") pendingSeen = true; } catch {}
  }
  check(pendingSeen, "ST30d: the background runner recorded its pending state");

  const runsBefore = setupPaneRuns().length;
  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST30d: the start returns while the bootstrap runs (${r.status}: ${r.err.trim().slice(-200)})`);
  check(setupPaneRuns().length === runsBefore, "ST30d: the start adopted the running bootstrap (no new pane)");
  check(r.err.includes("worktree setup: bootstrap running"), `ST30d: the probe's waiting line names the bootstrap (${r.err.trim().slice(-200)})`);
  check(r.data && r.data.cwd === wt && r.data.setup && r.data.setup.state === "pending",
    `ST30d: the session is registered in the worktree with the setup pending (${JSON.stringify(r.data && r.data.setup)})`);
  check(runner.exitCode === null, "ST30d: the bootstrap was still mid-flight when the start returned");
  const reg = r.data && readReg(r.data.session_dir);
  check(Boolean(reg && reg.cwd === wt), `ST30d: the registration's cwd is the worktree (${reg && reg.cwd})`);
  for (let i = 0; i < 100 && runner.exitCode === null; i++) pause(0.1);
  let recAfter = null;
  try { recAfter = JSON.parse(fs.readFileSync(recordFile, "utf8")); } catch {}
  check(recAfter && recAfter.state === "complete" && fs.existsSync(path.join(gdD, "setup-complete")),
    `ST30d: the bootstrap completed in the background (${JSON.stringify(recAfter && recAfter.state)})`);
  try { process.kill(-runner.pid); } catch {}
}

// ST30dp: the probe refusal — a bootstrap that can never satisfy the
// worktree's .envrc holds the start until the wait cap, then refuses
// setup_failed; the rollback kills the pane, removes the worktree and trashes
// the task — today's failure semantics, now visible. The stub's run leg
// patches a live pid into the record (the runner's first act) so the record
// holds pending through the cap.
{
  const f = fixture("st30dp");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  // The .envrc the bootstrap never satisfies: the main checkout is bootstrapped
  // (its .envrc evaluates), the configured bootstrap (a bare sleep) never
  // creates the worktree's venv — and the missing activate must fail the eval
  // (`|| exit 1`), or direnv would let it pass silently.
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "source .venv/bin/activate || exit 1\n");
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), "");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  setRepos({ setup: "sleep 5", teardown: "true" });
  const live = spawnSleep();
  const recordFile = path.join(f.repoDir, ".git", "worktrees", "003-probe-fail", "setup.json");
  const r = cli(["start", "--title", "Probe fail", "--worktree", "--no-attach", "--json"],
    { env: { AGENTS_SETUP_TIMEOUT_MS: "300", ZMX_PATCH_RECORD: recordFile, ZMX_PATCH_PID: String(live.pid) } });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "setup_failed", `ST30dp: the stuck bootstrap refuses setup_failed (${r.status}: ${JSON.stringify(body && body.error)})`);
  const m = r.err.match(/worktree setup: running in (Setup-[0-9a-f]{8})/);
  check(Boolean(m), `ST30dp: the launch line names the pane (${r.err.trim().slice(0, 160)})`);
  check(r.err.includes("worktree setup: bootstrap running in"), "ST30dp: the probe's waiting line names the bootstrap");
  check(Boolean(m) && zmxArgvs().some((w) => w[0] === "kill" && w[1] === m[1]), `ST30dp: the rollback killed the pane (${m && m[1]})`);
  check(!fs.existsSync(wtPath("003-probe-fail")), "ST30dp: the rolled-back worktree is gone");
  check(!db.listTasks({ disposition: "active" }).some((t) => t.dir_name === "003-probe-fail"), "ST30dp: the rolled-back task is gone from the active list");

  // The same never-satisfied envrc, but the bootstrap finishes INSIDE the
  // belt: the launch verifies (the record left pending), yet nothing is live
  // to arm — the rollback that follows the refusal must not kill the Setup
  // pane, while the worktree and task still clean up.
  const killsBefore = zmxArgvs().filter((w) => w[0] === "kill").length;
  const setupRunsBefore = setupPaneRuns().length;
  const r2 = cli(["start", "--title", "Inside belt", "--worktree", "--no-attach", "--json"],
    { env: { ZMX_FINISH_RECORD: path.join(f.repoDir, ".git", "worktrees", "004-inside-belt", "setup.json") } });
  let body2 = null;
  try { body2 = JSON.parse(r2.out); } catch {}
  check(r2.status === 2 && body2 && body2.error === "envrc_failed",
    `ST30dp: a bootstrap finished inside the belt refuses the env, not the setup (${r2.status}: ${JSON.stringify(body2 && body2.error)})`);
  check(!r2.err.includes("worktree setup: running in"), `ST30dp: a finished bootstrap prints no running-in line (${r2.err.trim().slice(0, 160)})`);
  check(setupPaneRuns().length === setupRunsBefore + 1,
    `ST30dp: the belt verified the finish on the first attempt (${setupPaneRuns().length - setupRunsBefore} runs)`);
  check(zmxArgvs().filter((w) => w[0] === "kill").length === killsBefore,
    "ST30dp: the finished bootstrap armed nothing — no kill on rollback");
  check(!fs.existsSync(wtPath("004-inside-belt")), "ST30dp: the rolled-back worktree is gone");
  check(!db.listTasks({ disposition: "active" }).some((t) => t.dir_name === "004-inside-belt"),
    "ST30dp: the rolled-back task is gone from the active list");
}

// ST30g: the bare-source probe — the owner's real .envrc form (`source
// .venv/bin/activate`, no `|| exit 1`) evaluates green under direnv even with
// the venv missing, so the failing-eval wait cannot fire for it; the main
// checkout's eval yields the venv fingerprint (VIRTUAL_ENV), and the start
// waits on that: the session opens only once the bootstrap has created the
// worktree's venv — no hardening required in the .envrc.
{
  const f = fixture("st30g");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "source .venv/bin/activate\n");
  // The main checkout is bootstrapped and its .envrc yields VIRTUAL_ENV — the
  // fingerprint the probe waits for. The activate must really export it (an
  // empty file sources green but exports nothing).
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), `export VIRTUAL_ENV="${path.join(f.repoDir, ".venv")}"\n`);
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  // The bootstrap creates the worktree's venv at ~2 s, then keeps installing.
  setRepos({ setup: `sleep 2; mkdir -p .venv/bin && echo 'export VIRTUAL_ENV="$PWD/.venv"' > .venv/bin/activate; sleep 3`, teardown: "true" });
  const wt = require("./lib/worktree").ensureTaskWorktree({ projectDir: f.repoDir, taskDir: f.tasks[1] }).path;
  check(fs.existsSync(wt), "ST30g: the worktree exists");

  const runner = spawn(process.execPath, [A, "setup", "run", wt], { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const gdG = gitdirOf(wt);
  const recordFile = path.join(gdG, "setup.json");
  let pendingSeen = false;
  for (let i = 0; i < 100 && !pendingSeen; i++) {
    pause(0.1);
    try { if (JSON.parse(fs.readFileSync(recordFile, "utf8")).state === "pending") pendingSeen = true; } catch {}
  }
  check(pendingSeen, "ST30g: the background runner recorded its pending state");

  const runsBefore = setupPaneRuns().length;
  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  const venvAtReturn = fs.existsSync(path.join(wt, ".venv", "bin", "activate"));
  check(r.status === 0, `ST30g: the start returns while the bootstrap runs (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.err.includes("worktree setup: bootstrap running"), `ST30g: the bare-source eval engages the wait (${r.err.trim().slice(-200)})`);
  check(venvAtReturn, "ST30g: the venv exists when the session opens — the wait ended on the venv, not the clock");
  check(setupPaneRuns().length === runsBefore, "ST30g: the start adopted the running bootstrap (no new pane)");
  check(r.data && r.data.cwd === wt && r.data.setup && r.data.setup.state === "pending",
    `ST30g: the session is registered in the worktree with the setup pending (${JSON.stringify(r.data && r.data.setup)})`);
  check(runner.exitCode === null, "ST30g: the bootstrap was still mid-flight when the start returned");
  for (let i = 0; i < 100 && runner.exitCode === null; i++) pause(0.1);
  let recAfter = null;
  try { recAfter = JSON.parse(fs.readFileSync(recordFile, "utf8")); } catch {}
  check(recAfter && recAfter.state === "complete" && fs.existsSync(path.join(gdG, "setup-complete")),
    `ST30g: the bootstrap completed in the background (${JSON.stringify(recAfter && recAfter.state)})`);
  try { process.kill(-runner.pid); } catch {}
}

// ST30h: an adopted pane survives a failed start — a reuse-start that adopts
// a pending bootstrap never owns the pane's lifecycle: when the start itself
// then fails (the probe cap here), the rollback kills no live bootstrap it
// did not launch; the adopted record stays pending and its runner keeps
// running for the start that did launch it.
{
  const f = fixture("st30h");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "source .venv/bin/activate || exit 1\n");
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), "");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  setRepos({ setup: "sleep 60", teardown: "true" });
  const wt = require("./lib/worktree").ensureTaskWorktree({ projectDir: f.repoDir, taskDir: f.tasks[1] }).path;
  const live = spawnSleep();
  plantRecord(wt, { pane: "Setup-st30hadopt", pid: live.pid, command: "sleep 60" });
  const runsBefore = setupPaneRuns().length;
  const killsBefore = zmxArgvs().filter((w) => w[0] === "kill").length;
  const r = cli(["start", "001", "--worktree", "--no-attach", "--json"], { env: { AGENTS_SETUP_TIMEOUT_MS: "300" } });
  let body = null;
  try { body = JSON.parse(r.out); } catch {}
  check(r.status === 2 && body && body.error === "setup_failed", `ST30h: the never-green env refuses at the cap (${r.status}: ${JSON.stringify(body && body.error)})`);
  check(setupPaneRuns().length === runsBefore, "ST30h: the failing start adopted the pending bootstrap (no new pane)");
  check(zmxArgvs().filter((w) => w[0] === "kill").length === killsBefore,
    `ST30h: the rollback kills no adopted pane (${JSON.stringify(zmxArgvs().filter((w) => w[0] === "kill").slice(-3))})`);
  const rec = readRecord(wt);
  check(rec && rec.state === "pending" && rec.pid === live.pid, `ST30h: the adopted record stays pending with its runner (${JSON.stringify(rec)})`);
  check(Boolean(session.isPidAlive(live.pid)), "ST30h: the adopted runner is still alive");
  check(fs.existsSync(wt), "ST30h: the reused worktree survives the failed start");
  check(db.listTasks({ disposition: "active" }).some((t) => t.dir_name === "001-one"), "ST30h: the pre-existing task is not trashed");
}

// ST30e: without zmx the bootstrap runs in-process, blocking and streaming,
// before the foreground session — today's order, but visible.
{
  const f = fixture("st30e");
  const markerFile = path.join(f.root, "st30e-marker.txt");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  setRepos({ setup: `echo st30e-bootstrap && touch ${markerFile}`, teardown: "true" });
  const r = cli(["start", "001", "--worktree", "--no-attach"], { env: { PATH: `${claudeOnlyBin}:/usr/bin:/bin` } });
  check(r.status === 0, `ST30e: the no-zmx start succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.out.includes("st30e-bootstrap"), `ST30e: the bootstrap's output streams into the start's stdout (${JSON.stringify(r.out.trim().slice(0, 120))})`);
  check(fs.existsSync(markerFile), "ST30e: the bootstrap ran to completion (its marker file)");
  const wt = wtPath("001-one");
  const gd = gitdirOf(wt);
  check(fs.existsSync(path.join(gd, "setup-complete")), "ST30e: the setup marker is written");
  const rec = fs.existsSync(path.join(gd, "setup.json")) ? readRecord(wt) : null;
  check(rec && rec.state === "complete" && rec.pane === null && rec.pane_kind === null, `ST30e: the in-process record completes with no pane (${JSON.stringify(rec)})`);
  check(claudeCalls().length >= 1, `ST30e: the agent stub ran after the bootstrap (${claudeCalls().length})`);
}

// ST30f: the status surfaces — a setup status for every shape, a setup wait
// for the three outcomes.
{
  const f = fixture("st30f");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  setRepos({ setup: "true", teardown: "true" });
  const wt = require("./lib/worktree").ensureTaskWorktree({ projectDir: f.repoDir, taskDir: f.tasks[1] }).path;

  // none: no record, no marker
  const s0 = cliJson(["setup", "status", wt]);
  check(s0.status === 0 && s0.data && s0.data.state === "none", `ST30f: a never-bootstrapped worktree says none (${s0.status}: ${JSON.stringify(s0.data)})`);

  // complete: the real runner, then status and wait
  const run1 = cli(["setup", "run", wt]);
  const s1 = cliJson(["setup", "status", wt]);
  check(run1.status === 0 && s1.status === 0 && s1.data && s1.data.state === "complete" && s1.data.exit_code === 0,
    `ST30f: a completed run statuses complete (${JSON.stringify(s1.data)})`);
  const w1 = cli(["setup", "wait", wt]);
  check(w1.status === 0 && w1.out.trim() === "worktree setup complete", `ST30f: wait returns 0 on complete (${w1.status}: ${w1.out.trim()})`);

  // failed with a tail
  const gdF = gitdirOf(wt);
  if (fs.existsSync(path.join(gdF, "setup-complete"))) fs.unlinkSync(path.join(gdF, "setup-complete"));
  plantRecord(wt, { state: "failed", exit_code: 3, tail: "boom-tail-line", finished_at: nowIso() });
  const s2 = cliJson(["setup", "status", wt]);
  check(s2.status === 0 && s2.data.state === "failed" && s2.data.exit_code === 3 && s2.data.tail === "boom-tail-line",
    `ST30f: a failed run statuses failed with the tail (${JSON.stringify(s2.data)})`);
  const w2 = cli(["setup", "wait", wt]);
  check(w2.status === 1 && w2.err.includes("boom-tail-line") && w2.err.includes("Remedy:"),
    `ST30f: wait returns 1 on failed with the tail and the remedy (${w2.status}: ${w2.err.trim().slice(0, 120)})`);

  // pane gone: a pending record with a dead pid
  plantRecord(wt, { pane: "Setup-st30fgone", pid: deadPid() });
  const s3 = cliJson(["setup", "status", wt]);
  check(s3.status === 0 && s3.data.state === "failed" && s3.data.error === "the pane is gone",
    `ST30f: a dead pid statuses the pane gone (${JSON.stringify(s3.data)})`);

  // pending (live pid): status and the wait budget
  const live = spawnSleep();
  plantRecord(wt, { pane: "Setup-st30flive", pid: live.pid });
  const s4 = cliJson(["setup", "status", wt]);
  check(s4.status === 0 && s4.data.state === "pending", `ST30f: a live pid statuses pending (${JSON.stringify(s4.data)})`);
  const w3 = cli(["setup", "wait", wt, "--timeout", "1"]);
  check(w3.status === 3, `ST30f: wait returns 3 when the budget expires over a pending record (${w3.status})`);

  // The next line names the hosting pane while the bootstrap runs
  setZmx([zl("Setup-st30fnext")]);
  plantRecord(wt, { pane: "Setup-st30fnext" });
  const n1 = cli(["next", "--task-dir", f.tasks[1]]);
  check(n1.status === 0 && n1.out.includes("Setup: pending (Setup-st30fnext)"),
    `ST30f: the next line names the hosting pane (${n1.status}: ${(n1.out.split("\n").find((l) => l.startsWith("Setup:")) || "").trim()})`);
}

// ST30i: a spawn failure on the setup launch falls back to the in-process
// bootstrap — the start warns naming the failure, the bootstrap streams into
// the start's stdout, the marker lands, and the start still succeeds (on this
// degraded path the JSON rides behind the streamed output in stdout).
{
  const f = fixture("st30i");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  setRepos({ setup: "echo st30i-bootstrap", teardown: "true" });
  const r = cli(["start", "001", "--worktree", "--json"], { env: { STUB_ZMX_SETUP_EXIT: "1" } });
  check(r.status === 0, `ST30i: a spawn failure never fails the start (${r.status}: ${r.err.trim().slice(-200)})`);
  check(/worktree setup: could not launch the zmx session/.test(r.err), `ST30i: the warn names the spawn failure (${r.err.trim().slice(-200)})`);
  check(r.out.includes("st30i-bootstrap"), `ST30i: the bootstrap streams into the start's stdout`);
  const wt = wtPath("001-one");
  let gd = null;
  try { gd = gitdirOf(wt); } catch {}
  check(Boolean(gd) && fs.existsSync(path.join(gd, "setup-complete")), "ST30i: the marker lands through the fallback");
  let rec = null;
  if (gd) { try { rec = readRecord(wt); } catch {} }
  check(rec && rec.state === "complete" && rec.exit_code === 0, `ST30i: the record completes in-process (${JSON.stringify(rec && [rec.state, rec.exit_code])})`);
  check(r.out.includes('"setup_mux": null'), `ST30i: the JSON reports setup_mux null`);
  check(zmxRunArgvs().some((w) => String(w[1] || "").startsWith("Conductor-")), "ST30i: the agent session launched after the bootstrap");
}

// ST30j: a bootstrap that finishes inside the belt — the launch verifies (the
// record left pending) but nothing is live: no running-in line ever claims the
// pane, setup_mux says null (nothing to attach to), and the start proceeds to
// the agent session.
{
  const f = fixture("st30j");
  const setRepos = (entry) => {
    const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
    cfg.repos = { [f.key.key]: entry };
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  };
  setRepos({ setup: "sleep 5", teardown: "true" });
  const runsBefore = setupPaneRuns().length;
  const condBefore = zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length;
  const r = cliJson(["start", "001", "--worktree", "--no-attach"],
    { env: { ZMX_FINISH_RECORD: predictableRecord("001-one") } });
  const wt = r.data && r.data.worktree;
  const gd = wt ? gitdirOf(wt) : null;
  check(r.status === 0, `ST30j: a start whose bootstrap finishes inside the belt succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  check(!r.err.includes("worktree setup: running in"), `ST30j: a finished bootstrap prints no running-in line (${r.err.trim().slice(-200)})`);
  check(setupPaneRuns().length === runsBefore + 1, `ST30j: the belt verified the finish on the first attempt (${setupPaneRuns().length - runsBefore} runs)`);
  check(r.data && r.data.setup && r.data.setup.state === "complete" && r.data.setup_mux === null,
    `ST30j: the JSON says complete with setup_mux null (${JSON.stringify(r.data && [r.data.setup && r.data.setup.state, r.data && r.data.setup_mux])})`);
  check(Boolean(gd && fs.existsSync(path.join(gd, "setup-complete"))), "ST30j: the marker landed with the belt-finished bootstrap");
  check(zmxRunArgvs().filter((w) => String(w[1] || "").startsWith("Conductor-")).length === condBefore + 1,
    "ST30j: the agent session launches beside the finished bootstrap");
}

// ST31: re-attaching to the task's existing worktree re-copies .env* files lost since creation.
{
  const f = fixture("st31");
  fs.writeFileSync(path.join(f.repoDir, ".env.local"), "KEY=secret\n");
  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST31: the first start creates the worktree (${r.status}: ${r.err.trim().slice(-200)})`);
  const wtDir = r.data && r.data.worktree;
  fs.unlinkSync(path.join(wtDir, ".env.local"));
  const r2 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r2.status === 0 && r2.data && r2.data.cwd === wtDir, `ST31: the second start reuses the worktree (${r2.status}: ${r2.err.trim().slice(-200)})`);
  check(fs.readFileSync(path.join(wtDir, ".env.local"), "utf8") === "KEY=secret\n", "ST31: the deleted .env.local is copied back on re-attach");
  check(r2.err.includes("worktree env: copied .env.local"), `ST31: the heal is named on stderr (${r2.err.trim().slice(-200)})`);
  const r3 = cliJson(["start", "001", "--worktree", "--no-attach"]);
  check(r3.status === 0 && !r3.err.includes("worktree env:"), `ST31: a third attach with nothing missing copies nothing and stays quiet (${r3.err.trim().slice(-200)})`);
}

// ST31b: resume into a worktree re-copies .env* lost since the session started.
{
  const f = fixture("st31b");
  fs.writeFileSync(path.join(f.repoDir, ".env.local"), "KEY=secret\n");
  const r = cliJson(["start", "001", "--worktree", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  const transcriptPath = path.join(f.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "[]\n");
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, cwd: r.data.worktree, pid: 99999, pid_at: nowIso(), transcript_path: transcriptPath });
  session.markEnded(dir);
  setZmx([zl(`Conductor-${id8}`, true)]);
  fs.unlinkSync(path.join(r.data.worktree, ".env.local"));
  const r2 = cli(["resume", "001"], { env: { STUB_ZMX_SNAP: path.join(dir, "registration.json") } });
  check(r2.status === 0, `ST31b: the resume succeeds (${r2.status}: ${r2.err.trim().slice(-200)})`);
  check(fs.readFileSync(path.join(r.data.worktree, ".env.local"), "utf8") === "KEY=secret\n", "ST31b: the lost .env.local is copied back on resume");
  check(r2.err.includes("worktree env: copied .env.local"), `ST31b: the heal is named on stderr (${r2.err.trim().slice(-200)})`);
}

// --------------------------------------------------------------------------- new env-launch tests

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

// ST-coordinator: a start --coordinator — the roster's coordinator as a first-class agent.
{
  fixture("st-coord");
  const r = cliJson(["start", "001", "--coordinator", "--here", "--no-attach"]);
  const d = r.data;
  const id8 = d && d.session_id.slice(0, 8);
  const reg = d && readReg(d.session_dir);
  check(r.status === 0 && d && reg && reg.agent === "coordinator" && reg.task_dir === cur.tasks[1]
    && reg.mux.name === `Coordinator-${id8}` && d.mux.name === `Coordinator-${id8}`,
    `ST-coordinator: the registration serves lowercase coordinator under the Coordinator-<id8> mux name (${r.status}: ${JSON.stringify(reg && [reg.agent, reg.mux])})`);

  setZmx([zl(`Coordinator-${id8}`)]);
  const roster = cliJson(["ls", "--all"], { cwd: cur.repoDir });
  const row = roster.data && roster.data.sessions.find((s) => s.session_id === d.session_id);
  check(roster.status === 0 && row && row.agent === "coordinator" && row.mux && row.mux.name === `Coordinator-${id8}` && row.task_dir === cur.tasks[1],
    `ST-coordinator: the roster session row carries agent coordinator and the mux name (${JSON.stringify(row && [row.agent, row.mux])})`);

  const withCourier = verb("start", ["001", "--coordinator", "--courier"]);
  check(withCourier.err && withCourier.err.exitCode === 2 && withCourier.err.message.includes("pick one of --conductor, --courier or --coordinator"),
    `ST-coordinator: --coordinator with --courier refuses with the one-agent-flag refusal (${withCourier.err && withCourier.err.message})`);
  const withConductor = verb("start", ["001", "--coordinator", "--conductor"]);
  check(withConductor.err && withConductor.err.exitCode === 2 && withConductor.err.message.includes("pick one of --conductor, --courier or --coordinator"),
    `ST-coordinator: --coordinator with --conductor refuses the same way (${withConductor.err && withConductor.err.message})`);

  check(start.parseArgs(["-o"]).coordinator === true
    && JSON.stringify(start.parseArgs(["001", "-o", "-n"])) === JSON.stringify(start.parseArgs(["001", "--coordinator", "--no-attach"])),
    "ST-coordinator: -o parses like --coordinator");

  const help = cli(["start", "--help"]);
  check(help.status === 0 && help.out.includes("--coordinator") && help.out.includes("the roster's coordinator"),
    `ST-coordinator: a start --help prints the --coordinator flag row (${help.status}: ${help.out.slice(0, 80)})`);

  // SessionStart arriving on the launched entry: agent_type Coordinator lands lowercased;
  // a payload omitting the agent leaves the launch's value standing.
  const hook = require("./lib/adapter/claude-code/session-register");
  process.env.AGENTS_SESSION_DIR = d.session_dir;
  try {
    hook.run({ session_id: d.session_id, agent_type: "Coordinator", cwd: cur.repoDir });
    check(readReg(d.session_dir).agent === "coordinator",
      `ST-coordinator: a SessionStart payload with agent_type Coordinator keeps the stored agent lowercase (${readReg(d.session_dir).agent})`);
    hook.run({ session_id: d.session_id, cwd: cur.repoDir });
    check(readReg(d.session_dir).agent === "coordinator",
      "ST-coordinator: a SessionStart payload omitting the agent leaves the launch's coordinator standing");
  } finally {
    delete process.env.AGENTS_SESSION_DIR;
  }
}

// ST-coordinator-shim: the a-coordinator wrapper.
{
  fixture("st-coord-shim");
  const wrapper = (args) => spawnSync("sh", [path.join(BIN, "a-coordinator"), ...args], {
    encoding: "utf8", cwd: cur.repoDir, env: { ...process.env, PATH: `${stubBin}:${BIN}:${process.env.PATH}` },
  });
  const a = wrapper(["--title", "Coord thing", "--no-attach", "--json"]);
  const data = a.status === 0 ? JSON.parse(a.stdout) : null;
  const reg = data && readReg(data.session_dir);
  const doc = data && taskLib.readTaskJson(data.task_dir);
  check(a.status === 0 && reg && reg.agent === "coordinator" && reg.task_dir === data.task_dir && reg.mux.name.startsWith("Coordinator-"),
    `ST-coordinator-shim: a-coordinator --title execs a start --coordinator (${a.status}: ${a.stderr.trim()})`);
  check(doc && doc.title === "Coord thing" && doc.mode !== "fast" && doc.tier !== "minor",
    `ST-coordinator-shim: the coordinator-started new task gets the defaults, not the courier shaping (${doc && JSON.stringify([doc.mode, doc.tier])})`);
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
