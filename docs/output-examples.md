# Output Examples

This file provides reference examples for the expected output formats. Use these as templates when generating instruction files and agent modes.

---

## Instruction File Example

```markdown
---
applyTo: "**/*.py"
---

# Python Coding Standards

## Formatting

- Use 4 spaces for indentation
- Maximum line length: 88 characters (Black default)
- Use trailing commas in multi-line structures

## Type Hints

- All function signatures must include type hints
- Use `from __future__ import annotations` for forward references
- Prefer `list[str]` over `List[str]` (Python 3.9+)

## Error Handling

- Never use bare `except:`
- Prefer specific exception types
- Log exceptions with context before re-raising
```

---

## Agent Mode Example

```markdown
---
name: tech-debt
description: Identify and fix technical debt
activation: When user mentions "tech debt", "cleanup", or "refactor"
---

# Tech Debt Mode

## Behavior

You are now in Tech Debt Mode. Your focus is identifying and resolving technical debt.

## Process

1. **Scan** the codebase for common debt indicators
2. **Categorize** findings by severity (critical, moderate, minor)
3. **Prioritize** based on impact and effort
4. **Propose** concrete fixes with rationale

## Debt Indicators to Look For

- TODO/FIXME comments older than 6 months
- Duplicated code blocks
- Functions exceeding 50 lines
- Missing type hints
- Unused imports/variables
- Overly complex conditionals (cyclomatic complexity > 10)

## Output Format

For each finding:

- **Location:** file:line
- **Type:** [duplication|complexity|missing-types|...]
- **Severity:** [critical|moderate|minor]
- **Suggested fix:** Brief description
- **Effort:** [low|medium|high]
```

---

## Prompt File Example

```markdown
---
name: research
description: Deep research into a codebase area
---

# Research Prompt

Given a topic or area of the codebase, perform deep research:

1. Identify all relevant files
2. Trace dependencies and call graphs
3. Document current behavior
4. Note any inconsistencies or issues
5. Summarize findings in a structured format

## Output Structure

- **Overview:** 2-3 sentence summary
- **Key Files:** List with brief descriptions
- **Dependencies:** Internal and external
- **Current Behavior:** How it works now
- **Issues Found:** Any problems discovered
- **Questions:** Clarifications needed
```

---

## Global Instructions Example

```markdown
---
applyTo: "**"
---

# Global Copilot Instructions

## Code Generation

- Prefer correctness over speed
- Verify with tests before considering done
- No placeholder comments like "// TODO: implement"

## Communication

- Be concise; no preamble
- When unsure, ask one clarifying question
- State assumptions explicitly

## Token Efficiency

- Don't repeat code that's already visible
- Summarize large outputs
- Use references to files instead of copying content
```
