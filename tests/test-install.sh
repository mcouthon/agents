#!/bin/zsh
#
# Test install and uninstall using a temporary prefix directory.
# Never touches real $HOME/.copilot/ or $HOME/.claude/ directories.
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo "${BLUE}ℹ${NC} $1"; }
success() { echo "${GREEN}✓${NC} $1"; }
error() { echo "${RED}✗${NC} $1"; exit 1; }

# Create isolated test prefix — all files go here instead of real $HOME
TEST_PREFIX=$(mktemp -d)
trap 'rm -rf "$TEST_PREFIX"' EXIT
export INSTALL_PREFIX="$TEST_PREFIX"

echo "Testing install script (isolated: $TEST_PREFIX)..."
echo ""

# Test install
info "Running install..."
"$REPO_ROOT/install.sh" > /dev/null

# Derive expected target dirs (mirrors install.sh HOME_DIR logic with prefix)
HOME_DIR="$TEST_PREFIX$HOME"
VSCODE_AGENTS_DIR="$HOME_DIR/.copilot/agents"
VSCODE_INSTRUCTIONS_DIR="$HOME_DIR/.copilot/instructions"
SKILLS_TARGET_DIR="$HOME_DIR/.copilot/skills"
CLAUDE_AGENTS_DIR="$HOME_DIR/.claude/agents"
CLAUDE_SKILLS_TARGET_DIR="$HOME_DIR/.claude/skills"
CLAUDE_RULES_DIR="$HOME_DIR/.claude/rules"
INTELLIJ_COPILOT_DIR="$HOME_DIR/.config/github-copilot/intellij"
AGENTS_USER_DIR="$HOME_DIR/.agents"
AGENTS_CONFIG_FILE="$AGENTS_USER_DIR/config.json"
MANIFEST_FILE="$AGENTS_USER_DIR/manifest.txt"

# Verify agent files exist (regular files, not symlinks)
for agent in "$REPO_ROOT"/generated/copilot/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ ! -f "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Agent file not installed: $name"
    fi
    if [[ -L "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Agent should be a copy, not a symlink: $name"
    fi
done
success "Agent files installed (copies)"

# Verify skill files exist (regular files in subdirs)
for skill in "$REPO_ROOT"/generated/copilot/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ ! -f "$SKILLS_TARGET_DIR/$name/SKILL.md" ]]; then
        error "Skill file not installed: $name/SKILL.md"
    fi
done
success "Skill files installed (copies)"

