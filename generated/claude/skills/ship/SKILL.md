---
name: ship
description: "Ship the current phase — commit changes and mark the phase checked. Spawns Committer to create a semantic commit, then marks the phase done with check_phase. Use after Builder and Reviewer complete. User-triggered only. Triggers on: '/ship', 'ship it', 'commit and ship', 'ship the phase'."
disable-model-invocation: true
allowed-tools: [Read, Bash, "Task(Committer)", mcp__state-manager__prime, mcp__state-manager__check_phase]
---

# Ship the Current Phase

## Live State

Git status:
!`git status --short`

If no changes are shown, there may be nothing to ship.

## What to do

1. Review the injected git status above — it shows uncommitted changes
   ready to ship.

2. Call `prime` on the task. Its `advice` names the phase to ship (the
   Conductor's loop: `prime` → plan → approve → build → review → accept →
   commit → `check_phase`). If the move is not `commit`, report what it says
   and stop; for example, "Use /build-phase N to start building first."

3. Invoke Committer to create a semantic commit:
   - Use the Task tool to spawn a Committer subagent
   - Committer will stage changes, create a semantic commit message,
     and commit

4. After Committer completes, call `check_phase` for the phase. It is the
   one progress writer: it marks the phase done and checking it twice
   changes nothing.

5. Report: phase shipped, commit hash, and what's next (call `prime` again:
   the next phase to plan or build, `land`, or task complete if every phase
   is checked).

## Notes

- **Access control:** `disable-model-invocation: true` ensures only the
  user can trigger shipping — the model cannot self-ship.
