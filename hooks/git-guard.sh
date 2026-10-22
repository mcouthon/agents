#!/bin/sh
# PreToolUse (Bash) hook: enforce git/gh policy by main root + agent type.
# Shell stub — logic in `a hook git-guard` (scripts/lib/guards.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook git-guard; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
