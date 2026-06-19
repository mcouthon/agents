---
name: phase-review
description: "Use when reviewing an implementation plan for a specific phase before committing to it. Checks phase plans in .tasks/ for scope creep, missing edge cases, dependency gaps, and alignment with the overall task goal. Triggers on: 'use phase mode', 'review phase', 'review the plan', 'check phase', 'validate phase', 'review phase N', 'check the plan for phase', 'is this plan solid', 'sanity check the phase'."

cc:
  allowed-tools: "Read, Grep, Glob, Edit, LSP"
---

# Phase Plan Review

Review the plan for the provided phase in the linked task for flaws, gaps, and risks before implementation begins.

**Do NOT modify plan files in the `plan/` directory.** Return suggestions as your response — the orchestrating agent presents them to the user for adoption or rejection.

## Review Criteria

Evaluate the phase plan against these dimensions:

### Scope and Feasibility

- Does the phase have a clear, bounded goal?
- Can it be completed independently of later phases?
- Are there hidden dependencies on unfinished work?
- Is the scope small enough for a single implementation pass?

### Correctness and Completeness

- Are edge cases addressed (empty inputs, error paths, concurrent access)?
- Do the proposed changes align with the overall task goal in `task.md`?
- Are there missing steps that would leave the codebase in a broken state?

### Risk Assessment

- What could go wrong during implementation?
- Are there areas where the plan makes assumptions about existing code?
- Would the changes introduce regressions in existing functionality?

### Ordering and Dependencies

- Is this the right phase to implement next?
- Are prerequisite phases marked as complete?
- Would reordering reduce risk or simplify implementation?

## Review Output Format

```markdown
## Phase Review: {phase-name}

**Verdict:** Ready / Needs Revision / Block

### Strengths
- [What the plan gets right]

### Issues Found
| Issue | Severity | Suggestion |
|-------|----------|------------|
| [description] | High/Medium/Low | [proposed fix] |

### Missing Considerations
- [Edge cases, dependencies, or risks not addressed]

### Recommendation
[1-2 sentences: proceed as-is, revise specific sections, or block until resolved]
```

## Common Flaws to Watch For

| Flaw | Example | What to Flag |
|------|---------|-------------|
| Scope creep | Phase adds unrelated refactoring | Suggest splitting into separate phase |
| Implicit dependency | Assumes API exists from future phase | Flag ordering issue |
| Missing rollback | Database migration with no down path | Suggest rollback strategy |
| Vague steps | "Update the config as needed" | Request specific file paths and changes |
| No verification | No mention of testing the changes | Suggest test or validation step |
