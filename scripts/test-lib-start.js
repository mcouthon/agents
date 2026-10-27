#!/usr/bin/env node
"use strict";
// `a start`, `a attach`, `a resume`: the session verbs, with stub zmx and claude.
// Isolation: nothing here may touch the real HOME, config, git config, zmx or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-start-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "claudebin", "procs"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.writeFileSync(path.join(t, "home", ".claude", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
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
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "VIRTUAL_ENV", "POETRY_ACTIVE", "STUB_ZMX_EXIT", "STUB_ZMX_SNAP", "STUB_CLAUDE_EXIT"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");
const BIN = path.join(__dirname, "bin");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const start = require("./lib/start");
const { repoKey } = require("./lib/repo");

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
  '  list) [ -f "$ZMX_LIST_FILE" ] && cat "$ZMX_LIST_FILE"; exit 0 ;;',
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

// ---------------------------------------------------------------- start
// ST1: the registration and the launch line.
fixture("st1");
{
  const r = cliJson(["start", "001", "--no-attach"]);
  const d = r.data;
  const id8 = d && d.session_id.slice(0, 8);
  const reg = d && readReg(d.session_dir);
  check(r.status === 0 && d && d.session_dir === path.join(cur.sessions, d.terminal_id), `ST1: registers under <sessions>/<terminal_id> (exit ${r.status}: ${r.err.trim()})`);
  check(reg && reg.task_dir === cur.tasks[1] && reg.origin === "cli" && reg.initiator === "user" && reg.agent === "conductor" && reg.pid === null && reg.mux.name === `Conductor-${id8}`,
    `ST1: the registration binds task 001 with no pid and the zmx name (${JSON.stringify(reg)})`);
  const expected =`exec env -u VIRTUAL_ENV -u POETRY_ACTIVE AGENTS_SESSION_DIR='${d && d.session_dir}' 'claude' '--session-id' '${d && d.session_id}' '--agent' 'Conductor' '--add-dir' '${cur.tasksRoot}'`;
  const argvs = zmxRunArgvs();
  check(argvs.length === 1 && JSON.stringify(argvs[0]) === JSON.stringify(["run", `Conductor-${id8}`, "-d", "sh", "-c", expected]), `ST1: one zmx run whose argv is sh -c <the launch line> (${JSON.stringify(argvs)})`);
  check(!zmxCalls().some((l) => l.startsWith("zmx attach")), "ST1: --no-attach does not attach");
}

