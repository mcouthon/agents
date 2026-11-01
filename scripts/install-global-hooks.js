#!/usr/bin/env node
"use strict";
// Re-export from the adapter; install.sh calls the adapter directly.
module.exports = require("./lib/adapter/claude-code/install");
if (require.main === module) {
  const args = process.argv.slice(2);
  const mod = module.exports;
  const homeIdx = args.indexOf("--home");
  if (homeIdx >= 0 && args[homeIdx + 1]) mod.setHome(args[homeIdx + 1]);
  if (args.includes("--manual")) { mod.manualInstructions(); process.exit(0); }
  const result = mod.install(args.includes("--force"));
  if (result.needsConfirmation) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Write these changes? [y/N] ", (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "y") {
        mod.writeSettings(result.updated, result.afterStr);
        console.log("Global hooks installed.");
      } else {
        console.log("Skipped. Run with --force to install without prompting.");
        mod.manualInstructions();
      }
      process.exit(0);
    });
  } else process.exit(0);
}
