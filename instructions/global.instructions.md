---
applyTo: "**"
---

# Global Copilot Instructions

## Core Principles

- **Correctness over speed** - Get it right the first time
- **Verify before claiming done** - Run tests, check types, lint
- **Research before implementing** - Understand existing patterns first
- **Own your decisions** - State assumptions; ask when uncertain

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

| Marker | Meaning                                            |
| ------ | -------------------------------------------------- |
| `[P]`  | Protected - Never modify without explicit approval |
| `[G]`  | Guarded - Requires human review before changes     |
| `[D]`  | Debug - Temporary code, remove before merge        |

## When Stuck

1. Maximum 2-3 retry attempts before asking for help
2. Include context: what was tried, what failed
3. Suggest concrete next steps
