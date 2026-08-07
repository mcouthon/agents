# Research Backlog

Unchecked research items organized by theme. Pick one item per session.

> **Migrated from RESEARCH.md** — See [RESEARCH.md](RESEARCH.md) for process. Before documenting, check if the topic belongs in an existing synthesis doc.

---

## Backlog

- [ ] https://crit.md/
- [ ] https://walkinglabs.github.io/learn-harness-engineering/en/
- [ ] https://x.com/trq212/status/2044548257058328723?s=52
- [ ] https://www.reddit.com/r/ClaudeAI/comments/1rw60jp/i_made_my_agent_342_more_accurate_by_letting_it/?share_id=l08_g_4iiuuxaMngPlRwf&utm_name=iossmf
- [ ] https://www.reddit.com/r/ClaudeCode/comments/1rvort4/i_gave_my_claude_code_agent_a_search_engine/?share_id=s8pu4N90tDXgqJy7VsPRN&utm_name=ioscss
- [ ] https://www.reddit.com/r/PromptEngineering/comments/1rv9wvb/i_built_a_claude_skill_that_writes_perfect/?share_id=uabk7GD_iTaJlfTm8WgEZ&utm_name=ioscss
- [ ] https://www.reddit.com/r/GithubCopilot/comments/1rrupux/show_hn_hads_a_convention_for_writing_technical/?share_id=vK-LKoO9X_BUocQxjIs2t&utm_name=iossmf
- [ ] https://www.reddit.com/r/ClaudeCode/comments/1rr7vgo/i_reverseengineered_claude_code_to_build_a_better/?share_id=u8gjxo_3wAM5ixJ6iSrCj&utm_name=ioscss
- [ ] https://www.reddit.com/r/ClaudeAI/comments/1rr47ya/i_delayed_my_product_launch_for_months_because_i/?share_id=QSdsLSy3dcZukdj8cCoJB&utm_name=iossmf
- [ ] https://www.reddit.com/r/ClaudeCode/comments/1ro4zk5/crit_a_terminal_review_tool_for_claude_code_plans/?share_id=hgj5QxPAFyye9SgmQ-Hrl&utm_name=iossmf
- [ ] https://www.reddit.com/r/GithubCopilot/comments/1rnf0v5/free_i_built_a_brain_for_copilot/?share_id=sujXn4ffiPtfSoXhuh7f9&utm_name=iossmf
- [ ] https://github.com/shanraisshan/claude-code-best-practice
- [ ] https://github.com/keysersoose/claude-agent-builder
- [ ] https://eversole.dev/blog/we-automated-everything/

  
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

