# Template Format Specification

Templates encode platform-agnostic content with conditional platform-specific sections. A single template generates outputs for both VS Code Copilot and Claude Code (CC).

## Overview

```
templates/
├── agents/           → Copilot: generated/copilot/agents/*.agent.md
│                     → CC: generated/claude/agents/*.md
├── skills/           → Copilot: generated/copilot/skills/*/SKILL.md
│                     → CC: generated/claude/skills/*/SKILL.md
└── instructions/     → Copilot: generated/copilot/instructions/*.instructions.md
                      → CC: generated/claude/rules/*.md
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

# === COPILOT-SPECIFIC ===
copilot:
  tools: ["vscode/askQuestions", "read/readFile", "edit/editFiles", ...]
  model: ["Claude Opus 4.5 (copilot)", "Claude Opus 4.6 (copilot)"]
  agents: ["Explorer", "Researcher"] # Available subagents
  handoffs: # Handoff buttons (Copilot UI)
    - label: Implement
      agent: Builder
      prompt: "Implement the plan..."
      send: false
  # Optional:
  # user-invokable: false               # Hide from user invocation (Researcher)
  # disable-model-invocation: true      # Model cannot invoke (Conductor)

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

- **Copilot output:** `name`, `description` + all `copilot:` fields (flattened to top level)
- **CC output:** `name`, `description` + all `cc:` fields (flattened to top level)

### Skill Template Frontmatter

Skills have simpler structure—Copilot uses only `name` and `description`:

```yaml
---
name: architecture
description: "Use when documenting architecture... Triggers on: 'architecture', 'system design'..."

# CC enhancements (Copilot has no equivalent)
cc:
  context: fork
  allowed-tools: [Read, Grep, Glob, LSP]
---
```

**Generation Rules:**

- **Copilot output:** `name`, `description` only
- **CC output:** `name`, `description` + all `cc:` fields (flattened)

### Instruction Template Frontmatter

Instructions map `applyTo` (Copilot) to `paths` (CC):

```yaml
---
applyTo: "**/*.py"
---
```

**Generation Rules:**

- **Copilot output:** `applyTo: "**/*.py"` (as-is)
- **CC output:** `paths: ["**/*.py"]` (array format)

**Special Case — Global Instructions:**
When `applyTo: "**"`:

- Copilot: Outputs `applyTo: "**"`
- CC: **No frontmatter at all** (unconditional rule, omit `---` block entirely)

---

## Body Content Directives

HTML comment directives mark platform-specific content sections.

### Syntax

| Directive                | Meaning                               |
| ------------------------ | ------------------------------------- |
| `<!-- SHARED -->`        | Content for both platforms (explicit) |
| `<!-- COPILOT-ONLY -->`  | Start Copilot-only section            |
| `<!-- /COPILOT-ONLY -->` | End Copilot-only section              |
| `<!-- CC-ONLY -->`       | Start CC-only section                 |
| `<!-- /CC-ONLY -->`      | End CC-only section                   |

### Rules

1. **Content before any directive is SHARED** (implicit default)
2. **`<!-- SHARED -->`** opens explicit shared section
3. **Platform blocks require closing tags** (`<!-- /CC-ONLY -->`)
4. **Closing a platform block returns to SHARED** implicitly
5. **No nesting** — directives cannot contain other directives
6. **Unknown directives are errors** (e.g., `<!-- WINDOWS-ONLY -->`)

### Example

```markdown
# Agent Mode

This content appears in BOTH Copilot and CC output.

## Core Instructions

Shared instructions here.

<!-- COPILOT-ONLY -->

## Handoff Buttons

Click the "Implement" button when ready.

<!-- /COPILOT-ONLY -->

<!-- CC-ONLY -->

## CC Platform Notes

Type `@"Builder (agent)"` to proceed.

<!-- /CC-ONLY -->

## More Shared Content

This section appears in both outputs.
```

**Copilot Output:**

```markdown
# Agent Mode

This content appears in BOTH Copilot and CC output.

## Core Instructions

Shared instructions here.

## Handoff Buttons

Click the "Implement" button when ready.

## More Shared Content

This section appears in both outputs.
```

**CC Output:**

```markdown
# Agent Mode

This content appears in BOTH Copilot and CC output.

## Core Instructions

Shared instructions here.

## CC Platform Notes

Type `@"Builder (agent)"` to proceed.

## More Shared Content

