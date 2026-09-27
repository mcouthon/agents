#!/bin/bash
# SessionStart hook: initialize workspace (seed memory + refresh code index)
#
# Fires on session begin (startup) or resume. Idempotent — safe to run
# repeatedly with no side effects when everything is already up to date.
#
# Memory seeding: copies MEMORY.md seed files from the installed seed source
# (~/.claude/agents/memory/) to the project's .claude/agent-memory/ directory.
# Create-if-not-exists: agent-curated memory is never overwritten.
#
# Code index refresh: delegates to workspace-init-helper.js, which reads the
# build command from ~/.agents/config.json (or $AGENTS_CONFIG_PATH), checks
# staleness (graph_file mtime vs tracked code files), and runs the build
# only when stale or missing — same staleness-guarded logic as the
# state-manager MCP's code_index_build tool.
#
# Always exits 0 — a SessionStart hook must never block the session.

set -uo pipefail

# Resolve project root — CLAUDE_PROJECT_DIR (set by CC), then git toplevel,
# then cwd. Mirrors state-server.js's resolveProjectDir priority chain.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

# --- Memory seeding --------------------------------------------------------

SEED_SRC="$HOME/.claude/agents/memory"
MEM_DEST="$PROJECT_DIR/.claude/agent-memory"

if [ -d "$SEED_SRC" ]; then
  for agent_dir in "$SEED_SRC"/*/; do
    [ -d "$agent_dir" ] || continue
    agent_name=$(basename "$agent_dir")
    src_file="$agent_dir/MEMORY.md"
    dest_file="$MEM_DEST/$agent_name/MEMORY.md"

    # Create-if-not-exists: never overwrite agent-curated memory
    if [ -f "$src_file" ] && [ ! -f "$dest_file" ]; then
      mkdir -p "$MEM_DEST/$agent_name"
      cp "$src_file" "$dest_file"
    fi
  done
fi

# --- Code index refresh ----------------------------------------------------
# Delegates to the Node.js helper for staleness-guarded build. The helper
# reads the config, checks staleness, and runs the build command only when
# needed. Failures are non-fatal — a stale or broken index does not block
# the session.

HELPER="$HOME/.claude/hooks/workspace-init-helper.js"
if [ -f "$HELPER" ]; then
  node "$HELPER" "$PROJECT_DIR" 2>/dev/null
fi

exit 0
