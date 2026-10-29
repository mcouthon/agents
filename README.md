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

Conductor automates multi-phase workflows with pause points for user approval. It
dispatches each agent with the Agent tool, records the owner's answers, in their words,
with `decide`, marks each finished phase with `check_phase` and lands with `land`.

| Agent         | Purpose                       | Tool Access       | Key Handoffs               |
| ------------- | ----------------------------- | ----------------- | -------------------------- |
| **Conductor** | Automate multi-phase workflow | Read + Agent + seven engine tools | (coordinates other agents) |
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
Courier is task-backed: `a start --courier` binds a fast one-phase task. It calls
`prime` first, marks its own phase with `check_phase` after its commit and finishes
with `land`, naming the checks to run. Subagents: Vision (images) and Oracle (deep reasoning) only.

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

**The two hooks.** `./install.sh --hooks` backs up `~/.claude/settings.json`
(`settings.json.agents-backup-<timestamp>` beside it), registers exactly these
two and removes AGENTS entries of earlier hook sets; foreign hooks
stay as they are. None of them ever blocks, denies or exits non-zero: each stub
checks the kill switch first, runs `a` under the node `install.sh` recorded
(`~/.agents/bin/node`) and exits 0 whatever happens.

| Hook | Event | What it does |
| ---- | ----- | ------------ |
| `session-register` | SessionStart | Registers the session and says which task is bound |
| `session-end` | SessionEnd | Marks the session ended |

Retired: the `prime`, `report-capture` and `checkpoint-capture` hooks are gone (`prime.sh`,
`report-capture.sh`, `checkpoint-capture.sh`); `./install.sh --hooks` removes their entries.
The Conductor calls the `prime` tool instead.

`a doctor hooks off|on` flips the kill switch (`a doctor hooks` shows it).

**Session registry.** Every Claude Code session — PAV-launched, `a cc`, or a bare
`claude` — self-registers in `~/.agents/sessions/<id>/registration.json`
(session id, `$CLAUDE_PID`, cwd, bound task), so the registry — not process
polling — is the source of truth for who is running what. Nested `claude` runs
are detected by the `AGENTS_SESSION_DIR` pointer (not by
`CLAUDE_CODE_CHILD_SESSION`, which Claude Code sets on every subprocess): a
live, foreign pid at the pointer means a nested run, which registers under its
own id with `origin: "external"` and a `parent_session_id` link, leaving the
parent's registration untouched. See
[ADR-018](docs/architecture/ADR-018-session-registry.md). `./install.sh` moves
installed copies of the earlier stubs, by exact name, to
`~/.agents/trash/<date>/claude-hooks/`.

**How `a next` decides:** nothing is stored. `a next` derives one move from the task's
phases, the owner's recorded answers (`decisions`), the plan files and git: `plan`, `approve`,
`revise`, `build`, `commit`, `check`, `land`, `close` or `phases`, with a one-sentence `advice`,
any question for the owner, the task's `worktree` and warnings. `a next --json` returns
`{task_dir, title, advice, decisions, notes, worktree}` (the 20 newest decisions); text mode
prints `Phase:`, `Next:`, `Worktree:` and `Task dir:` lines. A task given as an absolute
`--task-dir` (with `a decide`, `a task note` and `a land` too) is placed from the tasks root's
index, so the caller's directory does not matter; one the index cannot place is refused
`not_indexed` (exit 2) before anything is read or written, unless `--repo` names the checkout.
`a task check` is the one writer of phase progress; every refusal prints a `Remedy:` line.

### State Server (MCP)

An optional stdio MCP server (`scripts/state-server.js`) gives agents seven tools over the
engine's `a` commands, plus two code-index tools. `task.json` plus the database hold the task's
state; the only status the engine writes is `check_phase` (and `a task close`). The pure-prompt
core workflow works without the server.

The server runs from the installed snapshot, like the engine. `./install.sh` links each
snapshot's `node_modules` to `~/.agents/bin/deps/<lockfile hash>`, a tree it builds once per
`package-lock.json` with `npm ci --omit=dev` under the recorded node
(`~/.agents/bin/node`), so a repo that pins an older Node on PATH cannot break it. A snapshot
whose tree is not built (no network the first time) is made but not made `current`, and the
summary says so; re-run `./install.sh`. A tree no snapshot links moves to the trash. Running
the tests, or the checkout's own server, needs `npm ci` in the checkout.

