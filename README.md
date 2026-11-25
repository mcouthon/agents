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
| **Agents**       | 8     | Phase-based workflow with orchestration (4 core + Conductor + Courier + Coordinator + 1 internal) |
| **Skills**       | 23    | Auto-activate based on your prompts (debug, mentor, testing, etc.)        |
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
Conductor, Coordinator and Courier follow one output contract: decisions, blockers and
answers only — verdicts and actionable findings, evidence as a path or one line, every
turn ending with the one thing waiting on the owner. The contract speaks in plain words —
things named by what they do, not internal vocabulary — and every phase close and PR
summary carries one line on what changed for the end user, or plainly that nothing they
will notice changed and why it was worth doing anyway. It never explains how the work was
built or which checks ran: the owner reads for seconds, so a report says only what they
will notice, an ask states its options as effects — A does this, B does that, no history
or internals — and no agent hands the owner a list of steps to run (the walkthrough skill
is the path). Small review findings never reach the owner: agents fix them and re-review
until clean, and only a finding that changes what users see, adds risk, or rewrites the
plan is asked about.

Before `land` on a `pr`-policy repo, Conductor and Courier dispatch one cold Reviewer pass
over the whole task diff — no plan, no task context, judged as a stranger's PR against the
severity rubric; a fail verdict is the owner's fix-or-`land_anyway` call, and `direct`-policy
repos skip it. On a `pr` policy the landing agent passes the PR description — the same
contract — as `body` and the PR opens with it, titled from the branch's first commit
subject (gh's --fill only when no body came). After `land` opens a PR, the pr-ready skill
drives it to ready — description kept current per the skill's contract (an environment
PR-description skill's conventions come first), failing checks fixed, every review comment
answered and its thread resolved; done means green checks and no unresolved threads. The
Coordinator drives watched tasks' PRs there with same-day Couriers. Test volume follows
one doctrine everywhere: the regression test for what execution or a finding exposed,
forward tests only for behaviors the plan or request names — the testing skill's How Many
Tests section.

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
with `land`, naming the checks to run; on `pr`-policy repos it then runs the pr-ready
skill before reporting done. Subagents: Vision (images), Oracle (deep reasoning) and, on `pr`-policy repos before `land`, one cold Reviewer pass over the whole task diff.

**Internal agent (not user-invokable):** Researcher (read + web) — used by other agents for context-isolated subtasks.

**Multi-modal subagent:** Vision (read) — describes images and screenshots for non-multi-modal parent agents. Spawned by the Conductor and Courier when they encounter an image they cannot see.

**Deep-reasoning consultant:** Oracle (read) — takes the questions that deserve a harder pass: architecture forks with heavy tradeoffs, gnarly cross-cutting debugging, design choices where being wrong is expensive, plan-risk stress tests. Called by Conductor, Explorer, Builder, Courier, and Coordinator. Runs the fleet's most expensive model — make the question count. A `use big-think mode` dispatch turns the consult divergent — options at three altitudes with kill reasons, per the big-think skill.

**Task Write**: Explorer can only write to the task's folder under `~/.agents/tasks/`—not your codebase.

**Automatic state persistence**: Explorer saves research to the task's folder under `~/.agents/tasks/` (the brief's task dir), so you can resume across sessions. Tasks are numbered sequentially (001, 002, etc.) for chronological ordering.

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
| "10x this" or "Think bigger"  | `big-think`       |
| "Security review this PR"     | `security-review` |
| "Write tests for this"        | `testing`         |
| "Write a feature file"        | `bdd`             |
| "Add docs for this API"       | `documentation`   |
| "Check documentation quality" | `documentation`   |
| "/walkthrough" or "Walk me through testing this" | `walkthrough` |
| "/pr-ready" or "Make the PR ready"   | `pr-ready`       |

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
| Engine snapshot         | `~/.agents/bin/<name>/` (`scripts/`, `hooks/`, `generated/claude/agents/`, `templates/`, `defaults/`), `~/.agents/bin/current` → `<name>` |
| `a` CLI shim            | `~/.local/bin/a` (runs `~/.agents/bin/current`; the hook stubs and the backup job use it) |
| Task state gitignore    | Added to global gitignore (`.tasks/`) |
| Global session hooks    | `~/.claude/settings.json` only with `--hooks` (consent-gated; add `--force` to skip the prompt) |

**Snapshot install.** `./install.sh` copies the engine into
`~/.agents/bin/<sha12>/` (`<sha12>-dirty-<hash>` when the frozen trees have
uncommitted changes) and atomically repoints `~/.agents/bin/current`. The frozen
trees are `scripts/`, `hooks/`, `generated/claude/agents/`, the whole
`templates/` tree and `defaults/` — the generator's inputs, so `a doctor`'s
drift check can regenerate what a fresh install would write. The hook stubs and
`~/.local/bin/a` run `current`, so sessions never run the checkout and edits
there are not live until `./install.sh` runs again. If `current` goes missing
they fall back to `~/.agents/bin/checkout` with one warning line;
`a doctor --verbose` shows which `a` the stubs resolve to. Old snapshots are
kept.

**The four hooks.** `./install.sh --hooks` backs up `~/.claude/settings.json`
(`settings.json.agents-backup-<timestamp>` beside it), registers exactly these
four and removes AGENTS entries of earlier hook sets; foreign hooks
stay as they are. None of them ever blocks, denies or exits non-zero: each stub
checks the kill switch first, runs `a` under the node `install.sh` recorded
(`~/.agents/bin/node`) and exits 0 whatever happens.

| Hook | Event | What it does |
| ---- | ----- | ------------ |
| `session-register` | SessionStart | Registers the session, says which task is bound, and carries the worktree's setup state while its bootstrap is pending or dead |
| `session-end` | SessionEnd | Marks the session ended |
| `notification` | Notification | Writes a `needs_input` signal into the registration |
| `prompt-submit` | UserPromptSubmit | Clears the `needs_input` signal when the session's user speaks (a verified `pane-send answer` clears it the same way); while a bootstrap is pending or dead, every prompt carries the setup state too |

