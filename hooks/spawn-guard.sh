#!/bin/sh
# PreToolUse (Agent|Task) hook: deny off-sequence spawns, rewrite the prompt.
# Shell stub — logic in `a hook spawn-guard` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook spawn-guard; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
