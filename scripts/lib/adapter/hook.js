#!/usr/bin/env node
"use strict";

/**
 * The harness-neutral hook entry the shell stubs exec directly. Contains the
 * kill-switch and node:sqlite checks, reads the payload from stdin, and
 * dispatches to the adapter's hook handler. A crash never blocks (exit 0).
 */

const name = process.argv[2] || "";

try {
  const adapter = require("./index").forHarness();
  if (!adapter.hookHandlers.includes(name)) process.exit(0);
  if (adapter.hooksDisabled()) process.exit(0);
  const db = require("../db");
  if (!db.nodeSqliteOk()) {
    process.stderr.write(`agents: node ${process.version} at ${process.execPath} has no node:sqlite; hook ${name} skipped (run ./install.sh)\n`);
    process.exit(0);
  }
  let stdinData = "";
  try { stdinData = require("fs").readFileSync("/dev/stdin", "utf8"); } catch {}
  let hookInput = {};
  try { hookInput = stdinData ? JSON.parse(stdinData) : {}; } catch {}
  const output = adapter.hookHandler(name).run(hookInput);
  if (output) console.log(JSON.stringify(output));
  process.exit(0);
} catch (err) {
  process.stderr.write(`agents: hook ${name} failed: ${err.message}\n`);
  process.exit(0);
}
