---
applyTo: "**"
---

# Terminal & CLI Instructions

## Shell Commands

- Target shell: **zsh** on macOS
- Use `ag` (The Silver Searcher) instead of `rg` for searching
- Use `docker-compose` instead of `docker compose`
- Quote variables: `"$var"` instead of `$var`

## File Operations

- **NEVER** use `cat <<EOF >` or heredocs to create/edit files
- **ALWAYS** use IDE file creation/editing tools instead
- Use `gh` CLI for GitHub operations

## GitHub CLI (`gh`)

- Pipe output to `cat` to avoid interactive mode: `gh run view | cat`
- Use `gh api` for raw content from other repos
- Default organization: `forter` (when not specified)

```zsh
# Fetch file from another repo
gh api repos/forter/other-repo/contents/path/to/file \
  -H "Accept: application/vnd.github.raw" > /tmp/file.txt

# View workflow run non-interactively
gh run view 12345 | cat
```

## Vault

- Use `forter vault get-secret <path>` for secrets
- Store secrets in environment variables
- Never print secrets to terminal output

```zsh
# Good
export API_KEY=$(forter vault get-secret path/to/secret)

# Bad - prints secret
echo $(forter vault get-secret path/to/secret)
```

## Command Chaining

- Use `&&` to chain dependent commands
- Use `;` for independent commands
- Use `|` pipelines over temporary files

```zsh
# Good - stops on failure
cd project && npm install && npm test

# Good - pipeline
find . -name "*.py" | xargs grep "TODO"

# Avoid - continues on failure
cd project; npm install; npm test
```

## Output Management

- Use `head`, `tail`, `grep` to limit output
- Use `| cat` for pager commands: `git --no-pager log` or `git log | cat`
- Use `wc -l` to count before displaying large outputs
- Redirect verbose output: `command 2>&1 | tail -100`

## Background Processes

- Use `&` suffix for background processes
- Long-running processes (servers, watch mode) should be backgrounded
- Check status with `jobs`, `fg`, `bg`

## Best Practices

```zsh
# Check command exists before using
command -v jq >/dev/null || brew install jq

# Safe directory navigation
cd "${PROJECT_DIR:?PROJECT_DIR not set}"

# Capture exit codes
result=$(some_command) || { echo "Failed"; exit 1; }
```
