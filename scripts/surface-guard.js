#!/usr/bin/env node
"use strict";

// Fails when an emitted string names a hand-edit verb or a `state.json` edit, or when a refusal
// in the engine's own code ships without a remedy. Prints the file:line of every hit.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
let ROOT = REPO;

const BANNED = [
  "a state ", "state_update", "state_add_phases", "state_init", "--phase-status", "--task-status",
  "a checkpoint", "a report", "a run ", "edit task.json", "a task migrate",
  "--choice override", "decide override",
];

const MARKDOWN_ONLY = ["state.json"];

const SKILLS = ["build-phase", "ship", "plan-phase", "session-checkpoint", "phase-review"];

const CODE_SCOPE = [
  { dir: "scripts/lib", ext: /\.js$/ },
  { file: "scripts/bin/a" },
  { file: "scripts/state-server.js" },
];
const MARKDOWN_SCOPE = [
  { dir: "templates", ext: /\.md$/ },
  { dir: "generated/claude", ext: /\.md$/ },
];

const REFUSAL_FILES = [
  { file: "scripts/lib/land.js", args: 3 },
  { file: "scripts/lib/decide.js", args: 4 },
  { file: "scripts/lib/advise.js", args: 3 },
  { file: "scripts/lib/task.js", args: 3, functions: ["checkPhase", "addPhases", "setKnob", "closeTask", "mutateTask"] },
];

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, ext, out);
    else if (ext.test(entry.name)) out.push(rel);
  }
  return out;
}

function filesOf(scope) {
  return scope.flatMap((s) => (s.dir ? walk(s.dir, s.ext) : [s.file]));
}

function phraseHits(files, phrases) {
  const hits = [];
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
      for (const phrase of phrases) if (line.includes(phrase)) hits.push(`${file}:${i + 1}: names "${phrase}"`);
    });
  }
  return hits;
}

/** Splits the arguments of the call whose "(" sits at `open`, honouring strings, templates and nesting. */
function callArgs(src, open) {
  const args = [];
  let depth = 0, start = open + 1, i = open;
  const skipString = (quote) => {
    for (i++; i < src.length && src[i] !== quote; i++) {
      if (src[i] === "\\") i++;
      else if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
        let d = 0;
        for (i++; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) break;
          else if (src[i] === "`" || src[i] === '"' || src[i] === "'") skipString(src[i]);
        }
      }
    }
  };
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") skipString(c);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) { args.push(src.slice(start, i).trim()); return args; }
    } else if (c === "," && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1; }
  }
  return args;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** The text of the top-level `function name(` declaration, with its offset in `src`. */
function functionSpan(src, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(src);
  if (!m) return null;
  const end = src.indexOf("\n}\n", m.index);
  return { start: m.index, end: end === -1 ? src.length : end + 2 };
}

function refusalHits({ file, args, functions }) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const hits = [];
  const helper = functionSpan(src, "refusal");
  const spans = functions ? functions.map((n) => functionSpan(src, n)).filter(Boolean) : [{ start: 0, end: src.length }];
  const inScope = (index) => spans.some((s) => index >= s.start && index < s.end) && !(helper && index >= helper.start && index < helper.end);
  for (const m of src.matchAll(/\bthrow\b\s*([^;\n]*)/g)) {
    if (!inScope(m.index)) continue;
    if (!/^(refusal|rejected)\(/.test(m[1])) hits.push(`${file}:${lineOf(src, m.index)}: throws ${m[1].slice(0, 40)} instead of refusal(code, message, remedy)`);
  }
  for (const m of src.matchAll(/(?<![\w.])fail\(/g)) {
    if (inScope(m.index)) hits.push(`${file}:${lineOf(src, m.index)}: calls fail( outside the refusal helper`);
  }
  for (const m of src.matchAll(/(?<![\w.])refusal\(/g)) {
    if (!inScope(m.index) || src.slice(m.index - 9, m.index) === "function ") continue;
    const given = callArgs(src, m.index + m[0].length - 1);
    const remedy = given[args - 1];
    if (given.length !== args || !remedy || /^(""|''|``)$/.test(remedy)) hits.push(`${file}:${lineOf(src, m.index)}: refusal( has no remedy`);
  }
  return hits;
}

/** Every hit under `root` (the checkout by default). */
function run(root = REPO) {
  ROOT = root;
  const hits = [];
  const code = filesOf(CODE_SCOPE);
  const markdown = filesOf(MARKDOWN_SCOPE);
  hits.push(...phraseHits([...code, ...markdown], BANNED));
  hits.push(...phraseHits(markdown, MARKDOWN_ONLY));
  for (const skill of SKILLS) {
    for (const f of [`templates/skills/${skill}/SKILL.template.md`, `generated/claude/skills/${skill}/SKILL.md`]) {
      if (!fs.existsSync(path.join(ROOT, f))) hits.push(`${f}: the skill the guard was written against is missing`);
    }
  }
  for (const spec of REFUSAL_FILES) hits.push(...refusalHits(spec));
  return hits;
}

module.exports = { BANNED, run };

if (require.main === module) {
  const hits = run();
  for (const h of hits) console.log(h);
  console.log(`surface-guard: ${hits.length} hits (expect 0)`);
  process.exit(hits.length === 0 ? 0 : 1);
}
