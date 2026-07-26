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
CLAUDE_HOOKS_DIR="$HOME_DIR/.claude/hooks"

# IntelliJ Copilot configuration directory
INTELLIJ_COPILOT_DIR="$HOME_DIR/.config/github-copilot/intellij"

# AGENTS user configuration directory
AGENTS_USER_DIR="$HOME_DIR/.agents"
AGENTS_CONFIG_FILE="$AGENTS_USER_DIR/config.json"
AGENTS_DEFAULT_CONFIG="$SCRIPT_DIR/defaults/config.json"
MANIFEST_FILE="$AGENTS_USER_DIR/manifest.txt"

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

# Copy a directory tree, appending each destination to MANIFEST_LINES.
# Tracks changes in CHANGED_FILES array (only files with content differences).
# Usage: copy_tree <src_dir> <dest_dir>
copy_tree() {
    local src="$1" dest="$2"
    [[ -d "$src" ]] || return 0

    # Create destination root with explicit error handling
    if ! mkdir -p "$dest"; then
        error "Failed to create directory: $dest"
    fi

    while IFS= read -r file; do
        local rel="${file#$src/}"
        local dest_file="$dest/$rel"
        local dest_dir="$(dirname "$dest_file")"

        # Create subdirectory with explicit error handling
        if ! mkdir -p "$dest_dir"; then
            error "Failed to create directory: $dest_dir"
        fi

        # Verify directory exists before copy (catches silent mkdir failures)
        if [[ ! -d "$dest_dir" ]]; then
            error "Directory does not exist after mkdir: $dest_dir"
        fi

        if [[ -f "$dest_file" ]]; then
            if ! diff -q "$file" "$dest_file" > /dev/null 2>&1; then
                CHANGED_FILES+=("$dest_file")
            fi
        fi

        cp "$file" "$dest_file"
        MANIFEST_LINES+=("$dest_file")
    done < <(find "$src" -type f | sort)
}

# Write manifest after all copies succeed
write_manifest() {
    mkdir -p "$AGENTS_USER_DIR"
    {
        echo "# Installed by AGENTS framework — do not edit"
        echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '%s\n' "${MANIFEST_LINES[@]}"
    } > "$MANIFEST_FILE"
}

# Remove well-known files that were installed by older framework versions but
# are no longer generated. This handles orphans that predate manifest tracking
# or were installed before the file was removed from the framework.
cleanup_known_orphans() {
    # Worker agent was removed in April 2026. Files may exist from installs
    # that ran before manifest tracking or before the worker was deleted.
    local orphans=(
        "$CLAUDE_AGENTS_DIR/worker.md"
        "$VSCODE_AGENTS_DIR/worker.agent.md"
    )

    local removed_any=0
    for file in "${orphans[@]}"; do
        if [[ -f "$file" ]]; then
            [[ $removed_any -eq 0 ]] && { echo ""; info "Removing known orphaned files:"; }
            rm "$file"
            rmdir "$(dirname "$file")" 2>/dev/null || true
            local short="${file#$HOME_DIR/}"
            success "Removed: ~/$short"
            removed_any=1
        fi
    done
}

