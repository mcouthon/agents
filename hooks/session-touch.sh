#!/usr/bin/env bash
# UserPromptSubmit hook: extend lease and update liveness
A="${A:-$HOME/.local/bin/a}"
command -v "$A" >/dev/null 2>&1 || A="a"
"$A" session touch --hook
