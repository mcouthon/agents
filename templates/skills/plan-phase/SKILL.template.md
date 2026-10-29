---
name: plan-phase
description: "Plan the next unplanned phase in a task. Reads the task's advice to find the phase to plan, then invokes Explorer to create a detailed implementation plan. Use when you need to create or revise a phase plan. Triggers on: '/plan-phase', 'plan the next phase', 'plan phase', 'create phase plan', 'plan unplanned phase'."

cc:
  arguments: [task_slug]
  allowed-tools: [Read, Edit, "Task(Explorer)", mcp__state-manager__prime]
---

# Plan the Next Unplanned Phase

## Live State

Plan files so far for task `$task_slug`:
!`ls .tasks/${task_slug}/plan/ 2>/dev/null`

## What to do

1. Call `prime` on the task (the Conductor's loop: `prime` → plan →
   approve → build → review → accept → commit → `check_phase`). When its
   move is `plan` or `revise`, `advice` names the phase to plan. Otherwise
   report what it says; for example, "Use /build-phase N to start building,
   or /ship to commit completed work."

2. Read `.tasks/${task_slug}/task.md` for full task context — the phase
   table, research findings, and the specific phase's details section.

3. Invoke Explorer to plan the phase:
   - Use the Task tool to spawn an Explorer subagent
   - Instruct Explorer: "Plan Phase [N] of task [task_slug]. Read
     .tasks/[task_slug]/task.md for context. Create the phase plan at
     .tasks/[task_slug]/plan/phase-N-[name].md. Work in [the Worktree: path]."
   - Explorer researches the phase and creates the plan

4. After Explorer completes, show the owner the plan's headline, its
   `Worth your attention:` bullets and each open question. Planning writes
   no status: the owner's `decide` approval is what moves the loop on, and
   `check_phase` stays the one progress writer.
