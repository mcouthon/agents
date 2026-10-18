#!/bin/sh
# Stop hook (Courier): validate + persist the top-level builder report.
# SubagentStop does not fire for top-level sessions (D15 resumability gap).
# Shell stub — logic in `a hook courier-stop` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook courier-stop