**Registering the server with your client:** `./install.sh --mcp` registers it at user scope
through `claude mcp` (nothing when the entry already matches; an entry that names the checkout is
replaced; a failure is reported in the summary and install still exits 0). By hand:

**Claude Code:**

```bash
claude mcp add --scope user state-manager ~/.agents/bin/node ~/.agents/bin/current/scripts/state-server.js
claude mcp list    # verify: should list "state-manager"
```

The server exposes seven state tools. Each runs one `a` command, with `--json`, from
`~/.agents/bin/current` under `~/.agents/bin/node` per call, so a call always runs the `a` that
`current` names at that moment. Every argument is required and nothing defaults from context;
`task` is the absolute task dir (the `Task dir:` line `a next` prints), and a task the tasks
root's index cannot place is refused `not_indexed`.

| Tool          | Runs                | Takes (all required)                          | Time limit |
| ------------- | ------------------- | --------------------------------------------- | ---------- |
| `prime`       | `a next`            | `task`                                        | 120 s      |
| `task_read`   | `a task read`       | `task`                                        | 60 s       |
| `add_phases`  | `a task add-phases` | `task`, `phases` (`id`, `name`, `after`)      | 60 s       |
| `check_phase` | `a task check`      | `task`, `phase`                               | 60 s       |
| `decide`      | `a decide`          | `task`, `phase`, `choice`, `quote`            | 60 s       |
| `land`        | `a land`            | `task`; optional `check` (repeatable), `policy` (`pr`\|`direct`) | 900 s |
| `note`        | `a task note`       | `task`, `phase`, `text`                       | 60 s       |

A call that exits 0 returns the engine's JSON as is; one that fails returns an error whose text
holds the exit code, the engine's refusal object and its stderr.

Two code-index tools answer in the server itself and are not state tools:

| Tool                | Purpose                                                 | Read-only |
| ------------------- | ------------------------------------------------------- | --------- |
| `code_index_status` | Report code-index staleness (`missing`/`stale`/`fresh`) | yes       |
| `code_index_build`  | Run the configured build command, guarded by staleness  | no        |

The state-server is a thin wrapper over the `agents-core` library
(`scripts/lib/`), which also powers the `a` CLI (`scripts/bin/a`). The CLI has eight verbs:
`a start` and `a doctor` for people, and the machine verbs `a ls`, `a next`, `a resume`,
`a task new|close|read|check|add-phases|set|note`, `a decide` and `a land` (`a --help --all`
lists them, then one `retiring:` line). Verbs still called by PAV or by the two remaining hook
stubs stay runnable and hidden until the phase that deletes them: `attach`, `session`, `worktree`,
`cc`, `launch`, `repo key`, `tasks`, `trash`, `plan lint`, `export`, `task import`, `task create`,
`policy` and `hook`. Every `--json` output shape is pinned by explicit golden objects in
`scripts/test-cli-contract.js`. `a doctor` verifies that the two hooks are registered in
`~/.claude/settings.json`, that their handlers load, and which `a` the stubs resolve to.

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
- **Create / remove (via `a worktree`):** `a worktree add --task <dir>` (and `a start
  --worktree`) creates a task-bound worktree at `~/.agents/worktrees/<repo>/<NNN>-<slug>`
  on branch `wt/<NNN>-<slug>`; `a worktree add --name <name>` creates a non-task-bound
  one at `~/.agents/worktrees/<repo>/<name>` on `wt/<name>`. The repo folder is made on
  demand. `worktrees_root` in `~/.agents/config.json` moves the root (a leading `~` is
  HOME, a relative path resolves against the config file's directory). Worktrees made
  before the root (`../<repo>-wt-<NNN>-<slug>`) are never moved: git tracks them by path,
  so `a start`, `a land`, `a worktree list` and `a worktree clean` find them where they are.
  `a worktree remove <path>` removes a worktree (refuses if dirty or unlanded unless
  `--force`).
- **Cleanup:** one policy keeps a worktree while its branch is not merged into the base,
  its tree has uncommitted changes, or a live session's cwd is inside it; otherwise it
  goes by `git worktree remove` then `git branch -d` — never forced, never a dirty tree.
  `a worktree clean [--dry-run]` applies it to every `wt/*` worktree of the repo. `a land`
  applies it to the landed branch's worktree right after landing, unless a phase still to
  finish runs on that branch; `a task close` applies it to the task's worktree. Both print
  one line, `worktree removed: <path>` or `worktree kept: <path> (<why>)`, and report it as
  `worktree` in the JSON. `a doctor` lists the worktrees under the root that are removable
  or belong to a closed task, each with why it stays, and the `a worktree clean --repo
  <repo>` line to run (`worktrees` in its JSON).
- **`.tasks` link (database mode):** task state is accessed via absolute paths and
  the `agents-core` state store (`a` CLI / MCP `state-manager`), so all worktrees
  of a repo share one dashboard. In database mode `a worktree add` also symlinks
  the main checkout's `.tasks` (new tasks' Markdown, hidden through
  `info/exclude`) into the new worktree and reports `tasks_link`
  (`created`, `exists`, `skipped: ...` or `failed: ...`); removal needs no
  `--force`. Without a database no link is made.
