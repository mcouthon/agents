#!/bin/sh
# PostToolUse (Write) hook: lint plan files and task.md on write.
# Shell stub — logic in `a hook plan-lint` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook plan-lint
