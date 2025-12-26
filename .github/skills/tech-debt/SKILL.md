---
name: tech-debt
description: >
  Identify and resolve technical debt with focus on finding and cataloging issues. Use when
  asked to find code smells, audit TODOs, identify complexity, improve code quality, or
  assess technical debt. Triggers on: "use tech-debt mode", "tech debt", "find TODOs",
  "code smells", "technical debt audit", "find complexity", "code quality audit".
  Full access mode - can modify files and run tests.
---

# Tech Debt Mode

Identify and resolve technical debt.

## Core Philosophy

> "Less Code = Less Debt. Deletion is the most powerful refactoring."

## Debt Indicators to Find

| Category         | What to Look For                              |
| ---------------- | --------------------------------------------- |
| **Comments**     | TODO, FIXME, HACK, XXX, "temporary"           |
| **Code Smells**  | Duplicated blocks, long functions (>50 lines) |
| **Type Issues**  | Missing hints, `Any` types, type: ignore      |
| **Dead Code**    | Unused functions, unreachable branches        |
| **Dependencies** | Outdated packages, unused imports             |
| **Complexity**   | Deep nesting, long parameter lists            |

## Process

### 1. Scan

Search for debt indicators across the codebase:

- Grep for TODO/FIXME comments
- Find functions over threshold length
- Identify files with type errors
- Check for unused exports

### 2. Categorize

For each finding, assess:

- **Severity**: How bad is this?
- **Effort**: How hard to fix?
- **Risk**: What could go wrong?

### 3. Prioritize

Focus on:

- 🎯 **Quick Wins** - Low effort, high impact
- 🔒 **Safety First** - Fix risky debt before adding features
- 📍 **Hot Paths** - Prioritize frequently-touched code

### 4. Fix or Document

- Simple fixes: Just do it (with tests)
- Complex fixes: Create a plan for later

## Quick Win Examples

```python
# Before: Dead import
from typing import List, Dict, Optional  # Only Optional used

# After
from typing import Optional
```

```python
# Before: Bare except
try:
    data = fetch()
except:
    pass

# After: Specific exception
try:
    data = fetch()
except ConnectionError:
    logger.warning("Failed to fetch data, using cache")
    data = get_cached()
```

## Tech Debt Report Format

```markdown
## Tech Debt Analysis

### Summary

- **Total issues found**: X
- **Critical**: X (fix immediately)
- **Quick wins**: X (easy to fix)
- **Requires planning**: X (complex)

### Findings

#### Critical 🔴

| Location     | Type     | Issue                     | Effort |
| ------------ | -------- | ------------------------- | ------ |
| `file.py:42` | security | bare except hiding errors | Low    |

#### Quick Wins 🎯

| Location      | Type   | Issue             | Effort |
| ------------- | ------ | ----------------- | ------ |
| `utils.py:10` | unused | import never used | Low    |

#### Requires Planning 📋

| Location | Type        | Issue              | Why Complex              |
| -------- | ----------- | ------------------ | ------------------------ |
| `api.py` | duplication | 3 similar handlers | Needs abstraction design |

### Recommendations

[Suggested order of tackling debt]

### Fixed This Session

[List of debt items resolved]
```

## When Fixing Debt

- ✅ Run tests after each change
- ✅ Keep changes atomic and focused
- ✅ Verify no regressions
- ❌ Don't mix debt fixes with new features
- ❌ Don't "refactor" working code without reason

## Debt Prevention Tips

To prevent future debt:

- Add TODO with issue tracker link: `# TODO(JIRA-123): refactor after migration`
- Use type hints from the start
- Write tests before marking done
- Review for simplification opportunities

> "The best code is no code at all."
