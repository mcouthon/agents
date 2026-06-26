---
name: phase-review
description: "Review implementation plans from the .tasks/ directory for flaws before committing — either a single phase (phase mode) or across all phases of a task for consistency (cross-phase analyze mode). Triggers on: 'use phase mode', 'review phase', 'review the plan', 'check phase', 'validate phase', 'review phase N', 'check the plan for phase', 'analyze phases', 'cross-phase review', 'check consistency across phases', 'analyze the task plan'."
---

# Phase Plan Review

This skill has two modes. Pick by what you were asked to review.

## Mode 1 — Single phase (default)

Go over the plan for the provided phase in the linked task and make sure it has no flaws.
Make suggestions if there are changes you'd consider (keep the full context for the task in mind).

## Mode 2 — Cross-phase analyze (opt-in, multi-phase tasks only)

Use when asked to analyze a task across its phases (e.g. "analyze phases", "check consistency
across phases"). Skip for single-phase tasks — there is nothing to cross-check.

Read `task.md` (phase table, overview, goal) and ALL `plan/*.md` for the task, then cross-check
the phases against each other and against the goal for:

- **Contradictions** — phases that assume conflicting state, ordering, or interfaces.
- **Duplication** — two phases doing the same work.
- **Gaps** — a goal/overview item or a stated dependency with no owning phase.
- **Ordering/dependency** — a phase that depends on the output of a later phase.
- **Scope drift** — a phase doing work outside the task goal.
- **Convention misalignment** — phases that diverge from AGENTS.md Learned Patterns /
  project conventions (when an AGENTS.md is present).

## Both modes are read-only

**Do NOT modify `task.md` or any file in `plan/`.** Write your findings as your response; the
orchestrating agent presents them to the user for adoption or rejection.

For cross-phase mode, structure findings as a list, each item:

- **Severity** — High (blocks correct implementation) / Medium (likely rework) / Low (minor).
- **Phases involved** — the phase numbers.
- **Issue** — one line.
- **Recommended resolution** — what to change (a suggestion; you do not apply it).

End with an overall consistency verdict (consistent / issues found) and a one-line summary.
