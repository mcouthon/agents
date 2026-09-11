#!/usr/bin/env node
/**
 * Register Graphify as a WORKSPACE-FOLDER-scope MCP server in the current repo,
 * and refresh that repo's Graphify index in the same run.
 *
 * Usage:
 *   node /path/to/agents/scripts/configure-graphify-mcp.js [--force]
 *
 * Run it from anywhere inside the target repository. It takes no path argument:
 * the repo root comes from `git rev-parse --show-toplevel`.
 *
 * WHY THIS EXISTS
 * ---------------
 * VS Code spawns a *user-scope* stdio MCP server with `cwd = os.homedir()` --
 * the user-scope collection carries no `workspaceFolder` object, so the spawn
 * expression has nothing to fall back to but `os.homedir()`. Graphify's graph
 * path defaults to `<cwd>/graphify-out/graph.json`, so every argument-free
 * Graphify call from a coding agent session resolved `$HOME/graphify-out/graph.json`
 * and failed. A *workspace-folder-scope* `<repo>/.vscode/mcp.json` is the only
 * scope that carries the workspace folder, which becomes the spawn's cwd -- so
 * the correct graph is reached with no per-call argument and no cooperation
 * from the model.
 *
 * WHAT IT WRITES
 * --------------
 *   <repo>/.vscode/mcp.json  ->  servers.graphifyy = {
 *                                  "type": "stdio",
 *                                  "command": "<absolute graphify-mcp>",
 *                                  "cwd": "${workspaceFolder}"
 *                                }
 *
 * The server id `graphifyy` is load-bearing (the `graphifyy/*` grant,
 * the model-facing `mcp_graphify_*` tool names, and usage telemetry parsing) and
 * is never changed. `command` is absolute because the extension host's PATH is
 * not the terminal's PATH -- which also makes the written file machine-specific,
 * so think before committing it.
 *
 * SAFETY
 * ------
 * - `mcp.json` is JSONC (comments and trailing commas are legal) and VS Code's
 *   own writer re-serialises with `JSON.stringify`, destroying comments. This
 *   tool NEVER round-trips through `JSON.stringify`: it locates the insertion
 *   point with a JSONC token scanner and splices a string. Comments, formatting,
 *   line endings and neighbouring servers survive byte-for-byte.
 * - Writes are INSERT-ONLY. An existing `graphifyy` entry is never modified or
 *   deleted -- the tool prints both entries and refuses. There is deliberately
 *   no flag that overrides this.
 * - Refuses when the repo root is the home directory, a filesystem root, or not
 *   inside a git repository (matched by directory identity, not string compare).
 * - The index build command is read ONLY from the user-global
 *   `~/.agents/config.json` (`$AGENTS_CONFIG_PATH` honoured), never from the
 *   target repo, so opening an untrusted repo cannot inject a command.
 *
 * Only flag: `--force`, which forces the index rebuild. It never overrides a
 * config refusal.
 *
 * REVERT
 * ------
 * The tool says which of the two it did:
 *   "created .vscode/mcp.json"                -> rm .vscode/mcp.json
 *                                                (and rmdir .vscode if it says
 *                                                 it created that too)
 *   "added servers.graphifyy to ..."          -> delete that one entry; a
 *                                                .backup of the pre-splice file
 *                                                sits beside it
 *
 * Exit codes:
 *   0 - Something changed (file written and/or index rebuilt)
 *   1 - Nothing to do (already configured, index already fresh). NOT a failure;
 *       a `set -e` caller must tolerate it.
 *   2 - Refused or errored; nothing was written and no build was run
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const SERVER_ID = "graphifyy";
const GRAPHIFY_COMMAND_NAME = "graphify-mcp";
const WORKSPACE_FOLDER_VAR = "${workspaceFolder}";
const DEFAULT_BUILD_TIMEOUT_MS = 180000;

// Mirrors scripts/state-server.js DEFAULT_CODE_EXTENSIONS -- used only when the
// config omits `code_extensions`.
const DEFAULT_CODE_EXTENSIONS = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".scala", ".sh",
];

// User-scope mcp.json locations checked READ-ONLY for a duplicate `graphifyy`.
const USER_SCOPE_MCP_PATHS = [
  path.join("Library", "Application Support", "Code", "User", "mcp.json"),
  path.join(".config", "Code", "User", "mcp.json"),
];

// ---------------------------------------------------------------------------
// Failure helper
// ---------------------------------------------------------------------------

/** Print to stderr and exit 2. Nothing has been written when this is called. */
function refuse(message) {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Repo root and guards
// ---------------------------------------------------------------------------

/**
 * True when `a` and `b` are the SAME directory on disk -- by identity
 * (`dev` + `ino`), never string equality, so a case-differing or symlinked
 * alias on a case-insensitive filesystem still matches. A stat failure counts
 * as "no match" and never throws.
 */
function sameDirectory(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Resolve the repository root containing `process.cwd()`.
 *
 * In a `git worktree` this deliberately yields the WORKTREE root, not the main
 * worktree: VS Code opens the worktree, so `${workspaceFolder}` *is* the
 * worktree root and that is where its `.vscode/mcp.json` belongs.
 * @returns {string} Absolute repo root
 */
function resolveRepoRoot() {
  let out;
  try {
    out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    refuse(
      `Refusing: ${process.cwd()} is not inside a git repository.\n` +
      "Run this from inside the repository you want to configure."
    );
  }
  const root = out.trim();
  if (!root) {
    refuse(`Refusing: could not determine a repository root from ${process.cwd()}.`);
  }
  return path.resolve(root);
}

/**
 * Refuse for any root that must never receive a `.vscode/mcp.json` or a build:
 * the home directory or a filesystem root. Checked BEFORE repo membership,
 * because a dotfiles `$HOME` is itself a git repo and would otherwise pass.
 */
function assertSafeRoot(root) {
  if (sameDirectory(root, os.homedir())) {
    refuse(
      `Refusing: ${root} is the home directory.\n` +
      "A .vscode/mcp.json there would be spawned for every window and index nothing useful."
    );
  }
  if (sameDirectory(root, path.parse(root).root)) {
    refuse(`Refusing: ${root} is a filesystem root.`);
  }
}

// ---------------------------------------------------------------------------
// graphify-mcp resolution
// ---------------------------------------------------------------------------

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to `graphify-mcp`: PATH first, then ~/.local/bin. Absolute
 * because the extension host's PATH is not the terminal's PATH.
 * @returns {string}
 */
function resolveGraphifyCommand() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, GRAPHIFY_COMMAND_NAME);
    if (isExecutableFile(candidate)) return path.resolve(candidate);
  }
  const fallback = path.join(os.homedir(), ".local", "bin", GRAPHIFY_COMMAND_NAME);
  if (isExecutableFile(fallback)) return fallback;
  return refuse(
    `Refusing: could not find an executable "${GRAPHIFY_COMMAND_NAME}" on PATH or at ${fallback}.\n` +
    "Install graphify (e.g. `uv tool install graphifyy`) and re-run."
  );
}

