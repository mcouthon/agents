#!/usr/bin/env node
"use strict";
// `a resume` and the --json shapes, markers, env re-copy, the coordinator —
// the resume shard of the former test-lib-start (split when the suite outgrew
// every per-suite budget; see test-lib-start.js). With stub zmx and claude.
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
const world = require("./fixture-world");

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
  const repoDir = path.join(root, "work", "acme");
  world.clonePair(T, "acme", origin, repoDir);
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
  const wrapper = (args) => runCapture("sh", [path.join(BIN, "a-courier"), ...args], { cwd: cur.repoDir, env: { ...process.env, PATH: `${stubBin}:${BIN}:${process.env.PATH}` } });
  const a = wrapper(["--title", "x", "--no-attach", "--json"]);
  const doc = a.status === 0 && taskLib.readTaskJson(JSON.parse(a.out).task_dir);
  check(doc && doc.mode === "fast" && doc.title === "x", `ST15: a-courier --title starts a courier task (${a.status}: ${a.err.trim()})`);
  const count = taskCount();
  const b = wrapper(["Fix", "typo", "--no-attach"]);
  check(b.status === 2 && b.err.includes("typo") && taskCount() === count, `ST15: an unquoted multi-word title exits 2 naming the extra word (${b.status}: ${b.err.trim()})`);
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
  // Off the capture door: this watches stderr during the run — a post-exit read cannot replace it.
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
  const wrapper = (args) => runCapture("sh", [path.join(BIN, "a-coordinator"), ...args], {
    cwd: cur.repoDir, env: { ...process.env, PATH: `${stubBin}:${BIN}:${process.env.PATH}` },
  });
  const a = wrapper(["--title", "Coord thing", "--no-attach", "--json"]);
  const data = a.status === 0 ? JSON.parse(a.out) : null;
  const reg = data && readReg(data.session_dir);
  const doc = data && taskLib.readTaskJson(data.task_dir);
  check(a.status === 0 && reg && reg.agent === "coordinator" && reg.task_dir === data.task_dir && reg.mux.name.startsWith("Coordinator-"),
    `ST-coordinator-shim: a-coordinator --title execs a start --coordinator (${a.status}: ${a.err.trim()})`);
  check(doc && doc.title === "Coord thing" && doc.mode !== "fast" && doc.tier !== "minor",
    `ST-coordinator-shim: the coordinator-started new task gets the defaults, not the courier shaping (${doc && JSON.stringify([doc.mode, doc.tier])})`);
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
