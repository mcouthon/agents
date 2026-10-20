#!/bin/sh
# PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash) hook: D37 machine-owned
# task files. Denies writes to task.json, state.md, state.json*, tasks.json,
# index.json for every agent type and unbound sessions.
# Shell stub — logic in `a hook machine-owned-guard` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook machine-owned-guard
