#!/usr/bin/env node
"use strict";
// The start sweep — a closed task's worktree removed before create: the sweep
// shard of the former test-lib-start (split when the suite outgrew every
// per-suite budget; see test-lib-start.js). With stub zmx and claude.
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

// ST29: the sweep before create removes a closed task's clean, unoccupied worktree and reports it.
{
  const f = fixture("st29");
  // Plant a done, clean, unoccupied worktree, then close the task: check the
  // phase, merge the branch, push, record a land event, archive the folder
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
  const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), f.key.key);
  fs.mkdirSync(archiveBase, { recursive: true });
  fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
  db.setTaskDisposition({ repoKey: f.key.key, dirName: path.basename(taskDir), disposition: "archived" });
  const addedReal = fs.realpathSync(added.path);
  const marker = path.join(f.root, "st29-teardown.marker");
  const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
  cfg.repos = { [f.key.key]: { teardown: `pwd > ${marker}` } };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));

  // Start a new task with --worktree (triggers the sweep on the create path)
  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST29: start succeeds after sweep (${r.status}: ${r.err.trim().slice(-200)})`);
  check(!fs.existsSync(added.path), "ST29: the closed task's worktree is removed by the sweep");
  check(r.data && Array.isArray(r.data.swept) && r.data.swept.some((s) => s.path === added.path), `ST29: the swept array reports the removed worktree (${JSON.stringify(r.data && r.data.swept)})`);
  check(r.data && Array.isArray(r.data.swept) && r.data.swept.some((s) => s.path === added.path && s.teardown && s.teardown.exit_code === 0), `ST29: the swept row carries the teardown run (${JSON.stringify(r.data && r.data.swept)})`);
  check(fs.readFileSync(marker, "utf8").trim() === addedReal, "ST29: the start sweep runs the teardown inside the swept worktree");
  const st29Receipt = path.join(f.wtRoot, "acme", ".removed", `${path.basename(added.path)}.json`);
  check(fs.existsSync(st29Receipt), `ST29: the sweep writes a receipt (${st29Receipt})`);
  const st29Rc = JSON.parse(fs.readFileSync(st29Receipt, "utf8"));
  check(st29Rc.kind === "worktree_removed" && st29Rc.reason === "a start's sweep" && st29Rc.path === added.path
    && st29Rc.branch === added.branch && st29Rc.repo === f.repoDir && st29Rc.actor === "unattributed",
    `ST29: the receipt names the sweep's removal (${JSON.stringify(st29Rc)})`);
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
  const st29bReceipt = path.join(f.wtRoot, "acme", ".removed", "test.json");
  check(fs.existsSync(st29bReceipt), `ST29b: the harness worktree's receipt lands in the repo's worktrees root, never inside the removed worktree (${st29bReceipt})`);
  const st29bRc = JSON.parse(fs.readFileSync(st29bReceipt, "utf8"));
  check(st29bRc.reason === "a start's sweep" && st29bRc.path === harnessDir && st29bRc.branch === "harness-test" && st29bRc.repo === f.repoDir,
    `ST29b: the harness receipt names path, branch, repo and reason (${JSON.stringify(st29bRc)})`);
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
  const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), f.key.key);
  fs.mkdirSync(archiveBase, { recursive: true });
  fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
  db.setTaskDisposition({ repoKey: f.key.key, dirName: path.basename(taskDir), disposition: "archived" });
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
  const archiveBase = path.join(require("./lib/tasks-root").archiveRoot(), f.key.key);
  fs.mkdirSync(archiveBase, { recursive: true });
  fs.renameSync(taskDir, path.join(archiveBase, path.basename(taskDir)));
  db.setTaskDisposition({ repoKey: f.key.key, dirName: path.basename(taskDir), disposition: "archived" });

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

// ST29f: a done, not-closed task's worktree survives the start's sweep — no
// array names it, the directory and the branch stay, and the start succeeds.
{
  const f = fixture("st29f");
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
  check(derive.taskStatusOf(db.getTask(taskId), taskLib.readTaskJson(taskDir)) === "done", "ST29f: the planted task reads done");

  const r = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(r.status === 0, `ST29f: the start succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
  check(r.data && !(r.data.swept || []).some((s) => s.path === added.path), `ST29f: the swept array names nothing of the done, not-closed worktree (${JSON.stringify(r.data && r.data.swept)})`);
  check(r.data && !(r.data.held || []).some((h) => h.path === added.path), `ST29f: the held array names nothing of it (${JSON.stringify(r.data && r.data.held)})`);
  check(fs.existsSync(added.path), "ST29f: the done, not-closed worktree survives the start's sweep");
  check(git(f.repoDir, "branch", "--list", added.branch) !== "", "ST29f: the branch survives the sweep too");
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
