#!/bin/sh
# PreToolUse (Agent|Task) hook: deny off-sequence spawns, rewrite the prompt.
# Shell stub — logic in `a hook spawn-guard` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook spawn-guard
