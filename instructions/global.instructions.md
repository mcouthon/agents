---
applyTo: "**"
---

# Global Copilot Instructions

## CRITICAL: Inviolable Rules

These rules have the highest priority and must never be violated.

1. **File Editing**: NEVER use `cat <<EOF`, heredocs, or any terminal command
   to create/edit files. ALWAYS use IDE file editing tools directly.

2. **Git Operations**: ALWAYS use the `git` CLI for version control.
   Never use MCP servers (GitKraken, etc.) for git operations.

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
- No bare `except:` clauses

## Code Protection Markers

These markers are **advisory conventions** that skills respect. They are not programmatically
enforced, but skills will ask before modifying `[P]` code and flag `[D]` code for cleanup.

| Marker | Meaning                                            |
| ------ | -------------------------------------------------- |
| `[P]`  | Protected - Never modify without explicit approval |
| `[G]`  | Guarded - Requires human review before changes     |
| `[D]`  | Debug - Temporary code, remove before merge        |

## When Stuck

1. Maximum 2-3 retry attempts before asking for help
2. Include context: what was tried, what failed
3. Suggest concrete next steps
