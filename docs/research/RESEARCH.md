# 🔬 Deep Research

**Mission:** Continuously improve the AGENTS framework by learning from external sources, adopting what works, and keeping our patterns current.

## ⚠️ One Item Per Session

**Process exactly ONE research item per session.** When that item is complete (documentation updated, synthesis updated if adopting), stop. Do not pick up another item.

Why: Deep research > shallow coverage. Each item deserves full attention.

---

This file is a prompt for research sessions. Use it to:

- **Discover** new agent frameworks, prompt patterns, and IDE features
- **Evaluate** whether they improve our workflow, agents, or skills
- **Adopt** useful patterns into synthesis docs and framework components
- **Maintain** existing patterns as capabilities evolve

## Finding Previous Research

- [CATALOG.md](CATALOG.md) — Quick reference by topic and status
- [BACKLOG.md](BACKLOG.md) — Unchecked research items by category

## Philosophy

**Update existing docs over creating new ones.** Most research findings belong in consolidated files, not new standalone RDRs.

### Decision Tree: Where Does This Go?

```
┌─────────────────────────────────────────────────────────────┐
│          Where should this research decision live?          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
               ┌──────────────────────────────┐
               │ Is this related to an        │
               │ existing consolidated file?  │
               └──────────────────────────────┘
                    │                │
                   YES              NO
                    │                │
                    ▼                ▼
        ┌──────────────────┐   ┌──────────────────────────┐
        │ UPDATE the       │   │ Is this a major          │
        │ consolidated     │   │ architectural decision?  │
        │ file             │   └──────────────────────────┘
        └──────────────────┘         │           │
                                    YES         NO
                                     │           │
                                     ▼           ▼
                          ┌───────────────┐  ┌───────────────┐
                          │ Create/update │  │ Create new    │
                          │ ADR in docs/  │  │ standalone    │
                          │ architecture/ │  │ RDR           │
                          └───────────────┘  └───────────────┘
```

**Default action:** Update existing file. **Exception:** Create new RDR.

### Consolidated Files Reference

| Theme                | File                                                              | Update When                                         |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| VS Code Platform     | [vscode-platform.md](../synthesis/vscode-platform.md)             | New VS Code features, Copilot updates, tool changes |
| Framework Comparison | [framework-comparison.md](../synthesis/framework-comparison.md)   | Industry frameworks, external best practices        |
| Memory & Context     | [memory-and-continuity.md](../synthesis/memory-and-continuity.md) | Memory, subagents, context passing                  |
| Skills               | [skills.md](../synthesis/skills.md)                               | Skill creation, testing, skill ecosystems           |
| IDE Compatibility    | [ide-compatibility.md](../synthesis/ide-compatibility.md)         | Multi-IDE support, Cursor, Windsurf, Claude Code    |

### Documentation Hierarchy

| I want to...                        | Update...                          |
| ----------------------------------- | ---------------------------------- |
| Add findings to existing theme      | Synthesis doc (see table above)    |
| Record major architectural decision | ADR in `docs/architecture/`        |
| Document a novel topic (rare)       | New RDR in `docs/research/`        |
| Document a pattern/practice         | Synthesis doc in `docs/synthesis/` |
| Add a new principle                 | `prevailing-wisdom.md`             |
| Compare frameworks                  | `framework-comparison.md`          |
| Describe continuity pattern         | `memory-and-continuity.md`         |

**RDRs should be slim** (~50 lines). If you're writing paragraphs, that belongs in synthesis docs.

### What "Adoption" Means

Adoption requires a **behavioral change** to the framework — modifying files under `templates/` that affect how agents, skills, or instructions actually work.

