# AGENTS framework -- shared launcher core (sourced by a-* wrappers, never on PATH)
# Provides: current_task, agent_file_check, maybe_worktree, launch, a_main

# Find the most recently modified NNN-* task directory.
# Falls back to the main checkout's .tasks/ when PWD has none (fresh worktree
# has no .tasks/ — it's untracked). Mirrors state-server.js deriveMainWorktreeRoot().
current_task() {
  tasks_dir="${PWD}/.tasks"
  if [ -d "$tasks_dir" ]; then
    result=$(ls -t "$tasks_dir" 2>/dev/null | grep -E '^[0-9]{3}-' | head -1)
    if [ -n "$result" ]; then
      echo "$result"
      return
    fi
  fi
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  main_root=$(dirname "$common_dir")
  main_tasks="${main_root}/.tasks"
  if [ -d "$main_tasks" ]; then
    ls -t "$main_tasks" 2>/dev/null | grep -E '^[0-9]{3}-' | head -1
  fi
}

# Verify the target agent file exists in the installed location.
agent_file_check() {
  agent_lower=$(echo "$AGENT" | tr '[:upper:]' '[:lower:]')
  agent_file="${HOME}/.claude/agents/${agent_lower}.md"
  if [ ! -f "$agent_file" ]; then
    echo "Agent file not found: $agent_file" >&2
    echo "Run 'make && ./install.sh' to install agents." >&2
    exit 1
  fi
}

# If invoked from the main checkout, auto-create a worktree and cd into it.
# If already in a linked worktree or a non-git directory, launch in place.
maybe_worktree() {
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  main_root=$(dirname "$common_dir")

  # Already in a linked worktree — launch in place
  [ "$toplevel" = "$main_root" ] || return 0

  # Main checkout — auto-create a worktree
  agent_lower=$(echo "$AGENT" | tr '[:upper:]' '[:lower:]')
  timestamp=$(date +%Y%m%d-%H%M%S)
  branch="wt/${agent_lower}-${timestamp}"

  wt_path=$(node "$dir/../worktree.js" add "$branch" --print-path) || exit 1
  cd "$wt_path" || exit 1
}

# Resolve mode, then create worktree (if applicable), then exec the agent.
# Task resolution happens BEFORE worktree creation so a missing task fails
# fast with no stray git state.
launch() {
  mode="$1"
  agent_file_check

  case "$mode" in
    continue)
      task=$(current_task)
      if [ -z "$task" ]; then
        echo "No task found in .tasks/" >&2
        exit 1
      fi
      maybe_worktree
      echo "-> Continuing task: $task"
      exec claude --agent "$AGENT" "Continue task $task"
      ;;
    bare)
      maybe_worktree
      exec claude --agent "$AGENT"
      ;;
  esac
}

# Entry point called by thin wrappers.
a_main() {
  case "${1:-}" in
    "")       launch bare ;;
    continue) launch continue ;;
    *)
      prog=$(basename "$0")
      echo "Usage: $prog [continue]" >&2
      echo "  (no args)  fresh interactive session" >&2
      echo "  continue   auto-detect task, pre-fill prompt" >&2
      exit 1
      ;;
  esac
}
