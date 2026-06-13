# Cross-Agent Instructions

Instructions that apply to all AI agents working in this repository.

## Repository Structure

This is an agentic coding framework. Key locations:

| Path                 | Contents                                                       |
| -------------------- | -------------------------------------------------------------- |
| `templates/`         | Source-of-truth templates for agents, skills, instructions     |
| `Makefile`           | Build targets: `make [copilot\|cc\|all\|validate]`             |
| `scripts/`           | Generator (`generate.js`) and VS Code config scripts           |
| `generated/copilot/` | GENERATED — Copilot agents, skills, instructions (do not edit) |
| `generated/claude/`  | GENERATED — Claude Code agents, skills, rules (do not edit)    |
| `docs/sources/`      | Reference materials from external frameworks                   |
| `docs/synthesis/`    | Framework design principles and analysis                       |

## Conventions

- Follow existing patterns in the codebase
- Run `make && ./install.sh` after modifying templates
- See [README.md](README.md) for full documentation and usage instructions

## Context Hygiene — Operator Guidance

These are the strongest dynamic-context reducers because they **mechanically reset or
collapse** accumulated context in one action. All work on **both Claude Code and
GitHub Copilot**:

- **`/compact [focus]` at natural task boundaries.** Replaces accumulated history with a
  focused summary, collapsing dynamic context mid-spawn. On CC use `/compact` with an
  optional focus directive; on Copilot, context compaction runs automatically and can be
  triggered manually — Copilot's docs note it "helps manage AI credit consumption."
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

CC-only sub-levers (no Copilot parity): auto-compact threshold tuning via
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (Copilot offers only on/off), and per-subagent/skill
usage attribution in `/usage` (Copilot's breakdown is categorical only).

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
