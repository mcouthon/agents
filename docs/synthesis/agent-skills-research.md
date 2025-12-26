# Agent Skills Research

> **Status**: ✅ Implemented (Phase 6 complete)
> Research conducted December 26, 2025. Phase 6 implementation completed same day.

## Overview

**Agent Skills** are an open standard for teaching AI agents specialized tasks. GitHub Copilot added support on December 18, 2025.

### Implementation Summary

All 10 agents have been converted to SKILL.md format in `.github/skills/`:

| Skill Name          | Purpose                         | Trigger Examples                         |
| ------------------- | ------------------------------- | ---------------------------------------- |
| `research-codebase` | Deep codebase exploration       | "how does X work", "explore the code"    |
| `create-plan`       | Create implementation plans     | "create a plan", "design a solution"     |
| `implement-plan`    | Execute planned changes         | "implement the plan", "build this"       |
| `review-code`       | Verify implementation quality   | "review my changes", "before merge"      |
| `debug`             | Systematic bug investigation    | "this is broken", "fix this bug"         |
| `tech-debt`         | Find and fix tech debt          | "tech debt audit", "code smells"         |
| `architecture`      | High-level system documentation | "architecture overview", "system design" |
| `mentor`            | Socratic teaching style         | "teach me", "help me understand"         |
| `janitor`           | Clean and simplify code         | "remove dead code", "clean up"           |
| `critic`            | Challenge assumptions           | "find weaknesses", "devil's advocate"    |

### Key Sources