# Verify instruction files exist
for instr in "$REPO_ROOT"/generated/copilot/instructions/*.instructions.md; do
    [[ -f "$instr" ]] || continue
    name=$(basename "$instr")
    if [[ ! -f "$VSCODE_INSTRUCTIONS_DIR/$name" ]]; then
        error "Instruction file not installed: $name"
    fi
done
success "Instruction files installed (copies)"

# Verify Claude Code agent files exist
for agent in "$REPO_ROOT"/generated/claude/agents/*.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ ! -f "$CLAUDE_AGENTS_DIR/$name" ]]; then
        error "CC agent file not installed: $name"
    fi
done
success "CC agent files installed (copies)"

# Verify Claude Code skill files exist
for skill in "$REPO_ROOT"/generated/claude/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ ! -f "$CLAUDE_SKILLS_TARGET_DIR/$name/SKILL.md" ]]; then
        error "CC skill file not installed: $name/SKILL.md"
    fi
done
success "CC skill files installed (copies)"

# Verify Claude Code rule files exist
for rule in "$REPO_ROOT"/generated/claude/rules/*.md; do
    [[ -f "$rule" ]] || continue
    name=$(basename "$rule")
    if [[ ! -f "$CLAUDE_RULES_DIR/$name" ]]; then
        error "CC rule file not installed: $name"
    fi
done
success "CC rule files installed (copies)"

# Verify IntelliJ global instructions (regular file, not symlink)
intellij_dest="$INTELLIJ_COPILOT_DIR/global-copilot-instructions.md"
if [[ ! -f "$intellij_dest" ]]; then
    error "IntelliJ global instructions not installed"
fi
if [[ -L "$intellij_dest" ]]; then
    error "IntelliJ global instructions should be a copy, not a symlink"
fi
success "IntelliJ global instructions installed (copy)"

# Verify manifest created
if [[ ! -f "$MANIFEST_FILE" ]]; then
    error "Manifest not created"
fi
success "Manifest created"

# Verify manifest uses absolute paths (no tildes)
if grep -q "^/" "$MANIFEST_FILE"; then
    success "Manifest uses absolute paths"
else
    error "Manifest should use absolute paths"
fi
if grep -q "~" "$MANIFEST_FILE"; then
    error "Manifest should not contain tildes"
fi
success "Manifest has no tildes"

# Verify manifest has correct file count (47 files: 7+12+4 copilot + 7+12+4 CC + 1 IntelliJ)
MANIFEST_FILE_COUNT=$(grep -v '^#' "$MANIFEST_FILE" | grep -v '^$' | wc -l | tr -d ' ')
if [[ "$MANIFEST_FILE_COUNT" -ge 47 ]]; then
    success "Manifest tracks $MANIFEST_FILE_COUNT files (expected >= 47)"
else
    error "Manifest has $MANIFEST_FILE_COUNT files (expected >= 47)"
fi

# Verify config file created by install
if [[ -f "$AGENTS_CONFIG_FILE" ]]; then
    success "Config file created by install"
else
    error "Config file not created by install"
fi

# Test config migration: old config gets new fields added
info "Testing config migration..."
echo '{"models": {"opus": "9.9", "sonnet": "8.8"}}' > "$AGENTS_CONFIG_FILE"

# Re-run install — should migrate config and use custom models for generation
"$REPO_ROOT/install.sh" > /dev/null

# Verify models preserved after migration
if node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(c.models.opus==='9.9'?0:1)" "$AGENTS_CONFIG_FILE"; then
    success "Config migration preserved existing models"
else
    error "Config migration corrupted existing models!"
fi

# Verify new fields added by migration
if node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit('defaultTools' in c && 'agentTools' in c ? 0:1)" "$AGENTS_CONFIG_FILE"; then
    success "Config migration added missing fields"
else
    error "Config migration did not add missing fields!"
fi

# Verify custom config was applied to installed files
if grep -q "Claude Opus 9.9 (copilot)" "$VSCODE_AGENTS_DIR/explorer.agent.md"; then
    success "Custom config applied to installed agent files"
else
    error "Custom config not applied to installed agent files"
fi

# Verify re-install with complete config doesn't modify it
info "Testing config preservation on re-install..."
BEFORE_REINSTALL=$(cat "$AGENTS_CONFIG_FILE")
"$REPO_ROOT/install.sh" > /dev/null
AFTER_REINSTALL=$(cat "$AGENTS_CONFIG_FILE")
if [[ "$BEFORE_REINSTALL" == "$AFTER_REINSTALL" ]]; then
    success "Complete config NOT modified on re-install"
else
    error "Complete config was modified on re-install!"
fi

# Test: Tools in config survive install round-trip
info "Testing tools survive install round-trip..."
cat > "$AGENTS_CONFIG_FILE" << 'TOOLSRT'
{
  "models": {"opus": "9.9", "sonnet": "8.8"},
  "defaultTools": {
    "copilot": ["toolchain/roundtrip-default"],
    "cc": ["mcp__roundtrip__default"]
  },
  "agentTools": {
    "copilot": {
      "committer": ["toolchain/roundtrip-agent"]
    },
    "cc": {
      "committer": ["mcp__roundtrip__agent"]
    }
  }
}
TOOLSRT

"$REPO_ROOT/install.sh" > /dev/null

if grep -q "toolchain/roundtrip-default" "$VSCODE_AGENTS_DIR/explorer.agent.md"; then
    success "Default tools present in installed Copilot agent"
else
    error "Default tools missing from installed Copilot agent"
fi

if grep -q "toolchain/roundtrip-agent" "$VSCODE_AGENTS_DIR/committer.agent.md"; then
    success "Agent-specific tools present in installed Copilot committer"
else
    error "Agent-specific tools missing from installed Copilot committer"
fi

if grep -q "mcp__roundtrip__default" "$CLAUDE_AGENTS_DIR/explorer.md"; then
    success "Default tools present in installed CC agent"
else
    error "Default tools missing from installed CC agent"
fi

if grep -q "mcp__roundtrip__agent" "$CLAUDE_AGENTS_DIR/committer.md"; then
    success "Agent-specific tools present in installed CC committer"
else
    error "Agent-specific tools missing from installed CC committer"
fi

# Test uninstall
info "Running uninstall..."
"$REPO_ROOT/install.sh" uninstall > /dev/null

# Verify agent files removed
for agent in "$REPO_ROOT"/generated/copilot/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ -f "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Agent file not removed: $name"
    fi
done
success "Agent files removed"

# Verify skill files removed
for skill in "$REPO_ROOT"/generated/copilot/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ -f "$SKILLS_TARGET_DIR/$name/SKILL.md" ]]; then
        error "Skill file not removed: $name/SKILL.md"
    fi
done
success "Skill files removed"

# Verify instruction files removed
for instr in "$REPO_ROOT"/generated/copilot/instructions/*.instructions.md; do
    [[ -f "$instr" ]] || continue
    name=$(basename "$instr")
    if [[ -f "$VSCODE_INSTRUCTIONS_DIR/$name" ]]; then
        error "Instruction file not removed: $name"
    fi
done
success "Instruction files removed"

# Verify CC agent files removed
for agent in "$REPO_ROOT"/generated/claude/agents/*.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ -f "$CLAUDE_AGENTS_DIR/$name" ]]; then
        error "CC agent file not removed: $name"
    fi
done
success "CC agent files removed"

# Verify CC skill files removed
for skill in "$REPO_ROOT"/generated/claude/skills/*/; do
    [[ -d "$skill" ]] || continue
    name=$(basename "$skill")
    if [[ -f "$CLAUDE_SKILLS_TARGET_DIR/$name/SKILL.md" ]]; then
        error "CC skill file not removed: $name/SKILL.md"
    fi
