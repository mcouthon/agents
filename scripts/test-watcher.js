#!/usr/bin/env node
"use strict";
// watcher: the away safety net — relays a watched task's pending over the
// owner's private relay command while the home's coordinator is down, deaf or
// stuck on its own permission prompt, once per (session_id, needs_input.at);
// replaces a deaf or ended coordinator through the real restart verb under a
// per-hour spawn cap; renews a down home on the next tick, owner present or
// away, with the seat's first move submitted and its tokens verified; the
// daily digest; the PAV health fact and the heartbeat.
// Driven in-process against isolated roots with a stub zmx (the pane tail from
// a file, sends logged), a stub relay (a real sh script appending stdin) and
// the launcher as the one injected seam — the real verb runs only in the
// end-to-end scenario. Isolation: nothing here may touch the real HOME,
// config, git config, zmx, launchd, sessions or database.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-watcher-")));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs", "stubbin", "procs"]) fs.mkdirSync(path.join(t, d));
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
    AGENT_WATCHER_PAV_EVERY_TICKS: "1", // AW2 probes every tick
    AGENT_WATCHER_KICK_SECS: "0", // AW13b: the tokens verify settles on its first round
    AGENTS_KICK_READY_MS: "1000", AGENTS_KICK_VERIFY_SECS: "1", // the real restarts' kick stays fixture-fast
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF",
    "AGENTS_TEST_SKIP_IDENTITY", "CLAUDE_CODE_SESSION_ID", "ZMX_SESSION", "RELAY_FAIL_FIRST",
    "STUB_ZMX_EXIT", "STUB_CLAUDE_EXIT", "STUB_ZMX_HISTORY_EXIT", "STUB_ZMX_SEND_EXIT",
    "STUB_ZMX_KILL_EXIT", "AGENTS_RESTART_EXIT_TIMEOUT_MS"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const derive = require("./lib/derive");
const watcherMod = require("./bin/watcher");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const T = process.env.AGENTS_TEST_TMP;
let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Stub zmx and claude (the restart suite's idiom): list answers from
// $ZMX_LIST_FILE, history serves $ZMX_HISTORY_FILE, send logs its stdin to
// $ZMX_SEND_LOG and ZMX_SEND_ENDS drops the pane's list line once Enter lands.
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
  '    if [ -n "${STUB_ZMX_HISTORY_EXIT:-}" ]; then exit "$STUB_ZMX_HISTORY_EXIT"; fi',
  '    [ -f "${ZMX_HISTORY_FILE:-}" ] && cat "$ZMX_HISTORY_FILE"',
  "    exit 0 ;;",
  "  send)",
  "    text=$(cat)",
  '    if [ -n "${STUB_ZMX_SEND_EXIT:-}" ]; then exit "$STUB_ZMX_SEND_EXIT"; fi',
  '    printf \'%s\\n\' "$text" >> "${ZMX_SEND_LOG:?ZMX_SEND_LOG not set}"',
  '    if [ "${ZMX_SEND_ENDS:-0}" = "1" ] && [ "$text" = "$(printf \'\\r\')" ]; then drop "$2"; fi',
  "    exit 0 ;;",
  "  run)",
  '    printf \'name=%s\\tpid=1\\tclients=0\\tcreated=1\\tcwd=/tmp\\n\' "$2" >> "${ZMX_LIST_FILE:?ZMX_LIST_FILE not set}"',
  "    exit 0 ;;",
  "  kill)",
  '    printf \'%s\\n\' "$*" >> "${ZMX_KILL_LOG:?ZMX_KILL_LOG not set}"',
  '    if [ -n "${STUB_ZMX_KILL_EXIT:-}" ]; then exit "$STUB_ZMX_KILL_EXIT"; fi',
  '    drop "$2"',
  "    exit 0 ;;",
  "esac",
  'exit "${STUB_ZMX_EXIT:-0}"',
  "",
].join("\n"), { mode: 0o755 });
fs.writeFileSync(path.join(stubBin, "claude"), [
  "#!/bin/sh",
  'echo "claude $*" >> "${CLAUDE_LOG:-/dev/null}"',
  'echo "cwd $PWD" >> "${CLAUDE_LOG:-/dev/null}"',
  'echo "AGENTS_SESSION_DIR=$AGENTS_SESSION_DIR" >> "${CLAUDE_LOG:-/dev/null}"',
  'echo "PATH=$PATH" >> "${CLAUDE_LOG:-/dev/null}"',
  'exit "${STUB_CLAUDE_EXIT:-0}"',
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;
process.env.ZMX_SEND_ENDS = "1"; // AW10's clean exit: Enter drops the pane's list line
process.env.AGENTS_RESTART_FLUSH_TIMEOUT_MS = "300"; // AW10's real restart: the flush's deaf-seat wait shrinks like every live-end leg's

// The stub relay: a real sh script appending the message (stdin) to a file,
// one `---` delimiter before each delivery, failing the first
// $RELAY_FAIL_FIRST calls — the delivered messages are assertable as content.
const relayStub = path.join(T, "relay-stub.sh");
fs.writeFileSync(relayStub, [
  "#!/bin/sh",
  'n=$(cat "${RELAY_STATE:-/dev/null}" 2>/dev/null || echo 0)',
  "n=$((n+1))",
  'echo "$n" > "${RELAY_STATE:?RELAY_STATE not set}"',
  'if [ "$n" -le "${RELAY_FAIL_FIRST:-0}" ]; then cat >/dev/null; exit 1; fi',
  'printf -- "---\\n" >> "${RELAY_OUT:?RELAY_OUT not set}"',
  'cat >> "${RELAY_OUT:?RELAY_OUT not set}"',
  "exit 0",
  "",
].join("\n"), { mode: 0o755 });

// Every spawned child is registered here so no exit path strands one.
const spawned = [];
function track(child) {
  const entry = { child, closed: false };
  child.on("close", () => { entry.closed = true; });
  spawned.push(entry);
  return entry;
}
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const e of spawned) { try { e.child.kill("SIGKILL"); } catch { /* already gone */ } }
  fs.rmSync(T, { recursive: true, force: true });
}
for (const [sig, num] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
  process.on(sig, () => { teardown(); process.exit(128 + num); });
}
process.on("exit", teardown);

