#!/bin/zsh
#
# Agentic Coding Framework - Install/Uninstall Script
#
# Installs:
# - Custom Agents (workflow modes with tool restrictions and handoffs)
# - Agent Skills (auto-activated specialized capabilities)
#
# For GitHub Copilot (coding agent, CLI, VSCode) and Claude Code
#
# Usage:
#   ./install.sh              # Install agents and skills
#   ./install.sh uninstall    # Uninstall
#

set -e

# Configuration
SCRIPT_DIR="${0:A:h}"

# Target directories
SKILLS_TARGET_DIR="$HOME/.github/skills"
CLAUDE_SKILLS_TARGET_DIR="$HOME/.claude/skills"

# Agent target directories
VSCODE_PROMPTS_DIR="$HOME/Library/Application Support/Code/User/prompts"
CLAUDE_AGENTS_DIR="$HOME/.claude/agents"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() { echo "${BLUE}ℹ${NC} $1"; }
success() { echo "${GREEN}✓${NC} $1"; }
warn() { echo "${YELLOW}⚠${NC} $1"; }
error() { echo "${RED}✗${NC} $1"; exit 1; }

# Create symlink, backing up existing files
# Returns 0 if link created, 1 if already correct
link_file() {
    local src="$1" dest="$2" name="${3:-$(basename "$src")}"
    
    if [[ -L "$dest" ]]; then
        [[ "$(readlink "$dest")" == "$src" ]] && return 1  # Already correct
        rm "$dest"
    elif [[ -e "$dest" ]]; then
        warn "Backing up: $name → $name.backup"
        mv "$dest" "$dest.backup"
    fi
    
    ln -s "$src" "$dest"
    return 0
}

# Remove symlink if it points to our source
# Returns 0 if removed, 1 if not ours
unlink_if_ours() {
    local src="$1" dest="$2"
    [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]] && rm "$dest" && return 0
    return 1
}

# Show what will be linked
show_files() {
    echo "\n${BLUE}Custom Agents (workflow modes):${NC}"
    for f in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$f" ]] && echo "    - $(basename "$f")"
    done
    
    echo "\n${BLUE}Agent Skills (auto-activated capabilities):${NC}"
    for d in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$d" ]] && echo "    - $(basename "$d")/"
    done
    echo ""
}

