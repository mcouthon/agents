---
name: build-phase
description: "Build a specific phase by number. Spawns Builder to implement the approved phase plan. Phase 1 quality gates (PostToolUse, Stop hooks) fire automatically on Builder. Use when you're ready to implement an approved phase plan. Triggers on: '/build-phase', 'build phase', 'implement phase', 'start building phase', 'execute phase'."
arguments: [phase_number]
allowed-tools: [Read, Bash, "Task(Builder)"]
---

# Build Phase $phase_number

## Live State

Plan files for phase `$phase_number`:
!`ls .tasks/*/plan/phase-${phase_number}-*.md 2>/dev/null`

If no plan file is listed above, the phase number may be incorrect or no
task has a plan for it.

## What to do

1. Identify the task the plan file belongs to. In the Conductor's loop
   (`prime` → plan → approve → build → review → accept → commit →
   `check_phase`) this is the build step: call `prime` first and follow its
   `advice`; the `Worktree:` path is where the Builder works.

2. If no plan file exists, report: "No plan found for phase
   $phase_number. Run /plan-phase [task_slug] first to create a plan."

3. Spawn Builder to implement the plan:
   - Use the Task tool to spawn a Builder subagent
   - Instruct Builder: "Implement Phase $phase_number. Read the plan at
     .tasks/[task_slug]/plan/phase-$phase_number-[name].md. Follow the
     plan's implementation steps exactly. Work in [the Worktree: path]."
   - Builder's quality gates from Phase 1 fire automatically:
     PostToolUse hook runs validation after each Edit/Write
     Stop hook blocks completion without validation evidence
   - No manual validation needed — the hooks enforce it

4. After Builder completes, report the results. Do NOT mark the phase
   as done: `check_phase` is the one progress writer, and the loop calls it
   after the commit — use /ship to commit the changes first.

## Notes

- **Quality gates:** the global `quality-gate` hook (PostToolUse Bash +
  Stop) records validation exit codes and blocks Stop when an edit happened
  after the last green run. The hook reads exit codes directly; no
  tag-prefix format.
- **Access control:** this skill never edits task files; phase progress
  moves only through `check_phase`.
