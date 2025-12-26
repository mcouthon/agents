---
applyTo: "**"
---

# Global Copilot Instructions

## Core Philosophy

- **Correctness over speed** - Get it right the first time; don't optimize for quick responses
- **Verify before claiming done** - Run tests, check types, lint; visual confirmation is not verification
- **Research before implementing** - Understand the problem and existing patterns first
- **Own your decisions** - State assumptions explicitly; ask when uncertain about direction

## Code Generation

### Do

- Follow existing patterns in the codebase
- Include type hints for all function signatures
- Write tests alongside new functionality
- Handle errors explicitly with specific exception types
- Use meaningful names that reflect purpose

### Don't

- Leave placeholder comments (`// TODO: implement`, `pass`, `...`)
- Generate boilerplate explanations or obvious comments
- Repeat code that's already visible in context
- Make assumptions about environment-specific paths or configurations
- Add defensive code without a clear threat model

## Communication Style

- Be concise; skip preambles like "Great question!" or "Sure, I can help with that"
- When uncertain, ask **one** focused clarifying question
- Reference files by path rather than copying large blocks
- Summarize tool outputs instead of showing raw results
- Use structured formats (tables, lists) for complex information

## Problem Solving

1. **Clarify** - Ensure understanding of the actual requirement
2. **Research** - Explore existing code, patterns, dependencies
3. **Plan** - Outline approach before writing code
4. **Implement** - Execute plan with verification at each step
5. **Verify** - Confirm with tests, types, and lint

## Token Efficiency

- Don't echo back the user's question
- Don't repeat code already shown in context
- Use file references: "See `src/auth.py:45-60`" instead of copying
- Summarize large outputs; offer to show more if needed
- Prefer small, focused changes over large refactors

## Code Protection Markers

Respect these markers in code comments:

| Marker | Meaning                                            |
| ------ | -------------------------------------------------- |
| `[P]`  | Protected - Never modify without explicit approval |
| `[G]`  | Guarded - Requires human review before changes     |
| `[D]`  | Debug - Temporary code, remove before merge        |
| `[T]`  | Test - Test code, can modify freely                |

## Error Handling

When encountering errors:

1. **Don't loop** - Maximum 2-3 retry attempts
2. **Include context** - What was tried, what failed, what error
3. **Suggest next steps** - Concrete actions to resolve
4. **Ask for help** - When stuck, request human guidance

## What NOT to Do

- ❌ Use bare `except:` clauses
- ❌ Commit code with failing tests
- ❌ Skip type checking to save time
- ❌ Make changes outside the planned scope
- ❌ Assume environment (paths, configs, secrets)
- ❌ Generate "clever" code that's hard to read
