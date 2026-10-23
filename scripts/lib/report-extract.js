"use strict";

// Pulls the JSON report out of an agent's final message. Pure string work.

/**
 * Extract the report JSON from a message.
 *
 * Accepts, in order: the last ```json fence; if none, the last bare top-level
 * `{…}` object ending the message (the agent may drop the fence). Before
 * parsing, `//` line comments and trailing commas are stripped so a skeleton
 * pasted verbatim — even with the per-key comments left in — parses.
 *
 * For multi-fence messages (e.g. a Courier emitting builder + committer
 * blocks), see `extractJsonCandidates`, which callers use to try
 * each fence against the target schema and pick the one that validates.
 *
 * @param {string} message
 * @returns {{ valid: boolean, report?: object, reason?: string }}
 */
function extractJsonReport(message) {
  const candidates = extractJsonCandidates(message);
  if (candidates.length === 0) {
    return { valid: false, reason: "no JSON code block found in the report" };
  }
  // Last candidate (fences in order, then bare object).
  return candidates[candidates.length - 1];
}

/**
 * Extract every JSON candidate from a message.
 *
 * Returns parsed candidates in document order: each ```json fence (oldest
 * first), then the bare top-level `{…}` object ending the message if no
 * fence produced a candidate. `//` line comments and trailing commas are
 * stripped before parsing so a verbatim skeleton paste parses.
 *
 * Callers walk this list in reverse and use the first
 * candidate that validates against the target schema — so a Courier that
 * emits a builder block and a committer block has the builder block
 * selected even though the committer block is the last fence.
 *
 * @param {string} message
 * @returns {{ valid: boolean, report?: object, reason?: string }[]}
 */
function extractJsonCandidates(message) {
  if (!message || typeof message !== "string") {
    return [{ valid: false, reason: "no message" }];
  }
  const out = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(message)) !== null) {
    const raw = m[1].trim();
    try {
      out.push({ valid: true, report: JSON.parse(cleanJsonText(raw)) });
    } catch (err) {
      out.push({ valid: false, reason: `invalid JSON in report block: ${err.message}` });
    }
  }
  if (out.length === 0) {
    // No fence: try a bare top-level {...} object ending the message.
    const bare = extractBareObject(message);
    if (bare) {
      try {
        out.push({ valid: true, report: JSON.parse(cleanJsonText(bare)) });
      } catch (err) {
        out.push({ valid: false, reason: `invalid JSON in report block: ${err.message}` });
      }
    }
  }
  return out;
}

/**
 * Find the last top-level {...} object that ends the message (trailing
 * whitespace allowed). String- and brace-aware so nested objects and braces
 * inside string values do not fool it. Returns the raw object text or null.
 */
function extractBareObject(message) {
  let last = null;
  for (let i = 0; i < message.length; i++) {
    if (message[i] !== "{") continue;
    const end = matchBraces(message, i);
    if (end < 0) continue;
    if (message.slice(end + 1).trim() === "") {
      last = message.slice(i, end + 1);
    }
  }
  return last;
}

/**
 * Return the index of the '}' matching the '{' at `start`, skipping braces
 * inside double-quoted strings. -1 if unbalanced.
 */
function matchBraces(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip `//` line comments and trailing commas (outside strings) so a
 * skeleton pasted with its per-key comments, or with trailing commas left
 * after editing, still parses as JSON.
 */
function cleanJsonText(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] || ""; i++; }
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // trailing comma
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

module.exports = { extractJsonReport, extractJsonCandidates };
