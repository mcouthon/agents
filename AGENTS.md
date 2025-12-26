# Agentic Coding Framework

This framework provides **4 Custom Agents** for the core workflow (with enforced tool access and handoffs) plus **6 Agent Skills** that auto-activate based on your prompts.

## How It Works

### Custom Agents (Core Workflow)

Select agents from the **agent picker dropdown** in VS Code. Each agent has:

- **Enforced tool restrictions** (e.g., Plan can't edit files)
- **Handoff buttons** to transition to the next workflow phase

| Your Goal                     | Select Agent |
| ----------------------------- | ------------ |
| Understand how code works     | `Research`   |
| Create an implementation plan | `Plan`       |
| Execute the planned changes   | `Implement`  |
| Verify before merging         | `Review`     |

### Agent Skills (Utilities)

Skills load automatically based on your prompt. Just ask naturally:

| Your Prompt                        | Skill Activated |
| ---------------------------------- | --------------- |
| "This test is failing, help debug" | `debug`         |
| "Find TODOs and code smells"       | `tech-debt`     |
| "Document the system architecture" | `architecture`  |
| "Teach me how this works"          | `mentor`        |
| "Clean up dead code"               | `janitor`       |
| "Challenge my approach"            | `critic`        |

## The Core Workflow

For substantial changes, follow this pattern:

```
Research → Plan → Implement → Review
   ↑_________________________________↓ (iterate)
```

Each agent has a **handoff button** that appears after completion:

1. **Select Research agent** → Explore the codebase
2. **Click "Create Plan" handoff** → Switch to Plan agent
3. **Click "Start Implementation" handoff** → Switch to Implement agent
4. **Click "Review Changes" handoff** → Switch to Review agent
5. **Review passes** → Ready to merge! ✅

## Available Agents

### Core Workflow (Custom Agents)

| Agent       | Purpose                       | Tools                                                                  |
| ----------- | ----------------------------- | ---------------------------------------------------------------------- |
| `Research`  | Deep codebase exploration     | codebase, search, fetch, githubRepo, usages, problems, findTestFiles   |
| `Plan`      | Create implementation plans   | codebase, search, fetch, githubRepo, usages, problems                  |
| `Implement` | Execute planned changes       | codebase, search, editFiles, runInTerminal, runTests, problems, usages |
| `Review`    | Verify implementation quality | codebase, search, runTests, problems, usages, changes                  |

### Utilities (Agent Skills)

| Skill          | Purpose                         |
| -------------- | ------------------------------- |
| `debug`        | Systematic bug investigation    |
| `tech-debt`    | Find and fix technical debt     |
| `architecture` | High-level design documentation |
| `mentor`       | Teaching through questions      |
| `janitor`      | Cleanup and simplification      |
| `critic`       | Challenge assumptions           |

## Code Protection Markers

Use these **advisory** markers in code comments to protect important code.
Skills will respect these markers but enforcement is not programmatic.

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

## Adding Your Own

### Custom Agent

Create a new agent file:

```
.github/agents/my-agent.agent.md
```

With this structure:

```yaml
---
name: My Agent
description: What this agent does and when to use it.
tools: ["codebase", "search", "editFiles"] # Available tools
model: Claude Sonnet 4 # Optional: specific model
handoffs: # Optional: workflow transitions
  - label: Next Step
    agent: other-agent
    prompt: Continue with the next phase.
    send: false
---
# My Agent Instructions

Your detailed instructions here.
```

Run `./install.sh` to create symlinks.

### Agent Skill

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

## Agents vs Skills: When to Use Which

| Use Case                           | Use       |
| ---------------------------------- | --------- |
| Need enforced tool restrictions    | **Agent** |
| Need handoffs between phases       | **Agent** |
| Want auto-activation from prompts  | **Skill** |
| Cross-platform (CLI, coding agent) | **Skill** |
| Role-based workflow phases         | **Agent** |
| Specialized methodologies          | **Skill** |

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
