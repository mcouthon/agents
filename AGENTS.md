# Agentic Coding Framework - User Guide

> Your personal framework for working with AI coding agents in VSCode + Copilot.

## Quick Start

### 1. Install the Framework

```bash
# Clone the repo and run the install script
./install.sh

# To uninstall later
./install.sh uninstall
```

This creates **symlinks** to your global Copilot prompts directory. Any edits you make to files in this repo are immediately available in VSCode.

### 2. Use the Framework

**Instructions** load automatically based on file type. **Agent modes** are activated on-demand.

## How It Works

### What Loads Automatically

When you work with Copilot, instruction files load based on the file you're editing:

| File Type              | Instructions Loaded                        |
| ---------------------- | ------------------------------------------ |
| Any file               | `global.instructions.md`                   |
| `*.py`                 | + `python.instructions.md`                 |
| `*.ts`, `*.tsx`        | + `typescript.instructions.md`             |
| `*test*.*`, `*spec*.*` | + `testing.instructions.md`                |
| Terminal commands      | `terminal.instructions.md` (always loaded) |

**Global instructions are intentionally minimal** (~35 lines) to avoid context pollution. Detailed guidance lives in agent modes.

### What's Opt-In (Agent Modes)

Agent modes are activated when you need them:

1. Open **Copilot Chat** panel
2. Click the **model picker** dropdown (shows current mode/model)
3. Select an agent from the list

Agent modes provide specialized workflows with:

- Custom system prompts
- Tool restrictions (read-only vs full access)
- Structured output templates
- Handoffs to other agents

## The Core Workflow

For any substantial feature or change, follow this workflow:

```
┌─────────────────────────────────────────────────────────────────┐
│                    RESEARCH → PLAN → IMPLEMENT → REVIEW         │
│                                                                  │
│  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐    │
│  │ Research │ → │   Plan   │ → │ Implement │ → │  Review  │    │
│  │          │   │          │   │           │   │          │    │
│  │ Read-Only│   │ Read-Only│   │Full Access│   │Read+Test │    │
│  └──────────┘   └──────────┘   └───────────┘   └──────────┘    │
│       ↑                              │               │          │
│       └──────────────────────────────┴───────────────┘          │
│                     (iterate if needed)                         │
└─────────────────────────────────────────────────────────────────┘
```

### Example: "Add user notifications"

1. **Research Mode** (Read-Only)
   - "Explore how the existing notification system works"
   - Get a structured report of files, patterns, dependencies
2. **Plan Mode** (Read-Only)
   - "Create a plan to add email notifications for user events"
   - Get a phased implementation plan with success criteria
3. **Implement Mode** (Full Access)
   - "Implement Phase 1 of the notification plan"
   - Code is written, tests added, verification run
4. **Review Mode** (Read + Test)
   - "Review the notification implementation"
   - Get quality assessment and issue identification

## Available Agents

### Core Workflow (Rich, Procedural)

| Agent         | Purpose                       | When to Use                        |
| ------------- | ----------------------------- | ---------------------------------- |
| **Research**  | Deep codebase exploration     | Understanding how something works  |
| **Plan**      | Create implementation plans   | Before making substantial changes  |
| **Implement** | Execute planned changes       | Following an approved plan         |
| **Review**    | Verify implementation quality | After implementation, before merge |

### Utilities (Simpler, Task-Focused)

| Agent            | Purpose                      | When to Use                     |
| ---------------- | ---------------------------- | ------------------------------- |
| **Debug**        | Systematic bug investigation | When something is broken        |
| **Tech Debt**    | Find and fix tech debt       | Cleanup sprints, quick wins     |
| **Architecture** | High-level design docs       | Documenting system structure    |
| **Mentor**       | Teaching through questions   | Learning, code review prep      |
| **Janitor**      | Cleanup and simplification   | Removing dead code, simplifying |
| **Critic**       | Challenge assumptions        | Design reviews, risk assessment |

## Typical Workflows

### "I want to add a new feature"

1. **Research**: Understand existing patterns → structured report
2. **Plan**: Create phased implementation plan → approved plan
3. **Implement**: Execute each phase → working code
4. **Review**: Verify quality → merge-ready code

### "Something is broken"

1. **Debug**: Systematic investigation → root cause identified
2. **Plan** (if fix is complex): Create fix plan
3. **Implement**: Apply fix with regression test
4. **Review**: Verify fix doesn't break other things

### "I need to understand this codebase"

1. **Research**: "How does the authentication system work?"
2. **Research**: "What are the main data models?"
3. **Architecture**: Create high-level documentation

### "I want to clean up technical debt"

1. **Tech Debt**: Scan for issues, prioritize quick wins
2. **Janitor**: Remove dead code, simplify
3. **Review**: Verify cleanup didn't break anything

### "I'm learning this codebase"

