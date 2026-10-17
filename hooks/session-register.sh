#!/usr/bin/env bash
# SessionStart hook: register the session in the registry.
# Nested-session detection is pointer-based (D28); CLAUDE_CODE_CHILD_SESSION is
# set on every subprocess Claude Code spawns (hooks included) and is not a
# nested signal — see scripts/lib/session.js register().
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || A="a"
"$A" session register --hook
