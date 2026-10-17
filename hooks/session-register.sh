#!/usr/bin/env bash
# SessionStart hook: register the session in the registry
[ -n "$CLAUDE_CODE_CHILD_SESSION" ] && exit 0
a session register --hook
