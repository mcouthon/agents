#!/usr/bin/env bash
# SessionEnd hook: release lease and mark session ended
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || A="a"
"$A" session unregister --hook
