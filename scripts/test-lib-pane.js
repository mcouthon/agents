#!/usr/bin/env node
"use strict";
// lib/pane: the shared pane-read path — the pure parsers (the escape
// stripper, the SGR dim walk, the input-box and prompt-block heuristics,
// the marker set) and the zmx history read, whose failure throws
// fail-shaped instead of exiting. Isolation: nothing here touches the real
// HOME, db or zmx; the stub zmx serves a private ZMX_DIR and never the
// real daemon.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-lib-pane-")));
  for (const d of ["home", "xdg", "stubbin"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_DB", "AGENTS_TASKS_ROOT",
    "AGENTS_SESSIONS_ROOT", "ZMX_SESSION", "CLAUDE_CODE_SESSION_ID", "ZMX_DIR", "ZMX_HISTORY_FAIL"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");

const pane = require("./lib/pane");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }
const T = process.env.AGENTS_TEST_TMP;
const mk = (label) => { const d = path.join(T, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Stub zmx: `history <name> --vt` serves $ZMX_DIR/pane.<name> and logs its
// argv to $ZMX_DIR/hist.log; ZMX_HISTORY_FAIL fails the read on demand
// (stderr, exit 1) — the throw scene's shape.
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  'Z=${ZMX_DIR:?ZMX_DIR not set}',
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  "  history)",
  '    [ -n "${ZMX_HISTORY_FAIL:-}" ] && { echo "stub zmx: history fails on demand" >&2; exit 1; }',
  '    name=$2',
  '    [ "${3:-}" = "--vt" ] || { echo "stub zmx: history without --vt: $*" >&2; exit 65; }',
  '    echo "$*" >> "$Z/hist.log"',
  '    cat "$Z/pane.$name"',
  "    exit 0 ;;",
  '  *) echo "stub zmx: unsupported: $*" >&2; exit 64 ;;',
  "esac",
  "",
].join("\n"), { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;

// vt fixtures (ported from test-pane-send): the grey suggestion renders
// inside SGR 2 (dim) after a bare glyph and a non-breaking space; typed text
// renders non-dim (an fg 38;5;15 run). Echoed user lines start with ESC, so
// only a bare glyph at column 0 is the live input box.
const VT_SUGGEST_LINE = "❯\xa0\x1b[0m\x1b[2mTry \"how do I log an error?\"\x1b[0m";
const VT_TYPED_LINE = "❯\xa0\x1b[38;5;15mapprove the plan\x1b[0m";
const PANE_VT = (inputLine) => [
  "  \x1b[36m⏺\x1b[0m Reading the plan for phase 2",
  inputLine,
  "  \x1b[2m───────── Conductor ─────────\x1b[0m",
  "\x1b[?25l\x1b[2;1H",
  "",
].join("\n");

// ---------------------------------------------------------------- the exported constants

check(JSON.stringify(pane.PROMPT_MARKERS) === JSON.stringify(["Do you want to proceed?", "needs your confirmation"]),
  "C1: PROMPT_MARKERS is exactly the two reference strings");

// ---------------------------------------------------------------- the escape stripper

check(pane.stripEscapes("a\x1b[>4;2mb") === "ab",
  "E1: a CSI with >-prefixed params strips (zmx's private modes)");
check(pane.stripEscapes("x\x1b]0;title\x07y") === "xy",
  "E2: a BEL-terminated OSC strips");
check(pane.stripEscapes("x\x1b]8;;http://e\x1b\\y") === "xy",
  "E3: an ST-terminated OSC strips (the hyperlink form)");
check(pane.stripEscapes("q\x1b(Bw") === "qw",
  "E4: other escapes strip too (the charset switch)");
check(pane.stripEscapes(PANE_VT(VT_SUGGEST_LINE)) === "  ⏺ Reading the plan for phase 2\n❯\xa0Try \"how do I log an error?\"\n  ───────── Conductor ─────────\n\n",
  "E5: a stripped vt dump equals the plain history — every sequence in the fixture is gone");

// ---------------------------------------------------------------- the SGR dim walk

check(pane.sgrDimAfter("", true) === false,
  "D1: an empty param list is a reset — dim clears");
check(pane.sgrDimAfter("0", true) === false,
  "D2: 0 clears the dim attribute");
check(pane.sgrDimAfter("22", true) === false,
  "D3: 22 clears the dim attribute");
check(pane.sgrDimAfter("2", false) === true,
  "D4: 2 sets the dim attribute — the suggestion's grey");
check(pane.sgrDimAfter("38;5;2", false) === false,
  "D5: a 256-color index never reads as dim — the 2 is the color index, consumed");
check(pane.sgrDimAfter("38;2;1;2;3", false) === false,
  "D6: a truecolor run consumes its four subparams — the interior 2 is not the dim attribute");
check(pane.sgrDimAfter("2;38;5;15", false) === true,
  "D7: dim survives a following color run");

// ---------------------------------------------------------------- the input box

{
  const suggest = pane.inputLineOf(PANE_VT(VT_SUGGEST_LINE).split("\n"));
  check(suggest && suggest.line === VT_SUGGEST_LINE && suggest.empty === true,
    "I1: the dim suggestion after the glyph reads as an empty box — grey text is not a draft");
  const typed = pane.inputLineOf(PANE_VT(VT_TYPED_LINE).split("\n"));
  check(typed && typed.line === VT_TYPED_LINE && typed.empty === false,
    "I2: a typed non-dim run after the glyph reads as a non-empty box — an unsent draft");
}

{
  const vt = [
    "\x1b[38;5;15m❯ an echoed user row\x1b[0m",
    "❯\xa0\x1b[38;5;15mthe older box\x1b[0m",
    "  a plain row in between",
    "❯\xa0\x1b[38;5;15mthe live box\x1b[0m",
  ];
  const r = pane.inputLineOf(vt);
  check(r && r.line === "❯\xa0\x1b[38;5;15mthe live box\x1b[0m",
    "I3: the LAST column-0 glyph line is the input line; an ESC-starting echoed row never matches");
}

{
  const r = pane.inputLineOf(["  ⏺ Reading the plan for phase 2", "\x1b[?25l\x1b[2;1H", "  🤖 Conductor | GLM 5.3"]);
  check(r === null, `I4: a tail with no glyph line at all returns null (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- the prompt heuristics

const PROMPT_LINES = [
  "  ⏺ Reading the plan for phase 2",
  "  Do you want to proceed?",
  "    ❯ 1. Yes",
  "      2. Yes, and don't ask again",
  "      3. No, and tell Claude what to do differently (esc)",
  "  🤖 Conductor | GLM 5.3",
  "",
];

check(pane.promptPresent(PROMPT_LINES) === true,
  "P1: promptPresent is true when a marker sits in the tail");
check(pane.promptPresent(["  needs your confirmation before landing", "  🤖 Conductor | GLM 5.3"]) === true,
  "P2: the second marker lights promptPresent just as well");
check(pane.promptPresent(["  ⏺ Reading the plan for phase 2", "  🤖 Conductor | GLM 5.3", ""]) === false,
  "P3: a tail with no marker is not a prompt");

{
  const b = pane.promptBlockOf(PROMPT_LINES);
  check(b && b.marker === "Do you want to proceed?" && b.text === [
    "  Do you want to proceed?",
    "    ❯ 1. Yes",
    "      2. Yes, and don't ask again",
    "      3. No, and tell Claude what to do differently (esc)",
  ].join("\n"),
    "P4: the block is the marker line plus the consecutive option lines — the status bar below never enters");
}

{
  const b = pane.promptBlockOf(["  needs your confirmation", "", "    ❯ 1. Yes", "  🤖 Conductor | GLM 5.3"]);
  check(b && b.marker === "needs your confirmation" && b.text === "  needs your confirmation\n\n    ❯ 1. Yes",
    "P5: blank lines between the marker and its options stay in the block");
}

{
  const b = pane.promptBlockOf(["  ⏺ Reading the plan for phase 2", "  🤖 Conductor | GLM 5.3", ""]);
  check(b === null, `P6: a tail without a marker has no prompt block (${JSON.stringify(b)})`);
}

// ---------------------------------------------------------------- the zmx history read

{
  // A 40-line pane: the read window is the last 30 lines.
  const name = "tail40";
  const zdir = mk("tail40");
  process.env.ZMX_DIR = zdir;
  const all = [];
  for (let i = 1; i <= 40; i++) all.push("L" + String(i).padStart(2, "0"));
  fs.writeFileSync(path.join(zdir, `pane.${name}`), all.join("\n"));
  const vt = pane.paneVtLines(name);
  check(vt.length === 30 && vt[0] === "L11" && vt[29] === "L40",
    `T1: paneVtLines returns the last 30 lines of a 40-line pane (${vt.length} lines, first ${JSON.stringify(vt[0])}, last ${JSON.stringify(vt[vt.length - 1])})`);
  const log = fs.readFileSync(path.join(zdir, "hist.log"), "utf8").trim();
  check(log === `history ${name} --vt`,
    `T2: the read calls zmx history <name> --vt exactly (log: ${JSON.stringify(log)})`);
}

{
  // A failed read throws fail-shaped — never resolves, never exits the
  // process (this suite surviving the call is the proof).
  const name = "fails";
  const zdir = mk("fails");
  process.env.ZMX_DIR = zdir;
  fs.writeFileSync(path.join(zdir, `pane.${name}`), "irrelevant — the read fails first");
  process.env.ZMX_HISTORY_FAIL = "1";
  let err = null;
  try { pane.paneVtLines(name); } catch (e) { err = e; }
  delete process.env.ZMX_HISTORY_FAIL;
  check(err !== null, `T3: a failed zmx history read throws (${err ? "threw" : "resolved"})`);
  check(err && err.code === "zmx_history_failed" && err.exitCode === 2,
    `T4: the throw is fail-shaped — code zmx_history_failed, exitCode 2, the caller owns the exit`);
  check(err && err.message === "zmx history failed for fails: stub zmx: history fails on demand",
    `T5: the message keeps the bin's refusal text byte-identical (${err ? err.message : "no throw"})`);
}

{
  const name = "plain";
  const zdir = mk("plain");
  process.env.ZMX_DIR = zdir;
  fs.writeFileSync(path.join(zdir, `pane.${name}`), PANE_VT(VT_TYPED_LINE));
  const lines = pane.paneLines(name);
  check(JSON.stringify(lines) === JSON.stringify([
    "  ⏺ Reading the plan for phase 2",
    "❯\xa0approve the plan",
    "  ───────── Conductor ─────────",
    "",
    "",
  ]), `L1: paneLines is the vt tail mapped through the stripper (${JSON.stringify(lines)})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
