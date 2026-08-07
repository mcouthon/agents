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

**Reference:** [RDR-002](../research/archive/RDR-002-context-cortex.md)

---

### 2. MCP Memory Servers

**What it is:** Model Context Protocol servers that provide memory tools to agents. The official `@modelcontextprotocol/server-memory` uses a knowledge graph with entities, relations, and observations stored in JSONL.

**Status:** Rejected

**Rationale:** Adds significant complexity (Node process, mcp.json config, JSONL storage, maintenance burden) without proportional benefit. Task-centric persistence (`.tasks/` directories) achieves similar cross-session persistence with simpler architecture: markdown files, human-readable, version-controlled, no external dependencies.

**Reference:** [RDR-009](../research/archive/RDR-009-mcp-memory-rejected.md)

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

**Reference:** [RDR-005](../research/RDR-005-beads.md). Beads' _structured-state patterns_ have since been partially adopted as `state.json` (see [§8](#8-machine-readable-state-statejson-via-mcp--adopted), RDR-034); the full issue-tracker remains future consideration.

---

### 4. Task-Centric Persistence (Adopted)

**What it is:** Automatic persistence of Explorer agent outputs to structured task directories. Explorer saves its work with descriptive filenames after user confirmation.

**How it works:**

```
User: "I want to add authentication"

Explorer: [researches] → "Save as auth_flow.md?" → .tasks/add-auth/explore/auth_flow.md

User: "Continue working on add-auth"

Builder: [reads .tasks/add-auth/explore/*] → implements
```

**Directory structure:**

```
.tasks/
    [NNN]-[task-slug]/
        task.md              # Metadata
        explore/*.md         # Research with descriptive names
        implement/*.md       # Progress notes (optional)
```

**Status:** Adopted

**Rationale:**

- Solves multi-session continuity without infrastructure complexity
- Descriptive filenames make research findable
- Builder reads prior context automatically
- Human-readable files that can be reviewed and edited
- No external dependencies
- Update-by-default within a session (no file proliferation)

**Key design decisions:**

