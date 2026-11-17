#!/usr/bin/env node
"use strict";
// `a restart`: end a coordinator, replace it fresh — through the CLI, with stub zmx and claude.
// The stub zmx serves the pane tail from a file, logs sends (the text to a send log,
// the pane's death from the list when ZMX_SEND_ENDS=1), and fails on demand — the
// pane read, a send, the kill (STUB_ZMX_HISTORY_EXIT, STUB_ZMX_SEND_EXIT,
// STUB_ZMX_KILL_EXIT; a failed send or kill lands in no log and no list).
// Isolation: nothing here may touch the real HOME, config, git config, zmx or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-restart-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "procs", "xdg-data"]) fs.mkdirSync(path.join(t, d));
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
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "ZMX_SESSION", "VIRTUAL_ENV", "POETRY_ACTIVE", "STUB_ZMX_EXIT", "STUB_CLAUDE_EXIT",
    "AGENTS_RESTART_EXIT_TIMEOUT_MS", "ZMX_SEND_ENDS", "STUB_ZMX_KILL_EXIT",
    "STUB_ZMX_HISTORY_EXIT", "STUB_ZMX_SEND_EXIT"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const world = require("./fixture-world");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Stub zmx and claude: they log their argv, list answers from $ZMX_LIST_FILE, history
// serves $ZMX_HISTORY_FILE, send logs its stdin to $ZMX_SEND_LOG, and the levers —
// ZMX_SEND_ENDS drops the pane's line once Enter lands (the clean exit), while
// STUB_ZMX_HISTORY_EXIT, STUB_ZMX_SEND_EXIT and STUB_ZMX_KILL_EXIT fail their
// arm before any side effect lands.
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  "drop() {",
  '  [ -f "${ZMX_LIST_FILE:-}" ] || return 0',
  '  awk -v p="name=$1\t" \'index($0, p) != 1\' "$ZMX_LIST_FILE" > "$ZMX_LIST_FILE.new"',
  '  mv "$ZMX_LIST_FILE.new" "$ZMX_LIST_FILE"',
  "}",
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  '  list) [ -f "$ZMX_LIST_FILE" ] && cat "$ZMX_LIST_FILE"; exit 0 ;;',
  "  history)",
  '    printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  '    echo "cwd $PWD" >> "$ZMX_LOG"',
  '    if [ -n "${STUB_ZMX_HISTORY_EXIT:-}" ]; then exit "$STUB_ZMX_HISTORY_EXIT"; fi',
  '    [ -f "${ZMX_HISTORY_FILE:-}" ] && cat "$ZMX_HISTORY_FILE"',
  "    exit 0 ;;",
  "  send)",
  "    text=$(cat)",
  '    printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  '    echo "cwd $PWD" >> "$ZMX_LOG"',
  '    if [ -n "${STUB_ZMX_SEND_EXIT:-}" ]; then exit "$STUB_ZMX_SEND_EXIT"; fi',
  '    printf \'%s\\n\' "$text" >> "${ZMX_SEND_LOG:?ZMX_SEND_LOG not set}"',
  '    if [ "${ZMX_SEND_ENDS:-0}" = "1" ] && [ "$text" = "$(printf \'\\r\')" ]; then drop "$2"; fi',
  "    exit 0 ;;",
  "  kill)",
  '    printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  '    echo "cwd $PWD" >> "$ZMX_LOG"',
  '    if [ -n "${STUB_ZMX_KILL_EXIT:-}" ]; then exit "$STUB_ZMX_KILL_EXIT"; fi',
  '    drop "$2"',
  "    exit 0 ;;",
  "esac",
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
const nowIso = () => new Date().toISOString();

