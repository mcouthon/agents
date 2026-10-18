# Enforcement Hooks (Global, Agent-Type-Gated)

**Source:** Task 128, Phase 4 (October 2026)

## Decision

Everything the Conductor had to remember becomes a set of globally installed
hooks, each a shell stub calling `a hook <name>`, with logic in
`scripts/lib/hook.js`. One per-agent-type guard table
(`scripts/lib/guards.js`) determines which hooks are active and how they
behave for each agent type. The hooks are installed by `install.sh` via
`scripts/install-global-hooks.js` into `~/.claude/settings.json`, idempotent by
command path (D27).

## Hooks

| Hook | Event / matcher | Does |
|---|---|---|
| `prime` | UserPromptSubmit, SessionStart | Injects `a next` context (step, phase, plan, knobs) as `additionalContext`; lease touch |
| `spawn-guard` | PreToolUse `Agent\|Task` | Denies off-sequence spawns; rewrites the prompt via `updatedInput` to prepend the canonical context block |
| `report-parser` | SubagentStop | Extracts the last JSON block, validates per schema, persists via `a report`; exit 2 on invalid |
| `checkpoint-capture` | Pre/PostToolUse `AskUserQuestion` | Opens and resolves checkpoints; records a user-attributed pass (D31) |
| `git-guard` | PreToolUse `Bash` | Tokenises the command, enforces git/gh policy by main root + agent type |
| `manifest-guard` | PreToolUse `Edit\|Write\|MultiEdit\|NotebookEdit` | File-scope rules per the guard table |
| `quality-gate` | PostToolUse `Bash` + Stop | Records validation exit codes; blocks Stop on stale edits |
| `conductor-stop` | Stop | Blocks when no state advance happened this turn |
| `plan-lint` | PostToolUse `Write` | Lints plan files and task.md on write |
| `courier-stop` | Stop | Validates and persists Courier's top-level builder report (D15) |

## Failure policy (D13)

Three cases, so a broken `a` under global hooks never bricks the machine:

- **Unbound session, or binding undeterminable** → a failing guard no-ops
  silently (exit 0, never denies). Includes a missing or stale `a` binary.
- **Bound session, guard exception** → deny with `enforcement unavailable:
  <err>`; under `enforcement: warn` → warn (allow) and append to
  `phase.warnings`.
- **Injector exception** (prime, spawn-guard context injection) → silent
  no-op; injection must never block a prompt or a spawn.

## D30 — git-guard AGENTS_LAND allow-list

`AGENTS_LAND=1` in the guard's own process env unlocks exactly: push-to-base,
merge, rebase, branch delete, checkout — nothing else. Every other rule still
applies. The guard reads its own process env only; an `AGENTS_LAND=1` prefix
inside the Bash command string grants nothing (env-prefix assignments are
tokenised as assignments, not consulted). Second factor: the landing lock
`~/.agents/locks/<repo-key>.land.lock` must be held.

## D31 — user-attributed verdicts

Reviewer reports accept optional `attributed_to: "reviewer"|"user"`. When a
user resolves a plan review at a checkpoint, `checkpoint-capture` records a
pass with `attributed_to: "user"`, and `reviewer_verdict_pass` treats it as
satisfying `planned → reviewed` without flipping `review_plan`/`approve`
knobs.

## Consequences

- Per-agent frontmatter hooks are removed from templates (except
  `disallowedTools`); hooks are global.
- The old `post-edit-validate.sh`, `subagent-validate.sh`,
  `model-switch-logger.sh` are deleted; `quality-gate.sh` is replaced by the
  shell stub.
- `install.sh` owns `~/.local/bin/a` — nothing in this phase re-points it
  (A6 incident).
- `a doctor` ships as the hook-wiring check only (the full `a doctor` is A10).
- Task 128's `enforcement` knob is flipped back to `deny` after the hooks
  land (D32 closeout); the warn-through transitions replayed under deny pass
  with no new warnings.
