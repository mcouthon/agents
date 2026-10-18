#!/bin/sh
# PreToolUse (Edit|Write|MultiEdit|NotebookEdit) hook: enforce file-scope rules.
# Shell stub — logic in `a hook manifest-guard` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook manifest-guard
