"use strict";

// Pane reads, the one shared read path for zmx panes: the vt tail as
// `zmx history <name> --vt` serves it, the escape stripper, and the
// input-box and permission-prompt heuristics every pane reader leans on
// (the typed-draft test, the marker set). Nothing here sends; a failed
// read throws fail-shaped (exitCode 2, code zmx_history_failed) — the
// caller owns the exit, exactly like scripts/lib/start.js's failures.

const { execFileSync } = require("child_process");

// The permission-prompt markers, centralized because the strings drift
// across TUI versions. The reference set is the two-week-proven one from
// 129-watch.py; a pane tail matches a prompt when any of these appears.
const PROMPT_MARKERS = ["Do you want to proceed?", "needs your confirmation"];

const PANE_TAIL_LINES = 30;
const ZMX_TIMEOUT_MS = 10000;

// The input box renders its glyph at column 0; the permission prompt's
// option cursor is an indented glyph, so indentation tells them apart.
const INPUT_LINE_RE = /^[❯>]/;
// An offered option: an indented line of optional cursor, then a digit and . or ).
const OPTION_LINE_RE = /^\s*(❯\s*)?\d[.)]/;

// The escape stripper's grammar, in match order: CSI (parameter bytes may
// carry >-prefixes, e.g. \x1b[>4;2m), OSC (BEL- or ST-terminated), then any
// other escape (\x1b(B, \x1b\\). A stripped vt dump equals the plain history.
const ESCAPE_RE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[@-~]/g;

function stripEscapes(text) {
  return String(text).replace(ESCAPE_RE, "");
}

// The pane tail as `zmx history <name> --vt` serves it, escapes intact: the
// one read. Plain lines are derived by stripping; the input box's dim
// attribute — the suggestion's marker — survives only in the raw form.
function paneVtLines(session) {
  let out;
  try {
    out = execFileSync("zmx", ["history", session, "--vt"], {
      encoding: "utf8", timeout: ZMX_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const why = err.stderr ? String(err.stderr).trim() : err.message;
    const failed = new Error(`zmx history failed for ${session}: ${why}`);
    failed.exitCode = 2; // fail-shaped, like start.js fail(): the caller owns the exit
    failed.code = "zmx_history_failed";
    throw failed;
  }
  const lines = out.split("\n");
  return lines.slice(Math.max(0, lines.length - PANE_TAIL_LINES));
}

function paneLines(session) {
  return paneVtLines(session).map(stripEscapes);
}

function promptPresent(lines) {
  const text = lines.join("\n");
  return PROMPT_MARKERS.some((m) => text.includes(m));
}

// A public SGR (params then m); a >-prefixed CSI is not one.
const SGR_SEQ_RE = /^\x1b\[([0-9;:]*)m/;
const ANY_SEQ_RE = /^\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|^\x1b[ -/]*[@-~]/;

// The dim attribute after an SGR param list: 2 sets it, 0 and 22 clear it,
// and 38/48 extended colors consume their subparams (a color index is never
// the dim attribute). An empty param is a 0 (reset).
function sgrDimAfter(params, dim) {
  if (params === "") return false;
  const parts = params.split(";");
  let out = dim;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p === "38" || p === "48") {
      const mode = parts[k + 1];
      if (mode === "5") k += 2;
      else if (mode === "2") k += 4;
    } else if (p === "" || p === "0" || p === "22") out = false;
    else if (p === "2") out = true;
  }
  return out;
}

// The input line: the LAST raw vt line whose first character (column 0) is
// the input glyph — echoed user lines start with an escape, so only the live
// box matches. The box is empty when everything after the glyph is
// whitespace or text entirely inside dim runs (the grey suggestion); typed
// text renders non-dim and refuses.
function inputLineOf(vtLines) {
  let found = null;
  for (const line of vtLines) if (INPUT_LINE_RE.test(line)) found = line;
  if (found === null) return null;
  return { line: found, empty: inputBoxEmpty(found) };
}

function inputBoxEmpty(rawLine) {
  const body = rawLine.slice(1); // past the glyph
  let dim = false;
  let plain = "";
  for (let i = 0; i < body.length;) {
    if (body[i] !== "\x1b") {
      if (!dim) plain += body[i];
      i++;
      continue;
    }
    const rest = body.slice(i);
    const sgr = SGR_SEQ_RE.exec(rest);
    if (sgr) {
      dim = sgrDimAfter(sgr[1], dim);
      i += sgr[0].length;
      continue;
    }
    const other = ANY_SEQ_RE.exec(rest);
    i += other ? other[0].length : 1; // a lone trailing ESC leaves nothing plain
  }
  return plain.trim() === "";
}

// The prompt block: the LAST line carrying a marker plus the consecutive
// blank or option lines after it. The status bar below never enters the
// block, so its churn does not read as a changed prompt.
function promptBlockOf(lines) {
  const text = lines.join("\n");
  let markerIdx = -1;
  let marker = null;
  for (const m of PROMPT_MARKERS) {
    const idx = lines.findIndex((l) => l.includes(m));
    if (idx >= 0) { markerIdx = idx; marker = m; }
  }
  if (markerIdx < 0) return null;
  const block = [lines[markerIdx]];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || OPTION_LINE_RE.test(line)) block.push(line);
    else break;
  }
  return { marker, text: block.join("\n") };
}

module.exports = {
  PROMPT_MARKERS, PANE_TAIL_LINES, ZMX_TIMEOUT_MS,
  stripEscapes, paneVtLines, paneLines, promptPresent,
  sgrDimAfter, inputLineOf, inputBoxEmpty, promptBlockOf,
};