// ST1v: an activated virtualenv in the launching shell is not carried into the session; PATH is left as it was.
fixture("st1v");
{
  const { shellQuote } = require("./lib/cc");
  const launching = { VIRTUAL_ENV: path.join(T, "venv"), POETRY_ACTIVE: "1", PATH: `${path.join(T, "venv", "bin")}:${process.env.PATH}` };
  const r = cliJson(["start", "001", "--no-attach"], { env: launching });
  const d = r.data;
  const words = d ? ["claude", "--session-id", d.session_id, "--agent", "Conductor", "--add-dir", cur.tasksRoot].map(shellQuote).join(" ") : "";
  const expected = `exec env -u VIRTUAL_ENV -u POETRY_ACTIVE AGENTS_SESSION_DIR=${d && shellQuote(d.session_dir)} ${words}`;
  const line = (zmxRunArgvs()[0] || [])[5];
  check(r.status === 0 && line === expected, `ST1v: the launch line unsets VIRTUAL_ENV and POETRY_ACTIVE and adds no PATH word (${r.status}: ${r.err.trim()} ${line})`);

  const ran = spawnSync("sh", ["-c", line], { env: { ...launching, CLAUDE_LOG: process.env.CLAUDE_LOG }, encoding: "utf8" });
  const log = readLog(process.env.CLAUDE_LOG);
  check(ran.status === 0 && log.includes("VENV=unset,unset") && log.includes(`PATH=${launching.PATH}`), `ST1v: the session sees neither variable and the same PATH (${ran.status}: ${ran.stderr.trim()} ${JSON.stringify(log)})`);
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
  check(refused.status === 2 && refused.err.includes("a attach 001") && session.entries().length === 1 && zmxRuns().length === 0,
    `ST4b: without a TTY the refusal points to a attach 001 (${refused.status}: ${refused.err.trim()})`);
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
  check(refused.status === 2 && refused.err.includes("a attach aaaa0042") && refused.err.includes("a attach 001-one") && zmxRuns().length === 0,
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
  const doc = taskLib.readTaskJson(cur.tasks[2]);
  const link = path.join(wt, ".tasks");
  check(first.status === 0 && first.data.cwd === wt && git(cur.key.main_root, "branch", "--list", "wt/002-two").includes("wt/002-two"),
    `ST5: the session runs in ~/.agents/worktrees/acme/002-two on branch wt/002-two (${first.status}: ${first.err.trim()})`);
  check(doc.phases[0].branch === "wt/002-two", `ST5: the open phase carries the branch (${doc.phases[0].branch})`);
  check(fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(path.join(cur.key.main_root, ".tasks")), "ST5: .tasks in the worktree links to the main checkout's .tasks");
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
  check(c.status === 0 && zmxRuns().pop().endsWith("'--model' 'opus'"), `ST5b: arguments after -- reach claude (${zmxRuns().pop()})`);
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
  check(fs.lstatSync(path.join(wt, ".tasks")).isSymbolicLink(), "ST5c: .tasks is linked again");
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

// ST10: the config's launch command and env file.
fixture("st10");
{
  const envFile = path.join(cur.root, "claude.env");
  fs.writeFileSync(envFile, "A=1\n");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: envFile } }));
  const a = cliJson(["start", "001", "--no-attach"]);
  const envLine = `set -a && . '${envFile}' && set +a && exec env -u VIRTUAL_ENV -u POETRY_ACTIVE AGENTS_SESSION_DIR='${a.data.session_dir}' 'claude' '--session-id' '${a.data.session_id}' '--agent' 'Conductor' '--add-dir' '${cur.tasksRoot}'`;
  check(a.status === 0 && JSON.stringify(zmxRunArgvs().pop()) === JSON.stringify(["run", a.data.mux.name, "-d", "sh", "-c", envLine]), `ST10: the env file is sourced first (${JSON.stringify(zmxRunArgvs().pop())})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: path.join(cur.root, "missing.env") } }));
  const runs = zmxRuns().length, entries = session.entries().length;
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 2 && b.err.includes(path.join(cur.root, "missing.env")) && zmxRuns().length === runs && session.entries().length === entries && taskCount() === 2,
    `ST10: a missing env file exits 2 naming it and changes nothing (${b.status}: ${b.err.trim()})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { command: "myclaude" } }));
  const c = cliJson(["start", "002", "--no-attach"]);
  const cmdLine = `exec env -u VIRTUAL_ENV -u POETRY_ACTIVE AGENTS_SESSION_DIR='${c.data.session_dir}' 'myclaude' '--session-id' '${c.data.session_id}' '--agent' 'Conductor' '--add-dir' '${cur.tasksRoot}'`;
  check(c.status === 0 && JSON.stringify(zmxRunArgvs().pop()) === JSON.stringify(["run", c.data.mux.name, "-d", "sh", "-c", cmdLine]), `ST10: launch.command replaces claude (${JSON.stringify(zmxRunArgvs().pop())})`);
}

