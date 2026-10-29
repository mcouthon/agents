#!/usr/bin/env node
"use strict";

// The surface guard fails on each thing it guards and passes the clean tree.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, BANNED } = require("./surface-guard");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const REPO = path.resolve(__dirname, "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-guard-")));

function freshTree(label) {
  const root = path.join(tmp, label);
  fs.mkdirSync(path.join(root, "scripts", "bin"), { recursive: true });
  fs.cpSync(path.join(REPO, "scripts", "lib"), path.join(root, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "bin", "a"), path.join(root, "scripts", "bin", "a"));
  fs.copyFileSync(path.join(REPO, "scripts", "state-server.js"), path.join(root, "scripts", "state-server.js"));
  fs.cpSync(path.join(REPO, "templates"), path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated"), { recursive: true });
  fs.cpSync(path.join(REPO, "generated", "claude"), path.join(root, "generated", "claude"), { recursive: true });
  return root;
}
const edit = (root, rel, fn) => {
  const file = path.join(root, rel);
  fs.writeFileSync(file, fn(fs.readFileSync(file, "utf8")));
};
const append = (root, rel, text) => edit(root, rel, (s) => `${s}\n${text}\n`);
const hitsFor = (root, rel) => run(root).filter((h) => h.startsWith(`${rel}:`));

check(run(REPO).length === 0, `G0: the checkout has no hits (${run(REPO).slice(0, 3).join("; ") || "none"})`);
check(BANNED.includes("a report") && BANNED.includes("--choice override"), "G0: the banned list is exported for other tests");

for (const phrase of ["a state ", "state_update", "state_add_phases", "state_init", "--phase-status", "--task-status", "a checkpoint", "a report", "a run ", "edit task.json", "a task migrate", "--choice override", "decide override"]) {
  const root = freshTree(`phrase-${phrase.replace(/\W+/g, "_")}`);
  append(root, "templates/agents/builder.template.md", `Never ${phrase}here.`);
  append(root, "scripts/lib/render.js", `// ${phrase}x`);
  check(hitsFor(root, "templates/agents/builder.template.md").length === 1 && hitsFor(root, "scripts/lib/render.js").length === 1, `G1: "${phrase}" is a hit in markdown and in lib code`);
}

{
  const root = freshTree("override-prose");
  append(root, "templates/skills/design/SKILL.template.md", "A theme overrides the default; overrides win.");
  check(run(root).length === 0, "G2: prose 'overrides' is not a hit");
}

{
  const root = freshTree("state-json");
  append(root, "templates/skills/ship/SKILL.template.md", "Edit state.json by hand.");
  append(root, "scripts/lib/task.js", "// the v1 import reads state.json");
  const hits = run(root);
  check(hits.some((h) => h.startsWith("templates/skills/ship/")) && !hits.some((h) => h.startsWith("scripts/lib/task.js:") && /state\.json/.test(h)), "G3: state.json is a hit in markdown and not in lib code");
}

{
  const root = freshTree("generated-md");
  append(root, "generated/claude/agents/builder.md", "run a report");
  check(hitsFor(root, "generated/claude/agents/builder.md").length === 1, "G4: generated markdown is scanned");
}

for (const skill of ["build-phase", "ship", "plan-phase", "session-checkpoint", "phase-review"]) {
  const root = freshTree(`skill-${skill}`);
  fs.rmSync(path.join(root, "templates", "skills", skill, "SKILL.template.md"));
  check(run(root).some((h) => h.includes(`templates/skills/${skill}/SKILL.template.md`) && /missing/.test(h)), `G5: a missing ${skill} skill is a hit`);
}

for (const file of ["land", "decide", "advise"]) {
  const root = freshTree(`bare-throw-${file}`);
  append(root, `scripts/lib/${file}.js`, 'function extra() { throw new Error("no remedy"); }');
  check(hitsFor(root, `scripts/lib/${file}.js`).some((h) => /throws new Error/.test(h)), `G6: a bare throw in ${file}.js is a hit`);
}

{
  const root = freshTree("close-task");
  edit(root, "scripts/lib/task.js", (s) => s.replace(/throw refusal\("no_task", `No task\.json at \$\{taskDir\}\.`, "[^"]*"\)/, 'throw new Error(`task.json not found at ${taskDir}`)'));
  check(hitsFor(root, "scripts/lib/task.js").some((h) => /throws new Error/.test(h)), "G7: closeTask throwing a bare Error is a hit");
}

{
  const root = freshTree("empty-remedy");
  append(root, "scripts/lib/land.js", 'function extra() { throw refusal("x", "message", ""); }');
  append(root, "scripts/lib/decide.js", 'function extra() { throw refusal(2, "x", "message"); }');
  check(hitsFor(root, "scripts/lib/land.js").some((h) => /no remedy/.test(h)), "G8: a land refusal with an empty remedy is a hit");
  check(hitsFor(root, "scripts/lib/decide.js").some((h) => /no remedy/.test(h)), "G8: a decide refusal with a missing remedy is a hit");
}

{
  const root = freshTree("fail-call");
  append(root, "scripts/lib/decide.js", 'function extra() { return fail(2, "message"); }');
  check(hitsFor(root, "scripts/lib/decide.js").some((h) => /calls fail\(/.test(h)), "G9: a fail( call outside the refusal helper is a hit");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
