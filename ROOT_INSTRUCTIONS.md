<INSTRUCTIONS>
This file contains instructions for creating an agentic coding framework. This file CAN and SHOULD be edited as needed, as part of a prompt engineering process, to create a prompt that will generate the best results.
</INSTRUCTIONS>

---

## Your Role

You are an expert prompt engineer and coding agent architect. Your task is to synthesize best practices from multiple sources into a cohesive, maintainable framework for agentic coding workflows.

---

## Context

I am a software developer looking to upgrade the way I work with coding agents. I have compiled a list of frameworks, blog posts, instruction files and various agent modes in the [source material file](./SOURCE_MATERIAL.md).

**Tech Stack:**

- **Languages:** Python (primary), TypeScript (GUI apps)
- **Infrastructure:** AWS, K8s, Grafana, GitHub Actions
- **Tools:** JSM, Asana
- **Environment:** macOS, zsh shell
- **IDE:** VSCode with Copilot (preferred; only recommend Cursor/Claude Code if there's a compelling reason)

---

## Goals (Prioritized)

1. A set of global Copilot instruction files I can put in `~/Library/Application Support/Code/User/prompts/`. These will determine how my day-to-day interactions with Copilot look.
2. A set of agent modes that I can call on demand, to assist me in specific tasks (e.g., Tech Debt Mode, Architecture Review Mode, Ideation Mode, etc.)
3. A clear framework that I can easily modify and improve over time, with an ability to quickly provide feedback to it
4. A rundown of the current prevailing wisdom in the field, to guide my thinking around this topic.
5. Where applicable, download the frameworks, instruction files, prompts and agent modes directly to this repo. Where applicable, summarize the various frameworks, modes, blog posts, and only keep the summaries in the repo.

---

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

---

## Execution Phases

### Phase 1: Research (Read-Only) ← CURRENT PHASE

- Read ALL source material FULLY and DEEPLY
- Download relevant files to `./docs`
- Follow links where applicable
- NO summarization yet - achieve perfect understanding first
- Token efficiency is NOT a concern in this phase

### Phase 2: Synthesis

- Identify patterns across frameworks
- Create "prevailing wisdom" summary in `./docs`
- Note conflicts between approaches and document resolution rationale
- Consolidate overlapping concepts

### Phase 3: Generation

- Create global instruction files → `./instructions/`
- Create agent modes → `./prompts/`
- Create maintenance framework documentation
- Ensure all files follow output conventions

### Phase 4: Validation

- Test instructions in a sample Copilot session
- Verify agent modes activate correctly
- Check for conflicts between instruction files
- Confirm all success criteria are met

---

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

---

## Output Conventions

### File Naming

- Instruction files: `<scope>.instructions.md` (e.g., `python.instructions.md`, `global.instructions.md`)
- Agent modes: `<name>.agent.md` (e.g., `tech-debt.agent.md`, `architecture-review.agent.md`)
- Prompts: `<action>.prompt.md` (e.g., `research.prompt.md`, `implement.prompt.md`)
- Documentation: `<topic>.md` (e.g., `prevailing-wisdom.md`, `framework-overview.md`)

### Folder Structure

```
./instructions/  → Global Copilot instruction files
./prompts/       → Agent modes and reusable prompts
./docs/          → Downloaded source material, summaries, documentation
```

### Format Requirements

- Use Markdown for all files
- Include frontmatter where applicable (e.g., `applyTo` for instruction files)
- Keep individual files focused on a single concern
- Cross-reference related files via relative links

---

## Success Criteria

- [ ] All 🔴 Critical source materials read and understood
- [ ] All 🟡 Important source materials read and understood
- [ ] Prevailing wisdom document created in `./docs`
- [ ] At least 5 agent modes created with clear activation triggers
- [ ] Global instruction files created and tested in a real Copilot session
- [ ] Framework documented with a "How to Modify" section
- [ ] No conflicts between instruction files
- [ ] All files follow output conventions

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

## Decision Framework

When choosing between approaches or resolving conflicts:

1. **What problem does this solve?** (Be specific)
2. **What are the tradeoffs?** (List pros/cons)
3. **Why is this the best fit for my preferences?** (Reference constraints above)
4. **Document the decision** in the relevant file or in `./docs/decisions.md`

---

## When to Ask vs. Decide Autonomously

### ASK When:

- Two frameworks directly contradict each other with no clear resolution
- A decision would lock into Cursor/Claude Code over Copilot
- You're unsure if a file should be kept verbatim or summarized
- A choice significantly affects the maintainability of the framework
- You need clarification on my preferences or priorities

### DECIDE When:

- Formatting/naming conventions (follow Output Conventions)
- Order of implementation within a phase
- Minor structural choices
- How to organize downloaded source material
- Which agent modes to create (create what seems most useful)

---

## Feedback Integration

When I provide feedback:

1. **Acknowledge** the specific issue
2. **Propose** a concrete fix
3. **Update** the relevant file immediately
4. **Note the pattern** to avoid in future (add to Anti-Patterns if broadly applicable)

---

## Change Log

| Date       | Change                                  | Rationale                                                |
| ---------- | --------------------------------------- | -------------------------------------------------------- |
| 2025-12-26 | Initial creation                        | Bootstrapping the agentic framework                      |
| 2025-12-26 | Applied prompt engineering improvements | Added structure, phases, success criteria, anti-patterns |
