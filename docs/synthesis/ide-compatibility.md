# IDE Compatibility

| Field      | Value      |
| ---------- | ---------- |
| **Date**   | 2026-02-14 |
| **Status** | Active     |

## Summary

AGENTS framework compatibility across VS Code, Claude Code, Cursor, and IntelliJ. Analysis of what features work on each platform and why some don't.

---

## Support Matrix

| IDE         | Agents | Skills | Instructions | Status                          |
| ----------- | ------ | ------ | ------------ | ------------------------------- |
| VS Code     | ✅     | ✅     | ✅           | Full support                    |
| Claude Code | ✅     | ✅     | ✅           | Full support (native subagents) |
| Cursor      | ❌     | ✅     | ❌           | Skills only                     |
| IntelliJ    | ❌     | ❌     | ✅ (global)  | Global instructions only        |

---

## VS Code vs Claude Code (from RDR-017)

**Source:** [VS Code Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)

VS Code agents use `.agent.md` with 12 frontmatter fields. Claude Code uses native subagents (`.claude/agents/`) with CC-specific frontmatter.

### Architecture

Both platforms are generated from `templates/` via `scripts/generate.js`:

- **Copilot:** `generated/copilot/agents/*.agent.md` with Copilot YAML frontmatter
- **Claude Code:** `generated/claude/agents/*.md` with CC YAML frontmatter (tools, disallowedTools, model, skills)

Neither platform is "primary" — templates are the single source of truth.

### Feature Comparison

| Feature           | VS Code | Claude Code         |
| ----------------- | ------- | ------------------- |
| Agent modes       | ✅      | ✅ (subagents)      |
| Tool restrictions | ✅      | ✅ (tools/disallow) |
| Handoffs          | ✅      | ❌ (manual)         |
| Skills            | ✅      | ✅                  |
| Instructions      | ✅      | ✅ (rules)          |

### Key Insight

Template-based generation ensures both platforms get first-class support. The only remaining gap is handoff buttons (Copilot UI feature with no CC equivalent). CC users manually invoke the next agent.

### LSP Integration

LSP (Language Server Protocol) tools provide symbol navigation, go-to-definition, and find-references — critical for agents that need to understand code structure without grep-based guessing.

| Capability           | VS Code Copilot                    | Claude Code                                        |
| -------------------- | ---------------------------------- | -------------------------------------------------- |
| LSP tools available  | ✅ Native (`usages`, `get_errors`) | ⚠️ Requires `ENABLE_LSP_TOOL=1` in settings        |
| Setup needed         | None — works out of the box        | User must set env var + prompt instructions        |
| Preference over grep | Automatic (built-in tools)         | Needs explicit instruction to prefer Graphify, then LSP, over grep |

**AGENTS status:** All Claude Code agent templates already declare LSP in their tool lists, but Claude Code requires user-side setup:

1. Set `ENABLE_LSP_TOOL=1` in Claude Code settings to enable LSP tools
2. Agent prompts should instruct CC to prefer Graphify, then LSP, over grep for symbol navigation

This is a **Claude Code-specific gap** — VS Code Copilot has native LSP integration with no setup required. Future template updates may add explicit LSP preference instructions to CC agent prompts.

---

## Cursor Analysis (from RDR-029)