// The fixture: repo acme with a local bare origin and two open tasks, fresh roots and logs.
let cur;
function fixture(label) {
  const root = mk(label);
  Object.assign(process.env, {
    AGENTS_TASKS_ROOT: path.join(root, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
    AGENTS_DB: path.join(root, "agents.db"),
    ZMX_LOG: path.join(root, "zmx.log"),
    CLAUDE_LOG: path.join(root, "claude.log"),
    ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
    ZMX_HISTORY_FILE: path.join(root, "pane.vt"),
    ZMX_SEND_LOG: path.join(root, "send.log"),
  });
  const wtRoot = path.join(root, "worktrees");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ worktrees_root: wtRoot }));
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  db.open({ create: true });
  const origin = path.join(root, "origin.git");
  const repoDir = path.join(root, "work", "acme");
  world.clonePair(T, "acme", origin, repoDir);
  const key = repoKey(repoDir);
  const mkTask = (slug, title) => taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  const tasks = { 1: mkTask("one", "One"), 2: mkTask("two", "Two") };
  cur = { root, repoDir, key, tasks, wtRoot, sessions: process.env.AGENTS_SESSIONS_ROOT, tasksRoot: process.env.AGENTS_TASKS_ROOT };
  return cur;
}

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
function zmxArgvs() {
  const calls = [];
  let words = [];
  for (const l of readLog(process.env.ZMX_LOG)) {
    if (l.startsWith("cwd ")) { calls.push(words); words = []; } else words.push(l);
  }
  return calls;
}
const zmxRunArgvs = () => zmxArgvs().filter((w) => w[0] === "run");
const sendArgvs = () => zmxArgvs().filter((w) => w[0] === "send");
const killArgvs = () => zmxArgvs().filter((w) => w[0] === "kill");
const zl = (name) => `name=${name}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp`;
const setZmx = (lines) => fs.writeFileSync(process.env.ZMX_LIST_FILE, lines.map((l) => l + "\n").join(""));
const setPane = (text) => fs.writeFileSync(process.env.ZMX_HISTORY_FILE, text);
const readReg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "registration.json"), "utf8"));
const wtPath = (name) => path.join(cur.wtRoot, "acme", name);
const eventsOf = (kind) => {
  const d = new DatabaseSync(process.env.AGENTS_DB, { readOnly: true });
  try { return d.prepare("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail)); } finally { d.close(); }
};

// vt fixtures (the shapes of scripts/test-lib-pane.js): the grey suggestion renders inside SGR 2 (dim)
// after a bare glyph, typed text renders non-dim; a permission prompt shows its
// marker and indented option lines instead of an input box.
const VT_SUGGEST_LINE = "❯\xa0\x1b[0m\x1b[2mTry \"how do I log an error?\"\x1b[0m";
const VT_TYPED_LINE = "❯\xa0\x1b[38;5;15mapprove the plan\x1b[0m";
const VT_NO_BOX_LINE = "  a plain output row — the input box has scrolled out of the tail";
const PANE_VT = (inputLine) => [
  "  \x1b[36m⏺\x1b[0m Reading the plan for phase 2",
  inputLine,
  "  \x1b[2m───────── Coordinator ─────────\x1b[0m",
  "\x1b[?25l\x1b[2;1H",
  "",
].join("\n");
const PROMPT_VT = [
  "  \x1b[36m⏺\x1b[0m Bash(rm) needs your confirmation",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No, and tell it what to change",
  "",
].join("\n");

// Transcript fixtures: an idle tail ends with its marker newest; a running tail
// holds assistant evidence after the marker (or none at all — a first turn).
const IDLE_ROWS = [
  { type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { content: "fix the restart" } },
  { type: "assistant", timestamp: "2026-11-15T10:00:05.000Z", message: { content: "on it" } },
  { type: "system", subtype: "turn_duration", timestamp: "2026-11-15T10:00:06.000Z" },
];
const RUNNING_ROWS = [
  { type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { content: "fix the restart" } },
  { type: "assistant", timestamp: "2026-11-15T10:00:05.000Z", message: { content: "on it" } },
  { type: "system", subtype: "turn_duration", timestamp: "2026-11-15T10:00:06.000Z" },
  { type: "assistant", timestamp: "2026-11-15T10:00:07.000Z", message: { content: "still working" } },
];
const FIRST_TURN_ROWS = [
  { type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { content: "fix the restart" } },
  { type: "assistant", timestamp: "2026-11-15T10:00:05.000Z", message: { content: "on it" } },
];
const plantTranscript = (rows) => {
  const p = path.join(cur.root, `transcript-${session.mintId()}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

// Plants a registration and returns { sid, id8, name, dir }. A zmx list line and
// mux make it live (unless `ended` or `zmx: false`), a pid makes it live outside zmx.
function plant(agent, { task = cur.tasks[1], cwd = null, transcript = null, pid = null, ended = false, zmx = true } = {}) {
  const sid = session.mintId();
  const terminalId = session.mintId();
  const name = `${agent[0].toUpperCase()}${agent.slice(1)}-${sid.slice(0, 8)}`;
  const dir = path.join(cur.sessions, terminalId);
  session.register({
    origin: "cli", initiator: "user", agent, cwd: cwd || cur.key.main_root, repo_key: cur.key.key,
    session_dir: dir, terminal_id: terminalId, session_id: sid, task_dir: task,
    ...(pid ? { pid, pid_at: nowIso() } : {}),
    ...((zmx && !ended) ? { mux: { kind: "zmx", name } } : {}),
    ...(transcript ? { transcript_path: transcript } : {}),
  });
  if (ended) session.markEnded(dir);
  else setZmx(zmx ? [zl(name)] : []);
  return { sid, id8: sid.slice(0, 8), name, dir };
}

function cli(args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: cur.repoDir, timeout: 60000, env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function cliJson(args, opts) { const r = cli([...args, "--json"], opts); return { ...r, data: r.status === 0 && r.out ? JSON.parse(r.out) : null }; }
const errJson = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const errCode = (r) => { const e = errJson(r); return e && e.error; };

// ---------------------------------------------------------------- R1: no target
fixture("r1");
{
  const r = cli(["restart"]);
  check(r.status === 2 && r.err.includes("a restart needs a task or a session"),
    `R1: a restart without a target refuses with exit 2 and the message (${r.status}: ${r.err.trim()})`);
  const j = cli(["restart", "--json"]);
  check(j.status === 2 && errCode(j) === "refused", `R1: the --json refusal prints an error object (exit ${j.status}, ${j.out.trim().slice(0, 60)})`);
}

// ---------------------------------------------------------------- R2: unknown session
fixture("r2");
{
  // findEntry resolves every target through the zmx list probe (the production
  // 2 s budget plus one 5 s retry — this scene deliberately rides storms out
  // at the un-knobbed budgets; the timeout scenarios own the knob), which a
  // loaded battery can push even this stub past — the engine's zmx_timeout
  // refusal is the designed storm answer, not this scene's subject. Ride the
  // storm out and settle on the first non-storm outcome; the lock does not
  // weaken — a real break fails every leg identically.
  let r = cli(["restart", "bogus-session"]);
  for (let leg = 0; leg < 2 && r.status === 2 && r.err.includes("timed out twice"); leg++) {
    execFileSync("/bin/sleep", ["2"]);
    r = cli(["restart", "bogus-session"]);
  }
  check(r.status === 4 && r.err.includes("No session for bogus-session"),
    `R2: an unknown target refuses with exit 4 and findEntry's message (${r.status}: ${r.err.trim()})`);
}

// ---------------------------------------------------------------- R3: a non-coordinator refuses, nothing ended
fixture("r3");
{
  const c = plant("courier", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "not_coordinator" && r.err.includes("is a Courier session") && r.err.includes("coordinator session only"),
    `R3: a Courier refuses with not_coordinator naming Courier (${r.status}: ${r.err.trim().slice(0, 120)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0, "R3: nothing was sent or killed");
  check(readReg(c.dir).ended_at === undefined, "R3: the Courier stays unended");
}

// ---------------------------------------------------------------- R4: the happy path, the full JSON contract
fixture("r4");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1" } });
  const d = r.data;
  check(r.status === 0 && d !== null, `R4: a live idle coordinator restarts with exit 0 (${r.status}: ${r.err.trim().slice(0, 200)})`);
  check(d && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R4: the JSON carries previous_session_id, the old id, beside a NEW session_id (${d && d.previous_session_id})`);
  const newId8 = d && d.session_id.slice(0, 8);
  check(d && JSON.stringify(Object.keys(d)) === JSON.stringify([
    "session_id", "terminal_id", "session_dir", "task_dir", "cwd", "worktree", "mux", "attach", "swept", "held", "setup_mux", "previous_session_id",
  ]), `R4: the JSON is start's field list plus previous_session_id, nothing renamed or moved (${d && Object.keys(d).join(",")})`);
  check(d && d.mux && d.mux.name === `Coordinator-${newId8}` && d.attach === `zmx attach Coordinator-${newId8}` && d.task_dir === cur.tasks[1]
    && d.cwd === cur.key.main_root && d.worktree === null,
    `R4: the fresh session is a Coordinator pane on the same task in the same cwd (${d && d.mux && d.mux.name})`);
  check(d && JSON.stringify(readLog(process.env.ZMX_SEND_LOG)) === JSON.stringify(["/exit", "\r"]),
    `R4: the end typed /exit then Enter (${JSON.stringify(readLog(process.env.ZMX_SEND_LOG))})`);
  const sends = sendArgvs();
  const run = zmxRunArgvs().find((w) => w[1] === `Coordinator-${newId8}`);
  check(sends.length === 2 && sends.every((w) => w[1] === c.name) && Boolean(run) && run[2] === "-d" && run[3] === "exec" && run[4] === "sh" && fs.existsSync(run[5]),
    `R4: two sends to the old pane, then one run of the fresh session's launch script (${JSON.stringify(sends)} then ${JSON.stringify(run)})`);
  check(Boolean(readReg(c.dir).ended_at), "R4: the old registration's end is recorded");
  const regNew = d && readReg(d.session_dir);
  check(regNew && regNew.previous_session_id === c.sid && regNew.agent === "coordinator" && regNew.task_dir === cur.tasks[1],
    `R4: the new registration carries the linkage, the agent and the task (${regNew && JSON.stringify([regNew.previous_session_id, regNew.agent, regNew.task_dir])})`);
  const script = d && run && fs.readFileSync(run[5], "utf8");
  check(d && script && script.includes(`'--session-id' '${d.session_id}'`) && script.includes(`'--agent' 'Coordinator'`) && !script.includes("'--resume'"),
    `R4: the fresh session launches fresh — its own session id and --agent Coordinator, no --resume (${script && script.slice(0, 60)}…)`);
  const starts = eventsOf("start");
  check(d && starts.length === 1 && starts[0].session_id === d.session_id && starts[0].task_dir === cur.tasks[1],
    `R4: one start event row for the new session id (${JSON.stringify(starts)})`);
  check(r.err.includes(`restart: Coordinator session ${c.id8} exited cleanly`), `R4: stderr notes the clean exit (${r.err.trim()})`);
}

// ---------------------------------------------------------------- R5: already ended, resolved by id8 prefix
fixture("r5");
{
  const c = plant("coordinator", { ended: true });
  const r = cliJson(["restart", c.id8]);
  const d = r.data;
  check(r.status === 0 && d !== null && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R5: an ended coordinator restarts by its id8 prefix to a fresh session (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && !zmxArgvs().some((w) => w[0] === "history"),
    "R5: the end flow is skipped — no send, no kill, no pane read");
  check(r.err.includes(`restart: Coordinator session ${c.id8} had already ended`), `R5: stderr notes the already-ended state (${r.err.trim()})`);
  check(readReg(d.session_dir).previous_session_id === c.sid, "R5: the new registration carries the linkage");
}

// ---------------------------------------------------------------- R6: a worktree coordinator restarts in its worktree
fixture("r6");
{
  const base = cliJson(["start", "002", "--worktree", "--no-attach"]);
  const wt = wtPath("002-two");
  check(base.status === 0 && base.data.cwd === wt, `R6: the fixture start created the task's worktree (${base.status}: ${base.err.trim().slice(0, 120)})`);
  const c = plant("coordinator", { task: cur.tasks[2], cwd: wt, transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1" } });
  const d = r.data;
  check(r.status === 0 && d && d.worktree === wt && d.cwd === wt && d.task_dir === cur.tasks[2],
    `R6: the replacement runs in the same worktree (${r.status}: ${JSON.stringify(d && [d.worktree, d.cwd])})`);
  check(d && readReg(d.session_dir).cwd === wt, "R6: the new registration records the worktree cwd");
  check(Boolean(readReg(c.dir).ended_at), "R6: the old coordinator's end is recorded");
}

// ---------------------------------------------------------------- R7: a typed draft refuses, nothing ended
fixture("r7");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_TYPED_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "draft_pending" && r.err.includes("holds an unsent draft") && r.err.includes("approve the plan"),
    `R7: a typed draft refuses with draft_pending and the last input line (${r.status}: ${r.err.trim().slice(0, 140)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined,
    "R7: nothing was sent, nothing ended");
}

// ---------------------------------------------------------------- R8: a running turn refuses (transcript first)
fixture("r8a");
{
  const c = plant("coordinator", { transcript: plantTranscript(RUNNING_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "turn_running" && r.err.includes("is mid-turn"),
    `R8a: evidence newer than the last turn end refuses with turn_running (${r.status}: ${r.err.trim().slice(0, 120)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined && !zmxArgvs().some((w) => w[0] === "history"),
    "R8a: nothing was sent or ended, the pane was not even read — the transcript refused first");
}
fixture("r8b");
{
  const c = plant("coordinator", { transcript: plantTranscript(FIRST_TURN_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "turn_running",
    `R8b: evidence with no turn-end marker yet — a first turn in flight — refuses the same way (${r.status}: ${r.err.trim().slice(0, 100)})`);
  check(sendArgvs().length === 0 && readReg(c.dir).ended_at === undefined, "R8b: nothing was sent or ended");
}

// ---------------------------------------------------------------- R9: an open permission prompt refuses
fixture("r9");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PROMPT_VT);
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "prompt_pending" && r.err.includes("holds an open permission prompt"),
    `R9: an open permission prompt refuses with prompt_pending (${r.status}: ${r.err.trim().slice(0, 120)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined,
    "R9: nothing was sent or ended — a pane with no input box cannot receive /exit");
}

// ---------------------------------------------------------------- R10: the exit times out, the kill lands, it proceeds
fixture("r10");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], { env: { AGENTS_RESTART_EXIT_TIMEOUT_MS: "1000" } });
  const d = r.data;
  check(r.status === 0 && d && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R10: a coordinator that will not exit is killed and replaced (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(killArgvs().length === 1 && JSON.stringify(killArgvs()[0]) === JSON.stringify(["kill", c.name]),
    `R10: exactly one zmx kill of the old pane (${JSON.stringify(killArgvs())})`);
  check(Boolean(readReg(c.dir).ended_at), "R10: the killed session's end is recorded");
  check(r.err.includes(`restart: Coordinator session ${c.id8} did not exit within`) && r.err.includes(`killed its zmx session ${c.name}`),
    `R10: stderr names the kill (${r.err.trim()})`);
}

// ---------------------------------------------------------------- R11: the kill fails — the end is NOT recorded, the target stays live
fixture("r11");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"], { env: { AGENTS_RESTART_EXIT_TIMEOUT_MS: "300", STUB_ZMX_KILL_EXIT: "1" } });
  const e = errJson(r);
  check(r.status === 2 && e && e.error === "kill_failed" && r.err.includes(`zmx kill ${c.name}`) && e.remedy && e.remedy.includes("end it by hand"),
    `R11: a failed kill refuses with kill_failed and the hand remedy (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(readReg(c.dir).ended_at === undefined, "R11: the end is NOT recorded — a live pane must not read as exited");
  check(zmxRunArgvs().length === 0 && fs.readFileSync(process.env.ZMX_LIST_FILE, "utf8").includes(`name=${c.name}`),
    "R11: no replacement was launched and the pane still holds its zmx list line");
}

// ---------------------------------------------------------------- R12: a live coordinator outside zmx
fixture("r12");
{
  const claude = spawnClaude();
  const c = plant("coordinator", { pid: claude.pid, zmx: false });
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 4 && r.err.includes(`runs outside zmx (pid ${claude.pid})`),
    `R12: a pid-only coordinator refuses with exit 4 and the switch-to-terminal remedy (${r.status}: ${r.err.trim()})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined, "R12: nothing was sent or ended");
}

// ---------------------------------------------------------------- R13: no recorded task
fixture("r13");
{
  const c = plant("coordinator", { task: null, transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 4 && errCode(r) === "no_task" && r.err.includes("has no recorded task"),
    `R13: a taskless coordinator refuses with no_task (${r.status}: ${r.err.trim().slice(0, 120)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined,
    "R13: nothing was ended — the task check runs before any end work");
}

// ---------------------------------------------------------------- R14: another live session holds the task — the pre-check refuses before anything ends
fixture("r14");
{
  const courier = plant("courier", { transcript: plantTranscript(IDLE_ROWS) });
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setZmx([zl(c.name), zl(courier.name)]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "task_occupied" && r.err.includes(`already has a live Courier session ${courier.name}`) && r.err.includes("001-one"),
    `R14: a held task refuses with task_occupied naming the occupant (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0,
    "R14: nothing was sent or killed — the refusal fires before the end");
  check(readReg(c.dir).ended_at === undefined && fs.readFileSync(process.env.ZMX_LIST_FILE, "utf8").includes(`name=${c.name}`),
    "R14: the target coordinator stays live — ended with no replacement is the one outcome this verb must never produce");
}

// ---------------------------------------------------------------- R15: the human output
fixture("r15");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--no-attach"], { env: { ZMX_SEND_ENDS: "1" } });
  const run = zmxRunArgvs().find((w) => w[1] && w[1].startsWith("Coordinator-"));
  const newName = run && run[1];
  check(r.status === 0 && newName && r.out.trim() === `Session ${newName} (Coordinator) on 001-one in ${cur.key.main_root}`,
    `R15: without --json the stdout is start's summary line (${r.status}: ${r.out.trim()})`);
  check(r.err.includes(`restart: Coordinator session ${c.id8} exited cleanly`), `R15: stderr carries the end note (${r.err.trim()})`);
  check(!zmxArgvs().some((w) => w[0] === "attach"), "R15: --no-attach never attaches");
  const regNew = session.entries().find((e) => e.registration.mux && e.registration.mux.name === newName);
  check(regNew && regNew.registration.previous_session_id === c.sid, "R15: the linkage rides the new registration in the human path too");
}

// ---------------------------------------------------------------- R16: no input box in the pane tail
fixture("r16");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_NO_BOX_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  check(r.status === 2 && errCode(r) === "no_input_box" && r.err.includes("shows no input box line") && r.err.includes("cannot prove the input is empty"),
    `R16: a pane whose tail holds no input box refuses with no_input_box (${r.status}: ${r.err.trim().slice(0, 140)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined,
    "R16: nothing was sent or ended — an input that cannot be proven empty is not treated as empty");
}

// ---------------------------------------------------------------- R17: the pane read itself fails
fixture("r17");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"], { env: { STUB_ZMX_HISTORY_EXIT: "1" } });
  check(r.status === 2 && errCode(r) === "zmx_history_failed" && r.err.includes(`zmx history failed for ${c.name}`),
    `R17: a failed pane read refuses with zmx_history_failed and the pane lib's message (${r.status}: ${r.err.trim().slice(0, 140)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined,
    "R17: nothing was sent or ended — the pane could not even be read");
}

// ---------------------------------------------------------------- R18: the /exit send itself fails
fixture("r18");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"], { env: { STUB_ZMX_SEND_EXIT: "1" } });
  check(r.status === 1 && errCode(r) === "spawn_failed" && r.err.includes(`zmx send failed for ${c.name}`),
    `R18: a failed zmx send refuses with exit 1 and spawn_failed (${r.status}: ${r.err.trim().slice(0, 140)})`);
  check(sendArgvs().length === 1 && readLog(process.env.ZMX_SEND_LOG).length === 0 && killArgvs().length === 0
    && readReg(c.dir).ended_at === undefined && zmxRunArgvs().length === 0,
    "R18: the /exit was attempted but never landed — nothing killed, ended or launched");
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
