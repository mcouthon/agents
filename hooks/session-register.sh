#!/usr/bin/env bash
# SessionStart hook: register the session in the registry
[ -n "$CLAUDE_CODE_CHILD_SESSION" ] && exit 0
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || A="a"
"$A" session register --hook