// ST10b: a relative env file resolves against the config file's directory.
fixture("st10b");
{
  const cfgDir = path.join(cur.root, "cfg");
  fs.mkdirSync(path.join(cfgDir, "env"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "env", "claude.env"), "A=1\n");
  process.env.AGENTS_CONFIG_PATH = path.join(cfgDir, "config.json");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: "env/claude.env" } }));
  const a = cli(["start", "001", "--no-attach"]);
  const w = zmxRunArgvs().pop() || [];
  check(a.status === 0 && w.length === 6 && JSON.stringify([w[0], w[2], w[3], w[4]]) === JSON.stringify(["run", "-d", "sh", "-c"]) && w[5].startsWith(`set -a && . '${path.join(cfgDir, "env", "claude.env")}' && set +a && exec env `), `ST10b: the line sources the config-relative absolute path (${JSON.stringify(w)})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ launch: { env_file: "env/missing.env" } }));
  const runs = zmxRuns().length, entries = session.entries().length;
  const b = cli(["start", "002", "--no-attach"]);
  check(b.status === 2 && b.err.includes(path.join(cfgDir, "env", "missing.env")) && zmxRuns().length === runs && session.entries().length === entries && taskCount() === 2,
    `ST10b: a missing relative env file exits 2 naming the resolved path (${b.status}: ${b.err.trim()})`);
  process.env.AGENTS_CONFIG_PATH = path.join(T, "cfg.json");
}

// ST11: arguments after -- reach claude.
fixture("st11");
{
  const r = cli(["start", "001", "--no-attach", "--", "--model", "opus"]);
  check(r.status === 0 && zmxRuns().pop().endsWith("'--model' 'opus'"), `ST11: the launch line ends with the passthrough (${zmxRuns().pop()})`);
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
  check(b.status === 0 && (b.out + b.err).includes("local main is 1 commits behind origin/main") && git(cur.key.main_root, "rev-list", "--count", "main") === "1",
    `ST12: a local base behind origin is reported and left alone (${b.status}: ${b.out}${b.err})`);
}

// ---------------------------------------------------------------- attach
// ST13: attach.
{
  fixture("st13a");
  setZmx([zl("Conductor-aaaa0130")]);
  register({ session_id: "aaaa0130-0000-4000-8000-000000000130", terminal_id: "t130", mux: { kind: "zmx", name: "Conductor-aaaa0130" }, task_dir: cur.tasks[1] });
  const a = cli(["attach", "001"]);
  check(a.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0130", `ST13a: a live zmx session is attached (${a.status}: ${a.err.trim()})`);

  setZmx([zl("Conductor-aaaa0130", true)]);
  session.markEnded(path.join(cur.sessions, "t130"));
  const b = cli(["attach", "001"]);
  check(b.status === 4 && b.err.includes("a resume 001"), `ST13b: an ended session points to a resume (${b.status}: ${b.err.trim()})`);

  fixture("st13c");
  setZmx([zl("Courier-cccc0131")]);
  register({ session_id: "cccc0131-0000-4000-8000-000000000131", terminal_id: "t131", agent: "courier", task_dir: cur.tasks[1] });
  const c = cli(["attach", "001"]);
  check(c.status === 0 && zmxCalls().pop() === "zmx attach Courier-cccc0131", `ST13c: an entry with no mux matches its <Agent>-<id8> name (${c.status}: ${c.err.trim()})`);

  fixture("st13d");
  const claude = spawnClaude();
  register({ session_id: "aaaa0133-0000-4000-8000-000000000133", terminal_id: "t133", pid: claude.pid, pid_at: nowIso(), task_dir: cur.tasks[1] });
  const d = cli(["attach", "001"]);
  check(d.status === 4 && d.err.includes(`runs outside zmx (pid ${claude.pid})`) && zmxCalls().length === 0, `ST13d: a pid-only session cannot be attached (${d.status}: ${d.err.trim()})`);

  fixture("st13e");
  setZmx([zl("Conductor-aaaa0132"), zl("Conductor-bbbb0132", true)]);
  register({ session_id: "aaaa0132-0000-4000-8000-000000000132", terminal_id: "t132a", mux: { kind: "zmx", name: "Conductor-aaaa0132" }, task_dir: cur.tasks[1] });
  pause();
  register({ session_id: "bbbb0132-0000-4000-8000-000000000132", terminal_id: "t132b", mux: { kind: "zmx", name: "Conductor-bbbb0132" }, task_dir: cur.tasks[1] });
  session.markEnded(path.join(cur.sessions, "t132b"));
  const e = cli(["attach", "001"]);
  check(e.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0132", `ST13e: the live entry wins over the newer ended one (${e.status}: ${e.err.trim()})`);
}

// ---------------------------------------------------------------- resume
// ST14: resume in a fresh zmx session, with the registration written once, before the run.
function endedEntry() {
  const r = cliJson(["start", "001", "--no-attach"]);
  const dir = r.data.session_dir, sid = r.data.session_id, id8 = sid.slice(0, 8);
  register({ session_id: sid, terminal_id: r.data.terminal_id, session_dir: dir, pid: 99999, pid_at: nowIso() });
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
  const resumeLine = `exec env -u VIRTUAL_ENV -u POETRY_ACTIVE AGENTS_SESSION_DIR='${dir}' 'claude' '--resume' '${sid}' '--agent' 'Conductor' '--add-dir' '${cur.tasksRoot}'`;
  check(r.status === 0 && JSON.stringify(run) === JSON.stringify(["run", `Conductor-${id8}-r1`, "-d", "sh", "-c", resumeLine]) && lastCwd() === `cwd ${cur.key.main_root}`,
    `ST14: resume runs claude --resume under the next free name in the entry's cwd (${r.status}: ${r.err.trim()} ${JSON.stringify(run)})`);
  check(snap.mux.name === `Conductor-${id8}-r1` && !("ended_at" in snap) && snap.pid === null && !("pid_at" in snap), `ST14: zmx run already saw the new mux, no ended_at, no pid (${JSON.stringify(snap)})`);
  check(regBytes(dir) === fs.readFileSync(process.env.ZMX_LOG + ".snap", "utf8") && !fs.existsSync(path.join(cur.sessions, sid)), "ST14: nothing is written after the run and no <session_id> dir appears");

  setZmx([zl(`Conductor-${id8}`, true), zl(`Conductor-${id8}-r1`)]);
  const runs = zmxRuns().length;
  const again = cli(["resume", "001"]);
  check(again.status === 0 && zmxCalls().pop() === `zmx attach Conductor-${id8}-r1` && zmxRuns().length === runs, `ST14: a resumed session that is live is attached, not run again (${zmxCalls().pop()})`);

  setZmx([zl(`Conductor-${id8}`, true), zl(`Conductor-${id8}-r1`, true)]);
  const third = cli(["resume", "001"]);
  const w3 = zmxRunArgvs().pop() || [];
  check(third.status === 0 && w3.length === 6 && JSON.stringify(w3.slice(0, 5)) === JSON.stringify(["run", `Conductor-${id8}-r2`, "-d", "sh", "-c"]), `ST14: after -r1 ended the next name is -r2 (${JSON.stringify(w3)})`);

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
  const a3 = cli(["attach", "5555aaaa"]);
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
  check(b.status === 4 && b.err.includes("a attach 6666bbbb") && b.err.includes(`pid ${claude.pid}`) && zmxRuns().length === 0 && claudeCalls().length === 0
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
  const line = (zmxRunArgvs().pop() || [])[5] || "";
  check(resumed.status === 0 && line.includes(`'--resume' '${ended.sid}'`), `ST19c: a resume picks the Conductor, not the newer ended dispatch entry (${resumed.status}: ${resumed.err.trim()} ${line})`);

  fixture("st19d");
  setZmx([zl("Conductor-aaaa0194")]);
  register({ session_id: "aaaa0194-0000-4000-8000-000000000194", terminal_id: "t194", mux: { kind: "zmx", name: "Conductor-aaaa0194" }, task_dir: cur.tasks[1] });
  pause();
  const claudeD = spawnClaude();
  dispatchEntry("195", { pid: claudeD.pid, pid_at: nowIso() });
  const attached = cli(["attach", "001"]);
  check(attached.status === 0 && zmxCalls().pop() === "zmx attach Conductor-aaaa0194", `ST19d: an attach by task goes to the Conductor, not the newer live dispatch entry (${attached.status}: ${attached.err.trim()})`);

  const byId = cli(["attach", "dddd0195"]);
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

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
