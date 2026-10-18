#!/bin/sh
# PostToolUse (Bash) + Stop hook: record validation exit codes, block on stale edits.
# Replaces the old keyword-regex quality-gate. Logic in `a hook quality-gate`.
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || exit 0
exec "$A" hook quality-gate
