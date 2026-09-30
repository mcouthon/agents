---
name: ship
description: "Ship the current phase — commit changes and update state.json. Spawns Committer to create a semantic commit, then marks the in-progress phase as done in state.json. Use after Builder and Reviewer complete. User-triggered only. Triggers on: '/ship', 'ship it', 'commit and ship', 'ship the phase'."
disable-model-invocation: true
allowed-tools: [Read, Edit, Write, Bash, "Task(Committer)"]
---

# Ship the Current Phase

## Live State

Git status:
!`git status --short`

In-progress phase:
!`cat .tasks/*/state.json 2>/dev/null | jq -r '.task as $t | .phases[] | select(.status == "in_progress") | "Task: \($t) — Phase \(.id): \(.name)"'`

If no in-progress phase is shown, there may be nothing to ship.

## What to do

1. Review the injected git status above — it shows uncommitted changes
   ready to ship.

2. Review the injected state — it shows the in-progress phase. If no
   phase is in_progress, report: "No phase is in progress. Use
   /build-phase N to start building first."

3. Invoke Committer to create a semantic commit:
   - Use the Task tool to spawn a Committer subagent
   - Committer will stage changes, create a semantic commit message,
     and commit

4. After Committer completes, update state.json to mark the phase as done:
   - If you have `mcp__state-manager__*` tools: use `state_update` to
     set `status` to "done", `completed` to current ISO-8601 timestamp,
     and `owner` to null
   - Otherwise, use Edit on the task's `state.json`: set `status` to
     "done", `completed` to current timestamp, `owner` to null
   - PAV's scanner picks up this status change to move the phase to
     "Done" on the kanban board

5. Report: phase shipped, commit hash, and what's next (next phase to
   plan/build, or task complete if all phases are done).

## PAV Integration

- **Reads:** `state.json` phases where `status == "in_progress"` and git
  status — PAV's scanner shows in-progress phases on the kanban board
- **Writes:** `status: "done"`, `completed` timestamp — PAV's scanner
  moves the phase to "Done" on the kanban board (257 P3)
- **Access control:** `disable-model-invocation: true` ensures only the
  user (or PAV acting on the user's behalf via socket steering) can
  trigger shipping — the model cannot self-ship
- **Invocation:** PAV can invoke this via socket steering (257 P5) as a
  user-initiated action from its UI
