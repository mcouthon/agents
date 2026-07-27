# Agent Write-Lockdown (Reviewer / Committer)

**Source:** Task 100, Phases 1–6 (July 2026)

## Decision

Hard-enforce that the Reviewer subagent can never create or modify a file — and that
the Committer can only do so through the `Edit` tool, never through shell
write-primitives — via **defense-in-depth**: a soft prompt-level prohibition on both
agents, backstopped by a hard `PreToolUse` Bash/terminal write-guard hook scoped to
those two agents only, on both Claude Code and VS Code Copilot.

1. **Prompt (soft control, Phases 1 & 4)** — the Reviewer template states it MUST NOT
   create, write, or modify any file "by ANY means" (redirection, `tee`, heredocs,
   `sed -i`, `python -c`/`perl -e`/`node -e` writes, editors, `touch`, `dd`, etc.); the
   Committer template mandates the `Edit` tool for every file change and forbids
   authoring/editing files through the shell. Both live in the shared template body,
   so the prohibition reaches the Claude Code and Copilot variants of each agent from
   one edit.
2. **Hook (hard control, Phases 2, 3, 5, 6)** — a single shared script,
   `hooks/write-guard.sh`, is wired as a `PreToolUse` hook in **per-agent frontmatter**
   (never global settings) for the Reviewer and the Committer, on both Claude Code
   (`matcher: "Bash"`) and VS Code Copilot (matcher-less — Copilot's terminal tool is
   `runTerminalCommand`, not `Bash`). It parses the candidate shell command,
   quote-aware, and denies a FOCUSED set of write primitives (`>`/`>>`, `tee`,
   file-writing heredocs, `sed -i`/`perl -i`, `touch`, `dd`, in-place editors,
   `python -c`/`perl -e`/`node -e` writes, curl/wget download-to-file), while leaving
   reads, pipes, `git` operations, and the `Edit` tool untouched. The agent identity
   (`reviewer` / `committer`) is passed as a **positional argv** in the hook's
   `command` string, selecting an agent-specific coaching message on deny.

Copilot CLI has no per-agent hook surface at all (its hooks are global
`~/.copilot/hooks/*.json` files, not scoped to an `.agent.md`) and is explicitly
dropped from hard-control scope; it relies on the prompt prohibition alone.

## Why

- **The Reviewer retains `Bash`** (needed to run tests/lint/`git diff`) even though its
  tool config already withholds `Edit`/`Write` — so it can trivially bypass that
  restriction by writing files through the shell (`cat > f`, `sed -i`, `python -c
  "open(...,'w')"`, etc.), authoring ad-hoc verification scripts instead of auditing
  the Builder's evidence. That is the exact behavior this ADR eliminates.
- **The Committer's real failure mode** is editing `task.md` via `sed`/`awk`/`cat`/
  redirection instead of the `Edit` tool, violating the repo's global "never edit
  files via shell" rule. The guard is the forcing function; because the fix is
  behavioral (use `Edit`, not shell) rather than "don't write at all," the Committer's
  coaching message differs from the Reviewer's.
- **Per-agent frontmatter hooks are the only mechanism that scopes correctly.** Claude
  Code subagent frontmatter and VS Code Copilot custom-agent frontmatter both support
  a `hooks:` field scoped to that single agent definition, cleaned up automatically
  when the subagent finishes. A hook registered in global `settings.json` (Claude
  Code) or `.github/hooks/*.json` (Copilot) fires for **every** agent, including
  Builder — which legitimately writes files via shell — so global registration was
  rejected as unsafe for this task's threat model.
- **Positional argv, not `args:` or stdin, carries agent identity.** `PreToolUse`'s
  stdin JSON has no reliable `agent_type` field to depend on as the primary signal,
  and a YAML `args:` field on the hook entry breaks `$HOME` expansion in the `command`
  string. Appending the agent id as a token in the `command` string itself
  (`"$HOME/.claude/hooks/write-guard.sh reviewer"`) preserves shell expansion and lets
  one script serve both agents with distinct coaching text.
- **VS Code Copilot's `PreToolUse` deny contract is identical to Claude Code's** —
  same nested `hookSpecificOutput.permissionDecision` shape, PascalCase `PreToolUse`,
  reads `tool_input.command` — so one guard script covers both hosts unmodified; only
  the frontmatter wiring (and, for Copilot, dropping the inert `matcher` field)
  differs per host.
- **Static shell-command parsing is inherently incomplete.** The guard accepts a
  documented residual-risk surface (`$'...'` ANSI-C quoting, backslash-newline
  splicing, `printf -v` indirection, fully opaque/obfuscated commands) rather than
  chasing unbounded parser complexity. The threat model this hook defends against is
  a **cooperative-but-overeager agent** reaching for a shell workaround, not an
  adversary deliberately evading detection — the prompt-level prohibition is the
  backstop for anything the parser misses.

## Problem Statement

