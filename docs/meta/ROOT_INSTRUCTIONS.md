# ROOT_INSTRUCTIONS: Building an Agentic Coding Framework

> **Historical Note**: This was the meta-prompt used to guide an AI in building this framework.
> It demonstrates a structured approach to complex prompt engineering that may be useful as a template.

## TL;DR

This prompt guided an AI to:

1. Research source material (frameworks, blog posts, instruction files)
2. Synthesize best practices into a coherent framework
3. Generate Copilot instruction files + agent modes
4. Migrate to Agent Skills for auto-activation

**Result**: 10 Agent Skills in `.github/skills/`, synthesis documents in `./docs/synthesis/`.

---

## The Prompt Structure

### Your Role

> You are an expert prompt engineer and coding agent architect. Your task is to synthesize best practices from multiple sources into a cohesive, maintainable framework for agentic coding workflows.

### Context

I am a software developer looking to upgrade the way I work with coding agents. I have compiled a list of frameworks, blog posts, instruction files and various agent modes in the [source material file](./SOURCE_MATERIAL.md).

**Tech Stack:**

- **Languages:** Python (primary), TypeScript (GUI apps)
- **Infrastructure:** AWS, K8s, Grafana, GitHub Actions
- **Tools:** JSM, Asana
- **Environment:** macOS, zsh shell
- **IDE:** VSCode with Copilot

### Goals (Prioritized)

1. A set of global Copilot instruction files for `~/Library/Application Support/Code/User/prompts/`
2. A set of agent modes for on-demand tasks (Tech Debt, Architecture Review, Ideation, etc.)
3. A clear, easily modifiable framework with quick feedback integration
4. A rundown of prevailing wisdom in the field
5. Downloaded frameworks/prompts in this repo; summarized blog posts

---

## Execution Phases

The work was structured in phases with clear deliverables:

### Phase 1: Research (Read-Only)

- Read ALL source material FULLY and DEEPLY
- Download relevant files to `./docs/sources/`
- Follow links where applicable
- Synthesize into `./docs/synthesis/`

### Phase 2: Synthesis

- Identify patterns across frameworks → [prevailing-wisdom.md](../synthesis/prevailing-wisdom.md)
- Document conflicts and resolutions → [framework-comparison.md](../synthesis/framework-comparison.md)
- Pre-design agent modes → [agent-modes-design.md](../synthesis/agent-modes-design.md)

### Phase 3: Generation

- Create global instruction files → `./instructions/`
- Create agent modes → `./prompts/`
- Reference [output examples](../output-examples.md) for expected formats

### Phase 4: Validation

- Test in real workflows
- Collect user feedback

### Phase 5: Refinement

Address feedback iteratively (see refinement requirements below)

### Phase 6: Agent Skills Migration

- Convert agents to Skills format for auto-activation
- Create `.github/skills/` structure

---

## Constraints

### Hard Requirements

- MUST work with VSCode + Copilot (not Cursor/Claude Code unless compelling reason exists)
- MUST be repo-agnostic (no hardcoded paths or repo-specific assumptions)
- MUST verify outputs (tests, linting, typing) over quick/obvious solutions
- MUST prefer correctness on first try over quick responses

### Preferences

- SHOULD NOT generate slop/boilerplate/fluff
- SHOULD adhere to consistent coding best practices
- SHOULD be mindful of token usage/cost during **generated framework usage**
- SHOULD be set-and-forget: easily usable across multiple repos without per-repo setup
- SHOULD be easy to maintain and improve over time

---

## Source Material Priority

### 🔴 Critical (Read First, Fully)

