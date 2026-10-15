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

# Create a worktree via worktree.js and cd into it.
_create_worktree() {
  agent_lower=$(echo "$AGENT" | tr '[:upper:]' '[:lower:]')
  timestamp=$(date +%Y%m%d-%H%M%S)
  branch="wt/${agent_lower}-${timestamp}"
  wt_path=$(node "$dir/../worktree.js" add "$branch" --print-path) || exit 1
  cd "$wt_path" || exit 1
}

# Branch-aware worktree heuristic.
# - force_worktree=1 → always create a worktree (bypasses heuristic)
# - Already in a linked worktree → launch in place (no nesting)
# - On main/master → launch in place
# - On a branch fully merged to the default remote branch → switch to
#   default, pull, then launch in place
# - On an active (non-merged) branch → ask: continue here or create a worktree
# - Non-git or errors → launch in place
maybe_worktree() {
  # Explicit "worktree" keyword → always create
  if [ "${force_worktree:-0}" = 1 ]; then
    _create_worktree
    return $?
  fi

  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  main_root=$(dirname "$common_dir")

  # Already in a linked worktree — launch in place (no nesting)
  [ "$toplevel" = "$main_root" ] || return 0

  branch=$(git branch --show-current 2>/dev/null)
  # Detached HEAD or no branch → launch in place
  [ -n "$branch" ] || return 0

  # On main or master → no worktree
  case "$branch" in
    main|master) return 0 ;;
  esac

  # Check if branch is fully merged to the default remote branch
  default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  if [ -n "$default_branch" ]; then
    if git merge-base --is-ancestor "$branch" "origin/$default_branch" 2>/dev/null; then
      git checkout "$default_branch" && git pull || true
      return 0
    fi
  fi

  # Active (non-merged) branch → ask interactively
  if [ -t 0 ]; then
    printf "You're on branch '%s'. Continue here, or create a worktree?\n" "$branch"
    printf "  [1] Continue on this branch (default)\n"
    printf "  [2] Create a worktree\n"
    printf "Choice: "
    read choice || return 0
    case "$choice" in
      2) _create_worktree; return $? ;;
      *) return 0 ;;
    esac
  else
    return 0
  fi
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
# Accepts "continue" and "worktree" in any order (order-independent).
a_main() {
  continue_flag=0
  force_worktree=0
  for arg in "$@"; do
    case "$arg" in
      continue)  continue_flag=1 ;;
      worktree)  force_worktree=1 ;;
      *)
        prog=$(basename "$0")
        echo "Usage: $prog [continue] [worktree]" >&2
        echo "  (no args)    fresh interactive session" >&2
        echo "  continue     auto-detect task, pre-fill prompt" >&2
        echo "  worktree     force worktree creation" >&2
        exit 1
        ;;
    esac
  done
  if [ "$continue_flag" = 1 ]; then
    launch continue
  else
    launch bare
  fi
}
