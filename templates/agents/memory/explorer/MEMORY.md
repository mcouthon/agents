# Explorer Memory

## Project Navigation
- This is a templates/instructions repo for AI coding agents
- Source templates: templates/agents/*.template.md
- Generated output: generated/claude/
- Generator: scripts/generate.js (passes through all cc: frontmatter fields)
- Build: make && make validate
- State: .tasks/[NNN]-[slug]/state.json (machine-readable)
- Code intelligence: Graphify MCP (query_graph, get_neighbors, etc.)
- Build Graphify index before querying code structure

## Research Patterns
- (Agents accumulate findings here across sessions)