- **`.env*` links (any mode):** `a worktree add` and `a start --worktree` on a new
  branch also symlink the main checkout's untracked root-level `.env*` entries
  (`.env`, `.envrc`, …) into the new worktree and report them as `env_links`.
  Tracked names arrive with git and names already present are kept; no ignore file
  is written, so the repo's own ignore rules must cover the names.
- **Landing (`a land --task-dir <dir>`):** puts the task's branch on base. It resolves the
  repo's landing policy (`direct` pushes to base, `pr` pushes the branch and opens a PR with
  `gh pr create`; an unlisted repo is refused until `--policy pr|direct` records one),
  refuses a dirty tree, fetches and rebases onto base, refuses checked phases the owner has not
  accepted (when `approvals` is `ask`), runs each `--check <cmd>` in the task's tree (default `zsh scripts/check.sh`, repeatable),
  then pushes. It writes no status and no SHA. Every refusal prints what is wrong and a `Remedy:`
  line: `no_task`, `policy_unlisted`, `no_branch`, `dirty_tree`, `fetch_failed`, `rebase_conflict`,
  `not_accepted`, `check_failed`, `non_fast_forward`, `pr_failed`. The owner's way past a missing
  acceptance is `a decide … --choice land_anyway --quote "<why>"`. A land takes as long as its
  checks (each up to 850 s), so a caller with a shorter timeout must raise it; the MCP `land` tool
  allows 900 s.
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
steps. `a land` reads the same file: `"direct"` repos push to base, `"pr"` repos push the
branch and open a PR, and an unlisted repo is refused with a `Remedy:` naming `--policy`.

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

**Shell helpers** _(optional)_: `./install.sh` installs the `a` CLI as a shim at `~/.local/bin/a` that runs the installed snapshot (the global session hooks invoke it). Run `./install.sh helpers` to additionally add the `a-explorer`, `a-builder`, `a-reviewer`, `a-committer`, `a-conductor`, and `a-courier` launcher commands to your PATH (`a-conductor` and `a-courier` are one-line wrappers over `a start`). The `a` CLI provides repo identity, task management, state operations, policy resolution, session registry, worktree ops, landing, enforcement hooks (`a hook <name>`), and `a doctor` for hook-wiring verification — all with `--json` output for scripting. The `a-*` helpers launch specific agents. See [cc-quickstart.md](./docs/cc-quickstart.md) for details.

### `a start`, `a ls`, `a attach`, `a resume` — the session verbs

`a start` is the launch path instead of running `claude` directly. It fetches the base branch, binds a task, registers a session and runs `claude` in a detached zmx session, then attaches:

```bash
a start 002                    # Conductor on task 002 (number, NNN-slug or slug)
a start --title "fix typo"     # new task with this title
a start --courier --title "fix typo"   # Courier: a fast, minor task
a start 002 --worktree         # in the task's own worktree (~/.agents/worktrees/<repo>/002-<slug>)
a start 002 --here             # in the main checkout even when a session runs there
a start 002 -- --model opus    # everything after -- goes to claude
a s 002 -w -n                  # the same as a start 002 --worktree --no-attach
```

Every verb has a one-letter alias (`s l a r n t d`; `decide` and `land` stay long) and every flag a one-letter form (`-w -e -n -j -r -t …`, shown in `a <verb> --help` as `-t, --title`). `-t x` and `-t=x` both work; short flags do not combine, so `-wn` is refused.