Retired: the `prime`, `report-capture` and `checkpoint-capture` hooks are gone (`prime.sh`,
`report-capture.sh`, `checkpoint-capture.sh`); `./install.sh --hooks` removes their entries.
The Conductor calls the `prime` tool instead.

`a doctor hooks off|on` flips the kill switch (`a doctor hooks` shows it).

**Session registry.** Every Claude Code session — PAV-launched (PAV: a consumer
UI that drives this framework; everything here works without it) or a bare
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
engine's `a` commands, plus two code-index tools. The database holds the task's declared intent;
`task.md`'s three blocks render from it. The pure-prompt
core workflow works without the server.

The server runs from the installed snapshot, like the engine. `./install.sh` links each
snapshot's `node_modules` to `~/.agents/bin/deps/<lockfile hash>`, a tree it builds once per
`package-lock.json` with `npm ci --omit=dev` under the recorded node
(`~/.agents/bin/node`), so a repo that pins an older Node on PATH cannot break it. A snapshot
whose tree is not built (no network the first time) is made but not made `current`, and the
summary says so; re-run `./install.sh`. A tree no snapshot links moves to the trash. Running
the tests, or the checkout's own server, needs `npm ci` in the checkout. The recorded node is
itself pinned: `mise.toml` at the checkout root pins the engine's node and `./install.sh`
resolves the snapshot step through it (`mise x -C <checkout>`), so the shell that runs the
install cannot re-bind the engine to its own node. Without mise the install silently records
the ambient node and the summary's `node` line keeps the fallback visible; with mise present
but unable to honor the pin — a fresh clone until `mise trust` — it also warns.

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

| Tool          | Runs                | Takes (all required)                                             | Time limit |
| ------------- | ------------------- | ---------------------------------------------------------------- | ---------- |
| `prime`       | `a next`            | `task`                                                           | 120 s      |
| `task_read`   | `a task read`       | `task`                                                           | 60 s       |
| `add_phases`  | `a task add-phases` | `task`, `phases` (`id`, `name`, `after`, `pr`)                   | 60 s       |
| `check_phase` | `a task check`      | `task`, `phase`                                                  | 60 s       |
| `decide`      | `a decide`          | `task`, `phase`, `choice`, `gate`, `quote`                       | 60 s       |
| `land`        | `a land`            | `task`; optional `check` (repeatable), `policy` (`pr`\|`direct`) | 900 s      |
| `note`        | `a task note`       | `task`, `phase`, `text`                                          | 60 s       |

A call that exits 0 returns the engine's JSON as is; one that fails returns an error whose text
holds the exit code, the engine's refusal object and its stderr.

Two code-index tools answer in the server itself and are not state tools:

| Tool                | Purpose                                                 | Read-only |
| ------------------- | ------------------------------------------------------- | --------- |
| `code_index_status` | Report code-index staleness (`missing`/`stale`/`fresh`) | yes       |
| `code_index_build`  | Run the configured build command, guarded by staleness  | no        |

