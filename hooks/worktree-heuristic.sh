#!/bin/bash
# SessionStart hook: branch-aware worktree heuristic.
#
# Runs before the agent begins reasoning. Inspects the current git branch
# and either does nothing (main/master, or already in a worktree), switches
# to the default branch and pulls (merged branch), or outputs context telling
# the agent to ask the user (active branch).
#
# Always exits 0 — a SessionStart hook must never block the session.

set -uo pipefail

# Subagent safety: SessionStart should not fire for subagents (they fire
# SubagentStart), but if it does, the stdin JSON carries agent_id (present
# for subagents, absent for primary --agent sessions). Exit silently.
if [ ! -t 0 ]; then
  stdin_data=$(cat 2>/dev/null) || exit 0
  printf '%s' "$stdin_data" | grep -q '"agent_id"' && exit 0
fi

# Resolve repo root via git toplevel — not CLAUDE_PROJECT_DIR which may
# point at a subdirectory of the repo.
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

cd "$PROJECT_DIR" || exit 0

# Already in a linked worktree — no nesting
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
main_root=$(dirname "$common_dir")
[ "$PROJECT_DIR" = "$main_root" ] || exit 0

branch=$(git branch --show-current 2>/dev/null) || exit 0
[ -n "$branch" ] || exit 0

# On main or master → no action
case "$branch" in
  main|master) exit 0 ;;
esac

# Check if branch is fully merged to the default remote branch
default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -n "$default_branch" ]; then
  if git merge-base --is-ancestor "$branch" "origin/$default_branch" 2>/dev/null; then
    # Git's own output goes to stderr so it doesn't pollute the
    # injected context. --ff-only prevents merge commits on diverged
    # defaults. Failures are non-blocking (exit 0).
    # Split checkout and pull so the agent always gets a message when a
    # branch switch occurs — a successful checkout followed by a failed
    # pull must still notify, not silently leave the repo switched.
    if git checkout "$default_branch" >&2 2>&1; then
      if git pull --ff-only >&2 2>&1; then
        echo "Branch '$branch' was fully merged to origin/$default_branch."
        echo "Switched to $default_branch and pulled latest. Proceed normally."
      else
        echo "Branch '$branch' was fully merged to origin/$default_branch."
        echo "Switched to $default_branch but could not pull latest. Proceed normally."
      fi
    fi
    exit 0
  fi
fi

# Active (non-merged) branch — output context for the agent
echo "You are on active branch '$branch' (not yet merged to the default remote branch)."
echo "Consider asking the user whether to continue working on this branch"
echo "or create a worktree for parallel work (via: git worktree add <path> -b <branch>)."

exit 0
