#!/usr/bin/env node
/**
 * Configure VS Code settings.json for agent/instruction file locations.
 *
 * Usage:
 *   node scripts/configure-vscode-settings.js [settings.json path]
 *
 * Features:
 * - Adds missing settings, corrects wrong values
 * - Preserves comments and formatting: settings.json is JSONC, so the file is
 *   never round-tripped through JSON.stringify. Keys are located with a JSONC
 *   token scanner (never `indexOf('"key"')`, which a commented-out decoy key
 *   fools) and new members are spliced in at the HEAD of the target object
 *   (never before its closing `}`, where the separating comma would land inside
 *   a trailing `// comment` and corrupt the file).
 * - Idempotent (safe to run multiple times)
 * - Creates backup before modifying
 *
 * Exit codes:
 *   0 - Settings updated
 *   1 - Already configured (no changes needed)
 *   2 - Error
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Settings to configure
const SETTINGS = [
  // Object-type settings (add entry to existing object)
  {
    type: "object",
    key: "chat.agentSkillsLocations",
    entry: "~/.copilot/skills",
    value: "true",
  },
  {
    type: "object",
    key: "chat.agentSkillsLocations",
    entry: "~/.claude/skills",
    value: "false",
  },
  {
    type: "object",
    key: "chat.agentFilesLocations",
    entry: "~/.copilot/agents",
    value: "true",
  },
  {
    type: "object",
    key: "chat.agentFilesLocations",
    entry: "~/.claude/agents",
    value: "false",
  },
  {
    type: "object",
    key: "chat.instructionsFilesLocations",
    entry: "~/.copilot/instructions",
    value: "true",
  },
  {
    type: "object",
    key: "chat.instructionsFilesLocations",
    entry: "~/.claude/rules",
    value: "false",
  },
  // Boolean settings
  { type: "boolean", key: "chat.customAgentInSubagent.enabled", value: true },
  {
    type: "boolean",
    key: "chat.experimental.useSkillAdherencePrompt",
    value: true,
  },
];

// ---------------------------------------------------------------------------
// JSONC scanning
//
// Ported from scripts/configure-graphify-mcp.js. A token scanner, not a value
// parser. It exists so a setting is located by PARSED POSITION rather than by
// `indexOf('"key"')`, which a decoy inside a comment or a string value fools:
// a parked, commented-out `"chat.agentFilesLocations": { ... }` block carries
// its own `:` and `{`, so a raw scan splices the new entry INSIDE the comment
// where VS Code never sees it. Comments are skipped (never emitted), so nothing
// inside one is ever mistaken for structure; string tokens carry their decoded
// value, so only a string actually in key position counts as a key.
// ---------------------------------------------------------------------------

/** @typedef {{type: string, start: number, end: number, value?: string}} Token */

/**
 * Scan JSONC into structural tokens with source offsets.
 * @param {string} text
 * @returns {{tokens: Token[]} | {error: string}}
 */
function scanJsonc(text) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // Whitespace, plus a leading BOM treated as whitespace so offsets stay real.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "﻿") {
      i += 1;
      continue;
    }

    // Comments -- skipped, so nothing inside one is ever structure.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return { error: `unterminated block comment at offset ${i}` };
      i = close + 2;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",") {
      tokens.push({ type: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (ch === '"') {
      const start = i;
      let value = "";
      i += 1;
      let closed = false;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          // Keep the escape verbatim: only the decoded key name matters here,
          // and no JSON escape can produce a structural character by accident.
          value += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === "\n") return { error: `unterminated string at offset ${start}` };
        value += c;
        i += 1;
      }
      if (!closed) return { error: `unterminated string at offset ${start}` };
      tokens.push({ type: "string", start, end: i, value });
      continue;
    }

    // Numbers, true/false/null, and anything else non-structural: consume the
    // run up to the next delimiter. Validity is not this scanner's job.
    const start = i;
    while (
      i < n &&
      !'{}[]:,"'.includes(text[i]) &&
      !/\s/.test(text[i]) &&
      !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
    ) {
      i += 1;
    }
    if (i === start) i += 1; // never stall
    tokens.push({ type: "literal", start, end: i });
  }

  return { tokens };
}

/**
 * Index of the `}`/`]` closing the container that opens at `openIdx`.
 * @returns {number} -1 when the braces are unbalanced
 */
