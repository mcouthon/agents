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
| **Agents**       | 7     | Phase-based workflow with orchestration (4 core + Conductor + 2 internal) |
| **Skills**       | 16    | Auto-activate based on your prompts (debug, mentor, testing, etc.)        |
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

**Internal agent (not user-invokable):** Researcher (read + web) — used by other agents for context-isolated subtasks.

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

| AGENTS Is                       | AGENTS Isn't                 |
| ------------------------------- | ---------------------------- |
| Advisory guidance               | Mandatory enforcement        |
| Phase-based workflow            | Magic one-shot agent         |
| Minimal and composable          | Batteries-included framework |
| IDE-agnostic patterns           | Cursor/Claude-specific       |
| Human-in-the-loop at key points | Fully autonomous             |

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
| Task state gitignore    | Added to global gitignore (`.tasks/`) |

### Reviewer / Committer Write-Lockdown Hooks (Hard Control)

The Reviewer agent's `PreToolUse` hook (`~/.claude/hooks/write-guard.sh reviewer`)
hard-denies file-write commands run through the Reviewer's terminal/Bash tool. The
Committer agent carries the same hard hook (`~/.claude/hooks/write-guard.sh committer`)
— it denies shell write-primitives (redirection, `tee`, `sed -i`, heredocs, `touch`,
editors, etc.) while leaving `git add`/`git commit` and the `Edit` tool fully
functional, forcing the Committer onto the sanctioned `Edit`-tool path for any
file change (e.g. the `task.md` status update) instead of a shell fallback. Both
hooks work out of the box on Claude Code. The guard script is shared across
agents (a positional argv selects the coaching message; the deny/allow policy is
identical for every agent it is wired into).

**Do not** register the guard script as a global hook — it is scoped to the
Reviewer's and Committer's own agent frontmatter specifically so Builder's
legitimate shell writes are unaffected.

### State Server (MCP)

An optional stdio MCP server (`scripts/state-server.js`) gives agents deterministic,
atomic reads/writes of a machine-readable `state.json` shadow of `task.md`, plus a
tasks dashboard. The pure-prompt core workflow works without it — if the `state_*`
tools aren't registered, agents fall back to `task.md` as the sole record.

`./install.sh` already runs `npm install`, pulling in AGENTS' first runtime
dependencies (`@modelcontextprotocol/sdk`, `zod`). No manual dependency step is
needed. **Registering the server with your client is manual:**

**Claude Code:**

```bash
claude mcp add --scope user state-manager node <repo>/scripts/state-server.js
claude mcp list    # verify: should list "state-manager"
```

The server exposes 10 tools:

| Tool                 | Purpose                                                      | Read-only |
| -------------------- | ------------------------------------------------------------ | --------- |
| `state_init`         | Create `state.json` with initial phase list                  | no        |
| `state_update`       | Update phase status, owner, timestamps                       | no        |
| `state_add_phases`   | Append new phases to an existing `state.json`                | no        |
| `state_flag`         | Add a flag (auto-generates ID)                               | no        |
| `state_clear_flag`   | Remove a flag by ID                                          | no        |
| `state_read`         | Return full `state.json` contents                            | yes       |
| `state_prime`        | Return compact summary for fast resume                       | yes       |
| `tasks_list`         | Return aggregated `.tasks/tasks.json` index (dashboard view) | yes       |
| `code_index_status`  | Report code-index staleness (`missing`/`stale`/`fresh`)      | yes       |
| `code_index_build`   | Run the configured build command, guarded by staleness       | no        |

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
    "build": "graphify extract . --code-only --force",
    "graph_file": "graphify-out/graph.json",
    "code_extensions": [".py", ".ts", ".js", ".go"]
  }
}
```

Omit the `code_index` section (or the whole file) and both tools cleanly
no-op with `not_configured` — nothing breaks for repos that don't use a code
index.

### Concurrent workstreams with git worktrees

Run **one `git worktree` per workstream** — one branch, one isolated working tree,
index, and `HEAD` — so concurrent workloads never see each other's uncommitted
changes at the git layer.

- **Create / open:** `npm run worktree -- add <branch>` creates the branch + a linked
  worktree and prints launch instructions (`cd <path> && claude`, or `code <path>`).
  You can also use the VS Code Source Control **Worktrees** view (v1.103+). Other
  subcommands: `open <path>`, `merge <branch> [--into <target>]`, `remove <path>`,
  `list`.
- **Shared `.tasks/` — it Just Works:** the state server auto-resolves `.tasks/` to the
  repo's **main checkout**, so ONE `tasks.json` dashboard aggregates all tasks across
  every worktree of the repo, with **no env var or manual pinning**. Different repos
  keep their own `.tasks/` (a machine-wide pin is deliberately avoided). Requires
  git >= 2.31; on older/missing git it falls back to a per-worktree `.tasks/` and logs
  a one-time hint.
- **Foreground caveat:** multiple foreground chats in ONE window share one working tree
  — worktrees only isolate across *windows* (or via background/cloud agents). For the
  shared-foreground case, the Reviewer/Committer pathspec scoping (Phases 1-2) is the
  fallback.

See [ADR-012](docs/architecture/ADR-012-worktree-tasks-resolution.md) for the
concurrent-workloads decision (pathspec scoping + worktrees).

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
**Agent names:** `builder`, `committer`, `conductor`, `explorer`, `researcher`, `reviewer`

Both fields are optional — omit them or leave arrays empty for no extra tools.

---

## Claude Code Usage

Agents are available as native subagents in Claude Code:

| Agent       | Purpose                 |
| ----------- | ----------------------- |
| `Explorer`  | Research and plan       |
| `Builder`   | Execute the plan        |
| `Reviewer`  | Verify changes          |
| `Committer` | Create semantic commits |

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

**Shell helpers** _(optional)_: Run `./install.sh helpers` to add `a-explorer`, `a-builder`, `a-reviewer`, `a-committer`, and `a-conductor` commands to your PATH. Each supports `a-explorer`, `a-explorer continue` (auto-detect task), and `a-explorer "prompt"` modes. See [cc-quickstart.md](./docs/cc-quickstart.md) for details.

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
  task.md                      # Research + phases + main plan
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
| **Explorer** | `task.md`, `plan/*.md`  | `task.md`, `plan/*.md`, phase status |
| **Builder**  | Phase plan or `task.md` | Phase status (⬜→📋→🔄→✅)           |
| **Reviewer** | All plan + implement    | —                                    |

**To continue a task**: Just say "Continue working on [task-name]"

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
├── agents/               #   6 agent templates
├── skills/               #   16 skill templates
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