| Status                | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| **Adopted**           | Modified templates (agents, skills, instructions) that change agent behavior |
| **Partially Adopted** | Some behavioral changes made, others rejected                                |
| **Documented**        | Added to synthesis/reference docs — no behavioral changes                    |
| **Rejected**          | Evaluated, no changes made (out of scope, doesn't fit)                       |
| **Future**            | Good idea, but blocked or deferred                                           |

**What counts as adoption:**

- Adding/modifying agent templates (`templates/agents/`)
- Adding/modifying skill templates (`templates/skills/`)
- Adding/modifying instruction templates (`templates/instructions/`)
- Changing `Makefile`, `install.sh`, or `scripts/` to alter framework behavior

**What does NOT count as adoption:**

- Updating synthesis docs (`docs/synthesis/`) — this is documentation, not behavior
- Creating RDRs or ADRs — these record decisions, not change behavior
- Updating CHANGELOG or README — these describe, not implement

"Validates our approach" or "confirms we're on track" = **Rejected** (informational). Updating a doc without changing a template = **Documented**, not Adopted.

## Process

### 1. Find Research Candidates & Determine Destination

**From backlog:** Pick next unchecked item from [BACKLOG.md](docs/research/BACKLOG.md).

**From discovery sources:** When backlog is empty or you want fresh ideas:

| Source           | How to Search                                                                | Examples                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub           | Search `copilot instructions` or `agent prompts`, check trending             | [awesome-copilot](https://github.com/LouisShark/awesome-copilot), [claude-code-mastery](https://github.com/TheDecipherist/claude-code-mastery) |
| Yegge's blog     | Check [steve-yegge.medium.com](https://steve-yegge.medium.com)               | Beads memory system, Six Tips for Agents                                                                                                       |
| VS Code releases | Check [code.visualstudio.com/updates](https://code.visualstudio.com/updates) | Skills API (1.108), new Copilot tools                                                                                                          |
| Anthropic/OpenAI | Check engineering blogs and plugin repos                                     | [ralph-wiggum](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum), feature-dev                                          |
| Upstream repos   | Revisit repos we adopted from                                                | 12-Factor Agents, HumanLayer ACE                                                                                                               |

**Manual additions welcome.** Add URLs to [BACKLOG.md](docs/research/BACKLOG.md) as you discover them.

### 2. Research & Evaluate

1. Read [README](./README.md) and relevant [synthesis docs](./docs/synthesis/) for context
2. Read the source fully, follow links
3. Ask: Does this improve our agents, skills, or patterns?

### 3. Discuss & Decide

Present findings to user before making any decision:

1. **Summary**: What the source contains and key insights
2. **Relevance**: How it relates to our current agents/skills/patterns
3. **Recommendation**: Adopt / Partially Adopt / Reject, with specific rationale
4. **If adopting**: What concrete changes would be made

Present options to the user (`askQuestions` / CC: `AskUserQuestion`):

- **[Adopt]** Proceed with adoption changes
- **[Reject]** Document as rejected, no changes
- **[Investigate Further]** Deeper dive needed

The user may also ask clarifying questions or suggest a different approach. Only after explicit agreement, move to step 4 (Document Decision).

### 4. Document Decision

Record the research outcome regardless of adoption status:

| Action               | When                                     |
| -------------------- | ---------------------------------------- |
| Update existing file | Topic fits a consolidated synthesis file |
| Add to synthesis doc | New pattern or reference to document     |
| Create new RDR       | Novel topic that needs its own record    |

When creating a new RDR, use [template](./docs/research/TEMPLATE.md) (~50 lines). Mark with ⭐ if high-impact.

**Note:** Documentation alone is not adoption. If you only update docs, the status is **Documented**. Proceed to Step 5 only if you're making behavioral changes to templates.

### 5. Implement (if adopting)

Adoption means changing behavioral artifacts. Documentation updates are a side effect, not the goal.

| Adoption Type      | Change                                                    | Then Document In                                            |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| New principle      | Update agent/skill templates to follow it                 | [prevailing-wisdom.md](docs/synthesis/prevailing-wisdom.md) |
| New skill          | Create in `templates/skills/`, run `make && ./install.sh` | README counts, CHANGELOG                                    |
| Agent change       | Update template in `templates/agents/`                    | README, CHANGELOG                                           |
| Instruction change | Update template in `templates/instructions/`              | CHANGELOG                                                   |
| Workflow change    | Update orchestration or agent templates                   | README workflow section                                     |

If findings are interesting but don't warrant template changes → status is **Documented**, not Adopted. Update the relevant synthesis doc for reference.

## Maintenance Triggers

Signals that synthesis docs may need revisiting:

| Trigger                                      | Action                                           |
| -------------------------------------------- | ------------------------------------------------ |
| New model capabilities (tools, context size) | Review affected patterns in prevailing-wisdom.md |
| Pattern frequently overridden in practice    | Consider if guidance needs updating              |
| Upstream framework has major update          | Check if our adoption is stale                   |
| 6+ months since synthesis doc update         | Skim for staleness                               |

---

**⚠️ Remember: Pick ONE unchecked item from [BACKLOG.md](BACKLOG.md). Complete it fully before stopping.**
