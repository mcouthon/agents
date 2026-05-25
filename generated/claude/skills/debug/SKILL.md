---
name: debug
description: "Systematic debugging with hypothesis-driven investigation. Use when something is broken, tests are failing, unexpected behavior occurs, or errors need investigation. Triggers on: 'this is broken', 'debug', 'why is this failing', 'unexpected error', 'not working', 'bug', 'fix this issue', 'investigate', 'tests failing', 'trace the error', 'use debug mode'. Full access mode - can run commands, add logging, and fix issues."
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# Debug Mode

Systematic bug investigation and resolution.

## Core Approach

> "Don't guess. Form hypotheses. Test them."

## The 4-Phase Process

### Phase 1: Assessment 🔍

**Goal**: Understand and reproduce

- What is the expected behavior?
- What is the actual behavior?
- Can you reliably reproduce?
- What changed recently?

**Key Questions**:

- When did this start happening?
- Does it happen consistently or intermittently?
- What are the exact inputs that trigger it?
- What error messages or symptoms appear?

#### Building a Feedback Loop

**This is the most important step.** If you have a fast, deterministic, agent-runnable pass/fail signal, you will find the cause. If you don't, no amount of code-staring will save you. Spend disproportionate effort here.

**Techniques — try in roughly this order:**

1. **Failing test** at whatever seam reaches the bug (unit, integration, e2e)
2. **Curl / HTTP script** against a running dev server
3. **CLI invocation** with fixture input, diffing stdout against known-good output
4. **Headless browser script** (Playwright/Puppeteer) — drives UI, asserts on DOM/console
5. **Replay captured trace** — save a real request/payload to disk, replay through the code path
6. **Throwaway harness** — minimal subset of system that exercises the bug path
7. **Property/fuzz loop** — if "sometimes wrong output", run 1000 random inputs
8. **Bisection harness** — automate `git bisect run` between known-good and known-bad
9. **Differential loop** — run same input through old vs new version, diff outputs

**Iterate on the loop:** Can you make it faster? Sharper signal? More deterministic?

**If you cannot build a loop:** Stop and say so. List what you tried. Ask for: captured artifacts (logs, HAR file), environment access, or permission to add temporary instrumentation.

### Phase 2: Investigation 🔬

**Goal**: Isolate and trace

- Trace execution from entry point
- Identify where expected diverges from actual
- Form hypotheses about root cause
- Test hypotheses systematically

**Techniques**:

- Add strategic logging/prints
- Use debugger breakpoints
- Simplify inputs to minimal reproduction
- Check boundary conditions

### Phase 3: Resolution 🔧

**Goal**: Fix minimally and verify

- Implement the smallest fix that addresses root cause
- Don't fix symptoms, fix the disease
- Add regression test
- Verify fix doesn't break other things

**If fix doesn't work:**

- Count: How many fixes attempted?
- If < 3: Return to Phase 1, re-analyze with new information
- If ≥ 3: STOP. Question your understanding of the system.

### Phase 4: Quality ✅

**Goal**: Prevent recurrence

- Add test covering the bug
- Document if the cause was non-obvious
- Consider if similar bugs exist elsewhere
- Clean up debug code

## Debugging Checklist

```markdown
- [ ] **Reproduced**: Can trigger bug consistently
- [ ] **Isolated**: Know which component is failing
- [ ] **Root Cause**: Understand WHY it fails
- [ ] **Fixed**: Minimal change addresses cause
- [ ] **Tested**: Regression test added
- [ ] **Clean**: Debug code removed
```

## Hypothesis Template

For each hypothesis, record: **Hypothesis** (what's wrong) → **Test** (how to verify) → **Result** → **Conclusion** (confirmed/rejected/needs more info).

## Common Root Causes

| Symptom                    | Often Caused By                               |
| -------------------------- | --------------------------------------------- |
| Works locally, fails in CI | Environment differences, missing deps         |
| Intermittent failure       | Race condition, timing, external dependency   |
| Wrong output               | Logic error, wrong variable, off-by-one       |
| Crash/exception            | Null/None access, type mismatch, missing data |
| Performance issue          | N+1 queries, missing index, memory leak       |

## Rationalization Prevention

| Excuse                                         | Reality                                     | Required Action                                      |
| ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| "The fix is obvious"                           | Obvious fixes mask root causes              | Form a hypothesis and verify before changing code    |
| "It's probably X"                              | "Probably" isn't evidence                   | Test the hypothesis — name it, design a test, run it |
| "This is too simple to debug formally"         | Simple bugs waste the most time undiagnosed | Follow Phase 1 — reproduce, isolate, then fix        |
| "Logs look clean"                              | You didn't add targeted logging             | Add debug logging at the suspected point             |
| "I've tried 3 things, might as well try a 4th" | Stacking guesses compounds confusion        | STOP. Return to Phase 1. Re-analyze with new info    |
| "It works now"                                 | If you don't know why, it will break again  | Explain WHY it works and what changed                |

## Red Flags - STOP and Re-Assess

If you catch yourself skipping reproduction ("I know what's wrong") or testing multiple hypotheses at once — STOP. Return to Phase 1.

## Debug Report Format

```markdown
## Debug Report

### Bug Summary

- **Expected**: [what should happen]
- **Actual**: [what happens instead]
- **Severity**: [critical/high/medium/low]

### Reproduction

1. [Step to reproduce]
2. [Step to reproduce]
3. [Observe bug]

**Minimal reproduction**: [simplest case that triggers bug]

### Investigation

| Hypothesis | Test           | Result                     |
| ---------- | -------------- | -------------------------- |
| [theory]   | [what I tried] | ✅ Confirmed / ❌ Rejected |

### Root Cause

[What's actually wrong and why]

### Fix Applied

- **File**: `path/to/file.py`
- **Change**: [what was modified]
- **Why**: [how this fixes the root cause]

### Verification

- [ ] Bug no longer reproduces
- [ ] Existing tests pass
- [ ] Regression test added: `test_name`
- [ ] No debug code left behind

### Prevention

[How to prevent similar bugs in the future]
```