# Remove files from previous install that are no longer in the new manifest.
# Must be called BEFORE write_manifest() overwrites the old manifest.
cleanup_stale_files() {
    [[ -f "$MANIFEST_FILE" ]] || return 0  # No previous install

    local stale=()
    while IFS= read -r line; do
        [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue  # Skip comments/blanks

        # Check if this file is in the new manifest
        local found=0
        for new_file in "${MANIFEST_LINES[@]}"; do
            if [[ "$line" == "$new_file" ]]; then
                found=1
                break
            fi
        done

        # If not found in new manifest and file exists, it's stale
        if [[ $found -eq 0 && -f "$line" ]]; then
            stale+=("$line")
        fi
    done < "$MANIFEST_FILE"

    if [[ ${#stale[@]} -gt 0 ]]; then
        echo ""
        info "Removing stale files from previous install:"
        for file in "${stale[@]}"; do
            rm "$file"
            rmdir "$(dirname "$file")" 2>/dev/null || true
            local short="${file#$HOME_DIR/}"
            success "Removed: ~/$short"
        done
    fi
}

# Remove existing symlinks that point into our repo (migration from pre-manifest installs)
# Includes both generated/ (current) and .github/ (legacy) paths
migrate_symlinks_to_copies() {
    local dirs=("$VSCODE_AGENTS_DIR" "$SKILLS_TARGET_DIR" "$VSCODE_INSTRUCTIONS_DIR"
                "$CLAUDE_AGENTS_DIR" "$CLAUDE_SKILLS_TARGET_DIR" "$CLAUDE_RULES_DIR"
                "$INTELLIJ_COPILOT_DIR")

    for dir in "${dirs[@]}"; do
        [[ -d "$dir" ]] || continue
        for item in "$dir"/*(N); do
            [[ -L "$item" ]] || continue
            local target=$(readlink "$item")
            # Remove symlinks pointing anywhere in the AGENTS repo (covers generated/, .github/, etc.)
            if [[ "$target" == "$SCRIPT_DIR"* ]]; then
                rm "$item"
                info "Migrated symlink → copy: $(basename "$item")"
            fi
        done
    done
}

# Clean up empty directories left behind after uninstall
cleanup_empty_dirs() {
    local dirs=("$VSCODE_AGENTS_DIR" "$SKILLS_TARGET_DIR" "$VSCODE_INSTRUCTIONS_DIR"
                "$CLAUDE_AGENTS_DIR" "$CLAUDE_SKILLS_TARGET_DIR" "$CLAUDE_RULES_DIR")
    for dir in "${dirs[@]}"; do
        find "$dir" -type d -empty -delete 2>/dev/null || true
        rmdir "$dir" 2>/dev/null || true
    done
}

# Create symlink, backing up existing files (used only for shell helpers)
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

# Remove symlink if it points to our source (used only for shell helpers + legacy uninstall)
# Returns 0 if removed, 1 if not ours
unlink_if_ours() {
    local src="$1" dest="$2"
    [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]] && rm "$dest" && return 0
    return 1
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

    # CC agents (6 files)
    for agent in builder committer conductor explorer researcher reviewer; do
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

    # Copilot agents (6 files)
    for agent in builder committer conductor explorer researcher reviewer; do
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

# Verify the static (non-generated) hook scripts shipped in hooks/ exist.
# Sibling check to check_generated_files() — hooks/ is a static source
# directory, not part of the generator output, so it does not belong inside
# that function's generated/ tree enumeration.
check_hooks_scripts() {
    [[ -f "$SCRIPT_DIR/hooks/reviewer-write-guard.sh" ]] || \
        error "Required hook script not found: hooks/reviewer-write-guard.sh"
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

# Install default config if not present
install_config() {
    mkdir -p "$AGENTS_USER_DIR"

    if [[ ! -f "$AGENTS_CONFIG_FILE" ]]; then
        if [[ -f "$AGENTS_DEFAULT_CONFIG" ]]; then
            cp "$AGENTS_DEFAULT_CONFIG" "$AGENTS_CONFIG_FILE"
            success "Created default config: $AGENTS_CONFIG_FILE"
        else
            warn "Default config not found: $AGENTS_DEFAULT_CONFIG"
        fi
    fi

    # Migrate: add any new fields from defaults to existing config
    if [[ -f "$AGENTS_CONFIG_FILE" && -f "$AGENTS_DEFAULT_CONFIG" ]]; then
        node "$SCRIPT_DIR/scripts/migrate-config.js" "$AGENTS_CONFIG_FILE" "$AGENTS_DEFAULT_CONFIG" 2>/dev/null | while IFS= read -r field; do
            [[ -n "$field" ]] && info "Added $field field to config"
        done
    fi

    # Always return 0 - config existing is not an error
    return 0
}

# Install: Generate with user config, copy to target directories
install() {
    info "Installing Agentic Coding Framework..."
    info "Source: $SCRIPT_DIR"
    show_files
    check_generated_files
    check_hooks_scripts

    # Ensure ~/.agents/config.json exists BEFORE config resolution
    install_config

    local tmp_dir=$(mktemp -d)

    # Determine config: user's if exists, else repo defaults
    local config_file="$AGENTS_CONFIG_FILE"
    [[ -f "$config_file" ]] || config_file="$AGENTS_DEFAULT_CONFIG"

    # Install npm dependencies (required for MCP state server)
    npm install --silent 2>/dev/null || true

    # Generate with user config to temp dir
    node "$SCRIPT_DIR/scripts/generate.js" all \
        --config "$config_file" \
        --source "$SCRIPT_DIR/templates" \
        --output-dir "$tmp_dir" > /dev/null

    # Remove existing symlinks that point into our generated/ dir (migration)
    migrate_symlinks_to_copies

    # Copy generated files to target directories
    MANIFEST_LINES=()
    CHANGED_FILES=()
    copy_tree "$tmp_dir/copilot/agents"       "$VSCODE_AGENTS_DIR"
    copy_tree "$tmp_dir/copilot/skills"        "$SKILLS_TARGET_DIR"
    copy_tree "$tmp_dir/copilot/instructions"  "$VSCODE_INSTRUCTIONS_DIR"
    copy_tree "$tmp_dir/claude/agents"         "$CLAUDE_AGENTS_DIR"
    copy_tree "$tmp_dir/claude/skills"         "$CLAUDE_SKILLS_TARGET_DIR"
    copy_tree "$tmp_dir/claude/rules"          "$CLAUDE_RULES_DIR"
    copy_tree "$SCRIPT_DIR/hooks"              "$CLAUDE_HOOKS_DIR"
    chmod +x "$CLAUDE_HOOKS_DIR"/*.sh

    # IntelliJ global instructions (one-off copy)
    local intellij_src="$tmp_dir/copilot/instructions/global.instructions.md"
    local intellij_dest="$INTELLIJ_COPILOT_DIR/global-copilot-instructions.md"
    if [[ -f "$intellij_src" ]]; then
        mkdir -p "$INTELLIJ_COPILOT_DIR"
        if [[ -f "$intellij_dest" ]] && ! diff -q "$intellij_src" "$intellij_dest" > /dev/null 2>&1; then
            CHANGED_FILES+=("$intellij_dest")
        fi
        cp "$intellij_src" "$intellij_dest"
        MANIFEST_LINES+=("$intellij_dest")
    fi

    # Remove known orphaned files from older framework versions
    cleanup_known_orphans

    # Remove files from previous install that are no longer tracked
    cleanup_stale_files

    # Write manifest only after all copies succeed
    write_manifest

    # Report changed files
    if [[ ${#CHANGED_FILES[@]} -gt 0 ]]; then
        echo ""
        info "Updated files:"
        for changed in "${CHANGED_FILES[@]}"; do
            # Show short path relative to home
            local short="${changed#$HOME_DIR/}"
            success "~/$short"
        done
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

    # Count installed files by category
    local copilot_agents=$(find "$VSCODE_AGENTS_DIR" -name "*.agent.md" 2>/dev/null | wc -l | tr -d ' ')
    local copilot_skills=$(find "$SKILLS_TARGET_DIR" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
    local copilot_instructions=$(find "$VSCODE_INSTRUCTIONS_DIR" -name "*.instructions.md" 2>/dev/null | wc -l | tr -d ' ')
    local cc_agents=$(find "$CLAUDE_AGENTS_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    local cc_skills=$(find "$CLAUDE_SKILLS_TARGET_DIR" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
    local cc_rules=$(find "$CLAUDE_RULES_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')

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
    info "Config:      ~/.agents/config.json"
    info "Tasks:       .tasks/ (per workspace, gitignored globally)"
    echo ""

    # Clean up temp dir
    rm -rf "$tmp_dir"
}

# Uninstall: Remove installed files via manifest
uninstall() {
    info "Uninstalling Agentic Coding Framework..."

    if [[ ! -f "$MANIFEST_FILE" ]]; then
        # Fallback: try legacy symlink-based uninstall for migration
        warn "No manifest found. Attempting legacy symlink removal..."
        uninstall_legacy_symlinks
        return
    fi

    local removed=0
    while IFS= read -r line; do
        [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue  # Skip comments/blanks
        if [[ -f "$line" ]]; then
            rm "$line"
            success "Removed: $line"
            removed=$((removed + 1))
        fi
    done < "$MANIFEST_FILE"

    rm "$MANIFEST_FILE"

    # Clean up empty directories left behind
    cleanup_empty_dirs

    # Gitignore (skip in test-isolation mode)
    if [[ -z "$INSTALL_PREFIX" ]]; then
        if unconfigure_global_gitignore; then
            success "Removed .tasks/ from global gitignore"
        fi
    fi

    echo ""
    success "Uninstallation complete! Removed $removed files."
}

# Legacy support: remove symlinks from pre-manifest installs
uninstall_legacy_symlinks() {
    local removed=0

    for dir in "$VSCODE_AGENTS_DIR" "$SKILLS_TARGET_DIR" "$VSCODE_INSTRUCTIONS_DIR" \
               "$CLAUDE_AGENTS_DIR" "$CLAUDE_SKILLS_TARGET_DIR" "$CLAUDE_RULES_DIR" \
               "$INTELLIJ_COPILOT_DIR"; do
        [[ -d "$dir" ]] || continue
        for item in "$dir"/*(N); do
            [[ -L "$item" ]] || continue
            local target=$(readlink "$item")
            # Remove symlinks pointing anywhere in the AGENTS repo (covers generated/, .github/, etc.)
            if [[ "$target" == "$SCRIPT_DIR"* ]]; then
                rm "$item"
                success "Removed legacy symlink: $item"
                removed=$((removed + 1))
            fi
        done
    done

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

    echo ""
    success "Legacy uninstallation complete! Removed $removed symlinks."
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
        echo "  uninstall          Remove installed agents and skills"
        echo "  helpers            Install shell helpers (a-explorer, a-builder, etc.)"
        echo "  uninstall-helpers  Remove shell helper symlinks"
        exit 1
        ;;
esac