function findMatchingClose(tokens, openIdx) {
  let depth = 0;
  for (let k = openIdx; k < tokens.length; k += 1) {
    const type = tokens[k].type;
    if (type === "{" || type === "[") {
      depth += 1;
    } else if (type === "}" || type === "]") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Direct members of the object spanning `openIdx`..`closeIdx`: a string token
 * followed by `:` at the object's own depth. Nested objects and anything inside
 * a comment are excluded by construction. First occurrence wins, matching the
 * `indexOf` behaviour this replaces.
 * @returns {Map<string, {keyIdx: number, valueIdx: number}>}
 */
function objectMembers(tokens, openIdx, closeIdx) {
  const members = new Map();
  let depth = 0;
  for (let k = openIdx; k < closeIdx; k += 1) {
    const tok = tokens[k];
    if (tok.type === "{" || tok.type === "[") {
      depth += 1;
      continue;
    }
    if (tok.type === "}" || tok.type === "]") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    if (
      tok.type === "string" &&
      tokens[k + 1] &&
      tokens[k + 1].type === ":" &&
      tokens[k + 2] &&
      !members.has(tok.value)
    ) {
      members.set(tok.value, { keyIdx: k, valueIdx: k + 2 });
    }
  }
  return members;
}

/**
 * Locate the root object and its top-level members by token position.
 * @returns {{ok: false, error: string} | {ok: true, openIdx: number, closeIdx: number, members: Map<string, {keyIdx: number, valueIdx: number}>}}
 */
function locateRoot(tokens) {
  if (tokens.length === 0) return { ok: false, error: "file contains no JSON" };
  if (tokens[0].type !== "{") {
    return { ok: false, error: "top level is not a JSON object" };
  }
  const closeIdx = findMatchingClose(tokens, 0);
  if (closeIdx === -1) {
    return { ok: false, error: "unbalanced braces: no closing } for the root object" };
  }
  return { ok: true, openIdx: 0, closeIdx, members: objectMembers(tokens, 0, closeIdx) };
}

/** The literal text of a token, e.g. `true`. */
function tokenText(content, tok) {
  return content.slice(tok.start, tok.end);
}

/** Replace exactly one token's text -- never a regex match that may sit in a comment. */
function replaceToken(content, tok, text) {
  return content.slice(0, tok.start) + text + content.slice(tok.end);
}

/**
 * Splice `memberText` in at the HEAD of the object opening at `openIdx` --
 * right after its `{`, never before its `}`.
 *
 * Head insertion is the whole point: appending a comma before the closing brace
 * puts that comma inside any trailing `// comment` on the preceding line, which
 * corrupts the file. Inserting after the `{` is comma-safe in every case.
 *
 * @param {string} closeIndent - indentation for the closing brace when the
 *   object is empty and therefore has to be re-laid-out
 */
function insertAtHead(content, tokens, openIdx, closeIdx, memberText, closeIndent) {
  const open = tokens[openIdx];
  const close = tokens[closeIdx];
  const isEmpty = openIdx + 1 === closeIdx;
  const gap = content.slice(open.end, close.start);

  if (isEmpty && /^\s*$/.test(gap)) {
    // Empty object: replace the whitespace-only gap so no stray comma is left.
    return (
      content.slice(0, open.end) +
      `\n${memberText}\n${closeIndent}` +
      content.slice(close.start)
    );
  }
  return (
    content.slice(0, open.end) + `\n${memberText},` + content.slice(open.end)
  );
}

/**
 * Add or update an entry in a settings object in JSONC content.
 * Uses string manipulation to preserve comments and formatting.
 */
function addToSetting(content, settingKey, entryKey, entryValue) {
  const scanned = scanJsonc(content);
  if (scanned.error) {
    return { content, changed: false, error: `Cannot scan settings (${scanned.error})` };
  }
  const tokens = scanned.tokens;
  const root = locateRoot(tokens);
  if (!root.ok) {
    return { content, changed: false, error: root.error };
  }

  const setting = root.members.get(settingKey);

  // Setting exists? Correct or insert into it.
  if (setting) {
    const valueTok = tokens[setting.valueIdx];
    if (valueTok.type !== "{") {
      return { content, changed: false, error: `No { after ${settingKey}` };
    }
    const settingCloseIdx = findMatchingClose(tokens, setting.valueIdx);
    if (settingCloseIdx === -1) {
      return { content, changed: false, error: `No closing } for ${settingKey}` };
    }

    const entry = objectMembers(tokens, setting.valueIdx, settingCloseIdx).get(entryKey);
    if (entry) {
      const entryValueTok = tokens[entry.valueIdx];
      const current = tokenText(content, entryValueTok);
      if (
        entryValueTok.type === "literal" &&
        (current === "true" || current === "false") &&
        current !== entryValue
      ) {
        return {
          content: replaceToken(content, entryValueTok, entryValue),
          changed: true,
          corrected: true,
          oldValue: current,
        };
      }
      return { content, changed: false };
    }

    return {
      content: insertAtHead(
        content,
        tokens,
        setting.valueIdx,
        settingCloseIdx,
        `    "${entryKey}": ${entryValue}`,
        "  ",
      ),
      changed: true,
    };
  }

  // Setting doesn't exist - add it at the head of the root object.
  return {
    content: insertAtHead(
      content,
      tokens,
      root.openIdx,
      root.closeIdx,
      `  "${settingKey}": {\n    "${entryKey}": ${entryValue}\n  }`,
      "",
    ),
    changed: true,
  };
}

/**
 * Add or update a top-level boolean setting in JSONC content.
 */
function addBooleanSetting(content, settingKey, value) {
  const scanned = scanJsonc(content);
  if (scanned.error) {
    return { content, changed: false, error: `Cannot scan settings (${scanned.error})` };
  }
  const tokens = scanned.tokens;
  const root = locateRoot(tokens);
  if (!root.ok) {
    return { content, changed: false, error: root.error };
  }

  const setting = root.members.get(settingKey);
  if (setting) {
    const valueTok = tokens[setting.valueIdx];
    const current = tokenText(content, valueTok);
    if (
      valueTok.type === "literal" &&
      (current === "true" || current === "false") &&
      current !== String(value)
    ) {
      return {
        content: replaceToken(content, valueTok, String(value)),
        changed: true,
        corrected: true,
        oldValue: current,
      };
    }
    return { content, changed: false };
  }

  return {
    content: insertAtHead(
      content,
      tokens,
      root.openIdx,
      root.closeIdx,
      `  "${settingKey}": ${value}`,
      "",
    ),
    changed: true,
  };
}

function main() {
  // Get settings file path
  const defaultPath = path.join(
    os.homedir(),
    "Library/Application Support/Code/User/settings.json",
  );
  const settingsPath = process.argv[2] || defaultPath;

  // Check if file exists
  if (!fs.existsSync(settingsPath)) {
    console.error(`Settings file not found: ${settingsPath}`);
    process.exit(2);
  }

  // Read current content
  let content;
  try {
    content = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    console.error(`Failed to read settings: ${err.message}`);
    process.exit(2);
  }

  // Validate file has JSON/JSONC structure
  if (!content.includes("{") || !content.includes("}")) {
    console.error(
      `Settings file is not valid JSON/JSONC (missing {} structure): ${settingsPath}`,
    );
    process.exit(2);
  }

  // Refuse before writing anything when the file cannot be scanned as JSONC or
  // its root is not an object -- editing it by offset would corrupt it.
  const preScan = scanJsonc(content);
  const preRoot = preScan.error
    ? { ok: false, error: preScan.error }
    : locateRoot(preScan.tokens);
  if (!preRoot.ok) {
    console.error(
      `Settings file is not valid JSON/JSONC (${preScan.error || preRoot.error}): ${settingsPath}`,
    );
    process.exit(2);
  }

  // Apply each setting
  let anyChanged = false;
  for (const setting of SETTINGS) {
    let result;
    if (setting.type === "boolean") {
      result = addBooleanSetting(content, setting.key, setting.value);
      if (result.corrected) {
        console.log(
          `Corrected: ${setting.key} = ${setting.value} (was: ${result.oldValue})`,
        );
      } else if (result.changed) {
        console.log(`Added: ${setting.key} = ${setting.value}`);
      } else {
        console.log(`OK: ${setting.key}`);
      }
    } else {
      result = addToSetting(content, setting.key, setting.entry, setting.value);
      if (result.corrected) {
        console.log(
          `Corrected: ${setting.key} → ${setting.entry} (was: ${result.oldValue})`,
        );
      } else if (result.changed) {
        console.log(`Added: ${setting.key} → ${setting.entry}`);
      } else {
        console.log(`OK: ${setting.entry}`);
      }
    }
    if (result.error) {
      console.error(`Warning: ${result.error}`);
    }
    if (result.changed) {
      content = result.content;
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    console.log("No changes needed.");
    process.exit(1);
  }

  // Create backup
  const backupPath = settingsPath + ".backup";
  try {
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  } catch (err) {
    console.error(`Warning: Failed to create backup: ${err.message}`);
  }

  // Write updated content
  try {
    fs.writeFileSync(settingsPath, content);
    console.log("Settings updated successfully.");
    process.exit(0);
  } catch (err) {
    console.error(`Failed to write settings: ${err.message}`);
    process.exit(2);
  }
}

main();
