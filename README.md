# Agentic Coding Framework for GitHub Copilot

**4 Custom Agents** for the core workflow (with enforced tool access and handoffs) plus **6 Agent Skills** that auto-activate based on your prompts.

## Quick Start

```bash
./install.sh            # Install agents and skills
./install.sh uninstall  # Uninstall
```

## The Core Workflow (Custom Agents)

For substantial changes, use the **agent picker dropdown** to select workflow phases:

```
Research → Plan → Implement → Review
```

| Agent       | Purpose                       | Tool Access | Handoff To  |
| ----------- | ----------------------------- | ----------- | ----------- |
| `Research`  | Deep codebase exploration     | Read-only   | → Plan      |
| `Plan`      | Create implementation plans   | Read-only   | → Implement |
| `Implement` | Execute planned changes       | Full access | → Review    |
| `Review`    | Verify implementation quality | Read + Test | ✅ Done     |

**Why agents?** Each phase has **enforced tool restrictions** (Plan can't accidentally edit code) and **handoff buttons** to guide you to the next step.

## Utility Skills (Auto-Activate)

These skills activate automatically based on your prompts:

| You Say                     | Skill Activated |
| --------------------------- | --------------- |
| "This test is failing"      | `debug`         |
| "Find code smells"          | `tech-debt`     |
| "Document the architecture" | `architecture`  |
| "Teach me how this works"   | `mentor`        |
| "Clean up dead code"        | `janitor`       |
| "Challenge my approach"     | `critic`        |

No manual switching required for skills—just ask naturally.

## Available Skills

| Skill          | Purpose                         |
| -------------- | ------------------------------- |
| `debug`        | Systematic bug investigation    |
| `tech-debt`    | Find and fix technical debt     |
| `architecture` | High-level design documentation |
| `mentor`       | Teaching through questions      |
| `janitor`      | Cleanup and simplification      |
| `critic`       | Challenge assumptions           |

## Code Protection Markers

Use these advisory markers in code comments. Skills will respect them:

```python
# [P] Protected - never modify without approval
# [G] Guarded - ask before modifying
# [D] Debug - remove before merge
```

## Instructions (File-Type Standards)

The `instructions/` folder contains file-type specific coding standards.
To enable globally, add to your `~/.zshrc`:

```bash
export COPILOT_CUSTOM_INSTRUCTIONS_DIRS="/path/to/agents/instructions"
```

Or copy individual files to your project's `.github/instructions/` folder.

## Testing

Validate structure:

```bash
./tests/validate-skills.sh   # Validates agents and skills
```

Test install/uninstall:

```bash
./tests/test-install.sh
```

Manual test scenarios: `tests/scenarios/skill-activation.md`

## File Structure

```
.github/
├── agents/               # Custom agents (select from dropdown)
│   ├── research.agent.md
│   ├── plan.agent.md
│   ├── implement.agent.md
│   └── review.agent.md
└── skills/               # Agent skills (auto-activate)
    ├── debug/
    ├── tech-debt/
    ├── architecture/
    ├── mentor/
    ├── janitor/
    └── critic/

instructions/             # File-type coding standards (see above to enable)
├── global.instructions.md
├── python.instructions.md
├── typescript.instructions.md
├── testing.instructions.md
└── terminal.instructions.md

tests/                    # Validation and testing
├── validate-skills.sh
├── test-install.sh
└── scenarios/

docs/
├── synthesis/            # Framework design principles
│   ├── prevailing-wisdom.md
│   └── agent-skills-research.md
├── sources/              # Reference materials used to build this
└── meta/                 # Historical build prompts
```

## Adding Your Own

### Custom Agent

1. Create `.github/agents/my-agent.agent.md`
2. Add frontmatter with `name`, `description`, `tools`, and optional `handoffs`
3. Run `./install.sh`

### Agent Skill

1. Create `.github/skills/my-skill/SKILL.md`
2. Add frontmatter with `name` and `description` (include trigger keywords)
3. Run `./install.sh`

See [AGENTS.md](./AGENTS.md) for detailed formats.

## Further Reading

- **[AGENTS.md](./AGENTS.md)** - Detailed usage and customization
- **[docs/synthesis/prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)** - Core principles
- **[docs/synthesis/agent-skills-research.md](./docs/synthesis/agent-skills-research.md)** - Skills standard
