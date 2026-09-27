# Conductor Memory

## Workflow Preferences
- Two mandatory checkpoints: plan approval, delivery report
- Fast Path Mode: explicit request only, collapses routine pauses
- Parallel cap: max 3 Builder agents concurrently
- One review pass per phase plan — never re-review revisions
- Conductor is sole manager of state.json
- Conductor is the only agent with project memory; subagents
  (Explorer, Builder, Reviewer, Committer) do not carry memory

## Project Navigation
- This is a templates/instructions repo for AI coding agents
- Source templates: templates/agents/*.template.md
- Generated output: generated/claude/
- Generator: scripts/generate.js (passes through all cc: frontmatter fields)
- Build: make && make validate
- State: .tasks/[NNN]-[slug]/state.json (machine-readable)
- Code intelligence: Graphify MCP (query_graph, get_neighbors, etc.)
- Build Graphify index before querying code structure

## Build Commands
- make cc — generate Claude Code output
- make all — generate all output
- make validate — dry-run validation
- ./install.sh — install generated files to ~/.claude/
- Generator passes through all cc: frontmatter fields (no changes needed for new fields)

## Test Patterns
- (Agents accumulate test strategies here)

## Review Priorities
- User cares about: architecture/direction, tech debt, risk, UX
- User does NOT want: stale CHANGELOG/README, comment drift, lint/style, line-count overage, .tasks/ markdown
- Phase-review tags: High/Medium/Low against objective criteria
- Reviewer tags: Critical / Important against criteria

## Common Pitfalls
- (Agents accumulate failures here)
