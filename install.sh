#!/bin/zsh
#
# Agentic Coding Framework - Install/Uninstall Script
#
# Installs:
# - Custom Agents (workflow modes with tool restrictions and handoffs)
# - Agent Skills (auto-activated specialized capabilities)
#
# For GitHub Copilot (coding agent, CLI, VS Code, IntelliJ) and Claude Code
#
# Usage:
#   make                  # Generate output files first
#   ./install.sh          # Install agents and skills
#   ./install.sh uninstall  # Uninstall
#

set -e

# Configuration
SCRIPT_DIR="${0:A:h}"

# Optional prefix for test isolation (redirects all target paths)
HOME_DIR="${INSTALL_PREFIX:-}$HOME"

# Target directories
SKILLS_TARGET_DIR="$HOME_DIR/.copilot/skills"
CLAUDE_SKILLS_TARGET_DIR="$HOME_DIR/.claude/skills"

# Agent and instruction target directories (VS Code 1.109+)
VSCODE_AGENTS_DIR="$HOME_DIR/.copilot/agents"
VSCODE_INSTRUCTIONS_DIR="$HOME_DIR/.copilot/instructions"
CLAUDE_COMMANDS_DIR="$HOME_DIR/.claude/commands"
CLAUDE_AGENTS_DIR="$HOME_DIR/.claude/agents"
CLAUDE_RULES_DIR="$HOME_DIR/.claude/rules"

# IntelliJ Copilot configuration directory
INTELLIJ_COPILOT_DIR="$HOME_DIR/.config/github-copilot/intellij"

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

# Link all files matching a glob to a destination directory.
# Sets LINK_COUNT to the number of new links created.
# Usage: link_files "glob_pattern" "dest_dir" "label"
link_files() {
    local glob="$1" dest_dir="$2" label="$3"
    LINK_COUNT=0
    mkdir -p "$dest_dir"
    for src in ${~glob}; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "$src" "$dest_dir/$name" "$name"; then
            success "Linked $label: $name"
            LINK_COUNT=$((LINK_COUNT + 1))
        fi
    done
}

