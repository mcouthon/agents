#!/bin/bash
# Test script for hooks/worktree-heuristic.sh
# Creates temp repos and exercises all branch cases + guards.
#
# Run: npm run test:worktree-heuristic

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$SCRIPT_DIR/hooks/worktree-heuristic.sh"
WORKTREE_JS="$SCRIPT_DIR/scripts/worktree.js"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup_worktrees() {
  local repo="$1"
  (
    cd "$repo" 2>/dev/null || exit 0
    git worktree list --porcelain 2>/dev/null | grep "^worktree " | \
      while read -r _ wt_path; do
        if [ "$wt_path" != "$repo" ]; then
          git worktree remove --force "$wt_path" 2>/dev/null || true
        fi
      done
    git worktree prune 2>/dev/null || true
    git branch 2>/dev/null | grep 'wt/' | while read -r b; do
      git branch -D "$b" 2>/dev/null || true
    done
  ) 2>/dev/null || true
}

setup_repo() {
  local tmp
  tmp=$(mktemp -d)
  git init --bare "$tmp/remote.git" >/dev/null 2>&1
  git init "$tmp/repo" >/dev/null 2>&1
  (
    cd "$tmp/repo"
    git config user.email "test@test.com"
    git config user.name "Test"
    git remote add origin "$tmp/remote.git"
    echo "test" > README.md
    git add README.md
    git commit -m "initial" >/dev/null 2>&1
    git branch -M main
    git push -u origin main >/dev/null 2>&1
    git remote set-head origin main >/dev/null 2>&1
    mkdir -p scripts
    cp "$WORKTREE_JS" scripts/worktree.js
  ) >/dev/null 2>&1
  echo "$tmp"
}

# --- Tests ---

# Given a repo on main, When the hook fires, Then no output.
test_main_branch() {
  local tmp="$1" output
  output=$(cd "$tmp/repo" && bash "$HOOK" < /dev/null 2>/dev/null) || true
  if [ -z "$output" ]; then
    pass "main branch produces no output"
  else
    fail "main branch should produce no output, got: $output"
  fi
}

# Given a repo on an active (non-merged) branch, When the hook fires,
# Then context lines telling the agent to ask the user.
test_active_branch() {
  local tmp="$1" output
  (
    cd "$tmp/repo"
    git checkout -b feature-branch >/dev/null 2>&1
    echo "change" > file.txt
    git add file.txt
    git commit -m "feature" >/dev/null 2>&1
  ) >/dev/null 2>&1
  output=$(cd "$tmp/repo" && bash "$HOOK" < /dev/null 2>/dev/null) || true
  if echo "$output" | grep -q "active branch"; then
    pass "active branch produces context output"
  else
    fail "active branch should produce context output, got: $output"
  fi
  (cd "$tmp/repo" && git checkout main >/dev/null 2>&1 && git branch -D feature-branch >/dev/null 2>&1) 2>/dev/null || true
}

# Given a branch fully merged to origin/main, When the hook fires,
# Then the hook switches to main and outputs a confirmation.
test_merged_branch() {
  local tmp="$1" output
  (
    cd "$tmp/repo"
    git checkout -b merged-branch >/dev/null 2>&1
    echo "merged" > merged.txt
    git add merged.txt
    git commit -m "merged feature" >/dev/null 2>&1
    git checkout main >/dev/null 2>&1
    git merge merged-branch >/dev/null 2>&1
    git push origin main >/dev/null 2>&1
    git checkout merged-branch >/dev/null 2>&1
  ) >/dev/null 2>&1
  output=$(cd "$tmp/repo" && bash "$HOOK" < /dev/null 2>/dev/null) || true
  if echo "$output" | grep -q "Switched to main"; then
    pass "merged branch switches to main"
  else
    fail "merged branch should switch to main, got: $output"
  fi
  (cd "$tmp/repo" && git checkout main >/dev/null 2>&1 && git branch -D merged-branch >/dev/null 2>&1) 2>/dev/null || true
}

# Given the session is inside a linked worktree, When the hook fires,
# Then no output (no nesting).
test_in_worktree() {
  local tmp="$1" wt_path output
  wt_path=$(cd "$tmp/repo" && node scripts/worktree.js add --auto --print-path 2>/dev/null) || true
  if [ -z "$wt_path" ] || [ ! -d "$wt_path" ]; then
    echo "  SKIP: could not create worktree for in-worktree test"
    return 0
  fi
  output=$(cd "$wt_path" && bash "$HOOK" < /dev/null 2>/dev/null) || true
  if [ -z "$output" ]; then
    pass "in-worktree produces no output"
  else
    fail "in-worktree should produce no output, got: $output"
  fi
  cleanup_worktrees "$tmp/repo"
}

# Given a non-git directory, When the hook fires, Then no output.
test_non_git() {
  local nongit output
  nongit=$(mktemp -d)
  output=$(cd "$nongit" && bash "$HOOK" < /dev/null 2>/dev/null) || true
  if [ -z "$output" ]; then
    pass "non-git directory produces no output"
  else
    fail "non-git directory should produce no output, got: $output"
  fi
  rm -rf "$nongit" 2>/dev/null || true
}

# Given stdin JSON carries agent_id (subagent), When the hook fires,
# Then no output (subagent safety guard).
test_subagent_guard() {
  local tmp="$1" output
  (
    cd "$tmp/repo"
    git checkout -b some-branch >/dev/null 2>&1
  ) >/dev/null 2>&1
  output=$(cd "$tmp/repo" && printf '{"agent_id":"sub123","agent_type":"Builder"}' | bash "$HOOK" 2>/dev/null) || true
  if [ -z "$output" ]; then
    pass "subagent (agent_id in stdin) produces no output"
  else
    fail "subagent should produce no output, got: $output"
  fi
  (cd "$tmp/repo" && git checkout main >/dev/null 2>&1 && git branch -D some-branch 2>/dev/null) || true
}

main() {
  echo "=== worktree-heuristic.sh tests ==="
  local tmp
  tmp=$(setup_repo)
  if [ -z "$tmp" ] || [ ! -d "$tmp/repo" ]; then
    echo "FAIL: could not create test repo"
    exit 1
  fi
  trap "rm -rf '$tmp' 2>/dev/null || true" EXIT

  test_main_branch "$tmp"
  test_active_branch "$tmp"
  test_merged_branch "$tmp"
  test_in_worktree "$tmp"
  test_non_git
  test_subagent_guard "$tmp"

  echo ""
  echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