- [Agent Skills Specification](https://agentskills.io/specification) - The open standard format
- [About Agent Skills - GitHub Docs](https://docs.github.com/copilot/concepts/agents/about-agent-skills)
- [HumanLayer ACE Framework](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)
- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents)

### 🟡 Important (Read Fully)

- [anthropics/skills](https://github.com/anthropics/skills) - Example skills from Anthropic
- [agentskills/agentskills](https://github.com/agentskills/agentskills) - Spec repo with examples
- [Awesome Instructions](https://github.com/github/awesome-copilot/blob/main/docs/README.instructions.md)
- [How to write a great agents.md](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)

### 🟢 Reference (Skim for Specific Needs)

- [CursorRIPER Framework](https://github.com/johnpeterman72/CursorRIPER.sigma)
- Blog posts, EARS notation, Toon format

---

## Key Insights Discovered

1. **Phase-Based Workflows**: Research → Plan → Execute → Review with permission boundaries
2. **Context Engineering**: 40-60% utilization, custom formats, frequent compaction
3. **Control Flow Ownership**: Own prompts, context window, and execution flow
4. **Human-in-the-Loop**: At research/plan boundaries (highest leverage)
5. **Focused Agents**: 3-20 steps max, single-purpose over monolithic

---

## Anti-Patterns (Avoid These)

- ❌ Generic advice that could apply to any codebase
- ❌ Instructions that require manual updates per-repo
- ❌ Verbose explanations in generated code
- ❌ Over-reliance on a single framework's philosophy
- ❌ Instructions that conflict with each other
- ❌ Hardcoded paths or environment-specific assumptions
- ❌ Summarizing before fully understanding (in research phase)
- ❌ Creating files without clear purpose or activation criteria

---

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
4. **Document** in `./docs/synthesis/decisions.md`

---

## Feedback Integration

When I provide feedback:

1. **Acknowledge** the specific issue
2. **Propose** a concrete fix
3. **Update** the relevant file immediately
4. **Note the pattern** to avoid in future (add to Anti-Patterns if broadly applicable)

---

## Refinement Requirements (Phase 5)

These were the detailed requirements addressed after initial generation:

### 5.1 Architectural Separation: Core Workflow vs Utilities

- Restructure to distinguish the primary workflow (Research→Plan→Implement→Review) from utility modes
- Core workflow agents should be HumanLayer-level robust (procedural, interactive, sub-agent capable)
- Utility modes (debug, tech-debt, janitor, etc.) can remain simpler behavioral guidelines

### 5.2 Installation Script with Symlinks

- Create `install.sh` script for macOS
- Use symlinks (not copies) so edits in repo are immediately available globally
- Include uninstall option

### 5.3 Prevent Context Pollution

- Problem: `applyTo: "**"` loads ALL instruction files for EVERY interaction
- Solution: Make global.instructions.md minimal, move detailed guidance to agent modes (opt-in)

### 5.4 Enhance Core Workflow Agents (HumanLayer Parity)

- Step-by-step procedures with numbered sub-steps
- Initial response template (what to say when mode is activated)
- Interactive checkpoints (wait for user input, ask clarifying questions)
- Document creation with metadata (for research/plan outputs)
- Reference `./docs/sources/humanlayer/` for the gold standard

### 5.5 Document Activation Patterns

- Document how to invoke agents in VSCode Copilot
- Via model picker dropdown in Copilot Chat
- Via prompt files with frontmatter

### 5.6 Create Usage Guide / Entry Point Documentation

- What happens automatically (global instructions)
- What's opt-in (agent modes / skills)
- Typical workflow examples

---

## Agent Skills Migration (Phase 6)

The key discovery: **GitHub Copilot now supports Agent Skills** - an open standard for automatic skill activation.

### What Are Agent Skills?

1. **Automatic activation**: Copilot reads skill descriptions and automatically loads relevant skills based on your prompt
2. **Cross-platform**: Works with Claude Code, GitHub Copilot, and other agents
3. **Progressive disclosure**: Only skill metadata loaded always; full instructions loaded when activated
4. **Repo-level**: Skills live in `.github/skills/` (also supports `.claude/skills/`)

### Why This Changes Everything

| Before                                  | With Agent Skills                      |
| --------------------------------------- | -------------------------------------- |
| Manual agent selection via model picker | Automatic activation based on prompt   |
| `prompts/workflow/*.agent.md`           | `.github/skills/*/SKILL.md`            |
| User must remember which agent to use   | Copilot decides based on description   |
| VSCode-only                             | Cross-platform (Copilot + Claude Code) |

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
description: > # Required: max 1024 chars, include trigger keywords
  Deep codebase exploration and research. Use when asked to understand how 
  code works, trace data flow, find patterns, or explore architecture. 
  Triggers: "how does X work", "find where Y is defined", "trace the flow of Z".
---
# Instructions here (< 500 lines recommended)
```

---

## Related Documents

- [Prevailing Wisdom](../synthesis/prevailing-wisdom.md) - Core principles synthesized
- [Framework Comparison](../synthesis/framework-comparison.md) - Comparison matrix
- [Agent Skills Research](../synthesis/agent-skills-research.md) - Skills standard research
- [Source Material](./SOURCE_MATERIAL.md) - Original research sources