This section appears in both outputs.
```

---

## Output Directory Mapping

| Template Type                          | Copilot Output                                     | CC Output                            |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `templates/agents/*.template.md`       | `generated/copilot/agents/*.agent.md`              | `generated/claude/agents/*.md`       |
| `templates/skills/*/SKILL.template.md` | `generated/copilot/skills/*/SKILL.md`              | `generated/claude/skills/*/SKILL.md` |
| `templates/instructions/*.template.md` | `generated/copilot/instructions/*.instructions.md` | `generated/claude/rules/*.md`        |

### File Naming Conventions

- **Agents:** Template `explorer.template.md` → Copilot `explorer.agent.md`, CC `explorer.md`
- **Skills:** Template `debug/SKILL.template.md` → Both `debug/SKILL.md` (preserve structure)
- **Instructions:** Template `python.template.md` → Copilot `python.instructions.md`, CC `python.md`

---

## Validation Rules

The generator MUST fail with clear error messages for:

| Error              | Detection                                         | Message                                                         |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------- |
| Unclosed block     | `<!-- CC-ONLY -->` without `<!-- /CC-ONLY -->`    | `Error: Unclosed CC-ONLY block in {file}`                       |
| Nested directives  | `<!-- CC-ONLY -->` inside `<!-- COPILOT-ONLY -->` | `Error: Nested directive CC-ONLY inside COPILOT-ONLY in {file}` |
| Unknown directive  | `<!-- WINDOWS-ONLY -->`                           | `Error: Unknown directive WINDOWS-ONLY in {file}`               |
| Orphan closing tag | `<!-- /CC-ONLY -->` without opening               | `Error: Orphan closing tag /CC-ONLY in {file}`                  |

**Valid directives:** `SHARED`, `COPILOT-ONLY`, `/COPILOT-ONLY`, `CC-ONLY`, `/CC-ONLY`

---

## Whitespace Handling

1. **Directive lines are removed entirely** — no residual blank lines
2. **Content whitespace is preserved** — exact spacing within blocks
3. **Block boundaries collapse to single blank line** — prevents double spacing

---

## Edge Cases

### E1: Agents Without CC-Only Body Content

Some agents (Researcher) have no platform-specific body sections—they're embedded into parent agents for CC. The template has `cc:` frontmatter but no `<!-- CC-ONLY -->` body block:

```yaml
---
name: Research
description: "Internal research subagent..."

copilot:
  user-invokable: false
  tools: [read/readFile, search, web]
  model: ["Claude Sonnet 4.5 (copilot)"]

cc:
  tools: [Read, Grep, Glob, WebFetch, WebSearch, LSP]
  model: sonnet
---
# Research Mode

[Body content identical for both platforms]
```

### E2: Skills Without CC Enhancements

Skills that don't need CC-specific frontmatter omit the `cc:` section entirely:

```yaml
---
name: simple-skill
description: "Does something simple..."
# No cc: section — identical output for both platforms
---
```

### E3: Agents Referencing Other Agents

`handoffs` and `agents` fields are Copilot-only (live under `copilot:`). CC uses `Task(Agent-Name)` in the tools array instead:

```yaml
copilot:
  agents: ["Explorer", "Researcher"]
  handoffs:
    - label: Implement
      agent: Builder
      ...

cc:
  tools: [Task(Explorer), Task(Builder), ...]  # Subagent invocation
```

### E4: Platform-Specific Tool Names

Tool names differ completely between platforms. No mapping—each platform has its own tools array:

```yaml
copilot:
  tools: ["vscode/askQuestions", "read/readFile", ...]
cc:
  tools: [AskUserQuestion, Read, ...]
```

### E5: Platform-Specific Model Names

Same approach as tools—separate model fields:

```yaml
copilot:
  model: ["Claude Opus 4.5 (copilot)", "Claude Opus 4.6 (copilot)"]
cc:
  model: opus
```

**Model resolution:** Templates declare an abstract **type** (`opus`, `sonnet`,
`haiku`, `gpt`, `gpt-terra`, `gpt-sol`); `scripts/generate.js` renders it to a
platform string via the `MODEL_TYPES` registry — Claude types become
`Claude <Tier> <version> (copilot)`, and the GPT-family types (`gpt`, `gpt-terra`,
`gpt-sol`) become `GPT-<version> (copilot)`. The version comes from
`models.<type>` in config. A user's `agents.<agent>.copilot` config entry can
override which type an agent uses **for Copilot only**; Claude Code always uses
the template's `cc:` Claude type. See the README "Non-Claude Models" section for
configuration, including the Terra/Sol coexistence example.

Adding a future GPT SKU is a one-line registry addition —
`"gpt-<name>": gptVariant(),` next to `MODEL_TYPES` in `scripts/generate.js` —
since all GPT-family entries share one shape via the `gptVariant()` factory. See
the README "Adding a future GPT SKU?" note so this doc and README.md don't drift.

---

## Complete Agent Example

See [agents/explorer.template.md](agents/explorer.template.md) for a complete template demonstrating all features:

- Full frontmatter with both `copilot:` and `cc:` sections
- Shared body content (default)
- CC-only platform notes block