**Source:** [Cursor Modes](https://cursor.com/docs/agent/modes), [Cursor Commands](https://cursor.com/docs/context/commands)

### Built-in Modes (not extensible)

| Mode      | Purpose                               | Tool Access              |
| --------- | ------------------------------------- | ------------------------ |
| **Agent** | Full autonomous coding (default)      | All tools                |
| **Ask**   | Read-only exploration, no changes     | Search only              |
| **Plan**  | Creates detailed plans before coding  | All tools                |
| **Debug** | Hypothesis-driven debugging with logs | All tools + debug server |

These are **hardcoded modes**, not user-configurable. Users cannot create custom modes with specific tool restrictions or handoffs.

### Feature Compatibility

| Our Feature           | Cursor Equivalent             | Compatible?              |
| --------------------- | ----------------------------- | ------------------------ |
| **Skills (SKILL.md)** | `~/.cursor/skills/`           | ✅ Identical format      |
| **Agent modes**       | Built-in modes only (4 fixed) | ❌ Not extensible        |
| **Custom modes**      | Deprecated → slash commands   | ❌ Soft enforcement      |
| **Tool restrictions** | Instructions in commands only | ❌ Not enforced          |
| **Handoffs**          | Not supported                 | ❌                       |
| **Mode persistence**  | N/A                           | ❌ Commands are one-shot |

### Why Rules + Commands Can't Simulate Agents

| Feature           | Simulation Approach          | Why It Fails                                                 |
| ----------------- | ---------------------------- | ------------------------------------------------------------ |
| Tool restrictions | "Don't edit files" in prompt | Model can still call edit tools—instruction, not enforcement |
| Mode persistence  | N/A                          | Commands are one-shot; next message loses mode context       |
| Handoffs          | N/A                          | No UI mechanism; user must manually invoke next command      |
| Model selection   | N/A                          | Can't specify Opus for Explorer, Sonnet for Builder          |

### Cursor Subagents

Cursor subagents (`.cursor/agents/`) are **spawned child workers**, not primary workflow modes. This is closer to our subagent fan-out pattern in Explorer, not our top-level agent modes.

---

## IntelliJ Analysis (from RDR-029)

**Source:** [IntelliJ Custom Instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions?tool=jetbrains)

### Feature Compatibility

| Feature                        | VS Code | IntelliJ | Notes                                                              |
| ------------------------------ | ------- | -------- | ------------------------------------------------------------------ |
| **Global instructions**        | ✅      | ✅       | `~/.config/github-copilot/intellij/global-copilot-instructions.md` |
| **Repo-wide instructions**     | ✅      | ✅       | `.github/copilot-instructions.md` (auto-detected)                  |
| **Path-specific instructions** | ✅      | ✅       | `.github/instructions/**/*.instructions.md`                        |
| **AGENTS.md**                  | ✅      | ✅       | Coding Agent only (not Chat)                                       |
| **Prompt files**               | ✅      | ✅       | `.github/prompts/*.prompt.md`                                      |
| **Custom agent modes**         | ✅      | ❌       | No `chat.agentFilesLocations` equivalent                           |
| **Tool restrictions**          | ✅      | ❌       | No `tools:` frontmatter enforcement                                |
| **Skills (auto-activate)**     | ✅      | ❌       | No `chat.skillsFilesLocations` equivalent                          |

### What Can Be Installed for IntelliJ

| Component        | Count | Installable | Reason                                    |
| ---------------- | ----- | ----------- | ----------------------------------------- |
| **Agents**       | 4     | ❌          | Require tool restrictions + handoffs      |
| **Skills**       | 11    | ❌          | Require skills file location discovery    |
| **Instructions** | 5     | ✅ (1 only) | Only global instructions have target path |

**Global instructions path:**

- macOS/Linux: `~/.config/github-copilot/intellij/global-copilot-instructions.md`
- Windows: `C:\Users\USERNAME\AppData\Local\github-copilot\intellij\global-copilot-instructions.md`

---

## The Core Problem

The AGENTS workflow (Explorer → Builder → Reviewer → Committer) depends on VS Code-specific features:

| Feature Required     | VS Code                         | Cursor                | IntelliJ         |
| -------------------- | ------------------------------- | --------------------- | ---------------- |
| Tool restrictions    | `tools:` frontmatter (enforced) | ❌ Not supported      | ❌ Not supported |
| Agent discovery      | `chat.agentFilesLocations`      | ❌ Not supported      | ❌ Not supported |
| Skills auto-activate | `chat.skillsFilesLocations`     | ✅ `~/.cursor/skills` | ❌ Not supported |
| Handoff buttons      | In-context actions              | ❌ Not supported      | ❌ Not supported |
| Global instructions  | `~/.copilot/instructions/`      | ❌ Not supported      | ✅ Supported     |

**Key insight:** Our Explorer agent _cannot_ accidentally edit code—VS Code blocks the tools. In Cursor/IntelliJ, "don't edit files" is just a polite request the model can ignore.

---

## What Would Enable Full Adoption

### Cursor

1. User-defined modes with tool restrictions (like VS Code's `tools:` frontmatter)
2. Mode persistence across messages
3. Handoff UI or next-mode suggestions

### IntelliJ

1. Custom agent mode files with tool restrictions
2. Skills file location discovery setting
3. Handoff UI mechanisms

---

## See Also

**Architectural Decision:** [ADR-005](../architecture/ADR-005-ide-compatibility.md)

- [Cursor Docs](https://cursor.com/docs/agent/modes) — Built-in modes
- [IntelliJ Custom Instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions) — Official guide
- [Custom Instructions Support Matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) — Feature comparison
- [Agent Skills Standard](https://agentskills.io/) — Skills format specification
