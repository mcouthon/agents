# Prompt-Level Ban on Stderr/Exit-Code Suppression

**Source:** Task 103 (July 2026)

## Decision

Prohibit stderr- and exit-code-suppressing terminal commands (`2>/dev/null`,
`2>&1` redirects that discard errors, `|| true`, etc.) via a **prompt-level**
rule added to the two shared instruction templates —
`templates/instructions/terminal.template.md` and
`templates/instructions/global.template.md` — so it reaches every generated
flavor (`generated/copilot/instructions/*.instructions.md`,
`generated/claude/rules/*.md`) through `make all`, with no per-agent template
duplication. A **hook-based hard control** and **widening VS Code's
`chat.tools.terminal.autoApprove`** were both evaluated and explicitly
rejected as the enforcement mechanism (see Rejected Alternatives).

## Why

- **Observed problem:** agents (Builder, primarily) were emitting compound
  commands like `sed ... 2>/dev/null; echo ...; sed ... 2>/dev/null`. This
  cost autonomy (VS Code's terminal auto-approve requires every sub-command
  and any redirect to match an allow-list entry, so a redirect reliably
  forces an approval prompt) and hid failures (`2>/dev/null` discards the
  error text the agent needed to read; `|| true` discards the exit code).
- **Single source of truth, zero duplication:** the generator has no
  includes/partials mechanism for agent templates — only directive-based
  platform splitting. A rule placed in an agent template is per-agent
  duplication that must be independently justified. The shared instruction
  templates are the one place a rule reaches Builder, Committer, and Reviewer
  (the only three agents with terminal access) without touching any agent
  file.
- **Scope discipline:** the rule bans *suppression*, not *chaining*.
  Chaining is explicitly acceptable when every sub-command is itself
  approved; banning it too would have re-litigated an existing, deliberate
  Committer-only CC rule and cost approval-prompt autonomy for no error-
  hygiene benefit. The rule also had to explicitly exclude legitimate
  authored shell code (Makefile recipes, `command -v foo >/dev/null 2>&1`
  idioms) — it targets commands the agent *runs*, not scripts it *authors*.

## Problem Statement

Given the observed compound-redirect commands, three enforcement layers were
available: a prompt rule, a deny-hook, or a VS Code settings change. Each has
a different cost/coverage profile across the three platforms this framework
generates for (VS Code Copilot, Claude Code, Copilot CLI).

## Rejected Alternatives

### Hook-based enforcement (`PreToolUse` deny hook)

**Feasible, not planned.** The machinery already exists —
`hooks/reviewer-write-guard.sh` is a host-agnostic `PreToolUse` hook wired via
agent frontmatter on both platforms (see also the reviewer write-guard
decision from Task 100, referenced below). A sibling
`hooks/no-stderr-suppression.sh` would need no installer change.

Rejected for two reasons:

1. **Coverage gap where it matters most.** The approval-prompt cost this
   task is about is host-side (VS Code's terminal allow-list); VS Code
   agent-frontmatter hooks are a Preview feature with an unstable setting
   name that requires a trusted workspace, and **the Copilot CLI has no
   per-agent hooks mechanism at all**. A hook is therefore absent exactly
   where the prompt rule still has to work.
2. **Context-dependent, real false-positive risk.** Unlike "never write a
   file" (the write-guard's crisp, context-free predicate), "don't suppress
   stderr" is not context-free — the legitimate `command -v foo >/dev/null
   2>&1` idiom, and any script/Makefile the agent legitimately *authors*
   (as opposed to *runs*), both match the pattern. A deny-hook converts a
   style violation into a hard tool failure the agent must route around,
   for a rule that a crisp predicate cannot safely express.

### Widening `chat.tools.terminal.autoApprove`

**Mechanically easy, not planned.** `scripts/configure-vscode-settings.js`
already writes VS Code settings on install, so adding auto-approve entries
(including `matchCommandLine` object rules for redirects) was mechanically
straightforward. Rejected because it would restore autonomy by **widening
the security surface on the user's machine** for a pattern the task had just
decided is bad practice — and it does nothing about the underlying problem of
hidden errors. If ever wanted, it is its own task with its own security
review, not a substitute for banning the pattern.

## Solution

### Before

No rule existed. `templates/agents/committer.template.md` had a CC-only "never
chain commands" bullet (unrelated axis — chaining, not suppression), and
`templates/agents/reviewer.template.md` contained a sentence blessing
`/dev/null` redirects that, read next to a new suppression ban, would read as
a direct contradiction.

### After

- `templates/instructions/terminal.template.md` gained a rule stating
  terminal commands the agent *runs* must never redirect stderr to
  `/dev/null` or discard exit codes with `|| true`, scoped explicitly to
  avoid banning legitimate authored shell code (Makefiles, `command -v`
  idioms).
- `templates/instructions/global.template.md` gained a one-line pointer into
  the terminal instruction, following the existing precedent set by its
  "Terminal Command Length" rule.
- `templates/agents/reviewer.template.md` was reworded (not reverted) so its
  `/dev/null`-is-allowed sentence is scoped to the write-guard's actual
  concern ("`/dev/null` is not a file write") rather than reading as a
  general blessing of stderr suppression. `hooks/reviewer-write-guard.sh`
  itself is untouched — it correctly continues to treat `/dev/null` as a
  non-write target; error hygiene is a different axis, enforced by prompt.
- No change to `templates/agents/builder.template.md` or
  `templates/agents/committer.template.md` — Q2/Q3 in the task record
  explicitly rejected per-agent restatement of the rule, and left the
  Committer's unrelated chaining bullet alone.
- `tests/test-generate.sh` gained content-assertion tests (grepping a
  distinctive literal phrase in both `generated/claude/rules/terminal.md`
  and `generated/copilot/instructions/terminal.instructions.md`) following
  the existing Test 35 pattern, guarding against the rule being silently
  dropped in a future template refactor. A naive negative grep (`no
  2>/dev/null anywhere in generated/`) would have been wrong — the makefile
  skill's example recipes legitimately contain the pattern 20 times per
  platform.

## Design Principle

**Match the enforcement mechanism to the predicate's crispness.** A
context-free, binary predicate ("never write a file") is a good hook
candidate — deterministic, no false positives. A context-dependent predicate
("never suppress an error") that has legitimate exceptions in the same
surface (idioms, authored scripts) belongs in the prompt layer, where a
reasoning agent can apply the exception and where a miss is a style lapse
rather than a hard tool-call failure with no escape hatch. This is the same
class of trade-off as ADR-007's rationalization-prevention tables (placement
proximity to the point of action matters) but resolved one level up: whether
to enforce at all via a deterministic gate, or exclusively via the prompt
the agent reasons over.

## Accepted Residual Risk

**Copilot CLI instruction-reach is UNCONFIRMED from repo contents.** The
repo documents instruction-file discovery for VS Code, Cursor, and IntelliJ
(`docs/synthesis/ide-compatibility.md`); it contains no evidence either way
for whether the standalone Copilot CLI reads `~/.copilot/instructions/`. This
risk is specifically elevated by the companion decision (this task's Q2) to
drop the previously-considered Builder-agent-level restatement of the rule —
agent files are the one artifact the CLI is known to read (the original
problem report cited a CLI-run command against `~/.copilot/agents/conductor.agent.md`).
For Claude Code, reach is directly confirmed (this task's own Explorer
subagent session received the edited rules verbatim in its system prompt).
For VS Code Copilot, reach is established by `install.sh`'s copy destinations
and `chat.instructionsFilesLocations` settings, though whether `applyTo: "**"`
instructions apply inside a VS Code *custom agent* session (vs. plain agent
mode) is separately unverified.

**Mitigation:** a live post-install behavioral check (not a static test) is
the follow-up. If the Copilot CLI is confirmed to ignore
`~/.copilot/instructions/`, the follow-up is a **new phase reinstating
per-agent text** for the CLI-reachable Builder/Committer/Reviewer agent
files — not a silent fix folded back into this task.

## Consequences

- **Positive:** a single edit to two shared instruction templates reaches
  every terminal-capable agent (Builder, Committer, Reviewer) across
  Copilot and Claude Code, with a regression test guarding the phrase
  against silent loss in a future template refactor. No new hook to
  maintain, test, or reason about false positives for.
- **Negative / cost:** the fix's Copilot CLI reach is unverified; if the CLI
  does not read `~/.copilot/instructions/`, this task has zero effect on the
  runtime where the reported misbehavior was actually observed, until the
  follow-up phase lands. The chaining half of the original approval-prompt
  cost (compound `;`-joined commands) is explicitly out of scope and may
  still force occasional VS Code approval prompts.
- **Neutral:** `hooks/reviewer-write-guard.sh`'s `/dev/null`-is-allowed
  behavior is unchanged; only the reviewer template's prose describing it
  was reworded to remove the appearance of contradiction with the new rule.

## See Also

- `.tasks/103-no-stderr-suppression/task.md` — full research findings (F1-F9),
  knowledge gaps, and clarification log (Q1-Q3) behind this decision.
- `hooks/reviewer-write-guard.sh`, Task 100 — the crisp, context-free
  `PreToolUse` deny-hook this decision deliberately did not replicate; its
  `/dev/null`-as-non-write allowance is the direct source of the
  contradiction this task's Reviewer-template reword repairs.
- [ADR-005](ADR-005-ide-compatibility.md) — the templates-as-source-of-truth
  and per-platform generation mechanism this task's instruction edits ride on.
- [ADR-007](ADR-007-rationalization-prevention.md) — related placement
  principle (rule proximity to the point of action); this decision resolves
  the enforcement-mechanism question one level up.
