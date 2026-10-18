#!/bin/sh
# WorktreeCreate hook — creates a worktree via `a worktree add`.
# Uses the bound task if AGENTS_SESSION_DIR has one; otherwise the name from stdin.
# Prints the worktree path to stdout. Non-zero on failure.
A="${A:-$HOME/.local/bin/a}"
cat | "$A" worktree create --hook
