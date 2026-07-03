# RDR-005: Beads Memory System

| Field      | Value                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ |
| **Source** | https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a |
| **Date**   | 2025-12-29                                                                                 |
| **Status** | Partially Adopted (via [RDR-034](RDR-034-multi-agent-orchestration.md))                    |

## Summary

Issue-tracker-based memory system for AI agents. Uses JSONL files in git with CLI queries (`bd ready --json`) instead of "write-only" markdown files.

## Decision

**Not Adopted (Yet):**

- Adds CLI tooling dependency and new workflow
- Current task-centric persistence works for single-session tasks
- Framework scope is single-session; Beads is for multi-session memory

**When to Revisit:**

- Multi-day features become common
- Session context overflow blocks work
- "Where was I?" questions frequent at session start

## Key Insight

Markdown files are "write-only memory"—agents can write them but can't query them. Don't try to make markdown smarter; use a different data structure (issue tracker) with structured queries.

## See Also

- [memory-and-continuity.md](../synthesis/memory-and-continuity.md) — Current memory strategy
- [ADR-002](../architecture/ADR-002-task-centric-persistence.md) — Adopted task-centric persistence (complementary)