# Install: Create symlinks for skills globally
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR/.github/"
    info "Target: ~/.github/"
    
    show_files
    
    local skill_count=0
    local skipped=0
    
    # Create global skills directory if it doesn't exist
    if [[ ! -d "$SKILLS_TARGET_DIR" ]]; then
        info "Creating global skills directory..."
        mkdir -p "$SKILLS_TARGET_DIR"
    fi
    
    # Link Agent Skills directories
    for src in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "${src%/}" "$SKILLS_TARGET_DIR/$name" "$name"; then
            success "Linked skill: $name"
            skill_count=$((skill_count + 1))
        else
            skipped=$((skipped + 1))
        fi
    done
    
    # Create Claude Code compatibility symlink
    if [[ ! -L "$CLAUDE_SKILLS_TARGET_DIR" ]]; then
        info "Creating Claude Code compatibility symlink..."
        mkdir -p "$(dirname "$CLAUDE_SKILLS_TARGET_DIR")"
        if ln -s "$SKILLS_TARGET_DIR" "$CLAUDE_SKILLS_TARGET_DIR" 2>/dev/null; then
            success "Created: ~/.claude/skills → ~/.github/skills"
        fi
    elif [[ "$(readlink "$CLAUDE_SKILLS_TARGET_DIR")" == "$SKILLS_TARGET_DIR" ]]; then
        info "Claude Code symlink already exists"
    fi
    
    # Install agents to VS Code prompts folder
    info "Installing agents to VS Code prompts folder..."
    if [[ ! -d "$VSCODE_PROMPTS_DIR" ]]; then
        mkdir -p "$VSCODE_PROMPTS_DIR"
    fi
    
    local agent_count=0
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "$src" "$VSCODE_PROMPTS_DIR/$name" "$name"; then
            success "Linked agent: $name"
            agent_count=$((agent_count + 1))
        fi
    done
    
    # Install agents to Claude Code agents folder
    info "Installing agents to Claude Code agents folder..."
    if [[ ! -d "$CLAUDE_AGENTS_DIR" ]]; then
        mkdir -p "$CLAUDE_AGENTS_DIR"
    fi
    
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        link_file "$src" "$CLAUDE_AGENTS_DIR/$(basename "$src")" || true
    done
    
    # Install instructions to VS Code prompts folder
    info "Installing instructions to VS Code prompts folder..."
    local instruction_count=0
    for src in "$SCRIPT_DIR"/instructions/*.instructions.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "$src" "$VSCODE_PROMPTS_DIR/$name" "$name"; then
            success "Linked instruction: $name"
            instruction_count=$((instruction_count + 1))
        fi
    done
    
    echo ""
    success "Installation complete!"
    info "Installed $agent_count agents, $skill_count skills, and $instruction_count instructions"
    echo ""
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo "${YELLOW}  Agents are now available globally${NC}"
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    info "Agents installed to:"
    info "  • VS Code: ~/Library/Application Support/Code/User/prompts/"
    info "  • Claude Code: ~/.claude/agents/"
    echo ""
    info "Skills installed to:"
    info "  • ~/.github/skills/ (with ~/.claude/skills symlink)"
    echo ""
    info "Instructions installed to:"
    info "  • VS Code: ~/Library/Application Support/Code/User/prompts/"
    echo ""
}

# Uninstall: Remove symlinks (skills only)
uninstall() {
    info "Uninstalling Agentic Coding Framework..."
    
    local skill_count=0
    local agent_count=0
    local instruction_count=0
    
    # Remove Agent Skills symlinks
    info "Removing skills from $SKILLS_TARGET_DIR..."
    for src in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "${src%/}" "$SKILLS_TARGET_DIR/$name"; then
            success "Removed skill: $name"
            skill_count=$((skill_count + 1))
        fi
    done
    
    # Remove Claude Code compatibility symlink
    if [[ -L "$CLAUDE_SKILLS_TARGET_DIR" ]]; then
        local current_target=$(readlink "$CLAUDE_SKILLS_TARGET_DIR")
        if [[ "$current_target" == "$SKILLS_TARGET_DIR" ]]; then
            rm "$CLAUDE_SKILLS_TARGET_DIR"
            success "Removed: Claude Code compatibility symlink"
        fi
    fi
    
    # Remove agents from VS Code prompts folder
    info "Removing agents from VS Code prompts folder..."
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "$src" "$VSCODE_PROMPTS_DIR/$name"; then
            success "Removed agent: $name"
            agent_count=$((agent_count + 1))
        fi
    done
    
    # Remove agents from Claude Code agents folder
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        unlink_if_ours "$src" "$CLAUDE_AGENTS_DIR/$(basename "$src")" || true
    done
    
    # Remove instructions from VS Code prompts folder
    info "Removing instructions from VS Code prompts folder..."
    for src in "$SCRIPT_DIR"/instructions/*.instructions.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "$src" "$VSCODE_PROMPTS_DIR/$name"; then
            success "Removed instruction: $name"
            instruction_count=$((instruction_count + 1))
        fi
    done
    
    echo ""
    success "Uninstallation complete!"
    info "Removed $agent_count agents, $skill_count skills, and $instruction_count instructions"
}

# Main
case "${1:-install}" in
    install)
        install
        ;;
    uninstall)
        uninstall
        ;;
    *)
        echo "Usage: $0 [install|uninstall]"
        echo ""
        echo "Commands:"
        echo "  install    Install agents and skills globally"
        echo "  uninstall  Remove global agent and skill symlinks"
        exit 1
        ;;
esac
