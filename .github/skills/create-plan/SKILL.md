---
name: create-plan
description: >
  Create detailed implementation plans through interactive research and iteration. Use when
  asked to plan a feature, design a solution, create a technical specification, or prepare
  for implementation. Also use when the user describes a feature to add or a bug to fix and
  wants to approach it methodically. Triggers on: "create a plan", "how should I implement",
  "design", "plan out", "technical spec", "before I start coding", "what's the approach",
  "break this down", "I want to add", "I need to implement", "help me build", "fix this bug".
  Read-only mode - researches and documents but does not modify files.
---

# Plan Mode

Create detailed implementation plans through an interactive, iterative process. Be skeptical, thorough, and work collaboratively to produce high-quality technical specifications.

## Initial Response

When this skill is activated:

1. **If context/files were provided**, acknowledge and begin reading them
2. **If no context provided**, respond with:

```
I'll help you create a detailed implementation plan. Let me start by understanding what we're building.

Please provide:
1. The task description or goal
2. Any relevant context, constraints, or requirements
3. Related files or previous research (if any)

I'll analyze this and work with you to create a comprehensive plan.
```

Then wait for the user's input.

## Process Steps

### Step 1: Context Gathering

1. **Read all mentioned files FULLY**
2. **Explore the codebase for context**
3. **Verify understanding**
4. **Present understanding and ask focused questions**:

```
Based on the task and my research, I understand we need to [accurate summary].

I found that:
- [Current implementation detail with file:line reference]
- [Relevant pattern or constraint discovered]
- [Potential complexity identified]

Questions I couldn't answer through code investigation:
- [Specific technical question requiring judgment]
- [Business logic clarification needed]
```

Only ask questions you genuinely cannot answer through code exploration.

### Step 2: Research & Discovery

1. **Verify corrections**: If the user corrects a misunderstanding, research to verify
2. **Deep dive into relevant areas**
3. **Present findings and design options**:

```
Based on my research:

**Current State:**
- [Key discovery about existing code]
- [Pattern or convention to follow]

**Design Options:**
1. [Option A] - [pros/cons]
2. [Option B] - [pros/cons]

**Open Questions:**
- [Technical uncertainty]
- [Design decision needed]

Which approach aligns best with your vision?
```

### Step 3: Plan Structure Development

Create initial outline and get feedback before writing details:

```
Here's my proposed plan structure:

## Overview
[1-2 sentence summary]

## Phases:
1. [Phase name] - [what it accomplishes]
2. [Phase name] - [what it accomplishes]
3. [Phase name] - [what it accomplishes]

Does this phasing make sense? Should I adjust the order or granularity?
```

### Step 4: Detailed Plan Writing

After structure approval, write the plan using the Plan Output Format below.

### Step 5: Review and Iterate

```
I've created the implementation plan.

Please review and let me know:
- Are the phases properly scoped?
- Are the success criteria specific enough?
- Any technical details that need adjustment?
- Missing edge cases or considerations?
```

## Planning Principles

### Step Sizing

**Good step sizes:**

- Add a function with tests (~10-50 lines)
- Modify an existing function with verification
- Add/update a configuration
- Create a new file with initial structure

**Too big (break these down):**

- "Implement the feature"
- "Refactor the module"
- "Add authentication"

### Dependencies

- Make dependencies between steps explicit
- Consider rollback at each phase
- Plan for incremental verification

### Scope Management

- Explicitly list what's OUT of scope
- Identify future work vs current work
- Keep phases testable independently

## Plan Output Format

```markdown
## Implementation Plan: [Feature Name]

### Goal

[Single sentence - what success looks like]

### Current State Analysis

[What exists now, key constraints discovered]

- [Finding with file:line reference]
- [Pattern to follow]

### What We're NOT Doing

[Explicitly list out-of-scope items]

### Prerequisites

- [ ] [What must be true before starting]
- [ ] [Required access, tools, dependencies]

---

## Phase 1: [Descriptive Name]

### Overview

[What this phase accomplishes]

### Changes Required

#### 1. [Component/File]

**File**: `path/to/file.ext`
**Changes**: [Summary]

### Success Criteria

#### Automated Verification:

- [ ] Tests pass: `pytest tests/test_file.py`
- [ ] Type check passes: `mypy src/`
- [ ] Lint passes: `ruff check .`

#### Manual Verification:

- [ ] [Behavior to verify manually]
- [ ] [Edge case to test]

---

## Phase 2: [Descriptive Name]

[Same structure...]

---

## Testing Strategy

### Unit Tests

- [What to test]
- [Key edge cases]

### Integration Tests

- [End-to-end scenarios]

---

## Rollback Plan

[How to undo if something goes wrong]

## References

- [Related file: `path/to/file.py:45`]
- [Similar implementation: `other/file.py`]
```

## Guidelines

### Be Skeptical

- Question vague requirements
- Identify potential issues early
- Ask "why" and "what about"
- Don't assume - verify with code

### Be Interactive

- Don't write the full plan in one shot
- Get buy-in at each major step
- Allow course corrections
- Work collaboratively

### Be Thorough

- Read all context files COMPLETELY
- Research actual code patterns
- Include specific file paths and line numbers
- Write measurable success criteria

### Be Practical

- Focus on incremental, testable changes
- Consider migration and rollback
- Think about edge cases
- Keep phases independently verifiable

## No Open Questions in Final Plan

- If you encounter open questions during planning, STOP
- Research or ask for clarification immediately
- Do NOT write the plan with unresolved questions
- The final plan must be complete and actionable

---

## Next Steps (Workflow Guidance)

After the plan is approved, ALWAYS end with:

```markdown
---

## Ready for Next Step?

Plan is complete and ready for implementation. You can now:

**→ Start implementation**: "Implement the plan" or "Implement phase 1"

Or request changes to the plan if adjustments are needed.
```

This guides users to the next phase of the workflow:
Research → **Plan** → **Implement** → Review
