#!/bin/sh
# Pre/PostToolUse (AskUserQuestion) hook: open + resolve checkpoints.
# Shell stub — logic in `a hook checkpoint-capture` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook checkpoint-capture; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
