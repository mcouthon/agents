---
# Shared metadata (instructions don't have name/description)

# Platform sections
cc:
  # No paths field - global rule applies unconditionally
---

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

- Answer, don't announce — no preamble blocks, no restating the plan or question back, no progress narration; speak when there is a decision, a blocker, or the answer
- Ask **one** clarifying question when uncertain
- Reference files by path rather than copying large blocks
- Use structured formats (tables, lists) for complex information

## Code Quality

- Follow existing patterns in the codebase
- Include type hints for function signatures
- Write tests alongside new functionality
- No placeholder code (`TODO`, `pass`, `...` without implementation)

## Documentation Standards

- Comments are exceptional — comment only what the code cannot say (non-obvious constraint, workaround, subtle invariant); never narration, restatement, or section-divider comments
- Docstrings only where the contract is not obvious from name + types
- Never reference orchestration-transient state in shipped code or docs (task numbers, phase IDs, `.tasks/` paths, session/agent vocabulary) — cite the durable artifact instead: issue ID, ADR, commit
- Update docs alongside code changes, not after; keep them close to the code
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

## Environment Configuration

- **`CLAUDE_CODE_WEBFETCH_DEADLINE_MS`** — sets the WebFetch timeout in
  milliseconds (default: 300000 = 5 min). Set to `60000` (60s) for agent
  workloads. WebFetch is used by Explorer and Builder for documentation
  lookups; an unresponsive URL can block an agent for the full 5-minute
  default, wasting turns and inflating latency. 60s is generous for
  most web fetches while preventing indefinite hangs.
