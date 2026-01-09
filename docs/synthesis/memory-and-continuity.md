# Memory and Session Continuity

> How AGENTS handles the fundamental problem that AI coding agents forget everything between sessions.

---

## The Problem

AI coding agents have no persistent memory between sessions. Each new conversation starts fresh—the agent only knows what it can find on disk at boot time.

### The "Write-Only Memory" Problem

> "Markdown files are write-only memory for agents." — Steve Yegge (Beads)

Plans and research documents written during a session become difficult to use later:

| Problem                   | Why It Matters                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| **Query Problem**         | Agent can't ask "what issues are blocking X?" of a markdown file      |
| **Staleness**             | Plans written at session start may not reflect current state          |
| **Dependencies as Prose** | "After step 2" is unqueryable; `"depends": ["task-123"]` is queryable |
| **Scale Problem**         | At 100+ plan files, agents can't navigate or prioritize               |

The insight: prose plans work for single sessions but break down over time.

---

## Approaches Evaluated

### 1. Memory Bank Pattern (RIPER / Context Cortex)

**What it is:** Persistent context files maintained across sessions:

```
projectbrief.md      # Core requirements
systemPatterns.md    # Established patterns
techContext.md       # Tech stack details
activeContext.md     # Current focus
progress.md          # Task status
```

**Status:** Rejected

**Rationale:** Different philosophy—Memory Bank focuses on persistent learning and active context; AGENTS focuses on structured workflow phases and explicit control. Session continuity is better handled by explicit handoffs at workflow boundaries than implicit memory updates.

**Reference:** [RDR-002](../research/RDR-002-context-cortex.md)

---

### 2. MCP Memory Servers

**What it is:** Model Context Protocol servers that provide memory tools to agents. The official `@modelcontextprotocol/server-memory` uses a knowledge graph with entities, relations, and observations stored in JSONL.

**Status:** Rejected

**Rationale:** Adds significant complexity (Node process, mcp.json config, JSONL storage, maintenance burden) without proportional benefit. The Handoff agent achieves similar cross-session persistence with simpler architecture: markdown files, human-readable, version-controlled, no external dependencies.

**Reference:** [RDR-009](../research/RDR-009-mcp-memory-rejected.md)

---

### 3. Issue Tracker Memory (Beads)

**What it is:** A memory system using an issue-tracker metaphor with JSONL files stored in git. Issues have types (Epic → Story → Task → Defect), first-class dependencies, and structured queries via CLI (`bd ready --json`).

**Key Insight:** Don't try to make markdown files smarter. Use a different data structure (issue tracker) with structured queries.

**Status:** Future Consideration

**When to Revisit:**

- Multi-day/multi-week features become common
- Session context overflow is blocking work
- Team workflows need progress visibility
- Pattern of "where was I?" questions at session start

**Rationale:** Not adopted now because it adds CLI tooling dependency, new file format, and workflow changes. Current single-session focus doesn't require this infrastructure. But it's the right solution when scale demands it.

**Reference:** [RDR-005](../research/RDR-005-beads.md)

---

### 4. Task-Centric Persistence (Adopted)

**What it is:** Automatic persistence of Explore agent outputs to structured task directories. Explore saves its work with descriptive filenames after user confirmation.

**How it works:**

```
User: "I want to add authentication"

Explore: [researches] → "Save as auth_flow.md?" → .tasks/add-auth/explore/auth_flow.md

User: "Continue working on add-auth"

Implement: [reads .tasks/add-auth/explore/*] → implements
```

**Directory structure:**

```
.tasks/
    [task-slug]/
        task.md              # Metadata
        explore/*.md         # Research with descriptive names
        implement/*.md       # Progress notes (optional)
```

**Status:** Adopted

**Rationale:**

- Solves multi-session continuity without infrastructure complexity
- Descriptive filenames make research findable
- Implement reads prior context automatically
- Human-readable files that can be reviewed and edited
- No external dependencies
- Update-by-default within a session (no file proliferation)

**Key design decisions:**

- Explore has scoped write access (only to `.tasks/`)
- Review remains read-only (reports findings, doesn't persist them)
- Same-session updates go to the same file automatically
- Descriptive filenames instead of timestamps

---

## Decision Matrix

| Situation                           | Recommended Approach                |
| ----------------------------------- | ----------------------------------- |
| Single session, single task         | Optional: save for future reference |
| Continue tomorrow on same feature   | Automatic with .tasks/              |
| Research multiple areas of codebase | Save each as descriptive file       |
| Multi-week epic with many tasks     | Consider Beads (future)             |
| Team needs visibility into progress | Consider Beads (future)             |
| Need to query "what's blocking X?"  | Consider Beads (future)             |

---

## Current Solution Summary

AGENTS uses **Task-Centric Persistence** for session continuity:

1. **Explore** agent researches and asks to save with descriptive filename
2. Research is written to `.tasks/[task-slug]/explore/` directory
3. **Implement** automatically reads prior task context
4. New session: Just say "Continue working on [task-name]"
5. Within a session, Explore updates the same file (no prompting)

For implementation details, see the agent definitions in `.github/agents/`.

---

## Key Quotes

> "The problem we all face with coding agents is that they have no memory between sessions." — Steve Yegge

> "Markdown files are write-only memory for agents." — Steve Yegge

> "Handoffs are complementary to Beads, not competing. Use handoffs for day-to-day continuity; consider Beads when multi-week tracking becomes necessary." — RDR-007

---

## Related Documents

- [Prevailing Wisdom](./prevailing-wisdom.md) — Core framework principles
- [Framework Comparison](./framework-comparison.md) — How source frameworks handle context
- [Explore Agent](../../.github/agents/explore.agent.md) — Task persistence implementation
