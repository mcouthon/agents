<INSTRUCTIONS>
Meta-prompt for building an agentic coding framework.
Edit this file freely. Track changes in the Change Log.
</INSTRUCTIONS>

> **TL;DR:** This prompt guides an AI to build a personal agentic coding framework.
> It reads source material, synthesizes best practices, and generates Copilot instruction files + agent modes.
> Current phase: **Phase 6 - Agent Skills Migration** ✅ COMPLETE.

## Critical Discovery: Agent Skills (Dec 2025)

**GitHub Copilot now supports Agent Skills** (announced Dec 18, 2025). This fundamentally changes how the framework should be structured.

### What Are Agent Skills?

Agent Skills are an **open standard** for teaching AI agents specialized tasks. Key features:

1. **Automatic activation**: Copilot reads skill descriptions and automatically loads relevant skills based on your prompt
2. **Cross-platform**: Works with Claude Code, GitHub Copilot, and other agents
3. **Progressive disclosure**: Only skill metadata (~100 tokens) loaded always; full instructions loaded when activated
4. **Repo-level**: Skills live in `.github/skills/` (also supports `.claude/skills/`)

### Skill Format

```
.github/skills/
└── research-codebase/
    ├── SKILL.md           # Required - instructions
    ├── scripts/           # Optional - executable code
    ├── references/        # Optional - detailed docs
    └── assets/            # Optional - templates, data
```

**SKILL.md Structure:**

```yaml
---
name: research-codebase # Required: lowercase, hyphens only
description: Deep codebase exploration... # Required: max 1024 chars, include trigger keywords
license: Apache-2.0 # Optional
compatibility: Requires git, docker # Optional
allowed-tools: Bash(git:*) Read # Optional, experimental
---
# Instructions here (< 500 lines recommended)
```

### Why This Changes Everything

| Current Framework                       | With Agent Skills                      |
| --------------------------------------- | -------------------------------------- |
| Manual agent selection via model picker | Automatic activation based on prompt   |
| `prompts/workflow/*.agent.md`           | `.github/skills/*/SKILL.md`            |
| User must remember which agent to use   | Copilot decides based on description   |
| VSCode-only                             | Cross-platform (Copilot + Claude Code) |
| Global install via symlinks             | Per-repo OR global via symlinks        |

### Current Status

- ✅ Supported in **Copilot coding agent** and **GitHub Copilot CLI**
- ✅ Supported in **VSCode Insiders** agent mode
- ⏳ Coming to **VSCode stable** in early January 2025
- ✅ Compatible with `.claude/skills/` directory (Claude Code interop)

## Phase 1 Completed ✅

Research phase is complete. All source materials have been downloaded to `./docs/sources/` and synthesized into:

- [Prevailing Wisdom](./docs/synthesis/prevailing-wisdom.md) - Core principles and patterns
- [Framework Comparison](./docs/synthesis/framework-comparison.md) - Detailed comparison matrix
- [Agent Modes Design](./docs/synthesis/agent-modes-design.md) - Pre-designed agent specifications

**Key Insights Summary:**

1. **Phase-Based Workflows**: Research → Plan → Execute → Review with permission boundaries
2. **Context Engineering**: 40-60% utilization, custom formats, frequent compaction
3. **Control Flow Ownership**: Own prompts, context window, and execution flow
4. **Human-in-the-Loop**: At research/plan boundaries (highest leverage)
5. **Focused Agents**: 3-20 steps max, single-purpose over monolithic

## Phase 3 Completed ✅

Generation phase is complete. Created the following:

### Instruction Files (`./instructions/`)

- `global.instructions.md` - Core philosophy, code protection markers
- `python.instructions.md` - Python standards, type hints, patterns
- `typescript.instructions.md` - TypeScript/React conventions
- `testing.instructions.md` - Test structure, mocking, naming
- `terminal.instructions.md` - Shell commands, GitHub CLI, Vault

### Agent Modes (`./prompts/`)

