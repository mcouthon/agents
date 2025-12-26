<INSTRUCTIONS>
Meta-prompt for building an agentic coding framework.
Edit this file freely. Track changes in the Change Log.
</INSTRUCTIONS>

> **TL;DR:** This prompt guides an AI to build a personal agentic coding framework.
> It reads source material, synthesizes best practices, and generates Copilot instruction files + agent modes.
> Current phase: **Generation** (Phase 3).

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

### Phase 3: Generation ← CURRENT PHASE

- Create global instruction files → `./instructions/`
- Create agent modes → `./prompts/`
- Reference [output examples](./docs/output-examples.md) for expected formats
- Reference [agent modes design](./docs/synthesis/agent-modes-design.md) for specifications

### Phase 4: Validation

- Test instructions in a sample Copilot session
- Verify agent modes activate correctly
- Check for conflicts between instruction files
- Confirm all success criteria are met

## Source Priority

### 🔴 Critical (Read First, Fully)

- [HumanLayer ACE Framework](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)
- [CursorRIPER Framework](https://github.com/johnpeterman72/CursorRIPER.sigma)
- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents)

### 🟡 Important (Read Fully)

- [Awesome Instructions](https://github.com/github/awesome-copilot/blob/main/docs/README.instructions.md) (all linked files)
- All Agent Modes examples from awesome-copilot
- [How to write a great agents.md](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)

### 🟢 Reference (Skim for Specific Needs)

- Blog posts in Additional Considerations
- EARS notation, Toon format
- Claude Skills article

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
- Agent modes: `<name>.agent.md` (e.g., `tech-debt.agent.md`)
- Prompts: `<action>.prompt.md` (e.g., `research.prompt.md`)
- Documentation: `<topic>.md` (e.g., `prevailing-wisdom.md`)

### Folder Structure

```
./instructions/      → YOUR global Copilot instruction files (output)
./prompts/           → YOUR agent modes and reusable prompts (output)
./docs/
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

| Criterion                                                     | Status |
| ------------------------------------------------------------- | ------ |
| All 🔴 Critical source materials read and understood          | ✅     |
| All 🟡 Important source materials read and understood         | ✅     |
| Prevailing wisdom document created in `./docs/synthesis/`     | ✅     |
| At least 5 agent modes created with clear activation triggers | ⬜     |
| Global instruction files created and tested                   | ⬜     |
| Framework documented with "How to Modify" section             | ⬜     |
| No conflicts between instruction files                        | ⬜     |
| All files follow output conventions                           | ⬜     |

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
