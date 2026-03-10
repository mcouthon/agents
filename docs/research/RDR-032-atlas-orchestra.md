# RDR-032: Atlas & Orchestra Orchestration Patterns

| Field      | Value                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source** | [Github-Copilot-Atlas](https://github.com/bigguy345/Github-Copilot-Atlas), [copilot-orchestra](https://github.com/ShepAlderson/copilot-orchestra) |
| **Date**   | 2026-02-14                                                                                                                                        |
| **Status** | Partially Adopted                                                                                                                                 |

## Summary

Two related orchestration frameworks for VS Code Copilot. Orchestra provides conductor-delegate pattern with TDD enforcement; Atlas extends it with explicit context conservation strategy and parallel execution. Both validate our approach.

## Decision

**Adopted:**

- Context Conservation guidance in conductor.agent.md (documents existing implicit behavior)
- TDD Workflow section in Builder agent

**Rejected:**

- Auto-handoff (conflicts with user-control philosophy)
- Separate Prometheus planner agent (Explorer already serves this role)
- `plans/` directory structure (our `.tasks/` is more comprehensive)
- Model selection hints (single model approach is simpler)

## Key Insight

Our subagent delegation model already provides context conservation — Atlas's "game changer" feature. Documenting this explicitly makes the benefit visible.

Our unique strengths they lack: askQuestions tool, richer phase status (⬜📋⭐🔄✅), phase-review skill, error escalation diagnosis, context independence per session.

## What Changed

- [conductor.agent.md](/.github/agents/conductor.agent.md): Added Context Conservation section
- [builder.agent.md](/.github/agents/builder.agent.md): Added TDD Workflow section

## See Also

- [Full research](.tasks/008-atlas-orchestra-research/plan/phase-2-research.md)
- [prevailing-wisdom.md](docs/synthesis/prevailing-wisdom.md)
