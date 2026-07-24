# Cross-Agent Instructions

Instructions that apply to all AI agents working in this repository.

## Repository Structure

This is an agentic coding framework. Key locations:

| Path                 | Contents                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `templates/`         | Source-of-truth templates for agents, skills, instructions                                        |
| `Makefile`           | Build targets: `make [copilot\|cc\|all\|validate]`                                                |
| `scripts/`           | Generator (`generate.js`), VS Code config scripts, and MCP state server (`state-server.js`)       |
| `generated/copilot/` | GENERATED — Copilot agents, skills, instructions (do not edit)                                    |
| `generated/claude/`  | GENERATED — Claude Code agents, skills, rules (do not edit)                                       |
| `docs/sources/`      | Reference materials from external frameworks                                                      |
| `docs/synthesis/`    | Framework design principles and analysis                                                          |
| `.tasks/`            | Per-task research/plans (`task.md`) + optional machine-readable `state.json` shadow (MCP-managed) |

## Conventions

- Follow existing patterns in the codebase
- Run `make && ./install.sh` after modifying templates
- **Brevity (agent-instruction authoring):** keep always-in-context agent prose lean. Prefer rewording existing lines over adding new ones (replace > append); push situational behavior into on-demand skills rather than always-in-context agent prose; delete > comment out.
- **Concurrent workstreams:** run one `git worktree` per workstream (`npm run worktree -- add <branch>`) for structural isolation; the state server auto-derives a shared `.tasks/` per repo, so the dashboard aggregates every worktree with no manual pinning. See [README.md](README.md#concurrent-workstreams-with-git-worktrees).
- See [README.md](README.md) for full documentation and usage instructions

## Context Hygiene — Operator Guidance

These are the strongest dynamic-context reducers because they **mechanically reset or
collapse** accumulated context in one action. All work on **both Claude Code and
GitHub Copilot**:

- **`/clear` (or `/new`) between unrelated tasks.** Zeroes accumulated context when
  switching to unrelated work. CC `/clear` ↔ Copilot `/clear`/`/new` (or a new chat in
  the GUI); `/rewind` is available on both for checkpoint restore.
- **Keep sessions focused; hand off at phase boundaries.** Dynamic context roughly
  doubles from the first to the last quarter of a long spawn. Starting a fresh spawn at a
  natural boundary lets it begin near-zero. Caveat: don't over-split — the 41–100 turn
  band is the efficiency sweet spot; very short spawns waste cold-start overhead.
- **Don't paste large content into prompts.** Pasted blobs become permanent context
  residents re-read every turn. Reference a file path and let the agent read the relevant
  slice instead.

**Context compaction is a _manual_, proactive lever — auto-compaction won't save you.**
These models have very large context windows (1M tokens), so auto-compaction effectively
never fires and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is inert (confirmed empirically; see
also issue #53801). To actually reduce context cost:

- **`/compact`** a _long single-task coding session at a natural task boundary_ when
  context has grown large (>~100k tokens) AND substantial work remains (~50+ turns
  ahead), and the finished work is already committed/documented. (Modeled saving
  ~$17–22/mo for the slow-growth sessions that fit this profile; low risk at boundaries.)
- **Do NOT** `/compact` mid-task (unresolved errors / half-applied fixes), when the
  session is nearly done (overhead exceeds benefit), when merely _continuing_ the same
  task after a break (context regrows in 2–3 turns → net-negative), or inside
  Conductor/multi-agent loops (already handled by the workflow; net-negative per event).
- **`/clear`** between genuinely unrelated tasks — though in practice you likely already
  do this correctly (data shows ~$0–4/mo recoverable waste from /clear discipline).

## Post-Implementation

After making changes to this repository, complete these steps:

### 1. Update CHANGELOG.md

- Add changes under `## [Unreleased]` section
- Use categories: Added, Changed, Deprecated, Removed, Fixed, Security
- Follow [Keep a Changelog](https://keepachangelog.com/) format

### 2. Update Documentation (if changes justify it)

| Change Type                | Update                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| New/removed agents/skills  | [README.md](README.md) counts and tables                                           |
| Workflow changes           | [README.md](README.md) workflow section                                            |
| Framework philosophy       | [docs/synthesis/prevailing-wisdom.md](docs/synthesis/prevailing-wisdom.md)         |
| Memory/continuity patterns | [docs/synthesis/memory-and-continuity.md](docs/synthesis/memory-and-continuity.md) |
| Framework comparisons      | [docs/synthesis/framework-comparison.md](docs/synthesis/framework-comparison.md)   |

### 3. Versioning (for releases)

When ready to release:

1. Move Unreleased content to new version section: `## [X.Y.Z] - YYYY-MM-DD`
2. Add new empty Unreleased section
3. Add version link at bottom of CHANGELOG.md
4. Create git tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`

**Version increments:**

- MAJOR: Breaking changes to agent/skill format
- MINOR: New agents, skills, or features
- PATCH: Bug fixes and documentation