// ---------------------------------------------------------------------------
// JSONC scanning
//
// A token scanner, not a value parser. It exists so the `servers` key is
// located by PARSED POSITION rather than by `indexOf('"servers"')`, which a
// decoy `"servers"` inside a comment or a string value would fool. Comments are
// skipped (never emitted), so a decoy inside one cannot be mistaken for
// structure; string tokens carry their decoded value, so only a string that is
// actually in key position at depth 1 counts.
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
    while (i < n && !'{}[]:,"'.includes(text[i]) && !/\s/.test(text[i]) && !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) {
      i += 1;
    }
    if (i === start) i += 1; // never stall
    tokens.push({ type: "literal", start, end: i });
  }

  return { tokens };
}

/**
 * Locate the root object and, inside it, the top-level `servers` member --
 * by token position, so comments and nested objects cannot mislead it.
 * @param {Token[]} tokens
 * @returns {{ok: false, error: string} | {ok: true, rootOpen: Token, rootClose: Token, serversOpen: Token|null, serversClose: Token|null, serversKey: Token|null, rootFirstMember: Token|null, serversFirstMember: Token|null}}
 */
function locateServers(tokens) {
  if (tokens.length === 0) return { ok: false, error: "file contains no JSON" };
  if (tokens[0].type !== "{") return { ok: false, error: "top level is not a JSON object" };

  const rootOpen = tokens[0];
  let rootClose = null;
  let serversKey = null;
  let serversOpen = null;
  let serversClose = null;
  let rootFirstMember = null;
  let serversFirstMember = null;

  let depth = 1;
  for (let k = 1; k < tokens.length; k += 1) {
    const tok = tokens[k];

    if (depth === 1 && rootFirstMember === null && tok.type !== "}") {
      rootFirstMember = tok;
    }

    if (tok.type === "{" || tok.type === "[") {
      depth += 1;
      continue;
    }
    if (tok.type === "}" || tok.type === "]") {
      depth -= 1;
      if (depth === 0) {
        rootClose = tok;
        break;
      }
      if (serversOpen !== null && serversClose === null && depth === 1 && tok.type === "}") {
        serversClose = tok;
      }
      continue;
    }

    // A top-level key: a string at depth 1 followed by `:`.
    if (
      depth === 1 &&
      tok.type === "string" &&
      tokens[k + 1] &&
      tokens[k + 1].type === ":" &&
      tok.value === "servers" &&
      serversKey === null
    ) {
      const valueToken = tokens[k + 2];
      if (!valueToken || valueToken.type !== "{") {
        return { ok: false, error: '"servers" exists but its value is not an object' };
      }
      serversKey = tok;
      serversOpen = valueToken;
      serversFirstMember =
        tokens[k + 3] && tokens[k + 3].type !== "}" ? tokens[k + 3] : null;
    }
  }

  if (rootClose === null) return { ok: false, error: "unbalanced braces: no closing } for the root object" };
  if (serversOpen !== null && serversClose === null) {
    return { ok: false, error: 'unbalanced braces inside "servers"' };
  }

  return {
    ok: true,
    rootOpen,
    rootClose,
    serversKey,
    serversOpen,
    serversClose,
    rootFirstMember,
    serversFirstMember,
  };
}

