#!/bin/zsh
#
# Test install and uninstall
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo "${BLUE}ℹ${NC} $1"; }
success() { echo "${GREEN}✓${NC} $1"; }
error() { echo "${RED}✗${NC} $1"; exit 1; }

echo "Testing install script..."
echo ""

# Test install
info "Running install..."
"$REPO_ROOT/install.sh" > /dev/null

# Verify symlinks exist
for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ ! -L "$HOME/.github/skills/$name" ]]; then
        error "Symlink not created: $name"
    fi
done
success "Install successful - all symlinks created"

# Test uninstall
info "Running uninstall..."
"$REPO_ROOT/install.sh" uninstall > /dev/null

# Verify symlinks removed
for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ -L "$HOME/.github/skills/$name" ]]; then
        error "Symlink not removed: $name"
    fi
done
success "Uninstall successful - all symlinks removed"

# Re-install for normal use
info "Re-installing for normal use..."
"$REPO_ROOT/install.sh" > /dev/null
success "Re-install complete"

echo ""
echo "${GREEN}All install tests passed${NC}"
