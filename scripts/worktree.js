#!/usr/bin/env node
// Deprecated: use `a worktree` instead.
// This stub prints a pointer for one release, then will be deleted.

"use strict";

const USAGE =
  "Deprecated: scripts/worktree.js is replaced by `a worktree`.\n" +
  "Use:\n" +
  "  a worktree add --task <dir>          Create a task-bound worktree\n" +
  "  a worktree add --name <name>         Create a named worktree\n" +
  "  a worktree remove <path>             Remove a worktree\n" +
  "  a worktree list                      List worktrees\n" +
  "  a worktree clean [--dry-run]         Remove stale worktrees\n" +
  "\nRun `make && ./install.sh` to install the `a` CLI.";

function main() {
  console.error(USAGE);
  process.exit(1);
}

main();