/**
 * Rebuild the text as strict JSON (comments dropped, trailing commas dropped)
 * so it can be `JSON.parse`d. ADVISORY ONLY -- used to tell "already correct"
 * from "differs". It is never written anywhere.
 * @param {string} text
 * @param {Token[]} tokens
 * @returns {string}
 */
function tokensToStrictJson(text, tokens) {
  const parts = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    const next = tokens[k + 1];
    if (tok.type === "," && next && (next.type === "}" || next.type === "]")) continue;
    parts.push(text.slice(tok.start, tok.end));
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** CRLF when the file's first line ending is CRLF, else LF. */
function detectEol(text) {
  const nl = text.indexOf("\n");
  if (nl > 0 && text[nl - 1] === "\r") return "\r\n";
  return "\n";
}

/**
 * The file's indentation unit, taken from its first indented line. Defaults to
 * a tab, which is what VS Code's own `mcp.json` writer emits.
 */
function detectIndentUnit(text) {
  const match = text.match(/^([ \t]+)\S/m);
  if (!match) return "\t";
  return match[1];
}

/** Leading whitespace of the line containing `offset`. */
function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : "";
}

/**
 * The `"graphifyy": { ... }` member, rendered at `indent`, without a trailing
 * comma or newline.
 */
function renderEntry(indent, unit, eol, command) {
  const inner = indent + unit;
  return [
    `${indent}"${SERVER_ID}": {`,
    `${inner}"type": "stdio",`,
    `${inner}"command": ${JSON.stringify(command)},`,
    `${inner}"cwd": "${WORKSPACE_FOLDER_VAR}"`,
    `${indent}}`,
  ].join(eol);
}

/** The whole `"servers": { "graphifyy": {...} }` member, rendered at `indent`. */
function renderServersBlock(indent, unit, eol, command) {
  return [
    `${indent}"servers": {`,
    renderEntry(indent + unit, unit, eol, command),
    `${indent}}`,
  ].join(eol);
}

/** A complete new `mcp.json`, tab-indented like VS Code's own writer. */
function renderNewFile(command) {
  const eol = "\n";
  return ["{", renderServersBlock("\t", "\t", eol, command), "}", ""].join(eol);
}

// ---------------------------------------------------------------------------
// The splice
// ---------------------------------------------------------------------------

/**
 * Insert the `graphifyy` entry into existing JSONC text WITHOUT re-serialising.
 * Insert-only: the sole text ever removed is a whitespace-only run between an
 * empty object's braces, and only after checking that it really is whitespace.
 *
 * Insertion is always at the HEAD of the target object (right after its opening
 * `{`), never before its closing `}`. That is deliberate: a comma appended
 * before the closing brace would land inside any trailing `// comment` on the
 * preceding line and corrupt the file.
 *
 * @param {string} text
 * @param {object} loc - Result of locateServers
 * @param {string} command
 * @returns {{content: string, where: "servers"|"root"}}
 */
