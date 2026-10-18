"use strict";

/**
 * git/gh command tokeniser for the git-guard hook.
 *
 * Splits a shell command string on `&&`, `;` and `|` (respecting quotes), parses
 * each segment into tokens (respecting single/double quotes and `\` escapes),
 * separates leading `ENV=val` assignments from the program, and reports every
 * `git`/`gh` invocation with its arguments.
 *
 * Env-prefix assignments (`AGENTS_LAND=1 git push …`) are parsed as an
 * assignment, never as a grant — the guard reads its own process env, not the
 * command string, for the landing allow-list (D30).
 */

/**
 * Split a command string into segments on top-level `&&`, `;` and `|`.
 * Operators inside quotes or following a `\` are literal.
 * @param {string} command
 * @returns {string[]} non-empty trimmed segments
 */
function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Tokenise a single segment into argv, respecting quotes and `\` escapes.
 * Leading `ENV=val` assignments are separated into `env`.
 * @param {string} segment
 * @returns {{ env: object, argv: string[] }}
 */
function tokenizeSegment(segment) {
  const tokens = [];
  let env = {};
  let token = "";
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      token += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === "\\") {
      token += ch;
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      token += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      token += ch;
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (hasToken) {
        tokens.push(token);
        token = "";
        hasToken = false;
      }
      continue;
    }
    token += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(token);

  const argv = [];
  let sawProgram = false;
  for (const t of tokens) {
    if (!sawProgram) {
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) {
        env[m[1]] = stripQuotes(m[2]);
        continue;
      }
      sawProgram = true;
    }
    argv.push(t);
  }
  return { env, argv };
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Strip surrounding quotes from a token for matching purposes.
 */
function unquote(token) {
  return stripQuotes(token);
}

/**
 * Find every git/gh invocation in a command string.
 * @param {string} command
 * @returns {{ program: string, argv: string[], env: object, raw: string }[]}
 */
function findGitInvocations(command) {
  const results = [];
  for (const segment of splitSegments(command)) {
    const { env, argv } = tokenizeSegment(segment);
    if (argv.length === 0) continue;
    const program = unquote(argv[0]);
    if (program === "git" || program === "gh") {
      results.push({
        program,
        argv: argv.slice(1).map(unquote),
        env,
        raw: segment,
      });
    }
  }
  return results;
}

/**
 * Classify a git invocation's subcommand and key flags.
 * @param {{ program: string, argv: string[] }} inv
 * @returns {{ subcommand: string|null, hasForce: boolean, hasNoVerify: boolean,
 *            hasDashC: boolean, dashCPath: string|null, pushRemote: string|null,
 *            pushRefSpec: string[] }}
 */
function classifyGit(inv) {
  const argv = inv.argv;
  let hasForce = false;
  let hasNoVerify = false;
  let hasDashC = false;
  let dashCPath = null;
  let pushRemote = null;
  const pushRefSpec = [];

  // Global git options (-C <path>, -c <kv>) precede the subcommand.
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-C") {
      hasDashC = true;
      dashCPath = argv[i + 1] || null;
      i += 2;
      continue;
    }
    if (a === "-c") { i += 2; continue; }
    break;
  }
  const subcommand = i < argv.length ? argv[i] : null;
  const rest = argv.slice(i + 1);

  if (subcommand === "push") {
    for (const a of rest) {
      if (a === "-f" || a === "--force" || a === "--force-with-lease") hasForce = true;
      else if (a === "--no-verify") hasNoVerify = true;
      else if (pushRemote === null && !a.startsWith("-")) pushRemote = a;
      else if (pushRemote !== null && !a.startsWith("-")) pushRefSpec.push(a);
    }
  } else {
    for (const a of rest) {
      if (a === "--no-verify") hasNoVerify = true;
    }
  }
  if (subcommand === "add") {
    for (const a of rest) {
      if (a === "-A" || a === "." || a === "-u") hasForce = true;
    }
  }
  if (subcommand === "commit") {
    for (const a of rest) {
      if (a === "-a" || a === "--all") hasForce = true;
    }
  }
  return { subcommand, hasForce, hasNoVerify, hasDashC, dashCPath, pushRemote, pushRefSpec };
}

module.exports = {
  splitSegments,
  tokenizeSegment,
  findGitInvocations,
  classifyGit,
  unquote,
  stripQuotes,
};
