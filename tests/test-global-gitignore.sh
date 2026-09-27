#!/bin/zsh
#
# Test configure_global_gitignore / unconfigure_global_gitignore in isolation.
# Verifies that both .tasks/ and .claude/agent-memory/ are added and removed.
# Uses a temp HOME so git config --global never touches the real environment.

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Isolated HOME so git config --global writes to a temp .gitconfig
TEST_HOME=$(mktemp -d)
trap 'rm -rf "$TEST_HOME"' EXIT
export HOME="$TEST_HOME"

# Extract install.sh function definitions (everything before "# Main")
TEMP_SCRIPT=$(mktemp)
sed '/^# Main$/,$d' "$REPO_ROOT/install.sh" > "$TEMP_SCRIPT"
source "$TEMP_SCRIPT"
rm "$TEMP_SCRIPT"

# --- configure: both patterns should appear ---

configure_global_gitignore || true  # returns 1 when all patterns already exist

GITIGNORE_PATH=$(git config --global core.excludesFile)
GITIGNORE_PATH="${GITIGNORE_PATH/#\~/$HOME}"

grep -Fxq ".tasks/" "$GITIGNORE_PATH" || { echo "${RED}✗${NC} .tasks/ not found"; exit 1; }
echo "${GREEN}✓${NC} .tasks/ added to global gitignore"

grep -Fxq ".claude/agent-memory/" "$GITIGNORE_PATH" || { echo "${RED}✗${NC} .claude/agent-memory/ not found"; exit 1; }
echo "${GREEN}✓${NC} .claude/agent-memory/ added to global gitignore"

# --- idempotency: running again must not duplicate ---

configure_global_gitignore || true

TASKS_LINES=$(grep -Fx ".tasks/" "$GITIGNORE_PATH" | wc -l | tr -d ' ')
MEMORY_LINES=$(grep -Fx ".claude/agent-memory/" "$GITIGNORE_PATH" | wc -l | tr -d ' ')

[[ "$TASKS_LINES" -eq 1 ]] || { echo "${RED}✗${NC} .tasks/ duplicated ($TASKS_LINES)"; exit 1; }
echo "${GREEN}✓${NC} .tasks/ appears exactly once (idempotent)"

[[ "$MEMORY_LINES" -eq 1 ]] || { echo "${RED}✗${NC} .claude/agent-memory/ duplicated ($MEMORY_LINES)"; exit 1; }
echo "${GREEN}✓${NC} .claude/agent-memory/ appears exactly once (idempotent)"

# --- unconfigure: both patterns should be removed ---

unconfigure_global_gitignore || true

grep -Fxq ".tasks/" "$GITIGNORE_PATH" 2>/dev/null && { echo "${RED}✗${NC} .tasks/ not removed"; exit 1; }
echo "${GREEN}✓${NC} .tasks/ removed from global gitignore"

grep -Fxq ".claude/agent-memory/" "$GITIGNORE_PATH" 2>/dev/null && { echo "${RED}✗${NC} .claude/agent-memory/ not removed"; exit 1; }
echo "${GREEN}✓${NC} .claude/agent-memory/ removed from global gitignore"

echo ""
echo "${GREEN}All global gitignore tests passed${NC}"
