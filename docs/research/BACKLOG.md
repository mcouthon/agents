# Research Backlog

Unchecked research items organized by theme. Pick one item per session.

> **Migrated from RESEARCH.md** — See [RESEARCH.md](RESEARCH.md) for process. Before documenting, check if the topic belongs in an existing synthesis doc.

---

## Backlog

- [ ] https://github.com/qwibitai/nanoclaw - can we learn something from claw-like projects?
- [x] https://github.com/nagisanzenin/claude-code-production-grade-plugin — Documented in framework-comparison.md
- [ ] https://github.com/chethann/persistent-swarm
- [ ] https://www.a5c.ai/
- [x] https://www.reddit.com/r/ClaudeCode/s/IwX6Fi7QXX — Rejected (CC-specific, validates existing patterns)
- [x] https://www.reddit.com/r/GithubCopilot/s/b4fvkxJa9M — Rejected (validates existing patterns; all 7 rules already followed)
- [x] https://www.reddit.com/r/ClaudeCode/s/Qd6H0CIABg — Rejected (validates existing approach; all patterns already in AGENTS)
- [x] https://mthds.ai/latest/ and https://github.com/Pipelex/pipelex — Rejected (data-processing pipelines; different domain from coding agents)
- [ ] VSCode 1.110
  - /slash commands for subagents (testing, phase-review): https://github.com/microsoft/vscode/issues/297119
  - browser intergration: https://github.com/microsoft/vscode/issues/274118
  - forking: https://github.com/microsoft/vscode/issues/291481
  - askQuestion in subagents
