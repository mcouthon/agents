# RDR-035: Agentic Engineering Patterns (Willison)

| Field      | Value                                                           |
| ---------- | ---------------------------------------------------------------- |
| **Source** | https://simonwillison.net/guides/agentic-engineering-patterns/ |
| **Date**   | 2026-08-07                                                      |
| **Status** | Partially Adopted                                               |

## Summary

Simon Willison's field guide to working with coding agents — principles, testing/QA
practice, and code comprehension patterns.

## Decision

**Adopted:**

- Agentic manual testing — Builder exercises the change and reports observed output
  before reporting; Reviewer audits that evidence instead of performing first-pass
  functional verification.
- Manual-testing findings are fixed with red/green TDD.
- Compound engineering loop — execution friction recorded in phase plans
  (`## Execution Notes`) and converted by `consolidate-task` into a bounded, cited,
  confirmation-gated instruction delta.

**Rejected:**

- Reference-by-repo planning for Explorer — declined.
- The guide's anti-scaffolding stance (anti-plan-file, anti-`AGENTS.md`,
  anti-specialist-subagent) — see framework-comparison.md; it does not address
  unattended or multi-session work.
- Linear walkthroughs / cognitive-debt framing — out of scope.
- "First run the tests" session opener — Builder already has a TDD Workflow section
  (`builder.template.md:232`).

## Key Insight

The anti-fabrication principle behind Showboat's `exec` — capture the command *and*
its output, because an agent asked "did it work?" will write what it hoped happened.
AGENTS already applied this to automated checks; the adoption is extending it to
manual exercise and to retrospectives.

## See Also

- [framework-comparison.md](../synthesis/framework-comparison.md)
- [memory-and-continuity.md](../synthesis/memory-and-continuity.md)

---

**Attribution caveat:** `WebFetch` of the guide returned only its table of contents.
Section titles are confirmed; the quoted lines above come from the user's brief, not
from independent re-verification of the guide's body text.