Restricting an agent's tool list (withholding `Edit`/`Write`) does not restrict what
that agent can do with a retained `Bash`/terminal tool — shell redirection, `tee`,
in-place editors, and one-liner interpreters can all write files. The Reviewer needs
`Bash` for legitimate read/test/diff work, and the Committer needs it for `git`
operations, so removing the tool outright was not an option for either agent. The
system needed a way to block file-write side effects of specific tool calls for
exactly two agents, without affecting Builder/Explorer/Conductor, without a central
registry that risks over-scoping, and without breaking `$HOME`-relative paths that
only resolve at the installed user's runtime.

## Key Architectural Decisions

### Per-agent frontmatter hooks, not global settings

Both Claude Code and VS Code Copilot support a `hooks:` field inside a specific
subagent/custom-agent's own frontmatter, distributed as part of that agent's
definition file. This is the only mechanism used for scoping in this task; a global
`settings.json`/`.github/hooks/*.json` hook with `agent_type` self-filtering was
considered and explicitly rejected as the primary path, since it fires for every
agent and depends on a stdin field this task does not treat as authoritative.

### Shared script, per-agent coaching message via argv

`hooks/write-guard.sh` (renamed from `reviewer-write-guard.sh` in Phase 5 once it
started serving the Committer too) implements one deny/allow policy. `resolve_agent_id`
reads `argv[1]` first (falling back to a stdin `agent_type` field, then a generic
default) to select between three coaching-message templates: Reviewer ("report a
finding instead"), Committer ("use the `Edit` tool"), and a generic default. The
deny/allow scan logic itself does not vary by agent — only the message does.

### Quote-aware unwrap-then-scan detection

The guard recursively unwraps known shell/interpreter wrappers (`bash|sh|zsh -c`,
`xargs ... sh -c`, `find -exec sh -c`, `python3 -c`/`perl -e`/`node -e`, including
`subprocess`/`os.system` argument extraction in both quoted-string and list-literal
form) and matches DENY patterns only against unquoted/de-escaped text, so
`grep 'a > b' file` and similarly quoted operators are not false positives. This
replaced an earlier raw-scan approach after review found it flagged legitimate quoted
content. A subsequent adversarial audit found and closed four further bypasses
(backslash-escaped command names, `$(...)`/backtick substitution inside double
quotes, bundled short curl/wget download flags, and `subprocess` list-argv commands)
before the guard was considered load-bearing.

### VS Code Copilot: same deny contract, matcher dropped

VS Code Copilot's custom-agent `hooks:` field (Preview only, gated behind a
`chat.useHooks`-family setting — the exact setting name varies across VS Code builds
and a live smoke test is authoritative) uses the identical nested deny shape as Claude
Code and reads the command from `tool_input.command`, so the guard script needed no
Copilot-specific branch. Because Copilot's terminal tool is `runTerminalCommand` (not
`Bash`), the Copilot hook entry omits `matcher` entirely rather than risk a
CC-copied `matcher: "Bash"` value silently never firing.

### Copilot CLI is out of scope, by explicit decision

The Copilot CLI has no per-agent hook surface — its hooks are global JSON files under
`~/.copilot/hooks/*.json`, unscoped to an individual `.agent.md`. Wiring the guard
there would mean it fires for every agent, defeating the scoping requirement. This
task accepts that gap explicitly: Copilot CLI users get only the prompt-level
prohibition (Phases 1/4), not the hard hook.

## Consequences

- **Positive:** the Reviewer and Committer cannot write files via shell on Claude Code
  or VS Code Copilot without hitting a hard deny plus a coaching message that steers
  them to the correct tool (report a finding / use `Edit`); Builder, Explorer, and
  Conductor are structurally unaffected since the hook does not exist in their
  frontmatter; `git add`/`git commit`/`git diff` and the `Edit` tool remain fully
  functional for the Committer, since only shell write-primitives are in the deny set.
- **Negative / cost:** static shell-command parsing carries an accepted, documented
  residual-risk surface (ANSI-C quoting, backslash-newline splicing, `printf -v`
  indirection, opaque commands) that a sufficiently adversarial command could still
  slip through — mitigated, not eliminated, by the prompt-level prohibition as
  backstop. Hard enforcement on VS Code Copilot is conditional on a Preview setting
  the user must enable; if unset, Copilot silently falls back to prompt-only, same as
  the CLI. Copilot CLI has no hard control at all, by design.
- **Neutral:** one shared script and one deny/allow policy serve two agents across two
  hosts; only the frontmatter wiring and the selected coaching-message template vary.

## See Also

- [ADR-007](ADR-007-rationalization-prevention.md) — rationalization-prevention
  tables, the pattern this task's prompt-level prohibitions and coaching deny messages
  extend into a hard control.
- [ADR-005](ADR-005-ide-compatibility.md) — the Claude Code / Copilot dual-target
  template-generation approach this task's shared guard script and per-platform
  frontmatter wiring builds on.
- `.tasks/100-reviewer-write-lockdown/` — the implementing task (Phases 1–6: Reviewer
  prompt + CC hook + Copilot hook, Committer prompt, guard generalization, Committer
  hook wiring).
