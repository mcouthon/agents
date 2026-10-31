"use strict";

// Derived facts that read only files: which plan file a phase has, and the hash
// of the plan body. Checked, skipped, landing and the slow git facts join in
// later commits; nothing here writes.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * A phase's plan files: the files in a plan/ folder whose name is
 * `phase-<id>` with an optional `-slug` (lowercase letters, digits and dashes)
 * before `.md`. The slug class has no dot, so suffixed siblings such as
 * `phase-32-m1.rewritten-by-builder-1606.md` never match, and `phase-1-x.md`
 * never matches phase 10.
 */
function planFileRe(phaseId) {
  return new RegExp(`^phase-${phaseId}(-[a-z0-9][a-z0-9-]*)?\\.md$`);
}

/**
 * Every matching file in `dirs`, newest first, deduplicated by resolved path
 * (the same folder listed twice counts once).
 * @returns {{file: string, mtimeMs: number}[]}
 */
function planCandidates(dirs, phaseId) {
  const re = planFileRe(phaseId);
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!re.test(name)) continue;
      const file = path.join(dir, name);
      const key = path.resolve(file);
      if (seen.has(key)) continue;
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      seen.add(key);
      out.push({ file, mtimeMs });
    }
  }
  out.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.file < b.file ? -1 : 1));
  return out;
}

/**
 * The plan file of a phase: the newest match when there is one, and how many
 * matched (more than one is a warning for `advise`).
 * @returns {{file: string|null, count: number}}
 */
function planFileFor(dirs, phaseId) {
  const matches = planCandidates(dirs, phaseId);
  if (matches.length === 0) return { file: null, count: 0 };
  const newest = matches[matches.length - 1];
  return { file: newest.file, count: matches.length };
}

/**
 * The plan body: the file's text above its first appended section
 * (`## Verification Evidence`, `## Execution Notes` or `## Plan Review`),
 * with every checkbox read as unchecked and trailing whitespace trimmed, so
 * the evidence a Builder appends and the ticks it sets never change it.
 */
function planBody(text) {
  const lines = String(text).split("\n");
  const cut = lines.findIndex((l) => /^## (Verification Evidence|Execution Notes|Plan Review)\b/.test(l));
  const body = cut === -1 ? lines : lines.slice(0, cut);
  return body
    .map((l) => l.replace(/^(\s*[-*] )\[([xX])\]/, "$1[ ]").replace(/\s+$/, ""))
    .join("\n");
}

/** The SHA-256 of a plan file's body; the one value an approval is bound to. */
function planHash(text) {
  return crypto.createHash("sha256").update(planBody(text)).digest("hex");
}

module.exports = { planFileRe, planCandidates, planFileFor, planBody, planHash };
