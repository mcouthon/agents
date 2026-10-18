#!/bin/sh
# PreToolUse (Bash) hook: enforce git/gh policy by main root + agent type.
# Shell stub — logic in `a hook git-guard` (scripts/lib/guards.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook git-guard
