
# Global Instructions

## CRITICAL: Inviolable Rules

These rules have the highest priority and must never be violated.

1. **File Editing**: NEVER use `cat <<EOF`, heredocs, or any terminal command
   to create/edit files. ALWAYS use IDE file editing tools directly.

2. **Git Operations**: ALWAYS use the `git` CLI for version control.
   Never use MCP servers (GitKraken, etc.) for git operations.

3. **Terminal Command Length**: NEVER run commands longer than ~5 lines in a
   single terminal invocation. Create a temporary script or split into
   multiple commands instead. See Terminal instructions for details.

4. **Error Suppression**: NEVER suppress errors in commands you run — no
   `2>/dev/null`, no `>/dev/null 2>&1`, no `|| true` to mask a failure.
   See Terminal instructions for details.

## Core Principles

- **Correctness over speed** - Get it right the first time
- **Verify before claiming done** - Run tests, check types, lint
- **Research before implementing** - Understand existing patterns first
- **Own your decisions** - State assumptions; ask when uncertain
- **Brevity** - Short, elegant solutions preferred. Delete > comment out.
  Exception: Context for future AI executions should be detailed.

## Communication

- Be concise; skip preambles ("Great question!", "Sure, I can help...")
- Ask **one** clarifying question when uncertain
- Reference files by path rather than copying large blocks
- Use structured formats (tables, lists) for complex information

## Code Quality

- Follow existing patterns in the codebase
- Include type hints for function signatures
- Write tests alongside new functionality
- No placeholder code (`TODO`, `pass`, `...` without implementation)

## Documentation Standards

- Document public APIs: params, returns, exceptions, brief description
- Comments explain "why" not "what" — never restate the code
- Update docs alongside code changes, not after
- Keep documentation close to the code it describes
- For detailed guidance, see the documentation skill

## When Stuck

1. Maximum 2-3 retry attempts before asking for help
2. Include context: what was tried, what failed
3. Suggest concrete next steps

### Log Management

When developing backend or frontend applications, configure logging in code to write to
well-known locations. This enables reading errors directly from log files instead of
asking users to copy/paste terminal output.

### Autonomous Verification

Verify behavior programmatically rather than asking users to check manually:

1. **API endpoints**: Use `curl`, `httpie`, or write test scripts
2. **Web UIs**: Consider Playwright for browser automation
3. **CLI tools**: Capture and parse output for expected patterns
4. **File changes**: Check contents, run linters, validate schemas
