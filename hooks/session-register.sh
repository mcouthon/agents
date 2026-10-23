#!/bin/sh
# SessionStart: register the session. Never refuses; logic in `a hook session-register`.
[ "${AGENTS_HOOKS_OFF:-}" = 1 ] && exit 0
[ -e "${AGENTS_HOOKS_FLAG:-$HOME/.agents/hooks.disabled}" ] && exit 0
NODE="${AGENTS_NODE:-$HOME/.agents/bin/node}"
A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"
if [ ! -x "$A" ] && [ -x "$HOME/.agents/bin/checkout/scripts/bin/a" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  A="$HOME/.agents/bin/checkout/scripts/bin/a"
fi
[ -f "$A" ] || exit 0
[ -x "$NODE" ] || { echo "agents: no recorded node at $NODE (run ./install.sh)" >&2; exit 0; }
"$NODE" "$A" hook session-register
exit 0
