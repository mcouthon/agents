---
name: review-code
description: >
  Verify implementation quality against plan and codebase standards. Use when asked to review
  changes, check code quality, verify implementation, or audit work before merge. Triggers on:
  "review my changes", "check this code", "verify implementation", "before I merge", "code review",
  "is this ready", "audit", "quality check". Read-only with test access - inspects but doesn't
  modify code.
---

# Review Mode

Verify implementation quality against the plan and codebase standards.

## Initial Response

When this skill is activated:

```
I'll review the implementation. Please provide:
1. The changes to review (or I'll check recent changes)
2. The original plan (if applicable)
3. Any specific concerns to focus on

I'll verify against the plan, run tests, and inspect code quality.
```

## Process Steps

### Step 1: Gather Context

1. **Identify what to review**:

   - Check git changes if available
   - Read the implementation plan
   - Understand the intended goal

2. **Read all changed files** completely

3. **Read the original plan** (if provided):
   - Note success criteria
   - Understand expected behavior
   - Check for any manual verification steps

### Step 2: Automated Verification

Run all applicable checks:

```
Running automated verification:
- Tests: [command] → [result]
- Types: [command] → [result]
- Lint: [command] → [result]
```

Note any failures for the Issues section.

### Step 3: Plan Completion Check

If a plan was provided, verify each step:

| Step      | Status      | Notes            |
| --------- | ----------- | ---------------- |
| Phase 1.1 | ✅ Complete |                  |
| Phase 1.2 | ⚠️ Partial  | [what's missing] |
| Phase 2.1 | ❌ Not done | [why it matters] |

### Step 4: Code Quality Inspection

Review each changed file for:

**Functionality**

- [ ] Implementation matches intended behavior
- [ ] Edge cases handled
- [ ] Error handling appropriate
- [ ] No obvious bugs

**Quality**

- [ ] Type hints present and correct
- [ ] Follows codebase patterns
- [ ] No dead code or debug statements
- [ ] Comments explain "why" not "what"

**Tests**

- [ ] Tests exist for new functionality
- [ ] Tests actually assert meaningful behavior
- [ ] Edge cases covered
- [ ] Tests follow codebase patterns

**Safety**

- [ ] No security anti-patterns
- [ ] Protected code (`[P]`) not modified
- [ ] No breaking changes to public APIs
- [ ] Backwards compatibility maintained

### Step 5: Present Findings

Use the Review Output Format below.

### Step 6: Follow-up

If issues found:

```
I found [N] issues that should be addressed.

Critical issues must be fixed before merge.
Would you like me to help fix these?
```

## What to Look For

### Good Signs ✅

- Tests match implementation behavior
- Types are specific (not `Any` everywhere)
- Error messages are helpful and actionable
- Code is self-documenting
- Follows existing patterns

### Red Flags 🚩

- Tests that always pass (missing assertions)
- Broad exception handling (`except Exception`)
- Magic numbers without context
- Commented-out code
- Unused imports/variables
- Changes outside planned scope
- Placeholder code (`TODO`, `pass`, `...`)

## Review Output Format

```markdown
## Review Summary

### Status: PASS | NEEDS_WORK | FAIL

### Plan Completion

| Phase | Step       | Status      | Notes                   |
| ----- | ---------- | ----------- | ----------------------- |
| 1     | Setup      | ✅ Complete |                         |
| 1     | Core logic | ⚠️ Partial  | Missing error handling  |
| 2     | Tests      | ❌ Missing  | No tests for edge cases |

### Verification Results

| Check | Result          | Details          |
| ----- | --------------- | ---------------- |
| Tests | ✅ Pass (24/24) |                  |
| Types | ⚠️ 2 errors     | See issues below |
| Lint  | ✅ Clean        |                  |

### Issues Found

#### Critical 🔴

Must fix before proceeding:

| Location     | Issue               | Fix                  |
| ------------ | ------------------- | -------------------- |
| `file.py:42` | Unhandled exception | Add try/except for X |

#### Important 🟡

Should fix:

| Location     | Issue             | Suggestion               |
| ------------ | ----------------- | ------------------------ |
| `file.py:78` | Missing type hint | Add `-> str` return type |

#### Minor 🟢

Nice to have:

| Location     | Issue     | Suggestion           |
| ------------ | --------- | -------------------- |
| `file.py:95` | Long line | Consider breaking up |

### What's Good ✅

- [Positive observation 1]
- [Positive observation 2]

### Files Reviewed

- `path/to/file.py` - [summary of changes]
- `tests/test_file.py` - [summary]

### Recommendation

[Overall assessment and next steps]
```

## Review Depth Guidelines

### Quick Review (default)

- Verify automated checks pass
- Check plan completion
- Spot check critical sections
- ~5-10 minutes

### Thorough Review (when requested)

- Line-by-line inspection
- Trace logic flow
- Verify test coverage
- Check documentation updates
- ~15-30 minutes

### Security Review (for sensitive changes)

- Input validation
- Authentication/authorization
- Data handling
- Secrets management
- Dependency updates

## When to Escalate

Flag for human review when:

- Security-sensitive changes
- Changes to protected code (`[P]` markers)
- Public API modifications
- Database schema changes
- Configuration changes affecting production

---

## Next Steps (Workflow Guidance)

After review is complete, ALWAYS end with:

```markdown
---

## Review Complete!

**If PASS**: Ready to commit and merge!

**If NEEDS_WORK**: "Fix these issues" or address specific items listed above.

**If FAIL**: Consider whether to fix or revert. May need to revisit the plan.
```

This completes the workflow:
Research → Plan → Implement → **Review** → ✅ Done