**Tier 1 - Core Workflow:**

- `research.agent.md` - Deep codebase exploration (read-only)
- `plan.agent.md` - Create implementation plans
- `implement.agent.md` - Execute planned changes
- `review.agent.md` - Verify implementation quality

**Tier 2 - Specialized:**

- `tech-debt.agent.md` - Find and fix technical debt
- `debug.agent.md` - Systematic bug investigation
- `architecture.agent.md` - High-level design documentation
- `mentor.agent.md` - Teaching through questions

**Tier 3 - Utility:**

- `janitor.agent.md` - Cleanup and simplification
- `critic.agent.md` - Challenge assumptions

## Your Role

You are an expert prompt engineer and coding agent architect. Your task is to synthesize best practices from multiple sources into a cohesive, maintainable framework for agentic coding workflows.

## Execution Phases

### Phase 1: Research (Read-Only) ✅ COMPLETE

- ✅ Read ALL source material FULLY and DEEPLY
- ✅ Download relevant files to `./docs/sources/`
- ✅ Follow links where applicable
- ✅ Synthesize into `./docs/synthesis/`

### Phase 2: Synthesis ✅ COMPLETE

- ✅ Identify patterns across frameworks → [prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)
- ✅ Document conflicts and resolutions → [framework-comparison.md](./docs/synthesis/framework-comparison.md)
- ✅ Pre-design agent modes → [agent-modes-design.md](./docs/synthesis/agent-modes-design.md)

### Phase 3: Generation ✅ COMPLETE

- ✅ Create global instruction files → `./instructions/`
- ✅ Create agent modes → `./prompts/`
- ✅ Reference [output examples](./docs/output-examples.md) for expected formats
- ✅ Reference [agent modes design](./docs/synthesis/agent-modes-design.md) for specifications

### Phase 4: Validation ✅ COMPLETE

- ✅ Initial generation complete
- ⚠️ User feedback collected (see Phase 5)

### Phase 5: Refinement ✅ COMPLETE

Address user feedback from Phase 4. See detailed requirements below.

**5.1 Architectural Separation: Core Workflow vs Utilities**

- Restructure to distinguish the primary workflow (Research→Plan→Implement→Review) from utility modes
- Core workflow agents should be HumanLayer-level robust (procedural, interactive, sub-agent capable)
- Utility modes (debug, tech-debt, janitor, etc.) can remain simpler behavioral guidelines
- Consider folder structure: `./prompts/workflow/` vs `./prompts/utilities/`

**5.2 Installation Script with Symlinks**

- Create `install.sh` script for macOS
- Use symlinks (not copies) so edits in repo are immediately available globally
- Target: `~/Library/Application Support/Code/User/prompts/`
- Include uninstall option
- No need to support Linux

**5.3 Prevent Context Pollution**

- Problem: `applyTo: "**"` loads ALL instruction files for EVERY interaction
- Solutions to implement:
  - Make global.instructions.md minimal (just essential behaviors)
  - Move detailed guidance to agent modes (opt-in, not always-on)
  - Consider a "skills-like" pattern: lightweight index file that lists available modes
  - Use more specific `applyTo` patterns where possible (e.g., python.instructions.md only for \*.py)
- Document which files load when in README

**5.4 Enhance Core Workflow Agents (HumanLayer Parity)**

- Current agents are "behavioral guidelines" - too simple
- HumanLayer prompts are "procedural runbooks" - much richer
- Key differences to adopt for core workflow:
  - **Step-by-step procedures** with numbered sub-steps
  - **Initial response template** (what to say when mode is activated)
  - **Interactive checkpoints** (wait for user input, ask clarifying questions)
  - **Sub-agent spawning** for parallel research (if Copilot supports)
  - **Document creation** with metadata (for research/plan outputs)
  - **Model hints** (e.g., prefer opus for complex reasoning)
- Reference `./docs/sources/humanlayer/` for the gold standard
- Keep utility modes simple - only core workflow needs this richness