# Link all directories matching a glob to a destination directory.
# Sets LINK_COUNT to the number of new links created.
# Usage: link_dirs "glob_pattern" "dest_dir" "label"
link_dirs() {
    local glob="$1" dest_dir="$2" label="$3"
    LINK_COUNT=0
    mkdir -p "$dest_dir"
    for src in ${~glob}; do
        [[ -d "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "${src%/}" "$dest_dir/$name" "$name"; then
            success "Linked $label: $name"
            LINK_COUNT=$((LINK_COUNT + 1))
        fi
    done
}

# Unlink all files matching a glob from a destination directory.
# Sets LINK_COUNT to the number of links removed.
# Usage: unlink_files "glob_pattern" "dest_dir" "label"
unlink_files() {
    local glob="$1" dest_dir="$2" label="$3"
    LINK_COUNT=0
    for src in ${~glob}; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "$src" "$dest_dir/$name"; then
            success "Removed $label: $name"
            LINK_COUNT=$((LINK_COUNT + 1))
        fi
    done
}

# Unlink all directories matching a glob from a destination directory.
# Sets LINK_COUNT to the number of links removed.
# Cleans up empty parent directory.
# Usage: unlink_dirs "glob_pattern" "dest_dir" "label"
unlink_dirs() {
    local glob="$1" dest_dir="$2" label="$3"
    LINK_COUNT=0
    for src in ${~glob}; do
        [[ -d "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "${src%/}" "$dest_dir/$name"; then
            success "Removed $label: $name"
            LINK_COUNT=$((LINK_COUNT + 1))
        fi
    done
    rmdir "$dest_dir" 2>/dev/null || true
}

# Configure global gitignore to exclude .tasks/
configure_global_gitignore() {
    local pattern=".tasks/"
    
    # Get global gitignore path, or set default if not configured
    local gitignore_global=$(git config --global core.excludesFile)
    
    if [[ -z "$gitignore_global" ]]; then
        # No global gitignore configured, use default location
        gitignore_global="$HOME/.gitignore_global"
        git config --global core.excludesFile "$gitignore_global"
        info "Configured global gitignore: $gitignore_global"
    fi
    
    # Expand tilde if present
    gitignore_global="${gitignore_global/#\~/$HOME}"
    
    # Create the file if it doesn't exist
    if [[ ! -f "$gitignore_global" ]]; then
        touch "$gitignore_global"
    fi
    
    # Check if pattern already exists
    if grep -Fxq "$pattern" "$gitignore_global" 2>/dev/null; then
        return 1  # Already exists
    fi
    
    # Add pattern with a comment
    echo "" >> "$gitignore_global"
    echo "# Copilot task state (personal session context)" >> "$gitignore_global"
    echo "$pattern" >> "$gitignore_global"
    return 0
}

# Remove .tasks/ from global gitignore
unconfigure_global_gitignore() {
    local pattern=".tasks/"
    local gitignore_global=$(git config --global core.excludesFile)
    
    [[ -z "$gitignore_global" ]] && return 1
    gitignore_global="${gitignore_global/#\~/$HOME}"
    [[ ! -f "$gitignore_global" ]] && return 1
    
    # Resolve symlinks for sed compatibility (macOS sed -i doesn't work on symlinks)
    if [[ -L "$gitignore_global" ]]; then
        gitignore_global=$(readlink -f "$gitignore_global" 2>/dev/null || greadlink -f "$gitignore_global" 2>/dev/null || echo "$gitignore_global")
    fi
    
    # Remove the pattern and its comment if they exist
    if grep -Fxq "$pattern" "$gitignore_global" 2>/dev/null; then
        # Use sed to remove the pattern and the comment line before it
        sed -i.bak '/# Copilot task state (personal session context)/d' "$gitignore_global"
        sed -i.bak '\|'"$pattern"'|d' "$gitignore_global"
        rm "${gitignore_global}.bak" 2>/dev/null || true
        return 0
    fi
    return 1
}

# Verify all expected generated files exist (must run 'make' first)
check_generated_files() {
    local missing=()

    # CC agents (7 files)
    for agent in builder committer conductor explorer researcher reviewer worker; do
        [[ -f "$SCRIPT_DIR/generated/claude/agents/${agent}.md" ]] || missing+=("generated/claude/agents/${agent}.md")
    done

    # CC skills (12 directories)
    for skill in architecture consolidate-task critic debug deep-research design makefile mentor phase-review security-review tech-debt testing; do
        [[ -f "$SCRIPT_DIR/generated/claude/skills/${skill}/SKILL.md" ]] || missing+=("generated/claude/skills/${skill}/SKILL.md")
    done

    # CC rules (4 files)
    for rule in global python terminal typescript; do
        [[ -f "$SCRIPT_DIR/generated/claude/rules/${rule}.md" ]] || missing+=("generated/claude/rules/${rule}.md")
    done

    # Copilot agents (7 files)
    for agent in builder committer conductor explorer researcher reviewer worker; do
        [[ -f "$SCRIPT_DIR/generated/copilot/agents/${agent}.agent.md" ]] || missing+=("generated/copilot/agents/${agent}.agent.md")
    done

    # Copilot skills (12 directories)
    for skill in architecture consolidate-task critic debug deep-research design makefile mentor phase-review security-review tech-debt testing; do
        [[ -f "$SCRIPT_DIR/generated/copilot/skills/${skill}/SKILL.md" ]] || missing+=("generated/copilot/skills/${skill}/SKILL.md")
    done

    # Copilot instructions (4 files)
    for instr in global python terminal typescript; do
        [[ -f "$SCRIPT_DIR/generated/copilot/instructions/${instr}.instructions.md" ]] || missing+=("generated/copilot/instructions/${instr}.instructions.md")
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "${RED}✗${NC} Required generated files not found. Run 'make' before install.sh."
        echo "  Missing: $(IFS=', '; echo "${missing[*]}")"
        exit 1
    fi
}

# Show what will be linked
show_files() {
    echo "\n${BLUE}Custom Agents (workflow modes):${NC}"
    for f in "$SCRIPT_DIR"/generated/copilot/agents/*.agent.md; do
        [[ -f "$f" ]] && echo "    - $(basename "$f")"
    done
    
    echo "\n${BLUE}Agent Skills (auto-activated capabilities):${NC}"
    for d in "$SCRIPT_DIR"/generated/copilot/skills/*/; do
        [[ -d "$d" ]] && echo "    - $(basename "$d")/"
    done
    echo ""
}

# Install: Create symlinks for skills globally
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR"
    show_files
    check_generated_files

    # Copilot skills (directory symlinks)
    link_dirs "$SCRIPT_DIR/generated/copilot/skills/*/" "$SKILLS_TARGET_DIR" "skill"
    local copilot_skills=$LINK_COUNT

    # CC skills (directory symlinks — same pattern as Copilot)
    # Remove old compatibility symlink if it still exists
    [[ -L "$CLAUDE_SKILLS_TARGET_DIR" ]] && rm "$CLAUDE_SKILLS_TARGET_DIR"
    link_dirs "$SCRIPT_DIR/generated/claude/skills/*/" "$CLAUDE_SKILLS_TARGET_DIR" "CC skill"
    local cc_skills=$LINK_COUNT

    # Copilot agents
    link_files "$SCRIPT_DIR/generated/copilot/agents/*.agent.md" "$VSCODE_AGENTS_DIR" "agent"
    local copilot_agents=$LINK_COUNT

    # CC agents
    link_files "$SCRIPT_DIR/generated/claude/agents/*.md" "$CLAUDE_AGENTS_DIR" "CC agent"
    local cc_agents=$LINK_COUNT

    # Copilot instructions
    link_files "$SCRIPT_DIR/generated/copilot/instructions/*.instructions.md" "$VSCODE_INSTRUCTIONS_DIR" "instruction"
    local copilot_instructions=$LINK_COUNT

    # CC rules
    link_files "$SCRIPT_DIR/generated/claude/rules/*.md" "$CLAUDE_RULES_DIR" "CC rule"
    local cc_rules=$LINK_COUNT

    # IntelliJ global instructions (one-off, keep inline)
    mkdir -p "$INTELLIJ_COPILOT_DIR"
    local intellij_src="$SCRIPT_DIR/generated/copilot/instructions/global.instructions.md"
    local intellij_dest="$INTELLIJ_COPILOT_DIR/global-copilot-instructions.md"
    if [[ -f "$intellij_src" ]]; then
        if link_file "$intellij_src" "$intellij_dest" "global-copilot-instructions.md"; then
            success "Linked IntelliJ global instructions"
        fi
    fi

    # Configure global gitignore (skip in test-isolation mode)
    if [[ -z "$INSTALL_PREFIX" ]]; then
        if configure_global_gitignore; then
            success "Added .tasks/ to global gitignore"
        fi
    fi

    # Configure VS Code settings (skip in test-isolation mode)
    if [[ -z "$INSTALL_PREFIX" ]]; then
        if command -v node &>/dev/null; then
            if node "$SCRIPT_DIR/scripts/configure-vscode-settings.js" 2>/dev/null; then
                success "Configured VS Code settings for agent discovery"
            fi
        else
            warn "Node.js not found - cannot auto-configure VS Code settings"
            info "Add to VS Code settings.json:"
            echo '  "chat.agentFilesLocations": { "~/.copilot/agents": true }'
            echo '  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true }'
        fi
    fi

    echo ""
    success "Installation complete!"
    info "Copilot: $copilot_agents agents, $copilot_skills skills, $copilot_instructions instructions"
    info "Claude Code: $cc_agents agents, $cc_skills skills, $cc_rules rules"
    echo ""
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo "${YELLOW}  Agents are now available globally${NC}"
    echo "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    info "Copilot:     ~/.copilot/{agents,skills,instructions}/"
    info "Claude Code: ~/.claude/{agents,skills,rules}/"
    info "IntelliJ:    ~/.config/github-copilot/intellij/"
    info "Tasks:       .tasks/ (per workspace, gitignored globally)"
    echo ""
}

# Uninstall: Remove symlinks
uninstall() {
    info "Uninstalling Agentic Coding Framework..."

    # Copilot skills
    unlink_dirs "$SCRIPT_DIR/generated/copilot/skills/*/" "$SKILLS_TARGET_DIR" "skill"
    local copilot_skills=$LINK_COUNT

    # CC skills
    unlink_dirs "$SCRIPT_DIR/generated/claude/skills/*/" "$CLAUDE_SKILLS_TARGET_DIR" "CC skill"
    local cc_skills=$LINK_COUNT

    # Copilot agents
    unlink_files "$SCRIPT_DIR/generated/copilot/agents/*.agent.md" "$VSCODE_AGENTS_DIR" "agent"
    local copilot_agents=$LINK_COUNT

    # CC agents
    unlink_files "$SCRIPT_DIR/generated/claude/agents/*.md" "$CLAUDE_AGENTS_DIR" "CC agent"
    local cc_agents=$LINK_COUNT
    rmdir "$CLAUDE_AGENTS_DIR" 2>/dev/null || true

    # Copilot instructions
    unlink_files "$SCRIPT_DIR/generated/copilot/instructions/*.instructions.md" "$VSCODE_INSTRUCTIONS_DIR" "instruction"
    local copilot_instructions=$LINK_COUNT

    # CC rules
    unlink_files "$SCRIPT_DIR/generated/claude/rules/*.md" "$CLAUDE_RULES_DIR" "CC rule"
    local cc_rules=$LINK_COUNT
    rmdir "$CLAUDE_RULES_DIR" 2>/dev/null || true

    # Old slash commands cleanup
    if [[ -d "$CLAUDE_COMMANDS_DIR" ]]; then
        rm -f "$CLAUDE_COMMANDS_DIR"/*.md
        rmdir "$CLAUDE_COMMANDS_DIR" 2>/dev/null || true
    fi

    # Gitignore (skip in test-isolation mode)
    if [[ -z "$INSTALL_PREFIX" ]]; then
        if unconfigure_global_gitignore; then
            success "Removed .tasks/ from global gitignore"
        fi
    fi

    # IntelliJ
    local intellij_src="$SCRIPT_DIR/generated/copilot/instructions/global.instructions.md"
    unlink_if_ours "$intellij_src" "$INTELLIJ_COPILOT_DIR/global-copilot-instructions.md" && success "Removed IntelliJ global instructions"

    echo ""
    success "Uninstallation complete!"
    info "Removed: $copilot_agents agents, $copilot_skills skills, $copilot_instructions instructions"
    info "Removed: $cc_agents CC agents, $cc_skills CC skills, $cc_rules CC rules"
}

# Install shell helpers for agent switching (symlinks to ~/.local/bin)
install_helpers() {
    local bin_dir="$HOME_DIR/.local/bin"
    local src_dir="$SCRIPT_DIR/scripts/bin"

    if [[ ! -d "$src_dir" ]]; then
        error "scripts/bin/ not found. Are you running from the repo root?"
    fi

    info "Installing agent shell helpers to $bin_dir..."
    mkdir -p "$bin_dir"

    local count=0
    for src in "$src_dir"/a-*; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if link_file "$src" "$bin_dir/$name" "$name"; then
            success "Linked helper: $name"
            count=$((count + 1))
        fi
    done

    echo ""
    success "Installed $count shell helpers"

    # Check if ~/.local/bin is in PATH
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *)
            echo ""
            warn "~/.local/bin is not in your PATH"
            info "Add to your shell rc file:"
            echo '  export PATH="$HOME/.local/bin:$PATH"'
            echo ""
            info "For fish shell:"
            echo '  fish_add_path ~/.local/bin'
            ;;
    esac
}

# Remove shell helper symlinks from ~/.local/bin
uninstall_helpers() {
    local bin_dir="$HOME_DIR/.local/bin"
    local src_dir="$SCRIPT_DIR/scripts/bin"

    info "Removing agent shell helpers from $bin_dir..."

    local count=0
    for src in "$src_dir"/a-*; do
        [[ -f "$src" ]] || continue
        local name=$(basename "$src")
        if unlink_if_ours "$src" "$bin_dir/$name"; then
            success "Removed helper: $name"
            count=$((count + 1))
        fi
    done

    echo ""
    success "Removed $count shell helpers"
}

# Main
case "${1:-install}" in
    install)
        install
        ;;
    uninstall)
        uninstall
        ;;
    helpers)
        install_helpers
        ;;
    uninstall-helpers)
        uninstall_helpers
        ;;
    *)
        echo "Usage: $0 [install|uninstall|helpers|uninstall-helpers]"
        echo ""
        echo "Commands:"
        echo "  install            Install agents and skills globally"
        echo "  uninstall          Remove global agent and skill symlinks"
        echo "  helpers            Install shell helpers (a-explorer, a-builder, etc.)"
        echo "  uninstall-helpers  Remove shell helper symlinks"
        exit 1
        ;;
esac
