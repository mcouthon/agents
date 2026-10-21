# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Blocked phases defer instead of halting (D53).** `a next` picks the
  first open phase whose `blocked_by` deps are complete; an earlier phase
  waiting on a later one no longer freezes the task at `blocked`. Only when
  no open phase is eligible does the earliest blocked phase come back as
  `blocked` with its deps. Phase order is therefore state (`blocked_by`),
  not prompt text.
- **Hook kill switch and silent second pass (D51).** `a hooks off` writes
  `~/.agents/hooks.disabled` and every hook returns success without
  evaluating anything; `a hooks on` removes it; `a hooks status` shows it.
  The second evaluation of a Stop/SubagentStop hook (`stop_hook_active`)
  now emits no output at all: `additionalContext` on Stop tells Claude Code
  to continue the conversation, so the former "warning" kept sessions alive
  until the nine-block cap. The warning is written to the hook log instead.
- **One report format per agent (D47).** `generate.js` renders a single
  `## Final report` section at the end of every agent file that has a schema
  in `report-schemas.json` (explorer, builder, reviewer, committer; Courier
  uses builder + committer). The section contains the human-readable report
  shape and the JSON block skeleton with every required key and a one-line
  comment per key. All prior report-format descriptions in the templates
  (Courier "Delivery Report", Builder/Explorer/Reviewer/Committer "JSON
  Report") are deleted — one source of truth per agent.
- **Block reasons carry the fill-in skeleton (D47).** When `report-parser` or
  `courier-stop` blocks because the report is missing or invalid, the block
  reason includes the JSON skeleton with placeholder values and the sentence
  "paste this block at the end of your message, filled in."
- **Block at most once per turn (D47).** Every Stop/SubagentStop handler
  (courier-stop, conductor-stop, quality-gate, report-parser) blocks on the
  first evaluation and allows with a warning on the second (`stop_hook_active`).
  The warning is emitted as `additionalContext` so the agent sees it.
- **Hook code machine-owned guard (D47).** `handleMachineOwnedGuard` denies
  Edit/Write and Bash writes under `hooks/` and `scripts/lib/{hook,guards}.js`
  when the bound task's title and task.md do not contain "hook"
  (case-insensitive). Sessions without a bound task are unaffected. Reason:
  "hook code is changed by a task about hooks, not in reaction to a block."
- **Hook block log and `a doctor` counts (D47).** Every `blockStop` appends a
  one-line record to `~/.agents/logs/hooks.log` (timestamp, session id, hook
  name, reason). `a doctor` reports per-session block counts for the current
  day from the log.
- **Trash root at `~/.agents/trash/` (D47/D40).** `a task close` moves deleted
  tasks to `~/.agents/trash/<date>/<repo-key>/<slug>/` (was
  `~/.agents/tasks/trash/`), so nothing under the tasks root walks into it.

### Fixed

- **`hookSpecificOutput` carries `hookEventName` (D50).** Every hook emitter
  (`denyPreToolUse`, `askPreToolUse`, `rewriteInput`, `inject`,
  `allowWithWarning`, the report-parser success path) stamps `hookEventName`
  taken from the stdin payload's `hook_event_name`, falling back to the event
  the handler is wired for (`HANDLER_WIRING`). Fixes Claude Code rejecting
  second-pass Stop/SubagentStop warnings with "hookSpecificOutput is missing
  required field hookEventName". A schema test exercises every emitter's
  output path and fails on any `hookSpecificOutput` without `hookEventName`.
- **Lenient report extraction (D50 item 2).** `extractJsonReport` strips `//`
  line comments and trailing commas before parsing, and accepts a bare
  top-level `{…}` object ending the message when no ```json fence is present.
  `renderSkeleton` now emits valid JSON (placeholder values only); the per-key
  explanations are a list under the fence in both the generated agent files
  and the block reason. A skeleton pasted verbatim — with or without its
  comments, with or without the fence — now parses.
- **Test log isolation (D50 item 3).** The hook log path honours
  `AGENTS_LOGS_ROOT`, so `npm test` no longer appends to the live
  `~/.agents/logs/hooks.log` and inflates `a doctor`'s counts.
  `test-hooks.js` sets `AGENTS_LOGS_ROOT` to a tmpdir; a static guard asserts
  no test file that exercises blocking hooks runs without it. `a doctor`
  prints the log path it counted.

### Changed

- **`a cc` launcher (D38, D39, D43, D44).** `a cc` is the owner's launch path
  instead of running `claude` directly. It resolves the repo from `--repo` or
  cwd, checks the registry for live sessions on the main checkout (occupancy),
  and runs the new session in a task-bound worktree when occupied. Conductor
  needs `--task <slug>`, `--continue` (picks the most recently active non-done
  task), or a positional slug; without any, it defaults to `--continue`.
  Courier is task-backed: without `--task`, `--title "<short>"` creates a minor
  task (`a task create --mode fast --tier minor`); a positional prompt without
  `--title` supplies the title from its first line (max 80 chars, D39) and is
  forwarded to claude. Flags are parsed before positionals. Sessions use zmx
  (`zmx run -d` detached, `zmx attach`) by default; `--tmux` selects the tmux
  fallback (every argv element quoted before `send-keys`); without zmx or tmux,
  runs in the foreground. `a cc ls` defaults to live sessions only (`--all`
  for history), `a cc attach/kill` route to zmx or tmux per the registration's
  `mux` field. `a doctor` checks zmx is installed and ≥ 0.8.1. Every launch
  starts with a sub-second self-heal (prune dead/reused sessions, trash empty
  tasks older than one hour, quick doctor check). A failed launch rolls back
  the task, registry entry, zmx/tmux session, and worktree in the same process.
  `--` forwards args to `a launch`; model env lives in `~/.agents/launch.env`.
- **Liveness verification (D38 item 6).** `session.isLive(entry)` verifies
  process identity: the pid must be alive, the command line must contain
  `claude` (not `bg-spare`), and the process start time must not be later than
  the registration's `created_at` (pid reuse detection via `ps -o lstart,command`).
  `findLiveByRepoKey` uses `isLive`. `a session ls --prune` marks lost entries
  as ended. `a cc ls` and `a tasks ls --live` use `isLive` for accurate counts.
- **Courier-stop landing (D38 item 4).** When the bound phase is committed and
  the session cwd is a worktree, the `courier-stop` hook runs `a land`, then
  `a worktree remove` when no phases remain, then `a task close` by tier. On
  conflict, the worktree is left and a `needs_human` flag is written with the
  file list.
- **`createTask` migration guard (D38 item 5).** `a task create` calls
  `ensureMigrated(key)` first and propagates its refusal exactly like
  `resolveTaskDir`, so a repo whose `.tasks/` has not moved never gets a
  central task with numbering restarted at 001.
- **Central tasks root (D20/D35).** Tasks live at `~/.agents/tasks/<repo-key>/`
  — one central root, no per-repo `.tasks/` directory, no symlink, no
  `tasks.root` knob. `AGENTS_TASKS_ROOT` env override isolates fixture tests.
  `a task migrate --all --apply` moves each repo's `.tasks/` to the central
  root (refuses while live sessions are active, holds task locks during the
  move); `install.sh` adds `~/.agents/tasks` to `permissions.additionalDirectories`
  so sessions can read/write the root. A repo-local `.tasks/` met later is
  moved on first touch by `ensureMigrated` in the resolver.
- **Task tier lifecycle (D36).** `task.json.tier: strategic | standard | minor`
  (default `standard`; Courier/fast mode defaults `minor`), set at
  `a task create --tier`, changeable via `task_set`. When every phase is
  `landed`/`failed`/`skipped`, `a next` returns `consolidate`. The
  `consolidate-task` skill ends with a JSON report `{distilled_to, proposals}`
  persisted by `a report --agent consolidator`. `a task close` applies the
  tier rule: strategic requires non-empty `distilled_to` then archive;
  standard archives if distilled, else deletes; minor deletes. Archive
  moves to `~/.agents/tasks/archive/<repo-key>/<NNN-slug>/`.
- **Skim views (D20).** `INDEX.md` at the central root renders all tasks
  across repos (tier, disposition, status, next step, live session, last
  activity). `a tasks ls` with `--status/--tier/--live/--since/--json`
  filters. `a tasks show <slug|dir>`. `a tasks sweep [--older-than Nd] [--apply]`
  lists or closes done tasks by disposition. `a tasks doctrine <key> '<json>'`
  sets the default-tier table for a repo.
- **Consolidator report schema.** `scripts/lib/report-schemas.json` gains a
  `consolidator` schema (`distilled_to`, `proposals`); `emptyReports()` and
  `AGENT_REPORT_KEYS` updated to include it.
- **Done predicate.** Every phase `landed`/`failed`/`skipped`/`done` —
  evaluated against phase statuses, never `task.status`. `autoCompleteTask`
  extended to treat `landed` as terminal. `a task close` and `a tasks sweep`
  key off the phase predicate directly.

### Changed

- `tasks-root.js` always returns the central path (no `repo|central` switch).
- `defaults/config.json` drops `"tasks": { "root": "repo" }`.
- All readers (`buildTasksIndex`, `rebuildTasksIndex`, `listTasks`,
  `resolveTaskDir`, `render`, `prime`, lint cross-task overlap) resolve
  through `tasksRoot()`.
- `worktree.js` dead `.tasks` readers (`clearWorktreeFromTasks`,
  `isBranchLanded`) deleted; `remove` inlines central-root logic.
- `session.js find` gains a `repo_key` filter; `findLiveByRepoKey` for the
  migrate live-session refusal.
- `state-ops.js` resolves task_dir through `tasksRoot()` for all MCP tools.
- Obsolete `.tasks/` prose reworded in `repo.js`, `project-dir.js`,
  `writeguard.js`.
- MCP tool descriptions updated: `task_dir` accepts absolute path, slug, or
  number; `tasks_list` description no longer references `.tasks/tasks.json`.

### Fixed

- **Machine-owned task files guard and refusal actions (D37).** Task files
  (`task.json`, `state.md`, `state.json*`, `tasks.json`, `index.json`) are
  machine-owned: a new PreToolUse guard (`hooks/machine-owned-guard.sh`,
  active for every agent type and unbound sessions) denies Edit/Write whose
  file_path basename matches, and Bash commands that write to them
  (redirection, `tee`, `sed -i`, `cp`/`mv`, `python -c`/`node -e` one-liners
  naming them, reusing the gitcmd tokenizer, failing closed on anything
  ambiguous that names the file). The deny reason names the four ways state
  moves: subagent JSON reports, AskUserQuestion checkpoints, `task_set`, and
  `a state update`/`a report`. A `MISSING_ACTIONS` table in
  `scripts/lib/transitions.js` maps every `missing` key the guards emit
  (`plan_path`, `reports.*`, `checkpoint`, `commits`, `landed_sha`, `deps`,
  `cap:*`) to the exact action sentence; every refusal (CLI stderr, CLI
  `--json error`, MCP tool error text, `phase.warnings` reason) appends the
  mapped sentences. `a next` returns `how: {tool, command}` per step and
  `a next` text mode / `state_prime` print it on one line under the step.
  Every agent template carries one paragraph: task files are
  machine-owned; state moves only through those four surfaces.

- **`a --help` / `-h` flag for `scripts/bin/a` (D7).** `a --help` prints
  the group list; `a <group> --help` lists subcommands; `a <group> <cmd>
  --help` prints flags (required ones marked) and one example. The help
  short-circuit fires before any argument validation or side effect, so
  `a state update --task-dir <fixture> --help` exits 0 without running the
  update. The per-command usage text and the Groups line in the usage error
  are generated from one `COMMANDS` table so they cannot drift apart.

- **`a state update --commits` and MCP `state_update` with `commits` (D34).**
  A phase that runs on the main checkout cannot reach `committed` under
  `enforcement: deny`: `persistReport` stored the committer report without
  recording commit SHAs, `a state update` had no commits flag, and `a land`
  refuses phases already on base. `a state update --phase-status committed
  --commits <sha,sha,…>` (and the MCP `state_update` `commits` array) now
  resolves each SHA to full form via `git rev-parse --verify` (refusing an
  unknown SHA), records them in `phase.commits` before the transition runs,
  and passes `gitFacts` so the `commits_recorded` guard verifies them as
  today. `persistReport` also copies a committer report's `commits[].sha`
  (or `commits[]` strings) into `phase.commits` when present; the committer
  report schema accepts an optional `sha` field per commit.

- **`committed → landed` on a phase whose branch is empty or equals base
  (D34).** The `ancestor_of_base` guard now derives `landed_sha` from the
  last recorded commit, verifies it is an ancestor of base, and records it
  — no `a land` needed (which refuses "already on base"). A real branch
  (≠ base) still requires `a land` as before.

- **`a task read --json` returns the whole `task.json` (D34).** Additive
  fields `landed_sha`, `warnings`, `conflict` on phases and `worktree_path`
  on the task are now initialized by `task create`, `state_init`,
  `state_add_phases`, and `task migrate`, and pinned by the CLI contract
  golden. PAV reads `landed_sha` through this surface (D8).

- **Phase 7 Reviewer fixes (6 issues).** (1) `a task migrate --all --apply`
  now performs the central move — enumerates repos via
  `enumerateReposWithTasks`, calls `ensureMigrated` per repo (v1→v2, move,
  live-session refusal, task lock), so `install.sh` works as the plan
  describes. (2) MCP `task_set` zod enum now includes `tier` — the knob was
  rejected before reaching the handler. (3) `a tasks ls --since` and
  `--attention` filters are now applied (previously parsed but silently
  ignored); `--since` and `--status` added to `VALUE_FLAGS` so they consume
  their values. (4) `a doctor` now verifies `permissions.additionalDirectories`
  contains `~/.agents/tasks` (D25). (5) ADR-012 amended to describe the
  central-only root model (D35/D36). (6) Tests added: `ensureMigrated` (move,
  refusal, self-exclusion, fail-closed, idempotency, enumeration),
  `closeTask` (archive/refuse/delete per tier, archive path, index.json
  disposition), `tasks-sweep` (findDoneTasks, sweep dry-run/apply, older-than
  filter), `renderIndexMd` (tier/disposition columns, done collapsed, no
  priority), `tasks doctrine` (default-tier persistence), root-file
  concurrency, `additionalDirectories` by-value idempotency.

### Fixed

- **`a cc` worktree flag and `--add-dir` passthrough (D7, D25, D35).**
  Two gaps in `scripts/bin/a` case `cc`: (1) a bare `--worktree` (no value)
  became undefined and was silently dropped, so `a cc --task <slug> --worktree`
  ran in the main checkout. A bare `--worktree` with `--task` now derives the
  name `<NNN>-<slug>` (matching `a worktree add --task`) so the WorktreeCreate
  hook binds it; without `--task` it errors `--worktree needs a name`. (2) `a
  cc` had no `--` passthrough, so a session could not receive extra claude
  flags (`--add-dir`, `--settings`). Everything after `--` is now forwarded
  to `a launch`, and `--add-dir <tasks root>` (from `a tasks root`, central
  under D35) is always added so task-file edits never prompt (D25). A flag
  in the subcommand position now routes to the group's bare case (e.g. `a cc
  --task`), and `--` is never consumed as a value-flag's value. `--json`
  output adds `worktree` and `add_dir` (additive).

- **Worktree branch stamping narrowed to non-terminal phases.**
  `a worktree add --task` recorded `phase.branch` on every phase including
  done/landed/skipped/failed ones; `a worktree remove` never cleared it. A
  stale `phase.branch` on a deleted branch then made `a land` throw a generic
  "no worktree found". `recordWorktreeInTask` now stamps only non-terminal
  phases; `remove` clears `branch`/`worktree_path` on non-landed phases that
  reference the removed branch; `a land` checks the branch exists and errors
  with `BRANCH_NOT_FOUND` naming the phase id and the fix (`a worktree add
  --task` or clearing `phase.branch`).

- **`test-lib-policy.js` no longer creates a worktree against the live repo.**
  Test 3 ran `git worktree add` with `cwd = agents checkout` and left a prunable
  entry in `.git/worktrees`. Now uses a tmp repo and removes the worktree in a
  `finally` block.

- **CHANGELOG no longer names an internal tool (D24).** The privacy-constraint
  violation is reworded to "an unrelated tool's".

- **Fast mode creates one phase (D15).** `a task create --mode fast` with no
  explicit `--phases-json` now creates phase 1 named after the title, status
  `not_started`, with knobs `review_plan: false`, `review_code: false`,
  `approve: "auto"`. Without this, the task had zero phases, `a next` returned
  `consolidate` (vacuous truth on an empty array), courier-stop was a no-op,
  and the work shipped with the task left in `planning`. `computeNext` now
  returns `blocked` with reason "task has no phases" and `how` pointing to
  `a state add-phases` when the phases array is empty — never `consolidate`.

- **Agent type case normalisation (D13).** `resolveSession` in `hook.js`
  normalises `registration.agent` to lowercase; `session.js` lowercases
  `params.agent` on both the create and update paths; `a cc`'s courier
  shorthand defaults to lowercase. The `GUARD_TABLE` keys are lowercase, so
  a capitalised "Courier" or "Conductor" in `registration.json` caused
  `guardsFor()` to return `EXTERNAL_GUARDS` for every live session — the
  per-agent git/spawn/manifest/stop guards never applied outside tests.
  Hotfix 1b96689 compared `ctx.agentType !== "conductor"` which also disabled
  conductor-stop for real Conductors; now every Stop/SubagentStop handler
  consults `guardsFor(ctx.agentType).stop` instead of an ad-hoc string check.

- **Stop hooks: `stop_hook_active` and fail-open (D13/D43).** Every Stop and
  SubagentStop handler returns success immediately when the input has
  `stop_hook_active: true`. `conductor-stop` blocks at most once per turn;
  its second evaluation passes with the reason attached as a warning via
  `additionalContext`. When `agent_type` is unresolvable (neither
  registration nor hook input), hooks fail open — `guardsFor(null)` returns
  `EXTERNAL_GUARDS` with `stop: []`.

- **Block reasons written to stderr (D43).** `blockStop` now writes the
  reason to stderr as well as to the JSON `systemMessage`, so the reason is
  visible in the terminal instead of "No stderr output".

- **courier-stop base-branch advancement (D15/D34).** For a Courier on the
  base branch (no worktree), `courierStopAdvance` walks the phase through
  `implemented → committed → landed → done` using the Courier's own HEAD
  commit, then `a task close` by tier (minor → trash per D40).

- **`closeTask` moves to trash instead of `rm` (D40).** A minor or
  standard-without-distillation task is moved to
  `~/.agents/tasks/trash/<date>/<repo-key>/<NNN-slug>/` via rename, not
  deleted. Nothing under `~/.agents/tasks` is ever `rm`'d.

### Changed

- **`state.json` retired for migrated tasks (D33).** `task.json` is the sole
  truth; `state.json` is no longer created or written by any code path.
  `a task migrate --apply` renames `state.json` → `state.json.v1` (kept, never
  read) after writing `task.json`; an unmigrated v1 dir is migrated on first
  touch by `task.loadTask` so no caller keeps a v1 branch. `state_init` and
  `task_create` write `task.json` v2 + `state.md` only. Every reader and writer
  (`state_read`, `state_add_phases`, `tasks_list`/`buildTasksIndex`, session
  lease/binding claim-renew-release, `render`, CLI `state update`/`add-phases`/
  `prime`/`task read`) goes through `task.js`. Malformed v1 `state.json` dirs
  (missing `phases`/`flags` arrays) are skipped on touch — never written or
  renamed — and surfaced with a clear error. `state_prime` returns `a next`
  JSON for all tasks (v1 text summary dropped). Stale `state.json` left beside
  an existing `task.json` (the A3 coexistence state) is renamed to
  `state.json.v1` on the next `migrate --apply`.

### Fixed

- **`postToPav` posts synchronously so PAV's bind endpoint is hit.**
  `a session register --hook` calls `process.exit(0)` immediately after
  `postToPav`, so the former async `http.request` never left the process and
  PAV's bind endpoint was never hit. `postToPav` now uses a synchronous `curl`
  call (connect timeout 1s, max 2s, never throws, no-op when `pav.port` is
  unset) so the POST completes before the process exits.

- **`a cc` registry-dir mismatch (D7).** The `cc` command computed
  `sessionDir = <root>/<terminal_id>` and passed it as `AGENTS_SESSION_DIR`
  to the tmux pane, but `register()` wrote the launcher entry to
  `<root>/<session_id>` (no pointer in cc's own env). The SessionStart hook
  then found an empty pointer dir, created a second entry with
  `origin: external`, and the `cli` entry never received `pid` or
  `transcript_path`. `register()` now accepts an explicit `session_dir`
  param and derives `<root>/<terminal_id>` when `terminal_id` is given
  without a pointer; `a cc` passes `session_dir` so the launcher entry and
  the pane pointer are the same directory. The hook matches
  `registration.session_id`, keeps `origin: cli`, and fills `pid` and
  `transcript_path` — one entry results, not two.

- **Phase 4 review fixes (5 issues from Reviewer pass 1).**
  (1) `write-guard` shell write-primitive protection restored as a global
  PreToolUse Bash hook (`install-global-hooks.js`), with the detection logic
  ported from Python to `scripts/lib/writeguard.js` and the handler in
  `scripts/lib/hook.js` consulting the D13 guard table (explorer, reviewer,
  committer). `hooks/write-guard.sh` is now a shell stub calling
  `a hook write-guard`. `a doctor` counts hooks dynamically (19, not
  hardcoded 18).
  (2) `checkpoint-capture` headless fallback implemented: when
  `CLAUDE_CODE_NON_INTERACTIVE` is set, PreToolUse opens the checkpoint then
  denies with the question as the reason, so headless runs stop cleanly (D18).
  (3) Guard exception handlers (git-guard, manifest-guard) now check the
  `enforcement` knob: under `warn`, allow and append to `phase.warnings`;
  under `deny` (default), deny with `enforcement unavailable: <err>`.
  (4) ADR-015 extended with a section noting write-guard is now part of the
  global enforcement hooks system, pointing to ADR-019.
  (5) README.md updated: enforcement hooks table, task-backed Courier
  workflow, `a doctor`, `land` knob, removed hooks, global hooks model.

### Added

- **Enforcement hooks, task knobs, task-backed Courier (Phase 4).** Everything
  the Conductor had to remember is now a globally installed hook, driven by one
  per-agent-type guard table (`scripts/lib/guards.js`). New hooks (shell stubs
  calling `a hook <name>`, logic in `scripts/lib/hook.js`): `prime`
  (UserPromptSubmit/SessionStart — injects `a next` context), `spawn-guard`
  (PreToolUse Agent — denies off-sequence spawns, rewrites the prompt),
  `report-parser` (SubagentStop — validates the JSON report, persists via
  `a report`), `checkpoint-capture` (Pre/PostToolUse AskUserQuestion — opens
  and resolves checkpoints; records a user-attributed pass for D31),
  `git-guard` (PreToolUse Bash — enforces git/gh policy by main root + agent
  type, with the D30 `AGENTS_LAND=1` allow-list read from process env only),
  `manifest-guard` (PreToolUse Edit/Write — file-scope rules), `quality-gate`
  (PostToolUse Bash + Stop — records validation exit codes, blocks stale edits),
  `conductor-stop` (Stop — blocks when no state advance), `plan-lint`
  (PostToolUse Write — lints plan files), `courier-stop` (Stop — validates
  Courier's top-level report). Failure policy (D13): unbound/missing-`a` →
  silent no-op; bound + guard exception → deny (or warn under
  `enforcement: warn`); injector exception → silent no-op. The old
  `post-edit-validate.sh`, `subagent-validate.sh`, `model-switch-logger.sh`
  are deleted; the old Python `quality-gate.sh` is replaced by the shell stub.
  `scripts/lib/gitcmd.js` tokenises git/gh commands (chained, quoted,
  env-prefix). `install.sh` registers all hooks via
  `scripts/install-global-hooks.js` (19 entries, idempotent). Per-agent
  frontmatter hooks removed from templates. `a doctor` ships as the
  hook-wiring check. **D31:** reviewer reports accept optional
  `attributed_to: "reviewer"|"user"`; `reviewer_verdict_pass` treats a
  user-attributed pass as satisfying `planned → reviewed` without flipping
  knobs. **Flag-store unification:** `a state flag`/`clear-flag` write
  `task.flags` in task.json (same store as `a land`). **Migrate renders:**
  `a task migrate --apply` renders `state.md` with a dedicated Status column
  (not folded into the Phase cell). **Knobs:** `land` joins the `task_set`
  MCP enum; knob history (`{knob, value, by, at}`) is recorded. **D32
  closeout:** task 128's `enforcement` flipped back to `deny`; the
  warn-through transitions replayed under deny pass with no new warnings.

- **Enforcement knob wired (D32).** The `enforcement: deny|warn` task knob,
  declared in `task_set` and defaulting to `deny`, is now enforced by the
  transition machine. Guards are split into evidence guards (reviewer verdict,
  checkpoint resolved, builder report, code review verdict) and artifact guards
  (plan file exists, deps done, commits recorded, ancestor of base). Under
  `warn`, a failed evidence guard lets the transition through and records
  `{guard, reason, at, session_id}` into `phase.warnings`; artifact guards
  always deny. `state.md` renders a Warnings section per phase; `a next` and
  `state_prime` surface warnings in their output. The combined
  `commits_and_code_review` guard is split into `commits_recorded` (artifact)
  and `code_review_pass` (evidence). CLI `--json` shapes are additive only.

- **Worktree hooks and `a land` (Phase 6).** Worktree creation and removal now go
  through `WorktreeCreate`/`WorktreeRemove` hooks (installed by `install.sh` into
  `~/.claude/settings.json`), so `claude --worktree`, `EnterWorktree`, and
  `isolation: worktree` all share one path. `a worktree add --task <dir>` creates a
  task-bound worktree at `../<repo>-wt-<NNN>-<slug>` on branch `wt/<NNN>-<slug>`;
  `a worktree remove <path>` refuses dirty or unlanded worktrees; `a worktree clean
  [--dry-run]` sweeps stale worktrees. The `.tasks` symlink is removed — task state
  is accessed via absolute paths and the state store. `scripts/worktree.js` is a
  deprecation stub pointing to `a worktree`. `a land --task <dir>` lands committed
  phases: fetch, rebase onto base, validate, fast-forward base (direct repos) or
  push + `gh pr create` (PR repos), record `landed_sha`, transition to `landed`.
  Conflicts are recorded as `phase.conflict` and `a next` returns
  `resolve_conflicts`; `a land --continue` resumes. Landings are serialized under
  `~/.agents/locks/<repo-key>.land.lock`. The `landed` guard checks `landed_sha`
  is an ancestor of base (not individual commit SHAs, which a rebase may rewrite).
  The `AGENTS_LAND=1` env contract signals authorized git operations to P4's
  git-guard. New `land: per_phase|at_end` knob (D14 list). `a plan lint` checks
  cross-task manifest overlap. ADR-012 amended.

- **State machine, `a next`, `a report`, and rendered `state.md` (Phase 3).**
  Task state is now managed through a validated transition table
  (`not_started → planned → reviewed → approved → in_progress → implemented →
  committed → landed → done`, plus `failed`/`skipped`) with guards that verify
  artifacts behind every status (plan file exists, reviewer verdict recorded,
  checkpoint resolved, deps done, commits exist, code review passed). The
  `task.json` v2 schema is the single source of truth for task state, with
  per-task knobs (`mode`, `review_plan`, `review_code`, `approve`, `commit`,
  `parallel`, `enforcement`), counters with caps (`review_passes ≤ 1`,
  `fix_attempts ≤ 2`, `ci_attempts ≤ 5`, `clarify_rounds ≤ 1`), checkpoints,
  and per-phase reports. `a next` computes the Conductor's next action as a
  pure function of `task.json` + git facts (step, phase_ids, agent, checkpoint,
  caps). `a report` validates and persists subagent JSON reports (schemas in
  `scripts/lib/report-schemas.json`). `a checkpoint open|resolve` writes
  checkpoints and triggers implied transitions. `state.md` is rendered from
  `task.json` on every write. `a task migrate` converts `state.json` v1 →
  `task.json` v2 in place (idempotent, preserves A2-stamped fields, maps legacy
  statuses per D29). `a plan lint` validates plan files and rejects status
  columns in `task.md`. New MCP tools: `state_next` and `task_set`. Agent
  templates (explorer, builder, reviewer, committer) now specify their
  required JSON report output. The state server identifies its session from
  `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` in its env.

- **Session registry and identity spine (ADR-018).** Every Claude Code session
  on the machine now self-registers in `~/.agents/sessions/<id>/registration.json`
  with a full identity record (schema, origin, terminal_id, session_id, task_dir,
  agent, repo_key, cwd, pid, transcript_path, tmux coordinates, timestamps).
  A single env pointer (`AGENTS_SESSION_DIR`) replaces per-id env keys. The
  SessionStart hook runs `a session register` to create/update the registration,
  claim a task ownership lease, and inject one line of `additionalContext`
  naming the bound task; UserPromptSubmit extends the lease (`a session touch`);
  SessionEnd releases the lease and marks the session exited (`a session
  unregister`). Lease reclaim keys on holder liveness (pid death), not expiry.
  Global hooks are installed by `install.sh` into `~/.claude/settings.json` with
  a consent-gated diff and a `--no-global-hooks` skip. The MCP state server now
  stamps `binding` and `last_writer` on every state write, resolving identity
  lazily per write. New `a cc` command family launches task-bound tmux sessions
  from a plain shell (`a cc`, `a cc ls`, `a cc attach`, `a cc kill`). ADR-018
  documents the full registry contract; `docs/architecture/README.md` indexes it.

- **`agents-core` library and `a` CLI.** Extracted the state-server logic into a
  plain Node library (`scripts/lib/`) with modules for repo identity (`repoKey`),
  tasks-root resolution, locking (`withLock` with stale-pid reclaim), state store
  (session-scoped temp files fixing the `.tasks.json.tmp` race), task creation
  (atomic NNN under lock), policy resolution (v2 with string-form backward compat),
  session registry (`~/.agents/sessions/`), and a launcher abstraction. Added the
  `a` CLI (`scripts/bin/a`) with `--json` output for hooks, external orchestrators,
  and humans. The MCP state server shrinks to a thin wrapper delegating to the
  library; existing tool names and schemas are unchanged. New MCP tools:
  `task_create` and `repo_policy`. CLI contract test pins every `--json` shape
  with explicit golden objects.

- **Plan summary in phase-review checkpoint.** The phase-review skill
  (`templates/skills/phase-review/SKILL.template.md`) now produces a
  plain-language plan summary — **What it does**, **Risks**, and
  **Customer-facing changes** — before its findings. The Conductor's Step 2b
  plan-approval checkpoint (`templates/agents/conductor.template.md`) presents
  this summary alongside the existing headline, attention bullets, and
  verdict, so a human can understand what the plan does without opening the
  plan file. The summary is also persisted to the plan file under
  `## Plan Review — findings` alongside the tagged findings. Test assertions
  in `tests/test-generate.sh` verify the new literals survive generation.

- **Worktree guidance in global rules.** A "Worktrees for Concurrent Work"
  section was added to `templates/instructions/global.template.md`, the
  only instruction layer that unconditionally applies to all agents in all
  repos. Every agent in every consumer repo now sees the core principle
  (use `git worktree add` for parallel workstreams, not an in-place branch)
  and a short awareness statement tying SessionStart hook context to the
  worktree decision. The action instruction ("ask the user…") is deliberately
  deferred to the per-template layer to avoid double injection.

- **Builder agent now has the worktree-heuristic SessionStart hook.** The
  Builder template (`templates/agents/builder.template.md`) previously had
  zero worktree content and no SessionStart hook. A standalone Builder
  session now receives the branch-aware worktree heuristic on startup, the
  same coverage Conductor and Explorer already had. The template also has a
  "Worktree Awareness" body section with the action instruction: ask the
  user whether to continue on an active branch or create a worktree.

- **Worktree action instructions in Conductor and Explorer templates.**
  The worktree-heuristic hook injects context, but the templates did not
  tell the agent what to do with it. The Conductor template now has an
  action instruction in the Entry Gate section; the Explorer template's
  worktree awareness line now includes the action instruction. All three
  worktree-aware agents (Conductor, Explorer, Builder) now know to ask the
  user when the hook reports an active branch.

- **Courier worktree awareness.** The worktree-heuristic SessionStart hook
  and a "Worktree Awareness" action-instruction section were added to the
  Courier template, closing the same standalone-agent gap Phase 2 fixed for
  Builder, Conductor, and Explorer. A Courier running standalone
  (`claude --agent Courier`) now receives the branch-aware heuristic and
  knows to ask about worktrees instead of creating a branch in-place.

### Deprecated

- **`state.json` (v1)** superseded by `task.json` v2 as the single source of
  truth for task state. `a task migrate` converts v1 → v2 in place
  (idempotent). Existing MCP tools that read/write `state.json` now operate
  on `task.json` with the same call shapes.

### Changed

- **Conductor first action is now `tasks_list` instead of `Glob`.** The
  Conductor's Entry Gate mandated `Glob(".tasks/*/task.md")`, which returned
  empty in worktrees (Claude Code's Glob runs ripgrep without `--follow`).
  The first action is now `mcp__state-manager__tasks_list`, and all four
  normative rules that mandated relative `.tasks/` globs are rewritten to
  use absolute paths under the `task_dir_abs` values returned by the server.

- **Conductor Step 3 always presents the PR-creation checkpoint.** The
  direct-repo auto-push fast path (policy lookup → skip checkpoint) is
  dropped; the checkpoint is unconditional until Phase 4's git-guard restores
  policy resolution.

- **Courier policy lookup keyed by main root.** The `~/.claude/repo-policies.json`
  lookup now uses `dirname "$(git rev-parse --path-format=absolute
  --git-common-dir)"` (git >= 2.31) instead of `git rev-parse --show-toplevel`,
  which returns the worktree path inside a worktree and misses the policy.

- **Worktree decisions moved to the launcher.** All agent templates and
  global rules now carry one sentence: "Where a session runs is decided by
  whoever launched it; do not create branches or worktrees unless the user
  asks." The previous worktree-decision prose that asked the LLM to judge
  concurrency is removed from Conductor, Builder, Courier, and global rules.

- **State-server `tasks_list` returns `task_dir_abs`.** Each entry now
  includes an absolute `task_dir_abs` field, derived per entry in the
  handler (`path.resolve(projectDir, entry.dir)`) so stale persisted
  indexes written before the field existed don't silently omit it.

- **ADR-017 marked Superseded.** The branch-aware worktree-heuristic hook
  is deleted; ADR-017 points to task 128 for the replacement model.

- **README, AGENTS.md, and cc-quickstart.md updated** to the launcher-decides
  model. The `~/.gitignore` recommendation changed from `.tasks/` (directory
  only) to `.tasks` (also matches symlinks).

- **Worktree heuristic hook suggestion is now repo-agnostic.** The hook
  (`hooks/worktree-heuristic.sh`) now suggests `git worktree add <path> -b
  <branch>` instead of `node scripts/worktree.js add --auto --print-path`,
  which only exists in the agents repo. The new suggestion uses the standard
  git command available in every repo. Test assertions in
  `scripts/test-worktree-heuristic.sh` now verify the hook output contains
  `git worktree add` and does not reference `worktree.js`.

- **Explorer worktree awareness line now references the universal
  `git worktree add` command.** The Explorer template previously referenced
  `npm run worktree -- add` and `a-<agent> worktree`, both of which are
  agents-repo-local. The line now uses `git worktree add <path> -b <branch>`,
  which works in any repo, and includes the action instruction for hook
  context.

### Removed

- **`worktree-heuristic.sh` SessionStart hook deleted.** The hook mutated
  checkouts (a zero-commit branch counted as merged, no fetch, dirty tree
  carried across), fired on `clear|fork`, and asked the LLM to decide about
  concurrency it cannot see. Its test script
  (`scripts/test-worktree-heuristic.sh`) and npm script
  (`test:worktree-heuristic`) are also removed. The hook registration is
  removed from all four agent templates (Conductor, Builder, Explorer,
  Courier). Worktree decisions are now made by whoever launched the session.

- **AGENTS_WORKTREE env var path.** The SessionStart worktree heuristic no
  longer checks `AGENTS_WORKTREE=1` or creates worktrees. The hook now has
  three cases only: no action on main/master, checkout-and-pull on a merged
  branch, or context injection on an active branch. Worktree creation
  remains a manual step via `npm run worktree -- add`. The test case for
  `AGENTS_WORKTREE=1` was removed from `scripts/test-worktree-heuristic.sh`.

### Fixed

- **Session registry phase-2 defects (ADR-018).** (1) `a session register
  --hook` recorded `process.ppid` — the transient hook shell, which exits
  immediately — as the session pid, so lease liveness was always "dead" and a
  second session stole a held lease. It now records `$CLAUDE_PID` (fallback
  `$PPID`), the long-lived claude process; a new hook test proves a live
  holder refuses a challenger with the holder's session id in the output.
  (2) `install.sh install` now links `scripts/bin/a` to `~/.local/bin/a`
  (`uninstall` removes it), because the global session hooks invoke `a`;
  previously only the optional `helpers` step linked it. (3) The session
  registry root honors an `AGENTS_SESSIONS_ROOT` env override, and every
  registry-writing test now uses a tmpdir root so tests never touch the real
  `~/.agents/sessions`.

- **Nested-session detection is pointer-based (D28, ADR-018).** Claude Code
  sets `CLAUDE_CODE_CHILD_SESSION=1` in the env of every subprocess it spawns
  (Bash tool shells, hooks, and MCP servers alike), even for a top-level
  session, so the guard that skipped registration when it was set caused
  **no session to ever register** — `~/.agents/sessions/` held only test
  fixtures. Removed every `CLAUDE_CODE_CHILD_SESSION` check from the hooks and
  `scripts/bin/a` (the `agent_id` skip is kept). `register()` now decides
  nested vs. top-level from the `AGENTS_SESSION_DIR` pointer: it binds
  (claims the registration and lease) when the pointer's `session_id` matches,
  or its recorded `pid` is `null`, dead, or equals `$CLAUDE_PID` (the `/clear`
  and crash-restart cases); a live, foreign recorded pid means a nested
  process, which registers under its own session id with `origin: "external"`
  and a `parent_session_id` link, leaving the parent's registration and lease
  untouched. `unregister`/`touch --hook` act only on the caller's own session
  id. `resolveSessionDir` is session-id-aware so the caller's own dir resolves
  correctly whether or not it is the pointer. Hook test fixtures now run with
  `CLAUDE_CODE_CHILD_SESSION=1` and `CLAUDECODE=1` set, and the former "child
  session is skipped" test is replaced with four pointer-based scenarios
  (top-level registers; `/clear` rebinds; nested registers separately and
  leaves the lease; dead pid rebinds).

- **Post-edit-validate hook fails open on a missing ESLint config.** `npx`
  fetches `eslint` on demand, so the existing "wrapped binary missing"
  fail-open did not cover the case where eslint runs but the repo has no
  `eslint.config.*` (this repo validates via `npm test`, not eslint). The hook
  now treats "couldn't find an eslint.config" the same as a missing binary —
  no misleading quality-gate failure is reported.

- **Global hooks consent prompt hung on a TTY.** `install-global-hooks.js`
  read the consent answer with `fs.readFileSync("/dev/stdin", "utf8")`,
  which blocks until EOF. On a TTY the user types `y` + Enter and the read
  never returns (it waits for Ctrl-D), hanging the installer. Replaced with
  `readline.createInterface` + `question()`, which reads exactly one line and
  returns; works for both TTY and piped stdin.

- **`./install.sh --force` did not skip the consent prompt.** `install.sh`
  filtered `--force` out of the args to find the subcommand but never forwarded
  it to `install-global-hooks.js`, so the JS still prompted for consent. The
  flag is now parsed into `FORCE_FLAG` and passed to the JS invocation in
  `install_global_hooks()`, so `./install.sh --force` skips the prompt and
  writes directly. The `--force` flag is documented in the usage/help text.

- **Graphify index builds took 11+ minutes.** The recommended build command
  included `--force`, which bypasses Graphify's incremental manifest gate and
  forces a full re-scan on every staleness-triggered build. Removing `--force`
  enables incremental extraction — only changed files are re-processed,
  reducing build time from minutes to seconds (3s measured on this repo vs
  11+ minutes previously). The README example config, state-server comment,
  and the user-global `~/.agents/config.json` were all updated.

- **Builder spawned with wrong model.** The Conductor template instructed the
  LLM to "use the Builder's default model (sonnet)" when `execution.model` was
  null, causing it to explicitly pass `model: sonnet` — which overrode the
  Builder's frontmatter model and resolved to the session default (GLM 5.3
  Flash) instead of the configured GLM 5.2. The template now says to omit the
  model parameter when `execution.model` is null, letting the Builder's
  frontmatter model apply. The Explorer template's execution-metadata table
  was updated to match (default `null`/omit, not `sonnet`).

- **Conductor still overriding Builder's model via execution metadata.** The
  previous fix only handled the null case — when Explorer wrote `model: sonnet`
  in a phase plan's execution metadata, the Conductor still read it from
  state.json and passed it as a `model` override when spawning Builder,
  overriding the Builder's frontmatter model. The entire `model` field is now
  removed from the execution metadata system: the Explorer no longer writes or
  documents it, the Conductor no longer reads or passes it, and an explicit
  constraint ("NEVER specify a model parameter when spawning Builder") was
  added to the Conductor's constraints. The state-server keeps the
  `execution_model` field for backward compatibility but marks it deprecated.

- **Quality-gate stop hook infinite loop.** The Stop hook blocked indefinitely
  when an agent claimed completion without running validation — the agent
  said "Done" repeatedly, the hook blocked each time, and the session never
  terminated. The hook now tracks block count per session, escalates the
  message after the 2nd block ("attempt N, you have been blocked N times"),
  and allows stop after 5 blocks as a safety valve. Also writes the block
  message to stderr so the hook runner no longer reports "Stop hook error:
  No stderr output" alongside the block.

- **Worktree launcher review fixes.** Three issues from the worktree heuristic
  review: (1) `git pull` failure in the merged-branch path no longer kills the
  script via `set -e` — `|| true` lets failures fall through to `return 0` so
  the agent launches in place; (2) the interactive prompt now checks `[ -t 0 ]`
  before reading stdin — non-TTY stdin (launcher called from a script) skips
  the prompt and launches in place instead of consuming piped input; (3) stale
  "auto-create" worktree-by-default references in the Explorer and Conductor
  agent templates replaced with branch-aware heuristic wording.

- **Session identity spine review fixes (Phase 2).** Three issues from the
  Reviewer pass: (1) `binding.pid` was inconsistent — `claimLease` stamped the
  session's claude pid, but the MCP `writeState` stamped the MCP server's own
  `process.pid`, so any MCP-driven state write overwrote the binding with the
  wrong pid. `writeState` now resolves the pid from the session registration
  (`session.find({session_id}).pid`), matching `claimLease`, and falls back to
  `process.pid` only when no registration is found. (2) CLI contract goldens
  were missing for `session touch --json` (`{touched: <boolean>}`) and
  `cc ls --json` (`{sessions: [...], tmux_sessions: [...]}`); both are now
  pinned. (3) The hook register path (`a session register --hook`) never read
  `config.lease.ttl_ms`, always using the hardcoded 2h default. It now reads
  the config value and passes it as `lease_ttl_ms` to `register`, falling back
  to the default when the key is absent.

### Changed

- **Courier research rigor.** The Courier agent now borrows Explorer's
  systematic research practices: a Principles section (Thorough > Fast,
  No Assumptions, Ground claims in evidence, Impact before action), a
  research checklist (trace flow, find patterns, map dependencies, edge
  cases, core questions), and two new Rationalization Prevention rows
  targeting confident-but-unverified claims and requirement interpretation.

- **Courier Vision delegation.** The Courier agent can now spawn the Vision
  subagent (`Task(Vision)`) to read and describe images it cannot see directly,
  matching the Conductor's capability. Courier remains a single-agent workflow
  for all code work; Vision is a read-only sensory extension, not a work
  delegation.

- **Review comment reply + resolution.** Courier and Conductor now reply to
  each PR review comment and resolve the conversation thread after addressing
  it — not just fix the code silently. Replies go through the GitHub REST API
  (`gh api .../pulls/{n}/comments` with `in_reply_to`); threads are resolved
  via the GraphQL `resolveReviewThread` mutation.

- **Task number in delivery report headers.** The Conductor's `📦 Delivered`
  and Builder's `📦 Phase [N]` / `✅ All phases complete` headers now include
  the task number (e.g., `📦 Delivered: Task 042, Phase 1 — add auth`), so
  the user can always see which task a delivery report belongs to.

- **Branch-aware worktree heuristic in a-* launchers.** The launcher no longer
  auto-creates a worktree on every launch from the main checkout. Instead
  `maybe_worktree()` inspects the current branch: on `main`/`master` it
  launches in place; on a branch fully merged to the default remote branch
  it switches to the default, pulls, and launches in place; on an active
  (non-merged) branch it asks the user interactively. A new `worktree`
  keyword (`a-<agent> [continue] [worktree]`, order-independent) forces
  worktree creation, bypassing the heuristic. Replaces the previous
  worktree-by-default behavior.

- **DRY `a-*` launchers.** The five byte-identical launcher scripts are reduced
  to thin wrappers that set `AGENT` and source a new shared core,
  `scripts/bin/_a-common.sh` (provides `current_task`, `agent_file_check`,
  `maybe_worktree`, and `launch`). The `_` prefix keeps it out of install.sh's
  `a-*` glob, so install.sh needed no change. `current_task()` now falls back
  to the main checkout's `.tasks/` when run inside a fresh worktree (which has
  none — it's untracked), mirroring the state server's
  `deriveMainWorktreeRoot()`.

- **Launcher surface: `a-<agent> [continue] [worktree]`.** The launchers are
  now interactive-only — the custom-prompt arm (`a-<agent> "prompt"`) is
  dropped. The two keywords are order-independent: `continue` auto-detects the
  most recent task in `.tasks/`, and the `worktree` keyword forces worktree
  creation.

- **Explorer/Conductor templates: worktree-aware instructions.** The templates
  now tell agents they may be launched inside a linked worktree, that `.tasks/`
  resolves to the repo's main checkout, and that their working directory is the
  worktree root.

- **cc-quickstart launcher docs.** The quickstart's launcher section documents
  the new `a-<agent> [continue] [worktree]` surface and the branch-aware
  heuristic rules.

### Added

- **`worktree.js status` subcommand.** A task-aware worktree overview that
  cross-references `git worktree list` with `.tasks/` entries, showing each
  worktree's branch, associated task (if any), and merge-state flag
  (`active` / `merged (stale)` / `-` for the main checkout).

- **`worktree.js clean` subcommand.** Removes worktrees whose branches have
  been merged (with a `--force` override), so merged-branch worktrees don't
  accumulate.

- **`worktree.js add --print-path` mode.** Prints the bare absolute worktree
  path to stdout for scripted capture (human hints go to stderr), enabling the
  launcher to consume the path programmatically.

- **`worktree.js add` auto-naming: `--task <NNN>` and `--auto`.** `--task <NNN>`
  names the branch `wt/<NNN>-<task-slug>` from the `.tasks/<NNN>-*` directory
  (`wt/<NNN>-unnamed` when absent); `--auto` derives `wt/auto-<timestamp>`.
  Both replace the `<branch>` positional and are mutually exclusive.

- **`scripts/test-worktree.js`.** Test coverage for the worktree.js helper,
  which previously had none.

- **ADR-017.** Architectural decision record for the branch-aware worktree
  launch heuristic in the `a-*` launchers.

- **Vision agent.** A multi-modal subagent that reads an image or screenshot
  and returns a text description of what it shows. Used by non-multi-modal
  parent agents (e.g., Conductor running on a text-only model) that cannot
  process images directly. The Conductor spawns Vision via `Task(Vision)`
  when it encounters a screenshot or image it needs to understand. Uses
  `sonnet` (multi-modal) by default; the parent agent can override to
  `haiku` for simpler images.

- **Per-repo push policy.** A global config file at `~/.claude/repo-policies.json`
  maps repo paths to push behavior. Repos marked `"direct"` push to main
  without creating a PR or feature branch; repos marked `"pr"` use the PR
  workflow. Repos not listed in the file trigger an ask — the agent does not
  assume either behavior. Courier checks this at step 7 (skips CI/review
  steps for direct repos); Conductor auto-selects [Just Push] at its PR
  Creation checkpoint without pausing.

- **Courier Deliberate step.** A new workflow step between Research and
  Implement: the agent considers 2-3 viable approaches, weighs tradeoffs
  (complexity, regression risk, pattern fit), and uses `AskUserQuestion`
  when two or more are genuinely viable. Proceeds autonomously when one
  approach is clearly best. Prevents the agent from committing to the
  first idea that comes to mind. Guarded by a new Rationalization
  Prevention row: "The first approach is fine."

- **Courier agent.** A new agent type for small changes that need structure
  but not the full Conductor orchestration. Invoked directly with `use
  Courier` or `claude --agent Courier`, it researches (Graphify-first),
  implements, verifies, commits, and creates a PR in one pass — no .tasks/
  directory, no subagent spawning, no checkpoint pauses. Uses Sonnet by
  default (configurable via `agents.courier.cc` override). The full
  Conductor workflow remains for multi-phase tasks; Courier is the middle
  ground between raw CC default and full orchestration. Fills best-practice
  gaps from the audit: Stop hook (`quality-gate.sh`), TDD workflow, context
  hygiene, structured delivery report, exercise-the-change table, CI fix loop
  (max 2 attempts), commit-message length/grouping rules, and an expanded
  rationalization-prevention table.

- **First-class PR creation in the Conductor flow.** Conductor Step 3 now
  pauses at a "PR Creation Ready" checkpoint (AskUserQuestion with [Create PR]
  / [Just Push] / [Skip] / [Abort]), delegates push + PR creation to the
  Committer, verifies CI via Reviewer recon, and handles CI failures via a
  Builder fix loop (max 2 attempts). The Committer gained a "PR Creation"
  section with non-interactive `GH_PROMPT_DISABLED=1 gh pr create --title
  --body-file --head --base` instructions, stdin-pipe multi-line body via
  `printf | --body-file -`, `--fill` auto-derive alternative, `gh auth status`
  / existing-PR checks, and `AskUserQuestion` as an interactive fallback.
  Templates remain company-agnostic — company-specific conventions (task
  links, body format) are delegated to a PR-creation skill via the Skill tool.

- **Test guards 70-75** in `tests/test-generate.sh`: Committer non-interactive
  `gh pr create` instruction, bare-`gh pr create` prohibition, `--body-file`
  stdin-pipe instruction (Test 72), `GH_PROMPT_DISABLED` anti-hang guard
  (Test 72b), `--fill` alternative guard (Test 72c), Conductor PR creation
  checkpoint, company-agnostic template check, and PR-skill name check. **Test
  69** updated for `Skill` + `AskUserQuestion` in the Committer tools list
  (fixes pre-existing mismatch from commit f3cad2d). Tests 28-29 (write-guard
  hook presence) removed.

- **Oracle agent.** A read-only deep-reasoning consultant subagent running on
  the Fable model (the smartest available tier). Conductor, Explorer, Builder,
  and Courier call it via `Task(Oracle)` when a problem exceeds their own
  reasoning capacity. Oracle cannot edit files, run commands, or spawn
  subagents — it receives a difficult question with context and returns a
  structured recommendation. The `fable` model tier was added to the generator's
  MODEL_TYPES registry, and the `oracle` alias in `defaults/config.json`
  resolves to `fable` via the alias chain (swappable to another tier without
  template edit). Tests 86-88 guard the alias resolution and generated
  frontmatter; Test 84 (Courier guards) allows `Task(Vision)` and `Task(Oracle)`.

### Changed

- **Builder verification depth floor.** The Conductor's Builder delegation
  prompt (Step 2c) and Builder's "Tried it" delivery-report template now
  require exercising the change per the exercise-the-change table, with unit
  tests alone not counting unless that table says skip. If the change
  genuinely cannot be exercised (e.g. instruction-only changes), the agent
  must say so explicitly. This closes a gap where Builder reported only
  passing unit tests as verification.

- **Delivery report honesty and 🟡 auto-fix.** The Conductor's Step 2d
  "What's left for you" now requires real code-path evidence for "Nothing
  left for you" (or an explicit cannot-be-exercised statement), not just
  automated checks passing. A 🟡-only Reviewer pass is auto-fixed by Builder
  (Builder fixes, re-runs every check, no re-review) before the checkpoint,
  so only 🟡 Builder could not fix reach the user. The checkpoint's
  "Also flagged:" shows the whole carried list and is omitted when the cycle
  fixed every 🟡. The fix-loop trigger now fires on any issue reaching the
  checkpoint, and the max-2 cap explicitly excludes the pre-checkpoint cycle.
  Builder template adds self-fix guidance for quality issues (naming drift,
  missing docstrings, lint/style) to prevent 🟡 surfacing in review.

- **Courier and Conductor now persist until CI is green and reviews are
  addressed.** Both agents previously gave up after 2 CI fix attempts and
  never addressed PR review comments. Courier's Verify CI step now keeps
  fixing until green (5 attempts before stopping), and a new Step 8
  (Address Reviews) checks for unresolved PR review comments and addresses
  each one before reporting done. Conductor's Step 4a (Check Reviews) and
  unified Step 5 (Fix loop — CI or reviews) cycle Builder→Committer→Reviewer
  until both CI and reviews are clear (5 attempts before pausing for user
  intervention). Rationalization Prevention entries added to both agents
  to guard against early-stop excuses.

- **`agents.<name>.cc` accepts custom model strings and aliases.** The CC
  per-agent model override now accepts any string value, not just the tier
  aliases (`opus`, `sonnet`, `haiku`) and `inherit`. A new top-level `aliases`
  map in `~/.agents/config.json` resolves short names to full model strings
  (e.g. `{"aliases": {"glm52": "ai_gateway.models.glm52[1m]"}}`), so
  `agents.builder.cc = "glm52"` emits `model: ai_gateway.models.glm52[1m]`.
  Values that are neither tier aliases nor defined aliases pass through
  verbatim as literal model strings. Tier aliases take precedence over alias
  entries with the same name. Alias chains are followed recursively (e.g.
  `plan → glm52 → ai_gateway.models.glm52[1m]`) with a depth limit
  (`MAX_ALIAS_DEPTH = 10`) as a cycle guard; a chain that exceeds the limit
  emits the original override value. Absent key → byte-identical output, so
  `defaults/config.json` and `generated/` are unchanged.

- **Conductor template simplified.** A Checkpoint Options Reference table now
  consolidates all five checkpoint option sets (Plan Review, Parallel Impl.,
  Impl. Complete, PR Creation, Session Resume) plus the plain-text Task Not
  Found checkpoint in a single scannable location, preventing the observed
  error of mixing option sets across checkpoints. The First Action Protocol
  now explicitly says "Do NOT ask the user whether to create a task — create
  it," closing the gap where the Conductor applied the resume-case "Ask the
  user" pattern to new-task creation. Project_dir guidance condensed from 18
  to 7 lines and Resume Flow from 49 to 28 lines (net -32 lines), preserving
  all six project_dir rules, all six Resume Flow steps, the emoji-to-status
  mapping, and the session-independence note. Two new Test 35 guards verify
  the checkpoint table heading and the "just create it" instruction.

### Removed

- **Write-guard PreToolUse hook (`hooks/write-guard.sh`).** The shared
  shell-write-deny hook — previously wired into the Reviewer and Committer
  agent frontmatter — has been removed entirely. The script, its unit tests
  (`tests/test-write-guard.sh`), hook registrations in agent templates,
  `install.sh` hook verification, and all template/test/doc references have
  been deleted. The Committer's prompt-level "NEVER author or edit a file
  through the shell" prohibition remains (it does not depend on the
  write-guard). The Committer's PR-creation instructions use `printf |
  --body-file -` (stdin pipe) instead of heredocs for multi-line PR body
  content, avoiding the 5-line terminal limit.

- **Skill tool access for Builder, Committer, and Reviewer subagents.**
  Added `Skill` to the `tools:` list in all three agent templates so they
  can invoke skills (e.g. `/pr:create`, `/testing`) at runtime via the
  Skill tool, instead of only receiving pre-loaded instructions via the
  `skills:` frontmatter field.

- **Persistent agent memory** for Conductor only. Conductor accumulates
  project knowledge across sessions via `memory: project` frontmatter.
  A single MEMORY.md seed file (under `templates/agents/memory/conductor/`)
  provides initial project knowledge — build commands, codebase patterns,
  review priorities, and workflow conventions — all consolidated in one
  file. Conductor curates its own memory at runtime. Memory files are
  project-scoped and personal (not shared via git). Subagents (Explorer, Builder,
  Reviewer, Committer) do not carry project memory.

- **Prompt cache TTL** (`experimental: cacheTtl: "1h"`) on Explorer,
  Builder, and Reviewer — the three most-spawned agents. Keeps prompt
  cache warm for up to 1 hour between spawns, reducing the cold-start
  token tax for frequently-spawned agents.

- **State-manager MCP tools** `memory_seed` and `memory_status` for
  project-scoped agent memory seeding. `memory_seed` copies MEMORY.md
  seed files from the AGENTS repo's `templates/agents/memory/` to the
  project's `.claude/agent-memory/` directory with create-if-not-exists
  behavior (preserves agent-curated memory). `memory_status` reports
  whether memory is seeded. Agent directories are discovered dynamically.

- **State-manager MCP tool** `workspace_init` — combined initialization
  that refreshes the code-intelligence index (same logic as
  `code_index_build`, staleness-guarded) and seeds agent memory (same
  logic as `memory_seed`, create-if-not-exists) in a single call.
  Idempotent: safe to call repeatedly with no side effects when
  everything is already up to date. The Conductor previously called
  `workspace_init` at task start and on resume; this is now handled
  automatically by the SessionStart hook (see below).

- **SessionStart hook** (`hooks/workspace-init.sh`) on the Conductor —
  fires automatically when a session begins or resumes, seeding agent
  memory files (create-if-not-exists from installed seed sources) and
  refreshing the code-intelligence index (staleness-guarded, same logic
  as `code_index_build`). The Conductor template no longer calls
  `workspace_init` manually in Step 1 or the Resume Flow — the hook
  handles both. `install.sh` now copies memory seed files to
  `~/.claude/agents/memory/` (the hook's seed source) alongside the hook
  scripts. The hook always exits 0 — it never blocks session start.

### Changed

- **Conductor action routing** — selection guidance now routes command-running ACTIONS (trigger runs, deploy, operate) to Builder, not Reviewer; Reviewer bullet narrowed to explicitly read-only recon/observation. Capabilities table Builder "Primary Use" and "Use each agent" section updated consistently. Rationalization Prevention table and Detour Recovery updated to distinguish read-only shell (Reviewer) from shell actions (Builder). Test 76 added to `tests/test-generate.sh`.
- **Explorer read-only Bash access with PreToolUse write-guard hook; Reviewer recon mode removed** — Explorer now has read-only shell access for recon (git history, log inspection, process state); `Bash` added to `cc.tools`, removed from `disallowedTools`. A new `PreToolUse` write-guard hook (`hooks/write-guard.sh`) is wired into Explorer's `cc:` frontmatter (`matcher: "Bash"`) to hard-enforce read-only shell — it denies file-write primitives (redirection, `tee`, `sed -i`, `touch`, `dd of=`, heredoc-to-file, `python -c`/`perl -e`/`node -e` writes, curl/wget download-to-file, in-place editors) while allowing read-only commands, complementing the prose constraint (defense-in-depth). Conductor selection guidance routes shell-based recon to Explorer (not Reviewer); Reviewer bullet narrowed to verification only. Reviewer template recon mode removed — Reviewer is purely verification (recon no longer routed to Reviewer; Step 3 CI status check remains as a verification task). Capabilities table updated: Explorer Terminal ❌ → ✅. "Use each agent", Rationalization Prevention, and Detour Recovery updated consistently. `install.sh` `check_hooks_scripts()` updated to verify `write-guard.sh`. Test 77 added to `tests/test-generate.sh`; `tests/test-write-guard.sh` added for hook unit tests.
- **`.gitignore`** updated to allow `.claude/settings.json` to be
  git-tracked (previously `.claude/` was entirely ignored).
  `.claude/settings.local.json` and other `.claude/` contents (including
  `.claude/agent-memory/`) remain ignored. Recommended settings
  (bashOutputMaxChars, taskOutputMaxChars, effortLevel, respectGitignore)
  are now shared via git.
- **`install.sh`** now adds `.claude/agent-memory/` to the user's global
  gitignore (alongside `.tasks/`), ensuring agent memory is never
  committed in any repo.
- **State-manager MCP** now provides `memory_seed` and `memory_status`
  tools for project-scoped agent memory seeding. `memory_seed` copies seed
  files from the AGENTS repo's `templates/agents/memory/` to the project's
  `.claude/agent-memory/` directory (create-if-not-exists, preserves
  agent-curated memory). `memory_status` checks whether memory is seeded.
  `install.sh` no longer handles memory seeding — the MCP server is the
  correct architectural home because it already resolves project root and
  handles worktree rollup.
- **`AGENTS.md`** updated to reflect that `.claude/settings.json` is now
  shared via git (previously documented as local-only).
- **Comment/docstring discipline + orchestration-transient ban**
  (`templates/instructions/global.template.md`, documentation skill,
  python/typescript/golang rules, builder/reviewer/conductor templates,
  `hooks/post-edit-validate.sh`, `hooks/write-guard.sh`, tests) — the global
  Documentation Standards now default to **no comments**: code reads by
  itself, a comment is written only when the code cannot say it, and
  docstrings appear only where the contract is non-obvious from name and
  types. Shipped code and docs must never reference orchestration-transient
  state (task numbers, phase IDs, `.tasks/` paths, session vocabulary); cite
  the durable artifact (issue, ADR, commit) instead. The documentation skill
  drops its every-code-change comment cadence and comment-encouraging
  guidance; the Reviewer stops red-flagging missing docstrings and now flags
  comment noise and transient references (with a mechanical rg sweep over
  changed code files); the Conductor's 2e doc prompt scopes docstrings to
  non-obvious contracts and drops a dead skill-load instruction. A new
  PostToolUse transient-leak check in `post-edit-validate.sh` flags the four
  narrow patterns in code files as non-blocking additionalContext, and the
  hook now fails open when an npx-wrapped validator binary is missing.
  Test 66 guards the phrases through generation; hook behavior is covered in
  `tests/test-quality-gates.sh`.
- **ADR default-skip bar** (`templates/skills/consolidate-task/SKILL.template.md`,
  `templates/agents/conductor.template.md`, `tests/test-generate.sh`) —
  consolidation now defaults to **no ADR**. Creating one requires all three
  strict criteria (cross-cutting, not derivable from code + README,
  new-or-reversing); elastic triggers are removed. The ADR format is slimmed
  (no Implementation Phases table, at most one code snippet, required
  Alternatives Considered, target 40-60 lines). The Conductor's 2e.5
  consolidation prompt now evaluates first — the default is skip — and
  "ADR skipped: [criterion]" is a first-class reported outcome. Test 65
  guards the phrases through generation. (Task 114 Phase 1; entry backfilled
  here — it was missing from the Phase 1 commit.)
- **Testing-skill adherence mechanics** (`templates/agents/builder.template.md`,
  `templates/agents/explorer.template.md`, `templates/agents/reviewer.template.md`,
  `templates/agents/conductor.template.md`, phase-review skill, `tests/test-generate.sh`) —
  the testing skill's quality bar now reaches every stage that needs it. The
  `skills:` frontmatter preloads skill content into a subagent's context at spawn;
  an instruction to "load" a skill the agent has no Skill tool for is a dead letter.
  Builder is now told the testing skill is preloaded and must apply its 5-question
  Self-Test to every test — writing the behavioral test where a planned one fails
  it (the plan's test list is a floor, not the bar). Explorer's `## Tests`
  requirement inlines a compact test-quality core (behaviors not methods, mocks
  only at boundaries, no mirror tests, failing-test-first) instead of pointing at
  a skill it cannot load. The Reviewer now preloads the testing skill
  (`skills: [critic, security-review, testing]`), its Tests checklist cites the
  Self-Test explicitly, and Step 4.5 drops the false "not preloaded / load on
  demand" framing along with the unreachable /tech-debt and /documentation rows.
  The phase-review skill flags weak planned tests (mirror methods, mocked
  internals, no behavioral assertions) as Medium findings. The Conductor's 2c
  prompt adds "tests that fail the Self-Test do not count as coverage", and its
  2a.2 plan-review prompt adds a conditional read of the phase-review skill file
  (Phase 1's 2e.5 pattern). Test 67 guards the phrases through generation.
- **Conversational and report verbosity cuts** (`templates/instructions/global.template.md`,
  builder/reviewer/committer templates, `tests/test-generate.sh`) — agents now
  answer instead of announcing. The global Communication rule replaces
  "Be concise; skip preambles" with an answer-don't-announce rule: no preamble
  blocks, no restating the plan or question back, no progress narration —
  speak when there is a decision, a blocker, or the answer. Builder's opening
  ceremony (the "Working on:" phase-status table and the "I've reviewed the
  plan" restatement block) collapses to a one-line opener naming the phase and
  its plan path. Reviewer opens with no ceremony (a one-line ask only when the
  review target is unclear), its Step 1.5 context summary is capped at two
  lines and shown only for interactive reviews (skipped when spawned by
  another agent), and its output format omits empty sections — a small change
  is Status + Issues + Recommendation, not six sections — with Status and the
  verification-audit outcome never omitted. Committer's preamble and
  commit-structure note are each one line. Evidence and verification-output
  requirements are untouched: only ceremony is cut. Test 68 guards the
  phrases through generation.
- **Agent role separation — Committer makes no edits; Conductor prefers
  Builder/Explorer and uses Committer/Reviewer only for their narrow purposes**
  (`templates/agents/committer.template.md`, `templates/agents/conductor.template.md`,
  `tests/test-generate.sh`) — the Committer loses all file-edit capabilities:
  `Edit` is removed from its `tools` and added to `disallowedTools`, the File
  Edit Constraint is rewritten to "may NOT edit any files," the task-status
  step is removed, and the write-guard hook stays as defense-in-depth. The
  Conductor's Agent Capabilities table now shows the Committer with ❌ file
  edits; its step 2f no longer tells the Committer to update `task.md` to ✅
  Done — that trivial status flip is delegated to a lightweight `model: haiku`
  Explorer spawn — and its Selection guidance states that Committer/Reviewer
  are only for their narrow purposes while Builder/Explorer are preferred for
  building and research/planning. Builder editing `.tasks/` (e.g., the 2c "🔄
  In Progress" update) is deliberately preserved. Test 69 guards the
  role-separation phrases through generation. (Task 115; Phase 1 commits
  162c136, 425b08d — entry backfilled here alongside the Phase 3 test.)

### Fixed

- **Courier Vision instruction.** Moved from the Verify section (buried inside the Exercise the Change subsection) to a dedicated `## Vision for Images` section before the workflow; changed trigger from self-referential ("any image you cannot see directly") to external ("when the user pastes or references"); added file-path guidance.

### Changed

- **Branch-aware worktree heuristic moved to SessionStart hook.** The
  heuristic now runs as a `hooks/worktree-heuristic.sh` SessionStart hook
  that fires before the agent begins reasoning, regardless of launch method
  (direct `claude --agent` or `a-*` wrapper). On an active branch it injects
  context telling the agent to ask the user; `AGENTS_WORKTREE=1` forces
  worktree creation. Replaces the launcher-based `maybe_worktree()` approach.

### Reverted

- **`a-*` launchers restored to standalone scripts.** The DRY refactor
  (`_a-common.sh` shared core, thin wrappers) and the `worktree` keyword are
  reverted. The launchers are standalone scripts with a 3-mode surface:
  `a-<agent>`, `a-<agent> continue`, `a-<agent> "prompt"`. `scripts/bin/_a-common.sh`
  is deleted.

### Added

- **`hooks/worktree-heuristic.sh`.** SessionStart hook that implements the
  branch-aware worktree heuristic. Installed to `~/.claude/hooks/` by
  `install.sh`. Referenced in the Conductor and Explorer agent frontmatter.

- **`scripts/test-worktree-heuristic.sh`.** Test script covering the four
  branch cases (main, active, merged, `AGENTS_WORKTREE=1`) plus in-worktree
  and non-git guards. Wired as `npm run test:worktree-heuristic`.

## [3.0.0] - 2026-09-10

### Removed

- **Copilot support dropped entirely.** The framework now generates Claude
  Code agents, skills, and rules only. The `copilot` generation pipeline,
  Copilot-specific model types (GPT, GPT-5.6 Terra/Sol), Copilot tier
  fallback arrays, `COPILOT-ONLY`/`CC-ONLY` body directives, and the
  `copilot:` template frontmatter section have all been removed from
  `scripts/generate.js` and all template files. The `generated/copilot/`
  directory is deleted. `install.sh` no longer installs to `~/.copilot/` or
  IntelliJ paths. `scripts/configure-vscode-settings.js` is deleted. This
  is a breaking change — users relying on Copilot output must stay on v2.x.

- **Non-Claude model types removed.** `gpt`, `gpt-terra`, `gpt-sol` model
  types and the `gptVariant()` factory are removed from `MODEL_TYPES`. The
  `agents.<name>.copilot` config key is removed. Claude Code's
  `agents.<name>.cc` override key is unaffected.

- **`COPILOT-ONLY` and `CC-ONLY` body directives removed.** Template
  bodies no longer use conditional platform directives. All body content
  is shared (there is only one platform). The `SHARED` directive is also
  removed.

- **VS Code settings auto-configuration removed.**
  `scripts/configure-vscode-settings.js` is deleted. VS Code users no
  longer get automatic `chat.agentFilesLocations` /
  `chat.instructionsFilesLocations` configuration.

- **IntelliJ support removed.** `install.sh` no longer copies global
  instructions to `~/.config/github-copilot/intellij/`.

- **`docs/sources/awesome-copilot/` removed.** External Copilot pattern
  source material is no longer included.

### Changed

- **Major version bump to 3.0.0** — reflecting the breaking change of
  dropping Copilot support.
- **`package.json` description** updated to "Agentic coding framework for
  Claude Code".
- **`Makefile` simplified** — `copilot` target removed; `all` now depends
  on `cc` only.
- **Template format retains platform sections** — the `cc:` frontmatter
  section stays as the only platform section, keeping the architecture
  extensible for a future open-source Claude Code alternative.

### Added

- **Architecture addenda** — affected ADRs (001, 005, 009, 013, 014, 015)
  now note that Copilot support was dropped in 3.0.0.

## [Unreleased]

### Added

- **PAV control interface slash commands** (`templates/skills/plan-phase/`,
  `templates/skills/build-phase/`, `templates/skills/ship/`,
  `templates/skills/session-checkpoint/`, `install.sh`) — adds four custom
  slash commands that serve as the API between PAV's web UI and the
  conductor workflow: `/plan-phase [task_slug]` finds the next unplanned
  phase from state.json and invokes Explorer to plan it; `/build-phase [N]`
  spawns Builder for a specific phase (Phase 1 quality gates fire
  automatically); `/ship` runs Committer and marks the phase done in
  state.json (user-triggered only via `disable-model-invocation: true`);
  `/session-checkpoint` generates a progress summary from state.json.
  All commands use dynamic context injection (`!`command``) to ground
  in live state, update state.json in ways PAV's scanner picks up, and
  are invocable via PAV socket steering (257 P5) or Agent SDK (257 P6).
  Still useful in terminal CC. See task `113-double-down-claude-code`
  Phase 2.
- **Autonomous quality gate hooks** (`hooks/post-edit-validate.sh`,
  `hooks/quality-gate.sh`, `hooks/model-switch-logger.sh`,
  `hooks/subagent-validate.sh`, `templates/agents/builder.template.md`,
  `templates/agents/conductor.template.md`, `install.sh`) — adds four
  lifecycle hooks with PAV-structured output: PostToolUse on Builder runs
  per-file validation (tsc, eslint, py_compile, markdownlint, Python
  json.load) after
  every Edit/Write and injects errors as additionalContext with
  `[quality-gate:FAIL]` tag-prefix format; Stop on Builder blocks
  completion (exit code 2) if files were edited but no validation evidence
  appears in the agent's final message (uses flat JSON systemMessage with
  `[quality-gate:BLOCKED]` tag); SubagentStop on Conductor validates that
  subagent output is non-empty and non-trivial (blocks via exit code 2 with
  flat JSON systemMessage and `[subagent-validate:BLOCKED]` tag);
  PreModelSwitch on Conductor logs
  model changes to stderr. Hook output uses PAV-parseable tag-prefix
  format for transcript rendering (PAV 257 Phase 8). All hooks fail open
  on malformed input. Adds test suite (`tests/test-quality-gates.sh`).
  See task `113-double-down-claude-code` Phase 1.
- **CC output-sizing, effort cap, and WebFetch deadline settings**
  (`.claude/settings.json`, `templates/instructions/global.template.md`)
  — adopts `bashOutputMaxChars: 32768` (caps Bash output at 32K),
  `taskOutputMaxChars: 16384` (caps subagent result output at 16K, targets
  the 41% dynamic-context tax from task 001-cost), `effortLevel: "high"`
  (persists high effort for supported models). Documents
  `CLAUDE_CODE_WEBFETCH_DEADLINE_MS=60000` in global instructions to
  prevent indefinite WebFetch hangs. Note: `.claude/` is gitignored, so
  these settings are not shared via git — each developer must configure
  them locally (see AGENTS.md "Recommended CC Settings"). The plan
  specified `maxEffortLevel` (a ceiling per CC changelog v2.1.267), but
  the current CC settings schema does not recognize that field; used
  `effortLevel` instead, which may override per-agent `effort:` frontmatter.
  If Conductor runs at higher effort than expected, remove this setting.
  See task `113-double-down-claude-code` Phase 1.
- **`scripts/configure-graphify-mcp.js`** — a repo-owned tool that registers
  Graphify as a **workspace-folder-scope** MCP server in
  `<repo>/.vscode/mcp.json` and refreshes that repo's Graphify index in the same
  run. VS Code spawns *user-scope* stdio MCP servers with `cwd = os.homedir()`,
  so every argument-free Graphify call from a Copilot session resolved
  `$HOME/graphify-out/graph.json` and failed; workspace scope is the only scope
  that supplies the workspace folder as the spawn's cwd. Writes are insert-only
  and comment-preserving (JSONC token scan + string splice, never a
  `JSON.stringify` round-trip); an existing `graphifyy` entry is never modified.
  Refuses on `$HOME`, a filesystem root, or outside a git repo. Run it by path
  from inside the target repo; `install.sh` is unchanged.
- **`agents.<name>.cc` per-agent model override** (`scripts/generate.js`) — the
  Claude Code mirror of the existing `agents.<name>.copilot` key, reserved by
  ADR-009 and now honored. Accepts the Claude tier aliases (`opus`, `sonnet`,
  `haiku`) plus Claude Code's `inherit` sentinel, and nothing else — enforced
  through the previously-declared-but-unread `MODEL_TYPES[...].platforms` field;
  an override to a Copilot-only or unknown type warns and leaves the template's
  tier in place. `inherit` is Claude-Code-only and is rejected as a `copilot`
  value. Absent key → byte-identical output, so `defaults/config.json` and
  `generated/` are unchanged.
- **`mcpServers.graphify` guidance profile** (`defaults/config.json`) — a
  guidance-only `{{MCP_GUIDANCE}}` profile (no `grant` key, so it changes no
  tool permissions) that renders a "prefer Graphify" bullet ahead of LSP for
  explorer/builder/reviewer/researcher, resolving the conflict between
  `~/.claude/CLAUDE.md` (Graphify first) and the agent templates (LSP first).
- **Opt-in Fast Path workflow mode** (`conductor.template.md`) — explicit
  request only ("just do it", "auto-pilot"), recorded in task.md frontmatter,
  never inferred. Nothing in the pipeline is skipped; only the per-phase
  pauses collapse to one approval up front and one delivery report at the end.
  One carve-out: a `BLOCKING` plan-review verdict **stops for the human even under Fast Path**.

- **Compound engineering loop — execution friction becomes an instruction delta**
  (builder template, `consolidate-task` skill, conductor/explorer templates,
  `AGENTS.md`). Builder records real friction as one-liners under `##
  Execution Notes` in the phase plan while it happens (`[what happened] →
  [what would have prevented it]`); a clean phase writes nothing.
  `consolidate-task` reads those notes at task end and proposes at most three
  instruction changes, each citing the note it came from, routed by scope —
  repo convention to `AGENTS.md` `## Learned Patterns`, terminology to
  `CONTEXT.md`, agent/skill behavior to the owning instruction file
  (`templates/` here), framework posture to `docs/research/BACKLOG.md`.
  Nothing is written without confirmation; no notes means "no process
  learnings" and stop, never a reconstructed retrospective.
- **`## Learned Patterns` section in `AGENTS.md`** — the sink Explorer and
  `phase-review` already referenced but which did not exist in this repo.
- **RDR-035** (`docs/research/RDR-035-agentic-engineering-patterns.md`) — records the
  agentic-manual-testing and compound-engineering-loop adoption from Simon Willison's
  guide as Partially Adopted. `framework-comparison.md` gains the anti-scaffolding
  tension (plan files, `AGENTS.md`, specialist subagents — conceded for attended,
  single-session work; kept for AGENTS' unattended/multi-session case).
  `prevailing-wisdom.md` §8 gains the canonical specialist-agent criterion: "a
  specialist earns its place only if it preserves root context or produces
  verification evidence."

### Changed

- Explorer closes a phase-plan return with a plain-language headline and a
  `Worth your attention:` block held to architecture/tech-debt/risk/UX, so the plan
  checkpoint is readable without opening the plan.
- `phase-review` (Mode 1) now persists its full tagged findings to the reviewed phase
  plan under `## Plan Review — findings`, narrowing — not lifting — its write ban.
- Conductor's two checkpoints are plain prose. Step 2b gains a format it never had —
  Explorer's headline, its `Worth your attention:` bullets, the verdict with a count of
  the Medium/Low findings already recorded in the phase plan, and the plan path. Step 2d
  keeps its three fields and drops the quoting framing. Block quotes, italics-as-quoting
  and `(verbatim)` labels are gone; the guarantee they stood for is restated as
  **selection, not generation** — Conductor may drop a subagent's sentences, never
  rewrite one, never add one the subagent did not write.
- High plan-review findings and 🔴 review issues never collapse at a checkpoint; Medium
  and Low collapse to a count plus the plan path that now holds them. 🟡 issues still
  surface in full — Reviewer is write-locked, so a collapsed 🟡 would be a lost one, and
  they are what the [Fix Issues] / [Commit Anyway] choice turns on.
- **`consolidate-task` widened from ADR-only to two outputs** — the
  architectural record for future developers and the process-learnings
  instruction delta for future agents, from the same pass. Triggers now
  include 'retrospective', 'what did we learn', 'compound learnings'.
  Conductor's 2e.5 subagent prompt asks for both and its return contract adds
  "process learnings: N proposals, or none"; under Fast Path Mode proposals
  are deferred unapplied to the final Delivery Report instead of pausing
  mid-run.
- **Navigation order in the four Tool Preference blocks** (builder, explorer,
  researcher, reviewer templates) is now Graphify → LSP → `Grep`/`Glob`,
  config-injected via `{{MCP_GUIDANCE}}` rather than hardcoded, matching
  `~/.claude/CLAUDE.md`'s override.
- **Agentic manual testing — Builder exercises the change, Reviewer audits it**
  (builder/reviewer/conductor/explorer templates, `testing` skill). Builder's
  "do NOT execute manual steps" prohibition is reversed: it now runs the changed
  code, pastes the real command and output, fixes findings with red/green TDD,
  and persists the evidence to the phase plan's `## Verification Evidence`. The
  delivery report's `Try it:` field becomes **`Tried it:`** — what the agent
  actually ran and observed, then how a human can repeat it. Reviewer no longer
  performs first-pass functional verification; it audits Builder's evidence and
  re-runs only what is missing, implausible, or contradicted by the diff.
  Explorer's Demo Statement and manual verification steps must now be
  agent-executable or explicitly flagged as human-only.
- **Explorer taught no-Bash recon** (`explorer.template.md`) — the no-shell
  prohibition now also covers obtaining a shell by delegation, and a new
  CC-only recipe explains getting file lists/counts via `Glob`/`Grep
  output_mode: count` instead of `git ls-files`/`wc`.
- **Conductor's comms are succinct by default** — it quotes subagent output
  instead of re-summarizing it, at every surface (checkpoints, status
  summaries, phase announcements). The delivery report is now **three things**
  — what changed (user impact, high level), what the agent tried and observed,
  and what's left for the user — quoted from Builder's own report. Satellite
  questions (open clarifications, resume
  flags/continue) now ride inside the nearest mandatory checkpoint instead of
  taking their own round trip.
- **Plan review is capped at one pass per phase plan** (`conductor.template.md`,
  `explorer.template.md`, `phase-review` skill) — the review spawns exactly once;
  its findings are tagged High/Medium/Low against objective criteria and the
  verdict is computed from the tags (one or more High → `BLOCKING`, always), not
  left to the reviewing agent's discretion. On `APPROVED`/`APPROVED WITH
  SUGGESTIONS` the phase is marked reviewed; on `BLOCKING` Conductor escalates to
  the human verbatim instead of re-reviewing. Plan Only mode now plans one phase
  per request instead of rolling on into the backlog. Justified by directly
  measured waste (a 4-pass review cascade costing 23.7 min / 114,707 tokens, and
  a fully-planned-but-unbuilt phase costing 50.4 min / 218,850 tokens), not by
  any model-leniency argument.
- **Reviewer's findings are now tagged 🔴/🟡 against objective criteria rather than confidence bands; Conductor skips the *fix's* re-review when pass 1 raised no 🔴** — auto-applied, overridable with "review this properly" (phase-scoped), untagged issues counting as 🔴. Evidence: 11 of 13 re-reviews clean, both exceptions followed a 🔴. The first review pass on every phase is unchanged.
- **The `[Fix] [Skip] [Abort]` question folds into the Phase Implemented checkpoint** as `[Fix Issues]` / `[Commit Anyway]` / `[Abort]`; the max-2 fix-attempt cap and its error escalation are unchanged. This half is a preference for fewer gates, not a measured change.
- **Reviewer is now this system's read-only shell, with recon as an explicitly-labelled mode.** ~30% of Reviewer invocations were not reviews; of that, ~23% (54/231) genuinely need a shell and now get a reduced, ceremony-free recon protocol instead of a full review — a cost reduction, not an elimination. The remaining ~7% (16/231) that Conductor/Explorer could do without a shell is *not* the justification for this change, and is the same order as the deferred Rec 6 (8.0%). **This is a volume count and the saving is unquantified.** Conductor's Selection guidance routes a shell-needing question to Reviewer prompted with `Recon (not a review):`, and a `.tasks/`-answerable question to itself; Detour Recovery's "address it" now follows this rule. Conductor's own recon ceiling is stated (`.tasks/` only) and **no permission was widened**. The Explorer-shell-by-delegation isolation fix **remains deferred**.
- **The planned `{{PARTIAL:}}` shared-template mechanism is dropped, not shipped.** Re-measurement found only 48 of 2,633 `templates/agents/` lines (1.8%) are genuinely duplicated, not the ~11% originally estimated; and because the mechanism's own correctness guard requires generated output to stay byte-identical, it would have had **no token or latency effect** — maintainability only, and not worth ~60 new lines of generator code plus 4 tests to dedupe 48 lines. `tests/test-generate.sh` gains a drift-guard test instead (asserting the Tool Preference: Code Navigation block stays byte-identical across builder/explorer/reviewer/researcher) — this addresses the real, measured pain (Phase 6 had to edit that 4-way block twice) without building the include mechanism. **This entry describes a maintainability guard, not a performance change.**
- **Code-navigation guidance is now imperative, code-scoped and fully config-driven**
  (`defaults/config.json`). The `mcpServers` guidance bullet instructs the agent to reach
  for the code graph **first on any code-structure question** — with `file:line`
  citability stated, so a citation requirement is no longer a reason to `Grep` — instead
  of describing a preference; markdown, config and already-handed paths stay out of
  scope. Because a code-graph server reports no staleness of its own, the convention now
  says to run `code_index_build` first **if the agent holds it** (it no-ops when fresh),
  and `agentTools.cc` grants it to **explorer** as well as builder. The instruction lives
  only in config, so a user with no `mcpServers` profile gets no code-index prose at all:
  `templates/agents/explorer.template.md` loses its hardcoded staleness step — the last
  vendor name in `templates/` — and gains one vendor-neutral clause stating that
  refreshing an index is not a codebase write.

### Removed

- **From the delivery report:** the file list, the automated Verification
  Report table, and the `Capabilities` section. Automated checks are **still
  run in full**; passing checks are no longer presented as evidence to the
  user, and a failing check now blocks delivery with the error quoted. Also
  removed: the `[Verify]` second-confirmation gate (its runbook is now shown
  up front in the delivery report) and Step 2a.3 as a standalone step (folded
  into the plan-approval checkpoint).

### Fixed

- **`state-manager` MCP now warns, in the tool's returned text, when an explicit
  `project_dir` is not inside a git repository while `CLAUDE_PROJECT_DIR` is** —
  previously `code_index_status` returned a confident `missing`/`fresh`/`stale`
  answer for whatever path it was given, with no indication that the argument
  looked implausible; `tasks_list` gets the same warning as a JSON field
  (its payload is machine-readable). Resolution itself is unchanged — an
  explicit `project_dir` still wins, and the warning never fires from
  `process.cwd()`. The ten identical `project_dir` schema descriptions
  ("Required when CLAUDE_PROJECT_DIR env var is not set") are reworded to stop
  implying the argument is mandatory — the likely teacher of a hallucinated
  path. See task `108-graphify-usage-telemetry` Phase 12, Finding R12.
- **Phantom `getDiagnostics` removed** from the Tool Preference block in
  builder, explorer, researcher and reviewer templates — no CC or Copilot
  tool surface exposes `getDiagnostics`, `goToDefinition` or `findReferences`
  by those names.
- **`reviewer.template.md` heading nesting** — `## Process Steps` now
  correctly parents all seven `### Step N` subsections; it had been
  displaced after `## Rationalization Prevention`.
- **The Builder prompt no longer points at a "Step 2d template"** Builder
  cannot see, and the delivery report no longer asks for a "Capabilities"
  field Builder never emits.
- **Conductor's task-discovery glob no longer matches files instead of directories.**
  The Entry Gate and Step 1c's task-lookup patterns used a bare `.tasks/*`-style
  glob, which returns files (e.g. stray `.DS_Store`), never a task directory, so it
  could never discover a task — the defect behind commit `b31c250`, where another
  task's uncommitted work folded into this task's commit because Conductor was
  blind to 21 sibling task directories. Fixed to the directory-aware
  `.tasks/*/task.md`. Step 1c's broken example had also leaked a Claude-Code-only
  tool name into the generated Copilot conductor, which has no such tool; reworded
  platform-neutrally.
- **`README.md`'s File Structure block said `7 agent templates`; there are 6**
  (builder, committer, conductor, explorer, researcher, reviewer) — corrected.
- **`{{MCP_GUIDANCE}}` was undocumented in `templates/README.md`** — a gap left
  when the substitution was added. New `## Body Substitution: {{MCP_GUIDANCE}}`
  section covers the token, its per-agent bullet rendering, and expansion order
  relative to the platform directives.
- **`install.sh`'s summary counts (Copilot agents/skills/instructions, Claude
  Code agents/skills/rules) were inflated by files other tools or the user
  write into the shared destination directories** — each count was a blind
  `find` over `~/.copilot/{agents,skills,instructions}` or
  `~/.claude/{agents,skills,rules}`, so any unrelated file (e.g. an unrelated tool's
  `*.instructions.md`, or the user's own `~/.claude/rules/*.md`) was counted
  as if this framework had installed it (`make` reported 5 generated;
  `install.sh` reported 6). All six counts are now read from the run's own
  freshly generated `tmp_dir`, captured immediately after the corresponding
  `copy_tree` calls (decoupling the counts from `tmp_dir`'s cleanup at the end
  of the function), matching what this install actually copied.

- **Git-auto-derived shared `.tasks/` across worktrees** — the state server's
  `resolveProjectDir` now rolls a candidate directory up to its repo's **main
  worktree root** (via `git rev-parse --path-format=absolute --git-common-dir`),
  so every `git worktree` of a repo shares ONE `tasks.json` dashboard with no env
  var or manual pinning. A primary/non-worktree checkout resolves byte-for-byte as
  before; different repos keep their own `.tasks/`. Derivation never throws (falls
  back to the candidate on no-git/old-git/bare/parse-failure) and logs a
  **one-time stderr hint** for the
  old-git (< 2.31) / missing-git / parse-failure cases. Locale-hardened
  (`LC_ALL=LANG=C`) so the "not a git repository" classification is
  locale-independent. See ADR-012.
- **`scripts/worktree.js` git-worktree helper** — `npm run worktree -- <add|open|
  merge|remove|list>` to create/open/merge-back/remove worktrees; prints Claude
  Code / VS Code launch instructions and notes the auto-shared `.tasks/`.
- **Agent-managed code-index lifecycle** — two new `state-manager` MCP tools,
  `code_index_status` (read-only: `not_configured`/`missing`/`stale`/`fresh`)
  and `code_index_build` (runs a user-configured build command, guarded by the
  staleness check), keep a repo's code-intelligence index (e.g. Graphify's
  `graphify-out/graph.json`) current without manual extraction runs. The build
  command lives only in user-global `~/.agents/config.json` (or
  `$AGENTS_CONFIG_PATH`) — read-only from `JSON.parse`, no new dependency —
  never from the target repo, so an untrusted repo cannot inject a command.
  Staleness compares the newest mtime among `git ls-files`-tracked code files
  (gitignore-respected, extension-filtered) against the index file's mtime.
  Conductor now calls `code_index_build` at task start (and on resume);
  Builder calls it after each phase's verification passes; Explorer calls the
  read-only `code_index_status` at research start and flags a stale/missing
  index in its output. New `agentTools`/`defaultTools` grants in
  `defaults/config.json` give Explorer/Researcher/Reviewer/Builder the
  Graphify query tools (`mcp__graphifyy__*` / `graphifyy/*`) and give Builder
  the build tool; Conductor already held `mcp__state-manager__*`. See task
  `099-graphify-index-lifecycle`.

### Security

- **`code_index_build` refuses to run the configured build command when the
  resolved project root is the home directory, a filesystem root, or outside
  any git repository** — a hallucinated `project_dir` (e.g. `$HOME`) could
  previously reach `execSync(config.build, { cwd: projectDir })` for real,
  since the pre-existing staleness guard only skips a `"fresh"` index and a
  missing `graph_file` falls straight through. Home/filesystem-root are
  matched by directory identity (`stat` dev+ino), not string equality, so a
  case-differing or symlinked alias cannot bypass the guard. Environments
  without git (or with git < 2.31) are unaffected — repo-membership is
  fail-open on "unknown". See task `108-graphify-usage-telemetry` Phase 12,
  Finding R12.
- **Reviewer prompt hardening against Bash write-bypass** — the Reviewer agent
  definition (`templates/agents/reviewer.template.md`) now explicitly prohibits
  creating, writing, or modifying any file by ANY means, closing the gap where
  Reviewer retains `Bash` (needed for tests/lint) despite `disallowedTools:
  [Edit, Write]`. Names the FOCUSED deny set (`>`/`>>` redirection, `tee`,
  file-writing heredocs, `sed -i`, `python -c`/`perl -e`/`node -e` writes,
  `touch`, `dd`, `vi`/`vim`/`nvim`/`nano`/`ed`/`ex`) and requires Reviewer to
  STOP and report a finding instead of authoring ad-hoc verification scripts.
  Shared template body reaches both the Claude Code and Copilot variants. This
  is Phase 1 (soft control / defense-in-depth) of a hard `PreToolUse` hook
  enforcement planned in follow-up phases. See task
  `100-reviewer-write-lockdown`.
- **Reviewer `PreToolUse` Bash write-guard (Claude Code hard control)** — a new
  `hooks/reviewer-write-guard.sh` (Python) is installed to
  `~/.claude/hooks/` and wired into the Reviewer agent's `cc:` frontmatter
  (`templates/agents/reviewer.template.md`) via a subagent-scoped
  `hooks: PreToolUse` block on the `Bash` tool, so it fires ONLY for the
  Reviewer — Builder/Committer Bash writes are unaffected. The hook
  quote-aware-scans `tool_input.command` and denies file-write primitives
  (redirection, `tee`, `sed -i`/`perl -i`, heredocs, `touch`, `dd of=`,
  in-place/interactive editors, awk internal `>`, `curl`/`wget`
  download-to-file) while allowing `/dev/null`/fd redirects, `<<<`
  here-strings, and quoted operator text (`grep 'a > b' file`); it also
  recursively unwraps nested shell/interpreter wrappers (`bash -c`, `sh -c`,
  `xargs ... sh -c`, `find -exec sh -c`, `python3 -c`/`perl -e`/`node -e`) so a
  write hidden inside one of those is still caught. Denials return a coaching
  `permissionDecisionReason` telling the Reviewer not to retry another write
  method and to verify via existing commands/tests or report a finding — this
  pairs with the Phase 1 prompt prohibition. The script is host-agnostic
  (keys off `tool_input.command`, not `tool_name`) so it is shared unmodified
  by the planned Copilot hook (Phase 3). `install.sh` now ships and
  chmods the script via the existing `copy_tree` manifest machinery. This is
  Phase 2 of task `100-reviewer-write-lockdown`.
- **Reviewer write-guard: 4 adversarial-audit false-negative bypasses closed**
  — a Reviewer security audit of the Phase 2 guard found 4 exploitable
  bypasses; all fixed with regression tests in `hooks/reviewer-write-guard.sh`
  / `tests/test-reviewer-guard.sh`: (1) backslash-escaped command names
  (`t\ee`, `to\uch`, `s\ed -i`, `v\i`) previously slipped past word-boundary
  matching because quote-masking destroyed the token — command-NAME/flag
  matching now runs against a de-escaped token stream
  (`mask_quotes_deescape`) while redirection-operator matching keeps true
  quote/escape state; (2) `$(...)`/backtick command substitution inside
  double quotes (bash evaluates it there; only single quotes suppress it) is
  now extracted and recursively re-scanned regardless of surrounding
  quoting; (3) bundled short curl/wget download flags (`-sO`, `-Lo`, `-qO`)
  are now detected, not just standalone `-o`/`-O`/`--output`; (4)
  `python3 -c` interpreter-write scanning now also catches the
  `subprocess.run(['touch', 'f'])`/`subprocess.call([...])` list-argv form,
  not just the quoted-string first-arg form. No prior behavior regressed
  (147 assertions passing, up from 104).
- **Reviewer write-guard: bounded final fix pass (`eval` wrapper + curl/wget
  scoping)** — two more gaps closed in `hooks/reviewer-write-guard.sh` /
  `tests/test-reviewer-guard.sh`: (1) `eval` is now a recognized unwrap-able
  wrapper (same treatment as `bash -c`/`sh -c`, since bash executes `eval`'s
  argument as shell code) — `eval "touch f"`, `eval 'echo x > f'`, and
  `eval 'sed -i s/a/b/ f'` now correctly DENY, while a read-only
  `eval "grep x file"` still ALLOWs; (2) curl/wget download-flag detection is
  now scoped to only the pipeline segment(s) whose OWN first word is
  curl/wget (split on `|`/`;`/`&&`/`||`/newlines), fixing a false-positive
  regression where an unrelated downstream `-o` denied read-only pipelines
  like `curl https://x | sort -o file`, `curl https://x | grep -o result`, and
  `echo curl-report && ls -o file`. Three exotic bypass classes — ANSI-C
  quoting (`$'touch' f`), backslash-newline line-continuation splitting a
  command name, and `printf -v x "touch f"; $x` variable-indirection — are
  explicitly documented (guard script docstring + Phase 2 plan's Known
  limitations) as accepted residual risk rather than fixed: they require an
  agent to deliberately evade its own guard via non-obvious shell quoting,
  outside the cooperative-but-overeager threat model this hook targets; the
  Phase 1 prompt prohibition and this hook's coaching deny message remain the
  named backstop. 160 assertions passing, up from 147.
- **Reviewer `PreToolUse` write-guard (VS Code Copilot hard control)** — the
  same `hooks/reviewer-write-guard.sh` used for Claude Code is now also wired
  into the Reviewer agent's `copilot:` frontmatter
  (`templates/agents/reviewer.template.md`) via a `hooks: PreToolUse` block,
  scoped to the Reviewer agent only (Builder/Committer Copilot agents are
  unaffected). No script changes were needed — VS Code Copilot's `PreToolUse`
  deny contract uses the same nested `hookSpecificOutput.permissionDecision`
  shape and reads the command from `tool_input.command`, same as Claude Code.
  This hook only fires if the user has enabled the relevant VS Code Preview
  hooks setting (the exact setting name has varied across builds — see
  README.md) in a trusted workspace; the Copilot CLI has no per-agent hooks
  mechanism and remains prompt-only (Phase 1). This is Phase 3 of task
  `100-reviewer-write-lockdown`.
- **Committer prompt hardening: mandate the `Edit` tool, forbid shell
  file-writes** — the Committer agent definition
  (`templates/agents/committer.template.md`) now explicitly mandates using the
  `Edit` tool for every file modification, including the `task.md`
  phase-status update, and forbids authoring or editing any file through the
  shell (redirection, `tee`, file-writing heredocs, `sed -i`/`perl -i`, `awk`
  with an internal `>`/`>>`, `touch`, `dd of=`,
  `vi`/`vim`/`nvim`/`nano`/`ed`/`ex`) — while still allowing plain reads,
  non-in-place `sed`/`awk`, pipes, and all `git` operations. This is Phase 4
  (soft control) of task `100-reviewer-write-lockdown`'s Committer scope
  expansion; a paired hard `PreToolUse` hook is planned in Phase 6.
- **Write-guard generalized to a shared, agent-aware hook (+ renamed)** — the
  Reviewer-only `hooks/reviewer-write-guard.sh` is now `hooks/write-guard.sh`,
  a shared PreToolUse guard any agent's frontmatter can wire in. The
  `permissionDecisionReason` coaching message is now selected per agent: the
  Reviewer keeps its existing "don't attempt another write method, report a
  finding" message; a new Committer message says "use the `Edit` tool to
  modify files ... do NOT author/edit files through the shell"; any other/
  unknown agent gets a generic default. The agent id is resolved from the
  hook `command` string's positional argv (primary — e.g.
  `write-guard.sh reviewer`) with a stdin `agent_type` fallback for hosts/
  wiring that omit the argv; argv wins if both are present. The Reviewer's
  `cc:`/`copilot:` frontmatter hooks in `templates/agents/reviewer.template.md`
  now pass the `reviewer` argv. **The deny/allow policy — including the
  `2>/dev/null` and redirection-allow logic — is byte-for-byte unchanged**;
  only the coaching message and the agent-identity plumbing are new. This is
  Phase 5 of task `100-reviewer-write-lockdown`; it does not yet wire the
  guard into the Committer (Phase 6).
- **Committer `PreToolUse` write-guard hard control (Claude Code + VS Code
  Copilot)** — the shared `hooks/write-guard.sh` guard is now also wired into
  the Committer agent's `cc:` frontmatter (Claude Code, `matcher: "Bash"`) and
  `copilot:` frontmatter (VS Code Copilot, matcher-less — VS Code's terminal
  tool is `runTerminalCommand`, not `Bash`, so a matcher risks the hook never
  firing; the script's own self-guard keeps it inert for non-command tool
  calls), both passing the `committer` argv so the Committer's "use the `Edit`
  tool" coaching message fires. `git add`/`git commit` and the `Edit` tool are
  unaffected — only shell write-primitives are denied, forcing the Committer
  onto the sanctioned `Edit`-tool path (pairs with the Phase 4 prompt
  hardening). As with the Reviewer's Phase 3 hook, the VS Code Copilot side
  only fires if the user has enabled the relevant VS Code Preview hooks
  setting (exact name varies by build — see README.md) in a trusted
  workspace; the Copilot CLI has no per-agent hooks mechanism and remains
  prompt-only (Phase 4). Builder and Explorer are unaffected — the hook
  simply does not exist in their agent definitions. This is Phase 6 (final)
  of task `100-reviewer-write-lockdown`.

### Changed

- **Committer "repo root" → "worktree root (cwd)"** — the committer command rule
  now instructs running git commands from your worktree root (your current working
  directory); under `git worktree` this is the worktree, not the main checkout.
- **Copilot model names drop the `(copilot)` suffix** — the Copilot model
  picker now shows clean names (e.g. `Claude Opus 4.6`, `GPT-5.6 Sol`) instead
  of `Claude Opus 4.6 (copilot)`. Removed the `copilotSuffix` field from the
  `MODEL_TYPES` registry and `gptVariant()` factory in `scripts/generate.js`;
  Claude Code output is unaffected (it never carried the suffix).
- **Agents are now prohibited from suppressing stderr or masking exit codes**
  in commands they run — no `2>/dev/null`, no `>/dev/null 2>&1`, no `|| true`
  to hide a failure. Added to `templates/instructions/terminal.template.md`
  (canonical rule) and `templates/instructions/global.template.md` (Inviolable
  Rule 4, the only artifact IntelliJ receives). Suppression hides the error the
  agent needed to read, and a redirected command line falls outside VS Code's
  terminal auto-approve allow-list, costing a manual approval each time. The
  rule covers commands agents *run*, not scripts/Makefiles they author (the
  makefile skill's recipes are unaffected); command **chaining** is
  deliberately not prohibited. The Reviewer's `/dev/null`-is-allowed clause was
  reworded to cross-reference this rule instead of reading as a blanket
  blessing of `2>/dev/null`; the write-guard hook's behavior is unchanged. See
  task `103-no-stderr-suppression`.

### Fixed

- **state_update crash on malformed/foreign state.json** — a `state.json`
  anywhere under `.tasks/` that parsed as valid JSON but was missing required
  `phases` or `flags` arrays caused `buildTasksIndex` to throw
  `Cannot read properties of undefined (reading 'length')`, silently breaking
  every write tool (`state_update`, `state_flag`, `state_clear_flag`,
  `state_init`) for all tasks. `buildTasksIndex` now skips malformed siblings
  with a stderr warning; `readState` now throws a clear, named error instead
  of propagating the cryptic TypeError.

- **CC Conductor tools allowlist includes state-manager MCP tools** — added
  `"mcp__state-manager__*"` to the `cc.tools` block in
  `templates/agents/conductor.template.md` and regenerated
  `generated/claude/agents/conductor.md`. The Conductor's `tools:` allowlist
  previously omitted every `mcp__state-manager__*` tool, silently blocking all
  seven state-manager calls (`state_init`, `state_update`, `state_read`,
  `state_prime`, `state_flag`, `state_clear_flag`, `tasks_list`) despite the
  MCP server being healthy. Mirrors the existing `"state-manager/*"` grant
  already present in `copilot.tools`.

- **`migrate-config.js` now backfills nested keys, not just top-level ones**
  — the merge previously only checked `if (!(key in config))` at the
  top level, so once a user's `~/.agents/config.json` already had a
  top-level key (e.g. `agentTools`, `defaultTools` — true for anyone who ever
  ran `install.sh` before a given feature shipped), any NEW keys nested
  underneath that key (like the code-index-lifecycle tool grants added in
  task `099-graphify-index-lifecycle`) were silently never backfilled on
  upgrade. The merge now recurses into plain-object values so a nested key
  absent at any depth is copied from `defaults/config.json`, while a key the
  user has already set — object, array, or scalar — is never overwritten.
  Arrays follow a documented policy: a non-empty user array always wins
  as-is; an empty (or absent) array is treated as "not yet configured" and
  backfilled from defaults. Reported added-key paths are now dot-notation
  (e.g. `agentTools.cc.explorer`) so `install.sh`'s "Added `<field>` field to
  config" messages point at the exact nested key. Existing top-level-only
  migration behavior (whole-key backfill, idempotent re-install, no
  overwrite of customized values) is unchanged and covered by the existing
  `tests/test-install.sh` round-trip tests; new nested-merge/array-policy
  coverage added in `tests/test-migrate-config.sh`.

- **`migrate-config.js` prototype-pollution guard** — `"__proto__" in {}` is
  always `true` (inherited accessor), so a `defaults/config.json` object keyed
  `"__proto__"` under a target key the user's config lacked its own copy of
  made the merge read the *real* `Object.prototype` via the getter, pass the
  plain-object check, and recurse into it, letting a crafted defaults file
  mutate `Object.prototype` for the whole process. `mergeMissing` now skips
  `__proto__`, `constructor`, and `prototype` keys outright and uses
  `Object.prototype.hasOwnProperty.call(...)` instead of the `in` operator for
  presence checks. Regression coverage in `tests/test-migrate-config.sh`
  verifies `Object.prototype` stays clean for all three key names.

### Added

- **`state_add_phases` MCP tool** (`scripts/state-server.js`, 8th state-server
  tool) — appends one or more new phases to an existing `state.json` with
  whole-batch validation and no partial writes. Complements `state_init`
  (create-once): use when a task grows phases mid-flight so `state.json` stays in
  sync with `task.md`. Re-adding an existing phase id is rejected as a duplicate
  (never overwrites in-progress work); `blocked_by` resolves against existing ∪
  new phase ids.
- **MCP state server** (`scripts/state-server.js`) exposing **7 tools**
  (`state_init`, `state_update`, `state_flag`, `state_clear_flag`, `state_read`,
  `state_prime`, `tasks_list`) for deterministic, atomic `state.json` management.
- **`state.json` convention** — machine-readable shadow of `task.md` under
  `.tasks/[slug]/`.
- **`parallel_group` / `blocked_by` phase annotations** and the **`execution`
  metadata frontmatter** on phase plans.
- **Flag protocol** and **session-prime** pattern for fast cross-session resume.
- **First runtime dependencies** — `@modelcontextprotocol/sdk` + `zod`
  (`package.json`) — plus npm scripts (`state-server`, `test:state-server`,
  `test:e2e`); `install.sh` now runs `npm install` automatically.
- **Manual MCP registration** documented in README / cc-quickstart (Claude Code
  `claude mcp add --scope user`; VS Code user `mcp.json`).

### Changed

- **Explorer: right-sized phase-count guidance** — replaced "always produce a phased plan" with sizing guidance: single-phase for small/well-scoped tasks, multi-phase for genuinely complex ones. Removes unconditional multi-phase bias.
- **Conductor: neutral spawn language** — "Size the plan to the task" replaces "Break into numbered phases", removing the implicit pressure to split every task regardless of scope.
- **Clarify skill: automatic ambiguity scan for multi-phase plans** — scan now runs by default when a plan has multiple phases (default-on instead of opt-in); single-phase plans get a quick-exit.
- **Reviewer: AGENTS.md gate reports absence** — when no `AGENTS.md` is found the gate now logs "not found — convention check skipped" instead of silently no-opping.
- **Conductor: registers mid-flight phases in `state.json`** — the Conductor
  template now instructs the Conductor to call `state_add_phases` when a task
  grows phases after `state_init` (rather than tracking new phases only in
  `task.md`/todos, which silently desynced `state.json` from `task.md`).
  Regenerated `generated/claude/agents/conductor.md` and
  `generated/copilot/agents/conductor.agent.md`.

### Added

- **`clarify` skill + refinement loop** — new on-demand `templates/skills/clarify/` skill
  encoding a bounded clarification pass: surface unresolved `[?]` markers, ask ≤5 questions
  (one-at-a-time where dependent), opt out for unambiguous tasks, and record answers in a dated
  `## Clarifications` block before the plan checkpoint. Explorer loads it by name when `[?]`
  markers remain; Conductor Step 2a.3 surfaces the returned questions via its ask tool and
  re-spawns Explorer once with answers. Backports RDR-033 Concepts 1+4. (Skill count 15 → 16.)
- **Lean constitution soft-gate** — Explorer and Reviewer now consult repo `AGENTS.md`
  (Learned Patterns / conventions) as a soft planning and review gate when present; no new
  mandatory file. Backports RDR-033 Concept 8.
- **Cross-phase analyze mode in `phase-review`** — opt-in, read-only consistency pass over the
  full `task.md` phase set + all `plan/*.md`, surfacing coverage gaps, duplication,
  contradictions, and AGENTS.md/convention misalignment across phases. Multi-phase tasks only;
  +0 always-in-context lines (mode-in-skill, no Conductor hook). Backports RDR-033 Concept 5.

### Changed

- **Brevity authoring principle in `AGENTS.md`** — recorded the convention "replace > append;
  push situational behavior into on-demand skills rather than always-in-context agent prose;
  delete > comment out", the guardrail that justified extracting `clarify` into a skill.
- **Conductor trimmed** — folded-in brevity edits during the constitution work reduced
  always-in-context Conductor prose while adding the Step 2a.3 clarify-routing handler.

### Added

- **Non-Claude models for Copilot agents** — `models` config now accepts non-Claude
  model types (e.g. `"gpt": "5.5"`) as peers of the Claude tiers, and a new top-level
  `agents` config section overrides which model **type** a given agent uses for Copilot
  (e.g. `"agents": { "conductor": { "copilot": "gpt" } }` emits
  `model: ["GPT-5.5"]`). Resolution is driven by a `MODEL_TYPES` registry in
  `scripts/generate.js` (Claude → `Claude <Tier> <version>`,
  gpt → `GPT-<version>`). **Claude Code output stays Claude-only** — non-Claude
  overrides are ignored for CC, which falls back to the template's Claude type. Validation
  warns on unknown override types and on override types missing a `models` version.
  Opt-in: `defaults/config.json` is unchanged; re-run `make install` to apply config changes.
- **Context Hygiene guidance in Explorer, Builder, Reviewer** — new `## Context Hygiene` section in each agent template with four lean-context techniques: (T1) locate with Grep/Glob/LSP then read narrow slices; (T2) size/nesting-aware delegation (3+/50+ threshold preserved; Conductor-nested agents must read in-context); (T3) skip re-reads already in context, and never re-read after your own edit; (T4) trim bulky low-signal output but never summarize failure evidence. Evidence rule and Reviewer "read every changed file" invariants explicitly re-stated and preserved. Generates identically into both CC and Copilot outputs.

### Changed

- Lower skill size target from 500 to ~150 lines with linked reference files (from mattpocock/skills research)
- Add "THIS IS THE SKILL" emphasis pattern to skill authoring guidance
- Enhance debug skill with concrete feedback loop technique menu (10 ordered techniques)
- Add CONTEXT.md domain glossary awareness to Explorer and Builder agent templates

### Added

- **power-ui skill: Expanded Optimistic UI pattern (§5.4)** — replaces three thin bullet points with a full `useOptimisticAction<T>` hook (typed, reusable, snapshot-based revert), a one-liner usage example, a cross-reference to §2.7 for triage-specific extension, and a 4-row "when to use / when not to use" guidance table covering single-item actions, toggles, bulk actions, inline edits, fetches, server-computed values, multi-step operations, and confirmation dialogs.
- **power-ui skill: Triage UX Patterns (§2.5–2.7)** — three new component-pattern subsections: Bulk Action Bar (floating multi-select bar with "Select all low-priority" shortcut, `Ctrl+A`/`Escape` keyboard wiring), AI Suggestion Chips (computed-on-read accept/dismiss chips with rule-based rationale), and Drawer Auto-Advance (auto-advances to next item after triage action with `removedItem` pre-capture for optimistic revert). Anti-patterns table gains "Triage actions that close the drawer" row. Skill description and frontmatter triggers updated to include `triage UX`, `bulk action bar`, `suggestion chips`, `drawer auto-advance`.
- **power-ui skill: Color Discipline section (§1.1)** — hue budget rules, interactive-only primary, monochrome-default badges and avatars, anti-AI-purple zone guidance, single-hue gradient constraint, and a hue budget example table. Skill description and trigger phrases updated to include `color discipline`, `hue budget`, `monochrome badges`. Anti-patterns table gains an "Uncontrolled color / rainbow badges" row. H1 title corrected to "Power-UI Construction Manual".
- **power-ui skill** — new skill for building power-user interfaces: keyboard-first, information-dense, AI-present. Covers navigation chrome, data-table rows, keyboard architecture with priority model, liveness patterns, AI integration, visual impact planning, and comprehensive construction checklists.

### Changed

- **Builder emits structured delivery report at phase and full-implementation completion** — "After Completing a Phase" and "Final Completion" sections now specify a `📦 Phase [N]` / `✅ All phases complete` template with Verification status, Changes (before → after), Files, and Try it. Step 3 item 6 updated to reference the delivery report template instead of a bare verification summary.

### Changed

- **Conductor presents "What Changed" summary before commit checkpoint** — Step 2c Builder invocation prompt now requests a user-facing impact statement ("What Changed" — one plain-English sentence of what the user can now do/see). Step 2d now presents the impact summary (what changed, files changed, review status) before offering [Commit]/[Verify]/[Abort] options.

### Removed

- **Worker agent eliminated** — Deleted `templates/agents/worker.template.md` and generated outputs. Builder now handles all tasks previously delegated to Worker. See also: previous phases removed Worker calls from Conductor, Builder, and Reviewer.

### Fixed

- **Stale files cleaned up on reinstall** — `./install.sh` now removes files from previous installs that are no longer part of the framework (e.g., deleted agents).
- **Worker no longer uses terminal text tools for file edits** — Added `## Tool Preference: File Editing` section to Worker template explicitly requiring IDE file editing tools (`editFiles`/`replace_string_in_file`) and prohibiting terminal commands (`sed`, `awk`, `python`) for text replacement. Addresses Worker failures when editing markdown files containing multi-byte emoji characters (status markers like `🔄`, `✅`).
- **Conductor Worker prompts are more precise** — Both Worker subagent prompts in the Conductor (mark phase In Progress, mark phase Done) now instruct the Worker to find the specific phase table row and use file editing tools, reducing ambiguity when status strings appear multiple times in the file.

### Fixed

- **Builder always fixes failing tests** — Added rationalization prevention row forbidding `git stash`-based pre-existing failure checks; changed "Tests failing in unexpected ways" from a hard stop (🔴) to debug-and-fix (🟡); strengthened Step 3 to require fixing ALL test failures regardless of origin.

### Added

- **Anti-hallucination grounding in Explorer, Reviewer, Researcher** — Added evidence-grounding guidelines and rationalization prevention rows based on Anthropic's "Reduce Hallucinations" documentation. Explorer gets "ground claims in evidence" guideline + rationalization row; Reviewer gets uncertainty principle + rationalization row; Researcher gets grounded output requirement.
- **MCP tools merge in generate.js** — `resolveSectionTools()` function merges `defaultTools` and `agentTools` from `config.json` into agent `tools:` frontmatter during generation. Supports both multi-line (Copilot) and single-line (CC) array formats. Default config (empty arrays) produces identical output — zero regression risk.

### Added

- **`documentation` skill** — New skill encoding documentation best practices: documentation hierarchy (comments → docstrings → module docs → project docs), audience matrix (maintainers, new members, external users, AI agents), Diátaxis framework quick reference, quality checklist, anti-patterns, and agent-specific guidance. Auto-activates on prompts like "add docs", "docstring", "documentation review", etc.

- **`golang` instructions** — Idiomatic Go coding standards: code organization, error handling with `%w` wrapping, context propagation, concurrency patterns (goroutine lifecycle, channels vs mutexes), generics, interfaces (accept interfaces / return structs), table-driven testing, and common patterns (functional options, defer cleanup, zero-value usefulness)

- **`bdd` skill** — Behavior-Driven Development with Gherkin specifications and black-box testing: feature/scenario organization, declarative Given/When/Then semantics, black-box testing through public interfaces, thin step definitions as glue code, anti-patterns table, and quality checklist. Auto-activates on prompts like "bdd", "feature file", "gherkin", "step definitions", "given when then", etc.

### Changed

- **Builder: documentation enforcement** — Added `documentation` to CC skills list. Step 2 "Make Changes Incrementally" now includes documentation bullets and a skill loading trigger for public API changes. Step 3 "Phase Completion" adds a "Check Documentation" step. Code Quality Checklist and a new "Documentation Requirements" section parallel the existing Testing Requirements.
- **Conductor step 2e: stronger documentation enforcement** — Narrowed skip criteria (refactor/internal no longer auto-skips; only test-only and infra-only changes skip). Expanded Builder prompt to cover docstrings, module docs, and architecture docs — not just CHANGELOG/README.
- **Global instructions: Documentation Standards section** — Added a concise "Documentation Standards" section between "Code Quality" and "When Stuck", establishing baseline expectations for all agents (API docs, why-not-what comments, keeping docs current). References the documentation skill for detailed guidance.
- **Reviewer: documentation quality checks** — Added a "Documentation" checklist to Step 4 Code Quality Inspection (public API docstrings, README currency, stale docs). Added `documentation` to CC skills list and a Documentation row in the skill-powered subagents table. Updated "What to Look For" with documentation good signs and red flags.

### Fixed

- **install.sh: Defensive directory creation** — `copy_tree` now explicitly checks `mkdir -p` return codes and verifies directories exist before `cp`. Provides clear error messages instead of failing silently when directory creation fails.
- **install.sh: Legacy symlink migration** — Now removes symlinks pointing anywhere in the AGENTS repo (`$SCRIPT_DIR/*`), not just `generated/`. Fixes `cp` failures for users with old symlinks pointing to `.github/agents/` (pre-2.0 structure).

## [2.1.0] - 2026-03-14

Personalization framework, rationalization prevention tables, and requirement-change awareness.

### Changed

- **Install: copies instead of symlinks** — `install.sh` now generates with user config to a temp dir and copies to target directories instead of symlinking into `generated/`. This enables per-user model configuration without affecting committed files. See [ADR-006](docs/architecture/ADR-006-personalization-framework.md).
- **Flat-text manifest** (`~/.agents/manifest.txt`) — tracks all installed file paths for clean uninstall. Legacy symlinks are auto-detected and migrated on first install.
- **`generate.js` CLI flags** — added `--config <path>` (defaults to `defaults/config.json`) and `--output-dir <dir>` (defaults to `generated/`). Removed hardcoded `DEFAULT_VERSIONS` and implicit `~/.agents/config.json` fallback in favor of explicit config path.
- **Makefile targets** now pass `--config defaults/config.json` explicitly for deterministic CI builds.
- **Model configuration** — agent templates now use tier names (`opus`, `sonnet`) instead of hardcoded model strings; versions resolved from config at generation time.

### Added

- Requirement-change awareness in Explorer, Builder, and Conductor — agents now preserve valid completed work when requirements change mid-task instead of starting from scratch

- **Rationalization Prevention Tables** — 46 rows across 8 templates countering common agent shortcuts:
  - Skills (17 rows): `debug` (6), `testing` (6), `tech-debt` (5)
  - Agents (29 rows): `builder` (6), `reviewer` (6), `explorer` (6), `committer` (5), `conductor` (5)
  - Net-negative line growth: -58 lines (skills), -110 lines (agents) via concurrent prose trimming
  - Pattern: `| Excuse | Reality | Required Action |` format from obra/superpowers

- **User configuration file** (`~/.agents/config.json`) — created on first install, allows users to customize Claude model versions per tier without modifying templates.
- **ADR-006 Personalization Framework** — documents the config/manifest/install architecture decisions.
- **ADR-007 Rationalization Prevention** — documents the 3-column table pattern for countering agent shortcuts.

- **Renamed agents to persona names**: Explore→Explorer, Implement→Builder, Review→Reviewer,
  Commit→Committer, Orchestrate→Conductor, Research→Researcher (Worker unchanged)
- Updated all documentation to use new persona names (~15 files)
- **Verification before commit** — structured verification layer across Explore, Review, Orchestrate, and Implement templates:
  - Explore phase plans now require a `## Verification` section (automated checks, manual steps, success criteria)
  - Review owns functional verification — presents manual verification runbook, waits for single user confirmation before PASS
  - Orchestrate 2d checkpoint adds `[Verify]` option alongside Commit/Abort
  - Implement requires pasted terminal output as evidence (no more "✅ Tests pass" without proof) and delegates functional validation to Review
- **ADR commit ordering** — moved task consolidation (ADR creation) from post-commit step 2g to pre-commit step 2e.5 in orchestrate template:
  - ADR files are now committed together with code and docs in a single commit pass (step 2f)
  - Consolidation uses Implement agent (write-capable) instead of Explore (read-only outside `.tasks/`)
  - Removed separate post-commit ADR step (2g) that caused orphaned uncommitted files
- Research: [get-shit-done](https://github.com/gsd-build/get-shit-done) — Rejected (different scope/audience, CLI-only, validates existing approach)
- Research: [agentops](https://github.com/boshu2/agentops) — Rejected (autonomous DevOps scope, different from collaborative AGENTS)
- **Testing skill** (`templates/skills/testing/`): Behavioral testing strategy based on Kent Beck, Google SWE Book, and Martin Fowler research — tests behavior over structure, minimizes mocking, uses Saff Squeeze for regression workflow
- Research: [ai-project-system](https://github.com/panchew/ai-project-system) — Rejected (project management methodology, different scope)
- **CC-ONLY Command Rules in commit template**: Prevents `git -C` and `&&` command chaining that breaks Claude Code auto-approval
- **Testing skill integration in implement template**: Skill-loading directive, condensed testing principles, and testing skill subagent entry
- **Claude Code quickstart guide** (`docs/cc-quickstart.md`): Hands-on guide with 4 learning scenarios, troubleshooting, and Copilot-to-CC translation table

### Changed

- Research backlog housekeeping: completed entries in [docs/research/BACKLOG.md](docs/research/BACKLOG.md) are now moved out of the active backlog and grouped under Completed Items
- **Design skill trimmed from 1776 to 1401 lines** — comprehensive trim with high-value v2 additions:
  - Added: Intent-First Philosophy (answer "who/what/why" before picking aesthetics)
  - Added: Anti-Default Tests (Swap/Squint/Signature/Token tests) as core craft principle
  - Added: Per-Component Checkpoint (6-point quality gate for every component)
  - Added: Touch Targets (44px) & cursor-pointer as core principle
  - Added: "SaaS ≠ Marketing" and "Glass, not glow" principles
  - Added: Duration scale, button size variants, header glass pattern, component library guidance
  - Cut: 4 of 5 animation hooks (kept useInView, summarized rest in table)
  - Cut: Chat-specific components (chat input, typing indicator, session list)
  - Cut: Full checkbox implementation (replaced with technique note)
  - Cut: Gradient logo + ambient glow full code (replaced with technique description)
  - Cut: Chart container/palette, duplicate empty state, duplicate contrast hierarchy
  - Cut: Tailwind config full dump (replaced with structural overview)
  - Compressed: Stagger CSS classes, elevation utilities, quick reference, shadow pattern
- Implement template Testing Requirements — replaced generic guidelines with skill-aware behavioral testing principles; removed "70% coverage" metric
- Orchestrate: Added `[Verify]` checkpoint option before commit with manual verification runbook
- Orchestrate: Moved ADR consolidation before commit step (2e.5), removed separate 2g step
- Explore: Phase plans now require `## Verification` section (1-3 critical flow checks)
- Explore: Phase plans now require `## Tests` section for behavioral changes
- Implement: Automated verification now requires evidence (actual terminal output)
- Review: Added functional verification step with manual verification runbook (single confirmation)
- Review: Added `testing` to CC skills frontmatter
- All agents: Testing skill references use natural language invocation consistently

### Removed

- Testing instruction (`templates/instructions/testing.template.md`) — replaced by the testing skill

- Documentation updated to use current CC invocation syntax (`use AgentName`, `claude --agent AgentName`) instead of obsolete `@agent-Name` pattern
- `Task()` examples now use capitalized agent names (`Task(Explore, ...)` not `Task(explore, ...)`) for CC case-sensitivity
- Platform notes added for `askQuestions` (VS Code) / `AskUserQuestion` (CC) tool references

## [2.0.0] - 2026-02-21

Full Claude Code (CC) support — agents, skills, and rules now generated from the same template set as Copilot.

### Added

- **Claude Code support**: agents, skills, and rules generated for CC alongside Copilot from `templates/`
- **Single template set**: `scripts/generate.js` generates both platforms; use `<!-- COPILOT-ONLY -->` / `<!-- CC-ONLY -->` directives for platform-specific content
- **Neutral output dirs**: generated files now live in `generated/copilot/` and `generated/claude/` (previously scattered across `.github/`, `.claude/`, `instructions/`)
- Orchestrate agent improvements: Position Lock Protocol, Detour Recovery, context-adaptive checkpoints

### Changed

- **BREAKING:** Generated output paths moved to `generated/copilot/` and `generated/claude/`
- **`install.sh` is now symlink-only** — run `make` first to generate files, then `./install.sh` to symlink them into place; workflow is `make → ./install.sh`
- Documentation and instructions updated to reflect template-centric workflow

### Removed

- `scripts/generate-cc-files.js` — superseded by the unified `scripts/generate.js`
- Node.js generation logic from `install.sh` (generation is now a `make` step)

## [1.0.0] - 2026-02-13

### Added

- RDR-031: VS Code 1.109 orchestration features (Adopted — documents Orchestrate agent, subagent frontmatter)
- prevailing-wisdom.md Section 9: Conductor/Orchestration Pattern documentation
- IntelliJ IDEA support: installs global instructions to `~/.config/github-copilot/intellij/`
  - Note: Agents and skills are VS Code-specific (require tool restrictions and agent discovery)

### Changed

- Agent count 4 → 7: Orchestrate (conductor), Research (internal), Worker (internal)
- README: Updated workflow diagrams showing manual vs orchestrated workflows
- Consolidated design + ui-transformation skills into single `design` skill
  - Merged design philosophy (direction, personality, craft) with 9-phase implementation
  - ui-transformation folder now contains the unified skill with name "design"
  - Deleted standalone design skill folder

## [0.11.0] - 2026-02-07

### Added

- consolidate-task skill: Skip/Update/Create decision tree to prevent ADR bloat
- Agents: Multi-model configuration support (Commit/Review: Sonnet 4.5 + Gemini 3 Pro; Explore/Implement: Opus 4.5 + Opus 4.6)
- scripts/configure-vscode-settings.js: VS Code 1.109 boolean settings support (customAgentInSubagent, copilotMemory, askQuestions, searchSubagent)
- RDR-030: Vercel AGENTS.md eval study (Partially Adopted: retrieval-over-recall principle, horizontal vs vertical context)
- prevailing-wisdom.md: "Retrieval Over Recall" section with horizontal vs vertical context distinction
- scripts/configure-vscode-settings.js: Safe JSONC manipulation for VS Code settings (insert-only, preserves comments)
- scripts/test-configure-settings.sh: Test suite for settings configuration
- consolidate-task skill: Summarize completed tasks into architectural decision records (ADRs)
- phase-review skill: Review phase plans for flaws before implementation
- RDR-029: Cursor 2.4 support research (Rejected: lacks platform-enforced tool restrictions)
- RDR-024: Claude Code Mastery research (single-purpose chat, hooks vs instructions)
- RDR-023: Ralph Wiggum research (subagent fan-out, disposable plans, 40-60% context zone)
- RDR-022: Steve Yegge's six tips for agents (Partially Adopted: 40% rule, Rule of Five)
- docs/research/CATALOG.md: Topic-based navigation for research documents
- prevailing-wisdom.md: Skill evaluation checklist
- design skill: "use design mode" trigger phrase
- security-review skill: Security-focused code review with attack surface mapping, risk classification, and vulnerability checklist
- debug skill: Rationalization Prevention table and Red Flags section to prevent premature fix attempts
- debug skill: Fix attempt counting in Phase 3 with escalation guidance
- critic skill: Blast Radius Thinking section for downstream impact analysis
- critic skill: Expanded security probe patterns (attacker mindset, trust boundaries)
- critic skill: Rationalization Prevention table
- design skill: Pre-Delivery Checklist (visual quality, interaction, responsive, accessibility)
- Explore agent: Brainstorming skill patterns for focused design discussions
- RDR-028: Skills.sh ecosystem research documenting patterns from trailofbits, obra, getsentry
- deep-research skill: Exhaustive investigation with citations, structured findings, and confidence levels
- Explore agent: Skill-powered subagent patterns in Step 4 (architecture and deep-research skills)
- Implement agent: Skill-powered subagent section (Step 3.5) for debug skill invocation
- prevailing-wisdom.md Section 8: Skill-Powered Subagents pattern documentation
- RDR-027: Skill-subagents research documenting the pattern
- Review agent: Skill-powered subagent section (Step 4.5) for critic and tech-debt skills
- RDR-026: MetaPrompts research (Rejected: meta-agent for creating agents; confirms our approach)
- AGENTS.md: `## Learned Patterns` section for repository-level pattern memory
- Implement agent: "Learning from Corrections" (Step 5) - persists user-taught patterns to AGENTS.md
- Explore agent: "Repository Patterns" (Step 5.5) - discovers and suggests patterns during research
- Explore agent: Staleness warning for task files >14 days old
- memory-and-continuity.md: Learned Patterns section documenting the new feature
- RDR-025: Copilot Memory research with partial adoption
- design skill: UI/UX design principles for dashboards, admin interfaces, SaaS products (4px grid, depth strategy, typography hierarchy)
- makefile skill: AI-guided Makefile creation with process lifecycle management patterns (PID tracking, logging, status monitoring)
- Implement agent: "Save Progress" handoff for session continuity
- Implement agent: "Saving Progress Mid-Implementation" section for state preservation
- Implement agent: "Repo-Specific Instructions" step to check AGENTS.md for post-implementation requirements
- AGENTS.md: Post-Implementation section with CHANGELOG, docs, and versioning requirements

### Changed

- install.sh: Agents now install to `~/.copilot/agents/` (was `~/Library/.../prompts/`)
- install.sh: Instructions now install to `~/.copilot/instructions/` (was `~/Library/.../prompts/`)
- install.sh: Automatically migrates old symlinks from deprecated prompts folder
- install.sh: Configures `chat.agentFilesLocations` and `chat.instructionsFilesLocations` in VS Code settings
- tests/test-install.sh: Updated to verify new installation paths
- Skill count increased from 5 to 8 (added design, makefile, consolidate-task, phase-review; merged janitor into tech-debt)
- Agents: Sandwich pattern for constraint adherence (early + late reinforcement)
- Explore agent: Reduced question-asking behavior for smoother workflow
- Explore agent: consolidated from 541 to 322 lines (40% reduction)
  - Merged intro sections, moved Guidelines up, simplified process steps (9→6)
  - Removed handoff-format templates (now using task.md format)
- Explore agent: task.md template reorganized - phases table now at top for quick reference
- Implement agent: consolidated from 402 to 326 lines (19% reduction)
  - Integrated orphaned sections (Attention Management, Resuming Work) into workflow
  - Merged Quality Checklist + Testing Requirements with Guidelines
- Implement agent: strengthened UI verification guidance - emphasize Playwright tests over manual verification
- RDR TEMPLATE: Slimmed format for research documents
- RDRs 003-019: Slimmed to 29-46 lines each (from 60-183 lines)
- 8 RDRs archived to docs/research/archive/ (RDR-001, 002, 006-009, 011, 021)
- Task folder naming: `.tasks/[slug]/` → `.tasks/[NNN]-[slug]/` (e.g., `001-add-auth`)
  - Sequential numbering for chronological ordering
  - Updated in explore, implement, review agents and documentation
- prevailing-wisdom.md: Removed Section 7 "Code Protection" (feature was removed per RDR-011)
- framework-comparison.md: Marked RIPER protection levels as "not adopted" with RDR-011 reference
- framework-comparison.md: Updated "Handoff pattern" → "task-centric persistence" for consistency
- memory-and-continuity.md: Replaced "Handoff agent" reference with "task-centric persistence"
- tech-debt skill: absorbed janitor skill content (deletion philosophy, safe deletion patterns, cleaning checklist)
- architecture skill: strengthened constraints with anti-patterns table and "Never Include" examples
- AGENTS.md: updated repository structure table (agents/skills count corrections)
- copilot-instructions.md: simplified to reference AGENTS.md for cross-agent instructions

### Fixed

- All skill descriptions: Standardized to start with "Use when" and include proper `'use X mode'` triggers
- validate-skills.sh: Fixed regex to accept single-quoted trigger phrases
- configure-vscode-settings.js: Fixed trailing comma issue when setting has empty dict
- test-install.sh: skill symlink path check now matches install.sh (`~/.copilot/skills/` instead of `~/.github/skills/`)
- test.yml: explicit zsh invocation for shell compatibility on GHA macOS runners

### Removed

- All handoff file references (`.github/handoffs/` patterns) from both agents
- janitor skill: functionality merged into tech-debt (80% overlap)
- Terminal instructions: removed outdated line-count restrictions (VSCode 1.108 has better terminal handling)

## [0.10.0] - 2026-01-09

### Added

- Task-centric persistence: "Continue working on [task-name]" reads prior context
- Descriptive filenames for research (e.g., `error_handling.md`, `auth_flow.md`)
- Phase-based workflow with status tracking (⬜ Not Started, 📋 Planned, 🔄 In Progress, ✅ Done)
- Optional detailed phase plans in `.tasks/[task]/plan/phase-N-[name].md`
- Task metadata in `.tasks/[task]/task.md`
- Explore agent: scoped write access to `.tasks/` directory only
- Explore agent: "Plan Next Phase" handoff for detailed planning
- Implement agent: phase detection logic (picks smallest planned unit)
- RDR-017: Task-centric persistence decisions

### Changed

- Agent count reduced from 5 to 4 (Handoff agent removed)
- Agent state now saved to `.tasks/[task-name]/` instead of `.github/handoffs/`
- Explore agent asks for task name at start and saves research with descriptive filenames
- Explore agent merges overview into task.md (single source of truth)
- Implement agent reads task context from `.tasks/` directory, lists available tasks
- Implement agent model changed to Claude Opus 4.5 for better quality
- Review agent reads task context before reviewing (now read-only, no persistence)
- Install script manages `.tasks/` gitignore pattern instead of `.github/handoffs/`

### Removed

- Handoff agent: functionality now handled by Explore agent with scoped write access
- Review agent write access: now strictly read-only with test execution capability

## [0.9.1] - 2026-01-08

### Fixed

- Claude Code slash command references in documentation (corrected `/project:*` to `/*`)
- Install script messages now show correct command format (`@agent-Explore`, `@agent-Implement`, etc.)

## [0.9.0] - 2026-01-07

### Added

- RDR-017: Agent specification compatibility research for VS Code and Claude Code
- Claude Code agent invocation (`@agent-Explore`, `@agent-Implement`, `@agent-Review`, `@agent-Commit`)
- Capabilities sections in all agents describing tool access levels
- Claude Code usage documentation in README

### Changed

- Agents now use platform-agnostic language ("When starting this phase" vs "When this agent is activated")
- Install script generates Claude Code commands from agent bodies by stripping YAML frontmatter
- Handoff references updated to generic "Proceed to..." language instead of button-specific text
- Explore agent model field corrected to "Claude Opus 4.5"

## [0.8.0] - 2026-01-04

### Added

- RDR-016: Agent consolidation decision record

### Changed

- Consolidated Research + Plan agents into Explore agent (now 5 agents instead of 6)
- Explore agent enhanced with all features from Research and Plan
- Handoff agent simplified to copy Explore output verbatim (deterministic handoffs)
- Review agent: Re-Plan → Re-Explore handoff

### Removed

- `research.agent.md` - functionality merged into Explore
- `plan.agent.md` - functionality merged into Explore

## [0.7.2] - 2026-01-04

### Added

- Research tasks for VSCode browser testing, Copilot settings, and agent tools

### Changed

- Commit agent: explicit handoff file exclusion, never use force flags, require confirmation before deleting handoffs
- Handoff agent: added Explore source type, explicit filename formatting rules
- Implement agent: preserve handoff files until review passes (previously deleted after implementation)

## [0.7.1] - 2026-01-03

### Added

- RDR-012: Manus planning-with-files pattern research
- Attention Management section in Implement agent (goal drift prevention)
- Goal drift prevention guidance in prevailing-wisdom.md
- Manus/planning-with-files framework comparison

### Changed

- Framework comparison expanded with Manus pattern analysis

## [0.7.0] - 2026-01-02

### Added

- Explore agent for interactive codebase navigation and learning
- Auto-advance from Research to Plan agent
- Repo-specific copilot instructions (`.github/copilot-instructions.md`)
- Autonomous feedback loop guidance in global instructions (log files, programmatic verification)
- Self-improving instructions pattern for new repos
- RDR-011: Code protection markers removal

### Removed

- Code protection markers (`[P]`, `[G]`, `[D]`) - unused feature, see RDR-011

## [0.6.0] - 2026-01-01

### Added

- Community engagement infrastructure (CONTRIBUTING.md, issue/PR templates, README badges)

### Changed

- Supported version matrix updated to 0.5.x

## [0.5.0] - 2026-01-01

### Added

- Autonomous subagent support for Research/Plan/Implement agents
- RDR-010: Subagents and context forking research

### Changed

- Implement agent now cleans up handoff files after completion

## [0.4.0] - 2025-12-31

### Added

- Memory and session continuity synthesis document
- Namespaced tool specifications for agents
- RDR-008: Handoff workspace constraint research
- RDR-009: MCP memory tools rejection research

### Changed

- README revamped with AGENTS branding and improved structure
- Handoffs moved to workspace `.github/handoffs/` with global gitignore

## [0.3.0] - 2025-12-30

### Added

- Handoff agent for multi-session continuity
- Handoff workflow integration into Research/Plan/Implement agents
- RDR-007: Mitsuhiko handoff pattern research

## [0.2.0] - 2025-12-29

### Added

- RDR-005: Beads memory system analysis
- RDR-006: Agentic coding trends analysis
- Skill validation enforcement
- Review agent requires verification evidence before approval
- Testing anti-patterns documentation

### Changed

- Architecture skill aligned with CSO pattern
- Agents simplified and cleaned up

## [0.1.1] - 2025-12-28

### Added

- Research Decision Record (RDR) format for documenting decisions
- Feature-dev patterns adopted in agents

## [0.1.0] - 2025-12-27

### Added

- Commit agent with Conventional Commits support
- Review agent with handoffs and iteration tracking
- Mandatory testing requirements for agents
- Global agent installation for VS Code and Claude Code
- CRITICAL section with inviolable rules in instructions
- Automatic installation of instruction files

### Changed

- Updated workflow diagram and agent table in README
- Simplified installation instructions

## [0.0.1] - 2025-12-26

### Added

- Initial release of AGENTS framework
- 5 core agents: Research, Plan, Implement, Review, Commit
- 6 skills: debug, tech-debt, architecture, mentor, janitor, critic
- 5 instruction files: global, python, typescript, testing, terminal
- Installation script for VS Code Copilot and Claude Code
- Comprehensive documentation and synthesis from multiple frameworks
- Source materials from 12-Factor Agents, HumanLayer, CursorRIPER, Superpowers

[Unreleased]: https://github.com/mcouthon/agents/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/mcouthon/agents/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/mcouthon/agents/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mcouthon/agents/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mcouthon/agents/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/mcouthon/agents/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mcouthon/agents/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/mcouthon/agents/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mcouthon/agents/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mcouthon/agents/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/mcouthon/agents/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/mcouthon/agents/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mcouthon/agents/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mcouthon/agents/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mcouthon/agents/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mcouthon/agents/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mcouthon/agents/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mcouthon/agents/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mcouthon/agents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mcouthon/agents/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/mcouthon/agents/releases/tag/v0.0.1
