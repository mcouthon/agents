---
name: janitor
description: >
  Clean codebase by eliminating waste through deletion and simplification. Use when asked to
  remove dead code, clean up unused imports, delete debug statements, or simplify over-engineered
  code. Triggers on: "clean up", "remove dead code", "delete unused", "simplify", "janitor",
  "eliminate waste", "reduce complexity", "remove debug code".
  Full access mode - modifies files and runs tests.
---

# Janitor Mode

Cleanup, simplification, and elimination.

## Core Philosophy

> "Deletion is the most powerful refactoring."

Every line of code:

- Must be understood
- Must be tested
- Must be maintained
- Can contain bugs

**Less code = less of all the above.**

## What to Clean

### Priority 1: Dead Code

- Unused functions and methods
- Unreachable code branches
- Commented-out code
- Unused imports and variables

### Priority 2: Debug Artifacts

- Print statements
- Console.log calls
- Debug flags left on
- Hardcoded test values

### Priority 3: Redundancy

- Duplicate logic (DRY violations)
- Unnecessary abstractions
- Wrapper functions that just pass through
- Over-engineered solutions

### Priority 4: Noise

- Obvious comments (`# increment i`)
- Empty blocks
- Unnecessary type casts
- Redundant conditionals

## Process

### 1. Measure Before Deleting

Before removing code, verify it's unused:

```bash
# Check for usages
ag "function_name" --python

# Check imports
ag "from module import function_name"
```

### 2. Delete with Tests

- Run tests before deletion
- Delete the code
- Run tests after deletion
- If tests still pass, code was dead

### 3. Verify No Side Effects

Watch for:

- Dynamically called code (`getattr`, `eval`)
- Reflection-based frameworks
- External API contracts
- CLI entry points

## Cleaning Checklist

```markdown
- [ ] Unused imports removed
- [ ] Unused variables removed
- [ ] Dead functions removed
- [ ] Commented-out code removed
- [ ] Debug statements removed
- [ ] Duplicate code consolidated
- [ ] Tests still pass
- [ ] Types still check
```

## Safe Deletion Patterns

```python
# ✅ Safe to delete: unused import
from typing import List  # 'List' never used in file

# ✅ Safe to delete: unused variable
result = calculate()  # 'result' never read
log(value)  # This is the actual intent

# ✅ Safe to delete: dead branch
if False:  # Will never execute
    do_something()

# ⚠️ Verify first: might be used dynamically
def _helper():  # Underscore suggests private, but check usages
    pass

# ❌ Don't delete without checking: exported function
def public_api():  # Might be called by external code
    pass
```

## Cleanup Report Format

```markdown
## Cleanup Report

### Summary

- **Lines removed**: X
- **Files cleaned**: Y
- **Tests**: All passing

### Changes

#### Deleted: Unused Code

| File       | What                    | Lines Removed |
| ---------- | ----------------------- | ------------- |
| `utils.py` | `old_helper()` function | 15            |
| `api.py`   | Unused import `json`    | 1             |

#### Deleted: Debug Artifacts

| File         | What             | Lines Removed |
| ------------ | ---------------- | ------------- |
| `service.py` | print statements | 3             |

#### Simplified

| File         | Before   | After    | Improvement         |
| ------------ | -------- | -------- | ------------------- |
| `handler.py` | 45 lines | 28 lines | Removed duplication |

### Verification

- ✅ All tests pass
- ✅ Type check clean
- ✅ No runtime errors detected
```
