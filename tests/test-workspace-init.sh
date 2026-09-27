#!/bin/zsh
#
# Tests for hooks/workspace-init.sh (SessionStart hook):
#   - Memory seeding (create-if-not-exists, idempotent)
#   - Code index refresh (staleness check, build if stale)
#   - Always exits 0 (never blocks session start)
#
# Uses an isolated temp directory so no real ~/.claude/ paths are touched.

set -uo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"
HOOK_SRC="$REPO_ROOT/hooks/workspace-init.sh"
HELPER_SRC="$REPO_ROOT/hooks/workspace-init-helper.js"

PASS=0
FAIL=0

pass() { echo "OK $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

# Isolated environment
TEST_PREFIX=$(mktemp -d)
trap 'rm -rf "$TEST_PREFIX"' EXIT

# Simulate installed layout: ~/.claude/agents/memory/ with seed files
FAKE_HOME="$TEST_PREFIX/home"
mkdir -p "$FAKE_HOME/.claude/hooks"
mkdir -p "$FAKE_HOME/.claude/agents/memory"
cp "$HOOK_SRC" "$FAKE_HOME/.claude/hooks/workspace-init.sh"
cp "$HELPER_SRC" "$FAKE_HOME/.claude/hooks/workspace-init-helper.js"
chmod +x "$FAKE_HOME/.claude/hooks/workspace-init.sh"

# Copy seed files to the installed location (what install.sh would do)
# Only conductor has a memory seed file (Phase 3 simplification)
for agent in conductor; do
  mkdir -p "$FAKE_HOME/.claude/agents/memory/$agent"
  cp "$REPO_ROOT/templates/agents/memory/$agent/MEMORY.md" \
     "$FAKE_HOME/.claude/agents/memory/$agent/MEMORY.md"
done

# Helper to create a git-initialized project dir
mk_project() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
}

echo "Testing workspace-init SessionStart hook..."
echo ""

# --- Test 1: Memory seeding — creates files when none exist ---------------

PROJECT_DIR="$TEST_PREFIX/project"
mk_project "$PROJECT_DIR"

result=$(CLAUDE_PROJECT_DIR="$PROJECT_DIR" HOME="$FAKE_HOME" "$FAKE_HOME/.claude/hooks/workspace-init.sh" 2>/dev/null)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-1: hook exits 0 on first run"
else
  fail "WI-1: hook should exit 0, got $exit_code"
fi

all_created=true
for agent in conductor; do
  mem_file="$PROJECT_DIR/.claude/agent-memory/$agent/MEMORY.md"
  if [[ ! -f "$mem_file" ]]; then
    fail "WI-1: memory file not created: $agent/MEMORY.md"
    all_created=false
  fi
done
if $all_created; then
  pass "WI-1: conductor memory file seeded"
fi

# --- Test 2: Idempotent — preserves existing (curated) memory -------------

# Simulate curation: modify one memory file
curated_file="$PROJECT_DIR/.claude/agent-memory/conductor/MEMORY.md"
echo "" >> "$curated_file"
echo "## Curated Knowledge" >> "$curated_file"
echo "- Test entry" >> "$curated_file"

result=$(CLAUDE_PROJECT_DIR="$PROJECT_DIR" HOME="$FAKE_HOME" "$FAKE_HOME/.claude/hooks/workspace-init.sh" 2>/dev/null)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-2: hook exits 0 on second run"
else
  fail "WI-2: hook should exit 0, got $exit_code"
fi

if grep -q "Curated Knowledge" "$curated_file"; then
  pass "WI-2: curated memory preserved on re-run (create-if-not-exists)"
else
  fail "WI-2: curated memory was overwritten"
fi

# --- Test 3: Exit 0 even when seed source is missing ----------------------

EMPTY_PROJECT="$TEST_PREFIX/empty-project"
mk_project "$EMPTY_PROJECT"

# Use a HOME with no seed files
EMPTY_HOME="$TEST_PREFIX/empty-home"
mkdir -p "$EMPTY_HOME/.claude/hooks"

result=$(CLAUDE_PROJECT_DIR="$EMPTY_PROJECT" HOME="$EMPTY_HOME" "$FAKE_HOME/.claude/hooks/workspace-init.sh" 2>/dev/null)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-3: hook exits 0 when seed source is missing"
else
  fail "WI-3: hook should exit 0 even without seed source, got $exit_code"
fi

# --- Test 4: Helper exits 0 when code_index not configured ----------------

# Point AGENTS_CONFIG_PATH to a non-existent file so no config is found
result=$(AGENTS_CONFIG_PATH="$TEST_PREFIX/no-config.json" node "$HELPER_SRC" "$PROJECT_DIR" 2>&1)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-4: helper exits 0 when code_index not configured"
else
  fail "WI-4: helper should exit 0, got $exit_code"
