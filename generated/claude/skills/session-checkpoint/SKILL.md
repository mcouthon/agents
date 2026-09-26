---
name: session-checkpoint
description: "Generate a session progress summary from state.json. Shows task status, phase progress, current activity, and suggested next actions. Use when resuming a task or checking progress. Triggers on: '/session-checkpoint', 'session checkpoint', 'check progress', 'task summary', 'where are we', 'status check'."
allowed-tools: [Read]
---

# Session Checkpoint

## Live State

!`cat .tasks/*/state.json 2>/dev/null | jq -r '"Task: \(.task) — Status: \(.status)\nPhases: \([.phases[] | select(.status == "done")] | length)/\(.phases | length) complete\nNext: Phase \([.phases[] | select(.status != "done")][0] | .id) — \([.phases[] | select(.status != "done")][0] | .name) [\([.phases[] | select(.status != "done")][0] | .status)]\nFlags: \(.flags)"'`

If no task state is shown above, there may be no active tasks in the
current workspace.

## What to do

Present the injected state as a structured summary. Use this format:

**Session Checkpoint**

**Task:** [task name]
**Status:** [task status]

**Progress:** [N/M phases complete]

**Current Phase:** Phase [N] — [name] ([status])
**Owner:** [owner or "unassigned"]
**Started:** [started timestamp or "not started"]

**Flags:** [flags or "none"]

**Next Actions:**
- If a phase is `not_started`: `/plan-phase [task_slug]` to plan it
- If a phase is `planned`: `/build-phase [N]` to start building it
- If a phase is `in_progress`: `/build-phase [N]` to continue building
- If a phase is `done` and changes are uncommitted: `/ship` to commit
- If all phases are done: task is complete — consider /consolidate-task

If multiple tasks are active, present a summary for each.

## PAV Integration

- **Reads:** `state.json` — all fields (task, status, phases, flags)
- **Writes:** nothing (read-only command)
- **PAV context:** PAV's scanner already reads this data continuously;
  this command provides the same information as a slash command for
  terminal CC or PAV-invoked context injection
- **Invocation:** PAV can invoke this command to get a quick status
  update rendered in its transcript view (257 P8)