- Explorer has scoped write access (only to `.tasks/`)
- Review remains read-only (reports findings, doesn't persist them)
- Same-session updates go to the same file automatically
- Descriptive filenames instead of timestamps

---

## Decision Matrix

| Situation                           | Recommended Approach                                   |
| ----------------------------------- | ------------------------------------------------------ |
| Single session, single task         | Optional: save for future reference                    |
| Continue tomorrow on same feature   | Automatic with .tasks/                                 |
| Research multiple areas of codebase | Save each as descriptive file                          |
| Multi-week epic with many tasks     | Consider Beads (future)                                |
| Team needs visibility into progress | Consider Beads (future)                                |
| Need to query "what's blocking X?"  | `state.json` (`blocked_by`) or Beads for full tracking |

---

## Current Solution Summary

AGENTS uses **Task-Centric Persistence** for session continuity:

1. **Explorer** agent researches and asks to save with descriptive filename
2. Research is written to `.tasks/[NNN]-[task-slug]/explore/` directory (numbered for chronological ordering)
3. **Builder** automatically reads prior task context
4. New session: Just say "Continue working on [task-name]"
5. Within a session, Explorer updates the same file (no prompting)

For implementation details, see the agent definitions in `generated/copilot/agents/`.

---

### 5. Learned Patterns (Adopted)

**What it is:** Repository-level pattern memory via a `## Learned Patterns` section in AGENTS.md. Agents can persist conventions learned during research or implementation.

**How it works:**

| Trigger                       | Agent    | Action                              |
| ----------------------------- | -------- | ----------------------------------- |
| User corrects/teaches pattern | Builder  | Offers to persist to AGENTS.md      |
| Discovers repo convention     | Explorer | Suggests adding to Learned Patterns |

**Format:**

```markdown
## Learned Patterns

| Pattern                     | Location      | Discovered |
| --------------------------- | ------------- | ---------- |
| Use winston not console.log | `src/**/*.ts` | 2026-01-26 |
```

**Inspired by:** GitHub Copilot Memory (citation-based validation, staleness handling)

**Key differences from Copilot Memory:**

- Explicit (user confirms) vs automatic
- No auto-expiry (human curation)
- IDE-focused vs GitHub platform

**Reference:** [RDR-025](../research/archive/RDR-025-copilot-memory.md)

---

### 6. Context Isolation Patterns (Subagents)

**What it is:** VS Code supports **handoffs** (preserve context) and **subagents** (fork to isolated context). Subagents return only final summaries, compacting context automatically.

**Key Distinction:**

| Pattern   | Use Case                | Context Behavior            |
| --------- | ----------------------- | --------------------------- |
| Handoffs  | Phase transitions       | Preserves context           |
| Subagents | Parallel investigations | Forks, returns summary only |

**What we adopted:**

- Enabled `runSubagent` tool in Explorer agent
- Use subagents for context-heavy explorations (file tracing, dependency analysis)
- Subagents auto-compact: main context receives summaries, not intermediate reads

**When NOT to use subagents:**

- Phase transitions—use handoffs to preserve needed context
- Tasks requiring user interaction—subagents can't prompt

**Key insight:** Subagents complement handoffs, don't replace them. Use handoffs for phase transitions (Explorer→Builder); use subagents for parallel investigations within a phase.

**Reference:** [RDR-010](../research/archive/RDR-010-subagents-context-fork.md)

---

### 7. Planning with Files (Goal Drift Prevention)

**What it is:** Re-reading the plan before major decisions combats goal drift during long sessions.

**How it works:**

| Pattern              | Implementation                                     |
| -------------------- | -------------------------------------------------- |
| Read-before-decide   | Re-read plan before major decisions                |
| Todo list as anchor  | Frequent updates refresh goals in attention window |
| Goal drift awareness | Documented in prevailing-wisdom.md                 |

After 15-50+ tool calls, original goals can drift from attention ("lost in the middle" effect). Updating working state (todos, progress) keeps goals in the attention window.

**What we adopted:**

- "Attention Management" section in Builder agent
- Periodic re-read of plan/handoff files (~15 tool calls)
- Todo list updates as attention anchor

**What we rejected:**

- Mandatory 3-file infrastructure (too much friction)
- New skill/agent for this (absorbed into existing guidance)

**Reference:** [RDR-012](../research/archive/RDR-012-planning-with-files.md)

---

### 8. Machine-Readable State (state.json via MCP) — Adopted

**What it is:** A machine-readable `state.json` shadow of `task.md` at
`.tasks/[NNN]-[task-slug]/state.json`, written and read via a dedicated MCP
(stdio) state server (`scripts/state-server.js`, 7 tools).

**What problem it solves:** Directly answers the **Query Problem** and
**Dependencies-as-Prose** rows of the write-only-memory table above —
orchestrators can ask "what phase is active / blocked / owned / flagged" and
read `blocked_by` edges without parsing markdown.

**Status:** Adopted (partial — the structured-state layer of Beads, not the
full issue tracker). Source: RDR-034, task 089.

**Key design decisions:**

- Supplements, never replaces, `task.md` — the human source of truth stays
  markdown.
- Optional and backward-compatible — absent `state.json`, agents fall back to
  parsing `task.md`.
- Introduces AGENTS' first runtime dependency, reframing the posture to
  "pure-prompt core + optional MCP state layer."
- An MCP-server implementation was chosen over prompt-based JSON editing for
  deterministic, schema-validated writes.

**Reference:** [ADR-011](../architecture/ADR-011-machine-readable-state.md),
[RDR-034](../research/RDR-034-multi-agent-orchestration.md).

---

### 9. Execution-Feedback Loop (Adopted)

**What it is:** The friction an agent hits *while building* is memory too — and it was the
one kind this framework threw away. Builder now records it as it happens, and
`consolidate-task` converts it into proposed instruction edits at task end.

**How it works:**

| Step    | Where                                                | What                                                                |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Capture | Builder → `.tasks/[slug]/plan/phase-N-*.md` `## Execution Notes` | One line per real friction: `[what happened] → [what would have prevented it]`. A clean phase writes nothing. |
| Convert | `consolidate-task`                                   | Reads those notes, filters to generalizable + actionable, proposes ≤3 instruction changes, each citing its evidence line |
| Route   | by scope                                             | Repo convention → `AGENTS.md` `## Learned Patterns`; terminology → `CONTEXT.md`; agent/skill behavior → the instruction file that owns it (here, `templates/`); framework posture → `docs/research/BACKLOG.md` (propose only) |

**How it differs from the loops already here:**

| Loop                                  | Input                       | Captured when     |
| ------------------------------------- | --------------------------- | ----------------- |
| External research (RESEARCH → RDR → `templates/`) | Ideas from outside the repo | Reading           |
| Learned Patterns, §5 (Explorer)       | What the *codebase* looks like | Researching    |
| **Execution feedback (this)**         | What *went wrong* building it | Building        |

§5 and this one share the `## Learned Patterns` sink but never the same entry: Explorer
writes what the code *is*, this loop writes what the instructions *failed to say*.

**Why capture-then-convert, not one retrospective pass:** a retrospective written from
recollection at task end is fabrication with extra steps. No `## Execution Notes` anywhere
means the honest output is "no process learnings" — which is the expected result for most
tasks, and the property most likely to regress.

**Inspired by:** Simon Willison, *Agentic Engineering Patterns* — "LLMs don't learn from
their past mistakes, but coding agents can, provided we deliberately update our
instructions."

---

## Key Quotes

> "The problem we all face with coding agents is that they have no memory between sessions." — Steve Yegge

> "Markdown files are write-only memory for agents." — Steve Yegge

> "Task-centric persistence is complementary to Beads, not competing. Use task files for day-to-day continuity; consider Beads when multi-week tracking becomes necessary." — [ADR-002](../architecture/ADR-002-task-centric-persistence.md)

---

## Related Documents

- [Prevailing Wisdom](./prevailing-wisdom.md) — Core framework principles
- [Framework Comparison](./framework-comparison.md) — How source frameworks handle context
- [Explore Agent](../../generated/copilot/agents/explorer.agent.md) — Task persistence implementation
