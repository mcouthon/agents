#!/usr/bin/env node
"use strict";

// The phases block in task.md: rendered from task.json, other bytes of the file kept.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { phasesTable, withPhasesBlock, renderTaskMdPhases } = require("./lib/render");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const task = {
  phases: [
    { id: 1, name: "First | pipe", status: "done", blocked_by: [], plan_path: "plan/phase-1.md", note: "line\nbreak" },
    { id: 2, name: "Second", status: "not_started", blocked_by: [1], plan_path: "", note: "" },
  ],
};

{
  const block = phasesTable(task);
  check(block[0] === "<!-- phases:start -->" && block[block.length - 1] === "<!-- phases:end -->", "R1: the block is fenced by its markers");
  check(block.some((l) => l.includes("First \\| pipe") && l.includes("line break")), "R1: a pipe is escaped and a newline flattened in a cell");
  check(block.some((l) => l.startsWith("| 2 | Second | not_started | 1 |")), "R1: blocked_by renders as ids");
}

{
  const md = "# T\n\n## Phases\n\n| # | Phase | Notes |\n|---|---|---|\n\n## Decision Log\n";
  const out = withPhasesBlock(md, task);
  check(out.includes("<!-- phases:start -->") && !out.includes("| # | Phase | Notes |") && out.endsWith("## Decision Log\n"), "R2: the empty template table is replaced and the rest kept");
  check(withPhasesBlock(out, task) === out, "R2: rendering twice changes nothing");
  check(withPhasesBlock("<!-- phases:start -->\n", task) === null, "R2: a lone marker leaves the file alone");
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-render-test-"));
  fs.writeFileSync(path.join(dir, "task.md"), "# T\n\n## Phases\n\n| # | Phase | Notes |\n|---|---|---|\n");
  renderTaskMdPhases(dir, { ...task, files_dir: dir });
  const text = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  check(text.includes("| 1 | First \\| pipe | done |"), "R3: renderTaskMdPhases writes the block into task.md");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
