#!/usr/bin/env node
"use strict";
// The concurrent worktree setup (repos[key] = {setup}) — bootstrap, runner,
// env probes: the setup shard of the former test-lib-start (split when the
// suite outgrew every per-suite budget; see test-lib-start.js). With stub zmx and claude.
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

// Calls a verb in process; a refusal comes back as `err` (with its exitCode).
function verb(name, argv, deps = {}) {
  try {
    return { res: start[name](start.parseArgs(argv, name), { cwd: cur.repoDir, ...deps }) };
  } catch (err) {
    return { err };
  }
}
const answers = (...replies) => { const asked = []; const ask = (q, choices) => { asked.push({ q, choices }); return replies.shift(); }; ask.asked = asked; return ask; };

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
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "echo eval >> ./.eval-probe\nsource .venv/bin/activate || exit 1\n");
  // The main checkout is bootstrapped (its .envrc evaluates); the worktree's
  // .venv is what the bootstrap creates.
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), "");
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  setRepos({ setup: "n=0; until [ -e ./.eval-probe ] || [ \"$n\" -ge 900 ]; do sleep 0.1; n=$((n+1)); done; mkdir -p .venv/bin && touch .venv/bin/activate; sleep 3", teardown: "true" });
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
  fs.writeFileSync(path.join(f.repoDir, ".envrc"), "echo eval >> ./.eval-probe\nsource .venv/bin/activate\n");
  // The main checkout is bootstrapped and its .envrc yields VIRTUAL_ENV — the
  // fingerprint the probe waits for. The activate must really export it (an
  // empty file sources green but exports nothing).
  fs.mkdirSync(path.join(f.repoDir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(f.repoDir, ".venv", "bin", "activate"), `export VIRTUAL_ENV="${path.join(f.repoDir, ".venv")}"\n`);
  execFileSync("direnv", ["allow"], { cwd: f.repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  // The bootstrap creates the worktree's venv only after the .envrc's eval
  // probe appears — the venv's existence causally follows the child's first
  // eval, at any load.
  setRepos({ setup: "n=0; until [ -e ./.eval-probe ] || [ \"$n\" -ge 900 ]; do sleep 0.1; n=$((n+1)); done; mkdir -p .venv/bin && echo 'export VIRTUAL_ENV=\"$PWD/.venv\"' > .venv/bin/activate; sleep 3", teardown: "true" });
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

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
