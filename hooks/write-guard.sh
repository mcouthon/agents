#!/bin/sh
# PreToolUse (Bash) hook: deny shell file-write primitives for read-only agents
# (explorer, reviewer, committer per the D13 guard table).
# Shell stub — logic in `a hook write-guard` (scripts/lib/writeguard.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook write-guard; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
