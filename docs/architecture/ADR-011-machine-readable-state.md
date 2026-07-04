# Machine-Readable State (MCP State Server & state.json)

**Source:** Task 089 (July 2026)

## Decision

Add a machine-readable `state.json` shadow of `task.md` at
`.tasks/[NNN-slug]/state.json`, written and read via a dedicated **MCP (stdio)
server** (`scripts/state-server.js`) that exposes **7 deterministic tools**:
`state_init`, `state_update`, `state_flag`, `state_clear_flag`, `state_read`,
`state_prime`, and `tasks_list`. The implementation evolved from the
initially-planned pure-prompt, zero-dependency JSON convention to an
MCP-server implementation after prompt-based JSON editing proved error-prone
(trailing commas, schema inconsistencies, validation replication across
templates). `state.json` supplements — never replaces — `task.md`, which
remains the human-readable source of truth. This introduces AGENTS' **first
runtime dependency** (`@modelcontextprotocol/sdk`, `zod`) and its first
integration surface (an MCP server), reframing the framework posture from
"zero-dependency / pure-prompt" to **"pure-prompt core + optional MCP state
layer."** The layer is **optional and backward-compatible**: if `state.json`
is absent (or the server is not registered), agents fall back to parsing
`task.md` exactly as before.

## Why

