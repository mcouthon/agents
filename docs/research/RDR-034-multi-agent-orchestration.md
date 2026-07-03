# RDR-034: Multi-Agent Orchestration (Gas Town, Beads, Gas City)

| Field      | Value                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source** | [Gas Town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04), [Beads](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a), Gas City (SDK), [Water Town](https://motherduck.com/blog/water-town-agent-swarm-data-stack/), CC orchestration tools (11 evaluated), PAV app |
| **Date**   | 2026-07-02                                                                                                                                                                                                                                                                 |
| **Status** | Partially Adopted                                                                                                                                                                                                                                                          |

## Summary

Comprehensive research into Steve Yegge's multi-agent ecosystem (8-stage maturity model, Gas Town orchestrator, Beads state management, Gas City SDK) and 11 CC orchestration tools, culminating in a layered architecture decision: keep AGENTS as the session-behavior layer, adopt select Beads patterns into AGENTS as backward-compatible extensions, and extend PAV (existing personal assistant app) as the orchestration/UI layer.

## Decision

**Adopted (into AGENTS as backward-compatible extensions):**

- `state.json` -- machine-readable phase state alongside human-readable `task.md`
- `parallel_group` -- phase annotations for concurrent execution eligibility
- `execution_metadata` -- advisory model/effort hints in phase plan frontmatter
- Session prime pattern -- compact context summary at session start
- Flag protocol (from Water Town) -- Observation/Order/Flag communication model
- `blocked_by` dependency edges between phases

**Adopted (architecture decision):**

- Extend PAV as orchestration UI layer (subprocess launcher, SSE streaming, notifications already exist)
- Separate concerns: AGENTS = session behavior (pure prompts), orchestrator = session lifecycle (runtime)

**Rejected:**

- Dolt database (100MB binary, conflicts with zero-dependency philosophy)
- Gas City wholesale (heavyweight for 3-5 agent scale; 958-star SDK with pack ecosystem)
- Inter-agent messaging (Conductor handles coordination at current scale)
- Merge queues / Refinery (premature at <10 agents)
- Patrol workers / health checks (unnecessary until autonomous multi-day execution)
- Worker role taxonomy (Mayor/Deacon/Polecat -- designed for 20-30 agents)
- Gas Town's hardcoded 7-role hierarchy (Gas City already deconstructed this)

## Key Insight

AGENTS and orchestration solve different problems at different layers. AGENTS defines how agents *behave* inside a session (roles, tools, quality gates). An orchestrator defines how sessions are *spawned, routed, monitored, and coordinated* outside sessions. Mixing them would break AGENTS' zero-dependency, pure-prompt design. The right path: adopt Beads' structured-state patterns into AGENTS (backward-compatible JSON alongside markdown), build the orchestration runtime separately.

## See Also

- [Detailed research files](.tasks/gas-town-research/) -- 8 research documents
- [RDR-005](RDR-005-beads.md) -- Original Beads evaluation (Future Consideration -> now Partially Adopted)
- [framework-comparison.md](../synthesis/framework-comparison.md) -- Gas Town/Beads/Gas City section
- [memory-and-continuity.md](../synthesis/memory-and-continuity.md) -- State management patterns
