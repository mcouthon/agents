# Worker Agent Elimination

**Source:** Task 045 (April 2026)

## Decision

Eliminated the Worker agent entirely from the framework. Redistributed its responsibilities: Builder handles status updates inline, and Committer marks phases Done after a successful commit.

## Why

- Builder already runs on Sonnet (the same model Worker used), making Worker redundant
- Worker existed solely for lightweight status updates and git introspection — tasks Builder can handle directly
- Removing Worker reduces the agent roster from 5 to 4 user-invokable agents and simplifies the orchestration graph
- The previous design had Builder mark phases Done prematurely, before Reviewer and Committer had run; this created ambiguity about whether a phase truly completed the full cycle

## Problem Statement

Worker was a thin wrapper agent with two responsibilities:

1. Update task status to "🔄 In Progress" before Builder ran
2. Update task status to "✅ Done" after Committer ran
3. Run `git status --porcelain` during resume flow

This created overhead without value:

| Issue | Detail |
| --- | --- |
| Redundant model | Worker and Builder both used Sonnet — same capability, extra invocation |
| Premature Done marking | Builder also marked Done immediately after implementation, before Reviewer ran |
| Extra orchestration hops | Conductor called Worker → Builder → Reviewer → Committer → Worker — 5 agents for one cycle |
| Unclear ownership | Two agents (Builder and Worker) both wrote to task.md with overlapping timing |

## Solution

### Status Flow (Before)

```
Conductor
  └── Worker (set 🔄 In Progress)
  └── Builder (implement; also set ✅ Done — premature)
  └── Reviewer
  └── Committer
  └── Worker (set ✅ Done — authoritative)
```

### Status Flow (After)

```
Conductor
  └── Builder (first action: set 🔄 In Progress; implement only)
  └── Reviewer
  └── Committer (after commit: set ✅ Done)
```

### Status Ownership

| Status | Owner | Trigger |
| --- | --- | --- |
| ⭐ Reviewed | Explorer | Phase plan is reviewed and approved |
| 🔄 In Progress | Builder | First action at start of implementation |
| ✅ Done | Committer | After successful `git commit` |

### Changes Made

| Phase | Change |
| --- | --- |
| 1 — Committer | Added `.tasks/` edit capability; marks ✅ Done after commit; added file-edit constraint guardrail |
| 2 — Builder | Removed premature Done marking from "After Completing a Phase"; status stays 🔄 In Progress until Committer runs |
| 3 — Conductor | Removed 3 Worker calls (2c.0 status update, 2f Done update, resume-flow git check); merged In Progress update into Builder's prompt |
| 4 — Builder/Reviewer | Removed Worker from subagent delegation tables |
| 5 — Delete Worker | Deleted `worker.template.md`; removed Worker from all documentation |
| 6 — Install cleanup | Added stale-file removal to `install.sh` so old generated Worker files are purged on reinstall |

### Agent Roster (After)

| Agent | User-Invokable | File Edits | Role |
| --- | --- | --- | --- |
| Explorer | Yes | `.tasks/` only | Research + planning |
| Builder | Yes | Full codebase | Code implementation |
| Reviewer | Yes | None | Code review and verification |
| Committer | Yes | `.tasks/` only | Git commits + phase completion |

## Key Insights

1. **Responsibility should follow capability**: Committer already knows when a commit succeeds — it is the natural owner of Done marking. Worker was a detour.
2. **Premature Done was a hidden bug**: Builder marking Done before Reviewer ran could mislead the Conductor into thinking a phase was complete when functional review hadn't happened yet.
3. **Consolidation enables clarity**: Each agent now has a single, unambiguous write domain (Builder owns code; Committer owns phase completion status).

## See Also

- [ADR-003](ADR-003-agent-consolidation.md) — Earlier consolidation: Research + Plan → Explorer
- [ADR-001](ADR-001-orchestration-and-subagents.md) — Orchestration and subagent architecture
