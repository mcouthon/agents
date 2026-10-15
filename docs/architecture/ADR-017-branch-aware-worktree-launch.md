# Branch-Aware Worktree Launch in the `a-*` Launchers

**Source:** Task 124 (October 2026); initially planned as worktree-by-default in
task 099 (worktree-launch-agent, never implemented), revised to branch-aware per
user preference (2026-10-15).

**Criteria met:** cross-cutting — every `a-*` launcher must route through
`maybe_worktree()` and the `worktree.js --print-path` stdout contract; future
launcher work must follow it or consciously reverse it; not derivable — the
code shows the branch checks but not why worktree-by-default was rejected
(surprise worktrees in the common main-checkout case) or why the heuristic
lives in the launcher, not the agent; new/reversing — reverses task 099's
never-implemented worktree-by-default plan and extends, without duplicating,
[ADR-012](ADR-012-worktree-tasks-resolution.md).

## Decision

The `a-*` launchers use a **branch-aware heuristic** (in the shared
`scripts/bin/_a-common.sh` core) to decide whether to create a git worktree at
launch. The interactive surface is `a-<agent> [continue] [worktree]` — the two
keywords are order-independent:

| Situation at launch                                   | Behavior                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| On `main`/`master`                                     | Launch in place — no worktree.                                |
| On a branch fully merged to the default remote branch  | Switch to the default branch, pull, launch in place.          |
| On an active (non-merged) branch                       | Ask interactively: continue here or create a worktree.        |
| Explicit `worktree` keyword                            | Always create a worktree (`wt/<agent>-<timestamp>`), bypassing the heuristic. |
| Already inside a linked worktree                       | Launch in place — no nesting.                                 |
| Non-git directory or git error                         | Launch in place.                                              |

All git mutation stays in `scripts/worktree.js` (per
[ADR-012](ADR-012-worktree-tasks-resolution.md)); the launcher calls
`node scripts/worktree.js add <branch> --print-path` and captures the bare
absolute path from stdout. A non-TTY stdin skips the interactive prompt and
launches in place.

## Why

- **No surprise worktrees.** Worktree-by-default created a worktree on every
  launch from the main checkout — too aggressive for users who want to work
  directly on the main checkout (the common case).
- **Isolation is targeted at the scenario that benefits from it.** An active
  (non-merged) branch is exactly the state where a second concurrent workstream
  would collide; that is the only case where the heuristic intervenes.
- **Works for direct `claude --agent` callers.** The heuristic lives only in
  the `a-*` launcher scripts — it is not required for agent operation. Users
  who invoke `claude --agent <Agent>` directly keep full functionality and
  simply opt into worktrees manually (`npm run worktree -- add`).

## Problem Statement

The launcher needed to decide per launch whether the user's current checkout
state warrants a worktree. Auto-creating on every launch surprised users on the
main checkout; never creating pushed the full lifecycle burden back onto manual
commands. The heuristic had to distinguish merged branches (safe to just update
the checkout) from active ones (where a worktree is the isolation win), stay
silent in worktrees and non-git contexts, and remain overridable in one
keystroke.

## Key Architectural Decisions

### Heuristic in the launcher, not the agent

The decision is made before the agent starts, in `maybe_worktree()` in the
shared launcher core. Agents have no worktree logic — they simply run in
whatever directory the launcher landed them in, and the state server's
`.tasks/` rollup (ADR-012) makes either location work identically.

### Interactive-only surface

`a-<agent> [continue] [worktree]` replaces the previous `a-<agent> [continue]`
plus custom-prompt arm (`a-<agent> "prompt"` is dropped). The `worktree`
keyword is the explicit override for power users who want a worktree
regardless of branch state.

## Consequences

- **Positive:** no surprise worktrees; worktrees are created only when the
  user is on an active branch and opts in interactively, or passes the explicit
  `worktree` keyword; merged branches self-heal (switch to default + pull) so
  stale checkouts don't accumulate.
- **Negative / cost:** slightly more complexity than unconditional
  auto-create; the interactive prompt does not work in non-TTY contexts —
  handled by skipping the prompt and launching in place.
- **Neutral:** behavior inside an existing worktree, in non-git directories,
  and on git errors is unchanged from plain launch (in place).

## See Also

- [ADR-012](ADR-012-worktree-tasks-resolution.md) — the concurrent-workloads
  decision this builds on: worktree-per-workstream isolation and the
  auto-derived shared `.tasks/`.
