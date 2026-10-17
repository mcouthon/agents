# Branch-Aware Worktree Heuristic via SessionStart Hook

> **Status: SUPERSEDED** (task 128, phase 0, October 2026). The
> `worktree-heuristic.sh` SessionStart hook and its branch-aware checkout/pull
> logic are deleted. Where a session runs is now decided by whoever launched
> it (PAV, `a cc`, `--worktree`); agents do not create branches or worktrees
> unless the user asks. See task 128 in `.tasks/128-pav-agents-determinism/`
> for the full rationale and the behaviour table that replaces this ADR.

**Source:** Task 124 (October 2026); evolved through three stages — task 099
(worktree-by-default, never implemented) → task 124 Phase 1 (launcher-based
branch-aware heuristic) → task 124 Phase 5 (hook-based, per user direction).

**Criteria met:** cross-cutting — the SessionStart hook fires for every
Conductor, Explorer, Builder, and Courier session regardless of launch
method; future work must extend the hook or consciously replace it; not
derivable — the code shows the branch checks but not why the heuristic
moved from the launcher to a hook (the user mostly launches agents
directly with `claude --agent`, bypassing the `a-*` wrappers); new/reversing
— replaces the launcher-based approach and reverts the `a-*` launchers to
pre-task standalone scripts; extends, without duplicating,
[ADR-012](ADR-012-worktree-tasks-resolution.md).

## Decision

The branch-aware worktree heuristic runs as a **Claude Code SessionStart
hook** (`hooks/worktree-heuristic.sh`), not in the `a-*` launchers. The hook
fires before the agent begins reasoning, for all launch methods (direct
`claude --agent` and `a-*` wrappers). The `a-*` launchers are reverted to
standalone scripts with no worktree logic.

| Situation at launch                                   | Hook action                                           | Hook output                              |
| ----------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| On `main`/`master`                                     | None                                                  | No output (agent proceeds)               |
| On a branch fully merged to the default remote branch  | `git checkout <default> && git pull --ff-only`       | Brief confirmation                        |
| On an active (non-merged) branch                       | None                                                  | Context telling agent to ask user         |
| Already inside a linked worktree                       | None                                                  | No output (no nesting)                    |
| Non-git directory or git error                         | None                                                  | No output                                 |

Git's own output from `checkout` and `pull` goes to stderr so it does not
pollute the injected context; the confirmation echo fires only when both
commands succeed. The hook suggests the universally available `git worktree
add <path> -b <branch>` (not the repo-local `scripts/worktree.js`, which
does not exist in consumer repos). In the agents repo itself, `npm run
worktree -- add` (per [ADR-012](ADR-012-worktree-tasks-resolution.md))
remains available and wraps the same git command with task-state wiring.

## Why

- **Fires for all launch methods.** The launcher-based approach only worked
  for `a-*` wrapper launches. Users who invoke `claude --agent <Agent>`
  directly (the common case) never got the heuristic. The hook fires
  regardless of launch method.
- **Deterministic.** The hook runs before the agent begins reasoning, so the
  worktree decision is made before any agent logic. Agent templates and
  global rules now carry action instructions so the agent knows what to do
  with the injected context (ask the user, create a worktree, etc.) — the
  hook injects context; the instructions tell the agent how to act on it.
- **No surprise worktrees.** On `main`/`master` the hook does nothing; on an
  active branch it injects context for the agent to ask the user. The hook
  never creates worktrees — the agent or user creates them via
  `npm run worktree -- add` when the context prompts it.

## Problem Statement

The heuristic needed to fire for every agent session, not just those
launched via the `a-*` wrappers. Moving the logic into agent template prose
(agent instructions) would be non-deterministic — the agent might or might
not follow the instructions. A SessionStart hook runs deterministically as a
subprocess before the agent starts, for all launch methods.

## Key Architectural Decisions

### Heuristic in a SessionStart hook, not the launcher

The hook runs deterministically before the agent starts, for all launch
methods. The launcher-based approach (Phase 1) only worked for `a-*`
wrapper launches — users who launched agents directly with `claude --agent`
bypassed the heuristic entirely.

### Context injection via stdout

The hook outputs factual context to stdout, which Claude Code adds to the
agent's context as a system reminder. The agent acts on this context (asks
the user, creates a worktree, etc.). Output is factual, not imperative,
avoiding prompt-injection defenses.

### Git mutation in the hook (carve-out from DD5/ADR-012)

ADR-012's Design Decision 5 states "all git mutation stays in
`scripts/worktree.js`." The hook performs `git checkout` and `git pull`
directly, outside `worktree.js`. This is a deliberate carve-out: the hook
runs as a pre-session subprocess, not via `npm run` (whose banner would
pollute stdout capture — the original DD5 rationale, which does not apply
here). The hook does not create worktrees — that remains a manual step
via `npm run worktree -- add` or `scripts/worktree.js`.

## Consequences

- **Positive:** fires for all launch methods; deterministic; template action
  instructions and global-rules guidance complement the hook so agents know
  how to act on injected context; no "primary vs subagent" guard needed
  (SessionStart does not fire for subagents — they fire `SubagentStart`, and
  global rules cover them). A belt-and-braces guard exits silently if
  `agent_id` is present in the stdin JSON.
- **Negative:** the hook cannot detect a "worktree" keyword in the user's
  prompt; the hook cannot change the agent's cwd (the
  agent must `cd` or the user must restart); `a-<agent> continue` in a
  worktree loses the main-checkout `.tasks/` fallback (pre-task regression —
  the reverted `current_task()` reads `${PWD}/.tasks` only). If
  `refs/remotes/origin/HEAD` is unset (repos without it), the merged-branch
  case silently degrades to the "ask user" context — acceptable but worth
  noting.
- **Neutral:** behavior inside an existing worktree, in non-git directories,
  and on git errors is unchanged from the launcher-based approach (no
  action).

## See Also

- [ADR-012](ADR-012-worktree-tasks-resolution.md) — the concurrent-workloads
  decision this builds on: worktree-per-workstream isolation and the
  auto-derived shared `.tasks/`.

## Updates

| Date         | Task  | Summary                              |
| ------------ | ----- | ------------------------------------ |
| October 2026 | 126   | Extended hook coverage to Builder and Courier; changed hook suggestion from repo-local `scripts/worktree.js` to repo-agnostic `git worktree add` for consumer-repo portability; added global-rules worktree guidance and template action instructions so agents know how to act on hook-injected context (the ADR's original "no agent prose needed" claim no longer holds). |
