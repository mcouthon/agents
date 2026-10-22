#!/bin/sh
# PostToolUse (Bash) + Stop hook: record validation exit codes, block on stale edits.
# Replaces the old keyword-regex quality-gate. Logic in `a hook quality-gate`.
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook quality-gate; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
