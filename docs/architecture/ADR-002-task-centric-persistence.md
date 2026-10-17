# Task-Centric Persistence (.tasks/ Pattern)

**Source:** RDR-018, PR #2 (January 2026)

## Decision

Research and planning artifacts persist to `.tasks/[NNN-slug]/` directories with descriptive filenames. Explorer agent has scoped write access limited to `.tasks/`.

## Why

- Enables multi-session continuity for complex tasks
- Scoped write access maintains read-only safety for codebase
- Predictable location for task resumption ("continue task 012")
- Audit trail of decisions and exploration
- Users can review and edit plans before implementation

## Problem Statement

Without persistence:

- Research lost between sessions
- Users couldn't say "continue working on X"
- No central location to track multi-phase work
- Explorer had to be pure read-only (couldn't save findings)
- Knowledge accumulated during exploration was discarded

The original Explorer agent was strictly read-only. This protected the codebase but meant all research findings existed only in context—they couldn't survive session boundaries.

## Solution

### Before

```
Session 1: User → Explorer → (research in context only) → session ends, research lost
Session 2: User → Explorer → (repeat research from scratch)
```

### After

```
Session 1: User → Explorer → .tasks/012-feature/task.md → session ends
Session 2: User → "continue task 012" → Explorer reads .tasks/012-feature/ → resumes
```

### Directory Structure

```
.tasks/
├── [NNN-slug]/
│   ├── task.md          # Main research + phase table (human source of truth)
│   ├── state.json       # Machine-readable shadow (MCP-managed) — see ADR-011
│   └── plan/
│       └── phase-N-*.md # Detailed phase plans
└── architecture/
    └── ADR-*.md         # Cross-cutting decisions
```

### Naming Convention

| Element | Format                | Example               |
| ------- | --------------------- | --------------------- |
| NNN     | 3-digit number        | `012`                 |
| slug    | 2-4 words, hyphenated | `research-reorg`      |
| Full    | `NNN-slug/`           | `012-research-reorg/` |

Numbers are monotonically increasing. Slugs are human-readable descriptions.

### Explorer's Scoped Write Access

| Access Type | Location    | Allowed?         |
| ----------- | ----------- | ---------------- |
| Write       | `.tasks/**` | ✅ Yes           |
| Write       | `src/**`    | ❌ No (codebase) |
| Write       | `docs/**`   | ❌ No (codebase) |
| Read        | Anywhere    | ✅ Yes           |

**Philosophy:** Writing task files ≠ writing code. Task files are planning artifacts, not production deliverables.

### Task File Structure

```markdown
---
task: Brief description
slug: short-identifier
created: YYYY-MM-DD
status: planning | in-progress | done
---

# Task Name

## Phases

| #   | Phase | Status      | Plan                    | Notes |
| --- | ----- | ----------- | ----------------------- | ----- |
| 1   | Name  | ⭐ Reviewed | [link](plan/phase-1.md) | ...   |

## Overview

[Research findings and context]

## Goal

[What success looks like]
```

## Key Insights

The exception to read-only philosophy: Explorer can write to `.tasks/` because these are planning artifacts, not production code. This distinction enables session resumability without compromising codebase safety.

Phase status progression: `⬜ Not Started → 📋 Planned → ⭐ Reviewed → 🔄 In Progress → ✅ Done`

> **Superseded Oct 2026** (Task 128, Phase 3) — status now lives in `task.json`
> v2, not `task.md`. See the amendment below.

## Amendment: task.json v2 as Single Source of Truth; state.md Rendered; task.md Prose-Only (Oct 2026)

**Source:** Task 128 (`pav-agents-determinism`), Phase 3.

### Problem

`task.md` was the human source of truth and `state.json` its machine-readable
shadow (ADR-011). Both were written by agents at the same transition points,
but they disagreed on 13 of 36 tasks. The phase status column in `task.md`
was hand-maintained, drift-prone, and redundant with `state.json`.

### Decision

1. **`task.json` v2 is the single source of truth for task state** — phases,
   owners, counters, checkpoints, lease, binding, reports, and mode all
   live in `task.json`. The v2 schema supersedes `state.json` (v1); `a task
   migrate` converts v1 → v2 in place (idempotent, preserves A2-stamped
   fields). See ADR-011's Oct 2026 amendment for the transition table and
   enforcement.
2. **`state.md` is rendered from `task.json` on every write** — frontmatter,
   phase table, open checkpoints, flags, counters, lease/binding, last
   activity. It is a derived view, never authored.
3. **`task.md` keeps authored prose but no status column** — `a plan lint`
   rejects status columns or status emojis in the phases table. The status
   lives in `task.json`; `task.md` retains the phase table for human
   readability (names, deps, notes) without the status column.

### What does NOT change

- **`task.md`'s role as the human-authored narrative** — research findings,
  phase descriptions, decisions, and goals stay in `task.md`.
- **The `.tasks/[NNN-slug]/` directory structure** — same layout, with
  `task.json` replacing `state.json` and `state.md` added alongside `task.md`.

## See Also

- [memory-and-continuity.md](../../docs/synthesis/memory-and-continuity.md) — Full memory strategy
- [RDR-005-beads.md](../../docs/research/RDR-005-beads.md) — Beads for multi-session memory (future)
- [ADR-011](ADR-011-machine-readable-state.md) — extends this pattern with a machine-readable `state.json` shadow

## Updates

| Date     | Task | Summary                                                                                |
| -------- | ---- | -------------------------------------------------------------------------------------- |
| Jul 2026 | 089  | `.tasks/[NNN-slug]/` now also carries a machine-readable `state.json` shadow (ADR-011) |
| Oct 2026 | 128  | `task.json` v2 replaces `state.json` as the single source of truth for task state; `state.md` rendered from `task.json` on every write; `task.md` keeps authored prose but no status column (enforced by `a plan lint`); `a task migrate` converts v1 → v2 idempotently |
