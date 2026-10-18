#!/bin/sh
# Pre/PostToolUse (AskUserQuestion) hook: open + resolve checkpoints.
# Shell stub — logic in `a hook checkpoint-capture` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook checkpoint-capture
