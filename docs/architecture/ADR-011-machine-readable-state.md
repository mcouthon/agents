# Machine-Readable State (MCP State Server & state.json)

**Source:** Task 089 (July 2026)

## Decision

Add a machine-readable `state.json` shadow of `task.md` at
`.tasks/[NNN-slug]/state.json`, written and read via a dedicated **MCP (stdio)
server** (`scripts/state-server.js`) that exposes **10 deterministic tools**:
`state_init`, `state_update`, `state_add_phases`, `state_flag`,
`state_clear_flag`, `state_read`, `state_prime`, `tasks_list`,
`code_index_build`, and `code_index_status` (the latter two, added in Task
099, are a self-contained code-index lifecycle rather than task-state
tools — see "Code-index lifecycle tools" below). The implementation evolved from the
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

### The MCP Tools

| Tool                 | Purpose                                                    | Called By                                                                    |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `state_init`         | Create `state.json` with initial phase list                | Explorer (task creation)                                                     |
| `state_update`       | Update phase status, owner, timestamps                     | Explorer (planned/reviewed), Builder (in_progress + owner), Committer (done) |
| `state_add_phases`   | Append new phases to an existing `state.json`               | Conductor (task grows phases mid-flight)                                     |
| `state_flag`         | Add a flag (auto-generates ID)                              | Any agent, when human attention is needed                                    |
| `state_clear_flag`   | Remove a flag by ID                                         | Any agent, once the flag is resolved                                         |
| `state_read`         | Return full `state.json` contents                           | Any agent/orchestrator needing full detail                                   |
| `state_prime`        | Return a compact summary for fast session resume            | Conductor / agents resuming a session                                        |
| `tasks_list`         | List tasks across the repo with status                      | Orchestrator, cross-task queries                                             |
| `code_index_build`   | Build/refresh the code-intelligence index if stale, sync    | Conductor (task start), Builder (post-phase refresh)                        |
| `code_index_status`  | Read-only missing/stale/fresh check, no mutation             | Explorer (flag a missing/stale index on a direct, non-Conductor start)      |

Note: `state_add_phases` was added after the initial 7-tool release (task 093);
`code_index_build`/`code_index_status` were added in task 099. The
`scripts/state-server.js` header comment lists the current shipped tool set.

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

### Code-index lifecycle tools hosted on `state-manager` (Task 099)

Graphify's code graph (`graphify-out/graph.json`, adopted per Task 098) is a static,
per-commit snapshot that drifts as code changes, and nothing auto-refreshes it. Task 099
added `code_index_build`/`code_index_status` to `state-manager` — rather than a new
server — so a code-index lifecycle piggybacks on infrastructure this ADR already
established:

- **Host on the existing `state-manager`, not a new server.** It already exposes a real
  `McpServer` with a working `resolveProjectDir` (project_dir arg → `CLAUDE_PROJECT_DIR`
  → cwd, with the worktree-root derivation from ADR-012) that solves exactly the
  per-repo path-resolution problem a build tool needs. A second server would duplicate
  that resolver and add a second registration step for every consuming agent.
- **Narrowly-scoped build tool over a Bash grant.** Explorer, Researcher, and Conductor
  are Bash-free by design (`disallowedTools` in their templates) so they cannot mutate
  source. The agents that most benefit from a fresh index for comprehension work are
  exactly these Bash-free ones. Granting Bash to unlock `graphify extract` would hand
  them a general mutation capability to solve a narrow problem. An MCP tool that does
  only "check staleness, run the configured build command, return status" gives them
  build capability with no broader capability increase — `code_index_build` goes to
  Conductor (already holds `mcp__state-manager__*`) and Builder (already Bash-capable,
  granted for convenience/uniformity); Explorer gets only the read-only
  `code_index_status` companion, preserving its read-only guarantee.
- **Build command sourced only from trusted user-global config, never the repo.** The
  shell string executed by `code_index_build` is read exclusively from
  `~/.agents/config.json` (or `$AGENTS_CONFIG_PATH`) — a file the framework's own
  installer manages, never from anything committed to or found within the target repo.
  An untrusted or freshly cloned repo therefore has no path to inject an arbitrary
  command into a tool call an orchestration agent makes automatically. A repo opts in to
  the lifecycle simply by having a `graph_file` configured; it can never supply the
  command itself.
