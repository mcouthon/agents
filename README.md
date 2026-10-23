# AGENTS

> **A**I-**G**uided **E**ngineering — **N**avigate → **T**hink → **S**hip

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub Discussions](https://img.shields.io/github/discussions/mcouthon/agents)](https://github.com/mcouthon/agents/discussions)

A minimal framework for AI-assisted coding with phase-based workflows, auto-activating skills, and enforced tool safety for **Claude Code**.

---

## What You Get

| Component        | Count | What It Does                                                              |
| ---------------- | ----- | ------------------------------------------------------------------------- |
| **Agents**       | 7     | Phase-based workflow with orchestration (4 core + Conductor + Courier + 1 internal) |
| **Skills**       | 20    | Auto-activate based on your prompts (debug, mentor, testing, etc.)        |
| **Instructions** | 5     | File-type coding standards that load automatically                        |

```bash
git clone https://github.com/mcouthon/agents.git
cd agents
./install.sh    # Works out of the box — generated files are committed to git
```

> **Modifying templates?** Run `make` first to regenerate output files, then `./install.sh`.

That's it. In Claude Code, use `claude --agent AgentName` or `use AgentName`. Or just talk naturally and let skills auto-activate.

(Optional: register the State Server for orchestration features — see [State Server (MCP)](#state-server-mcp) below.)

---

## The Core Insight

> "The highest leverage point is at the end of research and the beginning of the plan. A human can skim 30 seconds and provide feedback that saves hours of incorrect implementation."

This framework is built around that insight. The **Explorer** agent is read-only—it can't accidentally edit your code. You review its research and plan, then hand off to **Builder** when you're ready.

---

## The Workflow

**Manual workflow** (use agents directly):

```
Explorer ──→ Builder ──→ Reviewer ──→ Committer
               │            │
               │            └──→ Fix Issues ──→ (back to Builder)
               │
               └──→ Committer (skip review for small changes)
```

**Orchestrated workflow** (CC: `use Conductor` or `claude --agent Conductor`):

```
┌─────────────────────────────────────────────────────────────┐
│            CONDUCTOR (conductor agent)                      │
│  Task → For each phase: Plan → Review → Build → Commit      │
└───────────┬───────────────────────────────────────────┬─────┘
            ↓                                           ↓
        Explorer ──→ Builder ──→ Reviewer ──→ Committer
```

Conductor automates multi-phase workflows with pause points for user approval.

| Agent         | Purpose                       | Tool Access       | Key Handoffs               |
| ------------- | ----------------------------- | ----------------- | -------------------------- |
| **Conductor** | Automate multi-phase workflow | Read + Agent      | (coordinates other agents) |
| **Explorer**  | Research + create plans       | Read + Task Write | Builder                    |
| **Builder**   | Execute planned changes       | Full access       | Reviewer, Committer        |
| **Reviewer**  | Verify implementation quality | Read + Test       | Commit Changes, Fix Issues |
| **Committer** | Create semantic commits       | Git + Read        | Push                       |
| **Courier**  | Small-change delivery        | Full access       | (self-contained)           |
| **Vision**   | Describe images/screenshots  | Read              | (returns text description) |
| **Oracle**  | Deep-reasoning consultant    | Read + search tools | (returns recommendation) |

**Courier workflow** (CC: `use Courier` or `claude --agent Courier`):
For small changes that need structure but not full orchestration:
research → deliberate → implement → verify → commit → PR, all in one agent.
Courier is now task-backed: on session start with no bound task, it creates a
fast one-phase task (`mode: fast`, reviews off, auto-approve, commit at end),
giving it the same resumability, lease, registry, and land/PR linkage as a
full Conductor task. Subagents: Vision (images) and Oracle (deep reasoning) only.

**Internal agent (not user-invokable):** Researcher (read + web) — used by other agents for context-isolated subtasks.

**Multi-modal subagent:** Vision (read) — describes images and screenshots for non-multi-modal parent agents. Spawned by the Conductor and Courier when they encounter an image they cannot see.

**Deep-reasoning consultant:** Oracle (read) — answers difficult questions that exceed the caller's reasoning capacity. Called by Conductor, Explorer, Builder, and Courier when they hit an intractable problem. Runs on the most expensive model; used sparingly.

**Task Write**: Explorer can only write to `.tasks/` directory—not your codebase.

**Automatic state persistence**: Explorer saves research to `.tasks/[NNN]-[task-name]/` so you can resume across sessions. Tasks are numbered sequentially (001, 002, etc.) for chronological ordering.

---

## Skills (Auto-Activate)

Skills activate automatically based on what you say:

| You Say                       | Skill Activated   |
| ----------------------------- | ----------------- |
| "This test is failing"        | `debug`           |
| "Find code smells"            | `tech-debt`       |
| "Clean up dead code"          | `tech-debt`       |
| "Document the architecture"   | `architecture`    |
| "Teach me how this works"     | `mentor`          |
| "Challenge my approach"       | `critic`          |
| "Create a Makefile"           | `makefile`        |
| "Build a dashboard UI"        | `design`          |
| "Build a power-user UI"       | `power-ui`        |
| "Deep dive research"          | `deep-research`   |
| "Security review this PR"     | `security-review` |
| "Write tests for this"        | `testing`         |
| "Write a feature file"        | `bdd`             |
| "Add docs for this API"       | `documentation`   |
| "Check documentation quality" | `documentation`   |

No manual switching required—just ask naturally.

---

## What AGENTS Is / Isn't

| AGENTS Is                       | AGENTS Isn't                     |
| ------------------------------- | -------------------------------- |
| Phase-based workflow            | Magic one-shot agent             |
| Minimal and composable          | Batteries-included framework     |
| IDE-agnostic patterns           | Cursor/Claude-specific           |
| Human-in-the-loop at key points | Fully autonomous                 |
| Hook-enforced guardrails        | Advisory-only prompts (pre-4.0)  |

---

## Installation Details

Generated files are committed to git, so `./install.sh` works immediately after clone.

**For contributors modifying templates:**

```bash
make            # Regenerate generated/ from templates/
./install.sh    # Copy generated files to home directories
```

After `./install.sh`:

| Component               | Installed To                          |
| ----------------------- | ------------------------------------- |
| Agents (Claude Code)    | `~/.claude/agents/`                   |
| Skills (Claude Code)    | `~/.claude/skills/`                   |
| Rules (Claude Code)     | `~/.claude/rules/`                    |
| Hooks (Claude Code)     | `~/.claude/hooks/`                    |
| Configuration           | `~/.agents/config.json`               |
| Engine snapshot         | `~/.agents/bin/<name>/` (`scripts/`, `hooks/`, `generated/claude/agents/`), `~/.agents/bin/current` → `<name>` |
| `a` CLI shim            | `~/.local/bin/a` (runs `~/.agents/bin/current`; the hook stubs and the backup job use it) |
| Task state gitignore    | Added to global gitignore (`.tasks/`) |
| Global session hooks    | `~/.claude/settings.json` only with `--hooks` (consent-gated; add `--force` to skip the prompt) |

**Snapshot install.** `./install.sh` copies the engine into
`~/.agents/bin/<sha12>/` (`<sha12>-dirty-<hash>` when the three trees have
uncommitted changes) and atomically repoints `~/.agents/bin/current`. The hook
stubs and `~/.local/bin/a` run `current`, so sessions never run the checkout and
edits there are not live until `./install.sh` runs again. If `current` goes
missing they fall back to `~/.agents/bin/checkout` with one warning line;
`a doctor` shows which `a` the stubs resolve to. Old snapshots are kept.

**The five hooks.** `./install.sh --hooks` backs up `~/.claude/settings.json`
(`settings.json.agents-backup-<timestamp>` beside it), registers exactly these
five and removes the AGENTS entries of the retired stubs below; foreign hooks
stay as they are. None of them ever blocks, denies or exits non-zero: each stub
checks the kill switch first, runs `a` under the node `install.sh` recorded
(`~/.agents/bin/node`) and exits 0 whatever happens.

| Hook | Event | What it does |
| ---- | ----- | ------------ |
| `session-register` | SessionStart | Registers the session and says which task is bound |
| `session-end` | SessionEnd | Marks the session ended and releases its lease |
| `prime` | UserPromptSubmit | Injects `a next` context (step, phase, plan, knobs) |
| `report-capture` | PreToolUse `SubagentHandback` | Persists the hand-back report through the same path as `a report`, under the payload's `agent_type` |
| `checkpoint-capture` | PostToolUse `AskUserQuestion` | Opens and resolves the checkpoint from the question and the answer |

Outcomes (`recorded`, `not_recorded` with a `reason=`, `error`) go to
`~/.agents/logs/hooks.log` as five tab-separated fields, one line per
`report-capture` hand-back; `a doctor` counts them. `a doctor hooks off|on`
flips the kill switch (`a doctor hooks` shows it) beside the older `a hooks`
modes.

**Global session hooks (retired stubs).** The earlier hook set is still
shipped and installed to `~/.claude/hooks/` but `--hooks` no longer registers
it; the tables below describe it. The `a session register|touch|unregister`
commands behind `session-register` and `session-end` still work. Every Claude Code session —
PAV-launched, `a cc`, or a bare `claude` — self-registers in
`~/.agents/sessions/<id>/registration.json` (session id, `$CLAUDE_PID`, cwd,
bound task), so the registry — not process polling — is the source of truth for
who is running what. Nested `claude` runs are detected by the
`AGENTS_SESSION_DIR` pointer (not by `CLAUDE_CODE_CHILD_SESSION`, which Claude
Code sets on every subprocess): a live, foreign pid at the pointer means a
nested run, which registers under its own id with `origin: "external"` and a
`parent_session_id` link, leaving the parent's registration and task lease
untouched. See [ADR-018](docs/architecture/ADR-018-session-registry.md).

**Enforcement hooks (retired stubs, shipped but not registered)** (dispatched as
`a hook <name>`; see [ADR-019](docs/architecture/ADR-019-enforcement-hooks.md)):

| Hook | Event | What it enforces |
| ---- | ----- | ---------------- |
| `spawn-guard` | PreToolUse Agent\|Task | Denies off-sequence spawns; rewrites the prompt with canonical context |
| `report-parser` | SubagentStop | Validates and persists JSON reports; exit 2 on invalid |
| `checkpoint-capture` | PostToolUse AskUserQuestion | Opens and resolves checkpoints (one of the five; never denies) |
| `git-guard` | PreToolUse Bash | Enforces git/gh policy by main root + agent type |
| `write-guard` | PreToolUse Bash | Denies shell file-write primitives for read-only agents (explorer, reviewer, committer) |
| `manifest-guard` | PreToolUse Edit\|Write | File-scope rules per the guard table |
| `quality-gate` | PostToolUse Bash + Stop | Records validation exit codes; blocks Stop on stale edits |
| `conductor-stop` | Stop | Blocks when no state advance happened this turn |
| `plan-lint` | PostToolUse Write | Lints plan files and task.md on write |
| `courier-stop` | Stop | Validates and persists Courier's top-level builder report |

One per-agent-type guard table (`scripts/lib/guards.js`) determines which
hooks are active for each agent. Guards fail closed with a reason (or warn
under the `enforcement: warn` knob); injectors fail open; unbound sessions
no-op. The old `post-edit-validate.sh`, `subagent-validate.sh`,
`model-switch-logger.sh`, and keyword-regex `quality-gate.sh` were removed;
`write-guard.sh` was ported from Python to JavaScript and rewired as a global
hook. Run `a doctor` to verify all hooks are registered and resolving.

**Hook modes** (`a hooks <mode>`):

| Mode | Command | Behaviour |
|------|---------|-----------|
| enforce | `a hooks enforce` | Denies and blocks are applied (default). |
| advise | `a hooks advise` | Denies and blocks are shown as system messages, not applied. Use during development. |
| off | `a hooks off` | Every hook exits 0; no guards active (kill switch). Use when a hook misbehaves. |

`a hooks status` shows the current mode. `a hooks on` re-enforces after `off`.

**How `a next` decides:** For every reachable cell of (phase status, knobs,
artifacts present, git facts), `a next` returns exactly one of three shapes:
an agent step naming the agent to spawn; a checkpoint whose options all resolve
to state transitions; or a `how` command that moves state. Fast-mode tasks
(`mode: fast`) skip planning and review — `a next` returns `build` directly.
`a next --explain` prints the full cell decomposition (status, knobs,
artifacts, git facts, matching rule).

### State Server (MCP)

An optional stdio MCP server (`scripts/state-server.js`) gives agents deterministic,
atomic reads/writes of `task.json` — the single source of truth for task state
(phases, owners, counters, checkpoints, lease, binding, reports, mode) — and renders
a `state.md` view alongside the human-authored `task.md`. Transitions are enforced
by a guarded table: illegal status moves are rejected with a reason. The pure-prompt
core workflow works without it — if the `state_*` tools aren't registered, agents
fall back to `task.md` prose.

`./install.sh` already runs `npm install`, pulling in AGENTS' first runtime
dependencies (`@modelcontextprotocol/sdk`, `zod`). No manual dependency step is
needed. **Registering the server with your client is manual:**

**Claude Code:**

```bash
claude mcp add --scope user state-manager node <repo>/scripts/state-server.js
claude mcp list    # verify: should list "state-manager"
```

The server exposes 17 tools:

| Tool                 | Purpose                                                      | Read-only |
| -------------------- | ------------------------------------------------------------ | --------- |
| `state_init`         | Create `state.json` with initial phase list                  | no        |
| `state_update`       | Update phase status, owner, timestamps                       | no        |
| `state_add_phases`   | Append new phases to an existing `state.json`                | no        |
| `state_flag`         | Add a flag (auto-generates ID)                               | no        |
| `state_clear_flag`   | Remove a flag by ID                                          | no        |
| `state_read`         | Return full `state.json` contents                            | yes       |
| `state_prime`        | Return compact summary for fast resume (now returns `a next` output) | yes       |
| `state_next`         | Compute the Conductor's next step from `task.json` + git facts | yes       |
| `tasks_list`         | Return aggregated `.tasks/tasks.json` index (dashboard view) | yes       |
| `task_create`        | Create a new task with atomic NNN, skeleton, and state.json | no        |
| `task_set`           | Set per-task knobs (mode, review, approve, commit, parallel, enforcement, land) | no        |
| `repo_policy`        | Resolve push/worktree/merge policy for a repository          | yes       |
| `code_index_status`  | Report code-index staleness (`missing`/`stale`/`fresh`)      | yes       |
| `code_index_build`   | Run the configured build command, guarded by staleness       | no        |
| `memory_seed`        | Seed agent memory files (create-if-not-exists)               | no        |
| `memory_status`      | Check whether agent memory is seeded                         | yes       |
| `workspace_init`     | Combined: refresh code index + seed agent memory             | no        |

The state-server is a thin wrapper over the `agents-core` library
(`scripts/lib/`), which also powers the `a` CLI (`scripts/bin/a`). The CLI
exposes the same operations for hooks, external orchestrators, and humans:
`a repo key`, `a tasks root`, `a task create|list|read|migrate`, `a state update|flag|clear-flag|add-phases|prime`,
`a next`, `a report`, `a checkpoint open|resolve`, `a plan lint`, `a policy`,
`a session register|unregister|touch|ls`, `a launch`, `a cc [ls|attach|kill]`,
`a worktree add|remove|list|clean`, `a land`, `a doctor`, `a hook <name>`.
Every `--json` output shape is pinned by explicit golden objects in
`scripts/test-cli-contract.js`. `a doctor` verifies that all enforcement
hooks are registered in `~/.claude/settings.json` and that each hook script
resolves the `a` binary (the full doctor is A10).

See [scripts/state-server.js](scripts/state-server.js) for the authoritative
install/verify commands and the project-scope caveat (user-scoped registration is
required — project-scoped servers can't be reached by custom subagents).

### Agent-managed code-index lifecycle

`code_index_status` / `code_index_build` keep a repo's code-intelligence index
(e.g. Graphify's `graphify-out/graph.json`) current automatically: Conductor
builds it at task start (and on resume), Builder refreshes it after each
phase, and Explorer flags a stale/missing index (read-only — it never
builds). The build command itself is **not** part of this repo — it lives in
your user-global `~/.agents/config.json`, keeping the framework
vendor-neutral:

```json
{
  "code_index": {
    "build": "graphify extract . --code-only",
    "graph_file": "graphify-out/graph.json",
    "code_extensions": [".py", ".ts", ".js", ".go"]
  }
}
```

Omit `--force` from the build command — it bypasses Graphify's incremental
manifest gate, forcing a full re-scan on every trigger. Without `--force`,
Graphify only re-extracts files that changed since the last build (seconds,
not minutes). Reserve `--force` for manual full rebuilds via
`code_index_build` with `force: true` or a direct `graphify extract . --code-only --force`.

Omit the `code_index` section (or the whole file) and both tools cleanly
no-op with `not_configured` — nothing breaks for repos that don't use a code
index.

### Concurrent workstreams with git worktrees

Run **one `git worktree` per workstream** — one branch, one isolated working tree,
index, and `HEAD` — so concurrent workloads never see each other's uncommitted
changes at the git layer.

- **Who decides:** where a session runs is decided by whoever launched it (PAV, a wrapper, or direct `claude --agent`). Agents do not create branches or worktrees unless the user asks. The former `worktree-heuristic.sh` SessionStart hook is deleted (it mutated checkouts and asked the LLM to judge concurrency it cannot see); see [ADR-017](docs/architecture/ADR-017-branch-aware-worktree-launch.md) (superseded).
- **Create / remove (via `a worktree`):** `a worktree add --task <dir>` creates a
  task-bound worktree at `../<repo>-wt-<NNN>-<slug>` on branch `wt/<NNN>-<slug>`.
  `a worktree add --name <name>` creates a non-task-bound worktree. `a worktree remove
  <path>` removes a worktree (refuses if dirty or unlanded unless `--force`). `a
  worktree list` and `a worktree clean [--dry-run]` sweep stale worktrees. The old
  `npm run worktree` is a deprecation stub pointing to `a worktree`.
- **Hook-controlled creation:** `WorktreeCreate`/`WorktreeRemove` hooks (installed by
  `install.sh`) route every Claude Code worktree creation through `a worktree`, so
  `claude --worktree`, `EnterWorktree`, and `isolation: worktree` all share one path
  with consistent naming and safety rules. The hooks read the bound task from
  `AGENTS_SESSION_DIR` when available.
- **`.tasks` link (database mode):** task state is accessed via absolute paths and
  the `agents-core` state store (`a` CLI / MCP `state-manager`), so all worktrees
  of a repo share one dashboard. In database mode `a worktree add` also symlinks
  the main checkout's `.tasks` (new tasks' Markdown, hidden through
  `info/exclude`) into the new worktree and reports `tasks_link`
  (`created`, `exists`, `skipped: ...` or `failed: ...`); removal needs no
  `--force`. Without a database no link is made.
- **Landing (`a land`):** on direct-to-main repos, a committed phase on a branch
  must be landed: `a land --task <dir>` fetches, rebases onto base, runs the
  validation set, fast-forwards base from the main checkout, pushes, records
  `landed_sha`, and transitions the phase to `landed`. On PR repos, it pushes the
  branch and creates a PR via `gh pr create` (draft when the initiator is mission or
  intake); the phase stays `committed` with `pr_open` and `a next` returns `ci_wait`.
  Conflicts are recorded as `phase.conflict` and `a next` returns `resolve_conflicts`
  for a Builder to resolve; `a land --continue` resumes after resolution. Landings are
  serialized under `~/.agents/locks/<repo-key>.land.lock`.
- **`AGENTS_LAND=1` env contract:** `a land` sets `AGENTS_LAND=1` in the environment
  of its own git calls. This signals to the git-guard hook (phase 4) that the git
  operation is authorized by the landing flow. Only `a land` sets this variable; no
  other code path does. The allow-list entry that honours it lives in the phase 4
  plan.
- **`land` knob:** `land: per_phase` (default) lands each phase individually;
  `land: at_end` accumulates commits and lands once when all phases are committed.
  Set via `a task set --knob land --value per_phase|at_end`.

See [ADR-012](docs/architecture/ADR-012-worktree-tasks-resolution.md) for the
concurrent-workloads decision (pathspec scoping + worktrees + landing).

---

## Configuration

AGENTS creates `~/.agents/config.json` on first install. Edit to customize model versions:

```json
{
  "models": {
    "opus": "4.5",
    "sonnet": "4.5"
  }
}
```

After editing, run `make install` to regenerate agents with the new models.

### Model Overrides

Override the model for a specific agent in Claude Code:

```json
{
  "agents": {
    "builder": {
      "cc": "opus"
    }
  }
}
```

Accepted values: `opus`, `sonnet`, `haiku`, `fable`, `inherit` (use the session's
model), or any custom model string. After editing, run `make install`.

### Model Aliases

Define short names for custom model strings:

```json
{
  "aliases": {
    "glm52": "ai_gateway.models.glm52[1m]"
  },
  "agents": {
    "builder": {
      "cc": "glm52"
    }
  }
}
```

The generator resolves `agents.builder.cc = "glm52"` to
`ai_gateway.models.glm52[1m]` and emits it verbatim into the agent's `model:`
frontmatter. Values that are neither tier aliases nor defined aliases pass
through as literal model strings. Tier aliases take precedence over alias
entries with the same name. Alias chains are followed recursively — a chain
like `plan → glm52 → ai_gateway.models.glm52[1m]` resolves all the way to the
final model string (or a tier alias), with a depth limit as a cycle guard:

```json
{
  "aliases": {
    "glm52": "ai_gateway.models.glm52[1m]",
    "plan": "glm52"
  },
  "agents": {
    "conductor": { "cc": "plan" }
  }
}
```

Here `conductor.cc = "plan"` resolves through `glm52` to
`ai_gateway.models.glm52[1m]`.

### Tools

Add MCP tools that get merged into agent definitions during generation:

```json
{
  "models": {
    "opus": "4.6",
    "sonnet": "4.6"
  },
  "defaultTools": {
    "cc": ["mcp__glean__search"]
  },
  "agentTools": {
    "cc": {
      "committer": ["mcp__github__get_commit"]
    }
  }
}
```

| Field                           | Type       | Description                                     |
| ------------------------------- | ---------- | ----------------------------------------------- |
| `defaultTools.<platform>`       | `string[]` | Tools added to **all** agents for that platform |
| `agentTools.<platform>.<agent>` | `string[]` | Tools added to a **specific** agent only        |

**Platform:** `cc`
**Agent names:** `builder`, `committer`, `conductor`, `explorer`, `courier`, `researcher`, `reviewer`

Both fields are optional — omit them or leave arrays empty for no extra tools.

### Per-Repo Push Policy

Control whether Courier and Conductor create PRs or push directly to main for
each repo via `~/.claude/repo-policies.json`:

```json
{
  "/Users/you/code/personal-repo": "direct",
  "/Users/you/code/dotfiles": "direct",
  "/Users/you/code/work-project": "pr"
}
```

- **Keys**: absolute paths to repo roots (matching `git rev-parse --show-toplevel`)
- **Values**: `"direct"` = push to main, no PR, no branch; `"pr"` = create a PR
- **Repo not listed (or file missing/unreadable)** → the agent asks the user whether to create a PR or push directly — never assumes either

Courier checks this at step 6 — `"direct"` repos push main and skip CI/review
steps. Conductor checks this at its PR Creation checkpoint — `"direct"` repos
auto-select [Just Push] without pausing. Unlisted repos still present the
checkpoint as before.

---

## Claude Code Usage

Agents are available as native subagents in Claude Code:

| Agent       | Purpose                 |
| ----------- | ----------------------- |
| `Explorer`  | Research and plan       |
| `Builder`   | Execute the plan        |
| `Reviewer`  | Verify changes          |
| `Committer` | Create semantic commits |
| `Courier`  | Small change → PR fast |
| `Vision`   | Describe images/screenshots |
| `Oracle`   | Deep-reasoning consultant |

**Example workflow:**

```
$ claude
> use Explorer to add user authentication

[Claude researches, produces plan]

> use Builder

[Claude implements based on conversation context]

> use Reviewer

[Claude reviews changes]

> use Committer

[Claude creates commits]
```

**Note:** Claude Code supports tool restrictions, model selection, and skills.

**Shell helpers** _(optional)_: `./install.sh` installs the `a` CLI as a shim at `~/.local/bin/a` that runs the installed snapshot (the global session hooks invoke it). Run `./install.sh helpers` to additionally add the `a-explorer`, `a-builder`, `a-reviewer`, `a-committer`, and `a-conductor` launcher commands to your PATH. The `a` CLI provides repo identity, task management, state operations, policy resolution, session registry, worktree ops, landing, enforcement hooks (`a hook <name>`), and `a doctor` for hook-wiring verification — all with `--json` output for scripting. The `a-*` helpers launch specific agents. See [cc-quickstart.md](./docs/cc-quickstart.md) for details.

### `a cc` — the launcher

`a cc` is the owner's launch path instead of running `claude` directly. It resolves the repo, checks occupancy, creates a zmx session (or tmux via `--tmux`), and attaches:

```bash
a cc                           # Conductor on the most recently active open task
a cc <slug>                    # Conductor on a specific task
a cc courier "<title>"         # Courier: creates a minor task and opens it
a cc --continue                # Pick the most recently active non-done task
a cc --task 128-slug           # Conductor on a specific task
a cc --agent Courier --title "fix typo"  # Courier with an explicit title
```

When the main checkout already has a live session, `a cc` runs the new session in a task-bound worktree automatically. `--no-worktree` refuses instead, naming the holder. Model/gateway env lives in `~/.agents/launch.env` (sourced by `a launch`, never in wrappers).

**D39 convention: launch, then paste.** The owner launches with `a cc` (no prompt argument), the session opens with the bound task injected by the `prime` hook, and the owner pastes the prompt (text, screenshots, files) as the first message. A positional prompt is accepted for one-liners only (the first line becomes the task title, max 80 chars).

**Two-line wrapper** for owner shims:

```bash
# ~/.local/bin/a-conductor
exec a cc --agent Conductor "$@"
```

---

## Customization

### Adding an Agent

Create `templates/agents/my-agent.template.md` (see [templates/README.md](templates/README.md) for format), then:

```bash
make            # Regenerate generated/ from templates/
./install.sh    # Install locally
```

### Adding a Skill

Create `templates/skills/my-skill/SKILL.template.md` (see [templates/README.md](templates/README.md) for format), then:

```bash
make && ./install.sh
```

### Validating Skills (TDD for Documentation)

1. **RED** - Run task WITHOUT the skill, note failures
2. **GREEN** - Add skill, verify improvement
3. **REFACTOR** - If agent rationalizes around it, strengthen guidance

> If you didn't see it fail without the skill, you don't know if the skill helps.

Run `make && ./install.sh` after adding agents or skills.

---

## Task Continuity

Explorer persists state to `.tasks/[NNN]-[task-name]/`:

```
.tasks/001-add-auth/
  task.md                      # Research + phases + main plan (authored prose, no status column)
  task.json                    # Machine-readable state (single source of truth for phase status)
  state.md                     # Rendered view of task.json (auto-generated, not authored)
  plan/
    phase-1-config.md          # Detailed plan for phase 1 (optional)
    phase-2-user-model.md      # Detailed plan for phase 2 (optional)
```

### Phase-Based Workflow

1. **Initial research** → `task.md` with research findings + phase table
2. **Plan Next Phase** (optional) → detailed plan for complex phases → `plan/phase-N-[name].md`
3. **Builder** → picks smallest planned unit (phase plan if exists, else task.md)
4. Mark phase ✅ Done, repeat

| Agent        | Reads                   | Updates                              |
| ------------ | ----------------------- | ------------------------------------ |
| **Explorer** | `task.md`, `plan/*.md`  | `task.md`, `plan/*.md`, `task.json` |
| **Builder**  | Phase plan or `task.md` | `task.json` (enforced transitions)  |
| **Reviewer** | All plan + implement    | `task.json` (verdict report)         |

**To continue a task**: Just say "Continue working on [task-name]"

### Database

`~/.agents/agents.db` (SQLite, WAL; needs Node 22.5+) holds every task, phase,
report, checkpoint, session and repo. DB mode is on exactly when the file exists:
with no file every `a` write behaves as before, and moving the file aside
returns `a` to file-only mode. `a task import` is a dry run that writes nothing
and reports counts, stale `state.md` files and any export that is not byte-equal;
`a task import --apply` creates the database, loads every `task.json` and
`registration.json`, moves the originals into a dated trash bundle and writes the
exports in their place (re-running it picks up anything that landed meanwhile).
Once the file exists every write goes to the database first, then to `task.json`,
`state.md` and `INDEX.md`. `a export` re-renders them from the database
(`--out <dir>` renders elsewhere; `--check` compares with the files and exits 1
on any difference). `a tasks backup` keeps a daily `agents.db.bak`, and
`a doctor` shows the database, its backup age and the node version.

In DB mode a new task keeps `task.md` and `plan/` in
`<repo>/.tasks/<NNN-slug>/` and records that absolute path as `files_dir` (in the
row and in the task's `task.json`; old tasks have none). If the repo moves,
lookups fall back to the central dir.

### Safety: trash and snapshots

Deleted tasks are never `rm`'d — they move to `~/.agents/trash/`. `a trash ls`
lists them; `a trash purge --older-than 30d` is the only deleter. The central
root is a git repo: `a tasks backup --init` sets it up with a launchd agent
that commits every 15 minutes, so every file is restorable to any point in time.

---

## Agents vs Skills

| Use Case                          | Use       |
| --------------------------------- | --------- |
| Need enforced tool restrictions   | **Agent** |
| Need handoffs between phases      | **Agent** |
| Want auto-activation from prompts | **Skill** |
| Role-based workflow phases        | **Agent** |
| Specialized methodologies         | **Skill** |

---

## File Structure

```
templates/                # SOURCE OF TRUTH — edit these
├── agents/               #   8 agent templates
├── skills/               #   20 skill templates
└── instructions/         #   5 instruction templates

generated/                # GENERATED — do not edit
└── claude/               #   Claude Code output
    ├── agents/           #     CC subagent files
    ├── skills/           #     CC skill files
    └── rules/            #     CC rule files

scripts/
├── generate.js           # Template generator
└── configure-graphify-mcp.js  # Registers Graphify in <repo>/.vscode/mcp.json (workspace scope)

Makefile                  # Build targets: make [cc|all|validate]
install.sh                # Copies generated files to ~/.claude/

docs/
├── synthesis/        # Core principles and framework analysis
└── research/         # Research Decision Records (RDRs)
```

---

## Troubleshooting

**Skills not auto-activating?**

1. Run `make && ./install.sh` to ensure generated files are installed
2. Check `~/.claude/skills/` for your skills
3. Be more explicit: "Use debug mode to investigate..."

**Generated files out of date?**

```bash
make validate   # Check if generated files match templates
make            # Regenerate if needed
```

**Need to uninstall?**

```bash
./install.sh uninstall
```

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Quick ways to contribute:**

- 🐛 [Report a bug](https://github.com/mcouthon/agents/issues/new?template=bug_report.md)
- 💡 [Request a feature](https://github.com/mcouthon/agents/issues/new?template=feature_request.md)
- 🎯 [Share your skill](https://github.com/mcouthon/agents/issues/new?template=share_skill.md)
- 🤖 [Share your agent](https://github.com/mcouthon/agents/issues/new?template=share_agent.md)

---

## Further Reading

| Topic                       | Document                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Core principles             | [prevailing-wisdom.md](./docs/synthesis/prevailing-wisdom.md)         |
| Framework analysis          | [framework-comparison.md](./docs/synthesis/framework-comparison.md)   |
| Memory & session continuity | [memory-and-continuity.md](./docs/synthesis/memory-and-continuity.md) |
| Enforcement hooks           | [ADR-019](docs/architecture/ADR-019-enforcement-hooks.md)             |
| Agent write-lockdown        | [ADR-015](docs/architecture/ADR-015-agent-write-lockdown.md)          |
| Session registry            | [ADR-018](docs/architecture/ADR-018-session-registry.md)              |
| Claude Code quickstart      | [cc-quickstart.md](./docs/cc-quickstart.md)                           |
| Research decisions          | [docs/research/](./docs/research/)                                    |
| 12-Factor Agents            | [docs/sources/12-factor-agents/](./docs/sources/12-factor-agents/)    |

---

## Why This Exists

Synthesized from multiple frameworks into something minimal and useful:

- [12 Factor Agents](./docs/sources/12-factor-agents/) — Control flow ownership
- [HumanLayer ACE](./docs/sources/humanlayer/) — Context engineering, human leverage points
- [CursorRIPER](./docs/sources/cursorriper/) — Permission boundaries
- [Superpowers](https://github.com/obra/superpowers) — Skill quality, TDD for documentation

> **Model recommendation:** Claude Opus 4.5 for heavy lifting. When Sonnet struggles, Opus delivers.
