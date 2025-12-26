# Agentic Coding Framework

A personal framework for working with AI coding agents in VSCode + Copilot.

## Quick Start

```bash
# Install with symlinks (edits in repo are immediately available)
./install.sh

# Uninstall
./install.sh uninstall
```

**For detailed usage, see [AGENTS.md](./AGENTS.md).**

## What's Included

### Instruction Files (Auto-Loaded)

| File                         | Applies To         | Purpose                              |
| ---------------------------- | ------------------ | ------------------------------------ |
| `global.instructions.md`     | All files          | Core principles (minimal, ~35 lines) |
| `python.instructions.md`     | `*.py`             | Python standards, type hints         |
| `typescript.instructions.md` | `*.ts`, `*.tsx`    | TypeScript/React patterns            |
| `testing.instructions.md`    | `*test*`, `*spec*` | Test structure, naming               |
| `terminal.instructions.md`   | All files          | Shell commands, GitHub CLI           |

### Agent Modes (Opt-In)

**Core Workflow** (Research → Plan → Implement → Review):

| Agent         | Purpose                       | Access      |
| ------------- | ----------------------------- | ----------- |
| **Research**  | Deep codebase exploration     | Read-only   |
| **Plan**      | Create implementation plans   | Read-only   |
| **Implement** | Execute planned changes       | Full access |
| **Review**    | Verify implementation quality | Read + Test |

**Utilities**:

| Agent            | Purpose                         |
| ---------------- | ------------------------------- |
| **Debug**        | Systematic bug investigation    |
| **Tech Debt**    | Find and fix technical debt     |
| **Architecture** | High-level design documentation |
| **Mentor**       | Teaching through questions      |
| **Janitor**      | Cleanup and simplification      |
| **Critic**       | Challenge assumptions           |

## The Core Workflow

```
Research → Plan → Implement → Review
   ↑___________________________________↓ (iterate)
```

1. **Research**: Understand the codebase (read-only)
2. **Plan**: Create a detailed implementation plan (read-only)
3. **Implement**: Execute the plan with verification (full access)
4. **Review**: Verify quality before merge (read + test)

## Activating Agent Modes

1. Open **Copilot Chat** panel
2. Click the **model picker** dropdown
3. Select an agent from the list

## File Structure

```
./
├── install.sh              # Install/uninstall script
├── AGENTS.md               # Detailed usage guide
├── README.md               # This file
│
├── instructions/           # Auto-loaded by file type
│   ├── global.instructions.md
│   ├── python.instructions.md
│   ├── typescript.instructions.md
│   ├── testing.instructions.md
│   └── terminal.instructions.md
│
└── prompts/
    ├── workflow/           # Core workflow agents
    │   ├── research.agent.md
    │   ├── plan.agent.md
    │   ├── implement.agent.md
    │   └── review.agent.md
    │
    └── utilities/          # Utility agents
        ├── debug.agent.md
        ├── tech-debt.agent.md
        ├── architecture.agent.md
        ├── mentor.agent.md
        ├── janitor.agent.md
        └── critic.agent.md
```

## Core Principles

This framework is built on:

1. **Phase-Based Workflows**: Research → Plan → Execute → Review
2. **Context Engineering**: Minimal always-on instructions, rich opt-in agents
3. **Human-in-the-Loop**: At research/plan boundaries (highest leverage)
4. **Focused Agents**: Single-purpose over monolithic

See [Prevailing Wisdom](./docs/synthesis/prevailing-wisdom.md) for detailed analysis.

## Code Protection Markers

```python
# [P] Protected - Agent will not modify
def critical_function():
    ...

# [G] Guarded - Agent will ask before modifying
def important_function():
    ...

# [D] Debug - Agent should remove before merge
print("DEBUG:", value)
```

## Customization

### Adding Instructions

1. Create `./instructions/<name>.instructions.md`
2. Add `applyTo` pattern in frontmatter
3. Run `./install.sh`

### Adding Agents

1. Create in `./prompts/workflow/` (procedural) or `./prompts/utilities/` (simpler)
2. Add frontmatter with `name`, `description`, `tools`
3. Run `./install.sh`

## Documentation

- **[AGENTS.md](./AGENTS.md)** - Detailed usage guide and workflows
- **[docs/synthesis/](./docs/synthesis/)** - Framework design decisions
- **[docs/sources/](./docs/sources/)** - Source material and references

## Contributing

1. Edit files in this repo (symlinks make changes immediate)
2. Test with real tasks
3. Document patterns that work
4. Add anti-patterns discovered
