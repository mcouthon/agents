#!/bin/zsh
#
# Agentic Coding Framework - Install/Uninstall Script
#
# Creates symlinks to global Copilot prompts directory so edits
# in this repo are immediately available in VSCode.
#
# Usage:
#   ./install.sh          # Install (create symlinks)
#   ./install.sh uninstall # Uninstall (remove symlinks)
#

set -e

# Configuration
SCRIPT_DIR="${0:A:h}"
TARGET_DIR="$HOME/Library/Application Support/Code/User/prompts"

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
    echo "\n${BLUE}Files to be managed:${NC}"
    echo "  Instructions:"
    for f in "$SCRIPT_DIR"/instructions/*.instructions.md; do
        [[ -e "$f" ]] && echo "    - $(basename "$f")"
    done
    echo "  Workflow Agents:"
    for f in "$SCRIPT_DIR"/prompts/workflow/*.agent.md; do
        [[ -e "$f" ]] && echo "    - $(basename "$f")"
    done
    echo "  Utility Agents:"
    for f in "$SCRIPT_DIR"/prompts/utilities/*.agent.md; do
        [[ -e "$f" ]] && echo "    - $(basename "$f")"
    done
    echo ""
}

# Install: Create symlinks
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR"
    info "Target: $TARGET_DIR"
    
    # Create target directory if it doesn't exist
    if [[ ! -d "$TARGET_DIR" ]]; then
        info "Creating prompts directory..."
        mkdir -p "$TARGET_DIR"
    fi
    
    show_files
    
    local count=0
    local skipped=0
    
    # Link instruction files
    for src in "$SCRIPT_DIR"/instructions/*.instructions.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            # Already a symlink - check if it points to our file
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                skipped=$((skipped + 1))
                continue
            else
                warn "Replacing existing symlink: $name"
                rm "$dest"
            fi
        elif [[ -e "$dest" ]]; then
            warn "Backing up existing file: $name → $name.backup"
            mv "$dest" "$dest.backup"
        fi
        
        ln -s "$src" "$dest"
        success "Linked: $name"
        count=$((count + 1))
    done
    
    # Link workflow agents
    for src in "$SCRIPT_DIR"/prompts/workflow/*.agent.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
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
            warn "Backing up existing file: $name → $name.backup"
            mv "$dest" "$dest.backup"
        fi
        
        ln -s "$src" "$dest"
        success "Linked: $name"
        count=$((count + 1))
    done
    
    # Link utility agents
    for src in "$SCRIPT_DIR"/prompts/utilities/*.agent.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
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
            warn "Backing up existing file: $name → $name.backup"
            mv "$dest" "$dest.backup"
        fi
        
        ln -s "$src" "$dest"
        success "Linked: $name"
        count=$((count + 1))
    done
    
    echo ""
    success "Installation complete!"
    info "Created $count symlinks, $skipped already existed"
    info "Edits to files in this repo will be immediately available in VSCode"
    echo ""
    info "To activate an agent mode in Copilot Chat:"
    info "  1. Open Copilot Chat"
    info "  2. Click the model picker dropdown"
    info "  3. Select an agent from the list"
    echo ""
}

# Uninstall: Remove symlinks
uninstall() {
    info "Uninstalling Agentic Coding Framework..."
    info "Target: $TARGET_DIR"
    
    local count=0
    
    # Remove instruction symlinks
    for src in "$SCRIPT_DIR"/instructions/*.instructions.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                rm "$dest"
                success "Removed: $name"
                count=$((count + 1))
            fi
        fi
    done
    
    # Remove workflow agent symlinks
    for src in "$SCRIPT_DIR"/prompts/workflow/*.agent.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                rm "$dest"
                success "Removed: $name"
                count=$((count + 1))
            fi
        fi
    done
    
    # Remove utility agent symlinks
    for src in "$SCRIPT_DIR"/prompts/utilities/*.agent.md; do
        [[ -e "$src" ]] || continue
        local name=$(basename "$src")
        local dest="$TARGET_DIR/$name"
        
        if [[ -L "$dest" ]]; then
            local current_target=$(readlink "$dest")
            if [[ "$current_target" == "$src" ]]; then
                rm "$dest"
                success "Removed: $name"
                count=$((count + 1))
            fi
        fi
    done
    
    echo ""
    success "Uninstallation complete!"
    info "Removed $count symlinks"
    
    # Check for backup files
    local backups=("$TARGET_DIR"/*.backup)
    if [[ -e "${backups[1]}" ]]; then
        echo ""
        warn "Found backup files in $TARGET_DIR:"
        for f in "${backups[@]}"; do
            echo "  - $(basename "$f")"
        done
        info "Remove .backup suffix to restore original files"
    fi
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
        echo "  install    Create symlinks to global Copilot prompts (default)"
        echo "  uninstall  Remove symlinks created by this script"
        exit 1
        ;;
esac
