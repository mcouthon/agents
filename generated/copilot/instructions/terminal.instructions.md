---
applyTo: "**"
---

# Terminal & CLI Instructions

## CRITICAL: Command Length Limit

NEVER use `cat <<EOF` or heredocs, and NEVER run commands longer than ~5 lines in a single terminal invocation.
Long commands can crash VS Code and degrade the user experience.

If a command exceeds ~5 lines create a temporary script or split the command into several ones.

## CRITICAL: NEVER suppress errors in commands you run

Applies to commands you run in the terminal — **not** to scripts, Makefiles, or
CI config you author (those may legitimately silence a probe).

- NEVER discard stderr: no `2>/dev/null`, no `>/dev/null 2>&1`, no `2>&-`.
- NEVER mask a non-zero exit with `|| true` / `|| echo ...` to make a failing
  command look like it passed. Use `|| true` only when a non-zero exit is the
  expected outcome and you say why.

Suppressed stderr hides the error you needed to read, and a redirect puts the
command line outside the terminal auto-approve allow-list — costing the user a
manual approval prompt. If output is too noisy, narrow it (`--stat`, `-n`,
`head`, explicit paths); never discard the error stream.

## Shell Commands

- Target shell: **zsh** on macOS
- Use `rg` for searching
- Use `docker compose` instead of `docker-compose`
- Quote variables: `"$var"` instead of `$var`
