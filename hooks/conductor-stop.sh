#!/bin/sh
# Stop hook (Conductor): block when no state advance happened this turn.
# Shell stub — logic in `a hook conductor-stop` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook conductor-stop; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