- [x] https://github.com/nagisanzenin/claude-code-production-grade-plugin — Documented in framework-comparison.md
- [x] https://www.reddit.com/r/ClaudeCode/s/IwX6Fi7QXX — Rejected (CC-specific, validates existing patterns)
- [x] https://www.reddit.com/r/GithubCopilot/s/b4fvkxJa9M — Rejected (validates existing patterns; all 7 rules already followed)
- [x] https://www.reddit.com/r/ClaudeCode/s/Qd6H0CIABg — Rejected (validates existing approach; all patterns already in AGENTS)
- [x] https://mthds.ai/latest/ and https://github.com/Pipelex/pipelex — Rejected (data-processing pipelines; different domain from coding agents)
- [x] [spec-driven-development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/) → [RDR-001](archive/RDR-001-spec-driven.md)
- [x] [feature-dev-plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/feature-dev) → [RDR-003](archive/RDR-003-feature-dev.md) (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] [agentic-future](https://seconds0.substack.com/p/heres-whats-next-in-agentic-coding) → [RDR-006](archive/RDR-006-agentic-future.md)
- [x] [mitsuhiko-agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/improve-skill/SKILL.md) → [RDR-007](archive/RDR-007-mitsuhiko-agent-stuff.md)
- [x] [six-tips-agents](https://steve-yegge.medium.com/six-new-tips-for-better-coding-with-agents-d4e9c86e42a9) → [RDR-022](archive/RDR-022-six-tips-agents.md) ⭐ (merged → [framework-comparison.md](../synthesis/framework-comparison.md))
- [x] https://www.reddit.com/r/ClaudeAI/comments/1rzyqqt/ — Partially Adopted: lightweight grounding added to Explorer, Reviewer, Researcher templates (no RDR; full apparatus stays in deep-research skill)
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
- [x] [spec-kit-sdd](https://github.com/github/spec-kit) → [RDR-033](RDR-033-spec-kit-sdd.md) (Adopted)
- [x] [agentic-engineering-patterns](https://simonwillison.net/guides/agentic-engineering-patterns/) → [RDR-035](RDR-035-agentic-engineering-patterns.md) (Partially Adopted)

### Agent Architecture

- [x] Combine Research + Plan agents → [RDR-016](archive/RDR-016-agent-consolidation.md) ⭐ (consolidated into Explorer agent)
- [x] Verify agent spec compatibility → [RDR-017](archive/RDR-017-agent-spec-compatibility.md) (merged → [ide-compatibility.md](../synthesis/ide-compatibility.md))
- [x] Improve testing of agents (install.sh, Claude Code configs)
- [x] Find opportunities to trim down agents (explorer/builder)
- [x] Rename explore back to research to avoid conflicts with Claude Code? — Resolved: renamed to persona names (Explorer, Builder, etc.)

### Skills

- [x] https://github.com/mattpocock/skills/ — Partially Adopted: skill size guidance lowered, emphasis pattern documented, debug skill enhanced, CONTEXT.md awareness added
- [x] [superpowers](https://github.com/obra/superpowers) → [RDR-004](archive/RDR-004-superpowers.md) (merged → [skills.md](../synthesis/skills.md))
- [x] Review current skills → [RDR-019](archive/RDR-019-skill-review.md) (merged → [skills.md](../synthesis/skills.md))
- [x] Create makefile skill → [makefile skill](../../.github/skills/makefile/SKILL.md)
- [x] Add design skill → [RDR-020](RDR-020-design-skill.md) (Adopted: [design skill](../../.github/skills/design/SKILL.md))
- [x] Skill-powered subagents → [RDR-027](archive/RDR-027-skill-subagents.md) ⭐ (merged → [skills.md](../synthesis/skills.md))
- [x] [skills.sh](https://skills.sh/) ecosystem review → [RDR-028](archive/RDR-028-skills-sh.md) (merged → [skills.md](../synthesis/skills.md))
- [x] Supplement design skill? [interface-design](https://github.com/Dammyjay93/interface-design) or [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) — Adopted: design skill trimmed + enhanced (intent-first, anti-default tests, touch targets)
- [x] [pcvelz-superpowers](https://github.com/pcvelz/superpowers) — Rejected (CC-specific runtime; methodology already adopted from obra in RDR-004)

### Context Management

- [x] [copilot-context-cortex](https://github.com/muaz742/copilot-context-cortex) → [RDR-002](archive/RDR-002-context-cortex.md)
- [x] [beads-memory](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a) → [RDR-005](RDR-005-beads.md), updated via [RDR-034](RDR-034-multi-agent-orchestration.md) (Partially Adopted)
- [x] [gas-town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) → [RDR-034](RDR-034-multi-agent-orchestration.md) (Partially Adopted)
- [x] [gas-city SDK](https://github.com/AbanteAI/gas-city) → [RDR-034](RDR-034-multi-agent-orchestration.md) (Partially Adopted)
- [x] [water-town](https://motherduck.com/blog/water-town-agent-swarm-data-stack/) → [RDR-034](RDR-034-multi-agent-orchestration.md) (Partially Adopted)
- [x] CC orchestration tools (Claude Squad, Pane, Composio AO, etc.) → [RDR-034](RDR-034-multi-agent-orchestration.md) (evaluated, 11 tools compared)
- [x] MCP servers for memory → [RDR-009](archive/RDR-009-mcp-memory-rejected.md) (Rejected)
- [x] Subagents fork context? → [RDR-010](archive/RDR-010-subagents-context-fork.md) (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] [planning-with-files](https://github.com/OthmanAdi/planning-with-files) → [RDR-012](archive/RDR-012-planning-with-files.md) ⭐ (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] [copilot-memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) → [RDR-025](archive/RDR-025-copilot-memory.md) ⭐ (merged → [memory-and-continuity.md](../synthesis/memory-and-continuity.md))
- [x] Create guidelines for plan file artifacts → Resolved: Use Research → Handoff workflow

### IDE Compatibility

- [x] [cursor-2.4](https://cursor.com/changelog/2-4) → [RDR-029](archive/RDR-029-alternative-ide-support.md) (merged → [ide-compatibility.md](../synthesis/ide-compatibility.md))
- [x] [claude-code-lsp](https://karanbansal.in/blog/claude-code-lsp/) — Adopted: LSP preference instructions added to CC agent templates; documented in ide-compatibility.md