- **Vendor-neutral tool surface.** `code_index_build`/`code_index_status` and their
  config schema (`graph_file`, `build`) name no code-intelligence vendor; `graphify`
  appears nowhere in this framework's committed source. Graphify is one config value a
  user supplies in their own `~/.agents/config.json`, not a framework dependency —
  consistent with `mcp__graphifyy__*` being an optional, user-granted tool namespace
  rather than a built-in integration.

| Option                                          | Rejected because                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| New dedicated MCP server for index lifecycle     | Duplicates `resolveProjectDir`/worktree-root derivation already solved on `state-manager`; extra registration burden per agent |
| Grant Bash to Explorer/Researcher/Conductor      | Blunt capability increase (full shell) to solve a narrow "run one build command" need                  |
| Read build command from a repo-local file/`AGENTS.md` | An untrusted repo could inject an arbitrary command into an agent-triggered tool call                |
| Hardcode `graphify extract` in the framework     | Couples the framework to one vendor; breaks the "vendor-neutral tools, user-supplied config" pattern    |

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
- **Positive (Task 099):** a code-intelligence index (e.g. Graphify's
  `graphify-out/graph.json`) stays current automatically at task start and
  after each phase, including for Bash-free agents, without granting them
  Bash; the build command can never be injected by an untrusted repo; the
  framework stays vendor-neutral.
- **Negative / cost (Task 099):** direct-Explorer starts (bypassing
  Conductor) don't auto-build — Explorer can only flag a missing/stale index
  via the read-only `code_index_status`, not build it; the Copilot tool-name
  form for `state-manager` tools is not yet confirmed, so the index-lifecycle
  tools are currently CC-only (Copilot templates omit them, see Task 099
  Phase 1 review fixes).

## See Also

- [RDR-034](../research/RDR-034-multi-agent-orchestration.md) — research source
  (Status: Partially Adopted); Beads/Water-Town provenance; rejected alternatives.
- [ADR-002](ADR-002-task-centric-persistence.md) — the `.tasks/` persistence
  pattern this extends with a machine-readable shadow.
- [ADR-001](ADR-001-orchestration-and-subagents.md) — the orchestration pattern
  that now consumes `state.json` (parallel fan-out, flag-on-resume).
- [memory-and-continuity.md](../synthesis/memory-and-continuity.md) — state /
  write-only-memory narrative (updated in Phase 3 of this task).
- [ADR-012](ADR-012-worktree-tasks-resolution.md) — the worktree-root
  derivation inside `resolveProjectDir` that `code_index_build`/
  `code_index_status` reuse unchanged.
- `.tasks/089-orchestration-extensions/` — the implementing task (all 4 phases Done).
- `.tasks/098-graphify-adoption-guide/` — adopted the Graphify code-intelligence MCP
  server this index lifecycle keeps current; not itself an architecture change (a guide),
  so it has no ADR of its own.
- `.tasks/099-graphify-index-lifecycle/` — the implementing task for the code-index
  lifecycle tools (all Done).

## Updates

| Date     | Task | Summary                                                                                                                                 |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Jul 2026 | 089  | Initial record: MCP state server (7 tools), `state.json` shadow, first runtime dependency, layered orchestrator/state/AGENTS separation |
| Jul 2026 | 093  | Added `state_add_phases` (8th tool) — appends phases to an existing `state.json` so state stays in sync with `task.md` when a task grows phases mid-flight; Conductor now calls it instead of task.md-only tracking |
| Jul 2026 | 099  | Added `code_index_build`/`code_index_status` (9th/10th tools) — a code-index lifecycle (e.g. Graphify's `graphify-out/graph.json`) hosted on `state-manager` rather than a new server; narrowly-scoped build tool lets Bash-free agents (Explorer/Researcher/Conductor) trigger a build without gaining mutation capability; build command sourced only from trusted user-global `~/.agents/config.json`, never the target repo; framework stays vendor-neutral (no vendor name committed) |