// ---------------------------------------------------------------- fixtures

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const zl = (name) => `name=${name}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp`;
function setLive(names) { fs.writeFileSync(process.env.ZMX_LIST_FILE, names.map((n) => zl(n) + "\n").join("")); }
function setPane(text) { fs.writeFileSync(process.env.ZMX_HISTORY_FILE, text); }
const readReg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "registration.json"), "utf8"));
const relayMessages = () => fs.readFileSync(process.env.RELAY_OUT, "utf8").split("---\n").filter(Boolean);
const stateOf = (home) => JSON.parse(fs.readFileSync(path.join(home, "watcher.json"), "utf8"));
const killArgvs = () => {
  try { return fs.readFileSync(process.env.ZMX_KILL_LOG, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")); }
  catch { return []; }
};

let cur = null;
const launchCalls = [];
const seamLaunch = (args) => { launchCalls.push(args); return { code: 0, typed: null }; };

/** The launcher seam by default; the real verb only where a scenario says so. */
function tick(opts = {}) {
  watcherMod.tick({ launch: opts.launch || seamLaunch });
  derive.flushFacts(); // no dirty facts survive a sweep of the fixture root
}

function useRoots(label) {
  const root = mk(label);
  Object.assign(process.env, {
    AGENTS_TASKS_ROOT: path.join(root, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
    AGENTS_DB: path.join(root, "agents.db"),
    ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
    ZMX_HISTORY_FILE: path.join(root, "pane.vt"),
    ZMX_SEND_LOG: path.join(root, "send.log"),
    ZMX_KILL_LOG: path.join(root, "kill.log"),
    CLAUDE_LOG: path.join(root, "claude.log"),
    RELAY_OUT: path.join(root, "relay.out"),
    RELAY_STATE: path.join(root, "relay.count"),
  });
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
  fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
  fs.writeFileSync(process.env.RELAY_OUT, "");
  fs.writeFileSync(process.env.RELAY_STATE, "0");
  db.open({ create: true });
  setLive([]);
  launchCalls.length = 0;
  return root;
}

/** A repo with a local bare origin, two open tasks and a watched home — the restart suite's fixture shape. */
function fixtureWorld(label) {
  const root = useRoots(label);
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
  const home = mkTask("home", "Home");
  const alpha = mkTask("alpha", "Alpha");
  fs.writeFileSync(path.join(home, "watch-set.md"), ["## Watched", alpha, "", "## Unwatched", "", "## Log", ""].join("\n") + "\n");
  require("./lib/roster").build({ all: true });
  derive.flushFacts();
  cur = { root, repoDir, key, home, alpha };
  return cur;
}

function awayOn(homeDir) {
  fs.writeFileSync(path.join(homeDir, "away.md"), `state: on\nsince: ${new Date().toISOString()}\n`);
}

/** A registration in the current world; live by a zmx name unless `ended`. */
function plant(agent, { task = cur.alpha, transcript = null, ended = false } = {}) {
  const sid = session.mintId();
  const terminalId = session.mintId();
  const name = `${agent[0].toUpperCase()}${agent.slice(1)}-${sid.slice(0, 8)}`;
  const dir = path.join(process.env.AGENTS_SESSIONS_ROOT, terminalId);
  session.register({
    origin: "cli", initiator: "user", agent, cwd: cur.repoDir, repo_key: cur.key.key,
    session_dir: dir, terminal_id: terminalId, session_id: sid, task_dir: task,
    ...(transcript ? { transcript_path: transcript } : {}),
    ...(ended ? {} : { mux: { kind: "zmx", name } }),
  });
  if (ended) session.markEnded(dir);
  return { sid, id8: sid.slice(0, 8), name, dir };
}

/** A transcript jsonl with the given rows, planted as a file. */
function plantTranscript(rows) {
  const p = path.join(cur.root, `transcript-${session.mintId()}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// An idle tail ends with its turn-end marker newest (the restart suite's shape).
const idleRows = (t0Ms) => [
  { type: "user", timestamp: new Date(t0Ms - 20000).toISOString(), message: { content: "hold the seat" } },
  { type: "assistant", timestamp: new Date(t0Ms - 15000).toISOString(), message: { content: "holding" } },
  { type: "system", subtype: "turn_duration", timestamp: new Date(t0Ms - 10000).toISOString() },
];
const dayOldRows = () => idleRows(Date.now() - 26 * 3600000);

function pending(dir, message) {
  session.recordSignal(dir, { message, kind: "idle_prompt" });
  return session.readRegistration(dir).needs_input.at;
}

/** Hand-set a signal's at — the fixture owns the data the tick reads. */
function setSignalAt(dir, ms) {
  const reg = session.readRegistration(dir);
  reg.needs_input.at = new Date(ms).toISOString();
  session.writeRegistration(dir, reg);
}

function writeCfg(extra = {}) {
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({
    worktrees_root: path.join(cur.root, "worktrees"),
    ...extra,
  }));
}

function cfgRelay() {
  writeCfg({ watcher: { relay: relayStub } });
}

function plantState(homeDir, over = {}) {
  fs.writeFileSync(path.join(homeDir, "watcher.json"), JSON.stringify({
    heartbeat: new Date().toISOString(), ticks: 3, pav: "unconfigured", relaid: {},
    digestAt: null, digestOf: [], capped: false, lastLaunch: null, relayFails: 0, deaf: null,
    ...over,
  }));
}

// The AW14 fixtures: synthetic models at invented rates (a few thousand
// tokens price to cents), transcripts planted under the fixture home's
// projects root — the tree the tick's spend refresh walks. The root is wiped
// per world so each AW14 world sees only its own files.
const SPEND_CFG = {
  cap_usd: 10, warn_pct: 80,
  prices_per_mtok: { "model-a": { input: 1, cache_read: 0.1, cache_write_5m: 1.5, cache_write_1h: 2, output: 5 } },
};
const spendLedgerPath = () => path.join(path.dirname(process.env.AGENTS_DB), "spend-ledger.json");
const utcMonthStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const monthKeyOf = (ms) => new Date(ms).toISOString().slice(0, 7);
/** A timestamp inside the current UTC month at any run date (never before its start). */
const inMonthMs = () => Math.max(utcMonthStart(Date.now()) + 60000, Date.now() - 60000);

/** One assistant record row with the usage shape transcripts carry. */
const usageRow = (tsMs, model, id, u) => ({
  type: "assistant", timestamp: new Date(tsMs).toISOString(),
  message: { id, model, usage: {
    input_tokens: u.in || 0,
    cache_read_input_tokens: u.cr || 0,
    cache_creation_input_tokens: (u.c5 || 0) + (u.c1 || 0),
    cache_creation: { ephemeral_5m_input_tokens: u.c5 || 0, ephemeral_1h_input_tokens: u.c1 || 0 },
    output_tokens: u.out || 0,
  } },
});

function resetProjects() {
  fs.rmSync(path.join(process.env.HOME, ".claude", "projects"), { recursive: true, force: true });
}

function plantProjectTranscript(relDir, rows) {
  const fileDir = path.join(process.env.HOME, ".claude", "projects", relDir);
  fs.mkdirSync(fileDir, { recursive: true });
  const p = path.join(fileDir, `${session.mintId()}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

/** The month's per-model token totals from a ledger. */
function sumLedger(ledger) {
  const summed = {};
  for (const memo of Object.values(ledger.files || {})) {
    for (const [model, t] of Object.entries(memo.models || {})) {
      const m = summed[model] || (summed[model] = { in: 0, cr: 0, c5: 0, c1: 0, out: 0 });
      m.in += t.in || 0; m.cr += t.cr || 0; m.c5 += t.c5 || 0; m.c1 += t.c1 || 0; m.out += t.out || 0;
    }
  }
  return summed;
}

// vt fixtures (the restart suite's shapes): the grey suggestion renders inside
// SGR 2 (dim) after a bare glyph; a permission prompt shows its marker and
// indented option lines instead of an input box.
const VT_SUGGEST_LINE = "❯\xa0\x1b[0m\x1b[2mTry \"how do I log an error?\"\x1b[0m";
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
// promptBlockOf anchors on the bottom-most marker line in the tail, so a
// both-marker pane yields the bottom marker's block; the stall fixture serves
// the single-marker prompt shape AW6 pins.
const STALL_PROMPT_VT = [
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No, and tell it what to change",
  "",
].join("\n");

// ---------------------------------------------------------------- scenarios

// AW1: discovery and the always-on jobs — a coordinator home gets its
// heartbeat while away is off (no relay even for a pending — the relay leg
// stays away-gated), the down home still renews through the down leg (the
// present-mode renewal), and a world with no coordinator session ever serves
// no home at all.
async function AW1() {
  const w = fixtureWorld("aw1");
  const coord = plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  pending(watched.dir, "a pending while the owner is not away");
  cfgRelay();
  tick(); // no away.md: away off — the relay leg stays gated, the down leg fires
  const st = stateOf(w.home);
  check(Boolean(st.heartbeat) && Date.now() - Date.parse(st.heartbeat) < 60000,
    "AW1: one tick writes a fresh heartbeat into the home's watcher.json");
  check(st.ticks === 1 && st.pav === "unconfigured",
    `AW1: the first tick counts one beat and an unconfigured PAV fact (${JSON.stringify([st.ticks, st.pav])})`);
  check(relayMessages().length === 0,
    "AW1: away off relays nothing — the relay leg stays away-gated");
  check(launchCalls.length === 1
    && JSON.stringify(launchCalls[0]) === JSON.stringify(["restart", coord.sid, "--json", "--no-attach"]),
    `AW1: the down home renews with the owner present — one launch through the restart verb (${JSON.stringify(launchCalls)})`);

  const w2 = fixtureWorld("aw1b");
  plant("conductor", { task: w2.alpha });
  setLive([]);
  awayOn(w2.home); // even away on: no coordinator registration, no home
  tick();
  check(!fs.existsSync(path.join(w2.home, "watcher.json")),
    "AW1: a world with no coordinator session serves no home — no state file");
}

// AW2: the PAV health fact — a local listener answers, a down one reads down,
// and no configured port reads unconfigured.
async function AW2() {
  const w = fixtureWorld("aw2");
  plant("coordinator", { task: w.home, ended: true });
  const listener = spawn(process.execPath, ["-e",
    "const s = require('http').createServer((q, r) => { r.end('ok'); });"
      + " s.listen(0, 'localhost', () => console.log(s.address().port));"],
    { stdio: ["ignore", "pipe", "pipe"] });
  track(listener);
  const port = await new Promise((resolve) => {
    let out = "";
    const timer = setTimeout(() => resolve(null), 10000);
    listener.stdout.on("data", (d) => {
      out += d;
      const m = /^(\d+)\s*$/m.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  check(Number.isFinite(port), "AW2: the local listener stands up");
  if (!Number.isFinite(port)) return;
  try {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ pav: { port } }));
    tick();
    let st = stateOf(w.home);
    check(st.pav && st.pav.ok === true && st.pav.code === "200",
      `AW2: an answering listener records ok with its code (${JSON.stringify(st.pav)})`);
    listener.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    tick();
    st = stateOf(w.home);
    check(st.pav && st.pav.ok === false && st.pav.code === "000",
      `AW2: a down listener reads down with code 000 (${JSON.stringify(st.pav)})`);
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({}));
    tick();
    st = stateOf(w.home);
    check(st.pav === "unconfigured", `AW2: an unset port reads unconfigured (${JSON.stringify(st.pav)})`);
  } finally {
    try { listener.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// AW3: the raw relay while down — the engine's message verbatim, once per
// (session_id, needs_input.at); a new pending on the same session relays again.
async function AW3() {
  const w = fixtureWorld("aw3");
  plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  const MSG = "the engine's own pending text, verbatim";
  const at = pending(watched.dir, MSG);
  awayOn(w.home);
  cfgRelay();
  tick();
  const msgs = relayMessages();
  check(msgs.length === 1 && msgs[0].includes(MSG),
    `AW3: the down coordinator's pending relays with the engine's message verbatim (${msgs.length} messages)`);
  const firstLine = (msgs[0] || "").split("\n")[0];
  check(/^\[\S+#\d+( · phase \d+)?\]$/.test(firstLine) && firstLine.includes(path.basename(path.dirname(w.alpha))),
    `AW3: the message opens with the stable label naming the repo (${JSON.stringify(firstLine)})`);
  const atMs = Date.parse(at);
  check((msgs[0] || "").includes(`session ${watched.id8} waiting since ${new Date(atMs).toISOString().slice(11, 16)}Z`),
    `AW3: the waiting line names the session and the since time (${JSON.stringify((msgs[0] || "").split("\n")[1])})`);
  check(stateOf(w.home).relaid[`${watched.sid}@${at}`] !== undefined,
    "AW3: the dedup key (session_id@needs_input.at) is recorded");
  // the digest stays out of this scenario's subject: the away leg's launch
  // reads no-turn against the stub, and that fact would surface on the very
  // next due digest (AW13b pins the line itself)
  const st1 = stateOf(w.home);
  st1.digestAt = new Date().toISOString();
  fs.writeFileSync(path.join(w.home, "watcher.json"), JSON.stringify(st1) + "\n");
  tick();
  check(relayMessages().length === 1, "AW3: a second tick adds nothing — the dedup holds");
  setSignalAt(watched.dir, atMs + 5000);
  tick();
  const again = relayMessages();
  check(again.length === 2, `AW3: a new needs_input.at on the same session relays again (${again.length} messages)`);
  check(stateOf(w.home).relaid[`${watched.sid}@${new Date(atMs + 5000).toISOString()}`] !== undefined,
    "AW3: the new key is recorded beside the pruned old one");
}

// AW4: a hearing coordinator silences the watcher — its transcript reacted
// after the watched event, so no relay and no launch.
async function AW4() {
  const w = fixtureWorld("aw4");
  const t0 = Date.now();
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(idleRows(t0)) });
  const watched = plant("conductor", { task: w.alpha });
  setLive([coord.name, watched.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  const at = pending(watched.dir, "a pending the coordinator can hear");
  setSignalAt(watched.dir, t0 - 60000); // a minute before the coordinator's last marker
  awayOn(w.home);
  cfgRelay();
  tick();
  check(relayMessages().length === 0, `AW4: a hearing coordinator relays nothing (${relayMessages().length})`);
  check(launchCalls.length === 0, "AW4: no launch while the coordinator hears");
}

// AW5: the deaf path — the coordinator's transcript is old against the
// watched pending; the missed pending relays, deaf records, and the launch
// seam carries the restart verb and the session id.
async function AW5() {
  const w = fixtureWorld("aw5");
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(dayOldRows()) });
  const watched = plant("conductor", { task: w.alpha });
  setLive([coord.name, watched.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  pending(watched.dir, "the missed pending");
  awayOn(w.home);
  cfgRelay();
  tick();
  check(relayMessages().some((m) => m.includes("the missed pending")),
    "AW5: the missed pending relays through the deaf path");
  const st = stateOf(w.home);
  check(st.deaf && st.deaf.sid === coord.sid,
    `AW5: deaf records with the coordinator's session id (${JSON.stringify(st.deaf)})`);
  check(launchCalls.length === 1 && launchCalls[0][0] === "restart" && launchCalls[0][1] === coord.sid
    && launchCalls[0].includes("--json") && launchCalls[0].includes("--no-attach"),
    `AW5: the launcher seam carries the restart verb, the session id and the flags (${JSON.stringify(launchCalls)})`);
}

// AW6: the prompt-stuck stall — the pane's prompt block rides verbatim, and no
// launch is attempted (the watcher does not try what the verb would refuse).
async function AW6() {
  const w = fixtureWorld("aw6");
  const t0 = Date.now();
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(idleRows(t0)) });
  const watched = plant("conductor", { task: w.alpha });
  setLive([coord.name, watched.name]);
  setPane(STALL_PROMPT_VT);
  pending(watched.dir, "a pending behind the prompt");
  awayOn(w.home);
  cfgRelay();
  tick();
  const stall = relayMessages().find((m) => m.includes("stuck on a permission prompt"));
  check(Boolean(stall) && stall.includes(`pane ${coord.name}`) && stall.includes("since "),
    `AW6: the stall relay names the pane and a since time (${Boolean(stall)})`);
  check(Boolean(stall) && stall.includes("Do you want to proceed?") && stall.includes("1. Yes"),
    "AW6: the prompt block rides verbatim");
  check(launchCalls.length === 0,
    `AW6: no launch for the prompt-stuck shape (${JSON.stringify(launchCalls)})`);
}

// AW7: the spawn cap — two coordinator registrations inside the hour hold the
// launch, the cap records, and the digest names it.
async function AW7() {
  const w = fixtureWorld("aw7");
  plant("coordinator", { task: w.home, ended: true });
  plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  pending(watched.dir, "a capped hour's pending");
  awayOn(w.home);
  cfgRelay();
  // a previous tick's state: the digest due, a cap already surfaced
  plantState(w.home, { digestAt: new Date(Date.now() - 2 * 24 * 3600000).toISOString(), capped: true });
  tick();
  const st = stateOf(w.home);
  check(launchCalls.length === 0 && st.capped === true,
    `AW7: two registrations in the hour hold the launch — capped (${JSON.stringify([launchCalls.length, st.capped])})`);
  const digest = relayMessages().find((m) => m.includes("daily digest"));
  check(Boolean(digest) && digest.includes("spawn cap"),
    `AW7: the digest names the cap (${Boolean(digest)})`);
}

// AW8: the daily digest — one message once past the cadence naming the old
// pending with its age; the next tick does not re-digest.
async function AW8() {
  const w = fixtureWorld("aw8");
  plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  const at = pending(watched.dir, "an old pending");
  setSignalAt(watched.dir, Date.parse(at) - 13 * 3600000);
  awayOn(w.home);
  cfgRelay();
  plantState(w.home, { digestAt: new Date(Date.now() - 2 * 24 * 3600000).toISOString() });
  tick();
  const digests = relayMessages().filter((m) => m.includes("daily digest"));
  check(digests.length === 1 && digests[0].includes("daily digest: 1 pendings older than 12h"),
    `AW8: the digest fires once past the cadence with the header (${digests.length})`);
  check(digests[0].includes(`session ${watched.id8} open 13h`),
    "AW8: the pending's line carries its session and age");
  tick();
  check(relayMessages().filter((m) => m.includes("daily digest")).length === 1,
    "AW8: the next tick does not re-digest");
}

// AW9: the relay failure — a failed attempt consumes no key and counts; the
// next tick retries and delivers.
async function AW9() {
  const w = fixtureWorld("aw9");
  plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  const at = pending(watched.dir, "a pending the first attempt drops");
  awayOn(w.home);
  cfgRelay();
  plantState(w.home, { digestAt: new Date().toISOString() }); // not due: the failure surfaces later, not here
  process.env.RELAY_FAIL_FIRST = "1";
  tick();
  let st = stateOf(w.home);
  check(st.relayFails === 1 && st.relaid[`${watched.sid}@${at}`] === undefined,
    `AW9: the failed attempt counts and consumes no key (${JSON.stringify([st.relayFails, st.relaid])})`);
  delete process.env.RELAY_FAIL_FIRST;
  tick();
  st = stateOf(w.home);
  check(relayMessages().some((m) => m.includes("a pending the first attempt drops")),
    "AW9: the next tick retries and delivers");
  check(st.relaid[`${watched.sid}@${at}`] !== undefined,
    "AW9: the delivered retry consumes the key");
}

// AW10: the real launch lock — the real restart replaces a deaf coordinator
// end to end (the clean tail resumes the same conversation: the row reopened,
// the seat kicked), and a second real run against an occupied seat is refused
// by the verb, recorded, nothing ended.
async function AW10() {
  const w = fixtureWorld("aw10");
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(dayOldRows()) });
  const watched = plant("conductor", { task: w.alpha });
  setLive([coord.name, watched.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  pending(watched.dir, "the pending that wakes the replacement");
  awayOn(w.home);
  cfgRelay();
  let realCalls = 0;
  const countingReal = (args) => { realCalls++; return watcherMod.realLaunch(args); };
  // a loaded battery can push the verb's own zmx probe past its budget — the
  // typed storm refusal is a legitimate outcome, ridden out like the restart
  // suite does; a real break fails every leg identically.
  let st = null;
  for (let leg = 0; leg < 3; leg++) {
    tick({ launch: countingReal });
    st = stateOf(w.home);
    if (!(st.lastLaunch && st.lastLaunch.typed === "zmx_timeout")) break;
    execFileSync("/bin/sleep", ["2"]);
  }
  check(st && st.lastLaunch && st.lastLaunch.verb === "restart" && st.lastLaunch.code === 0,
    `AW10: the real restart of the deaf coordinator records a clean exit (${JSON.stringify(st && st.lastLaunch)})`);
  check(realCalls === 1, `AW10: one launch attempt per tick (${realCalls})`);
  const reg = session.readRegistration(coord.dir);
  check(Boolean(reg) && reg.session_id === coord.sid && reg.ended_at === undefined
    && reg.agent === "coordinator" && reg.task_dir === w.home && reg.mux && reg.mux.name === coord.name,
    `AW10: the renewal resumed the deaf coordinator's conversation — the same id re-registered, the row reopened (${JSON.stringify(reg && [reg.session_id === coord.sid, reg.ended_at === undefined, reg.mux])})`);
  const sent = fs.existsSync(process.env.ZMX_SEND_LOG)
    ? fs.readFileSync(process.env.ZMX_SEND_LOG, "utf8").split("\n").filter(Boolean) : [];
  check(sent.some((l) => l.includes("hand-off")) && sent.some((l) => l === "/exit")
    && sent.some((l) => l.includes("Take up your post")),
    `AW10: the end flow ran (flush, /exit) and the fresh seat was kicked, all through the shared send path (${sent.length} sends)`);
  check(relayMessages().some((m) => m.includes("the pending that wakes the replacement")),
    "AW10: the missed pending relayed while the coordinator was deaf");

  const w2 = fixtureWorld("aw10b");
  const coord2 = plant("coordinator", { task: w2.home, transcript: plantTranscript(dayOldRows()) });
  const courier = plant("courier", { task: w2.home }); // another live session holds the home task
  const watched2 = plant("conductor", { task: w2.alpha });
  setLive([coord2.name, courier.name, watched2.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  pending(watched2.dir, "the pending behind the occupied seat");
  awayOn(w2.home);
  cfgRelay();
  let refusedCalls = 0;
  tick({ launch: (args) => { refusedCalls++; return watcherMod.realLaunch(args); } });
  const st2 = stateOf(w2.home);
  check(st2.lastLaunch && st2.lastLaunch.code === 2 && st2.lastLaunch.typed === "task_occupied",
    `AW10: the occupied seat's refusal is recorded with its typed code (${JSON.stringify(st2.lastLaunch)})`);
  check(refusedCalls === 1, `AW10: the refusal is not retried within the tick (${refusedCalls})`);
  check(session.readRegistration(coord2.dir).ended_at === undefined,
    "AW10: nothing was ended — the refusal fired before any end work");
}

// AW11: the launchd surface as data — the plist renders the exact XML, the
// install skips an isolated root, writes under a temp home by path, and never
// touches the live launchd.
async function AW11() {
  const text = watcherMod.watcherPlistText("com.mcouthon.agents.watcher", "/usr/local/bin/node", "/Users/t/.local/bin/watcher", "/Users/t/.agents/logs");
  check(text === `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mcouthon.agents.watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string><string>/Users/t/.local/bin/watcher</string>
  </array>
  <key>StartInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>/Users/t/.agents/logs/watcher.log</string>
  <key>StandardErrorPath</key><string>/Users/t/.agents/logs/watcher.log</string>
</dict>
</plist>`, "AW11: watcherPlistText renders the exact plist — label, 15s interval, shim args, log paths");

  const isolated = watcherMod.installWatcherPlist({ home: mk("aw11-skip") });
  check(isolated.skipped === true, "AW11: an isolated root (AGENTS_TASKS_ROOT) skips the install");

  const saved = process.env.AGENTS_TASKS_ROOT;
  delete process.env.AGENTS_TASKS_ROOT;
  try {
    const tempHome = mk("aw11-home");
    const r = watcherMod.installWatcherPlist({ home: tempHome });
    const plistPath = path.join(tempHome, "Library", "LaunchAgents", "com.mcouthon.agents.watcher.plist");
    check(r.skipped === false && fs.existsSync(plistPath),
      `AW11: the install writes the plist under the temp home's LaunchAgents (${r.skipped})`);
    check(fs.readFileSync(plistPath, "utf8")
      === watcherMod.watcherPlistText(watcherMod.WATCHER_PLIST_LABEL, process.execPath, path.join(tempHome, ".local", "bin", "watcher"), path.join(tempHome, ".agents", "logs")),
      "AW11: the written plist is the data text with the temp home's shim and log paths");
    check(r.loaded === false && r.loadError === null,
      `AW11: a temp home never touches the live launchd (${JSON.stringify([r.loaded, r.loadError])})`);
    // an install whose $HOME is overridden reads as isolated too: the home
    // equals $HOME yet is not the passwd home — no load (the suite's own HOME
    // is exactly this shape)
    const r2 = watcherMod.installWatcherPlist({ home: process.env.HOME });
    check(r2.skipped === false && r2.loaded === false && r2.loadError === null,
      `AW11: an overridden $HOME equal to the target home still never loads (${JSON.stringify([r2.skipped, r2.loaded, r2.loadError])})`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = saved;
  }
}

// AW12: per-home failure containment — the tick runs as its own launchd
// process over every served home, so one home's throw (a dir gone mid-
// lifecycle, closed and trashed while the session rows still point at it)
// would kill the process before every later home's heartbeat and relaunch
// into the same throw each interval. The tick contains the failure per home:
// a logged skip line naming the home, the beat kept for the homes after it,
// exit 0. Run as the real binary — the containment is about the process.
async function AW12() {
  const w = fixtureWorld("aw12");
  plant("coordinator", { task: w.home, ended: true }); // registers first: the gone home leads the iteration
  const survivor = taskLib.createTask({ repo: w.key, title: "Survivor", slug: "survivor",
    mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  plant("coordinator", { task: survivor, ended: true });
  fs.rmSync(w.home, { recursive: true, force: true }); // the lifecycle: closed and trashed, rows still pointing
  const r = spawnSync(process.execPath, [path.join(__dirname, "bin", "watcher")],
    { encoding: "utf8", timeout: 120000 });
  derive.flushFacts();
  const skip = r.stderr.split("\n").find((l) => l.includes("skipped"));
  const beat = fs.existsSync(path.join(survivor, "watcher.json")) ? stateOf(survivor).heartbeat : null;
  check(r.status === 0 && Boolean(skip && skip.includes(w.home)) && Boolean(beat),
    `AW12: a gone home is skipped with a logged line while the homes after it keep their beats, exit 0 (${JSON.stringify([r.status, skip, beat])})`);
}

// AW13a: the down-renewal's trigger and bound — a dead home (no live
// coordinator row) renews on the very next tick with the owner present; the
// retry bound holds an immediate second tick, and an aged lastLaunch re-arms
// the leg.
async function AW13a() {
  const w = fixtureWorld("aw13a");
  const coord = plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  pending(watched.dir, "a pending while the owner is present");
  tick();
  check(launchCalls.length === 1
    && JSON.stringify(launchCalls[0]) === JSON.stringify(["restart", coord.sid, "--json", "--no-attach"]),
    `AW13a: a present-mode down home renews through the restart verb on the next tick (${JSON.stringify(launchCalls)})`);
  const st = stateOf(w.home);
  check(st.lastLaunch && st.lastLaunch.verb === "restart" && st.lastLaunch.code === 0 && Boolean(st.lastLaunch.at),
    `AW13a: the lastLaunch record carries the verb, the code and the time (${JSON.stringify(st.lastLaunch)})`);
  tick();
  check(launchCalls.length === 1,
    `AW13a: an immediate second tick launches nothing — the retry bound holds (${launchCalls.length})`);
  plantState(w.home, { lastLaunch: { verb: "restart", code: 0, typed: null, at: new Date(Date.now() - 16 * 60000).toISOString() } });
  tick();
  check(launchCalls.length === 2,
    `AW13a: once the lastLaunch ages past the bound the down leg launches again (${launchCalls.length})`);
}

// AW13b: the tokens verify's outcomes — an assistant row at/after the launch
// reads "working", nothing within the (knobbed) budget reads "no-turn", a
// refused launch has no seat to verify (kick null), and the digest names a
// renewal whose seat never started working. The at/after row is future-dated
// on purpose — the engine compares milliseconds and cannot tell the date is
// ahead; a fixture trick, not a behavior claim about real transcripts.
async function AW13b() {
  const w = fixtureWorld("aw13b");
  plant("coordinator", { task: w.home, ended: true, transcript: plantTranscript([
    { type: "user", timestamp: new Date(Date.now() - 60000).toISOString(), message: { content: "old turn" } },
    { type: "assistant", timestamp: new Date(Date.now() + 60000).toISOString(), message: { content: "tokens flowing" } },
  ]) });
  setLive([]);
  tick();
  const st = stateOf(w.home);
  check(st.lastLaunch && st.lastLaunch.kick === "working",
    `AW13b: an assistant row at/after the launch reads kick working (${JSON.stringify(st.lastLaunch)})`);

  const w2 = fixtureWorld("aw13b2");
  plant("coordinator", { task: w2.home, ended: true, transcript: plantTranscript([
    { type: "user", timestamp: new Date(Date.now() - 60000).toISOString(), message: { content: "old turn" } },
    { type: "assistant", timestamp: new Date(Date.now() - 50000).toISOString(), message: { content: "old answer" } },
  ]) });
  setLive([]);
  tick();
  const st2 = stateOf(w2.home);
  check(st2.lastLaunch && st2.lastLaunch.kick === "no-turn",
    `AW13b: no assistant row after the launch reads kick no-turn (${JSON.stringify(st2.lastLaunch)})`);

  const w3 = fixtureWorld("aw13b3");
  plant("coordinator", { task: w3.home, ended: true });
  setLive([]);
  let refusedCalls = 0;
  tick({ launch: (args) => { refusedCalls++; return { code: 2, typed: "task_occupied" }; } });
  const st3 = stateOf(w3.home);
  check(st3.lastLaunch && st3.lastLaunch.code === 2 && st3.lastLaunch.typed === "task_occupied"
    && st3.lastLaunch.kick === null && refusedCalls === 1,
    `AW13b: a refused launch records its typed code with kick null, not retried in the tick (${JSON.stringify(st3.lastLaunch)})`);

  const w4 = fixtureWorld("aw13b4");
  plant("coordinator", { task: w4.home, ended: true });
  setLive([]);
  awayOn(w4.home);
  cfgRelay();
  plantState(w4.home, {
    digestAt: new Date(Date.now() - 2 * 24 * 3600000).toISOString(),
    lastLaunch: { verb: "restart", code: 0, typed: null, kick: "no-turn", at: new Date().toISOString() },
  });
  tick();
  const digest = relayMessages().find((m) => m.includes("daily digest"));
  check(Boolean(digest) && digest.includes("never started working"),
    `AW13b: the digest names a renewal whose new seat never started working (${Boolean(digest)})`);
}

// AW13c: the cold target — a home whose registrations were swept between the
// tick's discovery and the launch decision renews through a cold start. The
// sweep rides the first home's launch seam (the one mid-tick moment a fixture
// owns); the swept home's state remembers a beat, so it cold-starts instead of
// staying invisible.
async function AW13c() {
  const w = fixtureWorld("aw13c");
  plant("coordinator", { task: w.home, ended: true });
  plant("coordinator", { task: w.alpha, ended: true }); // a second home the tick also serves
  setLive([]);
  plantState(w.alpha, { heartbeat: new Date().toISOString() });
  const sweep = (args) => {
    launchCalls.push(args);
    if (args[0] === "restart") db.open().run("DELETE FROM sessions WHERE task_dir = ?", w.alpha);
    return { code: 0, typed: null };
  };
  tick({ launch: sweep });
  check(launchCalls.length === 2
    && JSON.stringify(launchCalls[1]) === JSON.stringify(["start", w.alpha, "--coordinator", "--json", "--no-attach"]),
    `AW13c: a swept home the state remembers renews through a cold start (${JSON.stringify(launchCalls)})`);
}

// AW13d: the task-status gate — a closed home is silent: no attempts, no
// refusal records (the pause stays the owner's hand: unload the watcher job,
// or close the home task).
async function AW13d() {
  const w = fixtureWorld("aw13d");
  plant("coordinator", { task: w.home, ended: true });
  setLive([]);
  const sentinel = { verb: "restart", code: 0, typed: null, at: new Date().toISOString() };
  plantState(w.home, { lastLaunch: sentinel });
  // the close archives the folder — the watcher state moves with it, and the
  // tick's discovery still names the old path (the registration's task_dir)
  const closed = taskLib.closeTask({ taskDir: w.home, repoKeyObj: cur.key, delete: false });
  tick();
  const st = JSON.parse(fs.readFileSync(path.join(closed.archivePath, "watcher.json"), "utf8"));
  check(launchCalls.length === 0 && JSON.stringify(st.lastLaunch) === JSON.stringify(sentinel),
    `AW13d: a closed home launches nothing and leaves its lastLaunch untouched (${JSON.stringify([launchCalls.length, st.lastLaunch])})`);
}

// AW13e: the spawn cap holds the down leg — two registrations inside the hour
// record `capped` and launch nothing (AW7's shape through the new leg).
async function AW13e() {
  const w = fixtureWorld("aw13e");
  plant("coordinator", { task: w.home, ended: true });
  plant("coordinator", { task: w.home, ended: true });
  setLive([]);
  tick();
  const st = stateOf(w.home);
  check(launchCalls.length === 0 && st.capped === true,
    `AW13e: the cap holds the down leg — capped, no launch (${JSON.stringify([launchCalls.length, st.capped])})`);
}

// AW13f: no double fire — away on with a relay-worthy pending launches once
// through the away leg; the down block never adds a second.
async function AW13f() {
  const w = fixtureWorld("aw13f");
  const coord = plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  pending(watched.dir, "a pending that wakes the away leg");
  awayOn(w.home);
  cfgRelay();
  tick();
  check(launchCalls.length === 1 && launchCalls[0][0] === "restart" && launchCalls[0][1] === coord.sid,
    `AW13f: away + down + a fired pending launches exactly once — the away leg's (${JSON.stringify(launchCalls)})`);
}

// AW13g: the end-to-end renewal (acceptance scenario 1's engine half) — a live
// coordinator killed under the test (its pane's list line dropped, the
// registration left unended: the open-but-dead shape) renews through a REAL
// tick: the restart refuses nothing (the prechecks pass, the end flow skips —
// nothing live), the conversation resumes (--resume in the spawn argv, the
// same id re-registered), and the watcher records the outcome. The stub
// claude writes no transcripts, so the kick reads "no-turn" — the zombie
// detection is the point here (the working detection is AW13b's; the live-seat
// proof is the owner's post-install acceptance). The dead-seat renewal kills
// nothing, pinned.
async function AW13g() {
  const w = fixtureWorld("aw13g");
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(idleRows(Date.now())) });
  setLive([coord.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  setLive([]); // the kill: the pane's line drops, the registration stays open — a seat that died without recording its end
  let realCalls = 0;
  tick({ launch: (args) => { realCalls++; return watcherMod.realLaunch(args); } });
  const st = stateOf(w.home);
  const reg = session.readRegistration(coord.dir);
  const scriptPath = path.join(coord.dir, "launch.sh");
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
  check(st.lastLaunch && st.lastLaunch.code === 0 && st.lastLaunch.kick === "no-turn",
    `AW13g: the killed seat renews end-to-end — exit 0, the seat's tokens never flowed (kick no-turn) (${JSON.stringify(st.lastLaunch)})`);
  check(Boolean(reg) && reg.ended_at === undefined && reg.mux && reg.mux.name === coord.name
    && script.includes(`'--resume' '${coord.sid}'`),
    `AW13g: the renewal resumed the old conversation — the same id re-registered, --resume in the spawn argv (${JSON.stringify([reg && reg.ended_at === undefined, reg && reg.mux, script.slice(0, 40)])})`);
  check(killArgvs().length === 0 && realCalls === 1,
    `AW13g: the dead-seat renewal kills nothing — no kill argvs through the whole chain (${JSON.stringify(killArgvs())})`);
}

// AW14a: the month's spend ledger — one tick refreshes it machine-wide (no
// coordinator home needed: the refresh rides the tick, not a home) from every
// transcript under the home's projects root: assistant records deduped by
// message id (last occurrence wins), bucketed by each record's own timestamp,
// so a duplicate counts once and a prior-month row not at all.
async function AW14a() {
  fixtureWorld("aw14a");
  writeCfg({ spend: SPEND_CFG });
  resetProjects();
  const ts = inMonthMs();
  const priorTs = utcMonthStart(Date.now()) - 5 * 86400000;
  plantProjectTranscript("alpha-111", [
    usageRow(ts, "model-a", "dup-1", { in: 100, out: 50 }),
    usageRow(ts + 1000, "model-a", "dup-1", { in: 300, out: 60 }), // the duplicate: last occurrence wins
    usageRow(priorTs, "model-a", "old-1", { in: 999, out: 999 }), // prior month: not counted
  ]);
  plantProjectTranscript("beta-222", [
    usageRow(ts, "model-a", "b-1", { in: 10, cr: 7, c5: 4, c1: 5, out: 5 }),
    usageRow(ts, "model-x", "b-2", { in: 20, out: 10 }), // priced by nothing, still summed
  ]);
  plantProjectTranscript("beta-222/sub", [
    usageRow(ts, "model-a", "c-1", { in: 1000, out: 500 }), // a subagent transcript, nested under the project
  ]);
  tick();
  const ledger = fs.existsSync(spendLedgerPath())
    ? JSON.parse(fs.readFileSync(spendLedgerPath(), "utf8")) : null;
  check(Boolean(ledger), "AW14a: one tick writes the spend ledger beside the database");
  check(Boolean(ledger) && ledger.month === monthKeyOf(Date.now()),
    `AW14a: the ledger is keyed to the current month (${JSON.stringify(ledger && ledger.month)})`);
  const summed = sumLedger(ledger || {});
  check(JSON.stringify(summed) === JSON.stringify({
    "model-a": { in: 1310, cr: 7, c5: 4, c1: 5, out: 565 },
    "model-x": { in: 20, cr: 0, c5: 0, c1: 0, out: 10 },
  }), `AW14a: the month's per-model sums are post-dedup and current-month only (${JSON.stringify(summed)})`);
}

// AW14b: the refresh is incremental, behaviorally — an appended record is
// counted exactly once (the totals equal the whole-file recompute, never an
// accumulation onto the memo), and an untouched file's totals hold across the
// ticks.
async function AW14b() {
  fixtureWorld("aw14b");
  writeCfg({ spend: SPEND_CFG });
  resetProjects();
  const ts = inMonthMs();
  const fileA = plantProjectTranscript("alpha-111", [
    usageRow(ts, "model-a", "a-1", { in: 400, out: 200 }),
  ]);
  plantProjectTranscript("beta-222", [
    usageRow(ts, "model-x", "b-1", { in: 2000, out: 1000 }),
  ]);
  tick();
  const readLedger = () => (fs.existsSync(spendLedgerPath())
    ? JSON.parse(fs.readFileSync(spendLedgerPath(), "utf8")) : { files: {} });
  const after1 = sumLedger(readLedger());
  fs.appendFileSync(fileA, JSON.stringify(usageRow(ts + 2000, "model-a", "a-2", { in: 500, out: 250 })) + "\n");
  tick();
  const after2 = sumLedger(readLedger());
  check(JSON.stringify(after2["model-a"]) === JSON.stringify({ in: 900, cr: 0, c5: 0, c1: 0, out: 450 })
    && JSON.stringify(after2["model-x"]) === JSON.stringify(after1["model-x"]),
    `AW14b: the appended record counts exactly once; the untouched file's totals hold (${JSON.stringify(after2)})`);
}

// AW14c: the digest's spend line — a coming cap fires the digest on the spend
// factLine alone, verbatim with the trip estimate; a benign month stays
// silent (no digest at all on spend's account).
async function AW14c() {
  const w = fixtureWorld("aw14c");
  const coord = plant("coordinator", { task: w.home, transcript: plantTranscript(idleRows(Date.now())) });
  setLive([coord.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  awayOn(w.home);
  writeCfg({ watcher: { relay: relayStub }, spend: SPEND_CFG });
  resetProjects();
  plantProjectTranscript("alpha-111", [usageRow(inMonthMs(), "model-a", "c-1", { in: 9000000 })]); // $9 of $10, 90%
  plantState(w.home, { digestAt: new Date(Date.now() - 2 * 24 * 3600000).toISOString() });
  tick();
  const digests = relayMessages().filter((m) => m.includes("daily digest"));
  const factLines = digests.length === 1
    ? digests[0].split("\n").filter((l) => l.startsWith("- ")) : [];
  check(digests.length === 1 && factLines.length === 1
    && /^- monthly spend \$9 of \$10 \(90%\) — (the cap trips in ~\d+d at this pace|past the warn threshold)$/.test(factLines[0] || ""),
    `AW14c: the digest fires on the spend line alone, verbatim with the trip estimate (${JSON.stringify(digests[0] && digests[0].split("\n"))})`);
  check(digests.length === 1 && digests[0].includes("daily digest: 0 pendings older than 12h"),
    "AW14c: the digest's header still names the pendings count");

  const w2 = fixtureWorld("aw14c2");
  const coord2 = plant("coordinator", { task: w2.home, transcript: plantTranscript(idleRows(Date.now())) });
  setLive([coord2.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  awayOn(w2.home);
  writeCfg({ watcher: { relay: relayStub }, spend: SPEND_CFG });
  resetProjects();
  plantProjectTranscript("alpha-111", [usageRow(inMonthMs(), "model-a", "c-2", { in: 100000 })]); // $0.10 of $10 — benign
  plantState(w2.home, { digestAt: new Date(Date.now() - 2 * 24 * 3600000).toISOString() });
  tick();
  check(relayMessages().length === 0,
    "AW14c: a benign month never fires a digest on spend's account");
}

// AW14d: the pace projection — a synthetic month clock past the 3-day guard,
// a spend under the pct threshold whose rate trips before month end: coming
// by pace, with the exact projection numbers.
async function AW14d() {
  const monthStart = utcMonthStart(Date.now());
  const d = new Date(monthStart);
  const monthLen = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - monthStart) / 86400000;
  const nowMs = monthStart + 10 * 86400000; // inside the month at any run date, past the guard
  const ledgerAt = path.join(mk("aw14d"), "spend-ledger.json");
  fs.writeFileSync(ledgerAt, JSON.stringify({
    month: monthKeyOf(nowMs),
    refreshedAt: new Date(nowMs - 3600000).toISOString(),
    files: { "fixture.jsonl": { mtimeMs: 1, size: 1, skipped: 0,
      models: { "model-a": { in: 5000000, cr: 0, c5: 0, c1: 0, out: 0 } } } }, // $5 of $10 by day 10
  }));
  const fact = require("./lib/spend").readMonth({ ledgerPath: ledgerAt, config: { spend: SPEND_CFG }, nowMs });
  check(fact && fact.coming === true && fact.because === "pace" && fact.usd === 5 && fact.pct === 50
    && fact.ratePerDay === 0.5 && fact.daysToCap === 10 && fact.daysLeftInMonth === monthLen - 10,
    `AW14d: a tripping rate under the threshold reads coming by pace with the projection (${JSON.stringify(fact)})`);
}

// AW14e: the day-1 guard — under 3 elapsed days a bursty rate never projects
// a trip; only the pct threshold could warn.
async function AW14e() {
  const monthStart = utcMonthStart(Date.now());
  const nowMs = monthStart + 86400000; // day 1
  const ledgerAt = path.join(mk("aw14e"), "spend-ledger.json");
  const plant = (tokens) => fs.writeFileSync(ledgerAt, JSON.stringify({
    month: monthKeyOf(nowMs),
    refreshedAt: new Date(nowMs).toISOString(),
    files: { "fixture.jsonl": { mtimeMs: 1, size: 1, skipped: 0,
      models: { "model-a": { in: tokens, cr: 0, c5: 0, c1: 0, out: 0 } } } },
  }));
  plant(5000000); // $5 of $10 on day 1: a burst that would trip inside a day — guarded
  const bursty = require("./lib/spend").readMonth({ ledgerPath: ledgerAt, config: { spend: SPEND_CFG }, nowMs });
  check(bursty && bursty.coming === false && bursty.because === null,
    `AW14e: a bursty day-1 rate never projects a trip (${JSON.stringify(bursty && [bursty.coming, bursty.because])})`);
  plant(9000000); // $9 of $10 on day 1: over the threshold — the pct still fires
  const over = require("./lib/spend").readMonth({ ledgerPath: ledgerAt, config: { spend: SPEND_CFG }, nowMs });
  check(over && over.coming === true && over.because === "pct",
    `AW14e: the pct threshold still fires inside the guard window (${JSON.stringify(over && [over.coming, over.because])})`);
}

// AW14f: no configured cap — no ledger file, no spend surface; the transcripts
// sit there uncounted and even the walk never happens.
async function AW14f() {
  fixtureWorld("aw14f");
  resetProjects();
  plantProjectTranscript("alpha-111", [usageRow(inMonthMs(), "model-a", "f-1", { in: 9000000 })]);
  tick();
  check(!fs.existsSync(spendLedgerPath()),
    "AW14f: without a configured cap the tick maintains no ledger");
}

// AW14g: containment — an unreadable transcript inside the projects root
// cannot cost the tick: the refresh's throw is contained to one warn line,
// every home still heartbeats, exit 0 (the AW12 precedent — the containment
// is about the process, so the real binary runs).
async function AW14g() {
  const w = fixtureWorld("aw14g");
  const coord1 = plant("coordinator", { task: w.home, transcript: plantTranscript(idleRows(Date.now())) });
  const coord2 = plant("coordinator", { task: w.alpha, transcript: plantTranscript(idleRows(Date.now())) });
  setLive([coord1.name, coord2.name]);
  setPane(PANE_VT(VT_SUGGEST_LINE));
  writeCfg({ spend: SPEND_CFG });
  resetProjects();
  const locked = plantProjectTranscript("locked-333", [usageRow(inMonthMs(), "model-a", "g-1", { in: 100 })]);
  fs.chmodSync(locked, 0o000);
  const r = spawnSync(process.execPath, [path.join(__dirname, "bin", "watcher")],
    { encoding: "utf8", timeout: 120000 });
  derive.flushFacts();
  const warned = r.stderr.split("\n").some((l) => l.includes("spend ledger refresh failed"));
  const beat1 = fs.existsSync(path.join(w.home, "watcher.json"));
  const beat2 = fs.existsSync(path.join(w.alpha, "watcher.json"));
  check(r.status === 0 && warned && beat1 && beat2,
    `AW14g: an unreadable transcript warns one line, both homes keep their beats, exit 0 (${JSON.stringify([r.status, warned, beat1, beat2])})`);
}

const SCENARIOS = [
  ["AW1", AW1], ["AW2", AW2], ["AW3", AW3], ["AW4", AW4], ["AW5", AW5],
  ["AW6", AW6], ["AW7", AW7], ["AW8", AW8], ["AW9", AW9], ["AW10", AW10], ["AW11", AW11],
  ["AW12", AW12], ["AW13a", AW13a], ["AW13b", AW13b], ["AW13c", AW13c], ["AW13d", AW13d],
  ["AW13e", AW13e], ["AW13f", AW13f], ["AW13g", AW13g],
  ["AW14a", AW14a], ["AW14b", AW14b], ["AW14c", AW14c], ["AW14d", AW14d],
  ["AW14e", AW14e], ["AW14f", AW14f], ["AW14g", AW14g],
];

async function scenarios() {
  const only = process.env.WATCHER_ONLY;
  const names = only && only.trim() ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (names) {
    const known = SCENARIOS.map(([label]) => label);
    for (const name of names) {
      if (!known.includes(name)) throw new Error(`unknown WATCHER_ONLY label ${JSON.stringify(name)}; known: ${known.join(", ")}`);
    }
  }
  for (const [label, fn] of SCENARIOS) {
    if (!names || names.includes(label)) await fn();
  }
}

scenarios().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0); // the exit handler runs the teardown sweep
  },
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1); // ditto
  }
);
