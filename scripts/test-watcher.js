#!/usr/bin/env node
"use strict";
// watcher: the away safety net — relays a watched task's pending over the
// owner's private relay command while the home's coordinator is down, deaf or
// stuck on its own permission prompt, once per (session_id, needs_input.at);
// replaces a deaf or ended coordinator through the real restart verb under a
// per-hour spawn cap; the daily digest; the PAV health fact and the heartbeat.
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
  "  kill)",
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
// heartbeat while away is off (no relay even for a pending), and a world with
// no coordinator session ever serves no home at all.
async function AW1() {
  const w = fixtureWorld("aw1");
  plant("coordinator", { task: w.home, ended: true });
  const watched = plant("conductor", { task: w.alpha });
  setLive([watched.name]);
  pending(watched.dir, "a pending while the owner is not away");
  cfgRelay();
  tick(); // no away.md: away off — only the always-on jobs run
  const st = stateOf(w.home);
  check(Boolean(st.heartbeat) && Date.now() - Date.parse(st.heartbeat) < 60000,
    "AW1: one tick writes a fresh heartbeat into the home's watcher.json");
  check(st.ticks === 1 && st.pav === "unconfigured",
    `AW1: the first tick counts one beat and an unconfigured PAV fact (${JSON.stringify([st.ticks, st.pav])})`);
  check(relayMessages().length === 0 && launchCalls.length === 0,
    "AW1: away off relays nothing and launches nothing");

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
// end to end (the JSON carries previous_session_id), and a second real run
// against an occupied seat is refused by the verb, recorded, nothing ended.
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
  const entry = session.entries().find((e) => e.registration.previous_session_id === coord.sid);
  const reg = entry && entry.registration;
  check(Boolean(reg) && reg.agent === "coordinator" && reg.task_dir === w.home,
    `AW10: the replacement registers as the home's coordinator carrying previous_session_id (${Boolean(reg)})`);
  check(Boolean(session.readRegistration(coord.dir).ended_at),
    "AW10: the deaf coordinator's end is recorded by the verb");
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

const SCENARIOS = [
  ["AW1", AW1], ["AW2", AW2], ["AW3", AW3], ["AW4", AW4], ["AW5", AW5],
  ["AW6", AW6], ["AW7", AW7], ["AW8", AW8], ["AW9", AW9], ["AW10", AW10], ["AW11", AW11],
  ["AW12", AW12],
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
