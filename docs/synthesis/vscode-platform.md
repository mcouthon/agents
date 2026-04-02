# VS Code Copilot Platform

| Field      | Value             |
| ---------- | ----------------- |
| **Date**   | 2026-02-14        |
| **Status** | Partially Adopted |

## Summary

Platform-specific VS Code Copilot features: settings, tools, and 1.109 orchestration capabilities. This consolidates research from three RDRs covering the VS Code platform.

---

## Settings (from RDR-014)

**Source:** [VS Code Copilot Setup](https://code.visualstudio.com/docs/copilot/setup)

### Recommended Configuration

```json
{
  "chat.agent.enabled": true,
  "chat.agent.maxRequests": 50,
  "chat.useAgentsMdFile": true,
  "chat.useNestedAgentsMdFiles": true,
  "chat.useAgentSkills": true,
  "github.copilot.chat.summarizeAgentConversationHistory.enabled": true,
  "github.copilot.chat.agent.autoFix": true,
  "chat.tools.terminal.enableAutoApprove": true,
  "chat.tools.terminal.blockDetectedFileWrites": "outsideWorkspace"
}
```

### What We Adopted

- Documented recommended settings above
- Enabled `chat.useNestedAgentsMdFiles` for monorepo support
- Validated agentskills.io alignment for skill format

### Not Needed

No changes needed—AGENTS is already aligned with VS Code's native architecture.

### Key Insight

Skills use 3-level progressive loading: Discovery (~100 tokens) → Instructions (<5000 tokens) → Resources (as needed). Personal skills location changed to `~/.copilot/skills` in v1.108. VSCode natively supports AGENTS.md via agentskills.io standard.

---

## Agent Tools (from RDR-015)

**Source:** [VS Code Copilot Features](https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features)

VS Code Copilot provides 30+ built-in tools. This research evaluated tool selections for AGENTS framework agents.

### What We Added

| Tool          | Agent               | Purpose                                         |
| ------------- | ------------------- | ----------------------------------------------- |
| `usages`      | Explorer            | Find References + Implementations + Definitions |
| `testFailure` | Reviewer            | Complements `runTests` for failure analysis     |
| `changes`     | Reviewer, Committer | Structured source control view                  |

### Tools Not Adopted

- **Notebook tools** (`#editNotebook`, `#runCell`)—specialized, not general-purpose
- **VS Code management tools** (`#extensions`, `#installExtension`)—IDE management
- **Setup tools** (`#new`, `#newWorkspace`)—project scaffolding, specialized
- **Tool sets** (`#edit`, `#search`)—explicit tool listing is more transparent

### Key Insight

The `#usages` tool is critical for code understanding—it combines three navigation capabilities essential for tracing code relationships. The AGENTS naming convention (`read/`, `edit/`, `execute/`) provides clear permission semantics.

---

## 1.109 Orchestration (from RDR-031)

**Source:** [VS Code 1.109 Release Notes](https://code.visualstudio.com/updates/v1_109)

VS Code 1.109 added agent orchestration capabilities: custom agents as subagents, parallel execution, new frontmatter for scope control.

### What We Adopted

| Feature                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `chat.agentFilesLocations` | Custom agent file locations → `~/.copilot/agents/`   |
| `agents` frontmatter       | Scope control for which subagents an agent can spawn |
| `user-invokable: false`    | Internal subagents hidden from picker                |
| `disable-model-invocation` | Explicit-only agents                                 |
| Model fallback arrays      | Multiple model options                               |
| Conductor agent            | Conductor pattern for task management                |
| Researcher subagent        | Internal agent for context-isolated reading          |

### Partially Adopted

- **`askQuestions` tool** — Used in Conductor for pause points
- **Copilot memory** — Enabled but relies on AGENTS.md Learned Patterns

### Not Adopted

- **Auto-invocation by model** — Prefer explicit subagent spawns

### Key Insight

Context isolation via subagents is the key capability. Parent agents stay focused while subagents handle deep exploration. The `agents` frontmatter enforces which subagents an agent can spawn, preventing scope creep.

---

## See Also

- [VS Code Copilot Setup](https://code.visualstudio.com/docs/copilot/setup) — Official settings reference
- [VS Code Copilot Features](https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features) — Tool reference
- [VS Code 1.109 Release Notes](https://code.visualstudio.com/updates/v1_109) — Orchestration features
- [agentskills.io](https://agentskills.io/) — Open standard for agent skills
- [memory-and-continuity.md](memory-and-continuity.md) — Subagent context isolation patterns
