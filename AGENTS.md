# Agent Skills

This framework provides **10 Agent Skills** that auto-activate based on your prompts.

## How It Works

Skills are loaded automatically by GitHub Copilot based on your prompt. Just ask naturally:

| Your Prompt                          | Skill Activated     |
| ------------------------------------ | ------------------- |
| "How does the auth system work?"     | `research-codebase` |
| "Create a plan to add notifications" | `create-plan`       |
| "Implement phase 1 of the plan"      | `implement-plan`    |
| "Review my changes before merge"     | `review-code`       |
| "This test is failing, help debug"   | `debug`             |
| "Find TODOs and code smells"         | `tech-debt`         |
| "Document the system architecture"   | `architecture`      |
| "Teach me how this works"            | `mentor`            |
| "Clean up dead code"                 | `janitor`           |
| "Challenge my approach"              | `critic`            |

**No manual switching required** - Copilot reads skill descriptions and decides which to load.

## The Core Workflow

For substantial changes, follow this pattern:

```
Research → Plan → Implement → Review
   ↑_________________________________↓ (iterate)
```

1. **Research**: "How does X work?" → Understand the codebase (read-only)
2. **Plan**: "Create a plan to add Y" → Get a phased implementation plan (read-only)
3. **Implement**: "Implement the plan" → Execute with verification (full access)
4. **Review**: "Review my changes" → Verify quality before merge (read + test)

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
