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
| `code_index_build`   | Build/refresh the code-intelligence index if stale, sync    | Conductor (task start), Builder (post-phase refresh), Explorer (pre-query refresh) |
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

## Amendment: Guidance Must State Tool-Output Shape; Caller-Supplied `project_dir` Must Be Validated (Aug 2026)

**Source:** Task 108 (`graphify-usage-telemetry`), Phases 11–12.

### Problem

Task 108 set out to measure Graphify utilization and instead found it near zero on Claude
Code after both the grant cutover (2026-07-26) and the prose-nudge cutover (2026-08-07),
despite the config wiring this ADR describes being fully intact on both surfaces (Finding
R1). Two distinct gaps explain it, both surfaced from real transcripts rather than a design
review:

1. **The guidance told agents to prefer the tool, never what its answers contain.**
   `~/.claude/CLAUDE.md`'s Graphify section said "prefer `mcp__graphifyy__*`… reach for it
   before grep/glob," but never that the tool's own output already satisfies the
   framework's standing file:line citation mandate (`get_node` → `Source: <path> L<n>`,
   `get_neighbors` → `at=<path>:L<n>`, `query_graph` → `loc=L<n>` per node). Live transcript
   reads (Finding R6) showed agents calling the tool once for orientation, then falling
   through to `Grep`/`Read` **for the citation** — not defying the citation mandate, but
   never told the first call had already supplied it (Finding R7). A bare preference,
   unbacked by what the tool's output actually contains, loses to a mandate the agent
   already trusts.
