---
name: implement-plan
description: >
  Execute implementation plans with verification at each phase. Use when asked to implement
  a planned feature, execute a technical plan, build what was designed, or make the planned
  changes. Triggers on: "implement the plan", "start coding", "execute phase", "build this",
  "make these changes", "implement phase 1", "follow the plan". Full access mode - modifies files,
  runs tests, creates code.
---

# Implement Mode

Execute an approved technical plan. Plans contain phases with specific changes and success criteria.

## Initial Response

When given a plan or context:

- Read the plan completely
- Check for any existing progress (completed checkboxes)
- Read all files mentioned in the plan
- Think deeply about how pieces fit together

If no plan provided:

```
I'm ready to implement. Please provide:
1. The implementation plan (or link to plan document)
2. Which phase to start with (or confirm starting from Phase 1)

I'll read the plan thoroughly before beginning.
```

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:

- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Communicate clearly when things don't match expectations

## Process Steps

### Step 1: Understand the Plan

1. **Read the entire plan** - understand the goal and all phases
2. **Read all referenced files** - get complete context
3. **Identify the starting point** - check for existing progress
4. **Confirm understanding** before starting:

```
I've reviewed the plan. Starting with Phase [N]: [Name]

This phase will:
- [Change 1]
- [Change 2]

Files I'll modify:
- `path/to/file.py`
- `path/to/other.py`

Proceeding with implementation.
```

### Step 2: Execute Phase

For each phase:

1. **Verify Prerequisites**

   - Confirm previous phase complete (if applicable)
   - Ensure required files/state exist
   - Check dependencies are in place

2. **Make Changes Incrementally**

   - Follow existing code patterns
   - Add type hints for all signatures
   - Handle errors explicitly
   - Add/update tests alongside changes

3. **Run Verification After Each Significant Change**
   - Run relevant tests
   - Check for type errors
   - Verify no lint issues
   - Don't batch verifications - catch issues early

### Step 3: Phase Completion

After implementing all changes in a phase:

1. **Run All Automated Verification**

```
Running verification for Phase [N]:
- Tests: [command and result]
- Types: [command and result]
- Lint: [command and result]
```

2. **Fix Any Issues** before proceeding

3. **Update Progress**

   - Check off completed items in the plan
   - Note any deviations from plan

4. **Pause for Manual Verification** (if plan has manual steps):

```
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- ✅ Tests pass
- ✅ Type check clean
- ✅ Lint clean

Please perform manual verification steps from the plan:
- [ ] [Manual step 1]
- [ ] [Manual step 2]

Let me know when manual testing is complete to proceed to Phase [N+1].
```

### Step 4: Handle Mismatches

When things don't match the plan:

1. **STOP and assess** - understand why
2. **Present clearly**:

```
Issue in Phase [N]:

Expected: [what the plan says]
Found: [actual situation]
Why this matters: [explanation]

Options:
1. [Adapt approach - how]
2. [Update plan - what changes]
3. [Need more info - what questions]

How should I proceed?
```

3. **Wait for guidance** before continuing

## Quality Checklist

For each change verify:

- [ ] Tests added/updated and passing
- [ ] Type hints included
- [ ] Error handling appropriate
- [ ] No placeholder code (`TODO`, `pass`, `...`)
- [ ] Follows existing patterns
- [ ] No unnecessary changes to other code

## When to STOP and Ask

- 🔴 Plan was based on wrong assumptions about the code
- 🔴 Discovering a significantly better approach
- 🔴 Unexpected complexity that changes scope
- 🔴 Changes would affect more files than planned
- 🔴 Tests failing in unexpected ways
- 🔴 Unclear how to handle an edge case

## Progress Tracking

After completing each step, note progress:

```markdown
### Step N Complete

**Files changed**:

- `path/to/file.py` - [what changed]

**Tests**:

- Added: `tests/test_new.py`
- Passing: 15/15

**Verification**:

- ✅ pytest passed
- ✅ mypy clean
- ✅ ruff clean

**Deviations from plan**:
[None | Description of why and what changed]

**Next**: Phase N, Step M
```

## Resuming Work

If picking up from previous work:

1. Check plan for existing checkmarks
2. Trust that completed work is done
3. Pick up from first unchecked item
4. Verify previous work only if something seems off

## Guidelines

### Code Quality

- Follow existing patterns in the codebase
- Use meaningful names that reflect purpose
- Add comments only for non-obvious decisions
- Handle errors with specific exception types

### Testing

- Write tests alongside implementation, not after
- Test edge cases, not just happy path
- Follow existing test patterns in the codebase
- Ensure tests actually assert meaningful behavior

## Common Pitfalls to Avoid

- ❌ Skipping tests to "save time"
- ❌ Making changes outside planned scope
- ❌ Ignoring failing tests and moving on
- ❌ Not reading files fully before modifying
- ❌ Implementing without understanding the goal
- ❌ Batching all verification to the end
