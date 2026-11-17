#!/usr/bin/env node
"use strict";
// Writes the maintenance family's daily cleanup launchd job: one
// `a doctor --clean` a day, the worktree teardowns first on every path the
// one removal rule lets go. Called by install.sh beside the watcher's own
// plist step, so every install rewrites and reloads the job.
//   node install-maintenance.js --home <HOME>
// Exit 0 always — a load failure is printed, not fatal: the next install
// retries.

function main(argv) {
  const i = argv.indexOf("--home");
  const home = i >= 0 ? argv[i + 1] : undefined;
  if (!home) {
    process.stderr.write("usage: install-maintenance.js --home <home>\n");
    process.exit(2);
  }
  const { installCleanupPlist } = require("./lib/backup");
  const r = installCleanupPlist({ home });
  if (r.skipped) {
    process.stdout.write("cleanup plist: skipped (an isolated root)\n");
    return;
  }
  const note = r.loadError
    ? ` (launchctl load failed: ${r.loadError}; the next install retries)`
    : r.loaded ? "" : " (written; not loaded — not the live home)";
  process.stdout.write(`cleanup plist: ${r.plistPath}${note}\n`);
}

main(process.argv.slice(2));
