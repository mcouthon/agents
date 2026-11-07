#!/usr/bin/env node
"use strict";
// pane-send: the shared send path for zmx panes — chunking, the transcript
// verify poll, every refusal path, paste's bracketed byte stream, and
// answer's read-send-reread (TOCTOU) plus the needs_input clear.
// Isolation: nothing here may touch the real HOME, db, zmx or sessions; the
// stub zmx serves a private ZMX_DIR and never the real daemon.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-pane-send-")));
  for (const d of ["home", "xdg", "stubbin"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"), { recursive: true });
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_DB", "AGENTS_TASKS_ROOT",
    "AGENTS_SESSIONS_ROOT", "ZMX_SESSION", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const PANE = path.join(__dirname, "bin", "pane-send");

const { PROMPT_MARKERS, OWNER_ONLY_WORDS, flattenText, chunkText } = require("./bin/pane-send");
const db = require("./lib/db");
const session = require("./lib/session");
const taskLib = require("./lib/task");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }
const mk = (label) => { const d = path.join(T, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Stub zmx: serves `list` from $ZMX_DIR/list, `history <n>` from the pane
// files (pane.<n> always; paneK.<n> from history-call K on), logs every
// `send` between ===SEND/===END markers, and — when send-call $ZMX_ENTER_AT
// arrives (the Enter) — appends $ZMX_APPEND to $ZMX_TRANSCRIPT after
// $ZMX_APPEND_DELAY (the write lags the Enter).
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  'Z=${ZMX_DIR:?ZMX_DIR not set}',
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  '  list) cat "$Z/list" 2>/dev/null; exit 0 ;;',
  "  history)",
  '    name=$2',
  '    [ "${3:-}" = "--vt" ] || { echo "stub zmx: history without --vt: $*" >&2; exit 65; }',
  '    cf="$Z/hcount.$name"; c=0; [ -f "$cf" ] && c=$(cat "$cf"); c=$((c + 1)); echo "$c" > "$cf"',
  '    i=9',
  '    while [ "$i" -ge 2 ]; do',
  '      if [ -f "$Z/pane$i.$name" ] && [ "$c" -ge "$i" ]; then cat "$Z/pane$i.$name"; exit 0; fi',
  '      i=$((i - 1))',
  "    done",
  '    cat "$Z/pane.$name" 2>/dev/null',
  "    exit 0 ;;",
  "  send)",
  '    name=$2',
  '    cf="$Z/scount.$name"; c=0; [ -f "$cf" ] && c=$(cat "$cf"); c=$((c + 1)); echo "$c" > "$cf"',
  "    printf '===SEND\\n' >> \"$Z/send.log\"",
  '    cat >> "$Z/send.log"',
  "    printf '\\n===END\\n' >> \"$Z/send.log\"",
  '    if [ -n "$ZMX_APPEND" ] && [ -f "$ZMX_APPEND" ] && [ "$c" -eq "${ZMX_ENTER_AT:-999999}" ]; then',
  // One hour ahead of now: a seconds-truncated stamp can sort before the
  // send's start instant when both land in the same second (.000 < .017).
  '      ( sleep "${ZMX_APPEND_DELAY:-0.3}"; sed "s/__TS__/$(date -u -v+1H +%Y-%m-%dT%H:%M:%S.000Z)/" "$ZMX_APPEND" >> "$ZMX_TRANSCRIPT" ) &',
  "    fi",
  "    exit 0 ;;",
  '  *) echo "stub zmx: unsupported: $*" >&2; exit 64 ;;',
  "esac",
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;

// Pane fixtures. The input box renders its glyph at column 0; the permission
// prompt's option cursor is an INDENTED glyph (option lines are indented).
const PANE_PROMPT = [
  "  ⏺ Reading the plan for phase 2",
  "  Do you want to proceed?",
  "    ❯ 1. Yes",
  "      2. Yes, and don't ask again",
  "      3. No, and tell Claude what to do differently (esc)",
  "  🤖 Conductor | GLM 5.3",
  "",
].join("\n");
const PANE_REST = [
  "  ✻ Welcome to Claude Code",
  "  ───────── Conductor ─",
  "❯ ",
  "  ─────────",
  "  🤖 Conductor | GLM 5.3",
  "",
].join("\n");
const PANE_TYPED = PANE_REST.replace("❯ ", "❯ approve the plan for phase 2");
const PANE_PLAIN = [
  "  ⏺ Reading the plan for phase 2",
  "  no input glyph anywhere in this tail",
  "  🤖 Conductor | GLM 5.3",
  "",
].join("\n");
const PANE_ANSWERED = [
  "  ⏺ Running the tool now",
  "  ⏺ Some new output line",
  "  ───────── Conductor ─",
  "  🤖 Conductor | GLM 5.3",
  "",
].join("\n");
// The prompt block with one option changed (the TOCTOU pane).
const PANE_CHANGED = PANE_PROMPT.replace("      2. Yes, and don't ask again", "      2. Yes, allow everything");
// The pre pane minus the prompt block: the marker gone but nothing new.
const PANE_GONE_QUIET = [
  "  ⏺ Reading the plan for phase 2",
  "  🤖 Conductor | GLM 5.3",
  "",
].join("\n");

// vt fixtures (--vt dump shapes): the grey suggestion renders inside SGR 2
// (dim) after a bare glyph and a non-breaking space; typed text renders
// non-dim (an fg 38;5;15 run). Only the live input box starts with a bare
// glyph at column 0 (echoed user lines start with ESC), and the cursor-control
// junk line starts with ESC and never reads as the box.
const VT_SUGGEST_LINE = "❯\xa0\x1b[0m\x1b[2mTry \"how do I log an error?\"\x1b[0m";
const VT_TYPED_LINE = "❯\xa0\x1b[38;5;15mapprove the plan\x1b[0m";
const PANE_VT = (inputLine) => [
  "  \x1b[36m⏺\x1b[0m Reading the plan for phase 2",
  inputLine,
  "  \x1b[2m───────── Conductor ─────────\x1b[0m",
  "\x1b[?25l\x1b[2;1H",
  "",
].join("\n");

const iso = (d) => d.toISOString();
const minutesAgo = (m) => iso(new Date(Date.now() - m * 60000));
const userEntry = (ts, content) => JSON.stringify({ type: "user", timestamp: ts, isSidechain: false, message: { role: "user", content } }) + "\n";
// The transcript of a session that last turned in 2020: every user/assistant
// row predates any needs_input the scene records (a fresh lit row); the
// tool_result row is a user row that never reads as a typed message.
const OLD_ENTRIES = [
  userEntry("2020-01-01T00:00:00.000Z", "x".repeat(600)),
  JSON.stringify({ type: "user", timestamp: "2020-01-01T00:00:01.000Z", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] } }) + "\n",
].join("");
// A transcript with bookkeeping rows only: the file exists, no turn ever ran.
const BOOKKEEPING_ENTRIES = JSON.stringify({ type: "last-prompt", prompt: "hi" }) + "\n"
  + JSON.stringify({ type: "cost-state", cost: 1 }) + "\n";
// A future sidechain user row: never a typed turn (the fresh-empty rule
// holds) and never a verify match — typedTextOf filters sidechain either way.
const SIDECHAIN_ENTRIES = userEntry("2099-01-01T00:00:00.000Z", "y".repeat(900)).replace('"isSidechain":false', '"isSidechain":true');
// The bookkeeping row Claude Code writes into a waiting session's transcript
// after the idle signal (the pav#307 tail).
const COST_STATE_ROW = JSON.stringify({ type: "cost-state", cost: 1 }) + "\n";

// One fresh world per scene: its own ZMX_DIR, db, sessions root, task,
// transcript. The session is task-bound; `gate` makes the task one whose
// advice holds a question (an approvals:ask plan awaiting approval), the
// state a gate word answers.
let sceneNo = 0;
function scene(opts = {}) {
  const {
    pane = "prompt", alt2 = null, pane3 = null, register = true, needs = true,
    ended = false, transcriptExists = true, entries = "old", gate = false,
  } = opts;
  const root = mk(`scene${++sceneNo}`);
  const z = path.join(root, "zmx");
  fs.mkdirSync(z);
  const name = `S${sceneNo}`;
  const transcript = path.join(root, "t.jsonl");
  if (transcriptExists) {
    const content = entries === "bookkeeping" ? BOOKKEEPING_ENTRIES
      : entries === "sidechain" ? SIDECHAIN_ENTRIES : OLD_ENTRIES;
    fs.writeFileSync(transcript, content);
  }
  const panes = {
    prompt: PANE_PROMPT, rest: PANE_REST, typed: PANE_TYPED, plain: PANE_PLAIN,
    vtSuggest: PANE_VT(VT_SUGGEST_LINE), vtTyped: PANE_VT(VT_TYPED_LINE),
  };
  fs.writeFileSync(path.join(z, `pane.${name}`), panes[pane]);
  if (alt2) fs.writeFileSync(path.join(z, `pane2.${name}`), alt2);
  if (pane3) fs.writeFileSync(path.join(z, `pane3.${name}`), pane3);
  fs.writeFileSync(path.join(z, "list"), `  name=${name}\tpid=1\tclients=0\tcreated=1\tcwd=/tmp\n`);
  const sessions = path.join(root, "sessions");
  const tasksRoot = path.join(root, "tasks");
  fs.mkdirSync(sessions);
  Object.assign(process.env, {
    AGENTS_DB: path.join(root, "agents.db"), AGENTS_SESSIONS_ROOT: sessions,
    AGENTS_TASKS_ROOT: tasksRoot, ZMX_DIR: z, ZMX_TRANSCRIPT: transcript,
    ZMX_APPEND: path.join(root, "append.jsonl"), ZMX_APPEND_DELAY: "0.3", ZMX_ENTER_AT: "",
  });
  let sdir = null;
  let taskDir = null;
  if (register) {
    const repo = { key: "github.com/t/x", main_root: root };
    taskDir = taskLib.createTask({
      repo, title: `Scene ${sceneNo}`, slug: `sc${sceneNo}`, mode: "fast", tier: "standard",
      phases: [{ id: 1, name: "P" }], description: "",
    }).task_dir;
    if (gate) {
      db.setTaskKnob(db.taskIdOf(taskDir), "approvals", "ask");
      fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
      fs.writeFileSync(path.join(taskDir, "plan", "phase-1-p.md"), "# plan\n");
    }
    const r = session.register({
      origin: "cli", agent: "conductor", session_id: `sid-${sceneNo}`, terminal_id: `t${sceneNo}`,
      cwd: root, repo_key: "github.com/t/x", task_dir: taskDir,
      transcript_path: transcript, mux: { kind: "zmx", name },
      session_dir: path.join(sessions, `t${sceneNo}`),
    });
    sdir = r.session_dir;
    if (needs) session.recordSignal(sdir, { message: "Do you want to proceed?" });
    if (needs && transcriptExists) {
      // the pav#307 shape: the transcript keeps taking bookkeeping writes
      // after the signal — mtime newer than at, no turn appended
      fs.appendFileSync(transcript, COST_STATE_ROW);
    }
    if (ended) session.markEnded(sdir);
  }
  return { root, z, name, transcript, sdir, sessions, tasksRoot, taskDir };
}

// The delayed transcript entry: the sent text lands as a fresh user message.
function armAppend(text) {
  fs.writeFileSync(process.env.ZMX_APPEND, userEntry("__TS__", text));
}

function run(args, { input } = {}) {
  const r = spawnSync(process.execPath, [PANE, ...args], {
    encoding: "utf8", timeout: 60000, cwd: T, input: input === undefined ? undefined : input,
  });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// The stub's send log: one payload per zmx send call.
function sendPayloads() {
  const log = path.join(process.env.ZMX_DIR, "send.log");
  if (!fs.existsSync(log)) return [];
  const raw = fs.readFileSync(log, "utf8");
  return raw.split("===SEND\n").slice(1).map((seg) => seg.slice(0, seg.indexOf("\n===END")));
}

// A decide row in the scene's own db — on the scene's task by default, with
// task/author/choice knobs for the binding matrix.
function decideRow({ taskDir, choice = "answer", recordedBy = null, quote = "the owner's words", decidedAt } = {}) {
  let dir = taskDir;
  if (!dir) {
    const repo = { key: "github.com/t/x", main_root: path.join(process.env.ZMX_DIR, "..") };
    dir = taskLib.createTask({ repo, title: "Backing", slug: "backing", mode: "fast", tier: "standard", phases: [{ id: 1, name: "P" }], description: "" }).task_dir;
  }
  const row = taskLib.taskRowOf(dir);
  return db.insertDecision({
    task_id: row.id, phase_id: null, choice, quote,
    recorded_by: recordedBy, decided_at: decidedAt || iso(new Date()),
  });
}

// ---------------------------------------------------------------- the exported constants

check(Array.isArray(PROMPT_MARKERS) && JSON.stringify(PROMPT_MARKERS) === JSON.stringify(["Do you want to proceed?", "needs your confirmation"]),
  "C1: PROMPT_MARKERS is exactly the 129-watch reference set (both strings)");
check(JSON.stringify(OWNER_ONLY_WORDS) === JSON.stringify([
  "approve", "accept", "reject", "skip", "land_anyway", "approve_anyway", "override", "waived", "answer",
  "install", "restart", "kill", "stop", "rm", "delete",
]), "C2: OWNER_ONLY_WORDS is the decide choices plus the install/restart/kill class (15 words)");

// ---------------------------------------------------------------- flatten and chunk math

check(flattenText("  line one\nline two\n\nline three\n") === "line one line two  line three",
  "F1: flatten trims the ends, maps newlines to spaces, keeps interior blank lines as double spaces (the reference join)");
check(flattenText("a\r\nb\rc") === "a b c", "F2: flatten folds \\r\\n and bare \\r like the reference's splitlines");
check(flattenText("   \n\n  ") === "", "F3: flatten of only whitespace is the empty string");
check(JSON.stringify(chunkText("x".repeat(450), 200)) === JSON.stringify(["x".repeat(200), "x".repeat(200), "x".repeat(50)]),
  "F4: 450 chars at 200 chunk to 200+200+50");
check(chunkText("x".repeat(200), 200).length === 1 && chunkText("x".repeat(40), 200)[0] === "x".repeat(40) && chunkText("", 200).length === 0,
  "F5: a text within the chunk size is one chunk; empty text is none");

// ---------------------------------------------------------------- send: the happy path

{
  const s = scene();
  const text = "The owner says proceed with the next phase when the report lands";
  const flat = flattenText(text);
  armAppend(flat);
  process.env.ZMX_ENTER_AT = String(Math.ceil(flat.length / 50) + 1); // 2 chunks, then the Enter
  const t0 = Date.now();
  const r = run(["send", s.name, text, "--chunk-chars", "50", "--pause-secs", "0.05"]);
  const elapsed = Date.now() - t0;
  const calls = sendPayloads();
  check(r.status === 0, `S1: send exits 0 (${r.err.trim().split("\n")[0] || ""})`);
  check(calls.slice(0, -1).join("") === flat && calls[calls.length - 1] === "\r",
    "S2: the chunks arrive in order and reassemble the flattened text, the \\r is a separate final send");
  check(calls.slice(0, -1).every((c) => c.length <= 50), "S3: every chunk is within the chunk size");
  check(r.out.includes(`${flat.length}-char`) && !r.out.includes("600-char"),
    `S4: the transcript verify names the appended entry's length, not the older 600-char one (${r.out.trim()})`);
  check(elapsed >= 550, `S5: the send waited the inter-chunk pauses and the pre-Enter settle (took ${elapsed}ms)`);
}

// send: stdin carries the text when no positional is given
{
  const s = scene();
  const text = "Piped text for the pane with plenty of words to chunk through";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = "3";
  const r = run(["send", s.name, "--chunk-chars", "50", "--pause-secs", "0.05"], { input: text });
  const calls = sendPayloads();
  check(r.status === 0, `S6: stdin text sends and verifies (${r.err.trim().split("\n")[0] || ""})`);
  check(calls.slice(0, -1).join("") === flattenText(text), "S7: the stdin text is flattened and chunked identically");
}

// ---------------------------------------------------------------- send: the verify poll

{
  const s = scene();
  // No ZMX_APPEND: nothing lands after the Enter; the old entries must not satisfy the poll.
  const r = run(["send", s.name, "short text only", "--chunk-chars", "50", "--pause-secs", "0.02", "--verify-secs", "0.5"]);
  check(r.status === 1, `S8: no qualifying user message within the budget exits 1, never a silent retry (${r.status})`);
  check(/at least 15 chars/.test(r.err) && /found \d+ chars/.test(r.err),
    `S9: the failure names the expected and found lengths (${r.err.trim().split("\n")[0] || ""})`);
  check(r.err.includes("Do you want to proceed?"), "S10: the failure prints the pane tail");
}

{
  const s = scene({ transcriptExists: false });
  const r = run(["send", s.name, "short text", "--chunk-chars", "50", "--pause-secs", "0.02", "--verify-secs", "0.5"]);
  check(r.status === 1 && /no user message/.test(r.err),
    `S11: a transcript that never appears fails the verify (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- send: refusal paths

{
  scene(); // a live scene whose session is deliberately not the one named
  const r = run(["send", `nope-${Date.now()}`, "hello there"]);
  check(r.status === 2 && /no zmx session/.test(r.err), `R1: an unknown zmx session refuses, exit 2 (${r.err.trim()})`);
}

{
  const s = scene({ register: false });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /no engine registration/.test(r.err), `R2: a pane with no engine registration refuses (${r.err.trim()})`);
}

{
  const s = scene({ ended: true });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /gone|ended/.test(r.err), `R3: an ended registration refuses (${r.err.trim()})`);
}

{
  // needs_input unset and a pane with a prompt: a mid-turn session (CC queues typed input).
  const s = scene({ pane: "prompt", needs: false });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /mid-turn|needs_input|fresh/.test(r.err), `R4: a mid-turn session refuses (${r.err.trim()})`);
}

{
  // needs_input unset, rest pane with an empty input box, a transcript with
  // bookkeeping rows only (no turn ever ran): the fresh-empty path (a first message).
  const s = scene({ pane: "rest", needs: false, entries: "bookkeeping" });
  armAppend(flattenText("the first message into a fresh pane"));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, "the first message into a fresh pane", "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `R5: a fresh-empty pane accepts a send without needs_input (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene({ pane: "typed" });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /input box|input line/.test(r.err), `R6: a pane with typed input refuses (${r.err.trim()})`);
}

{
  const s = scene({ pane: "plain" });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /input box|input line/.test(r.err), `R7: a pane with no visible input line refuses (${r.err.trim()})`);
}

{
  const s = scene();
  const r = run(["send", s.name, "/clear the decks before we start"]);
  check(r.status === 2 && /\/clear/.test(r.err), `R8: text starting with /clear is refused always (${r.err.trim()})`);
}

{
  const s = scene();
  const r = run(["send", s.name, "approve the plan, it looks good"]);
  check(r.status === 2 && /approve/.test(r.err) && /owner-only/.test(r.err),
    `R9: an owner-only first word without --decision-id refuses (${r.err.trim()})`);
}

{
  const s = scene();
  const r = run(["send", s.name, "rm -rf the leftover worktree"]);
  check(r.status === 2 && /\brm\b/.test(r.err) && /owner-only/.test(r.err),
    `R10: rm is an owner-only word (${r.err.trim()})`);
}

{
  const s = scene();
  const missing = run(["send", s.name, "approve the plan", "--decision-id", "999"]);
  check(missing.status === 2 && /--decision-id 999/.test(missing.err) && /no (such|decide) row/.test(missing.err),
    `R11: a --decision-id that names no decide row refuses (${missing.err.trim()})`);
}

{
  const s = scene();
  const id = decideRow({ decidedAt: minutesAgo(10) });
  const stale = run(["send", s.name, "approve the plan", "--decision-id", String(id)]);
  check(stale.status === 2 && /old/.test(stale.err) && /5 minutes/.test(stale.err),
    `R12: a decide row older than 5 minutes refuses (${stale.err.trim()})`);
}

{
  const s = scene();
  const id = decideRow({ quote: "" });
  const empty = run(["send", s.name, "approve the plan", "--decision-id", String(id)]);
  check(empty.status === 2 && /empty quote/.test(empty.err),
    `R13: a decide row with an empty quote refuses (${empty.err.trim()})`);
}

{
  const s = scene();
  const id = decideRow({ taskDir: s.taskDir, quote: "ship it" });
  armAppend(flattenText("approve the plan, phase 2"));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, "approve the plan, phase 2", "--decision-id", String(id), "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `R14: a fresh quoted decide row on the target's task backs an owner-only word (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- paste

// The paste body: multi-line markdown, the shape PAV's _task_body pastes —
// an interior blank line, trailing spaces kept on one line, no trailing newline.
const PASTE_BODY = [
  "## Phase 2 build",
  "",
  "Run the build and report the result.",
  "A line with trailing spaces kept   ",
  "and a third line ends the body",
].join("\n");

{
  const s = scene({ pane: "rest", needs: false, entries: "bookkeeping" });
  // The pane starts empty (the precondition read); the sig shows up only on
  // the verify read, as the pasted text sitting in the input box.
  const sig = PASTE_BODY.replace(/\s+$/, "").slice(-20);
  fs.writeFileSync(path.join(process.env.ZMX_DIR, `pane2.${s.name}`), PANE_REST.replace("❯ ", `❯ ${sig}`));
  const r = run(["paste", s.name, PASTE_BODY, "--chunk-chars", "30", "--pause-secs", "0.02"]);
  const calls = sendPayloads();
  const joined = calls.join("");
  check(r.status === 0, `P1: paste exits 0 (${r.err.trim().split("\n")[0] || ""})`);
  check(joined === `\x1b[200~${PASTE_BODY}\x1b[201~`,
    "P2: the paste stream is exactly ESC[200~ + the raw body + ESC[201~ — one wrap around the whole text, newlines preserved, no flatten (byte-equal to paste_input)");
  check(joined.split("\x1b[200~").length === 2 && joined.split("\x1b[201~").length === 2,
    "P3: exactly one opening and one closing marker across every chunk, never one pair per chunk");
  check(calls.length >= 3 && calls.every((c) => c.length <= 30 + "\x1b[200~".length + "\x1b[201~".length),
    `P4: the body chunks (${calls.length} >= 3 here) and every payload keeps within the chunk size plus the marker overhead`);
  check(!joined.includes("\r"), "P5: paste never sends \\r (no Enter anywhere in the stream)");
  check(/pane tail shows the final chunk/.test(r.out),
    `P6: the report-only verify names what the pane tail shows (${r.out.trim()})`);
}

{
  const s = scene({ pane: "rest", needs: false, entries: "bookkeeping" });
  const r = run(["paste", s.name, "--chunk-chars", "30", "--pause-secs", "0.02"], { input: PASTE_BODY });
  const calls = sendPayloads();
  check(r.status === 0 && calls.join("") === `\x1b[200~${PASTE_BODY}\x1b[201~`,
    `P7: a multi-line body from stdin pastes with the same one-wrap bytes (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene({ pane: "rest", needs: false, entries: "bookkeeping" });
  const r = run(["paste", s.name, PASTE_BODY, "--chunk-chars", "30", "--pause-secs", "0.02"]);
  check(r.status === 0 && /does not show the final chunk/.test(r.out),
    `P8: a paste whose tail never shows the sig still exits 0 with the report (${r.out.trim()})`);
  check(/❯/.test(r.out), "P9: the unverified report prints the pane tail");
}

{
  const s = scene();
  const r = run(["paste", s.name, "/clear it all"]);
  check(r.status === 2 && /\/clear/.test(r.err), `P10: paste refuses /clear like every mode (${r.err.trim()})`);
  const sneaky = run(["paste", s.name, "\n\n/clear hiding behind leading newlines"]);
  check(sneaky.status === 2 && /\/clear/.test(sneaky.err),
    `P11: a /clear hiding behind leading newlines still refuses — the raw text is checked, not a flatten (${sneaky.err.trim()})`);
}

{
  const s = scene();
  const r = run(["paste", s.name, "approve\nthe plan, it looks good"]);
  check(r.status === 2 && /owner-only/.test(r.err),
    `P12: an owner-only first word found across newlines refuses (${r.err.trim()})`);
}

{
  const s = scene({ pane: "rest", needs: false, entries: "bookkeeping" });
  const r = run(["paste", s.name], { input: "\n\n   \n" });
  check(r.status === 2 && /empty/.test(r.err), `P13: a whitespace-only paste refuses as empty (${r.err.trim()})`);
}

{
  const s = scene({ pane: "typed" });
  const r = run(["paste", s.name, PASTE_BODY]);
  check(r.status === 2 && /input box/.test(r.err),
    `P14: paste refuses a non-empty input box — the pane preconditions still run on the raw text (${r.err.trim()})`);
}

// ---------------------------------------------------------------- answer

{
  const s = scene({ pane3: PANE_ANSWERED });
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "2"]);
  const calls = sendPayloads();
  check(r.status === 0, `A1: answer exits 0 when the prompt leaves and output appears (${r.err.trim().split("\n")[0] || ""})`);
  check(calls.length === 1 && calls[0] === "1", "A2: answer sends exactly the option keystroke");
}

{
  const s = scene({ alt2: PANE_CHANGED });
  const r = run(["answer", s.name, "--option", "1"]);
  check(r.status === 2 && /changed between/.test(r.err),
    `A3: a pane that changes between the read and the keystroke refuses (TOCTOU) (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene({ pane: "rest" });
  const r = run(["answer", s.name, "--option", "1"]);
  check(r.status === 2 && /no permission prompt/.test(r.err),
    `A4: a pane without a prompt refuses answer (${r.err.trim()})`);
}

{
  const s = scene({ needs: false });
  const r = run(["answer", s.name, "--option", "1"]);
  check(r.status === 2 && /mid-turn|needs_input|fresh/.test(r.err),
    `A5: answer on a session whose state is not needs_input refuses (${r.err.trim()})`);
}

{
  // No pane3: the keystroke is lost, the marker stays for the whole budget.
  const s = scene();
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "0.5"]);
  check(r.status === 1 && /still shows|answer failed/.test(r.err),
    `A6: a keystroke that changes nothing fails with the tail (${r.err.trim().split("\n")[0] || ""})`);
  check(r.err.includes("Do you want to proceed?"), "A7: the failure prints the pane tail");
}

{
  // The marker leaves but nothing new appears (the block was just erased).
  const s = scene({ pane3: PANE_GONE_QUIET });
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "0.5"]);
  check(r.status === 1 && /new output|answer failed/.test(r.err),
    `A8: the prompt leaving without new output fails (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene({ pane3: PANE_ANSWERED });
  const bad = run(["answer", s.name, "--option", "yes"]);
  check(bad.status === 2 && /--option/.test(bad.err), `A9: a multi-char --option refuses (${bad.err.trim()})`);
  const slash = run(["answer", s.name, "--option", "/"]);
  check(slash.status === 2, "A10: a slash --option refuses");
  const r = run(["answer", s.name, "--option", "enter", "--verify-secs", "2"]);
  const calls = sendPayloads();
  check(r.status === 0 && calls.length === 1 && calls[0] === "\r", `A11: --option enter sends \\r (${r.err.trim()})`);
}

{
  // The keystroke fires no UserPromptSubmit, so a verified answer clears the
  // needs_input signal itself — the same clearSignal the hook calls.
  const s = scene({ pane3: PANE_ANSWERED });
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "2"]);
  const reg = session.readRegistration(s.sdir);
  check(r.status === 0 && reg && !reg.needs_input,
    `A12: a verified answer clears the registration's needs_input (${r.err.trim().split("\n")[0] || ""})`);
  check(/needs-input signal is cleared/.test(r.out),
    `A13: the success line reports the clear (${r.out.trim()})`);
}

{
  const s = scene({ alt2: PANE_CHANGED });
  const r = run(["answer", s.name, "--option", "1"]);
  const reg = session.readRegistration(s.sdir);
  check(r.status === 2 && reg && !!reg.needs_input,
    `A14: a refused answer (the pane changed) never clears the signal (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene();
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "0.5"]);
  const reg = session.readRegistration(s.sdir);
  check(r.status === 1 && reg && !!reg.needs_input,
    `A15: a failed verify (the prompt stays) never clears the signal (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- placeholder discrimination (vt)

{
  // Fresh pane: the suggestion renders dim after the glyph, the transcript
  // holds bookkeeping rows only — the suggestion reads as an empty box and
  // the first-message paste goes through.
  const s = scene({ pane: "vtSuggest", needs: false, entries: "bookkeeping" });
  const r = run(["paste", s.name, PASTE_BODY, "--chunk-chars", "30", "--pause-secs", "0.02"]);
  check(r.status === 0, `V1: a fresh pane's dim suggestion reads as an empty box; paste exits 0 (${r.err.trim().split("\n")[0] || ""})`);
}

{
  // Mid-turn: the same empty-looking box, but the transcript holds a typed
  // user entry — the turn that ran. The send refuses as mid-turn.
  const s = scene({ pane: "vtSuggest", needs: false });
  const r = run(["send", s.name, "hello there", "--chunk-chars", "50", "--pause-secs", "0.02", "--verify-secs", "0.5"]);
  check(r.status === 2 && /mid-turn/.test(r.err),
    `V2: an empty box over a transcript with a turn refuses as mid-turn (${r.err.trim().split("\n")[0] || ""})`);
}

{
  // Typed text: a non-dim run after the glyph reads as a non-empty box.
  const s = scene({ pane: "vtTyped" });
  const r = run(["send", s.name, "hello there"]);
  check(r.status === 2 && /input box/.test(r.err),
    `V3: typed (non-dim) text in the box refuses as non-empty (${r.err.trim().split("\n")[0] || ""})`);
}

{
  // After-turn: the suggestion rendered after a turn, needs_input fresh.
  // The 15-minute refusal, replayed green.
  const s = scene({ pane: "vtSuggest", needs: true });
  const text = "The owner says proceed with the next phase when the report lands";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = String(Math.ceil(flattenText(text).length / 50) + 1);
  const r = run(["send", s.name, text, "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `V4: an after-turn pane with a dim suggestion sends — the 15-minute refusal replayed green (${r.err.trim().split("\n")[0] || ""})`);
}

{
  // A sidechain user row neither turns the pane (the fresh-empty rule holds)
  // nor satisfies the transcript verify — typedTextOf filters sidechain.
  const s = scene({ pane: "vtSuggest", needs: false, entries: "sidechain" });
  const text = "the first message into a pane whose transcript holds a sidechain row";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, text, "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `V5: a sidechain row neither turns the pane nor fails the fresh-empty rule (${r.err.trim().split("\n")[0] || ""})`);
  check(r.out.includes(`${flattenText(text).length}-char`),
    `V6: the verify names the appended entry, not the 900-char sidechain row (${r.out.trim()})`);
}

// ---------------------------------------------------------------- needs_input staleness

{
  // The pav#307 shape: every timestamped turn predates the signal, a
  // bookkeeping-only tail was written after it (mtime an hour newer than at)
  // — the row stays fresh and the send passes; the mtime rule would have
  // refused this row.
  const s = scene();
  const reg = session.readRegistration(s.sdir);
  const atMs = reg && reg.needs_input ? Date.parse(reg.needs_input.at) : 0;
  fs.utimesSync(s.transcript, new Date(atMs + 3600000), new Date(atMs + 3600000));
  check(reg && reg.needs_input && fs.statSync(s.transcript).mtimeMs > atMs,
    "ST1: the scene's transcript mtime runs an hour newer than needs_input.at (the pav#307 shape)");
  const text = "sent into a waiting session whose transcript was touched after the signal";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = String(Math.ceil(flattenText(text).length / 50) + 1);
  const r = run(["send", s.name, text, "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `ST2: the mtime-touched waiting row still sends (${r.err.trim().split("\n")[0] || ""})`);
}

{
  // The mid-turn shape: a timestamped user row landed after the signal — the
  // row reads stale, the state falls through to live, mid-turn refusal.
  const s = scene();
  fs.appendFileSync(s.transcript, userEntry("2099-01-01T00:00:00.000Z", "the owner typed after the signal"));
  const r = run(["send", s.name, "hello there", "--chunk-chars", "50", "--pause-secs", "0.02", "--verify-secs", "0.5"]);
  check(r.status === 2 && /mid-turn/.test(r.err),
    `ST3: a turn after the signal unlights the row — the send refuses as mid-turn (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- the --decision-id binding

{
  // Gate-awaiting (fresh needs_input + a task whose advice holds a question)
  // with a valid row: the target's task, choice approve, recorded by nobody,
  // under 5 minutes, quoted — sent.
  const s = scene({ gate: true });
  const id = decideRow({ taskDir: s.taskDir, choice: "approve" });
  const text = "approve the plan, the owner's words";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, text, "--decision-id", String(id), "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `B1: a valid decide row backs the gate word (${r.err.trim().split("\n")[0] || ""})`);
}

{
  const s = scene({ gate: true });
  const id = decideRow({ choice: "approve" }); // a row on another task
  const r = run(["send", s.name, "hello there", "--decision-id", String(id)]);
  check(r.status === 2 && /another task/.test(r.err),
    `B2: a row deciding another task than the target's refuses (${r.err.trim()})`);
}

{
  const s = scene({ gate: true });
  const id = decideRow({ taskDir: s.taskDir, choice: "waived" });
  const r = run(["send", s.name, "hello there", "--decision-id", String(id)]);
  check(r.status === 2 && /waived/.test(r.err),
    `B3: a waived row refuses (${r.err.trim()})`);
}

{
  const s = scene({ gate: true });
  const id = decideRow({ taskDir: s.taskDir, choice: "approve", recordedBy: "another-session" });
  const r = run(["send", s.name, "hello there", "--decision-id", String(id)]);
  check(r.status === 2 && /another session/.test(r.err),
    `B4: a row recorded by another session refuses (${r.err.trim()})`);
}

{
  // The invoking session's own row: pane-send reads CLAUDE_CODE_SESSION_ID.
  const s = scene({ gate: true });
  process.env.CLAUDE_CODE_SESSION_ID = "the-invoking-session";
  const id = decideRow({ taskDir: s.taskDir, choice: "approve", recordedBy: "the-invoking-session" });
  const text = "hello there into the gated session";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, text, "--decision-id", String(id), "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `B5: a row recorded by the invoking session backs the send (${r.err.trim().split("\n")[0] || ""})`);
  delete process.env.CLAUDE_CODE_SESSION_ID;
}

{
  // Gate-awaiting without the flag: one advisory line on stderr, exit 0,
  // the text sent (PAV's sends today are exactly this row).
  const s = scene({ gate: true });
  const text = "yes, proceed with the plan";
  armAppend(flattenText(text));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, text, "--chunk-chars", "50", "--pause-secs", "0.05"]);
  const calls = sendPayloads();
  check(r.status === 0 && /advisory/.test(r.err) && r.err.trim().split("\n").length === 1,
    `B6: a gate-awaiting send without the flag advises once on stderr and sends (${JSON.stringify(r.err)})`);
  check(calls.slice(0, -1).join("") === flattenText(text),
    "B7: the advisory changes no bytes — the text is sent as it was");
}

{
  // A needs_input session whose task asks no question: no advisory.
  const s = scene();
  const r = run(["send", s.name, "hello there", "--chunk-chars", "50", "--pause-secs", "0.02", "--verify-secs", "0.5"]);
  check(r.status === 1 && !/advisory/.test(r.err),
    `B8: a needs_input session whose task asks no question gets no advisory — only the verify runs (${r.status})`);
}

{
  // paste obeys the same rules: a draft offered into a gated session.
  const s = scene({ gate: true });
  const r = run(["paste", s.name, "the draft offered into the gated session", "--chunk-chars", "30", "--pause-secs", "0.02"]);
  check(r.status === 0 && /advisory/.test(r.err),
    `B9: paste into a gate-awaiting session advises on stderr and still pastes (${r.err.trim()})`);
}

// ---------------------------------------------------------------- --expect-prompt-hash

// The canonical prompt-block text of PANE_PROMPT: the marker line plus the
// consecutive option lines, escapes stripped (the fixture carries none),
// joined by \n — the same string the caller hashed when it showed the prompt.
const PROMPT_BLOCK_TEXT = [
  "  Do you want to proceed?",
  "    ❯ 1. Yes",
  "      2. Yes, and don't ask again",
  "      3. No, and tell Claude what to do differently (esc)",
].join("\n");

{
  const s = scene({ pane3: PANE_ANSWERED });
  const good = require("crypto").createHash("sha256").update(PROMPT_BLOCK_TEXT).digest("hex");
  const r = run(["answer", s.name, "--option", "1", "--expect-prompt-hash", good, "--verify-secs", "2"]);
  const calls = sendPayloads();
  check(r.status === 0 && calls.length === 1 && calls[0] === "1",
    `H1: a matching --expect-prompt-hash answers and verifies (${r.err.trim().split("\n")[0] || ""})`);
  check(!/advisory/.test(r.err), "H2: a present flag never advises");
}

{
  const s = scene({ pane3: PANE_ANSWERED });
  const wrong = require("crypto").createHash("sha256").update("a different prompt").digest("hex");
  const r = run(["answer", s.name, "--option", "1", "--expect-prompt-hash", wrong]);
  const calls = sendPayloads();
  check(r.status === 2 && /prompt changed since it was shown/.test(r.err) && calls.length === 0,
    `H3: a wrong hash refuses exit 2 before the keystroke (${r.err.trim()}; ${calls.length} sends)`);
}

{
  const s = scene({ pane3: PANE_ANSWERED });
  const r = run(["answer", s.name, "--option", "1", "--verify-secs", "2"]);
  check(r.status === 0 && /advisory/.test(r.err),
    `H4: without the flag the answer proceeds with the advisory on stderr (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- usage

{
  const none = run([]);
  check(none.status === 2 && /usage/i.test(none.err + none.out), `U1: no arguments prints usage (${(none.err || none.out).trim().split("\n")[0] || ""})`);
  const bogus = run(["transmit", "x", "y"]);
  check(bogus.status === 2 && /mode|usage/i.test(bogus.err + bogus.out), "U2: an unknown mode refuses");
  const empty = run(["send", "x"]);
  check(empty.status === 2, "U3: sending empty text refuses");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
