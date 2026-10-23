#!/usr/bin/env bash
# SessionStart hook: register the session in the registry.
# Nested-session detection is pointer-based (D28); CLAUDE_CODE_CHILD_SESSION is
# set on every subprocess Claude Code spawns (hooks included) and is not a
# nested signal — see scripts/lib/session.js register().
A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"
if [ ! -x "$A" ] && [ -x "$HOME/.agents/bin/checkout/scripts/bin/a" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  A="$HOME/.agents/bin/checkout/scripts/bin/a"
fi
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" session register --hook