- [ ] https://background-agents.com/
- [ ] [agentic-memory-public-preview](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/)
- [ ] [stripe-minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- [ ] [allenai-open-coding-agents](https://allenai.org/blog/open-coding-agents)
- [x] Rename explore back to research to avoid conflicts with Claude Code? — Resolved: renamed to persona names (Explorer, Builder, etc.)
- [x] Supplement design skill? [interface-design](https://github.com/Dammyjay93/interface-design) or [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) — Adopted: design skill trimmed + enhanced (intent-first, anti-default tests, touch targets)
- [x] [pcvelz-superpowers](https://github.com/pcvelz/superpowers) — Rejected (CC-specific runtime; methodology already adopted from obra in RDR-004)

---

## Completed Items

Checked items from previous research. Keep for traceability.

### VS Code Platform

- [x] [vscode-copilot-settings](https://code.visualstudio.com/docs/copilot/setup) → [RDR-014](archive/RDR-014-vscode-copilot-settings.md) (merged → [vscode-platform.md](../synthesis/vscode-platform.md))
- [x] [copilot-agent-tools](https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features) → [RDR-015](archive/RDR-015-copilot-agent-tools.md) (merged → [vscode-platform.md](../synthesis/vscode-platform.md))
- [x] [vscode-1.108-skills](https://code.visualstudio.com/updates/v1_108) → [RDR-014](archive/RDR-014-vscode-copilot-settings.md) (merged → [vscode-platform.md](../synthesis/vscode-platform.md))
- [x] [vscode-browser-testing](https://code.visualstudio.com/docs/copilot/overview) → [RDR-013](RDR-013-vscode-browser-testing.md)
- [x] [vscode-1.109](https://code.visualstudio.com/updates/v1_109) → [RDR-031](archive/RDR-031-vscode-1109-orchestration.md) (merged → [vscode-platform.md](../synthesis/vscode-platform.md))

### External Patterns

- [x] [spec-driven-development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/) → [RDR-001](archive/RDR-001-spec-driven.md)
- [x] [feature-dev-plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/feature-dev) → [RDR-003](archive/RDR-003-feature-dev.md) (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] [agentic-future](https://seconds0.substack.com/p/heres-whats-next-in-agentic-coding) → [RDR-006](archive/RDR-006-agentic-future.md)
- [x] [mitsuhiko-agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/improve-skill/SKILL.md) → [RDR-007](archive/RDR-007-mitsuhiko-agent-stuff.md)
- [x] [six-tips-agents](https://steve-yegge.medium.com/six-new-tips-for-better-coding-with-agents-d4e9c86e42a9) → [RDR-022](archive/RDR-022-six-tips-agents.md) ⭐ (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] [ralph-wiggum](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) → [RDR-023](archive/RDR-023-ralph-wiggum.md) ⭐ (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] [claude-code-mastery](https://github.com/TheDecipherist/claude-code-mastery) → [RDR-024](archive/RDR-024-claude-code-mastery.md) (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] [MetaPrompts](https://github.com/JBurlison/MetaPrompts) → [RDR-026](archive/RDR-026-metaprompts.md) (Rejected)
- [x] [vercel-agents-md-evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) → [RDR-030](RDR-030-vercel-agents-md-evals.md) (Partially Adopted)
- [x] [atlas-orchestra](https://github.com/bigguy345/Github-Copilot-Atlas) → [RDR-032](RDR-032-atlas-orchestra.md) (Partially Adopted)
- [x] [copilot-orchestra](https://github.com/ShepAlderson/copilot-orchestra) → [RDR-032](RDR-032-atlas-orchestra.md) (combined with Atlas)
- [x] [agno-framework](https://www.agno.com/) → [RDR-021](archive/RDR-021-agno.md) (Rejected)
- [x] [ai-project-system](https://github.com/panchew/ai-project-system) — Rejected (project management methodology, different scope; no RDR)
- [x] [agentops](https://github.com/boshu2/agentops) — Rejected (autonomous DevOps scope, different from collaborative AGENTS; no RDR)
- [x] [get-shit-done](https://github.com/gsd-build/get-shit-done) — Rejected (different scope/audience, CLI-only, validates existing approach; no RDR)

### Agent Architecture

- [x] Combine Research + Plan agents → [RDR-016](archive/RDR-016-agent-consolidation.md) ⭐ (consolidated into Explorer agent)
- [x] Verify agent spec compatibility → [RDR-017](archive/RDR-017-agent-spec-compatibility.md) (merged → [ide-compatibility.md](../synthesis/ide-compatibility.md))
- [x] Improve testing of agents (install.sh, Claude Code configs)
- [x] Find opportunities to trim down agents (explorer/builder)

### Skills

- [x] [superpowers](https://github.com/obra/superpowers) → [RDR-004](archive/RDR-004-superpowers.md) (merged → [skills.md](../synthesis/skills.md))
- [x] Review current skills → [RDR-019](archive/RDR-019-skill-review.md) (merged → [skills.md](../synthesis/skills.md))
- [x] Create makefile skill → [makefile skill](../../.github/skills/makefile/SKILL.md)
- [x] Add design skill → [RDR-020](RDR-020-design-skill.md) (Adopted: [design skill](../../.github/skills/design/SKILL.md))
- [x] Skill-powered subagents → [RDR-027](archive/RDR-027-skill-subagents.md) ⭐ (merged → [skills.md](../synthesis/skills.md))
- [x] [skills.sh](https://skills.sh/) ecosystem review → [RDR-028](archive/RDR-028-skills-sh.md) (merged → [skills.md](../synthesis/skills.md))

### Context Management

- [x] [copilot-context-cortex](https://github.com/muaz742/copilot-context-cortex) → [RDR-002](archive/RDR-002-context-cortex.md)
- [x] [beads-memory](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a) → [RDR-005](RDR-005-beads.md)
- [x] MCP servers for memory → [RDR-009](archive/RDR-009-mcp-memory-rejected.md) (Rejected)
- [x] Subagents fork context? → [RDR-010](archive/RDR-010-subagents-context-fork.md) (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] [planning-with-files](https://github.com/OthmanAdi/planning-with-files) → [RDR-012](archive/RDR-012-planning-with-files.md) ⭐ (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] [copilot-memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) → [RDR-025](archive/RDR-025-copilot-memory.md) ⭐ (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] Create guidelines for plan file artifacts → Resolved: Use Research → Handoff workflow

### IDE Compatibility

- [x] [cursor-2.4](https://cursor.com/changelog/2-4) → [RDR-029](archive/RDR-029-alternative-ide-support.md) (merged → [ide-compatibility.md](../synthesis/ide-compatibility.md))
- [x] [claude-code-lsp](https://karanbansal.in/blog/claude-code-lsp/) — Adopted: LSP preference instructions added to CC agent templates; documented in ide-compatibility.md
