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

# Verify agent symlinks exist in global agents directory
VSCODE_AGENTS_DIR="$HOME/.copilot/agents"
for agent in "$REPO_ROOT"/.github/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ ! -L "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Agent symlink not created: $name"
    fi
done
success "Agent symlinks created"

# Verify skill symlinks exist
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ ! -L "$HOME/.copilot/skills/$name" ]]; then
        error "Skill symlink not created: $name"
    fi
done
success "Skill symlinks created"

if [[ -L "$CLAUDE_SKILLS_DIR" ]]; then
    error "~/.claude/skills should be a directory, not a symlink"
fi
for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ ! -L "$CLAUDE_SKILLS_DIR/$name" ]]; then
        error "Claude skill symlink not created: $name"
    fi
done
success "Claude skill symlinks created"

# Verify instruction symlinks exist in global instructions directory
VSCODE_INSTRUCTIONS_DIR="$HOME/.copilot/instructions"
for instr in "$REPO_ROOT"/instructions/*.instructions.md; do
    [[ -f "$instr" ]] || continue
    name=$(basename "$instr")
    if [[ ! -L "$VSCODE_INSTRUCTIONS_DIR/$name" ]]; then
        error "Instruction symlink not created: $name"
    fi
done
success "Instruction symlinks created"

# Verify Claude Code commands exist (generated files, not symlinks)
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"
command_count=0
for agent in "$REPO_ROOT"/.github/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    # Command files are named after the agent prefix (e.g., explore.agent.md -> explore.md)
    name=$(basename "$agent" .agent.md)
    if [[ -f "$CLAUDE_COMMANDS_DIR/$name.md" ]]; then
        command_count=$((command_count + 1))
    fi
done
if [[ $command_count -eq 0 ]]; then
    error "No Claude Code commands created in $CLAUDE_COMMANDS_DIR"
fi
success "Claude Code commands created ($command_count files)"

# Verify global gitignore contains .tasks/ pattern
gitignore_global=$(git config --global core.excludesFile 2>/dev/null || echo "")
if [[ -n "$gitignore_global" ]]; then
    gitignore_global="${gitignore_global/#\~/$HOME}"
    if ! grep -Fxq ".tasks/" "$gitignore_global" 2>/dev/null; then
        error "Global gitignore does not contain .tasks/ pattern"
    fi
    success "Global gitignore configured with .tasks/"
else
    error "Global gitignore not configured"
fi

# Test uninstall
info "Running uninstall..."
"$REPO_ROOT/install.sh" uninstall > /dev/null

# Verify agent symlinks removed
for agent in "$REPO_ROOT"/.github/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ -L "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Agent symlink not removed: $name"
    fi
done
success "Agent symlinks removed"

# Verify skill symlinks removed
for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ -L "$HOME/.copilot/skills/$name" ]]; then
        error "Skill symlink not removed: $name"
    fi
done
success "Skill symlinks removed"

for skill in "$REPO_ROOT"/.github/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ -L "$CLAUDE_SKILLS_DIR/$name" ]]; then
        error "Claude skill symlink not removed: $name"
    fi
done
success "Claude skill symlinks removed"

# Verify instruction symlinks removed
for instr in "$REPO_ROOT"/instructions/*.instructions.md; do
    [[ -f "$instr" ]] || continue
    name=$(basename "$instr")
    if [[ -L "$VSCODE_INSTRUCTIONS_DIR/$name" ]]; then
        error "Instruction symlink not removed: $name"
    fi
done
success "Instruction symlinks removed"

# Verify Claude Code commands removed
for agent in "$REPO_ROOT"/.github/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent" .agent.md)
    if [[ -f "$CLAUDE_COMMANDS_DIR/$name.md" ]]; then
        error "Claude Code command not removed: $name.md"
    fi
done
success "Claude Code commands removed"

# Re-install for normal use
info "Re-installing for normal use..."
"$REPO_ROOT/install.sh" > /dev/null
success "Re-install complete"

echo ""
echo "${GREEN}All install tests passed${NC}"
