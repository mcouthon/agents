"use strict";

/**
 * Phase 15 Step 11: Static test — root isolation (F20).
 *
 * Checks every test-*.js file in scripts/ that touches state (imports or
 * requires ./lib/task, ./lib/session, ./lib/store, ./lib/hook, ./lib/report,
 * ./lib/checkpoint) sets the corresponding AGENTS_*_ROOT env var to a tmpdir.
 * Each lib maps to the root it writes to, so a test importing only ./lib/task
 * needs only AGENTS_TASKS_ROOT, not all three.
 */

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname);

// Map each state lib to the env var root it writes to.
const LIB_TO_ROOT = {
  "./lib/task": "AGENTS_TASKS_ROOT",
  "./lib/session": "AGENTS_SESSIONS_ROOT",
  "./lib/store": "AGENTS_TASKS_ROOT",
  "./lib/hook": "AGENTS_LOGS_ROOT",
  "./lib/report": "AGENTS_TASKS_ROOT",
  "./lib/checkpoint": "AGENTS_TASKS_ROOT",
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; } else {
    failed++;
    console.error(`  FAIL - ${message}`);
  }
}

const testFiles = fs.readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith("test-") && f.endsWith(".js"))
  .map((f) => ({ name: f, filePath: path.join(SCRIPTS_DIR, f) }));

console.log("F20: root isolation — every state-touching test sets the required roots");

for (const { name, filePath } of testFiles) {
  const src = fs.readFileSync(filePath, "utf8");

  for (const [lib, envVar] of Object.entries(LIB_TO_ROOT)) {
    const escaped = lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`require\\(["']${escaped}["']\\)`).test(src)) continue;

    assert(
      src.includes(envVar),
      `${name}: sets ${envVar} (imports ${lib})`
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
