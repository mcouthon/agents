---
name: build-phase
description: "Build a specific phase by number. Spawns Builder to implement the approved phase plan. Phase 1 quality gates (PostToolUse, Stop hooks) fire automatically on Builder. Use when you're ready to implement an approved phase plan. Triggers on: '/build-phase', 'build phase', 'implement phase', 'start building phase', 'execute phase'."

cc:
  arguments: [phase_number]
  allowed-tools: [Read, Edit, Bash, "Task(Builder)"]
---

# Build Phase $phase_number

## Live State

!`cat .tasks/*/state.json 2>/dev/null | jq -r '.task as $t | .phases[] | select(.id == ${phase_number}) | "Task: \($t) — Phase \(.id): \(.name) [\(.status)]"'`

If no phase is shown above, the phase number may be incorrect or no
task has that phase.

## What to do

1. Read the injected state above — it shows the task and phase details
   for phase `$phase_number`. Identify which task the phase belongs to.

2. Find the phase plan file:
   - Look in `.tasks/*/plan/phase-${phase_number}-*.md`
   - If no plan file exists, report: "No plan found for phase
     $phase_number. Run /plan-phase [task_slug] first to create a plan."

3. Update state.json to mark the phase as in progress BEFORE spawning
   Builder:
   - If you have `mcp__state-manager__*` tools: use `state_update` to
     set `status` to "in_progress", `owner` to "builder", and `started`
     to the current ISO-8601 timestamp
   - Otherwise, use Edit on the task's `state.json`: set `status` to
     "in_progress", `owner` to "builder", `started` to current timestamp
   - PAV's scanner picks up this status change to show the phase as
     "In Progress" on the kanban board with "Builder" as the current agent

4. Spawn Builder to implement the plan:
   - Use the Task tool to spawn a Builder subagent
   - Instruct Builder: "Implement Phase $phase_number. Read the plan at
     .tasks/[task_slug]/plan/phase-$phase_number-[name].md. Follow the
     plan's implementation steps exactly."
   - Builder's quality gates from Phase 1 fire automatically:
     PostToolUse hook runs validation after each Edit/Write
     Stop hook blocks completion without validation evidence
   - No manual validation needed — the hooks enforce it

5. After Builder completes, report the results. Do NOT mark the phase
   as done — use /ship to commit changes and update state.

## PAV Integration

- **Reads:** `state.json` phase matching `$phase_number` — PAV's scanner
  shows phase status and details on the kanban board (257 P3)
- **Writes:** `status: "in_progress"`, `owner: "builder"`, `started`
  timestamp — PAV's scanner picks up these changes to display the phase
  as "In Progress" with "Builder" as the active agent
- **Quality gates:** Builder's PostToolUse hook output (`[quality-gate:FAIL]`
  / `[quality-gate:PASS]` tag-prefix format) appears in PAV's transcript
  view (257 P8) — structured for PAV rendering, human-readable in terminal
- **Invocation:** PAV can invoke this command via socket steering or Agent
  SDK to start building from its UI
