# Agentic Coding Framework

A personal framework for working with AI coding agents in VSCode + Copilot.

## Quick Start

### Installation

Copy the instruction files to your global Copilot prompts directory:

```bash
# macOS
cp instructions/*.instructions.md ~/Library/Application\ Support/Code/User/prompts/

# Linux
cp instructions/*.instructions.md ~/.config/Code/User/prompts/
```

Copy agent modes (or keep them in a workspace-specific location):

```bash
# For global access
cp prompts/*.agent.md ~/Library/Application\ Support/Code/User/prompts/

# Or for workspace-specific
mkdir -p .github/prompts
cp prompts/*.agent.md .github/prompts/
```

### Usage

**Instruction files** apply automatically based on `applyTo` patterns:

- `global.instructions.md` → all files
- `python.instructions.md` → `*.py` files
- `typescript.instructions.md` → `*.ts, *.tsx` files
- `testing.instructions.md` → test files
- `terminal.instructions.md` → all files (terminal guidance)

**Agent modes** are activated by switching modes in Copilot Chat:

1. Open Copilot Chat
2. Click the model picker (or use the dropdown)
3. Select an agent mode from the list

## Framework Contents

### Instruction Files (`./instructions/`)

| File                         | Scope                | Purpose                                                       |
| ---------------------------- | -------------------- | ------------------------------------------------------------- |
| `global.instructions.md`     | `**`                 | Core philosophy, code protection markers, communication style |
| `python.instructions.md`     | `**/*.py`            | Python standards, type hints, error handling                  |
| `typescript.instructions.md` | `**/*.{ts,tsx}`      | TypeScript patterns, React conventions                        |
| `testing.instructions.md`    | `**/*{test,spec}*.*` | Test structure, mocking, naming                               |
| `terminal.instructions.md`   | `**`                 | Shell commands, GitHub CLI, Vault                             |

### Agent Modes (`./prompts/`)

#### Tier 1: Core Workflow (Research → Plan → Execute → Review)

| Agent       | Purpose                       | Tools       | Handoffs              |
| ----------- | ----------------------------- | ----------- | --------------------- |
| `research`  | Deep codebase exploration     | Read-only   | → Plan                |
| `plan`      | Create implementation plans   | Read-only   | → Implement, Research |
| `implement` | Execute planned changes       | Full access | → Review, Plan        |
| `review`    | Verify implementation quality | Read + Test | → Implement           |

#### Tier 2: Specialized Tasks

| Agent          | Purpose                         | Key Feature                       |
| -------------- | ------------------------------- | --------------------------------- |
| `tech-debt`    | Find and fix technical debt     | Quick wins prioritization         |
| `debug`        | Systematic bug investigation    | 4-phase hypothesis-driven process |
| `architecture` | High-level design documentation | Mermaid diagrams, API contracts   |
| `mentor`       | Teaching through questions      | Socratic method, no solutions     |

#### Tier 3: Utility

| Agent     | Purpose                    | Key Feature                                 |
| --------- | -------------------------- | ------------------------------------------- |
| `janitor` | Cleanup and simplification | "Deletion is the most powerful refactoring" |
| `critic`  | Challenge assumptions      | 5 Whys technique, adversarial thinking      |

## How to Modify

### Adding a New Instruction File

1. Create `./instructions/<scope>.instructions.md`
2. Add frontmatter with `applyTo` pattern:
   ```yaml
   ---
   applyTo: "**/*.go"
   ---
   ```
3. Keep instructions focused on one concern
4. Copy to your global prompts directory

### Adding a New Agent Mode

1. Create `./prompts/<name>.agent.md`
2. Add frontmatter:
   ```yaml
   ---
   name: "Agent Name"
   description: "One-line description"
   tools: ["codebase", "search", ...] # Available tools
   handoffs: # Optional: transitions to other agents
     - label: "Button Text"
       agent: other-agent
       prompt: "Context for handoff"
       send: false
   ---
   ```
3. Define:
   - Core rules (what to always/never do)
   - Process (step-by-step workflow)
   - Output format (structured templates)
4. Copy to prompts directory

### Tool Reference

Common tool bundles:

| Bundle      | Tools                                                            |
| ----------- | ---------------------------------------------------------------- |
| Read-Only   | `codebase, search, usages, problems, findTestFiles`              |
| Read + Web  | `codebase, search, fetch, githubRepo, usages`                    |
| Full Access | `codebase, search, editFiles, runTests, runInTerminal, problems` |

### Customizing for Your Stack

1. **Add language-specific instructions**: Create `go.instructions.md`, `rust.instructions.md`, etc.
2. **Modify existing**: Edit instruction files to match your team's conventions
3. **Add domain agents**: Create agents for your specific workflows (e.g., `migration.agent.md`, `api-design.agent.md`)

### Best Practices

- **Keep agents focused**: 3-20 tool calls max
- **Use handoffs**: Create guided workflows between agents
- **Test changes**: Try modified agents on real tasks
- **Iterate**: Add to anti-patterns as you discover issues

## Core Principles

This framework is built on synthesized wisdom from:

- [HumanLayer ACE Framework](./docs/sources/humanlayer/ace-fca.md)
- [CursorRIPER Framework](./docs/sources/cursorriper/)
- [12 Factor Agents](./docs/sources/12-factor-agents/)
- [Awesome Copilot](./docs/sources/awesome-copilot/)

### Key Insights

1. **Phase-Based Workflows**: Research → Plan → Execute → Review with permission boundaries
2. **Context Engineering**: 40-60% utilization, custom formats, frequent compaction
3. **Control Flow Ownership**: Own prompts, context window, and execution flow
4. **Human-in-the-Loop**: At research/plan boundaries (highest leverage)
5. **Focused Agents**: 3-20 steps max, single-purpose over monolithic

See [Prevailing Wisdom](./docs/synthesis/prevailing-wisdom.md) for detailed analysis.

## Code Protection Markers

Use these markers in code comments to protect important code:

| Marker | Meaning   | Agent Behavior                         |
| ------ | --------- | -------------------------------------- |
| `[P]`  | Protected | Never modify without explicit approval |
| `[G]`  | Guarded   | Requires human review before changes   |
| `[D]`  | Debug     | Temporary code, remove before merge    |
| `[T]`  | Test      | Test code, can modify freely           |

Example:

```python
# [P] Core authentication - security reviewed
def verify_token(token: str) -> Claims:
    ...
```

## Troubleshooting

### Agent not appearing in Copilot

- Ensure file is in correct directory
- Check frontmatter syntax (valid YAML)
- Restart VSCode

### Instructions not applying

- Verify `applyTo` glob pattern matches your files
- Check file is in the prompts directory
- Ensure no syntax errors in frontmatter

### Agent behaving unexpectedly

- Check tool restrictions match intended behavior
- Review if instructions conflict with other files
- Add more specific constraints to the agent

## Contributing

1. Test changes with real tasks
2. Document the purpose and behavior
3. Update this README if adding new agents
4. Note any anti-patterns discovered
