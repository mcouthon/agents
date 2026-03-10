# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Renamed agents to persona names**: Explore→Explorer, Implement→Builder, Review→Reviewer,
  Commit→Committer, Orchestrate→Conductor, Research→Researcher (Worker unchanged)
- Updated all documentation to use new persona names (~15 files)
- **Verification before commit** — structured verification layer across Explore, Review, Orchestrate, and Implement templates:
  - Explore phase plans now require a `## Verification` section (automated checks, manual steps, success criteria)
  - Review owns functional verification — presents manual verification runbook, waits for single user confirmation before PASS
  - Orchestrate 2d checkpoint adds `[Verify]` option alongside Commit/Abort
  - Implement requires pasted terminal output as evidence (no more "✅ Tests pass" without proof) and delegates functional validation to Review
- **ADR commit ordering** — moved task consolidation (ADR creation) from post-commit step 2g to pre-commit step 2e.5 in orchestrate template:
  - ADR files are now committed together with code and docs in a single commit pass (step 2f)
  - Consolidation uses Implement agent (write-capable) instead of Explore (read-only outside `.tasks/`)
  - Removed separate post-commit ADR step (2g) that caused orphaned uncommitted files
- Research: [get-shit-done](https://github.com/gsd-build/get-shit-done) — Rejected (different scope/audience, CLI-only, validates existing approach)
- Research: [agentops](https://github.com/boshu2/agentops) — Rejected (autonomous DevOps scope, different from collaborative AGENTS)
- **Testing skill** (`templates/skills/testing/`): Behavioral testing strategy based on Kent Beck, Google SWE Book, and Martin Fowler research — tests behavior over structure, minimizes mocking, uses Saff Squeeze for regression workflow
- Research: [ai-project-system](https://github.com/panchew/ai-project-system) — Rejected (project management methodology, different scope)
- **CC-ONLY Command Rules in commit template**: Prevents `git -C` and `&&` command chaining that breaks Claude Code auto-approval
- **Testing skill integration in implement template**: Skill-loading directive, condensed testing principles, and testing skill subagent entry
- **Claude Code quickstart guide** (`docs/cc-quickstart.md`): Hands-on guide with 4 learning scenarios, troubleshooting, and Copilot-to-CC translation table

### Changed

- **Design skill trimmed from 1776 to 1401 lines** — comprehensive trim with high-value v2 additions:
  - Added: Intent-First Philosophy (answer "who/what/why" before picking aesthetics)
  - Added: Anti-Default Tests (Swap/Squint/Signature/Token tests) as core craft principle
  - Added: Per-Component Checkpoint (6-point quality gate for every component)
  - Added: Touch Targets (44px) & cursor-pointer as core principle
  - Added: "SaaS ≠ Marketing" and "Glass, not glow" principles
  - Added: Duration scale, button size variants, header glass pattern, component library guidance
  - Cut: 4 of 5 animation hooks (kept useInView, summarized rest in table)
  - Cut: Chat-specific components (chat input, typing indicator, session list)
  - Cut: Full checkbox implementation (replaced with technique note)
  - Cut: Gradient logo + ambient glow full code (replaced with technique description)
  - Cut: Chart container/palette, duplicate empty state, duplicate contrast hierarchy
  - Cut: Tailwind config full dump (replaced with structural overview)
  - Compressed: Stagger CSS classes, elevation utilities, quick reference, shadow pattern
- Implement template Testing Requirements — replaced generic guidelines with skill-aware behavioral testing principles; removed "70% coverage" metric
- Orchestrate: Added `[Verify]` checkpoint option before commit with manual verification runbook
- Orchestrate: Moved ADR consolidation before commit step (2e.5), removed separate 2g step
- Explore: Phase plans now require `## Verification` section (1-3 critical flow checks)
- Explore: Phase plans now require `## Tests` section for behavioral changes
- Implement: Automated verification now requires evidence (actual terminal output)
- Review: Added functional verification step with manual verification runbook (single confirmation)
- Review: Added `testing` to CC skills frontmatter
- All agents: Testing skill references use natural language invocation consistently

### Removed

- Testing instruction (`templates/instructions/testing.template.md`) — replaced by the testing skill

- Documentation updated to use current CC invocation syntax (`use AgentName`, `claude --agent AgentName`) instead of obsolete `@agent-Name` pattern
- `Task()` examples now use capitalized agent names (`Task(Explore, ...)` not `Task(explore, ...)`) for CC case-sensitivity
- Platform notes added for `askQuestions` (VS Code) / `AskUserQuestion` (CC) tool references

## [2.0.0] - 2026-02-21

Full Claude Code (CC) support — agents, skills, and rules now generated from the same template set as Copilot.

### Added

- **Claude Code support**: agents, skills, and rules generated for CC alongside Copilot from `templates/`
- **Single template set**: `scripts/generate.js` generates both platforms; use `<!-- COPILOT-ONLY -->` / `<!-- CC-ONLY -->` directives for platform-specific content
- **Neutral output dirs**: generated files now live in `generated/copilot/` and `generated/claude/` (previously scattered across `.github/`, `.claude/`, `instructions/`)
- Orchestrate agent improvements: Position Lock Protocol, Detour Recovery, context-adaptive checkpoints

### Changed

- **BREAKING:** Generated output paths moved to `generated/copilot/` and `generated/claude/`
- **`install.sh` is now symlink-only** — run `make` first to generate files, then `./install.sh` to symlink them into place; workflow is `make → ./install.sh`
- Documentation and instructions updated to reflect template-centric workflow

### Removed

- `scripts/generate-cc-files.js` — superseded by the unified `scripts/generate.js`
- Node.js generation logic from `install.sh` (generation is now a `make` step)

## [1.0.0] - 2026-02-13

### Added

- RDR-031: VS Code 1.109 orchestration features (Adopted — documents Orchestrate agent, subagent frontmatter)
- prevailing-wisdom.md Section 9: Conductor/Orchestration Pattern documentation
- IntelliJ IDEA support: installs global instructions to `~/.config/github-copilot/intellij/`
  - Note: Agents and skills are VS Code-specific (require tool restrictions and agent discovery)

### Changed

- Agent count 4 → 7: Orchestrate (conductor), Research (internal), Worker (internal)
- README: Updated workflow diagrams showing manual vs orchestrated workflows
- Consolidated design + ui-transformation skills into single `design` skill
  - Merged design philosophy (direction, personality, craft) with 9-phase implementation
  - ui-transformation folder now contains the unified skill with name "design"
  - Deleted standalone design skill folder

## [0.11.0] - 2026-02-07

### Added

- consolidate-task skill: Skip/Update/Create decision tree to prevent ADR bloat
- Agents: Multi-model configuration support (Commit/Review: Sonnet 4.5 + Gemini 3 Pro; Explore/Implement: Opus 4.5 + Opus 4.6)
- scripts/configure-vscode-settings.js: VS Code 1.109 boolean settings support (customAgentInSubagent, copilotMemory, askQuestions, searchSubagent)
- RDR-030: Vercel AGENTS.md eval study (Partially Adopted: retrieval-over-recall principle, horizontal vs vertical context)
- prevailing-wisdom.md: "Retrieval Over Recall" section with horizontal vs vertical context distinction
- scripts/configure-vscode-settings.js: Safe JSONC manipulation for VS Code settings (insert-only, preserves comments)
- scripts/test-configure-settings.sh: Test suite for settings configuration
- consolidate-task skill: Summarize completed tasks into architectural decision records (ADRs)
- phase-review skill: Review phase plans for flaws before implementation
- RDR-029: Cursor 2.4 support research (Rejected: lacks platform-enforced tool restrictions)
- RDR-024: Claude Code Mastery research (single-purpose chat, hooks vs instructions)
- RDR-023: Ralph Wiggum research (subagent fan-out, disposable plans, 40-60% context zone)
- RDR-022: Steve Yegge's six tips for agents (Partially Adopted: 40% rule, Rule of Five)
- docs/research/CATALOG.md: Topic-based navigation for research documents
- prevailing-wisdom.md: Skill evaluation checklist
- design skill: "use design mode" trigger phrase
- security-review skill: Security-focused code review with attack surface mapping, risk classification, and vulnerability checklist
- debug skill: Rationalization Prevention table and Red Flags section to prevent premature fix attempts
- debug skill: Fix attempt counting in Phase 3 with escalation guidance
- critic skill: Blast Radius Thinking section for downstream impact analysis
- critic skill: Expanded security probe patterns (attacker mindset, trust boundaries)
- critic skill: Rationalization Prevention table
- design skill: Pre-Delivery Checklist (visual quality, interaction, responsive, accessibility)
- Explore agent: Brainstorming skill patterns for focused design discussions
- RDR-028: Skills.sh ecosystem research documenting patterns from trailofbits, obra, getsentry
- deep-research skill: Exhaustive investigation with citations, structured findings, and confidence levels
- Explore agent: Skill-powered subagent patterns in Step 4 (architecture and deep-research skills)
- Implement agent: Skill-powered subagent section (Step 3.5) for debug skill invocation
- prevailing-wisdom.md Section 8: Skill-Powered Subagents pattern documentation
- RDR-027: Skill-subagents research documenting the pattern
- Review agent: Skill-powered subagent section (Step 4.5) for critic and tech-debt skills
- RDR-026: MetaPrompts research (Rejected: meta-agent for creating agents; confirms our approach)
- AGENTS.md: `## Learned Patterns` section for repository-level pattern memory
- Implement agent: "Learning from Corrections" (Step 5) - persists user-taught patterns to AGENTS.md
- Explore agent: "Repository Patterns" (Step 5.5) - discovers and suggests patterns during research
- Explore agent: Staleness warning for task files >14 days old
- memory-and-continuity.md: Learned Patterns section documenting the new feature
- RDR-025: Copilot Memory research with partial adoption
- design skill: UI/UX design principles for dashboards, admin interfaces, SaaS products (4px grid, depth strategy, typography hierarchy)
- makefile skill: AI-guided Makefile creation with process lifecycle management patterns (PID tracking, logging, status monitoring)
- Implement agent: "Save Progress" handoff for session continuity
- Implement agent: "Saving Progress Mid-Implementation" section for state preservation
- Implement agent: "Repo-Specific Instructions" step to check AGENTS.md for post-implementation requirements
- AGENTS.md: Post-Implementation section with CHANGELOG, docs, and versioning requirements

### Changed

- install.sh: Agents now install to `~/.copilot/agents/` (was `~/Library/.../prompts/`)
- install.sh: Instructions now install to `~/.copilot/instructions/` (was `~/Library/.../prompts/`)
- install.sh: Automatically migrates old symlinks from deprecated prompts folder
- install.sh: Configures `chat.agentFilesLocations` and `chat.instructionsFilesLocations` in VS Code settings
- tests/test-install.sh: Updated to verify new installation paths
- Skill count increased from 5 to 8 (added design, makefile, consolidate-task, phase-review; merged janitor into tech-debt)
- Agents: Sandwich pattern for constraint adherence (early + late reinforcement)
- Explore agent: Reduced question-asking behavior for smoother workflow
- Explore agent: consolidated from 541 to 322 lines (40% reduction)
  - Merged intro sections, moved Guidelines up, simplified process steps (9→6)
  - Removed handoff-format templates (now using task.md format)
- Explore agent: task.md template reorganized - phases table now at top for quick reference
- Implement agent: consolidated from 402 to 326 lines (19% reduction)
  - Integrated orphaned sections (Attention Management, Resuming Work) into workflow
  - Merged Quality Checklist + Testing Requirements with Guidelines
- Implement agent: strengthened UI verification guidance - emphasize Playwright tests over manual verification
- RDR TEMPLATE: Slimmed format for research documents
- RDRs 003-019: Slimmed to 29-46 lines each (from 60-183 lines)
- 8 RDRs archived to docs/research/archive/ (RDR-001, 002, 006-009, 011, 021)
- Task folder naming: `.tasks/[slug]/` → `.tasks/[NNN]-[slug]/` (e.g., `001-add-auth`)
  - Sequential numbering for chronological ordering
  - Updated in explore, implement, review agents and documentation
- prevailing-wisdom.md: Removed Section 7 "Code Protection" (feature was removed per RDR-011)
- framework-comparison.md: Marked RIPER protection levels as "not adopted" with RDR-011 reference
- framework-comparison.md: Updated "Handoff pattern" → "task-centric persistence" for consistency
- memory-and-continuity.md: Replaced "Handoff agent" reference with "task-centric persistence"
- tech-debt skill: absorbed janitor skill content (deletion philosophy, safe deletion patterns, cleaning checklist)
- architecture skill: strengthened constraints with anti-patterns table and "Never Include" examples
- AGENTS.md: updated repository structure table (agents/skills count corrections)
- copilot-instructions.md: simplified to reference AGENTS.md for cross-agent instructions

### Fixed

- All skill descriptions: Standardized to start with "Use when" and include proper `'use X mode'` triggers
- validate-skills.sh: Fixed regex to accept single-quoted trigger phrases
- configure-vscode-settings.js: Fixed trailing comma issue when setting has empty dict
- test-install.sh: skill symlink path check now matches install.sh (`~/.copilot/skills/` instead of `~/.github/skills/`)
- test.yml: explicit zsh invocation for shell compatibility on GHA macOS runners

### Removed

- All handoff file references (`.github/handoffs/` patterns) from both agents
- janitor skill: functionality merged into tech-debt (80% overlap)
- Terminal instructions: removed outdated line-count restrictions (VSCode 1.108 has better terminal handling)

## [0.10.0] - 2026-01-09

### Added

- Task-centric persistence: "Continue working on [task-name]" reads prior context
- Descriptive filenames for research (e.g., `error_handling.md`, `auth_flow.md`)
- Phase-based workflow with status tracking (⬜ Not Started, 📋 Planned, 🔄 In Progress, ✅ Done)
- Optional detailed phase plans in `.tasks/[task]/plan/phase-N-[name].md`
- Task metadata in `.tasks/[task]/task.md`
- Explore agent: scoped write access to `.tasks/` directory only
- Explore agent: "Plan Next Phase" handoff for detailed planning
- Implement agent: phase detection logic (picks smallest planned unit)
- RDR-017: Task-centric persistence decisions

### Changed

- Agent count reduced from 5 to 4 (Handoff agent removed)
- Agent state now saved to `.tasks/[task-name]/` instead of `.github/handoffs/`
- Explore agent asks for task name at start and saves research with descriptive filenames
- Explore agent merges overview into task.md (single source of truth)
- Implement agent reads task context from `.tasks/` directory, lists available tasks
- Implement agent model changed to Claude Opus 4.5 for better quality
- Review agent reads task context before reviewing (now read-only, no persistence)
- Install script manages `.tasks/` gitignore pattern instead of `.github/handoffs/`

### Removed

- Handoff agent: functionality now handled by Explore agent with scoped write access
- Review agent write access: now strictly read-only with test execution capability

## [0.9.1] - 2026-01-08

### Fixed

- Claude Code slash command references in documentation (corrected `/project:*` to `/*`)
- Install script messages now show correct command format (`@agent-Explore`, `@agent-Implement`, etc.)

## [0.9.0] - 2026-01-07

### Added

- RDR-017: Agent specification compatibility research for VS Code and Claude Code
- Claude Code agent invocation (`@agent-Explore`, `@agent-Implement`, `@agent-Review`, `@agent-Commit`)
- Capabilities sections in all agents describing tool access levels
- Claude Code usage documentation in README

### Changed

- Agents now use platform-agnostic language ("When starting this phase" vs "When this agent is activated")
- Install script generates Claude Code commands from agent bodies by stripping YAML frontmatter
- Handoff references updated to generic "Proceed to..." language instead of button-specific text
- Explore agent model field corrected to "Claude Opus 4.5"

## [0.8.0] - 2026-01-04

### Added

- RDR-016: Agent consolidation decision record

### Changed

- Consolidated Research + Plan agents into Explore agent (now 5 agents instead of 6)
- Explore agent enhanced with all features from Research and Plan
- Handoff agent simplified to copy Explore output verbatim (deterministic handoffs)
- Review agent: Re-Plan → Re-Explore handoff

### Removed

- `research.agent.md` - functionality merged into Explore
- `plan.agent.md` - functionality merged into Explore

## [0.7.2] - 2026-01-04

### Added

- Research tasks for VSCode browser testing, Copilot settings, and agent tools

### Changed

- Commit agent: explicit handoff file exclusion, never use force flags, require confirmation before deleting handoffs
- Handoff agent: added Explore source type, explicit filename formatting rules
- Implement agent: preserve handoff files until review passes (previously deleted after implementation)

## [0.7.1] - 2026-01-03

### Added

- RDR-012: Manus planning-with-files pattern research
- Attention Management section in Implement agent (goal drift prevention)
- Goal drift prevention guidance in prevailing-wisdom.md
- Manus/planning-with-files framework comparison

### Changed

- Framework comparison expanded with Manus pattern analysis

## [0.7.0] - 2026-01-02

### Added

- Explore agent for interactive codebase navigation and learning
- Auto-advance from Research to Plan agent
- Repo-specific copilot instructions (`.github/copilot-instructions.md`)
- Autonomous feedback loop guidance in global instructions (log files, programmatic verification)
- Self-improving instructions pattern for new repos
- RDR-011: Code protection markers removal

### Removed

- Code protection markers (`[P]`, `[G]`, `[D]`) - unused feature, see RDR-011

## [0.6.0] - 2026-01-01

### Added

- Community engagement infrastructure (CONTRIBUTING.md, issue/PR templates, README badges)

### Changed

- Supported version matrix updated to 0.5.x

## [0.5.0] - 2026-01-01

### Added

- Autonomous subagent support for Research/Plan/Implement agents
- RDR-010: Subagents and context forking research

### Changed

- Implement agent now cleans up handoff files after completion

## [0.4.0] - 2025-12-31

### Added

- Memory and session continuity synthesis document
- Namespaced tool specifications for agents
- RDR-008: Handoff workspace constraint research
- RDR-009: MCP memory tools rejection research

### Changed

- README revamped with AGENTS branding and improved structure
- Handoffs moved to workspace `.github/handoffs/` with global gitignore

## [0.3.0] - 2025-12-30

### Added

- Handoff agent for multi-session continuity
- Handoff workflow integration into Research/Plan/Implement agents
- RDR-007: Mitsuhiko handoff pattern research

## [0.2.0] - 2025-12-29

### Added

- RDR-005: Beads memory system analysis
- RDR-006: Agentic coding trends analysis
- Skill validation enforcement
- Review agent requires verification evidence before approval
- Testing anti-patterns documentation

### Changed

- Architecture skill aligned with CSO pattern
- Agents simplified and cleaned up

## [0.1.1] - 2025-12-28

### Added

- Research Decision Record (RDR) format for documenting decisions
- Feature-dev patterns adopted in agents

## [0.1.0] - 2025-12-27

### Added

- Commit agent with Conventional Commits support
- Review agent with handoffs and iteration tracking
- Mandatory testing requirements for agents
- Global agent installation for VS Code and Claude Code
- CRITICAL section with inviolable rules in instructions
- Automatic installation of instruction files

### Changed

- Updated workflow diagram and agent table in README
- Simplified installation instructions

## [0.0.1] - 2025-12-26

### Added

- Initial release of AGENTS framework
- 5 core agents: Research, Plan, Implement, Review, Commit
- 6 skills: debug, tech-debt, architecture, mentor, janitor, critic
- 5 instruction files: global, python, typescript, testing, terminal
- Installation script for VS Code Copilot and Claude Code
- Comprehensive documentation and synthesis from multiple frameworks
- Source materials from 12-Factor Agents, HumanLayer, CursorRIPER, Superpowers

[Unreleased]: https://github.com/mcouthon/agents/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/mcouthon/agents/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mcouthon/agents/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/mcouthon/agents/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mcouthon/agents/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/mcouthon/agents/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mcouthon/agents/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mcouthon/agents/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/mcouthon/agents/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/mcouthon/agents/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mcouthon/agents/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mcouthon/agents/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mcouthon/agents/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mcouthon/agents/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mcouthon/agents/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mcouthon/agents/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mcouthon/agents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mcouthon/agents/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/mcouthon/agents/releases/tag/v0.0.1
