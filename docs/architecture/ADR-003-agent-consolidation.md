# Agent Consolidation (Research + Plan → Explorer)

**Source:** RDR-016 (January 2026)

## Decision

Merged Research and Plan agents into a single Explorer agent. Simplified workflow from 6 agents to 4 user-invokable agents, plus 2 internal subagents.

## Why

- Users preferred unified workflow over mode-switching
- Simpler mental model: one agent for understanding + planning
- Handoff determinism: single source format for downstream agents
- Reduced friction: no extra handoff between research and planning
- Phased structure in Explorer preserves the distinct cognitive modes

## Problem Statement

Originally had separate agents for different phases:

| Agent    | Responsibility        |
| -------- | --------------------- |
| Research | Understand codebase   |
| Plan     | Create implementation |

This created friction:

- Extra handoff step between Research → Plan
- Users confused about which to invoke ("should I research more or start planning?")
- Redundant context building (Plan re-read files Research already analyzed)
- Research findings lost if not explicitly handed off

## Solution

### Before (6 agents)

```
User → Research → Plan → Implement → Review → Commit
           │        │
           │        └── Creates implementation plan
           └── Understands codebase
```

### After (4 user-invokable + 2 internal)

```
User → Explorer → Builder → Reviewer → Committer
          │
          ├── Phase 1-3: Research codebase (was Research agent)
          └── Phase 4-5: Create plan (was Plan agent)

Internal subagents (user-invokable: false):
└── Researcher — context-isolated codebase research
```

### Current Agent Structure

| Agent      | User-Invokable | Role                         |
| ---------- | -------------- | ---------------------------- |
| Explorer   | ✅             | Research + planning combined |
| Builder    | ✅             | Code implementation          |
| Reviewer   | ✅             | Code review and verification |
| Committer  | ✅             | Git commit generation        |
| Researcher | ❌             | Internal: read-only subagent |

### Cognitive Mode Preservation

The original separation enforced different cognitive modes. Explore preserves these via phased steps:

| Phase | Mode       | Description                 |
| ----- | ---------- | --------------------------- |
| 1     | Intake     | Read mentioned files        |
| 2     | Decompose  | Break down into subproblems |
| 3     | Explore    | Systematic codebase search  |
| 4     | Synthesize | Connect findings into plan  |
| 5     | Persist    | Save to `.tasks/`           |

The cognitive modes aren't lost—they're internalized into Explore's workflow.

## Key Insights

Previously rejected this consolidation with rationale: "separation enforces different cognitive modes." Reversed because:

1. Explorer's phased steps preserve cognitive modes internally
2. Practical experience showed users prefer the unified workflow
3. Forced handoff between Research → Plan added friction without benefit

The key learning: cognitive mode separation is valuable, but it can be achieved through internal structure rather than external agent boundaries.

## See Also

- [memory-and-continuity.md](../../docs/synthesis/memory-and-continuity.md) — Updated workflow diagram
- [ADR-001](ADR-001-orchestration-and-subagents.md) — Subagent architecture