fi
if [[ "$result" == *"not configured"* ]]; then
  pass "WI-4: helper reports 'not configured' when no config exists"
else
  fail "WI-4: helper should report not configured, got: $result"
fi

# --- Test 5: Helper runs build when graph is stale ------------------------

STALE_PROJECT="$TEST_PREFIX/stale-project"
mk_project "$STALE_PROJECT"

# Create a code file (newer than the graph)
echo 'console.log("test");' > "$STALE_PROJECT/app.js"
git -C "$STALE_PROJECT" add app.js
git -C "$STALE_PROJECT" commit -m "test" --quiet

# Create an old graph file
mkdir -p "$STALE_PROJECT/graphify-out"
echo '{}' > "$STALE_PROJECT/graphify-out/graph.json"
# Make graph.json much older than app.js
touch -t 202001010000 "$STALE_PROJECT/graphify-out/graph.json"

# Create a config that uses a simple build command
mkdir -p "$FAKE_HOME/.agents"
cat > "$FAKE_HOME/.agents/config.json" << 'CFG'
{
  "code_index": {
    "build": "echo 'build-ran' > graphify-out/build-marker.txt",
    "graph_file": "graphify-out/graph.json"
  }
}
CFG

result=$(AGENTS_CONFIG_PATH="$FAKE_HOME/.agents/config.json" node "$HELPER_SRC" "$STALE_PROJECT" 2>&1)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-5: helper exits 0 after running build"
else
  fail "WI-5: helper should exit 0, got $exit_code"
fi
if [[ "$result" == *"built"* ]]; then
  pass "WI-5: helper reports build ran for stale index"
else
  fail "WI-5: helper should report build, got: $result"
fi
if [[ -f "$STALE_PROJECT/graphify-out/build-marker.txt" ]]; then
  pass "WI-5: build command was actually executed"
else
  fail "WI-5: build command was not executed"
fi

# --- Test 6: Helper skips build when graph is fresh -----------------------

# Make graph.json newer than app.js
touch "$STALE_PROJECT/graphify-out/graph.json"

result=$(AGENTS_CONFIG_PATH="$FAKE_HOME/.agents/config.json" node "$HELPER_SRC" "$STALE_PROJECT" 2>&1)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-6: helper exits 0 when index is fresh"
else
  fail "WI-6: helper should exit 0, got $exit_code"
fi
if [[ "$result" == *"fresh"* ]]; then
  pass "WI-6: helper reports fresh — skipping build"
else
  fail "WI-6: helper should report fresh, got: $result"
fi

# --- Test 7: Helper runs build when graph is missing ----------------------

MISSING_PROJECT="$TEST_PREFIX/missing-project"
mk_project "$MISSING_PROJECT"
echo 'console.log("test");' > "$MISSING_PROJECT/app.js"
git -C "$MISSING_PROJECT" add app.js
git -C "$MISSING_PROJECT" commit -m "test" --quiet
# Create the graphify-out dir but NOT the graph.json file (graph is "missing")
mkdir -p "$MISSING_PROJECT/graphify-out"

result=$(AGENTS_CONFIG_PATH="$FAKE_HOME/.agents/config.json" node "$HELPER_SRC" "$MISSING_PROJECT" 2>&1)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-7: helper exits 0 when graph is missing"
else
  fail "WI-7: helper should exit 0, got $exit_code"
fi
if [[ "$result" == *"built"* ]]; then
  pass "WI-7: helper runs build when graph file is missing"
else
  fail "WI-7: helper should run build for missing graph, got: $result"
fi

# --- Test 8: Helper exits 0 on build failure (non-fatal) ------------------

FAIL_PROJECT="$TEST_PREFIX/fail-project"
mk_project "$FAIL_PROJECT"
echo 'console.log("test");' > "$FAIL_PROJECT/app.js"
git -C "$FAIL_PROJECT" add app.js
git -C "$FAIL_PROJECT" commit -m "test" --quiet

# Config with a build command that will fail
cat > "$FAKE_HOME/.agents/config.json" << 'CFG'
{
  "code_index": {
    "build": "false",
    "graph_file": "graphify-out/graph.json"
  }
}
CFG

result=$(AGENTS_CONFIG_PATH="$FAKE_HOME/.agents/config.json" node "$HELPER_SRC" "$FAIL_PROJECT" 2>&1)
exit_code=$?
if [[ $exit_code -eq 0 ]]; then
  pass "WI-8: helper exits 0 even when build command fails"
else
  fail "WI-8: helper should exit 0 on build failure, got $exit_code"
fi
if [[ "$result" == *"failed"* ]]; then
  pass "WI-8: helper reports build failure"
else
  fail "WI-8: helper should report failure, got: $result"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
