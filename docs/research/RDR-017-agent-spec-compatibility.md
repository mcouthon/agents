# Research Decision Record: Agent Specification Compatibility

| Field        | Value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| **Source**   | https://code.visualstudio.com/docs/copilot/customization/custom-agents |
| **Reviewed** | 2026-01-07                                                             |
| **Status**   | Partially Adopted                                                      |

## Summary

Investigated the VS Code Copilot custom agents specification and Claude Code's configuration model to determine compatibility. VS Code's agent specification is well-documented with 12 frontmatter fields. Claude Code uses a completely different model—it doesn't support `.agent.md` files. Implemented a lightweight compatibility layer using Claude Code's slash commands.

## Key Concepts

| Concept           | Description                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| Agent Frontmatter | YAML header in `.agent.md` with name, description, tools, model, handoffs      |
| Tool Restrictions | VS Code enforces per-agent tool lists; Claude Code has global permissions only |
| Handoffs          | VS Code feature for guided transitions between agents; no CC equivalent        |
| Slash Commands    | Claude Code's custom commands from `.claude/commands/` directory               |
| CLAUDE.md         | Claude Code's instruction file format (equivalent to AGENTS.md)                |

## VS Code Agent Specification (Well-Defined)

| Field             | Type    | Description                                  |
| ----------------- | ------- | -------------------------------------------- |
| `name`            | string  | Agent display name (defaults to filename)    |
| `description`     | string  | Placeholder text in chat input               |
| `argument-hint`   | string  | User interaction hint                        |
| `tools`           | array   | Available tools list                         |
| `model`           | string  | AI model (e.g., "Claude Sonnet 4", "Opus")   |
| `infer`           | boolean | Subagent eligibility (default: true)         |
| `target`          | string  | Environment: vscode or github-copilot        |
| `mcp-servers`     | array   | MCP server configs for github-copilot target |
| `handoffs`        | array   | Handoff definitions                          |
| `handoffs.label`  | string  | Button text                                  |
| `handoffs.agent`  | string  | Target agent identifier                      |
| `handoffs.prompt` | string  | Prompt to send                               |
| `handoffs.send`   | boolean | Auto-submit (default: false)                 |

## Claude Code Compatibility Matrix

| Feature           | VS Code               | Claude Code         | Compatible?  |
| ----------------- | --------------------- | ------------------- | ------------ |
| Agent modes       | `.agent.md`           | Not supported       | ❌           |
| Instructions      | `*.instructions.md`   | `CLAUDE.md`         | Different    |
| Tool restrictions | Per-agent `tools:`    | Global only         | ❌           |
| Model selection   | Per-agent `model:`    | CLI flag only       | ❌           |
| Handoffs          | `handoffs:` array     | Not available       | ❌           |
| Slash commands    | `/` from prompt files | `/<command>`        | ✅ Similar   |
| Skills            | `~/.github/skills/`   | `~/.claude/skills/` | ✅ Symlinked |

## Decision

**Adopted:**

1. Generate Claude Code slash commands from agent file bodies during `install.sh`
2. Strip frontmatter and copy body to `~/.claude/commands/<agent>.md`
3. Skip `handoff` agent (doesn't make sense as standalone command)
4. Update README to document Claude Code usage with feature differences
5. Update uninstall to clean up generated commands

**Rationale:**

The 80/20 approach: the core value is the methodology in each agent's instructions, not the tool enforcement or handoff buttons. By generating slash commands, Claude Code users get:

- Explore methodology (research before code)
- Implementation discipline (follow the plan)
- Review checklist (verify before commit)
- Commit conventions (semantic messages)

What they don't get (acceptable losses):

- Tool enforcement (Claude generally respects instructions anyway)
- Handoff buttons (run next command manually—trivial)
- Model selection (use `claude --model opus` if needed)

**Not Adopted:**

- Complex file-based handoff state management (overengineered)
- Tool restriction instructions prepended to each command (marginal value, adds noise)
- Auto-generated CLAUDE.md (users may already have one; README docs suffice)

## Comparison to Current Framework

| Component      | Before                         | After                         |
| -------------- | ------------------------------ | ----------------------------- |
| VS Code agents | Fully functional               | Unchanged                     |
| Claude Code    | Agents copied but ignored      | Slash commands generated      |
| Skills         | Working via symlink            | Unchanged                     |
| Documentation  | Claims CC support (misleading) | Clarifies feature differences |
