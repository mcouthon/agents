#!/bin/sh
# SessionStart: register the session. Never refuses; logic in scripts/lib/adapter/hook.js.
NODE="${AGENTS_NODE:-$HOME/.agents/bin/node}"
HOOK="${AGENTS_HOOK:-$HOME/.agents/bin/current/scripts/lib/adapter/hook.js}"
if [ ! -f "$HOOK" ] && [ -f "$HOME/.agents/bin/checkout/scripts/lib/adapter/hook.js" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  HOOK="$HOME/.agents/bin/checkout/scripts/lib/adapter/hook.js"
fi
[ -f "$HOOK" ] || exit 0
[ -x "$NODE" ] || { echo "agents: no recorded node at $NODE (run ./install.sh)" >&2; exit 0; }
"$NODE" "$HOOK" session-register
exit 0