The state-server is a thin wrapper over the `agents-core` library
(`scripts/lib/`), which also powers the `a` CLI (`scripts/bin/a`). The CLI has ten verbs:
`a start` and `a doctor` for people, and the machine verbs `a ls`, `a next`, `a resume`,
`a restart`, `a task new|close|read|check|add-phases|set|note|worktree`, `a decide`, `a land`, and `a check` (`a --help --all`
lists them, then one `retiring:` line). Verbs still called by PAV stay runnable and hidden
until the phase that deletes them: `session`, `worktree`, `launch`, `tasks`, and `task create`.
Every `--json` output shape is pinned by explicit golden objects in
`scripts/test-cli-contract.js`. `a doctor` checks the whole install and prints
`ok` when nothing needs action — every remaining row is an action row carrying
its remedy, plus one state line of counts (which also carries the month's
spend against a configured cap, with one action row when the cap is coming —
the watcher's ledger priced by the config's own rates; nothing enforces
anything); `a doctor --verbose` adds the
standing facts once (the db describe, the worktree rows, the stray paths, the
hook log), and `a doctor --json` serves the machine shape (`{ok, actions, info}`).
The agent drift check expects what a fresh install would write — the engine's
templates regenerated under the install's own config resolution
(`~/.agents/config.json`, else the engine's `defaults/`) — so a config-tuned
install does not flag while a hand-edit or a stale install does.

See [scripts/state-server.js](scripts/state-server.js) for the authoritative
install/verify commands and the project-scope caveat (user-scoped registration is
required — project-scoped servers can't be reached by custom subagents).

### The harness adapter

The harness boundary lives in `scripts/lib/adapter/`. `forHarness(name?)` reads
the config's `harness` key (default `"claude-code"`) and returns the adapter
module; an unknown name refuses with its remedy. The `surface-guard` phrase
ban (`HARNESS_BANNED = ["claude", "CLAUDE_", ".claude"]`) keeps every harness
name out of `scripts/lib/` and `scripts/bin/a` except inside `adapter/`, so a
second harness is a new adapter directory, not a core change.

The claude-code adapter provides five functions — `launch`, `resume`,
`register`, `end`, and `transcript` — and the boundary exports the core reads
instead of naming the harness: `ownSessionId()`, `parentPid()`,
`droppedEnvNames()`, `agentProcessLooksLive()`, `projectDirEnv()`,
`harnessWorktrees()`, `transcriptsRoot()`, `installIssues()`, and `hookHandlers`.

Four hooks are registered in `~/.claude/settings.json`: SessionStart
(`session-register`), SessionEnd (`session-end`), Notification
(`notification`, which writes a `needs_input` signal into the registration
so `a ls --json` serves `session_state: "needs_input"`), and UserPromptSubmit
(`prompt-submit`, which clears the `needs_input` signal when the session's user
speaks). The two context hooks also carry a linked session's worktree setup
state: while its bootstrap is pending, the pane and the instruction to wait;
when it died, the exit and tail; nothing once complete. The state these derive
is the turn model — `live` means a turn is
running: the signal is one input, and the transcript's completed-turn tail
(turn-end markers, no newer turn evidence) the other, so a seat the idle
notification never fired on still reads waiting. The shell stubs in
`hooks/` exec the adapter's harness-neutral `hook.js` entry directly. `a doctor`
verifies all four are wired and resolving.

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

- **Who decides:** where a session runs is decided by whoever launched it (PAV, a wrapper, or direct `claude --agent`). Agents do not create branches or worktrees unless the user asks.
- **Main-checkout gate:** an `a start` that will run on the main checkout —
  free of live sessions, not `--here` sharing one (a session's working state
  is its own; the gate never moves files under it, dirt included) — needs a
  clean tracked tree: uncommitted changes refuse the start with the remedy
  (untracked files never block; `--worktree` is the escape, never touching
  the main tree). The tasks registry is the one exception: its tree rests
  dirty (the watcher's 15 s heartbeat outpaces the 900 s snapshot), so a
  start that will run there — a coordinator's — runs the engine's own
  snapshot commit first and proceeds, never refused for dirt (the commit is
  local only, the maintenance job's push owns it; a registry whose snapshot
  itself wedges still refuses with the by-hand remedy). A checkout on a spent
  side branch moves itself back to
  base when the branch is fully landed — merged into the freshly fetched
  `origin/<base>` tip and its task closed; a taskless branch needs only the
  merge — one visible line, and the base then fast-forwards on that fresh
  tip (never the ≤10-minute-stale ref; a fetch that fails skips the pull
  with one warning). A branch that is not fully landed — unmerged, or its
  task open or done-but-not-closed — refuses naming why and the escapes. A
  diverged base is left alone, warned only. The same rule `a land` already
  applies to the main checkout after a direct land.
- **Pr-policy branch in the main checkout:** the same start, in a repo whose
  landing policy is pr, cuts the task's own branch there — `t/<NNN>-<slug>`,
  created from base or the surviving branch checked out to continue a task —
  before the agent runs, so the work never sits on base and a pr land has
  its branch to open from (a direct-policy or unlisted repo keeps working
  on base; a live session sharing the checkout waives the cut with one
  warning — HEAD may not move under it). The task's own branch is the gate's
  side-branch exception: a start continues on it, and once its work is
  fully landed the start switches the checkout back to base and deletes the
  merged branch. A squash-merged PR leaves no ancestry git can show — a
  done or closed task's `t/` branch switches back on its landing record
  alone, the ref staying behind inert (git's `-d` declines what it cannot
  prove, the same as a reaped worktree's branch).
- **Create:** `a start <task-dir> --worktree` creates a task-bound worktree at
  `~/.agents/worktrees/<repo>/<NNN>-<slug>` on branch `wt/<NNN>-<slug>`, cut
  from the fetched `origin/<base>` tip — a fresh task carries the latest
  landed commits even when the local checkout is behind. A create rides the
  throttled fetch (a fetch that succeeded inside the 10-minute window is
  enough; one that runs and fails refuses the start — the cut would begin
  from a ref the engine knows it failed to refresh).
  `worktrees_root` in `~/.agents/config.json` moves the root (a leading `~` is
  HOME, a relative path resolves against the config file's directory).
  `a worktree remove <path>` and `a worktree list` stay for PAV; creation is
  `a start`'s (or `a task worktree`'s, the restore path), cleaning is
  `a doctor --clean`'s.
- **Bootstrap in a pane:** a repo with `repos[origin].setup` configured gets
  its worktree bootstrapped in the background at creation — the session opens
  immediately while the install streams in a pane (PAV's in the workspace
  when configured, the engine's own `Setup-<id8>` zmx session otherwise) —
  the details are in the Setup/teardown bullet below.
- **`.env*` copies:** creation and every later attach (`a start`, `a resume`)
  copy the main checkout's untracked root-level `.env*` files into the
  worktree, skipping names already present; a worktree rebuilt by raw git
  heals at its next attach. `a task worktree --task-dir <dir>` restores a
  task's lost worktree the same way — it is the only sanctioned recreation
  path; `git worktree add` by hand leaves the copies behind.
- **One removal rule:** a worktree is removable when its tree is clean, no live
  session runs inside it, it holds no stray task notes, and its task is closed
  (the disposition `a task close` sets) or done and dormant — every phase
  checked, the landing landed, and no intent event newer than one quiet
  day (the removal rule's own wait, apart from `a tasks sweep`'s 3-day
  archive default). A task done more
  recently keeps its worktree and branch on every automatic path — `a start`'s
  sweep leaves it silently, `a land`'s reap reports the keep, `a doctor
  --clean` lists it as kept ("task … is done, not closed") — so a freshly
  landed session stays resumable; `a task close` takes the worktree at once,
  teardown first, and a done task quiet past the grace goes the same way on
  every automatic path without the owner's word, its records untouched —
  the teardown command runs before every removal. A close whose worktree is
  held still releases the repo's resources — the teardown runs while the
  files stay, closed tasks only (an open or done task's worktree keeps
  everything: the work is not over). A live session inside holds the teardown
  itself ("teardown held — a live session runs inside it" on the kept line)
  and the daily clean self-heals once the session ends. The run is recorded
  per worktree in `<gitdir>/teardown.json`: only an exit-0 run is terminal —
  a failed or unfinished one is retried by every later visit (the daily
  `a doctor --clean` included) until it exits 0, a re-run bootstrap voids the
  record (the resources came back), and deleting the file by hand forces a
  re-run; the record dies with the worktree.
  A worktree whose branch matches no task in the database keeps the
  merged-into-base leg — and that leg reads both refs: the local base (where a
  hand merge may sit unpushed) and the fetched `origin/<base>` the cut itself
  rides, so a checkout sitting behind origin never holds a fresh task's
  worktree as unlanded. Branch deletion carries the same two-ref proof; when
  git's own `-d` check cannot see the origin-side ancestry, the engine's proof
  substitutes for it. The removal gets its own 120 s budget
  (`AGENTS_WORKTREE_REMOVE_TIMEOUT_MS` overrides) — `git worktree remove`
  deletes every file in the tree, and a removal killed at the shared 10 s git
  budget under load leaves a half-deleted tree that reads as dirt forever; a
  failed first attempt now heals through a forced retry at the full budget.
  `a doctor --clean` removes stale worktrees across
  repos, including harness worktrees under `.claude/worktrees/`, and purges
  `repos` rows whose checkout is gone — their task, session and event rows
  stay (history).
- **Removal receipts:** every engine removal — `a start`'s sweep, `a doctor
  --clean`, `a task close`'s and `a land`'s reap, `a worktree remove`, the
  start's failure rollback — writes a `worktree_removed` event and a receipt
  file at `~/.agents/worktrees/<repo>/.removed/<name>.json` naming path,
  branch, repo, actor (the session, or "unattributed") and reason, so a
  removal can be attributed from disk with no database. The receipt lives in
  the repo's worktrees root, never inside the removed worktree, and a
  receipt that cannot be written warns without failing the removal. Raw
  `git worktree remove` cannot be intercepted — receipts cover engine paths
  only, a limit that is accepted.
- **`.tasks` symlink:** `a start --worktree` symlinks `.tasks/<NNN>-<slug>` in
  both the main checkout and the new worktree, pointing at the central task
  folder, and appends `/.tasks/` to the shared `info/exclude` once. The engine
  resolves tasks through the central root, not this symlink.
- **`.env*` copies:** `a start --worktree` copies the main checkout's untracked
  root-level `.env*` entries (`.env`, `.envrc`, …) into the new worktree as
  regular files and reports them as `env_copies`, so an edit inside the worktree
  no longer edits the main checkout's file. Tracked names arrive with git and
  names already present are kept; directory entries are skipped; no ignore file
  is written, so the repo's own ignore rules must cover the names. Existing
  worktrees keep the old symlinks.
- **Setup/teardown commands:** `repos` in `~/.agents/config.json` holds the
  per-repo worktree commands, keyed by the repo's origin slug:
  `repos["github.com/owner/repo"] = { "setup": "…", "teardown": "…" }`.
  `setup` is the repo's bootstrap, and `a start <task> --worktree` runs it in
  the background while the session opens immediately: the bootstrap streams
  in the engine's own `Setup-<id8>` zmx session (`zmx attach <pane>` reaches
  it), or in the caller's terminal, streaming, when zmx is absent — and a
  launch whose spawn itself fails falls back to that in-terminal form. The
  launch is verified, never fire-and-forget: the start's belt waits for the
  runner's pid to land, retries the launch once, and a launch that does not
  take reconciles the record to `failed` and says so on stderr — no output,
  human or JSON, ever names a setup session that is not really hosting the
  bootstrap. The start's JSON carries the state as `setup: {state, marker,
  log, pane, pane_kind}` and the attachable session as `setup_mux:
  {kind: "zmx", name: "<session>"} | null` — always present, set only while
  the bootstrap is pending in a listed, not-ended session (the contract a
  PAV-side pane task builds against to attach the bootstrap beside the
  agent session); the start's stderr names the pane on a verified launch and
  on adoption. The state lives in the worktree's git dir beside the
  completion marker: `<gitdir>/setup.json` (the record — state, pane, pid,
  exit code, log tail) and `<gitdir>/setup.log` (the merged output), dying
  with the worktree. The start waits only until the session's launch
  environment can be built — the worktree's `.envrc` evaluated through
  direnv, retried once a second while the bootstrap is pending until the
  evaluation is green and carries the venv variables the main checkout's
  `.envrc` yields (a bare `source <venv>/activate` evaluates green without
  the venv, so the names — not the exit code — are what the wait reads;
  typically the first seconds of a venv-creating install, while the rest
  overlaps with the open session); a bootstrap that fails or dies before
  then refuses the start with `setup_failed` and its tail, and the
  failed-start rollback kills the setup session before the force-remove, so
  no bootstrap ever writes into a removed tree, and a start that merely
  adopts a running bootstrap never kills its pane. The session's agent sees
  the bootstrap through `prime` (its `setup` field, with a warning while
  pending or failed), `a setup status [--json] <worktree>` (always exits 0 —
  the state is the answer), `a setup wait [--timeout <s>] <worktree>` (exit
  0 complete, 1 failed with the tail and the remedy, 3 budget expired) and
  `a setup run <worktree>` (the runner itself, run by hand — streaming, and
  refusing a live second bootstrap; it recognizes its own launch record
  through the session it runs in, so the launcher's pre-launch record never
  blocks the bootstrap it starts). The session's own context carries the
  state too, hook-borne: SessionStart and every prompt inject the pane and
  the wait instruction while the bootstrap is pending, the exit and tail when
  it died, and nothing once complete — task-bound, engine-linked sessions
  only, and only while hooks are on. A completed run restores the tracked files
  the command itself dirtied (an installer rewriting a lockfile), recorded as
  `restored` in the setup record and noted in its log — a worktree is born
  clean, because the one removal rule keeps a dirty tree and setup dirt would
  otherwise hold the worktree at close while its teardown never ran;
  pre-existing dirt is never touched. The completion marker keeps the
  run-once semantics — a reuse start with the marker launches nothing, a
  deleted marker relaunches — and a live bootstrap is adopted (the session
  opens beside it), a dead one relaunched.
  `AGENTS_SETUP_TIMEOUT_MS` overrides the 850 s bootstrap budget (the runner
  and the environment wait alike), `AGENTS_SETUP_LAUNCH_BELT_MS` the 10 s
  setup launch belt (each of the two attempts).
  `teardown` is the
  setup opposite: it runs immediately before a worktree's resources are
  released — before every removal, on every removal path (`a worktree remove`
  including `--force`, the rollback of a failed start, `a start`'s sweep, `a
  land`, `a task close`, `a doctor --clean`), and on a kept close too: a
  close whose worktree is held (dirty, or held for another rule reason)
  still runs it when the task is closed — the files stay, the resources go —
  while a live session inside holds the teardown itself (the daily clean
  self-heals once it ends). Every result carries the run as `{command,
  exit_code}` (an incomplete run also carries `error`, why it did not
  complete) — `a start --worktree --json`'s swept rows, land/close's
  `worktree` field, `a doctor --clean --json`'s `clean.removed` and kept
  rows, not just `a worktree remove`'s output; the kept lines carry the bit —
  `; teardown ran`, `; teardown already ran`, or the failed/incomplete warn
  naming the next clean's retry. It runs in the worktree with the clean-base
  env and a 120 s timeout (`AGENTS_TEARDOWN_TIMEOUT_MS` overrides it). Each
  worktree records its last run in `<gitdir>/teardown.json`, beside the setup
  record: only an exit-0 run is terminal — it never re-runs on any path —
  while a failed or unfinished one is retried by every later visit (the daily
  `a doctor --clean` included) until it exits 0; a re-run bootstrap (delete
  the setup marker, `a setup run`) voids the record because the resources
  came back, and deleting the record file by hand forces a re-run (the same
  gesture as the setup marker's). A
  completed failure never blocks the removal — it warns on stderr with the
  exit code — but a run that did not complete (timed out, could not start,
  or was killed) holds the worktree for the next sweep's retry: no
  automatic path removes it, and `a worktree remove` refuses until `--force`.
  Anything it leaves inside the worktree makes git refuse the
  removal, so it must clean up outside the tree, never write into it. Either
  field set to `""` opts the repo out of that command; a field that is absent
  means the same thing to the engine (nothing runs), so the old
  `setup.repos` / `teardown.repos` maps and the `setup.command` /
  `teardown.command` defaults are gone — an install moves any legacy values
  into `repos` once. When a repo resolves a setup command but no teardown, `a
  start --worktree` warns once on stderr with the line to add (a deliberate
  `""` teardown opt-out warns too — the engine cannot tell it from
  unconfigured).
- **Landing (`a land --task-dir <dir>`):** puts the task's branch on base. It resolves the
  repo's landing policy (`direct` pushes to base, `pr` pushes the branch and opens a PR with
  `gh pr create`; an unlisted repo is refused until `--policy pr|direct` records one),
  refuses a dirty tree, fetches and rebases onto base, refuses checked phases the owner has not
  accepted (when `approvals` is `ask`), refuses a `pr` land whose diff is over 1000 added + deleted lines. Lockfiles and `linguist-generated` paths are not counted, and the result's `pr_lines` is the count. It then runs each `--check <cmd>` in the task's tree (default `zsh scripts/check.sh`, repeatable) and pushes. A `pr` land whose tree is the main checkout on base with commits ahead of origin
  rescues them: it cuts the task's `t/<NNN>-<slug>` branch at HEAD, moves the checkout onto it
  and rewinds local base to origin's tip — every local-only commit rides the branch, so nothing
  is lost — then pushes and opens the PR as usual. A `pr` task whose phases carry two or more PR letters
  lands each group on its own branch `<task branch>.<letter>`, never the task branch: the PR of a group
  opens once every phase of it is checked, based on the group below's branch (on base once that PR is
  merged), and the 1000-line count is the group's own diff. A task whose earlier land was a single-PR or direct land never becomes stacked: stacking starts from a task's first grouped land. A rebase also pushes the lower group branches it moved. After a lower PR merges (squash, merge or rebase) the next land drops its commits from the layers above, retargets the PR right above to base with `gh pr edit`, records the layer as `merged` and never pushes it again; a layer someone changed on GitHub since the last land refuses `stack_diverged` and prints the git commands that fold their commits in, and a group is not cut on a group that still has unchecked phases. A `fixup! <sha>` commit aimed at a lower PR's commit folds into that PR on the next land (the PRs above restack); one that clashes with a PR above refuses `rebase_conflict` naming the fix and how to make it a plain commit, and one whose target hash is in none of the landing commits or a merged PR refuses `fixup_unplaced` before the rebase. The result and land event carry `layers`. A stacked task reads landed (`proof: stack`) only when every group's PR is merged: `a next` says `drive` while PRs are open (and `land` once after a lower one merged, so the PRs above restack), asks GitHub only for that one task (a listing shows the last recorded state), and its JSON carries `review_base` (the ref the cold review diffs against: the open PR below the next land, else `origin/<base>`) and `prs`; removing a landed stacked task's worktree deletes its group branches.
  It writes no status and no SHA. Every refusal prints what is wrong and a `Remedy:`
  line: `no_task`, `policy_unlisted`, `no_branch`, `branch_exists`, `dirty_tree`, `fetch_failed`, `rebase_conflict`,
  `not_accepted`, `pr_groups_mixed`, `pr_too_big`, `pr_size_failed`, `check_failed`, `test_slot_busy`, `test_slots_invalid`, `non_fast_forward`, `stack_diverged`, `fixup_unplaced`, `pr_closed`, `pr_failed`. The owner's way past a missing
  acceptance or an oversized PR (the alternative is splitting the group) is `a decide … --choice land_anyway --quote "<why>"`. A land takes as long as its
  checks (each up to 850 s), so a caller with a shorter timeout must raise it; the MCP `land` tool
  allows 900 s.
  Each check run (a land's, and `a check`'s) takes one of the machine-wide **test slots** first, so
  several worktrees' full suites cannot all run at once. The owner sets how many in
  `~/.agents/config.json` as `tests.slots` (default 2, read on every poll, so an edit takes effect
  at once; anything but a positive whole number refuses `test_slots_invalid`). A run that finds
  every slot taken queues, printing which tasks hold them and since when; waiters take freed slots
  oldest first. A check skipped for a recorded pass takes no slot. A run that waited returns
  `slot_wait` (`waited 3m for a slot held by task <task>`) in its `--json` result (on the
  `checks` entry for a land) and on stderr. A wait past 300 s (`AGENTS_SLOT_WAIT_MS`) refuses
  `test_slot_busy` instead of skipping the run; a holder whose process died frees its slot.
- **`land` knob:** `land: per_phase` (default) lands each phase individually;
  `land: at_end` accumulates commits and lands once when all phases are committed.
  Set via `a task set --knob land --value per_phase|at_end`.

See [ADR-012](docs/architecture/ADR-012-worktree-tasks-resolution.md) for the
concurrent-workloads decision (pathspec scoping + worktrees + landing).

---

## Configuration

AGENTS creates `~/.agents/config.json` on first install. Edit it to customize agent
models — per-agent overrides and aliases below. After editing, run `make install` to
regenerate agents.

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

Unknown top-level config keys are passed through untouched — the generator reads
only the sections it documents. For example, a machine-local `profiles` map (the
dotfiles `agents-profile` switcher keeps profile definitions inside
`~/.agents/config.json`) generates no warnings and changes no output.

### Tools

Add MCP tools that get merged into agent definitions during generation:

```json
{
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
each repo via `~/.agents/repo-policies.json`:

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

Conductor and Courier read the policy from `prime`'s JSON (`policy` with its `base`) at the
land step. `direct` — `land` now; `pr` — one cold Reviewer pass over the whole task diff
first, then `land`; unlisted — the owner is asked `pr` or `direct`, and the answer rides to
`land` as its `policy`. `a land` resolves the same file: `"direct"` repos push to base,
`"pr"` repos push the branch and open a PR, and an unlisted repo is refused with a `Remedy:`
naming `--policy`.

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
| `Coordinator` | The roster's coordinator: watches by the owner's standing rules, acts alone inside its boundary, asks only for the irreversible and a new task's first launch, eyes for image-blind seats, open asks held in one machine-readable file, the owner channel while away (asks out, replies translated back); opens each launch's /coding tab |
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

**Shell helpers** _(optional)_: `./install.sh` installs the `a` CLI as a shim at `~/.local/bin/a` that runs the installed snapshot (the global session hooks invoke it), and `pane-send`, `task-probe`, `engine-wait` and `watcher` as helper shims that spawn the snapshot's copies under the recorded node (`engine-wait` is the coordinator's background poll — it wakes the coordinator's session on watched tasks' engine facts; armed with `--external` it also wakes on the owner's configured external source, printing `wake=external` — the wake command and the channel are the owner's private setup; the repo knows the flag and the line; `watcher` is the away safety net — a launchd job that relays watched pendings over the owner's private channel while the coordinator cannot, replaces a deaf one under the spawn cap, renews a down home on the next tick with the owner present or away (its task active, refusals bounded by the down-retry bound, the renewed seat's first move verified from its transcript), and keeps the heartbeat `a doctor` surfaces plus, while a spend cap is configured, the month's spend ledger beside the database that `a doctor` reads). The helper shims watch their parent chain and take their command down with it when that chain dies, and the poll self-reaps the same way inside the script — a poll that outlives the seat that armed it serves nobody. `pane-send` is the one shared send path for zmx panes: `send` chunks and Enters (transcript-verified, text flattened; a send into a gate-awaiting session carries `--decision-id` naming the owner's fresh decide row), `paste` wraps the whole body once in bracketed-paste markers with newlines preserved and no Enter (offered unsent), and `answer` keystrokes a permission prompt — a verified answer clears the session's `needs_input` the way `prompt-submit` does. Run `./install.sh helpers` to additionally add the `a-explorer`, `a-builder`, `a-reviewer`, `a-committer`, `a-conductor`, `a-courier`, and `a-coordinator` launcher commands to your PATH (`a-conductor`, `a-courier` and `a-coordinator` are one-line wrappers over `a start`). The `a` CLI provides repo identity, task management, state operations, policy resolution, session registry, worktree ops, landing, and `a doctor` for install verification — all with `--json` output for scripting. The `a-*` helpers launch specific agents. See [cc-quickstart.md](./docs/cc-quickstart.md) for details.

### `a start`, `a ls`, `a resume`, `a restart` — the session verbs

`a start` is the launch path instead of running `claude` directly. It fetches the base branch (skipped when the last fetch succeeded under 10 minutes ago, so the behind-warning can be that stale; a worktree start whose fetch runs and fails refuses — its branch is cut from `origin/<base>`, never a ref the engine failed to refresh — while the main checkout's switch-and-pull always fetches fresh past the window), binds a task, registers a session and runs `claude` in a detached zmx session, then attaches:

```bash
a start 002                    # Conductor on task 002 (number, NNN-slug or slug)
a start --title "fix typo"     # new task with this title
a start --courier --title "fix typo"   # Courier: a fast, minor task
a start 002 --worktree         # in the task's own worktree (~/.agents/worktrees/<repo>/002-<slug>)
a start 002 --here             # in the main checkout even when a session runs there
a start 002 -- --model opus    # everything after -- goes to claude
a s 002 -w -n                  # the same as a start 002 --worktree --no-attach
a restart 002                  # replace task 002's coordinator with a fresh session
```

Every verb has a one-letter alias (`s l r n t d`; `decide` and `land` stay long) and every flag a one-letter form (`-w -e -n -j -r -t …`, shown in `a <verb> --help` as `-t, --title`). `-t x` and `-t=x` both work; short flags do not combine, so `-wn` is refused.

When the main checkout already has a live session, `a start` asks `[w]orktree / [h]ere / [c]ancel`; without a terminal it refuses naming `--worktree` and `--here`. When the task already has a live session, a terminal is asked `[a]ttach / [c]ancel`; without one `a start` refuses with exit 2 naming `a resume <task>`. Add `--no-attach` to start detached, or `--json` to print the session. Model/gateway env lives in `~/.agents/launch.env`, named by `launch.env_file` in the config (a relative path resolves against the config file's directory); `launch.command` replaces `claude`. Every session starts in its folder's own environment: the launcher's Python activation and venv-bin `PATH` entries are stripped (the clean base), then the folder's `.envrc` is evaluated by the engine through real direnv before registration. A blocked, denied, failing, or missing-direnv `.envrc` refuses the start with a named code and a remedy; no `.envrc` means the clean base only. `AGENTS_DIRENV_TIMEOUT_MS` overrides the 30 s direnv evaluation timeout. A worktree start whose repo has a bootstrap configured opens the session immediately — the bootstrap streams in a pane in the background, and while it is pending the `.envrc` evaluation is retried once a second until the environment can load and yields the venv variables the main checkout's `.envrc` names (seconds, not the whole install); a bootstrap that fails before then refuses the start with its tail. Checks (`a check` and `a land`) run in the environment of the session that calls them, not in the computed launch environment.

`a ls` lists the tasks that have a live session, or are not done, were written in the last 7 days and whose checkout exists, with their next step. `--all` lists every active task. `a ls --json` reads the index and derives each row's fields (`task_status`, `current_phase`, `phases_checked`, `phases_total`, `advice`, `landing`, `approvals`, `migrated`, `live`, `resumable` — the newest ended Conductor/Courier/Coordinator session) plus every live session on its own row with its registration `origin` and its repo's `main_root`, the `repos` rows (`repo_key` + `main_root`; a repo whose `main_root` is gone on disk stays listed only while it holds an active task — one stat per row, and `a doctor` names the repos left out, one action row each — `a doctor --clean` purges them) and `ended_sessions` (rows ended within 24 hours of `generated_at`, newest first, unbound rows included) — every value from the database save that one stat; with a warm cache it runs under 200 ms (default) and under 500 ms with `--all`, wall time, warm median — measured 170/370 ms on a copy of the live tree with the 907 registrations in place. `a resume <task|session>` reopens an ended one with `claude --resume` in a new zmx session (`-r1`, `-r2`, …), or attaches when it is live. `a restart <task|session>` replaces a Coordinator with a renewed seat on the same task and flags: the live one is first asked to flush its working context to the task records (one line through pane-send, then a bounded wait — `AGENTS_RESTART_FLUSH_TIMEOUT_MS`, 120 s by default — for the hand-off turn to end; a refused or deaf flush proceeds without blocking), then ended cleanly (`/exit` in its pane, a zmx kill — forced after the plain one — past `AGENTS_RESTART_EXIT_TIMEOUT_MS`, 10 s by default, each kill polled for `AGENTS_RESTART_KILL_GRACE_MS`, 5 s), the end is recorded once observed, and the replacement resumes the old conversation when its transcript ended clean (the same session id, `--resume` in the launch, the pane name reused, `resumed: true` in `--json`) or cold-starts a fresh session (`previous_session_id` names the old — a mid-turn or transcript-less old session takes this path, its unrecorded tail lost as before). Every Coordinator launch — start or restart — then submits the seat's first move itself: one line through pane-send once the pane's input box shows (`AGENTS_KICK_READY_MS`, 60 s by default, the readiness wait; `AGENTS_KICK_VERIFY_SECS`, 10 s by default, the transcript verify), never fatal, never retried; the watcher separately records whether the renewed seat actually works (an assistant row in its transcript within `AGENT_WATCHER_KICK_SECS`, 90 s by default, of the launch). Coordinator-only — a closed task, an unlanded side branch, a worktree's failed fetch, a running turn, an unsent draft, an open permission prompt or another live session on the task refuses with nothing ended (the refusal classes the fresh start would hit fire before the seat is touched), an already-ended coordinator proceeds as a plain replacement, and the original start's `--` passthrough is not recorded, so it does not carry over (a restart's own `--` forwards).

**Launch, then paste.** Start with `a start` and no prompt; the session opens with the bound task injected by the `prime` hook, and you paste the prompt (text, screenshots, files) as the first message.

`a-conductor`, `a-courier` and `a-coordinator` are one-line wrappers over `a start --conductor`, `a start --courier` and `a start --coordinator`: `a-courier "fix typo"` asks to create that task and opens it (`a-courier --title "fix typo"` does not ask). Quote a multi-word title.

`a launch` still works, routed through the same environment builder. It refuses
when a live registered session's cwd realpath equals the target the new session
will run in (the `--cwd`, or the harness worktree path when `--worktree` is
passed); `--here` shares the checkout. Under a zmx timeout it refuses with
`zmx_timeout` (spawn-class, like `a start` and `a resume`).

### `a decide` — the owner's answers

The owner's words are the input, and they are kept as spoken: every accepted answer is a `decisions` row with the quote byte for byte, and one move of the task.

```bash
a decide --task-dir 001 --phase-id 1 --choice approve --quote "Go, but keep the old API"
a task note --task-dir 001 --phase-id 1 --text "waiting on the staging key"   # sets the phase's note
a task check --task-dir 001 --phase-id 1                                        # marks the phase done
a task worktree --task-dir 217                                                  # the task's worktree, restored when missing
```

| Choice | What it records |
| --- | --- |
| `approve` | the owner approves the phase's plan |
| `reject` | the owner rejects the plan; the quote goes back to the Explorer |
| `answer` | the owner answers the questions the plan or the advice raised |
| `accept` | the owner accepts the built and reviewed phase, so it can be committed and landed |
| `skip` | the phase counts as checked without work |
| `land_anyway` | lets a land past a missing acceptance |
| `waived` | the agent waived a gate, naming it with `--gate` |

`a decide` writes one `decisions` row per answer and changes no phase status; `a next` derives the move from those rows, the plan files and git. A choice outside the seven is refused with a `Remedy:` line. `check_phase` (`a task check`) is the one writer of phase progress. `waived` names its gate with `--gate` (`phase-plan`, `phase-build`, `task-plan`, `finalize` or `land`), and a task-level `answer` names `task-plan` or `finalize` the same way; every other choice's gate follows from the choice itself.

### `a check` and land's skip

`a check --task-dir <dir> -- <cmd>` runs a command in the task's tree and records
one `check_run` event (kind `check_run`, not `check` — that is the checkmark's
intent kind) with `{command, tree, exit}`. The tree must be clean (the recorded
tree is `HEAD^{tree}`); a dirty tree is refused with the remedy. `a check` exits
with the command's exit code. Agents run every full suite through `a check`
(the testing skill's rule); `--no-record` runs it on an uncommitted tree and
records nothing, so it never feeds land's skip, but it still takes a slot. The run takes one of the machine-wide
test slots first (`tests.slots` in `~/.agents/config.json`, default 2; see
Landing), reading the tree hash once it holds the slot; a run that queued adds
`slot_wait` to its result, and a wait past 300 s refuses `test_slot_busy`.

`a land` skips a check whose newest `check_run` on the task matches the same
command on the same tree with exit 0 — the tree hash is the identity. A rebase
that changes the tree, or a Committer that splits commits differently, re-runs
the check. The default `zsh scripts/check.sh` participates identically.

### The failed-resume rule

`a resume <id>` refuses, exit 4, when the session never had a turn — no
transcript exists for it. The cause names the fresh start (`a start <task>`, or
`a start --title <title>` when it had no task); the id and any transcript are
kept, nothing is deleted. A resume whose transcript exists keeps today's
byte-restore rollback.

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

A task's one home is its central folder, `~/.agents/tasks/<repo_key>/<NNN-slug>/`:

```
~/.agents/tasks/github.com-owner-repo/001-add-auth/
  task.md                      # Research + phases + decisions + notes (the three blocks render from the database)
  plan/
    phase-1-config.md          # Detailed plan for phase 1 (optional)
    phase-2-user-model.md      # Detailed plan for phase 2 (optional)
```

### Phase-Based Workflow

1. **Initial research** → `task.md` with research findings + phase table with PR groups
2. **Plan Next Phase** (optional) → detailed plan for complex phases → `plan/phase-N-[name].md`
3. **Builder** → picks smallest planned unit (phase plan if exists, else task.md)
4. Mark phase ✅ Done, repeat

| Agent        | Reads                   | Updates                              |
| ------------ | ----------------------- | ------------------------------------ |
| **Explorer** | `task.md`, `plan/*.md`  | `task.md`, `plan/*.md` |
| **Builder**  | Phase plan or `task.md` | the MCP tools (`add_phases`, `check_phase`, `note`, `decide`) |
| **Reviewer** | All plan + implement    | the MCP tools (`decide`, `note`) |

The table between the `<!-- phases:start -->` and `<!-- phases:end -->` markers
under `## Phases` in `task.md` is the engine's: it is rendered from the database
on every write, so write outside it (a hand-written table under the heading
stays, below the block). The decisions and notes blocks carry their own markers.

**To continue a task**: Just say "Continue working on [task-name]"

### Database

`~/.agents/agents.db` (SQLite, WAL; needs Node 22.5+) holds every task, phase,
checkmark, decision, note, event, session and repo; it is always on and created
on first open. The tables hold the declared intent; every status is derived on
read — a task's status word, a session's state, and a task's landing (a merged
PR over a non-empty range, a patch identity or a recorded push, never ancestry
alone; `unresolved` otherwise). The slow git facts
sit in a per-fact cache file the sweep recomputes. A schema 1 file migrates to
v2 automatically on open, keeping a checked `agents.db.v1.bak` — only the
installed engine migrates the home default. Repo-local `.tasks` leftovers
move into the central folder by hand (no verb folds). The unresolved list
the v2 install's one-shot step printed closes on the owner's word with
`a task close --batch <unresolved.json> --quote "<words>"`. The `repos` table is
the one repos store (no `index.json`). `a export` re-renders `task.md`'s blocks
from the database (`--check` compares with the files and exits 1 on any
difference). `a tasks backup` keeps a daily `agents.db.bak`, and
`a doctor --verbose` shows the database, its backup age and the node version.

**Rollback of the import** (run with the owner): stop every session and PAV
first, and keep PAV stopped throughout. Run `sh <bundle>/undo.sh` — with more
than one bundle, the newest bundle's is the one to run — which moves every
folded file, folder, link, loose entry, `task.json`, `index.json` and
batch-closed task folder back, printing each path it skips. Before restoring,
check the backup the migration printed (`sqlite3 -readonly <path> "PRAGMA
quick_check"` answers `ok`); then point `~/.agents/bin/current` back at the
previous snapshot and replace `agents.db` with that backup after removing
`agents.db-wal` and `agents.db-shm`. After the restore, `schema_version` reads
1 and `a ls` answers; every write since the migration is lost (the tasks
root's own git history holds every `task.md` revision), and PAV starts again
only after its reader phase is reverted on PAV's `main`.

A task's Markdown lives only in its central folder; `a doctor` carries one
count row while any sits elsewhere (a repo-local `.tasks/` or a worktree's
stray notes) — `--verbose` lists each path with its destination.

### Safety: trash and snapshots

Deleted tasks are never `rm`'d — they move to `~/.agents/trash/`. `a trash ls`
lists them; `a trash purge --older-than 30d` is the only deleter. The central
root is a git repo: `a tasks backup --init` sets it up with a launchd agent
that commits every 15 minutes (an `a start` into the root commits its own
snapshot first, so the resting dirt never blocks a coordinator's start), so
every file is restorable to any point in time.

The maintenance family's second launchd job ships with `./install.sh` and
runs `a doctor --clean` once a day at local noon (`com.mcouthon.agents.cleanup`
— a missed tick runs once on wake, and its PATH carries the Homebrew prefixes
because launchd runs without a shell): worktrees the one removal rule lets go
are removed with the repo's teardown command first, gone repo rows are purged,
and the day's action rows land in `~/.agents/logs/cleanup.log`.

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
├── skills/               #   23 skill templates
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
throwaway HOME (`lib` and `rest` are its two halves, `check.sh <name>` names suites), with
each suite in its own temp root in a bounded pool — half the machine's cores, longest
recorded suite first, `CHECK_JOBS` lowers the pool only — and a suite that goes silent for
three minutes — or outlives a ten-minute outer ceiling — is killed and fails the run with
its name and captured output; a slow suite is never killed. Two wait-shaped suites
(engine-wait, pane-send) no-op behind the `AGENTS_TEST_TIMING` gate — the default battery
is the fast landing run; `AGENTS_TEST_TIMING=1 zsh scripts/check.sh` runs every check
(the full-coverage battery).
This is the verification command to record.

**The battery's construction standard:** speed comes from construction, never from
gating a check. A scenario that proves a timeout knobs its budget small (an env knob;
the production constants never change) and proves the same refusal ladder; a suite that
rebuilds the same repository clones the shared template world
([`scripts/fixture-world.js`](scripts/fixture-world.js)) once per suite instead of
re-initializing it per fixture; a hold that waits on an event (a completion marker, a
release latch) polls the event, never a clock that guesses when it landed — and every
knobbed wait still fails fast on real breakage, inside its knobbed bound. An assertion
that re-proves a behavior another check already owns (a duplicate row through a second
door) merges into its owner — the owner keeps the full proof, each door keeps its own
delta — and every merge is owner-approved and named in the [CHANGELOG](CHANGELOG.md),
never silent. The one gate is owner-approved and named there too: the two wait-shaped
suites (engine-wait, pane-send) run only behind `AGENTS_TEST_TIMING=1` — the default run
launches them and they pass as no-op lines — and nothing else is ever gated out of it.

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
