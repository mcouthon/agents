#!/bin/sh
# WorktreeCreate hook — creates a worktree via `a worktree add`.
# Uses the bound task if AGENTS_SESSION_DIR has one; otherwise the name from stdin.
# Prints the worktree path to stdout. Non-zero on failure.
A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"
if [ ! -x "$A" ] && [ -x "$HOME/.agents/bin/checkout/scripts/bin/a" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  A="$HOME/.agents/bin/checkout/scripts/bin/a"
fi
command -v "$A" >/dev/null 2>&1 || { echo "agents: no installed a (run ./install.sh)" >&2; exit 1; }
cat | "$A" worktree create --hook
