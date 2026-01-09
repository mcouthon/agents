# RDR-017: Task-Centric Persistence

**Status:** Adopted  
**Date:** 2026-01-09  
**Context:** [PR #2](https://github.com/mcouthon/agents/pull/2) (opinionated_file_workflow) introduced task-centric persistence

---

## Summary

Accept task-centric persistence from PR #2 with modifications: grant Explore scoped write access (only to `.tasks/`), remove optional step structure, remove write access from Review, and delete the now-redundant Handoff agent.

---

## Background

PR #2 proposed automatic persistence of agent outputs to `.tasks/[task-slug]/` directories. The original implementation added write tools to both Explore and Review agents, introduced an optional step structure for complex tasks, and converted all handoff buttons to in-context actions (same agent, `send: true`).

### Original PR Changes

| Component      | PR #2 Proposed                         |
| -------------- | -------------------------------------- |
| Explore        | Add edit tools, automatic persistence  |
| Review         | Add edit tools, persistence to review/ |
| Handoff        | Keep (but diminished role)             |
| Step structure | Optional `steps/` for complex tasks    |
| Handoffs       | All in-context (`send: true`)          |

---

## Decision

Accept the core value proposition (task-centric persistence) while trimming complexity:

### What Was Adopted

1. **`.tasks/` directory structure**: Research saved to `.tasks/[task-slug]/explore/`
2. **Descriptive filenames**: `auth_flow.md` instead of timestamps
3. **Task continuity UX**: "Continue working on X" pattern
4. **Scoped write access for Explore**: Edit tools restricted to `.tasks/` directory

### What Was Removed/Changed

1. **Optional step structure**: Removed (over-engineering for rarely-needed feature)
2. **Review write access**: Removed edit tools (Review reports, doesn't persist)
3. **Handoff agent**: Deleted (redundant now that Explore handles persistence)
4. **In-context-only handoffs**: Restored cross-agent handoffs alongside useful in-context actions

### Update-by-Default Behavior

Within a session, Explore updates the same file rather than creating new ones:

- Same session: Update existing file without prompting
- New session with existing task: Offer to update or create new
- New task: Suggest filename, save on confirmation

---

## Rationale

### Scoped Write Access (Philosophy Exception)

The framework's stated philosophy is that Explore is "read-only" to prevent accidental code modifications. We make a narrow exception:

> **Explore can write ONLY to `.tasks/` directory**—not the codebase.

This preserves the safety intent (can't accidentally modify code) while enabling convenience (no Handoff agent indirection).

### Why Remove Step Structure

The optional step structure (`steps/01-phase/explore/`) added cognitive load for a rarely-needed feature. Most tasks don't require multi-phase organization, and those that do can use multiple descriptive files in `explore/`.

### Why Remove Review Write Access

Review's purpose is to verify and report—not to persist. The pattern is:

- Review finds issues → hands off to Implement
- Review approves → hands off to Commit

Persisting review findings adds complexity without proportional benefit.

### Why Delete Handoff Agent

With Explore handling persistence directly to `.tasks/`, the Handoff agent became redundant. The original purpose (persist context for next session) is now fulfilled by Explore's save functionality.

---

## Comparison to Original Handoff Pattern

| Aspect            | Original            | New                     |
| ----------------- | ------------------- | ----------------------- |
| Persistence agent | Handoff             | Explore (scoped)        |
| Directory         | `.github/handoffs/` | `.tasks/`               |
| Filenames         | Timestamps          | Descriptive             |
| Organization      | Flat                | Task-centric            |
| Continuity        | Find handoff file   | "Continue working on X" |
| File updates      | Always new file     | Update-by-default       |

---

## Implementation

### Files Changed

- `.github/agents/explore.agent.md`: Updated description, simplified persistence, restored cross-agent handoffs
- `.github/agents/review.agent.md`: Removed edit tools, removed persistence logic, added cross-agent handoffs
- `.github/agents/implement.agent.md`: Removed step structure references
- `.github/agents/handoff.agent.md`: Deleted
- `README.md`: Updated agent table, handoff buttons, task continuity section
- `docs/synthesis/memory-and-continuity.md`: Updated to reflect new approach

### Agent Tool Access Summary

| Agent     | Tool Access                        |
| --------- | ---------------------------------- |
| Explore   | Read + Task Write (`.tasks/` only) |
| Implement | Full access                        |
| Review    | Read + Test                        |
| Commit    | Git + Read                         |

---

## References

- [PR #2](https://github.com/mcouthon/agents/pull/2) - Original proposal
- [RDR-005](./RDR-005-beads.md) - Issue tracker memory (future consideration)
- [RDR-009](./RDR-009-mcp-memory-rejected.md) - Why MCP memory servers were rejected
- [memory-and-continuity.md](../synthesis/memory-and-continuity.md) - Full memory strategy
