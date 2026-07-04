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

## See Also

- [memory-and-continuity.md](../../docs/synthesis/memory-and-continuity.md) — Full memory strategy
- [RDR-005-beads.md](../../docs/research/RDR-005-beads.md) — Beads for multi-session memory (future)
- [ADR-011](ADR-011-machine-readable-state.md) — extends this pattern with a machine-readable `state.json` shadow

## Updates

| Date     | Task | Summary                                                                                |
| -------- | ---- | -------------------------------------------------------------------------------------- |
| Jul 2026 | 089  | `.tasks/[NNN-slug]/` now also carries a machine-readable `state.json` shadow (ADR-011) |
