#!/bin/sh
# WorktreeRemove hook — removes a worktree via `a worktree remove`.
# Refuses (non-zero with reason) when dirty or unlanded; Claude Code leaves it in place.
A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"
if [ ! -x "$A" ] && [ -x "$HOME/.agents/bin/checkout/scripts/bin/a" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  A="$HOME/.agents/bin/checkout/scripts/bin/a"
fi
command -v "$A" >/dev/null 2>&1 || { echo "agents: no installed a (run ./install.sh)" >&2; exit 1; }
cat | "$A" worktree remove --hook
