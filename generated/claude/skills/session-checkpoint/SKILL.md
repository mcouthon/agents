---
name: session-checkpoint
description: "Generate a session progress summary from the task's advice. Shows task status, phase progress, current activity, and suggested next actions. Use when resuming a task or checking progress. Triggers on: '/session-checkpoint', 'session checkpoint', 'check progress', 'task summary', 'where are we', 'status check'."
allowed-tools: [Read, mcp__state-manager__prime, mcp__state-manager__task_read]
---

# Session Checkpoint

## Live State

Tasks in the current workspace:
!`ls -d .tasks/*/ 2>/dev/null`

If no task is listed above, there may be no active tasks in the
current workspace.

## What to do

For each task, call `prime` (its `advice` and `decisions`) and `task_read`
(its phases), then present a structured summary. This is the Conductor's
loop seen from outside: `prime` → plan → approve → build → review → accept
→ commit → `check_phase` → `land`. A phase counts as complete when
`check_phase` marked it done. Use this format:

**Session Checkpoint**

**Task:** [task name]

**Progress:** [N/M phases checked]

**Current Phase:** Phase [N] — [name]
**Next move:** [`advice.move` and its sentence]
**Worktree:** [the worktree path or "none"]

**Warnings:** [advice warnings or "none"]

**Next Actions:**
- `plan` or `revise`: `/plan-phase [task_slug]` to plan it
- `approve`: the owner's approval of the plan is next
- `build`: `/build-phase [N]` to start building it
- `commit`: `/ship` to commit
- `check`: `check_phase` marks it done
- `land`: `land` pushes the checked phases
- `close`: task is complete — consider /consolidate-task

If multiple tasks are active, present a summary for each. This skill writes nothing.
