---
applyTo: "**"
---

# Terminal & CLI Instructions

## Shell Commands

- Target shell: **zsh** on macOS
- Use `rg` for searching
- Use `docker compose` instead of `docker-compose`
- Quote variables: `"$var"` instead of `$var`

## File Operations

- Use `gh` CLI for GitHub operations
- See **CRITICAL** rules in global.instructions.md for file editing restrictions

## GitHub CLI (`gh`)

- Pipe output to `cat` to avoid interactive mode: `gh run view | cat`
- Use `gh api` for raw content from other repos

```zsh
# Fetch file from another repo
gh api repos/owner/repo/contents/path/to/file \
  -H "Accept: application/vnd.github.raw" > /tmp/file.txt

# View workflow run non-interactively
gh run view 12345 | cat
```
