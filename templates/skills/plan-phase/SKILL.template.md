---
name: plan-phase
description: "Plan the next unplanned phase in a task. Reads state.json to find the next not_started phase, then invokes Explorer to create a detailed implementation plan. Use when you need to create or revise a phase plan. Triggers on: '/plan-phase', 'plan the next phase', 'plan phase', 'create phase plan', 'plan unplanned phase'."

cc:
  arguments: [task_slug]
  allowed-tools: [Read, Edit, "Task(Explorer)"]
---

# Plan the Next Unplanned Phase

## Live State

!`cat .tasks/${task_slug}/state.json 2>/dev/null | jq -r '.phases[] | select(.status == "not_started") | "Next unplanned: Phase \(.id) — \(.name)"' | head -1`

If no phase is shown above, all phases may already be planned or in
progress, or the task slug may be incorrect.

## What to do

1. Read the injected state above — it shows the next `not_started` phase
   for task `$task_slug`. If empty, check whether the task exists and
   whether all phases are already planned.

2. Read `.tasks/${task_slug}/task.md` for full task context — the phase
   table, research findings, and the specific phase's details section.

3. Invoke Explorer to plan the phase:
   - Use the Task tool to spawn an Explorer subagent
   - Instruct Explorer: "Plan Phase [N] of task [task_slug]. Read
     .tasks/[task_slug]/task.md for context. Create the phase plan at
     .tasks/[task_slug]/plan/phase-N-[name].md."
   - Explorer researches the phase, creates the plan, and updates
     task.md to mark the phase as Planned

4. After Explorer completes, update state.json to signal planning is done:
   - If you have `mcp__state-manager__*` tools (Conductor context): use
     `state_update` to set the phase's `status` to "planned" and `owner`
     to null
   - Otherwise, use Edit on `.tasks/${task_slug}/state.json`: set the
     phase's `status` field to "planned" and `owner` field to null
     (planning complete, ready for build)
   - PAV's scanner reads `status` and `owner` to display the phase's
     state on its kanban board — "planned" with null owner signals
     "ready for build"

5. If no `not_started` phase is found, report: "All phases are planned or
   in progress. Use /build-phase N to start building, or /ship to commit
   completed work."

## PAV Integration

- **Reads:** `state.json` phases where `status == "not_started"` — PAV's
  scanner shows phase status on the kanban board (257 P3)
- **Writes:** `status: "planned"` and `owner` set to null after
  planning — signals "ready for build" to PAV's scanner
- **Invocation:** PAV can invoke this command via socket steering (257 P5)
  or Agent SDK (257 P6) to trigger planning from its UI
- **Output:** Explorer's plan file and task.md update are visible in
  PAV's file browser and transcript view (257 P8)