function spliceEntry(text, loc, command) {
  const eol = detectEol(text);
  const unit = detectIndentUnit(text);

  if (loc.serversOpen) {
    const keyIndent = lineIndentAt(text, loc.serversKey.start);
    const memberIndent = keyIndent + unit;
    const entry = renderEntry(memberIndent, unit, eol, command);
    const gap = text.slice(loc.serversOpen.end, loc.serversClose.start);

    if (loc.serversFirstMember === null && /^\s*$/.test(gap)) {
      // Empty `"servers": {}` -- replace the whitespace-only gap so the result
      // is not left with two closing indents.
      return {
        content:
          text.slice(0, loc.serversOpen.end) +
          eol + entry + eol + keyIndent +
          text.slice(loc.serversClose.start),
        where: "servers",
      };
    }

    return {
      content:
        text.slice(0, loc.serversOpen.end) +
        eol + entry + "," +
        text.slice(loc.serversOpen.end),
      where: "servers",
    };
  }

  // No `servers` key at all -- splice the whole member in at the head of root.
  const rootIndent = lineIndentAt(text, loc.rootOpen.start);
  const block = renderServersBlock(rootIndent + unit, unit, eol, command);
  const gap = text.slice(loc.rootOpen.end, loc.rootClose.start);

  if (loc.rootFirstMember === null && /^\s*$/.test(gap)) {
    return {
      content:
        text.slice(0, loc.rootOpen.end) +
        eol + block + eol + rootIndent +
        text.slice(loc.rootClose.start),
      where: "root",
    };
  }

  return {
    content:
      text.slice(0, loc.rootOpen.end) +
      eol + block + "," +
      text.slice(loc.rootOpen.end),
    where: "root",
  };
}

// ---------------------------------------------------------------------------
// Index refresh (mirrors scripts/state-server.js code_index_build)
// ---------------------------------------------------------------------------

function agentsConfigPath() {
  return process.env.AGENTS_CONFIG_PATH || path.join(os.homedir(), ".agents", "config.json");
}

/**
 * The `code_index` section of the user-global AGENTS config, or null when the
 * file is missing/unreadable/malformed or has no such section. Never throws.
 *
 * SECURITY: read ONLY from this user-global, trusted file -- never from the
 * target repo -- so an untrusted repo cannot inject a build command by being
 * opened.
 */
function loadCodeIndexConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentsConfigPath(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.code_index && typeof parsed.code_index === "object") {
      return parsed.code_index;
    }
  } catch {
    return null;
  }
  return null;
}

function codeIndexConfigured(config) {
  return Boolean(
    config &&
    typeof config.graph_file === "string" && config.graph_file &&
    typeof config.build === "string" && config.build
  );
}

/**
 * "missing" | "stale" | "fresh" for the repo's index, by comparing the graph
 * file's mtime against the newest tracked code file. Non-repo counts as fresh.
 */
function computeCodeIndexStatus(root, config) {
  const graphFile = path.resolve(root, config.graph_file);
  if (!fs.existsSync(graphFile)) {
    return { status: "missing", reason: `${config.graph_file} not found` };
  }
  const graphMtimeMs = fs.statSync(graphFile).mtimeMs;

  const extensions = Array.isArray(config.code_extensions) && config.code_extensions.length > 0
    ? config.code_extensions
    : DEFAULT_CODE_EXTENSIONS;

  let trackedFiles;
  try {
    const out = execFileSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackedFiles = out.split("\n").filter(Boolean);
  } catch {
    return { status: "fresh", reason: "no git repository found; nothing to compare" };
  }

  const graphFileRel = path.relative(root, graphFile);
  const graphDirRel = path.dirname(graphFileRel);

  for (const rel of trackedFiles) {
    if (rel === graphFileRel) continue;
    if (graphDirRel !== "." && (rel === graphDirRel || rel.startsWith(graphDirRel + "/"))) continue;
    if (!extensions.some((ext) => rel.endsWith(ext))) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.resolve(root, rel)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > graphMtimeMs) {
      return { status: "stale", reason: `${rel} newer than ${config.graph_file}` };
    }
  }
  return { status: "fresh", reason: `no tracked code file newer than ${config.graph_file}` };
}

