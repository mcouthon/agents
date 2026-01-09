# 🔬 Deep Research

Research external frameworks and materials to evaluate potential improvements to this framework.

## Process

1. Read [README](./README.md), [prevailing wisdom](./docs/synthesis/prevailing-wisdom.md), and [framework comparison](./docs/synthesis/framework-comparison.md) IN FULL
2. Pick the next unchecked item from the Research List
3. Read it fully—follow links as needed to grasp its insights
4. Create an RDR (Research Decision Record) in `docs/research/` using the [template](./docs/research/TEMPLATE.md)
5. **If adopting findings, update relevant synthesis docs:**
   - Core principles → [prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)
   - Framework comparisons → [framework-comparison.md](./docs/synthesis/framework-comparison.md)
   - Memory/continuity patterns → [memory-and-continuity.md](./docs/synthesis/memory-and-continuity.md)
6. Mark the item as checked and link to the RDR

## Guidelines

- **One item per iteration** - Don't read ahead
- **Small tweaks preferred** - Avoid unnecessary complexity
- **Big changes need justification** - Explain why the benefit outweighs the cost
- **Document everything** - Even rejections are valuable for future reference

## Adding New Research Items

Add URLs to the list above. Format after research:

- [x] short-name → RDR-NNN

## Research List

- [x] [spec-driven-development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/) → [RDR-001](docs/research/RDR-001-spec-driven.md)
- [x] [copilot-context-cortex](https://github.com/muaz742/copilot-context-cortex) → [RDR-002](docs/research/RDR-002-context-cortex.md)
- [x] [feature-dev-plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/feature-dev) → [RDR-003](docs/research/RDR-003-feature-dev.md)
- [x] [superpowers](https://github.com/obra/superpowers) → [RDR-004](docs/research/RDR-004-superpowers.md)
- [x] [beads-memory](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a) → [RDR-005](docs/research/RDR-005-beads.md)
- [x] [agentic-future](https://seconds0.substack.com/p/heres-whats-next-in-agentic-coding) → [RDR-006](docs/research/RDR-006-agentic-future.md)
- [x] [mitsuhiko-agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/improve-skill/SKILL.md) → [RDR-007](docs/research/RDR-007-mitsuhiko-agent-stuff.md)
- [x] Building my own tools for memory (MCP servers) → [RDR-009](docs/research/RDR-009-mcp-memory-rejected.md) (Rejected)
- [x] Create guidelines for plan file artifacts → Resolved: Use Research → Handoff workflow (documented in [README](README.md#the-workflow))
- [x] Combine Research + Plan agents → [RDR-016](docs/research/RDR-016-agent-consolidation.md) (Adopted: consolidated into Explore agent, reversing previous rejection)
- [x] Research whether Copilot subagents in VSCode fork the context, and start with a clean context. What of the main agent's context is being passed to those subagents? → [RDR-010](docs/research/RDR-010-subagents-context-fork.md) (Subagents fork context; adopted for parallel investigations in Research agent)
- [x] [planning-with-files](https://github.com/OthmanAdi/planning-with-files) → [RDR-012](docs/research/RDR-012-planning-with-files.md)
- [x] [vscode-browser-testing](https://code.visualstudio.com/docs/copilot/overview) → [RDR-013](docs/research/RDR-013-vscode-browser-testing.md)
- [x] [vscode-copilot-settings](https://code.visualstudio.com/docs/copilot/setup) → [RDR-014](docs/research/RDR-014-vscode-copilot-settings.md)
- [x] [copilot-agent-tools](https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features) → [RDR-015](docs/research/RDR-015-copilot-agent-tools.md) (Partially Adopted: added `usages` to Research/Explore/Plan, `changes` and `testFailure` to Review/Commit)
- [x] Research if there's a way to make the handoff agent deterministic → [RDR-016](docs/research/RDR-016-agent-consolidation.md) (Resolved: unified Explore output format with handoff format for verbatim copying)
- [x] Verify which parts of the agents specification follow are well defined (eg https://code.visualstudio.com/docs/copilot/customization/custom-agents), and whether they are compatible with Claude Code OOTB (including tool/model specifications) → [RDR-017](docs/research/RDR-017-agent-spec-compatibility.md)
- [ ] Review addition of skills capabilities in new VSCode version 1.108, as well as any other updates in the new version that may bear on the FW. https://code.visualstudio.com/updates/v1_108. May need updating RDR-014 or RDR-015.
- [ ] https://devscribe.app/
- [ ] Improve testing of agents, including making sure the install.sh script works, and that we're properly testing Claude Code related configurations
- [ ] Find opportunities to trim down agents (mainly explore and implement)
- [ ] Rename explore back to research to avoid conflicts with CC?
- [ ] Add "Save" handoff in "Implement"
- [ ] https://github.com/Dammyjay93/claude-design-skill/blob/main/skill/skill.md
