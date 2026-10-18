#!/bin/sh
# PreToolUse (Bash) hook: deny shell file-write primitives for read-only agents
# (explorer, reviewer, committer per the D13 guard table).
# Shell stub — logic in `a hook write-guard` (scripts/lib/writeguard.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook write-guard