**5.5 Document Activation Patterns**

- VSCode Copilot does NOT support `/command` syntax like Claude Code
- Document the actual Copilot UX for invoking agents:
  - Via model picker dropdown in Copilot Chat
  - By mentioning agent in prompt (if supported)
  - Via prompt files with `agent:` frontmatter field
- Consider creating a cheat sheet or quick reference card
- Explore if there's a way to create shortcuts or aliases

**5.6 Create Usage Guide / Entry Point Documentation**

- Create a "How to Use This Framework" guide covering:
  - What happens automatically (global instructions kick in)
  - What's opt-in (agent modes)
  - Typical workflow examples (e.g., "I want to add a feature" → use Research→Plan→Implement→Review)
  - Quick reference for all available modes
- Consider Claude Skills pattern:
  - Minimal frontmatter loaded always (just name/description)
  - Full content only loaded when mode is activated
  - A lightweight "router" file that knows about all available modes
- Create `AGENTS.md` or similar entry point file

**5.7 Update Success Criteria**
After Phase 5, verify:

- [x] Core workflow agents match HumanLayer richness
- [x] install.sh script works with symlinks
- [x] Context pollution minimized (document what loads when)
- [x] Clear activation documentation exists
- [x] Usage guide / entry point created
- [x] README updated with all changes

### Phase 6: Agent Skills Migration ✅ COMPLETE

Restructure the entire framework to use the Agent Skills standard for automatic activation.

**6.1 Create Skills Directory Structure**

Convert existing agents to skills format:

```
.github/skills/
├── research-codebase/
│   └── SKILL.md
├── create-plan/
│   └── SKILL.md
├── implement-plan/
│   └── SKILL.md
├── review-code/
│   └── SKILL.md
├── debug/
│   └── SKILL.md
├── tech-debt/
│   └── SKILL.md
├── architecture/
│   └── SKILL.md
├── mentor/
│   └── SKILL.md
├── janitor/
│   └── SKILL.md
└── critic/
    └── SKILL.md
```

**6.2 Convert Agent Files to SKILL.md Format**

For each existing agent in `prompts/workflow/` and `prompts/utilities/`:

1. Create skill directory with lowercase-hyphen name
2. Create SKILL.md with required frontmatter:
   - `name`: Must match directory name
   - `description`: Include trigger keywords for auto-activation
3. Move instructions to SKILL.md body (keep under 500 lines)
4. Move detailed references to `references/` subdirectory if needed

**Key Conversion: Description Field**

The `description` field is critical for auto-activation. Include:

- What the skill does
- When to use it (trigger keywords)
- Example prompts that should activate it

Example:

```yaml
description: >
  Deep codebase exploration and research. Use when asked to understand how 
  code works, trace data flow, find patterns, or explore architecture. 
  Triggers: "how does X work", "find where Y is defined", "trace the flow of Z",
  "understand the codebase", "research", "explore".
```

**6.3 Update install.sh**

Modify install script to:

1. Create symlinks for `.github/skills/` → global skills location (if supported)
2. Keep existing instruction file symlinks
3. Document that skills work at repo level by default
4. Add `.claude/skills/` symlink for Claude Code compatibility

**6.4 Maintain Backward Compatibility**

Keep existing structure for now:

- `prompts/workflow/` - Original agent files (for manual activation)
- `prompts/utilities/` - Original utility agents
- `.github/skills/` - New skills format (for auto-activation)

This allows:

- Manual activation via model picker (existing workflow)
- Automatic activation via prompt (new capability)
- Claude Code compatibility (`.claude/skills/` symlink)

**6.5 Update Documentation**

- Update AGENTS.md with skills activation explanation
- Add migration guide for users upgrading
- Document which activation method to use when
- Update README with new structure

**6.6 Test Skills Activation**

Verify in VSCode Insiders:

1. Ask "how does the auth system work?" → research skill activates
2. Ask "create a plan to add notifications" → plan skill activates
3. Ask "implement phase 1 of the plan" → implement skill activates
4. Ask "review my changes" → review skill activates