/**
 * Refresh the repo's index, staleness-guarded unless `force`.
 * @returns {{built: boolean, message: string}}
 */
function refreshIndex(root, force) {
  const config = loadCodeIndexConfig();
  if (!codeIndexConfigured(config)) {
    return {
      built: false,
      message: `index: not_configured (no code_index.build / code_index.graph_file in ${agentsConfigPath()})`,
    };
  }

  if (!force) {
    const { status, reason } = computeCodeIndexStatus(root, config);
    if (status === "fresh") {
      return { built: false, message: `index: skipped (fresh) -- ${reason}` };
    }
  }

  const timeoutMs = Number.isFinite(config.timeout_ms) && config.timeout_ms > 0
    ? config.timeout_ms
    : DEFAULT_BUILD_TIMEOUT_MS;
  const start = Date.now();
  try {
    // execSync (not execFileSync) is intentional: `build` is a free-form,
    // user-authored shell string that may contain `&&` and quoting. Safe
    // specifically because it comes only from the trusted user-global config.
    execSync(config.build, {
      cwd: root,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    const stderrTail = (err.stderr ? err.stderr.toString() : "")
      .split("\n").filter(Boolean).slice(-5).join("\n");
    return {
      built: false,
      message:
        `index: build FAILED after ${elapsedS}s -- \`${config.build}\`\n` +
        (stderrTail ? `${stderrTail}\n` : "") +
        "The config file above is correct and safe to re-run against.",
    };
  }
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
  return { built: true, message: `index: rebuilt in ${elapsedS}s -- \`${config.build}\`` };
}

// ---------------------------------------------------------------------------
// Duplicate-scope warning (read-only)
// ---------------------------------------------------------------------------

/**
 * Warn when a user-scope `mcp.json` also declares `graphifyy`: both servers
 * spawn (collection ids differ, so the same name is not an override), and the
 * model then sees two near-identical toolsets, one of them rooted at $HOME.
 * Never edits the file. Does not affect the exit code.
 * @returns {string[]} Lines to print
 */
function duplicateScopeWarnings() {
  const lines = [];
  for (const rel of USER_SCOPE_MCP_PATHS) {
    const candidate = path.join(os.homedir(), rel);
    let text;
    try {
      text = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(`"${SERVER_ID}"`)) continue;
    lines.push(
      `WARNING: ${candidate} also declares a "${SERVER_ID}" server at USER scope.`,
      "  Both will spawn -- the same id at two scopes is not an override -- and the model",
      "  will see two near-identical toolsets (mcp_graphify_* and mcp_graphify2_*), one of",
      "  them resolving its graph under $HOME.",
      `  Remedy: remove the "${SERVER_ID}" entry from that file, leaving its other servers`,
      "  untouched, then restart the server. This tool never edits it."
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length > 0) {
    refuse(`Unknown argument(s): ${unknown.join(" ")}\nUsage: configure-graphify-mcp.js [--force]`);
  }

  // 1. Repo root + guards, before anything is written.
  const root = resolveRepoRoot();
  assertSafeRoot(root);

  const command = resolveGraphifyCommand();
  const expectedEntry = {
    type: "stdio",
    command,
    cwd: WORKSPACE_FOLDER_VAR,
  };

  const vscodeDir = path.join(root, ".vscode");
  const mcpPath = path.join(vscodeDir, "mcp.json");

  console.log(`repo: ${root}`);

  // 2. Create or splice.
  let fileChanged = false;
  let createdVscodeDir = false;

  if (!fs.existsSync(mcpPath)) {
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
      createdVscodeDir = true;
    }
    fs.writeFileSync(mcpPath, renderNewFile(command));
    fileChanged = true;
    console.log(`created .vscode/mcp.json with servers.${SERVER_ID}`);
    if (createdVscodeDir) console.log("created .vscode/ (it did not exist)");
  } else {
    const original = fs.readFileSync(mcpPath, "utf8");
    const scanned = scanJsonc(original);

    if (original.includes(`"${SERVER_ID}"`)) {
      // Never modify an existing entry -- the one irreversible mistake here.
      if (scanned.error) {
        refuse(
          `Refusing: .vscode/mcp.json mentions "${SERVER_ID}" but does not scan as JSONC ` +
          `(${scanned.error}), so the existing entry cannot be compared.\n` +
          `Expected entry:\n${JSON.stringify({ [SERVER_ID]: expectedEntry }, null, 2)}\n` +
          "Reconcile by hand; nothing was written."
        );
      }
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(tokensToStrictJson(original, scanned.tokens));
      } catch (err) {
        parseError = err.message;
      }
      const existing =
        parsed && parsed.servers && typeof parsed.servers === "object"
          ? parsed.servers[SERVER_ID]
          : undefined;

      if (parseError) {
        refuse(
          `Refusing: .vscode/mcp.json mentions "${SERVER_ID}" but does not parse ` +
          `(${parseError}), so the existing entry cannot be compared.\n` +
          `Expected entry:\n${JSON.stringify({ [SERVER_ID]: expectedEntry }, null, 2)}\n` +
          "Reconcile by hand; nothing was written."
        );
      }
      if (existing === undefined) {
        refuse(
          `Refusing: .vscode/mcp.json mentions "${SERVER_ID}" but has no servers.${SERVER_ID} ` +
          "entry -- it is in a comment or somewhere else in the file.\n" +
          `Expected entry:\n${JSON.stringify({ [SERVER_ID]: expectedEntry }, null, 2)}\n` +
          "Reconcile by hand; nothing was written."
        );
      }
      if (!deepEqual(existing, expectedEntry)) {
        console.error(
          `Refusing: servers.${SERVER_ID} already exists and differs. An existing entry is never modified.\n` +
          `Existing:\n${JSON.stringify(existing, null, 2)}\n` +
          `Expected:\n${JSON.stringify(expectedEntry, null, 2)}\n` +
          "Reconcile by hand; nothing was written and no build was run."
        );
        process.exit(2);
      }
      console.log(`.vscode/mcp.json already has a matching servers.${SERVER_ID} -- no write`);
    } else {
      if (scanned.error) {
        refuse(
          `Refusing: .vscode/mcp.json does not scan as JSONC (${scanned.error}).\n` +
          `Paste this into its "servers" object by hand:\n` +
          `${JSON.stringify({ [SERVER_ID]: expectedEntry }, null, 2)}\n` +
          "Nothing was written."
        );
      }
      const loc = locateServers(scanned.tokens);
      if (!loc.ok) {
        refuse(
          `Refusing: .vscode/mcp.json is not usable (${loc.error}).\n` +
          `Paste this into its "servers" object by hand:\n` +
          `${JSON.stringify({ [SERVER_ID]: expectedEntry }, null, 2)}\n` +
          "Nothing was written."
        );
      }

      const { content, where } = spliceEntry(original, loc, command);

      const backupPath = mcpPath + ".backup";
      try {
        fs.copyFileSync(mcpPath, backupPath);
        console.log(`backup: ${backupPath}`);
      } catch (err) {
        console.error(`Warning: failed to create backup: ${err.message}`);
      }
      fs.writeFileSync(mcpPath, content);
      fileChanged = true;
      console.log(
        where === "servers"
          ? `added servers.${SERVER_ID} to .vscode/mcp.json (existing entries, comments and formatting preserved)`
          : `added a "servers" object with ${SERVER_ID} to .vscode/mcp.json (existing keys, comments and formatting preserved)`
      );
    }
  }

  // 3. Index refresh -- after the write, so a failed build still leaves a
  //    correct config behind and the tool is safe to re-run.
  const index = refreshIndex(root, force);
  console.log(index.message);

  // 4. Notes.
  console.log(
    "note: the entry's `command` is an absolute, machine-specific path, so committing " +
    ".vscode/mcp.json only helps teammates with the same graphify install location. " +
    "This tool does not touch .gitignore -- that is your repo's decision."
  );
  if (fileChanged) {
    console.log(
      createdVscodeDir
        ? "revert: rm .vscode/mcp.json && rmdir .vscode"
        : fs.existsSync(mcpPath + ".backup")
          ? `revert: delete the servers.${SERVER_ID} entry, or restore ${mcpPath}.backup`
          : "revert: rm .vscode/mcp.json"
    );
  }
  for (const line of duplicateScopeWarnings()) console.error(line);

  process.exit(fileChanged || index.built ? 0 : 1);
}

main();
