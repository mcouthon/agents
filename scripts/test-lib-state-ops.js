#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-ops-tasks-"));
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-state-ops-sessions-"));
const { updateState } = require("./lib/state-ops");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

function makeTaskDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-ops-test-"));
  const taskDir = path.join(tmpDir, "task");
  fs.mkdirSync(taskDir, { recursive: true });
  const task = {
    schema: 2, slug: "so", number: 1, title: "SO", status: "in_progress", mode: "full",
    knobs: { review_plan: true, review_code: true, approve: "ask", commit: "per_phase", parallel: 3, enforcement: "deny" },
    binding: {}, lease: {}, last_writer: {},
    phases: [{
      id: 1, name: "P1", status: "planned", owner: null,
      blocked_by: [], parallel_group: "", plan_path: "plan/p.md", manifest: [], note: "",
      reports: { explorer: null, builder: null, reviewer: null, committer: null },
      commits: [], branch: "", counters: { review_passes: 1, fix_attempts: 0, autofix_ran: false, ci_attempts: 0, clarify_rounds: 0 },
      started: null, completed: null, landed_sha: null, warnings: [], conflict: null,
    }],
    checkpoints: [], flags: [], created: "", updated: "",
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2));
  return { tmpDir, taskDir };
}

// --counter sets a phase counter (D56)
{
  const { tmpDir, taskDir } = makeTaskDir();
  try {
    updateState(tmpDir, taskDir, { phase_id: 1, counters: { review_passes: 0, autofix_ran: true } });
    const after = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0];
    if (after.counters.review_passes === 0 && after.counters.autofix_ran === true && after.counters.fix_attempts === 0)
      ok("counters: review_passes reset, autofix_ran set, others untouched");
    else fail_(`counters: ${JSON.stringify(after.counters)}`);
  } catch (e) { fail_(`counters threw: ${e.message}`); }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// unknown or malformed counters are rejected before any write
{
  const { tmpDir, taskDir } = makeTaskDir();
  let threw = null;
  try { updateState(tmpDir, taskDir, { phase_id: 1, counters: { bogus: 1 } }); } catch (e) { threw = e.message; }
  if (threw && threw.includes("unknown counter")) ok("counters: unknown name rejected"); else fail_(`unknown counter: ${threw}`);
  threw = null;
  try { updateState(tmpDir, taskDir, { phase_id: 1, counters: { review_passes: -1 } }); } catch (e) { threw = e.message; }
  if (threw && threw.includes("non-negative")) ok("counters: negative value rejected"); else fail_(`negative: ${threw}`);
  const after = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")).phases[0];
  if (after.counters.review_passes === 1) ok("counters: rejected update wrote nothing"); else fail_("rejected update changed state");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
