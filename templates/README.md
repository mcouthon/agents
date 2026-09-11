# Template Format Specification

Templates encode content with platform-specific frontmatter sections. A single template generates output for Claude Code (CC).

## Overview

```
templates/
├── agents/           → generated/claude/agents/*.md
├── skills/           → generated/claude/skills/*/SKILL.md
└── instructions/     → generated/claude/rules/*.md
```

---

## Frontmatter Structure

Templates use YAML frontmatter with shared metadata and platform-keyed sections.

### Agent Template Frontmatter

```yaml
---
# === SHARED METADATA ===
name: Explorer
description: "READ-ONLY research and planning..."

# === CC-SPECIFIC ===
cc:
  tools: [Read, Grep, Glob, Edit, Write, Task(Explorer), LSP, ...]
  disallowedTools: [Bash] # Explicit tool restrictions
  model: opus
  skills: [deep-research, architecture, critic]
  # Optional:
  # permissionMode: plan                # For Conductor
---
```

**Generation Rules:**

- **CC output:** `name`, `description` + all `cc:` fields (flattened to top level)

### Skill Template Frontmatter

Skills have simpler structure:

```yaml
---
name: architecture
description: "Use when documenting architecture... Triggers on: 'architecture', 'system design'..."

cc:
  context: fork
  allowed-tools: [Read, Grep, Glob, LSP]
---
```

**Generation Rules:**

- **CC output:** `name`, `description` + all `cc:` fields (flattened)

### Instruction Template Frontmatter

Instructions use `paths` for file-type scoping:

```yaml
---
paths: ["**/*.py"]
---
```

**Generation Rules:**

- **CC output:** `paths: ["**/*.py"]` (array format)

**Special Case — Global Instructions:**
When `paths: ["**"]` (or no paths):

- CC: **No frontmatter at all** (unconditional rule, omit `---` block entirely)

---

## Body Content

With a single platform, all body content is shared — no conditional directives
are needed. Template bodies contain plain markdown that is passed through to the
generated output as-is.

---

## Body Substitution: `{{MCP_GUIDANCE}}`

A line whose trimmed content is exactly `{{MCP_GUIDANCE}}` is replaced with one
bullet per `mcpServers` profile (in `defaults/config.json`) whose `agents` list
includes the current agent, rendered with that profile's
`toolNames`. Profiles render in config declaration order. If no profile
applies to the agent, the line is removed entirely (whitespace then collapses
normally). Every other `{{...}}` token (e.g. host-injected `{{VSCODE_*}}`
variables) is left untouched.

---

## Output Directory Mapping

| Template Type                          | CC Output                            |
| -------------------------------------- | ------------------------------------ |
| `templates/agents/*.template.md`       | `generated/claude/agents/*.md`       |
| `templates/skills/*/SKILL.template.md` | `generated/claude/skills/*/SKILL.md` |
| `templates/instructions/*.template.md` | `generated/claude/rules/*.md`        |

### File Naming Conventions

- **Agents:** Template `explorer.template.md` → CC `explorer.md`
- **Skills:** Template `debug/SKILL.template.md` → `debug/SKILL.md` (preserve structure)
- **Instructions:** Template `python.template.md` → CC `python.md`

---

## Whitespace Handling

1. **Content whitespace is preserved** — exact spacing within blocks
2. **Blank lines collapse** — prevents double spacing

---

## Edge Cases

### E1: Agents Without Special Body Content

Some agents (Researcher) have no platform-specific body sections — they're embedded into parent agents for CC. The template has `cc:` frontmatter but no special body blocks:

```yaml
---
name: Research
description: "Internal research subagent..."

cc:
  tools: [Read, Grep, Glob, WebFetch, WebSearch, LSP]
  model: sonnet
---
# Research Mode

[Body content]
```

### E2: Skills Without CC Enhancements

Skills that don't need CC-specific frontmatter omit the `cc:` section entirely:

```yaml
---
name: simple-skill
description: "Does something simple..."
# No cc: section — identical output
---
```

### E3: Agents Referencing Other Agents

CC uses `Task(Agent-Name)` in the tools array for subagent invocation:

```yaml
cc:
  tools: [Task(Explorer), Task(Builder), ...]  # Subagent invocation
```

### E4: Platform-Specific Tool Names

CC has its own tool names:

```yaml
cc:
  tools: [AskUserQuestion, Read, ...]
```

### E5: Model Types

Templates declare an abstract **type** (`opus`, `sonnet`, `haiku`);
`scripts/generate.js` renders it to a platform string via the `MODEL_TYPES`
registry — Claude types become `Claude <Tier> <version>`. The version comes
from `models.<type>` in config. A user's `agents.<agent>.cc` config entry can
override which type an agent uses.

---

## Complete Agent Example

See [agents/explorer.template.md](agents/explorer.template.md) for a complete template demonstrating all features:

- Full frontmatter with `cc:` section
- Body content
- MCP guidance substitution
