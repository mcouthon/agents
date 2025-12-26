# Agent Skills

This framework provides **10 Agent Skills** that auto-activate based on your prompts.

## How It Works

Skills are loaded automatically by GitHub Copilot based on your prompt. Just ask naturally:

| Your Prompt                        | Skill Activated     |
| ---------------------------------- | ------------------- |
| "I want to add notifications"      | `create-plan`       |
| "How does the auth system work?"   | `research-codebase` |
| "Implement the plan"               | `implement-plan`    |
| "Review my changes before merge"   | `review-code`       |
| "This test is failing, help debug" | `debug`             |
| "Find TODOs and code smells"       | `tech-debt`         |
| "Document the system architecture" | `architecture`      |
| "Teach me how this works"          | `mentor`            |
| "Clean up dead code"               | `janitor`           |
| "Challenge my approach"            | `critic`            |

**No manual switching required** - Copilot reads skill descriptions and decides which to load.

## The Core Workflow

For substantial changes, follow this pattern:

```
Research → Plan → Implement → Review
   ↑_________________________________↓ (iterate)
```

**Just describe what you want** - each skill guides you to the next step:

1. **"I want to add OAuth refresh tokens"** → Plan skill researches and creates a plan
2. **Plan ends with**: "Ready for Next Step? → Implement the plan"
3. **"Implement the plan"** → Implement skill executes each phase
4. **Implementation ends with**: "Ready for Next Step? → Review my changes"
5. **"Review my changes"** → Review skill verifies everything

**Need to understand code first?** Start with: "How does X work?" (Research skill)

## Available Skills

### Core Workflow

| Skill               | Purpose                       | Access      |
| ------------------- | ----------------------------- | ----------- |
| `research-codebase` | Deep codebase exploration     | Read-only   |
| `create-plan`       | Create implementation plans   | Read-only   |
| `implement-plan`    | Execute planned changes       | Full access |
| `review-code`       | Verify implementation quality | Read + Test |

### Utilities

| Skill          | Purpose                         |
| -------------- | ------------------------------- |
| `debug`        | Systematic bug investigation    |
| `tech-debt`    | Find and fix technical debt     |
| `architecture` | High-level design documentation |
| `mentor`       | Teaching through questions      |
| `janitor`      | Cleanup and simplification      |
| `critic`       | Challenge assumptions           |

## Code Protection Markers

Use these in code comments to protect important code:

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

| Marker | Meaning   | Behavior                               |
| ------ | --------- | -------------------------------------- |
| `[P]`  | Protected | Never modify without explicit approval |
| `[G]`  | Guarded   | Ask before modifying                   |
| `[D]`  | Debug     | Remove before merge                    |

## Adding Your Own Skills

Create a new skill directory:

```
.github/skills/my-skill/
└── SKILL.md
```

With this structure:

```yaml
---
name: my-skill
description: >
  What this skill does. Include trigger keywords for auto-activation.
  Triggers: "keyword1", "keyword2", "when to use this".
---
# My Skill Instructions

Your detailed instructions here (< 500 lines recommended).
```

Run `./install.sh` to create symlinks.

## Troubleshooting

**Skills not auto-activating:**

1. Run `./install.sh` to ensure symlinks exist
2. Check `~/.github/skills/` for your skills
3. Be more explicit: "Use research mode to explore..."

**Need to uninstall:**

```bash
./install.sh uninstall
```

## See Also

- [Prevailing Wisdom](./docs/synthesis/prevailing-wisdom.md) - Core principles
- [Agent Skills Research](./docs/synthesis/agent-skills-research.md) - Skills standard
- [12 Factor Agents](./docs/sources/12-factor-agents/) - Design principles
