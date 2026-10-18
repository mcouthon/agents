#!/bin/sh
# SubagentStop hook: validate the JSON report and persist via `a report`.
# Shell stub — logic in `a hook report-parser` (scripts/lib/hook.js).
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook report-parser