1. **Mentor**: Ask questions, get guided exploration
2. **Research**: Deep dive into specific areas
3. **Architecture**: See the big picture

## Context Loading Summary

```
Always Loaded (for any file):
  └── global.instructions.md (~35 lines, minimal)
  └── terminal.instructions.md (~90 lines)

Loaded for Python files (*.py):
  └── python.instructions.md (~175 lines)

Loaded for TypeScript files (*.ts, *.tsx):
  └── typescript.instructions.md (~156 lines)

Loaded for test files (*test*, *spec*):
  └── testing.instructions.md (~174 lines)

Loaded on-demand (agent modes):
  └── research.agent.md (when Research mode active)
  └── plan.agent.md (when Plan mode active)
  └── etc.
```

## Code Protection Markers

Use these in code comments to protect important code from AI modification:

```python
# [P] Core authentication - security reviewed
def verify_token(token: str) -> Claims:
    ...  # Agent will not modify this

# [G] Performance-critical path
def process_batch(items: list[Item]) -> Results:
    ...  # Agent will ask before modifying

# [D] Debug code - remove before merge
print(f"DEBUG: {value}")
```

| Marker | Meaning   | Agent Behavior                         |
| ------ | --------- | -------------------------------------- |
| `[P]`  | Protected | Never modify without explicit approval |
| `[G]`  | Guarded   | Ask before modifying                   |
| `[D]`  | Debug     | Remove before merge                    |

## Tips & Best Practices

### For Best Results

1. **Use the workflow**: Research → Plan → Implement → Review
2. **Be specific**: "Analyze the payment processing flow" > "Look at payments"
3. **Provide context**: Reference files, tickets, or previous research
4. **Verify outputs**: Check plans before implementing, review before merging

### Handoffs Between Agents

Core workflow agents support **handoffs** - clicking a button to switch to another agent with context:

- Research → "Create Plan" → Plan agent with research context
- Plan → "Start Implementation" → Implement agent with plan
- Implement → "Review Changes" → Review agent with implementation
- Review → "Fix Issues" → Implement agent with issues list

### When to Use Each Agent

| Situation                        | Agent                |
| -------------------------------- | -------------------- |
| "I don't understand how X works" | Research             |
| "I need to add feature Y"        | Plan → Implement     |
| "Something is broken"            | Debug                |
| "Clean up this code"             | Janitor or Tech Debt |
| "Is this design good?"           | Critic               |
| "Help me learn"                  | Mentor               |
| "Document the architecture"      | Architecture         |

## Customization

### Adding Your Own Instructions

Create files in `./instructions/` with the pattern:

```yaml
---
applyTo: "**/*.go" # Glob pattern for when to load
---
# Your instructions here
```

### Adding Your Own Agents

Create files in `./prompts/workflow/` (for procedural agents) or `./prompts/utilities/` (for simpler agents):

```yaml
---
name: "Agent Name"
description: "One-line description"
tools: ["codebase", "search", ...]
handoffs:
  - label: "Button Text"
    agent: other-agent
    prompt: "Context for handoff"
---
# Agent instructions here
```

After adding, re-run `./install.sh` to create symlinks.

## File Structure

```
./
├── install.sh                    # Install/uninstall script
├── AGENTS.md                     # This file
├── README.md                     # Project overview
│
├── instructions/                 # Auto-loaded based on file type
│   ├── global.instructions.md    # → All files (minimal)
│   ├── python.instructions.md    # → *.py files
│   ├── typescript.instructions.md # → *.ts, *.tsx files
│   ├── testing.instructions.md   # → *test*, *spec* files
│   └── terminal.instructions.md  # → All files (terminal guidance)
│
└── prompts/
    ├── workflow/                 # Core workflow (rich, procedural)
    │   ├── research.agent.md
    │   ├── plan.agent.md
    │   ├── implement.agent.md
    │   └── review.agent.md
    │
    └── utilities/                # Utility modes (simpler)
        ├── debug.agent.md
        ├── tech-debt.agent.md
        ├── architecture.agent.md
        ├── mentor.agent.md
        ├── janitor.agent.md
        └── critic.agent.md
```

## Troubleshooting

### Agent not appearing in Copilot

1. Ensure `./install.sh` was run
2. Check symlinks exist in `~/Library/Application Support/Code/User/prompts/`
3. Restart VSCode

### Instructions not applying

1. Verify `applyTo` pattern matches your file
2. Check for YAML syntax errors in frontmatter
3. Ensure symlink is not broken

### Agent behaving unexpectedly

1. Check tool restrictions in the agent file
2. Look for conflicting instructions
3. Add more specific constraints

## See Also

- [Prevailing Wisdom](./docs/synthesis/prevailing-wisdom.md) - Core principles
- [Framework Comparison](./docs/synthesis/framework-comparison.md) - Source analysis
- [12 Factor Agents](./docs/sources/12-factor-agents/) - Design principles
