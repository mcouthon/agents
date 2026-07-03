---
name: phase-review
description: "Review implementation plans from the .tasks/ directory for flaws before committing — either a single phase (phase mode) or across all phases of a task for consistency (cross-phase analyze mode). Triggers on: 'use phase mode', 'review phase', 'review the plan', 'check phase', 'validate phase', 'review phase N', 'check the plan for phase', 'analyze phases', 'cross-phase review', 'check consistency across phases', 'analyze the task plan'."
allowed-tools: [Read, Grep, Glob, Edit, LSP]
---

# Phase Plan Review

This skill has two modes. Pick by what you were asked to review.

## Mode 1 — Single phase (default)

Go over the plan for the provided phase in the linked task and make sure it has no flaws.
Make suggestions if there are changes you'd consider (keep the full context for the task in mind).

If the phase has a `parallel_group` assigned, additionally check:

- **File overlap (mechanical):** Read the `## Files Modified` section from each
  phase plan in the same parallel group. Compute the intersection of their file
  lists. Flag any overlap as **High severity** — parallel phases must not modify
  overlapping files.
- **Shared state:** Check if this phase reads state that another parallel phase
  writes (e.g., shared config files, database migrations that must be ordered).
  Flag as **Medium severity** if detected.

## Mode 2 — Cross-phase analyze (opt-in, multi-phase tasks only)

Use when asked to analyze a task across its phases (e.g. "analyze phases", "check consistency
across phases"). Skip for single-phase tasks — there is nothing to cross-check.

Read `task.md` (phase table, overview, goal) and ALL `plan/*.md` for the task, then cross-check
the phases against each other and against the goal for:

- **Contradictions** — phases that assume conflicting state, ordering, or interfaces.
- **Duplication** — two phases doing the same work.
- **Gaps** — a goal/overview item or a stated dependency with no owning phase.
- **Ordering/dependency** — a phase that depends on the output of a later phase.
- **Parallel group safety** — phases in the same `parallel_group` that modify
  overlapping files or share mutable state. Severity: High if file overlap,
  Medium if shared-state risk.
- **Dependency consistency** — `blocked_by` edges in state.json match the `Deps`
  column in task.md. Flag mismatches as Medium severity.
- **Scope drift** — a phase doing work outside the task goal.
- **Convention misalignment** — phases that diverge from AGENTS.md Learned Patterns /
  project conventions (when an AGENTS.md is present).

## File access

**Do NOT modify `task.md`, any file in `plan/`, or any source code files.** Write your findings
as your response; the orchestrating agent presents them to the user for adoption or rejection.

**After a successful review (Approved or Approved with Suggestions):** Call
`state_update` with the task directory, the reviewed phase's ID, and
`phase_status: "reviewed"`. This ensures Conductor can see `reviewed` on resume
and skip re-review.

For cross-phase mode, structure findings as a list, each item:

- **Severity** — High (blocks correct implementation) / Medium (likely rework) / Low (minor).
- **Phases involved** — the phase numbers.
- **Issue** — one line.
- **Recommended resolution** — what to change (a suggestion; you do not apply it).

End with an overall consistency verdict (consistent / issues found) and a one-line summary.
