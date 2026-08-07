# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

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

### Removed

- **From the delivery report:** the file list, the automated Verification
  Report table, and the `Capabilities` section. Automated checks are **still
  run in full**; passing checks are no longer presented as evidence to the
  user, and a failing check now blocks delivery with the error quoted. Also
  removed: the `[Verify]` second-confirmation gate (its runbook is now shown
  up front in the delivery report) and Step 2a.3 as a standalone step (folded
  into the plan-approval checkpoint).

### Fixed

- **Phantom `getDiagnostics` removed** from the Tool Preference block in
  builder, explorer, researcher and reviewer templates — no CC or Copilot
  tool surface exposes `getDiagnostics`, `goToDefinition` or `findReferences`
  by those names.
- **`reviewer.template.md` heading nesting** — `## Process Steps` now
  correctly parents all seven `### Step N` subsections; it had been
  displaced after `## Rationalization Prevention`.
- **Committer's Copilot subagent guidance now names an agent it can reach**
  — the COPILOT-ONLY body under `## Subagent Usage` told Committer to run
  Explorer, which isn't in its Copilot `agents:` allow-list; it now names
  Researcher.
- **The Builder prompt no longer points at a "Step 2d template"** Builder
  cannot see, and the delivery report no longer asks for a "Capabilities"
  field Builder never emits.

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
- **GPT-5.6 Terra and GPT-5.6 Sol model types (Copilot)** — two new
  `MODEL_TYPES` registry entries (`gpt-terra`, `gpt-sol`) that render to
  `GPT-5.6 Terra` and `GPT-5.6 Sol` in generated Copilot
  agent frontmatter. Both coexist in one config, so different agents can be
  assigned different GPT-5.6 SKUs. Opt-in via `models` + `agents`; Claude Code
  output stays Claude-only. GPT-family registry entries are now built via a
  small `gptVariant()` factory, so adding another GPT SKU in the future is a
  one-line registry addition. See ADR-009 addendum.
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

[Unreleased]: https://github.com/mcouthon/agents/compare/v2.1.0...HEAD
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
