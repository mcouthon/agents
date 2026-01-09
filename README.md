# AGENTS

> **A**I-**G**uided **E**ngineering — **N**avigate → **T**hink → **S**hip

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub Discussions](https://img.shields.io/github/discussions/mcouthon/agents)](https://github.com/mcouthon/agents/discussions)

A minimal framework for AI-assisted coding with phase-based workflows, auto-activating skills, and enforced tool safety. Works with **VS Code Copilot** and **Claude Code**.

---

## What You Get

| Component        | Count | What It Does                                                             |
| ---------------- | ----- | ------------------------------------------------------------------------ |
| **Agents**       | 4     | Phase-based workflow with enforced tool restrictions and handoff buttons |
| **Skills**       | 6     | Auto-activate based on your prompts (debug, mentor, architecture, etc.)  |
| **Instructions** | 5     | File-type coding standards that load automatically                       |

```bash
git clone https://github.com/mcouthon/agents.git
cd agents
./install.sh
```

That's it. Use `/agent` or the Chat menu to select agents, or just talk naturally and let skills auto-activate.

---

## The Core Insight

> "The highest leverage point is at the end of research and the beginning of the plan. A human can skim 30 seconds and provide feedback that saves hours of incorrect implementation."

This framework is built around that insight. The **Explore** agent is read-only—it can't accidentally edit your code. You review its research and plan, then hand off to **Implement** when you're ready.

---

## The Workflow

```
Explore ──→ Implement ──→ Review ──→ Commit
               │            │
               │            └──→ Fix Issues ──→ (back to Implement)
               │
               └──→ Commit (skip review for small changes)
```

| Agent         | Purpose                       | Tool Access       | Key Handoffs               |
| ------------- | ----------------------------- | ----------------- | -------------------------- |
| **Explore**   | Research + create plans       | Read + Task Write | Implement                  |
| **Implement** | Execute planned changes       | Full access       | Review, Commit             |
| **Review**    | Verify implementation quality | Read + Test       | Commit Changes, Fix Issues |
| **Commit**    | Create semantic commits       | Git + Read        | Push                       |

**Task Write**: Explore can only write to `.tasks/` directory—not your codebase.

**Automatic state persistence**: Explore saves research to `.tasks/[task-name]/` so you can resume across sessions.

**In-context actions**: Each agent has handoff buttons for common next steps that keep your chat history and context intact. To switch agents, just @ mention them (e.g., `@Implement` when ready to start coding).

### Handoff Buttons (In-Context Actions)

Each agent has buttons that trigger common next steps **without leaving your current chat context**:

| Agent         | Button            | Purpose                                   |
| ------------- | ----------------- | ----------------------------------------- |
| **Explore**   | Implement         | Hand off to Implement agent               |
|               | Plan Next Phase   | Detailed plan for next unplanned phase    |
|               | Re-explore        | Investigate further                       |
|               | Show Plan         | Display phase status from task.md         |
|               | Save              | Persist research to `.tasks/`             |
| **Implement** | Review            | Hand off to Review agent                  |
|               | Commit            | Hand off to Commit agent                  |
|               | Check for Errors  | Run linting and type checks               |
|               | Run Tests         | Execute the test suite                    |
| **Review**    | Commit Changes    | Hand off to Commit agent                  |
|               | Fix Issues        | Hand off to Implement to address problems |
|               | Re-review         | Check again after fixes are applied       |
|               | Check Tests       | Run tests and verify they pass            |
| **Commit**    | Review Commits    | Show commits with git log                 |
|               | Amend Last Commit | Amend the last commit with staged changes |
|               | Push              | Push commits to remote                    |

**Key benefit**: These buttons keep your context and chat history. No reset, no re-explaining.

---

## Skills (Auto-Activate)

Skills activate automatically based on what you say:

| You Say                     | Skill Activated |
| --------------------------- | --------------- |
| "This test is failing"      | `debug`         |
| "Find code smells"          | `tech-debt`     |
| "Document the architecture" | `architecture`  |
| "Teach me how this works"   | `mentor`        |
| "Clean up dead code"        | `janitor`       |
| "Challenge my approach"     | `critic`        |

No manual switching required—just ask naturally.

---

## What AGENTS Is / Isn't

| AGENTS Is                       | AGENTS Isn't                 |
| ------------------------------- | ---------------------------- |
| Advisory guidance               | Mandatory enforcement        |
| Phase-based workflow            | Magic one-shot agent         |
| Minimal and composable          | Batteries-included framework |
| IDE-agnostic patterns           | Cursor/Claude-specific       |
| Human-in-the-loop at key points | Fully autonomous             |

---

## Installation Details

After `./install.sh`:

| Component            | Installed To                                          |
| -------------------- | ----------------------------------------------------- |
| Agents (VS Code)     | `~/Library/Application Support/Code/User/prompts/`    |
| Commands (Claude Code) | `~/.claude/commands/`                                 |
| Skills               | `~/.github/skills/` (with `~/.claude/skills` symlink) |
| Instructions         | `~/Library/Application Support/Code/User/prompts/`    |
| Task state gitignore | Added to global gitignore (`.tasks/`)                 |

---

## Claude Code Usage

Agents are available using `@agent-<Name>` syntax in Claude Code:

| Command                  | Purpose                 |
| ------------------------ | ----------------------- |
| `@agent-Explore <task>`  | Research and plan       |
| `@agent-Implement`       | Execute the plan        |
| `@agent-Review`          | Verify changes          |
| `@agent-Commit`          | Create semantic commits |

**Example workflow:**

```
$ claude
> @agent-Explore add user authentication

[Claude researches, produces plan]

> @agent-Implement

[Claude implements based on conversation context]

> @agent-Review

[Claude reviews changes]

> @agent-Commit

[Claude creates commits]
```

**Note:** VS Code agent features like tool restrictions, model selection, and handoff buttons are not available in Claude Code. Skills work identically on both platforms.

---

## Customization

### Adding an Agent

Create `.github/agents/my-agent.agent.md`:

```yaml
---
name: My Agent
description: What this agent does and when to use it.
tools: ["codebase", "search", "editFiles"]
model: Claude Sonnet 4 # Optional
handoffs:
  - label: Next Step
    agent: other-agent
    prompt: Continue with the next phase.
---
# My Agent Instructions

Your detailed instructions here.
```

### Adding a Skill

Create `.github/skills/my-skill/SKILL.md`:

```yaml
---
name: my-skill
description: >
  Trigger keywords for auto-activation: "keyword1", "keyword2".
  Focus on WHEN to use (symptoms), not WHAT it does.
---
# My Skill Instructions

Your instructions here (< 500 lines recommended).
```

### Validating Skills (TDD for Documentation)

1. **RED** - Run task WITHOUT the skill, note failures
2. **GREEN** - Add skill, verify improvement
3. **REFACTOR** - If agent rationalizes around it, strengthen guidance

> If you didn't see it fail without the skill, you don't know if the skill helps.

Run `./install.sh` after adding agents or skills.

---

## Task Continuity

Explore persists state to `.tasks/[task-name]/`:

```
.tasks/add-auth/
  task.md                      # Research + phases + main plan
  plan/
    phase-1-config.md          # Detailed plan for phase 1 (optional)
    phase-2-user-model.md      # Detailed plan for phase 2 (optional)
```

### Phase-Based Workflow

1. **Initial research** → `task.md` with research findings + phase table
2. **Plan Next Phase** (optional) → detailed plan for complex phases → `plan/phase-N-[name].md`
3. **Implement** → picks smallest planned unit (phase plan if exists, else task.md)
4. Mark phase ✅ Done, repeat

| Agent         | Reads                   | Updates                              |
| ------------- | ----------------------- | ------------------------------------ |
| **Explore**   | `task.md`, `plan/*.md`  | `task.md`, `plan/*.md`, phase status |
| **Implement** | Phase plan or `task.md` | Phase status (⬜→📋→🔄→✅)           |
| **Review**    | All plan + implement    | —                                    |

**To continue a task**: Just say "Continue working on [task-name]"

---

## Agents vs Skills

| Use Case                          | Use       |
| --------------------------------- | --------- |
| Need enforced tool restrictions   | **Agent** |
| Need handoffs between phases      | **Agent** |
| Want auto-activation from prompts | **Skill** |
| Role-based workflow phases        | **Agent** |
| Specialized methodologies         | **Skill** |

---

## File Structure

```
.github/
├── agents/           # Workflow phases (Explore, Implement, Review, Commit)
└── skills/           # Auto-activating capabilities (debug, mentor, etc.)

instructions/         # File-type coding standards
├── global.instructions.md
├── python.instructions.md
├── typescript.instructions.md
├── testing.instructions.md
└── terminal.instructions.md

docs/
├── synthesis/        # Core principles and framework analysis
└── research/         # Research Decision Records (RDRs)
```

---

## Troubleshooting

**Skills not auto-activating?**

1. Run `./install.sh` to ensure symlinks exist
2. Check `~/.github/skills/` for your skills
3. Be more explicit: "Use debug mode to investigate..."

**Need to uninstall?**

```bash
./install.sh uninstall
```

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Quick ways to contribute:**

- 🐛 [Report a bug](https://github.com/mcouthon/agents/issues/new?template=bug_report.md)
- 💡 [Request a feature](https://github.com/mcouthon/agents/issues/new?template=feature_request.md)
- 🎯 [Share your skill](https://github.com/mcouthon/agents/issues/new?template=share_skill.md)
- 🤖 [Share your agent](https://github.com/mcouthon/agents/issues/new?template=share_agent.md)

---

## Further Reading

| Topic                       | Document                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Core principles             | [prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)         |
| Framework analysis          | [framework-comparison.md](./docs/synthesis/framework-comparison.md)   |
| Memory & session continuity | [memory-and-continuity.md](./docs/synthesis/memory-and-continuity.md) |
| Research decisions          | [docs/research/](./docs/research/)                                    |
| 12-Factor Agents            | [docs/sources/12-factor-agents/](./docs/sources/12-factor-agents/)    |

---

## Why This Exists

Synthesized from multiple frameworks into something minimal and useful:

- [12 Factor Agents](./docs/sources/12-factor-agents/) — Control flow ownership
- [HumanLayer ACE](./docs/sources/humanlayer/) — Context engineering, human leverage points
- [CursorRIPER](./docs/sources/cursorriper/) — Permission boundaries
- [Superpowers](https://github.com/obra/superpowers) — Skill quality, TDD for documentation
- [Awesome Copilot](./docs/sources/awesome-copilot/) — Agent and instruction patterns

> **Model recommendation:** Claude Opus 4.5 for heavy lifting. When Sonnet struggles, Opus delivers.
