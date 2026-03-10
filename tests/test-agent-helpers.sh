#!/bin/zsh
#
# Tests for scripts/bin/a-* shell helpers.
# Tests the helper scripts in isolation (does not require claude CLI).
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo "${BLUE}i${NC} $1"; }
success() { echo "${GREEN}ok${NC} $1"; }
error() { echo "${RED}FAIL${NC} $1"; exit 1; }

BIN_DIR="$REPO_ROOT/scripts/bin"

# Create a temporary workspace
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Create a fake 'claude' shim that records invocations
SHIM_DIR="$TEST_DIR/shims"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/claude" << 'SHIM'
#!/bin/sh
echo "CLAUDE_ARGS=$*"
SHIM
chmod +x "$SHIM_DIR/claude"

# Put shim first in PATH so scripts find it instead of real claude
export PATH="$SHIM_DIR:$BIN_DIR:$PATH"

echo "Testing scripts/bin/a-* helpers..."
echo ""

# --- Test 1: All 5 helper scripts exist and are executable ---
info "Test 1: Scripts exist and are executable"
for name in a-explorer a-builder a-reviewer a-committer a-conductor; do
    if [[ ! -x "$BIN_DIR/$name" ]]; then
        error "Script not found or not executable: $name"
    fi
done
success "All 5 helper scripts exist and are executable"

# --- Test 2: No a-researcher or a-worker scripts ---
info "Test 2: Leaf agent scripts do not exist"
for name in a-researcher a-worker; do
    if [[ -f "$BIN_DIR/$name" ]]; then
        error "Leaf agent script should not exist: $name"
    fi
done
success "No leaf agent helper scripts"

# --- Test 3: Bare invocation (no args) ---
info "Test 3: Bare invocation"
result=$(cd "$TEST_DIR" && a-builder)
[[ "$result" == "CLAUDE_ARGS=--agent Builder" ]] || error "Expected bare invocation, got: $result"
success "Bare invocation passes correct args"

# --- Test 4: Custom prompt passthrough ---
info "Test 4: Custom prompt"
result=$(cd "$TEST_DIR" && a-builder "Build the login page")
[[ "$result" == "CLAUDE_ARGS=--agent Builder Build the login page" ]] || error "Expected custom prompt, got: $result"
success "Custom prompt passed through"

# --- Test 5: 'continue' with no .tasks/ directory ---
info "Test 5: 'continue' with no .tasks/"
cd "$TEST_DIR"
rm -rf "$TEST_DIR/.tasks"
if a-explorer continue 2>/dev/null; then
    error "Should exit 1 when no task found"
fi
success "'continue' exits 1 when no .tasks/"

# --- Test 6: 'continue' finds most recent task ---
info "Test 6: 'continue' finds task"
mkdir -p "$TEST_DIR/.tasks/001-first-task"
mkdir -p "$TEST_DIR/.tasks/002-second-task"
sleep 1
touch "$TEST_DIR/.tasks/002-second-task"
cd "$TEST_DIR"
result=$(a-builder continue 2>/dev/null)
# Should contain the task slug and correct agent
[[ "$result" == *"CLAUDE_ARGS=--agent Builder Continue task 002-second-task"* ]] || error "Expected continue with task, got: $result"
success "'continue' finds most recent task"

# --- Test 7: 'continue' ignores non-NNN directories ---
info "Test 7: Ignores non-NNN dirs"
rm -rf "$TEST_DIR/.tasks"
mkdir -p "$TEST_DIR/.tasks/notes"
mkdir -p "$TEST_DIR/.tasks/random"
cd "$TEST_DIR"
if a-explorer continue 2>/dev/null; then
    error "Should exit 1 when no NNN-* task found"
fi
success "'continue' ignores non-matching directories"

# --- Test 8: Agent name capitalization for all 5 helpers ---
info "Test 8: Agent name capitalization"
cd "$TEST_DIR"
for pair in "a-explorer:Explorer" "a-builder:Builder" "a-reviewer:Reviewer" "a-committer:Committer" "a-conductor:Conductor"; do
    cmd="${pair%%:*}"
    expected="${pair##*:}"
    result=$($cmd)
    [[ "$result" == "CLAUDE_ARGS=--agent $expected" ]] || error "$cmd: expected agent '$expected', got: $result"
done
success "All 5 helpers use correct capitalized agent names"

# --- Test 9: install.sh helpers subcommand ---
info "Test 9: install.sh helpers"
TEST_PREFIX=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$TEST_PREFIX"' EXIT
export INSTALL_PREFIX="$TEST_PREFIX"
HOME_DIR="$TEST_PREFIX$HOME"
"$REPO_ROOT/install.sh" helpers > /dev/null
# Check symlinks exist
for name in a-explorer a-builder a-reviewer a-committer a-conductor; do
    if [[ ! -L "$HOME_DIR/.local/bin/$name" ]]; then
        error "Helper symlink not created: $name"
    fi
    if [[ "$(readlink "$HOME_DIR/.local/bin/$name")" != "$BIN_DIR/$name" ]]; then
        error "Helper symlink points to wrong target: $name"
    fi
done
success "install.sh helpers creates symlinks"

# --- Test 10: install.sh uninstall-helpers ---
info "Test 10: install.sh uninstall-helpers"
"$REPO_ROOT/install.sh" uninstall-helpers > /dev/null
for name in a-explorer a-builder a-reviewer a-committer a-conductor; do
    if [[ -L "$HOME_DIR/.local/bin/$name" ]]; then
        error "Helper symlink not removed: $name"
    fi
done
success "install.sh uninstall-helpers removes symlinks"

# Reset
unset INSTALL_PREFIX

echo ""
echo "${GREEN}All agent helper tests passed${NC}"