1. [GitHub Changelog Announcement](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
2. [Official GitHub Docs](https://docs.github.com/copilot/concepts/agents/about-agent-skills)
3. [Agent Skills Specification](https://agentskills.io/specification)
4. [agentskills/agentskills repo](https://github.com/agentskills/agentskills)
5. [anthropics/skills repo](https://github.com/anthropics/skills)

## What Are Agent Skills?

Skills are **folders of instructions, scripts, and resources** that agents can load dynamically to improve performance on specialized tasks.

Key characteristics:

- **Automatic activation**: Agent reads skill descriptions and decides when to use them based on your prompt
- **Cross-platform**: Works with Claude Code, GitHub Copilot, and other agents implementing the standard
- **Progressive disclosure**: Only metadata loaded always; full instructions loaded when activated
- **Open standard**: Maintained by Anthropic, open to community contributions

## Platform Support

| Platform             | Status       | Notes                 |
| -------------------- | ------------ | --------------------- |
| Copilot coding agent | ✅ Supported | Works now             |
| GitHub Copilot CLI   | ✅ Supported | Works now             |
| VSCode Insiders      | ✅ Supported | Agent mode            |
| VSCode Stable        | ⏳ Coming    | Early January 2025    |
| Claude Code          | ✅ Supported | Via `.claude/skills/` |

## Directory Structure

Skills live in `.github/skills/` (Copilot) or `.claude/skills/` (Claude Code):

```
.github/skills/
└── skill-name/
    ├── SKILL.md           # Required - main instructions
    ├── scripts/           # Optional - executable code
    ├── references/        # Optional - detailed documentation
    └── assets/            # Optional - templates, data files
```

## SKILL.md Format

### Required Frontmatter

```yaml
---
name: skill-name # Must match directory name
description: What this skill does... # Max 1024 chars
---
```

### Optional Frontmatter

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files...
license: Apache-2.0 # License info
compatibility: Requires git, docker # Environment requirements
allowed-tools: Bash(git:*) Read # Pre-approved tools (experimental)
metadata:
  author: example-org
  version: "1.0"
---
```

### Name Field Rules

- 1-64 characters
- Lowercase alphanumeric and hyphens only (`a-z`, `0-9`, `-`)
- Must not start or end with hyphen
- No consecutive hyphens (`--`)
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Field (Critical for Auto-Activation)

The description is how agents decide when to use a skill. Include:

- What the skill does
- When to use it
- Trigger keywords/phrases

**Good example:**

```yaml
description: >
  Extracts text and tables from PDF files, fills PDF forms, and merges 
  multiple PDFs. Use when working with PDF documents or when the user 
  mentions PDFs, forms, or document extraction.
```

**Poor example:**

```yaml
description: Helps with PDFs.
```

### Body Content

The Markdown body contains the actual instructions. Recommendations:

- Keep under 500 lines
- Include step-by-step procedures
- Add examples of inputs/outputs
- Document edge cases
- Move detailed reference material to `references/` subdirectory

## Progressive Disclosure

Skills are designed for efficient context use:

1. **Metadata (~100 tokens)**: `name` and `description` loaded at startup for ALL skills
2. **Instructions (< 5000 tokens recommended)**: Full `SKILL.md` body loaded when skill activates
3. **Resources (as needed)**: Scripts, references, assets loaded only when required

## How Activation Works

1. User sends a prompt
2. Agent scans all skill descriptions
3. Agent determines which skills are relevant based on keywords/intent
4. Relevant `SKILL.md` files are injected into context
5. Agent follows the instructions

This is **automatic** - users don't need to explicitly invoke a skill.

## Comparison: Current Framework vs Skills

| Aspect              | Current (.agent.md)     | Agent Skills (SKILL.md)  |
| ------------------- | ----------------------- | ------------------------ |
| **Activation**      | Manual (model picker)   | Automatic (prompt-based) |
| **Location**        | `prompts/workflow/`     | `.github/skills/`        |
| **Cross-platform**  | VSCode Copilot only     | Copilot + Claude Code    |
| **User experience** | Must remember to switch | Just ask naturally       |
| **Context loading** | Full file always        | Progressive disclosure   |

## Conversion Strategy

### Core Workflow Skills

These need rich, procedural instructions (HumanLayer-style):

| Current File         | Skill Name          | Trigger Keywords                                                       |
| -------------------- | ------------------- | ---------------------------------------------------------------------- |
| `research.agent.md`  | `research-codebase` | "how does X work", "find where", "trace flow", "understand", "explore" |
| `plan.agent.md`      | `create-plan`       | "create a plan", "implementation plan", "design", "approach for"       |
| `implement.agent.md` | `implement-plan`    | "implement", "execute plan", "build", "code this"                      |
| `review.agent.md`    | `review-code`       | "review", "check my changes", "verify", "before merge"                 |

### Utility Skills

These can remain simpler:

| Current File            | Skill Name     | Trigger Keywords                                       |
| ----------------------- | -------------- | ------------------------------------------------------ |
| `debug.agent.md`        | `debug`        | "bug", "error", "fix", "broken", "not working"         |
| `tech-debt.agent.md`    | `tech-debt`    | "tech debt", "refactor", "cleanup", "improve code"     |
| `architecture.agent.md` | `architecture` | "architecture", "design doc", "system overview"        |
| `mentor.agent.md`       | `mentor`       | "teach me", "explain", "help me understand", "learn"   |
| `janitor.agent.md`      | `janitor`      | "clean up", "remove dead code", "simplify"             |
| `critic.agent.md`       | `critic`       | "challenge", "devil's advocate", "what could go wrong" |

## Example SKILL.md Conversion

### Before (research.agent.md frontmatter):

```yaml
---
name: Research
description: Deep codebase exploration
tools: ["codebase", "search", "read"]
---
```

### After (SKILL.md):

```yaml
---
name: research-codebase
description: >
  Deep codebase exploration and research. Use when asked to understand how 
  code works, trace data flow, find existing patterns, or explore architecture.
  Triggers: "how does X work", "find where Y is defined", "trace the flow of Z",
  "understand the codebase", "research this", "explore the code".
---
# Research Codebase

[Full procedural instructions from research.agent.md body]
```

## install.sh Updates Needed

1. Keep existing instruction file symlinks (for always-on behavior)
2. Add `.github/skills/` support:
   - Option A: Symlink entire `.github/skills/` to a global location (if Copilot supports)
   - Option B: Skills work per-repo only (current behavior)
3. Create `.claude/skills/` → `.github/skills/` symlink for Claude Code compatibility

## Testing Plan

1. Install VSCode Insiders
2. Create skill files in `.github/skills/`
3. Test auto-activation:
   - "How does authentication work in this repo?" → should load `research-codebase`
   - "Create a plan to add user notifications" → should load `create-plan`
   - "This function is broken" → should load `debug`
4. Verify skill instructions are followed
5. Test Claude Code compatibility via `.claude/skills/` symlink

## Open Questions

1. **Global skills**: Can skills be installed globally, or only per-repo?

   - Current evidence suggests per-repo only
   - May need to symlink `.github/skills/` into each project

2. **Skill priority**: What happens when multiple skills could apply?

   - Unclear from docs; needs testing

3. **Combining with instructions**: How do skills interact with `.instructions.md` files?

   - Both load; skills are additive context

4. **Model hints**: Does `model: opus` work in SKILL.md frontmatter?
   - Not in spec; likely Copilot-specific or unsupported

## References

- [Anthropic blog: Equipping agents for the real world with Agent Skills](https://anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Claude Skills support article](https://support.claude.com/en/articles/12512176-what-are-skills)
- [Creating custom skills](https://support.claude.com/en/articles/12512198-creating-custom-skills)
