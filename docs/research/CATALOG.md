# RDR Catalog

Quick reference for Research Decision Records.

> **Synthesis docs are authoritative** — RDRs document decisions, synthesis docs document the resulting patterns. When in doubt, consult [prevailing-wisdom.md](../synthesis/prevailing-wisdom.md).

## Synthesis Documents

Research was consolidated into synthesis docs. These are the authoritative references:

| File                                                              | Source RDRs                  | Theme                      |
| ----------------------------------------------------------------- | ----------------------------- | -------------------------- |
| [vscode-platform.md](../synthesis/vscode-platform.md)             | 014, 015, 031                 | VS Code features           |
| [framework-comparison.md](../synthesis/framework-comparison.md)   | 003, 022, 023, 024, 034, 035  | Industry best practices    |
| [memory-and-continuity.md](../synthesis/memory-and-continuity.md) | 010, 012, 025                 | Context and memory         |
| [skills.md](../synthesis/skills.md)                               | 004, 019, 027, 028            | Skill creation and testing |
| [ide-compatibility.md](../synthesis/ide-compatibility.md)         | 017, 029                      | Multi-IDE support          |

## Standalone RDRs

| File                                                                        | Status            | Summary                               |
| --------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| [RDR-005-beads.md](RDR-005-beads.md)                                        | Partially Adopted | Beads JSONL memory (via RDR-034)      |
| [RDR-013-vscode-browser-testing.md](RDR-013-vscode-browser-testing.md)      | Future            | Playwright browser testing            |
| [RDR-020-design-skill.md](RDR-020-design-skill.md)                          | Adopted           | Design skill creation                 |
| [RDR-030-vercel-agents-md-evals.md](RDR-030-vercel-agents-md-evals.md)      | Partially Adopted | Vercel eval study                     |
| [RDR-032-atlas-orchestra.md](RDR-032-atlas-orchestra.md)                    | Partially Adopted | Orchestra patterns                    |
| [RDR-033-spec-kit-sdd.md](RDR-033-spec-kit-sdd.md)                          | Adopted           | spec-kit SDD backport plan            |
| [RDR-034-multi-agent-orchestration.md](RDR-034-multi-agent-orchestration.md) | Partially Adopted | Gas Town/Beads/Gas City orchestration |
| [RDR-035-agentic-engineering-patterns.md](RDR-035-agentic-engineering-patterns.md) | Partially Adopted | Willison agentic engineering patterns |

**Note:** RDR-016 and RDR-018 superseded by ADRs. See [docs/architecture/](../architecture/) for ADR-002 (task persistence) and ADR-003 (agent consolidation).

## Quick Reference

| I want to understand...     | Start with                                                        |
| --------------------------- | ----------------------------------------------------------------- |
| VS Code settings & tools    | [vscode-platform.md](../synthesis/vscode-platform.md)             |
| External framework patterns | [framework-comparison.md](../synthesis/framework-comparison.md)   |
| Context/memory/subagents    | [memory-and-continuity.md](../synthesis/memory-and-continuity.md) |
| Skill creation & testing    | [skills.md](../synthesis/skills.md)                               |
| Multi-IDE compatibility     | [ide-compatibility.md](../synthesis/ide-compatibility.md)         |
| Why 4 agents not 6          | [ADR-003](../architecture/ADR-003-agent-consolidation.md)         |
| Task persistence approach   | [ADR-002](../architecture/ADR-002-task-centric-persistence.md)    |
| Skill-powered subagents     | [ADR-004](../architecture/ADR-004-skill-powered-subagents.md)     |
| IDE support strategy        | [ADR-005](../architecture/ADR-005-ide-compatibility.md)           |
| Skill creation example      | [RDR-020](RDR-020-design-skill.md)                                |
| Spec-kit planning backports | [ADR-010](../architecture/ADR-010-spec-kit-planning-backports.md) |
| Multi-agent orchestration   | [RDR-034](RDR-034-multi-agent-orchestration.md)                   |

## Research Backlog

See [BACKLOG.md](BACKLOG.md) for unchecked research items organized by category.

## Archive

Originals of consolidated RDRs, plus rejected/superseded research. See [archive/](archive/) for full documents.

| RDR | Title                        | Why Archived                             |
| --- | ---------------------------- | ---------------------------------------- |
| 001 | Spec-Driven                  | Rejected: spec files not used            |
| 002 | Context Cortex               | Rejected: memory bank not used           |
| 003 | Feature-Dev                  | Merged → framework-comparison.md         |
| 004 | Superpowers                  | Merged → skills.md                       |
| 006 | Agentic Future               | Informational only                       |
| 007 | mitsuhiko agent-stuff        | Superseded by RDR-018                    |
| 008 | Handoff Workspace Constraint | Superseded by RDR-018                    |
| 009 | MCP Memory                   | Rejected: too complex                    |
| 010 | Subagents Context Fork       | Merged → memory-and-continuity.md        |
| 011 | Protection Markers           | Feature removed                          |
| 012 | Planning with Files          | Merged → memory-and-continuity.md        |
| 014 | VSCode Copilot Settings      | Merged → vscode-platform.md              |
| 015 | Copilot Agent Tools          | Merged → vscode-platform.md              |
| 016 | Agent Consolidation          | Superseded by ADR-003                    |
| 017 | Agent Spec Compatibility     | Merged → ide-compatibility.md            |
| 018 | Task-Centric Persistence     | Superseded by ADR-002                    |
| 019 | Skill Review                 | Merged → skills.md                       |
| 021 | Agno                         | Rejected: out of scope                   |
| 022 | Six Tips for Agents          | Merged → framework-comparison.md         |
| 023 | Ralph Wiggum                 | Merged → framework-comparison.md         |
| 024 | Claude Code Mastery          | Merged → framework-comparison.md         |
| 025 | Copilot Memory               | Merged → memory-and-continuity.md        |
| 026 | MetaPrompts                  | Rejected: confirms existing approach     |
| 027 | Skill Subagents              | Merged → skills.md                       |
| 028 | Skills.sh                    | Merged → skills.md                       |
| 029 | Alternative IDE Support      | Merged → ide-compatibility.md            |
| 031 | 1.109 Orchestration          | Merged → vscode-platform.md              |
| —   | ai-project-system            | Rejected: different scope (project mgmt) |
| —   | agentops                     | Rejected: autonomous DevOps scope        |
