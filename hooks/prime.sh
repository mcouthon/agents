#!/bin/sh
# UserPromptSubmit / SessionStart hook: inject `a next` context + lease touch.
# Shell stub — logic in `a hook prime` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook prime