- External orchestrators (the user's PAV app, or any tool) need to know the
  active phase, what's blocked, who owns what, and what needs human attention
  **without parsing markdown**.
- `task.md` is optimized for humans; a machine-readable shadow is optimized
  for tools. Both are written by the same agents at the same transition
  points.
- Prompt-based JSON editing (the originally-planned approach) relied on the
  LLM to emit valid JSON — a known error source (trailing commas, missing
  quotes, wrong field names). A tool-mediated server produces well-formed,
  schema-validated, atomically-written JSON every time.
- A tool call shrinks template prose from multi-paragraph JSON blocks to
  single-line instructions and centralizes schema validation in one place
  instead of replicating it across four agent templates.
- Making state externally queryable is the enabling step for orchestrated
  multi-agent execution (Yegge maturity stage 8) — parallel fan-out,
  right-sized model routing, and flag-based escalation all read from
  `state.json`.

## Problem Statement

AGENTS' internal phase state lived **only** in `task.md` markdown. Any
external orchestrator had to parse prose tables to answer "what phase is
active / blocked / owned / flagged" — brittle and version-fragile. There was
no separation between **session behavior** (how an agent acts inside a
session) and **session lifecycle** (how sessions are spawned, routed,
monitored outside a session). An orchestrator had no stable, structured
contract to read. Task 089 set out to add this bridge **without** breaking
the "works immediately in any session" promise for users who don't run an
orchestrator.

## Solution

### Layered Architecture

```
Orchestrator (PAV) — reads state.json, spawns sessions, sends notifications
     │
state.json (bridge) — machine-readable, written by agents, read by orchestrator
     │
AGENTS (session behavior) — prompts, roles, skills, quality gates
```

### The `state.json` Schema

Location: `.tasks/[NNN-slug]/state.json` (same directory as `task.md`).

```json
{
  "task": "slug-name",
  "status": "planning",
  "updated": "2026-07-02",
  "phases": [
    {
      "id": 1,
      "name": "phase-name",
      "status": "not_started",
      "owner": null,
      "started": null,
      "completed": null,
      "blocked_by": [],
      "parallel_group": null,
      "execution": {
        "model": null,
        "effort": null,
        "agent_type": null
      }
    }
  ],
  "flags": []
}
```

### The 7 MCP Tools

| Tool               | Purpose                                          | Called By                                                                    |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `state_init`       | Create `state.json` with initial phase list      | Explorer (task creation)                                                     |
| `state_update`     | Update phase status, owner, timestamps           | Explorer (planned/reviewed), Builder (in_progress + owner), Committer (done) |
| `state_flag`       | Add a flag (auto-generates ID)                   | Any agent, when human attention is needed                                    |
| `state_clear_flag` | Remove a flag by ID                              | Any agent, once the flag is resolved                                         |
| `state_read`       | Return full `state.json` contents                | Any agent/orchestrator needing full detail                                   |
| `state_prime`      | Return a compact summary for fast session resume | Conductor / agents resuming a session                                        |
| `tasks_list`       | List tasks across the repo with status           | Orchestrator, cross-task queries                                             |

Note: the header comment in `scripts/state-server.js` says "6 tools" and
omits `tasks_list` — the header is stale; this ADR documents the shipped **7**
(the header fix is out of scope for this ADR — see task 089).

### Status Ownership

| Transition        | Agent                   | MCP Tool Call                                                      |
| ----------------- | ----------------------- | ------------------------------------------------------------------ |
| Create state.json | Explorer                | `state_init`                                                       |
| Phase planned     | Explorer                | `state_update` (phase status → `planned`)                          |
| Phase reviewed    | Explorer (phase-review) | `state_update` (phase status → `reviewed`)                         |
| Phase started     | Builder                 | `state_update` (phase status → `in_progress`, owner set)           |
| Task in progress  | Builder                 | `state_update` (task status → `in_progress`, on first phase start) |
| Phase completed   | Committer               | `state_update` (phase status → `done`, owner → null)               |
| Task complete     | Committer               | `state_update` (task status → `done`, when all phases done)        |

## Key Architectural Decisions

### MCP server over pure prompt-based JSON editing

RDR-034 and the task-089 overview originally framed this feature as a
**zero-dependency JSON convention** enforced purely by prompt templates. The
**shipped** implementation instead built an MCP server, deliberately
accepting the first runtime dependency. The design evolved for determinism
(schema-validated output), atomic writes (write-tmp + rename), centralized
validation, and much leaner template prose.

| Option                                    | Rejected because                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Prompt-based JSON editing (Write/Edit)    | LLM-emitted JSON is a known error source; validation replicated across 4 templates          |
| Embed state in `task.md` only (no shadow) | Orchestrators must parse markdown; brittle, version-fragile                                 |
| Dolt database / SQL (Beads' approach)     | ~100MB binary; conflicts with the lightweight ethos even after accepting the small MCP deps |

### `state.json` supplements, does not replace, `task.md`

Human-readable source of truth stays markdown; JSON is the machine shadow.
Both are written by agents at the same transition points.

### Optional & backward-compatible by construction

Absent `state.json` → fall back to `task.md` parsing. Absent server
registration → agents still function. This preserves the "works immediately"
promise for non-orchestrator users.

### Advisory, not enforced

`parallel_group` declares eligibility (Conductor may still run sequentially);
`execution` metadata is a hint (orchestrator may ignore it); flags are
agent-written (not orchestrator-inferred heuristics). Consistent with AGENTS'
standing "advisory, not mandatory" principle.

### User-scoped (global) MCP registration

`claude mcp add --scope user`; VS Code user-scoped `mcp.json`. Rationale:
project-scoped `.mcp.json` has a known bug (#13898) where custom subagents
can't reach the server and hallucinate results. Registration is **manual**
(the installer runs `npm install` but does not register the server).

## Consequences

- **Positive:** internal state is externally queryable; parallel fan-out,
  model right-sizing, and flag-routing become possible; template prose
  shrinks; the malformed-JSON class of errors is eliminated; fast session
  resume via `state_prime` (~100 tokens vs. full task.md + all phase plans).
- **Negative / cost:** the framework is no longer strictly zero-dependency —
  it now ships `@modelcontextprotocol/sdk` + `zod` and an `npm install` step;
  MCP registration is a manual, per-machine step (not yet automated by
  `install.sh` — tracked as a separate follow-up).
- **Neutral:** the "zero-dependency" messaging is _reframed_ ("pure-prompt
  core + optional MCP layer"), not deleted; users who don't register the
  server are unaffected. Users who adopted AGENTS as zero-dependency won't
  experience workflow breakage — the MCP layer is strictly optional, and all
  existing functionality continues to work without it.

## See Also

- [RDR-034](../research/RDR-034-multi-agent-orchestration.md) — research source
  (Status: Partially Adopted); Beads/Water-Town provenance; rejected alternatives.
- [ADR-002](ADR-002-task-centric-persistence.md) — the `.tasks/` persistence
  pattern this extends with a machine-readable shadow.
- [ADR-001](ADR-001-orchestration-and-subagents.md) — the orchestration pattern
  that now consumes `state.json` (parallel fan-out, flag-on-resume).
- [memory-and-continuity.md](../synthesis/memory-and-continuity.md) — state /
  write-only-memory narrative (updated in Phase 3 of this task).
- `.tasks/089-orchestration-extensions/` — the implementing task (all 4 phases Done).

## Updates

| Date     | Task | Summary                                                                                                                                 |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Jul 2026 | 089  | Initial record: MCP state server (7 tools), `state.json` shadow, first runtime dependency, layered orchestrator/state/AGENTS separation |