**6.7 Success Criteria for Phase 6**

- [x] All 10 agents converted to SKILL.md format
- [x] Skills auto-activate based on prompt keywords
- [x] install.sh updated for skills
- [x] Claude Code compatibility (`.claude/skills/` works)
- [x] Documentation updated
- [x] Backward compatibility maintained

## Source Priority

### 🔴 Critical (Read First, Fully)

- [Agent Skills Specification](https://agentskills.io/specification) - **NEW: The open standard format**
- [About Agent Skills - GitHub Docs](https://docs.github.com/copilot/concepts/agents/about-agent-skills) - **NEW: Official docs**
- [HumanLayer ACE Framework](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)
- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents)

### 🟡 Important (Read Fully)

- [anthropics/skills](https://github.com/anthropics/skills) - **NEW: Example skills from Anthropic**
- [agentskills/agentskills](https://github.com/agentskills/agentskills) - **NEW: Spec repo with examples**
- [Awesome Instructions](https://github.com/github/awesome-copilot/blob/main/docs/README.instructions.md)
- [How to write a great agents.md](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)

### 🟢 Reference (Skim for Specific Needs)

- [CursorRIPER Framework](https://github.com/johnpeterman72/CursorRIPER.sigma)
- Blog posts in Additional Considerations
- EARS notation, Toon format

## Context

I am a software developer looking to upgrade the way I work with coding agents. I have compiled a list of frameworks, blog posts, instruction files and various agent modes in the [source material file](./SOURCE_MATERIAL.md).

**Tech Stack:**

- **Languages:** Python (primary), TypeScript (GUI apps)
- **Infrastructure:** AWS, K8s, Grafana, GitHub Actions
- **Tools:** JSM, Asana
- **Environment:** macOS, zsh shell
- **IDE:** VSCode with Copilot (preferred; only recommend Cursor/Claude Code if there's a compelling reason)

## Goals (Prioritized)

1. A set of global Copilot instruction files for `~/Library/Application Support/Code/User/prompts/`
2. A set of agent modes for on-demand tasks (Tech Debt, Architecture Review, Ideation, etc.)
3. A clear, easily modifiable framework with quick feedback integration
4. A rundown of prevailing wisdom in the field
5. Downloaded frameworks/prompts in this repo; summarized blog posts

## Constraints

### Hard Requirements

- MUST work with VSCode + Copilot (not Cursor/Claude Code unless compelling reason exists)
- MUST be repo-agnostic (no hardcoded paths or repo-specific assumptions)
- MUST verify outputs (tests, linting, typing) over quick/obvious solutions
- MUST prefer correctness on first try over quick responses

### Preferences

- SHOULD NOT generate slop/boilerplate/fluff
- SHOULD adhere to consistent coding best practices (including repo-specific directives)
- SHOULD be mindful of token usage/cost during **generated framework usage** (not during research phase)
- SHOULD be set-and-forget: easily usable across multiple repos without per-repo setup
- SHOULD be easy to maintain and improve over time

## Output Conventions

### File Naming

- Instruction files: `<scope>.instructions.md` (e.g., `python.instructions.md`)
- Agent modes: `<name>.agent.md` (e.g., `tech-debt.agent.md`) - **Legacy, keep for manual activation**
- **Skills: `.github/skills/<name>/SKILL.md`** (e.g., `.github/skills/research-codebase/SKILL.md`) - **NEW: Primary format**
- Documentation: `<topic>.md` (e.g., `prevailing-wisdom.md`)

### Folder Structure

```
.github/skills/      → Agent Skills (auto-activated, cross-platform)
.claude/skills/      → Symlink to .github/skills/ (Claude Code compat)
./instructions/      → Global Copilot instruction files (always-on)
./prompts/           → Legacy agent modes (manual activation via model picker)
./docs/
  ├── meta/          → Meta-prompts (ROOT_INSTRUCTIONS.md, etc.)
  ├── sources/       → Downloaded source material (read-only reference)
  ├── synthesis/     → Prevailing wisdom, decisions, notes
  └── output-examples.md → Reference examples for expected formats
```

### Format Requirements

- Use Markdown for all files
- Include frontmatter where applicable (e.g., `applyTo` for instruction files)
- Keep individual files focused on a single concern
- Cross-reference related files via relative links
- See [output examples](./docs/output-examples.md) for templates

## Success Criteria

| Criterion                                                     | Status        |
| ------------------------------------------------------------- | ------------- |
| All 🔴 Critical source materials read and understood          | ✅            |
| All 🟡 Important source materials read and understood         | ✅            |
| Prevailing wisdom document created in `./docs/synthesis/`     | ✅            |
| At least 5 agent modes created with clear activation triggers | ✅ (10 modes) |
| Global instruction files created and tested                   | ✅ (5 files)  |
| Framework documented with "How to Modify" section             | ✅            |
| No conflicts between instruction files                        | ✅            |
| All files follow output conventions                           | ✅            |
| Core workflow agents match HumanLayer richness                | ✅            |
| install.sh script with symlinks                               | ✅            |
| Context pollution minimized                                   | ✅            |
| Activation patterns documented                                | ✅            |
| Usage guide / entry point created                             | ✅            |
| **Phase 6: Agent Skills Migration**                           | ⬅️ Current    |
| All 10 agents converted to SKILL.md format                    | ⏳            |
| Skills auto-activate based on prompt keywords                 | ⏳            |
| Claude Code compatibility (`.claude/skills/`)                 | ⏳            |

## Anti-Patterns (Avoid These)

- ❌ Generic advice that could apply to any codebase
- ❌ Instructions that require manual updates per-repo
- ❌ Verbose explanations in generated code
- ❌ Over-reliance on a single framework's philosophy
- ❌ Instructions that conflict with each other
- ❌ Hardcoded paths or environment-specific assumptions
- ❌ Summarizing before fully understanding (in research phase)
- ❌ Creating files without clear purpose or activation criteria

## Handling Ambiguity

### When to ASK:

- Two frameworks directly contradict each other with no clear resolution
- A decision would lock into Cursor/Claude Code over Copilot
- Unsure if a file should be kept verbatim or summarized
- A choice significantly affects framework maintainability
- Need clarification on preferences or priorities

### When to DECIDE Autonomously:

- Formatting/naming conventions (follow Output Conventions)
- Order of implementation within a phase
- Minor structural choices
- How to organize downloaded source material
- Which agent modes to create (create what seems most useful)

### Decision Documentation

When resolving conflicts between approaches:

1. **What problem does this solve?** (Be specific)
2. **What are the tradeoffs?** (List pros/cons)
3. **Why is this the best fit for my preferences?** (Reference constraints)
4. **Document** in the relevant file or in `./docs/synthesis/decisions.md`

## Feedback Integration

When I provide feedback:

1. **Acknowledge** the specific issue
2. **Propose** a concrete fix
3. **Update** the relevant file immediately
4. **Note the pattern** to avoid in future (add to Anti-Patterns if broadly applicable)

## Change Log

| Date       | Change                                      | Rationale                                                                 |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| 2025-12-26 | Initial creation                            | Bootstrapping the agentic framework                                       |
| 2025-12-26 | v2: Applied prompt engineering improvements | Added structure, phases, success criteria, anti-patterns                  |
| 2025-12-26 | v3: Restructured for clarity                | Reordered sections, added TL;DR, split docs folder, externalized examples |
| 2025-12-26 | v4: Phase 1 & 2 complete                    | Research done, synthesis documents created, ready for Phase 3             |
| 2025-12-26 | v5: Phase 3 complete, user feedback         | Added Phase 5 with 6 refinement requirements from user feedback           |
| 2025-12-26 | v6: Phase 5 complete                        | Restructured prompts, enhanced core workflow, install.sh, AGENTS.md       |
