# Agent Skills for GitHub Copilot

A collection of **10 Agent Skills** that auto-activate based on your prompts in GitHub Copilot.

## Quick Start

```bash
./install.sh            # Install skills
./install.sh uninstall  # Uninstall
```

That's it. Skills auto-activate based on what you ask.

## How It Works

Just ask naturally in Copilot Chat:

| You Say                              | Skill Activated     |
| ------------------------------------ | ------------------- |
| "I want to add OAuth refresh tokens" | `create-plan`       |
| "How does the auth system work?"     | `research-codebase` |
| "Implement the plan"                 | `implement-plan`    |
| "Review my changes"                  | `review-code`       |
| "This test is failing"               | `debug`             |
| "Find code smells"                   | `tech-debt`         |
| "Document the architecture"          | `architecture`      |
| "Teach me how this works"            | `mentor`            |
| "Clean up dead code"                 | `janitor`           |
| "Challenge my approach"              | `critic`            |

No manual switching required.

**Need explicit control?** Say "use research mode", "use plan mode", etc.

## The Core Workflow

For substantial changes, follow this pattern:

```
Research → Plan → Implement → Review
```

**Just describe what you want to do** - the skills guide you through each phase:

1. **Start with your goal**: "I want to add OAuth refresh token support"
2. **Plan activates**: Researches the codebase and creates a phased plan
3. **You approve**: "Implement the plan"
4. **Implement activates**: Executes each phase with verification
5. **Finish**: "Review my changes"

Each skill ends with a **"Ready for Next Step?"** prompt that tells you exactly what to say next.

## Available Skills

| Skill               | Purpose                         | Access        |
| ------------------- | ------------------------------- | ------------- |
| `research-codebase` | Deep codebase exploration       | Read-only     |
| `create-plan`       | Create implementation plans     | Read-only     |
| `implement-plan`    | Execute planned changes         | Full access   |
| `review-code`       | Verify implementation quality   | Read + Test   |
| `debug`             | Systematic bug investigation    | Investigation |
| `tech-debt`         | Find and fix technical debt     | Full access   |
| `architecture`      | High-level design documentation | Read-only     |
| `mentor`            | Teaching through questions      | Read-only     |
| `janitor`           | Cleanup and simplification      | Full access   |
| `critic`            | Challenge assumptions           | Read-only     |

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

Validate skill structure:

```bash
./tests/validate-skills.sh
```

Test install/uninstall:

```bash
./tests/test-install.sh
```

Manual test scenarios: `tests/scenarios/skill-activation.md`

## File Structure

```
.github/skills/           # The 10 agent skills (auto-activate)
├── research-codebase/
├── create-plan/
├── implement-plan/
├── review-code/
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

## Adding Your Own Skills

1. Create `.github/skills/my-skill/SKILL.md`
2. Add frontmatter with `name` and `description` (include trigger keywords)
3. Run `./install.sh`

See [AGENTS.md](./AGENTS.md) for detailed skill format.

## Further Reading

- **[AGENTS.md](./AGENTS.md)** - Detailed usage and customization
- **[docs/synthesis/prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)** - Core principles
- **[docs/synthesis/agent-skills-research.md](./docs/synthesis/agent-skills-research.md)** - Skills standard
