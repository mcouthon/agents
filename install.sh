#!/bin/zsh
#
# Agentic Coding Framework - Install/Uninstall Script
#
# Installs Agent Skills for auto-activation in:
# - GitHub Copilot (coding agent, CLI, VSCode)
# - Claude Code (via .claude/skills/ compatibility)
#
# Usage:
#   ./install.sh              # Install skills
#   ./install.sh uninstall    # Uninstall (also cleans up legacy symlinks)
#

set -e

# Configuration
SCRIPT_DIR="${0:A:h}"

# Skills directories (the only thing we install now)
SKILLS_TARGET_DIR="$HOME/.github/skills"
CLAUDE_SKILLS_TARGET_DIR="$HOME/.claude/skills"

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

# Show what will be linked
show_files() {
    echo "\n${BLUE}Skills to be installed:${NC}"
    for d in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$d" ]] && echo "    - $(basename "$d")/"
    done
    echo ""
}

# Install: Create symlinks for skills only
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR/.github/skills/"
    info "Target: $SKILLS_TARGET_DIR"
    
    show_files
    
    local count=0
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
        local dest="$SKILLS_TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "${src%/}" ]]; then
                skipped=$((skipped + 1))
                continue
            else
                warn "Replacing existing symlink: $name"
                rm "$dest"
            fi
        elif [[ -e "$dest" ]]; then
            warn "Backing up existing skill: $name → $name.backup"
            mv "$dest" "$dest.backup"
        fi
        
        ln -s "${src%/}" "$dest"
        success "Linked: $name"
        count=$((count + 1))
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
    
    echo ""
    success "Installation complete!"
    info "Created $count symlinks, $skipped already existed"
    echo ""
    info "Skills auto-activate based on your prompts. Just ask naturally:"
    info "  • 'How does X work?' → research-codebase"
    info "  • 'Create a plan to add Y' → create-plan"  
    info "  • 'Implement the plan' → implement-plan"
    echo ""
    info "Or switch explicitly: 'use research mode', 'use plan mode', etc."
    echo ""
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo "${YELLOW}  OPTIONAL: Enable Global Instructions${NC}"
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    info "To enable file-type coding standards globally, add to ~/.zshrc:"
    echo ""
    echo "    export COPILOT_CUSTOM_INSTRUCTIONS_DIRS=\"$SCRIPT_DIR/instructions\""
    echo ""
    info "Then restart your shell or run: source ~/.zshrc"
    echo ""
}

# Uninstall: Remove symlinks (skills + legacy cleanup)
uninstall() {
    info "Uninstalling Agentic Coding Framework..."
    
    local count=0
    
    # Remove Agent Skills symlinks
    info "Removing skills from $SKILLS_TARGET_DIR..."
    for src in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$SKILLS_TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "${src%/}" ]]; then
                rm "$dest"
                success "Removed: $name"
                count=$((count + 1))
            fi
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
    
    echo ""
    success "Uninstallation complete!"
    info "Removed $count symlinks"
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
        exit 1
        ;;
esac