When the main checkout already has a live session, `a start` asks `[w]orktree / [h]ere / [c]ancel`; without a terminal it refuses naming `--worktree` and `--here`. When the task already has a live session, a terminal is asked `[a]ttach / [c]ancel`; without one `a start` refuses with exit 2 naming `a attach <task>`. Add `--no-attach` to start detached, or `--json` to print the session. Model/gateway env lives in `~/.agents/launch.env`, named by `launch.env_file` in the config (a relative path resolves against the config file's directory); `launch.command` replaces `claude`. The launch line unsets `VIRTUAL_ENV` and `POETRY_ACTIVE`, so no session runs inside the launching shell's virtualenv (use `poetry run` or `uv run`, which pick the project's own); `PATH` is left as it was. `a land`'s checks get the same env.

`a ls` lists the tasks that have a live session, or are not done, were written in the last 7 days and whose checkout exists, with their next step. `--all` lists every active task. `a attach <task|session>` attaches to a live zmx session; `a resume <task|session>` reopens an ended one with `claude --resume` in a new zmx session (`-r1`, `-r2`, …), or attaches when it is live.

**Launch, then paste.** Start with `a start` and no prompt; the session opens with the bound task injected by the `prime` hook, and you paste the prompt (text, screenshots, files) as the first message.

`a-conductor` and `a-courier` are one-line wrappers over `a start --conductor` and `a start --courier`: `a-courier "fix typo"` asks to create that task and opens it (`a-courier --title "fix typo"` does not ask). Quote a multi-word title.

`a cc` and `a launch` still work and are unchanged.

### `a decide` — the owner's answers

The owner's words are the input, and they are kept as spoken: every accepted answer is a `decisions` row with the quote byte for byte, and one move of the task.

```bash
a decide --task-dir 001 --phase-id 1 --choice approve --quote "Go, but keep the old API"
a task note --task-dir 001 --phase-id 1 --text "waiting on the staging key"   # sets the phase's note
a task check --task-dir 001 --phase-id 1                                        # marks the phase done
```

| Choice | What it records |
| --- | --- |
| `approve` | the owner approves the phase's plan |
| `reject` | the owner rejects the plan; the quote goes back to the Explorer |
| `answer` | the owner answers the questions the plan or the advice raised |
| `accept` | the owner accepts the built and reviewed phase, so it can be committed and landed |
| `skip` | the phase counts as checked without work |
| `land_anyway` | lets a land past a missing acceptance |

`a decide` writes one `decisions` row per answer and changes no phase status; `a next` derives the move from those rows, the plan files and git. A choice outside the six is refused with a `Remedy:` line. `check_phase` (`a task check`) is the one writer of phase progress.

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

The table between the `<!-- phases:start -->` and `<!-- phases:end -->` markers
under `## Phases` in `task.md` is the engine's: it is rendered from the database
on every write, so write outside it (a hand-written table under the heading
stays, below the block).

**To continue a task**: Just say "Continue working on [task-name]"

### Database

`~/.agents/agents.db` (SQLite, WAL; needs Node 22.5+) holds every task, phase,
decision, event, session and repo. DB mode is on exactly when the file exists:
with no file every `a` write behaves as before, and moving the file aside
returns `a` to file-only mode. `a task import` is a dry run that writes nothing
and reports counts and any export that is not byte-equal;
`a task import --apply` creates the database, loads every `task.json` and
`registration.json`, moves the originals into a dated trash bundle and writes the
exports in their place (re-running it picks up anything that landed meanwhile).
Once the file exists every write goes to the database first, then to `task.json`.
`a export` re-renders it from the database
(`--out <dir>` renders elsewhere; `--check` compares with the files and exits 1
on any difference). `a tasks backup` keeps a daily `agents.db.bak`, and
`a doctor` shows the database, its backup age and the node version.

The `tasks` row also holds the task's stored next step (`next_json`) and who it
awaits (`awaiting`); both are added to an older database when it is opened. The
`decisions` table holds the owner's answers (`a decide`): the quote verbatim, the
transition it caused, and, for `override` and `land_anyway`, who consumed it.

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

Run `zsh scripts/check.sh full` before a change lands; it runs every suite under a
throwaway HOME (`lib` and `rest` are its two halves, `check.sh db run` names suites) and is
the verification command to record.

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
