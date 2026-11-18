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
    "AGENTS_RESTART_EXIT_TIMEOUT_MS", "AGENTS_RESTART_FLUSH_TIMEOUT_MS", "AGENTS_RESTART_KILL_GRACE_MS",
    "ZMX_SEND_ENDS", "STUB_ZMX_KILL_EXIT", "STUB_ZMX_KILL_PLAIN_EXIT",
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
// arm before any side effect lands; STUB_ZMX_KILL_PLAIN_EXIT fails only the
// kills without --force (the wedged pane that survives a plain kill).
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
  '    case "$*" in',
  '      *--force*) ;;',
  '      *) if [ -n "${STUB_ZMX_KILL_PLAIN_EXIT:-}" ]; then exit "$STUB_ZMX_KILL_PLAIN_EXIT"; fi ;;',
  '    esac',
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

// A future-dated idle tail — the timestamps sit past the run on purpose: the
// engine compares milliseconds and cannot tell the dates are ahead, so the
// flush's transcript verify finds its user row at/after the submit and the
// turn-end marker satisfies the flush wait instantly. A fixture trick, not a
// behavior claim about real transcripts.
const flushLandedRows = () => {
  const ahead = (s) => new Date(Date.now() + s * 1000).toISOString();
  return [
    { type: "user", timestamp: ahead(60), message: { content: "this row is the flushed submit stand-in: long enough that the verify window counts it as the landed hand-off, well past the one-chunk flush line" } },
    { type: "assistant", timestamp: ahead(61), message: { content: "hand-off written to the records" } },
    { type: "system", subtype: "turn_duration", timestamp: ahead(62) },
  ];
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

function cli(args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: cwd || cur.repoDir, timeout: 60000, env: { ...process.env, ...env } });
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
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
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
  const sent = readLog(process.env.ZMX_SEND_LOG);
  check(sent.length === 4 && sent[0].includes("hand-off") && sent[1] === "\r" && sent[2] === "/exit" && sent[3] === "\r",
    `R4: the end typed the flush (one chunk, by its hand-off wording), its Enter, /exit then Enter (${JSON.stringify(sent)})`);
  const sends = sendArgvs();
  const run = zmxRunArgvs().find((w) => w[1] === `Coordinator-${newId8}`);
  check(sends.length === 4 && sends.every((w) => w[1] === c.name) && Boolean(run) && run[2] === "-d" && run[3] === "exec" && run[4] === "sh" && fs.existsSync(run[5]),
    `R4: four sends to the old pane (the flush's two, /exit's two), then one run of the fresh session's launch script (${JSON.stringify(sends)} then ${JSON.stringify(run)})`);
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
  check(r.err.includes(`restart: Coordinator session ${c.id8} exited cleanly`) && r.err.includes("did not land within"),
    `R4: stderr notes the unverified flush beside the clean exit (${r.err.trim()})`);
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
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
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
  const r = cliJson(["restart", c.sid], { env: { AGENTS_RESTART_EXIT_TIMEOUT_MS: "1000", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
  const d = r.data;
  check(r.status === 0 && d && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R10: a coordinator that will not exit is killed and replaced (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(killArgvs().length === 1 && JSON.stringify(killArgvs()[0]) === JSON.stringify(["kill", c.name]),
    `R10: exactly one zmx kill of the old pane (${JSON.stringify(killArgvs())})`);
  check(Boolean(readReg(c.dir).ended_at), "R10: the killed session's end is recorded");
  check(r.err.includes(`restart: Coordinator session ${c.id8} did not exit within`) && r.err.includes(`killed its zmx session ${c.name}`),
    `R10: stderr names the kill (${r.err.trim()})`);
}

// ---------------------------------------------------------------- R11: the ladder is exhausted — the end is NOT recorded, the target stays live
fixture("r11");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"], {
    env: { AGENTS_RESTART_EXIT_TIMEOUT_MS: "300", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300", AGENTS_RESTART_KILL_GRACE_MS: "300", STUB_ZMX_KILL_EXIT: "1" },
  });
  const e = errJson(r);
  check(r.status === 2 && e && e.error === "kill_failed" && r.err.includes(`zmx kill ${c.name}`) && r.err.includes("--force")
    && e.remedy && e.remedy.includes("end it by hand"),
    `R11: both kills failing refuses with kill_failed naming the forced attempt and the hand remedy (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(JSON.stringify(killArgvs()) === JSON.stringify([["kill", c.name], ["kill", c.name, "--force"]]),
    `R11: the ladder ran both rungs — the plain kill, then the forced one (${JSON.stringify(killArgvs())})`);
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
  const r = cli(["restart", c.sid, "--no-attach"], { env: { ZMX_SEND_ENDS: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
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

// ---------------------------------------------------------------- R18: a send that fails fails the flush's first, then /exit's
fixture("r18");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"], { env: { STUB_ZMX_SEND_EXIT: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
  check(r.status === 1 && errCode(r) === "spawn_failed" && r.err.includes(`zmx send failed for ${c.name}`),
    `R18: a failed zmx send refuses with exit 1 and spawn_failed (${r.status}: ${r.err.trim().slice(0, 140)})`);
  check(sendArgvs().length === 2 && readLog(process.env.ZMX_SEND_LOG).length === 0 && killArgvs().length === 0
    && readReg(c.dir).ended_at === undefined && zmxRunArgvs().length === 0,
    "R18: the flush's send and /exit were each attempted but neither landed — nothing killed, ended or launched");
}

// ---------------------------------------------------------------- R19: the registry never blocks a restart
// The registry-shaped fixture (the tasks root IS the repo — a clonePair pair
// under template key reg, its one task living inside it, tracked dirt on the
// seeded README): an ended coordinator restarts into a fresh start whose gate
// snapshots the root instead of refusing it — the whole unattended chain
// (restart → fresh start → gate → snapshot → launch) a renewal leans on.
{
  const root = mk("r19");
  const origin = path.join(root, "origin.git");
  const repoDir = path.join(root, "reg");
  world.clonePair(T, "reg", origin, repoDir);
  Object.assign(process.env, {
    AGENTS_TASKS_ROOT: repoDir,
    AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
    AGENTS_DB: path.join(root, "agents.db"),
    ZMX_LOG: path.join(root, "zmx.log"),
    CLAUDE_LOG: path.join(root, "claude.log"),
    ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
    ZMX_HISTORY_FILE: path.join(root, "pane.vt"),
    ZMX_SEND_LOG: path.join(root, "send.log"),
  });
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ worktrees_root: path.join(root, "worktrees") }));
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  db.open({ create: true });
  const key = repoKey(repoDir);
  const taskDir = taskLib.createTask({ repo: key, title: "One", slug: "one", mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  cur = { root, repoDir, key, tasks: { 1: taskDir }, wtRoot: path.join(root, "worktrees"), sessions: process.env.AGENTS_SESSIONS_ROOT, tasksRoot: process.env.AGENTS_TASKS_ROOT };
  fs.appendFileSync(path.join(repoDir, "README.md"), "dirty\n");
  const c = plant("coordinator", { task: taskDir, cwd: repoDir, ended: true, zmx: false });
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  const r = cli(["restart", c.sid, "--no-attach"], { cwd: repoDir });
  const newReg = session.entries().find((e) => e.registration.previous_session_id === c.sid);
  check(r.status === 0 && newReg && newReg.registration.session_id !== c.sid
    && /^snapshot /.test(git(repoDir, "log", "-1", "--format=%s"))
    && git(repoDir, "status", "--porcelain", "--untracked-files=no") === "",
    `R19: a restart into a tracked-dirty tasks root snapshots and relaunches (${r.status}: ${(r.out + r.err).trim().slice(-200)})`);
}

// ---------------------------------------------------------------- R20: a closed task refuses before anything is ended
fixture("r20");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  taskLib.closeTask({ taskDir: cur.tasks[1], repoKeyObj: cur.key, delete: false });
  const r = cli(["restart", c.sid, "--json"]);
  const e = errJson(r);
  check(r.status === 2 && errCode(r) === "task_gone" && r.err.includes("001-one") && r.err.includes("closed or no longer active")
    && e.remedy && e.remedy.includes("--coordinator"),
    `R20: a closed task refuses with task_gone naming the task and the remedy (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && !zmxArgvs().some((w) => w[0] === "history"),
    "R20: nothing was sent, killed or even read — the refusal fires before the end flow");
  check(readReg(c.dir).ended_at === undefined && fs.readFileSync(process.env.ZMX_LIST_FILE, "utf8").includes(`name=${c.name}`),
    "R20: the seat stays live — ended with no replacement is the one outcome this verb must never produce");
}

// ---------------------------------------------------------------- R21: an unlanded side branch refuses before anything is ended
fixture("r21");
{
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  git(cur.repoDir, "checkout", "-q", "-b", "wt/001-one");
  fs.writeFileSync(path.join(cur.repoDir, "side.txt"), "unmerged work\n");
  git(cur.repoDir, "add", "side.txt");
  git(cur.repoDir, "commit", "-q", "-m", "side work");
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cli(["restart", c.sid, "--json"]);
  const e = errJson(r);
  check(r.status === 2 && errCode(r) === "side_branch" && r.err.includes("not merged into origin/main")
    && r.err.includes("the seat was left live") && e.remedy && e.remedy.includes("then a restart again"),
    `R21: an unlanded side branch refuses with side_branch, the shared why and the seat-left-live note (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(git(cur.repoDir, "branch", "--show-current") === "wt/001-one",
    "R21: the repo still sits on the branch — the precheck is read-only, no checkout side effect");
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined
    && fs.readFileSync(process.env.ZMX_LIST_FILE, "utf8").includes(`name=${c.name}`),
    "R21: nothing was sent or killed, the seat stays live through the refusal");
}

// ---------------------------------------------------------------- R22: the worktree shape's fetch refuses pre-end; a working origin pre-warms
// R6's shape (a real start creating the task's worktree, then the coordinator
// planted there). FETCH_HEAD is truncated to empty after it — the state git
// itself leaves when a fetch fails — so the precheck's fetchBase cannot skip
// the window and must actually run against the origin.
fixture("r22a");
{
  const base = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(base.status === 0, `R22a: the fixture start created the task's worktree (${base.status}: ${base.err.trim().slice(0, 120)})`);
  const c = plant("coordinator", { task: cur.tasks[2], cwd: wtPath("002-two"), transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  fs.rmSync(path.join(cur.root, "origin.git"), { recursive: true });
  fs.writeFileSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), "");
  const r = cli(["restart", c.sid, "--json"]);
  const e = errJson(r);
  check(r.status === 2 && errCode(r) === "fetch_failed" && r.err.includes("could not fetch origin main")
    && r.err.includes("the seat was left live") && e.remedy && e.remedy.includes("fix the remote"),
    `R22a: a broken origin refuses the worktree-shaped restart with fetch_failed before the end (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(sendArgvs().length === 0 && killArgvs().length === 0 && readReg(c.dir).ended_at === undefined
    && fs.readFileSync(process.env.ZMX_LIST_FILE, "utf8").includes(`name=${c.name}`),
    "R22a: nothing was sent or ended — the seat stays live through the broken fetch");
}
fixture("r22b");
{
  const base = cliJson(["start", "002", "--worktree", "--no-attach"]);
  check(base.status === 0, `R22b: the fixture start created the task's worktree (${base.status}: ${base.err.trim().slice(0, 120)})`);
  const wt = wtPath("002-two");
  const c = plant("coordinator", { task: cur.tasks[2], cwd: wt, transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  fs.writeFileSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD"), "");
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300" } });
  const d = r.data;
  check(r.status === 0 && d && d.previous_session_id === c.sid && d.worktree === wt,
    `R22b: a working origin passes the fetch precheck and renews in the worktree (${r.status}: ${r.err.trim().slice(0, 160)})`);
  check(Boolean(readReg(c.dir).ended_at) && fs.statSync(path.join(cur.key.main_root, ".git", "FETCH_HEAD")).size > 0,
    "R22b: the old seat ended and the pre-end fetch wrote FETCH_HEAD back non-empty — the fresh start's fetch skips inside the window");
}

// ---------------------------------------------------------------- R23: the flush lands before the exit
fixture("r23");
{
  const c = plant("coordinator", { transcript: plantTranscript(flushLandedRows()) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], { env: { ZMX_SEND_ENDS: "1", AGENTS_RESTART_FLUSH_TIMEOUT_MS: "3000" } });
  const d = r.data;
  check(r.status === 0 && d !== null && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R23: a live coordinator whose flush lands renews with exit 0 (${r.status}: ${r.err.trim().slice(0, 200)})`);
  const sent = readLog(process.env.ZMX_SEND_LOG);
  check(sent.length === 4 && sent[0].includes("hand-off") && sent[1] === "\r" && sent[2] === "/exit" && sent[3] === "\r",
    `R23: the send log reads the flush, its Enter, /exit then its Enter — the flush precedes the exit (${JSON.stringify(sent)})`);
  check(r.err.includes("flushed its hand-off to the records"), `R23: stderr carries the landed line (${r.err.trim()})`);
  check(d && JSON.stringify(Object.keys(d)) === JSON.stringify([
    "session_id", "terminal_id", "session_dir", "task_dir", "cwd", "worktree", "mux", "attach", "swept", "held", "setup_mux", "previous_session_id",
  ]), `R23: the JSON contract is start's field list plus previous_session_id, unchanged (${d && Object.keys(d).join(",")})`);
}

// ---------------------------------------------------------------- R24: a deaf seat proceeds bounded — the never-blocks chain in one leg
fixture("r24");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], {
    env: { AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300", AGENTS_RESTART_EXIT_TIMEOUT_MS: "300", AGENTS_RESTART_KILL_GRACE_MS: "300" },
  });
  const d = r.data;
  check(r.status === 0 && d && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R24: a deaf seat still renews within the knobbed budgets (${r.status}: ${r.err.trim().slice(0, 200)})`);
  check(readLog(process.env.ZMX_SEND_LOG).some((l) => l.includes("hand-off")),
    "R24: the flush was attempted — its text is in the send log");
  check(r.err.includes("did not land within"), `R24: the unverified flush warns on stderr (${r.err.trim()})`);
  check(killArgvs().length === 1 && JSON.stringify(killArgvs()[0]) === JSON.stringify(["kill", c.name]),
    `R24: the plain kill ends it — the ladder needs no rung above (${JSON.stringify(killArgvs())})`);
  check(Boolean(readReg(c.dir).ended_at), "R24: the killed session's end is recorded");
}

// ---------------------------------------------------------------- R25: the pane that ignores /exit and the plain kill renews through the forced kill
fixture("r25");
{
  const c = plant("coordinator", { transcript: plantTranscript(IDLE_ROWS) });
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const r = cliJson(["restart", c.sid], {
    env: { AGENTS_RESTART_FLUSH_TIMEOUT_MS: "300", AGENTS_RESTART_EXIT_TIMEOUT_MS: "300", AGENTS_RESTART_KILL_GRACE_MS: "300", STUB_ZMX_KILL_PLAIN_EXIT: "1" },
  });
  const d = r.data;
  check(r.status === 0 && d && d.previous_session_id === c.sid && d.session_id !== c.sid,
    `R25: the wedged-pane shape renews on its own (${r.status}: ${r.err.trim().slice(0, 200)})`);
  check(JSON.stringify(killArgvs()) === JSON.stringify([["kill", c.name], ["kill", c.name, "--force"]]),
    `R25: the ladder escalates — the plain kill, then the forced one (${JSON.stringify(killArgvs())})`);
  check(Boolean(readReg(c.dir).ended_at), "R25: the forced kill's end is recorded");
  check(r.err.includes(`force-killed its zmx session ${c.name}`), `R25: stderr names the forced kill (${r.err.trim()})`);
}

for (const c of children) { try { process.kill(-c.pid); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