done
success "CC skill files removed"

# Verify CC rule files removed
for rule in "$REPO_ROOT"/generated/claude/rules/*.md; do
    [[ -f "$rule" ]] || continue
    name=$(basename "$rule")
    if [[ -f "$CLAUDE_RULES_DIR/$name" ]]; then
        error "CC rule file not removed: $name"
    fi
done
success "CC rule files removed"

# Verify IntelliJ file removed
if [[ -f "$intellij_dest" ]]; then
    error "IntelliJ global instructions not removed"
fi
success "IntelliJ global instructions removed"

# Verify manifest removed but config preserved
if [[ -f "$MANIFEST_FILE" ]]; then
    error "Manifest not removed after uninstall"
fi
success "Manifest removed"

if [[ -f "$AGENTS_CONFIG_FILE" ]]; then
    success "Config preserved after uninstall"
else
    error "Config should be preserved after uninstall"
fi

# Test symlink migration: create legacy symlinks, run install, verify copies replace them
info "Testing symlink migration..."
mkdir -p "$VSCODE_AGENTS_DIR"
for agent in "$REPO_ROOT"/generated/copilot/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    ln -s "$agent" "$VSCODE_AGENTS_DIR/$name"
done

# Run install — should migrate symlinks to copies
"$REPO_ROOT/install.sh" > /dev/null

for agent in "$REPO_ROOT"/generated/copilot/agents/*.agent.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ -L "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "Symlink not migrated to copy: $name"
    fi
    if [[ ! -f "$VSCODE_AGENTS_DIR/$name" ]]; then
        error "File not present after migration: $name"
    fi
done
success "Symlinks migrated to copies"

# Clean up for final state
"$REPO_ROOT/install.sh" uninstall > /dev/null

echo ""
echo "${GREEN}All install tests passed (isolated mode)${NC}"
