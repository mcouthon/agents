#!/usr/bin/env node
"use strict";
// pane-send: the shared send path for zmx panes — chunking, the transcript
// verify poll, every refusal path, and answer's read-send-reread (TOCTOU).
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

const iso = (d) => d.toISOString();
const minutesAgo = (m) => iso(new Date(Date.now() - m * 60000));
const userEntry = (ts, content) => JSON.stringify({ type: "user", timestamp: ts, isSidechain: false, message: { role: "user", content } }) + "\n";
const OLD_ENTRIES = [
  userEntry("2020-01-01T00:00:00.000Z", "x".repeat(600)),
  JSON.stringify({ type: "user", timestamp: "2020-01-01T00:00:01.000Z", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] } }) + "\n",
  userEntry("2099-01-01T00:00:00.000Z", "y".repeat(900)).replace('"isSidechain":false', '"isSidechain":true'),
].join("");

// One fresh world per scene: its own ZMX_DIR, db, sessions root, transcript.
let sceneNo = 0;
function scene(opts = {}) {
  const {
    pane = "prompt", alt2 = null, pane3 = null, register = true, needs = true,
    ended = false, transcriptExists = true,
  } = opts;
  const root = mk(`scene${++sceneNo}`);
  const z = path.join(root, "zmx");
  fs.mkdirSync(z);
  const name = `S${sceneNo}`;
  const transcript = path.join(root, "t.jsonl");
  if (transcriptExists) fs.writeFileSync(transcript, OLD_ENTRIES);
  const panes = { prompt: PANE_PROMPT, rest: PANE_REST, typed: PANE_TYPED, plain: PANE_PLAIN };
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
  if (register) {
    const r = session.register({
      origin: "cli", agent: "conductor", session_id: `sid-${sceneNo}`, terminal_id: `t${sceneNo}`,
      cwd: root, repo_key: "github.com/t/x", task_dir: null,
      transcript_path: transcript, mux: { kind: "zmx", name },
      session_dir: path.join(sessions, `t${sceneNo}`),
    });
    sdir = r.session_dir;
    if (needs) session.recordSignal(sdir, { message: "Do you want to proceed?" });
    if (ended) session.markEnded(sdir);
  }
  return { root, z, name, transcript, sdir, sessions, tasksRoot };
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

// A decide row backing an owner-only word, in the scene's own db.
function decideRow({ quote = "the owner's words", decidedAt } = {}) {
  const repo = { key: "github.com/t/x", main_root: path.join(process.env.ZMX_DIR, "..") };
  const { task_dir } = taskLib.createTask({ repo, title: "Backing", slug: "backing", mode: "fast", tier: "standard", phases: [{ id: 1, name: "P" }], description: "" });
  const row = taskLib.taskRowOf(task_dir);
  return db.insertDecision({ task_id: row.id, phase_id: null, choice: "answer", quote, decided_at: decidedAt || iso(new Date()) });
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
  // needs_input unset, rest pane with an empty input box: the fresh-empty path (a first message).
  const s = scene({ pane: "rest", needs: false });
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
  const id = decideRow({ quote: "ship it" });
  armAppend(flattenText("approve the plan, phase 2"));
  process.env.ZMX_ENTER_AT = "2";
  const r = run(["send", s.name, "approve the plan, phase 2", "--decision-id", String(id), "--chunk-chars", "50", "--pause-secs", "0.05"]);
  check(r.status === 0, `R14: a fresh quoted decide row backs an owner-only word (${r.err.trim().split("\n")[0] || ""})`);
}

// ---------------------------------------------------------------- paste

{
  const s = scene({ pane: "rest", needs: false });
  // The pane starts empty (the precondition read); the sig shows up only on
  // the verify read, as the pasted text sitting in the input box.
  const text = "the first message pasted unsent into the input box";
  const sig = flattenText(text).slice(-20);
  fs.writeFileSync(path.join(process.env.ZMX_DIR, `pane2.${s.name}`), PANE_REST.replace("❯ ", `❯ ${sig}`));
  const r = run(["paste", s.name, text, "--chunk-chars", "30", "--pause-secs", "0.02"]);
  const calls = sendPayloads();
  check(r.status === 0, `P1: paste exits 0 (${r.err.trim().split("\n")[0] || ""})`);
  check(calls.join("") === flattenText(text) && !calls.includes("\r"),
    "P2: paste chunks the text and never sends \\r");
  check(/pane tail shows the final chunk|verified/.test(r.out),
    `P3: the report-only verify names what the pane tail shows (${r.out.trim()})`);
}

{
  const s = scene({ pane: "rest", needs: false });
  const r = run(["paste", s.name, "a draft whose tail the pane will not show", "--chunk-chars", "30", "--pause-secs", "0.02"]);
  check(r.status === 0 && /does not show the final chunk|unverified/.test(r.out),
    `P4: a paste whose sig is missing from the pane still exits 0 with the report (${r.out.trim()})`);
  check(/approve the plan|❯/.test(r.out), "P5: the unverified report prints the pane tail");
}

{
  const s = scene();
  const r = run(["paste", s.name, "/clear it all"]);
  check(r.status === 2 && /\/clear/.test(r.err), `P6: paste refuses /clear like every mode (${r.err.trim()})`);
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
