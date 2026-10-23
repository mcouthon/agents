#!/bin/sh
# Pre/PostToolUse (AskUserQuestion) hook: open + resolve checkpoints.
# Shell stub — logic in `a hook checkpoint-capture` (scripts/lib/hook.js).
A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"
if [ ! -x "$A" ] && [ -x "$HOME/.agents/bin/checkout/scripts/bin/a" ]; then
  echo "agents: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)" >&2
  A="$HOME/.agents/bin/checkout/scripts/bin/a"
fi
command -v "$A" >/dev/null 2>&1 || exit 0
"$A" hook checkpoint-capture; rc=$?
# A crash in `a` (any exit but the deliberate 2) is not a verdict: fail open (D57).
[ "$rc" -eq 2 ] && exit 2
exit 0
