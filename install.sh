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
AGENTS_TARGET_DIR="$HOME/.github/agents"
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
    echo "\n${BLUE}Custom Agents (workflow modes with enforced tool access):${NC}"
    for f in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$f" ]] && echo "    - $(basename "$f")"
    done
    
    echo "\n${BLUE}Agent Skills (auto-activated capabilities):${NC}"
    for d in "$SCRIPT_DIR"/.github/skills/*/; do
        [[ -d "$d" ]] && echo "    - $(basename "$d")/"
    done
    echo ""
}

# Install: Create symlinks for agents and skills
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR/.github/"
    info "Target: ~/.github/"
    
    show_files
    
    local agent_count=0
    local skill_count=0
    local skipped=0
    
    # Create global agents directory if it doesn't exist
    if [[ ! -d "$AGENTS_TARGET_DIR" ]]; then
        info "Creating global agents directory..."
        mkdir -p "$AGENTS_TARGET_DIR"
    fi
    
    # Link Custom Agents (.agent.md files)
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$AGENTS_TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                skipped=$((skipped + 1))
                continue
            else
                warn "Replacing existing symlink: $name"
                rm "$dest"
            fi
        elif [[ -e "$dest" ]]; then
            warn "Backing up existing agent: $name → $name.backup"
            mv "$dest" "$dest.backup"
        fi
        
        ln -s "$src" "$dest"
        success "Linked agent: $name"
        agent_count=$((agent_count + 1))
    done
    
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
        success "Linked skill: $name"
        skill_count=$((skill_count + 1))
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
    info "Created $agent_count agent symlinks, $skill_count skill symlinks ($skipped already existed)"
    echo ""
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo "${YELLOW}  Custom Agents (select from agent picker dropdown)${NC}"
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    info "Agents provide enforced tool access and handoffs between workflow phases:"
    info "  • Research → Plan → Implement → Review"
    echo ""
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo "${YELLOW}  Agent Skills (auto-activate based on prompts)${NC}"
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    info "Skills auto-activate based on what you ask:"
    info "  • 'This test is failing' → debug"
    info "  • 'Teach me how this works' → mentor"
    info "  • 'Clean up dead code' → janitor"
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

# Uninstall: Remove symlinks (agents + skills)
uninstall() {
    info "Uninstalling Agentic Coding Framework..."
    
    local agent_count=0
    local skill_count=0
    
    # Remove Custom Agent symlinks
    info "Removing agents from $AGENTS_TARGET_DIR..."
    for src in "$SCRIPT_DIR"/.github/agents/*.agent.md; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$AGENTS_TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                rm "$dest"
                success "Removed agent: $name"
                agent_count=$((agent_count + 1))
            fi
        fi
    done
    
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
                success "Removed skill: $name"
                skill_count=$((skill_count + 1))
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
    info "Removed $agent_count agent symlinks, $skill_count skill symlinks"
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