2. **A caller-supplied path argument selecting a command's working directory was trusted,
   not validated.** Finding R12: a fresh Explorer session called `code_index_status` with a
   hallucinated `project_dir: "/Users/pavelbrodsky"` (the user's home directory) while its
   actual `cwd` was a different repo; `resolveProjectDir`'s silent non-git fallback (this
   ADR's own resolver, documented above) returned a confident but wrong `missing` for the
   wrong directory. Because this same task's Phase 11 had just granted the more
   consequential `code_index_build` to Explorer, the identical hallucinated argument passed
   to `code_index_build` would have run `graphify extract . --code-only --force` with `cwd:
   $HOME` — an uncontrolled, repo-crawling extraction rooted at the user's home directory.
   The most likely teacher of the hallucination was the tool schema itself: all ten
   `project_dir` parameters across `state-server.js` carried the identical description
   "Required when `CLAUDE_PROJECT_DIR` env var is not set" — an agent cannot observe
   whether that env var is set, so the wording reads as "I must supply a value."

### Decision

1. **Tool-preference guidance must state what the tool's output actually contains, not
   just a preference for it.** The `~/.claude/CLAUDE.md` Graphify section and the
   underlying `hint`/`callingConvention` strings that feed `{{MCP_GUIDANCE}}` (see Task 102
   provenance) were rewritten **imperative and code-scoped**: for any question about code
   structure, call the tool first — Grep/Read only for what it does not answer — and the
   rule states plainly that the tool's returned locations already satisfy the citation
   mandate. Evidence basis: Task 097's own probes showed imperative wording ("use those
   tools directly instead of Read/Grep/Bash") produced zero Read/Grep fallback, while
   permissive wording ("if any code-intelligence tools are available") produced a hybrid.
2. **No guidance surface — `templates/`, `defaults/config.json`, `~/.claude/CLAUDE.md`, or
   any agent body — names a tool argument.** Confirmed as the correct call by Finding R4:
   the complete schema (names, types, `required`) is already resident in the calling
   agent's context at call time, so restating it in prose is redundant; a prose enumeration
   of a third-party API demonstrably goes stale (Graphify's own bundled skill docs list 7
   of the server's 10 tools); and it structurally cannot fit an `mcpServers` profile
   bullet's 120-character cap (Test 61) or `templates/`'s vendor-neutrality constraint. The
   durable form is a behavioral rule — read the schema for required argument names before
   guessing — not an enumeration that drifts the moment a vendor adds or renames a
   parameter.
3. **A caller-supplied path argument that selects a command's working directory must be
   validated before use, never trusted.** `code_index_build` (`scripts/state-server.js`)
   now refuses to run when the resolved root is the user's home directory, a filesystem
   root, or not a git repository at all — checked by directory-identity comparison (`stat`
   device+inode, not string equality, which a case-fold or symlink difference would
   bypass). `code_index_status` and `tasks_list` gain **warn, don't redirect**: an explicit
   `project_dir` outside any git repository while `CLAUDE_PROJECT_DIR` is set gets a
   warning prepended to the tool's own **returned text** — the only channel available,
   since agents do not see stderr (the same invisibility that already made Graphify's own
   `pre-#1504` legacy-ID note unactionable, per Task 108 Finding R8). Resolution priority
   itself (`project_dir` arg > `CLAUDE_PROJECT_DIR` > cwd) is unchanged — the fix is
   refusal and disclosure, not silent redirection, preserving the "explicit arg wins"
   contract and the test suite's legitimate non-git temp-directory fixtures.
4. **A tool-schema description that reads as mandatory teaches agents to guess a value.**
   All ten `project_dir` parameter descriptions were reworded from "Required when…" to
   omit-don't-guess phrasing, hoisted to one shared constant, on the finding that the
   schema — not Conductor's prose, which a freshly-spawned Explorer subagent never reads —
   was the more likely teacher of the hallucination.

### What does NOT change

- **The file:line citation mandate itself.** The user offered to relax it and the offer
  was declined on the evidence: Finding R6 showed the requirement is the proximate driver
  of the trailing `Grep` calls, but Finding R7 showed that step was never necessary — the
  fix is to say the tool already satisfies the requirement, never to weaken the
  requirement. Binding on every future guidance edit: no citation requirement is weakened
  anywhere to accommodate a tool's limitations.
- **`resolveProjectDir`'s resolution order and its silent non-git fallback for the
  read-only state tools** (`state_read`, `tasks_list`, etc.) — those already fail loudly
  and legibly on a bogus root (`ENOENT`, "state.json not found at …"); only the
  write-triggering `code_index_build` needed a hard refusal, and only the stat-only
  `code_index_status` needed a disclosed (not corrected) warning.
- **`templates/` stays vendor-neutral.** The two `templates/` edits Phase 11 required
  (`explorer.template.md`, `reviewer.template.md`) are single lines inside existing
  `<!-- CC-ONLY -->` blocks naming only `state-manager` — this repo's own server, already
  named in three templates — never Graphify. `templates/` is now fully vendor-neutral end
  to end: `rg -ci 'graphif' templates/` returns zero matches (the one stray reference this
  task found and removed), guarded going forward by Test 64, which covers the no-MCP-server
  case the migration would otherwise have left unguarded.
- **ADR-015's absolute no-write prohibition on Reviewer.** Granting `code_index_build` to
  Reviewer (which runs immediately after Builder, when the graph is most likely stale) was
  considered and rejected for exactly that reason; Builder's existing post-phase index
  refresh already serves Reviewer's comprehension needs without a new grant.

### Consequences

- **Positive:** the guidance fix is small and falsifiable — two capped config strings plus
  two single-line template edits — rather than a heavier mechanical lever. Graphify itself
  ships an unused `hook`/`hook-guard` mechanism that would hard-block a stale `Read`
  (Finding R11); it is recorded as an escalation path, deliberately not implemented,
  reserved for if prose adoption does not move on a future `recheck.sh` run.
- **Positive:** a hallucinated or wrong `project_dir` can no longer trigger an out-of-repo
  filesystem mutation; the failure mode for the read-only status/list tools changes from
  silent-wrong-answer to disclosed-wrong-answer.
- **Negative / cost:** no measurement arm was run for the guidance rewrite itself — a
  deliberate, user-confirmed decision (the user accepted their own experience that Graphify
  is faster on these questions), not an evidence gap. `telemetry/recheck.sh` measures
  adoption (call volume, transcripts-with-calls, last-activity date) only, never a
  substitution rate or a keep/drop verdict. The one available before/after data point
  (Finding R13, `7ab405e9…`) is an N=1, hand-picked, subagent-vs-main-session comparison and
  must not be read as a rate — whether the rewrite moved organic utilization remains open.

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
- `.tasks/108-graphify-usage-telemetry/` — the implementing task for the Aug 2026
  amendment above (Phases 11–12 done; Phases 2, 5, 6 deferred, unrelated to this ADR).
- [ADR-015](ADR-015-agent-write-lockdown.md) — Reviewer's absolute no-write prohibition,
  which the Aug 2026 amendment's rejected Reviewer grant would otherwise have bordered on.

## Updates

| Date     | Task | Summary                                                                                                                                 |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Jul 2026 | 089  | Initial record: MCP state server (7 tools), `state.json` shadow, first runtime dependency, layered orchestrator/state/AGENTS separation |
| Jul 2026 | 093  | Added `state_add_phases` (8th tool) — appends phases to an existing `state.json` so state stays in sync with `task.md` when a task grows phases mid-flight; Conductor now calls it instead of task.md-only tracking |
| Jul 2026 | 099  | Added `code_index_build`/`code_index_status` (9th/10th tools) — a code-index lifecycle (e.g. Graphify's `graphify-out/graph.json`) hosted on `state-manager` rather than a new server; narrowly-scoped build tool lets Bash-free agents (Explorer/Researcher/Conductor) trigger a build without gaining mutation capability; build command sourced only from trusted user-global `~/.agents/config.json`, never the target repo; framework stays vendor-neutral (no vendor name committed) |
| Aug 2026 | 108  | Root-caused near-zero organic Graphify utilization to guidance that stated a tool preference without stating the tool's output already satisfies the citation mandate — fixed with imperative, code-scoped guidance that never names an argument; hardened `code_index_build`/`code_index_status` against a hallucinated `project_dir` (directory-identity check, refuse-to-build on `$HOME`/fs-root/non-git, warn-don't-redirect, reworded schema descriptions) after a hallucinated home-directory argument was observed live and would have escaped to a real filesystem mutation |
