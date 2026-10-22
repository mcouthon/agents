#!/bin/sh
# PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash) hook: D37 machine-owned
# task files. Denies writes to task.json, state.md, state.json*, tasks.json,
# index.json for every agent type and unbound sessions.
# Shell stub — logic in `a hook machine-owned-guard` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook machine-owned-guard; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
