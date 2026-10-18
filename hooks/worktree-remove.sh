#!/bin/sh
# WorktreeRemove hook — removes a worktree via `a worktree remove`.
# Refuses (non-zero with reason) when dirty or unlanded; Claude Code leaves it in place.
A="${A:-$HOME/.local/bin/a}"
cat | "$A" worktree remove --hook
