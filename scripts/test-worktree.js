#!/usr/bin/env node
// Tests for scripts/worktree.js deprecation stub.
// The old add/remove/list/status/clean + symlink functionality moved to
// scripts/lib/worktree.js (tested by scripts/test-lib-worktree.js).
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const WORKTREE_JS = path.join(__dirname, "worktree.js");

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) { passed++; console.log(`  ok - ${msg}`); }
  else { failed++; console.error(`  FAIL - ${msg}`); }
}

function wt(args) {
  const r = spawnSync("node", [WORKTREE_JS, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// T0: deprecation stub prints usage and exits 1
{
  const r = wt([]);
  check(r.status === 1, `exit 1, got ${r.status}`);
  check(r.stderr.includes("Deprecated"), "stderr mentions Deprecated");
  check(r.stderr.includes("a worktree"), "stderr points to `a worktree`");
}

// T1: any subcommand also exits 1 with deprecation message
{
  const r = wt(["add", "wt/test"]);
  check(r.status === 1, `exit 1 for add, got ${r.status}`);
  check(r.stderr.includes("a worktree add"), "stderr mentions `a worktree add`");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
