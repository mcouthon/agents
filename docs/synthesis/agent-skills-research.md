# Agent Skills Research

> **Status**: ✅ Implemented (Phase 7 complete - Agents + Skills architecture)
> Research conducted December 26, 2025. Phase 7 refactored to use both Custom Agents and Skills.

## Overview

**Agent Skills** are an open standard for teaching AI agents specialized tasks. GitHub Copilot added support on December 18, 2025.

**Custom Agents** are VS Code-specific configurations that provide enforced tool access and handoffs between workflow phases.

### Implementation Summary

The framework now uses **both** mechanisms:

- **4 Custom Agents** for the core workflow (enforced tool restrictions + handoffs)
- **6 Agent Skills** for utility capabilities (auto-activation)

| Custom Agents (`.github/agents/`) | Agent Skills (`.github/skills/`) |
| --------------------------------- | -------------------------------- |
| `research.agent.md`               | `debug/`                         |
| `plan.agent.md`                   | `tech-debt/`                     |
| `implement.agent.md`              | `architecture/`                  |
| `review.agent.md`                 | `mentor/`                        |
|                                   | `janitor/`                       |
|                                   | `critic/`                        |

### Why This Architecture?

The core workflow (Research → Plan → Implement → Review) requires:

- **Enforced tool restrictions** (Plan agent can't edit files)
- **Handoffs** between phases with context
- **Explicit user selection** from agent picker

Agent Skills don't support tool restrictions or handoffs. Per the agentskills.io spec:

> `allowed-tools: ... # Pre-approved tools (Experimental)`

This is experimental and not reliably enforced.

### Key Sources

1. [VS Code Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
2. [VS Code Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
3. [GitHub Changelog Announcement](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
4. [Agent Skills Specification](https://agentskills.io/specification)
5. [agentskills/agentskills repo](https://github.com/agentskills/agentskills)

## Custom Agents vs Agent Skills

| Capability            | Custom Agents (.agent.md)      | Agent Skills (SKILL.md)            |
| --------------------- | ------------------------------ | ---------------------------------- |
| **Tool restrictions** | ✅ Enforced via `tools:` array | ❌ `allowed-tools` is experimental |
| **Handoffs**          | ✅ Supported via `handoffs:`   | ❌ Not supported                   |
| **Model selection**   | ✅ Via `model:` field          | ❌ Not supported                   |
| **Activation**        | Manual (agent picker)          | Automatic (prompt-based)           |
| **Portability**       | VS Code only                   | Cross-platform (CLI, coding agent) |
| **Scripts/resources** | Instructions only              | Can include scripts/, assets/      |

## When to Use Which

| Use Case                     | Use       |
| ---------------------------- | --------- |
| Enforced read-only access    | **Agent** |
| Workflow phase transitions   | **Agent** |
| Auto-activation from prompts | **Skill** |
| Include executable scripts   | **Skill** |
| Cross-platform portability   | **Skill** |
| Specialized methodologies    | **Skill** |

````yaml
---
name: Research
## Custom Agent Format

Custom agents use `.agent.md` files in `.github/agents/`:

```yaml
---
name: Plan
description: Create implementation plans with read-only access.
tools: ['codebase', 'search', 'fetch', 'githubRepo', 'usages', 'problems']
model: Claude Sonnet 4
handoffs:
  - label: Start Implementation
    agent: implement
    prompt: Implement the plan outlined above.
    send: false
---
# Plan Mode

[Detailed instructions...]
````

## Agent Skill Format

Agent skills use `SKILL.md` files in `.github/skills/<skill-name>/`:

```yaml
---
name: debug
description: >
  Systematic debugging with hypothesis-driven investigation. Use when something
  is broken, tests are failing, or errors need investigation. Triggers on:
  "this is broken", "debug", "why is this failing", "bug", "fix this issue".
---
# Debug Mode

[Detailed instructions...]
```

## References

- [VS Code Custom Agents Docs](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code Agent Skills Docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [Agent Skills Specification](https://agentskills.io/specification)
- [GitHub Agent Skills Announcement](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
