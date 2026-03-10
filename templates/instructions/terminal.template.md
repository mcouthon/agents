---
# Shared metadata (instructions don't have name/description)

# Platform sections
copilot:
  applyTo: "**"

cc:
  # No paths field - global rule applies unconditionally
---

# Terminal & CLI Instructions

## CRITICAL: Command Length Limit

NEVER use `cat <<EOF` or heredocs, and NEVER run commands longer than ~5 lines in a single terminal invocation.
Long commands can crash VS Code and degrade the user experience.

If a command exceeds ~5 lines create a temporary script or split the command into several ones.

## Shell Commands

- Target shell: **zsh** on macOS
- Use `rg` for searching
- Use `docker compose` instead of `docker-compose`
- Quote variables: `"$var"` instead of `$var`
