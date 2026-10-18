#!/bin/sh
# Stop hook (Conductor): block when no state advance happened this turn.
# Shell stub — logic in `a hook conductor-stop` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook conductor-stop
