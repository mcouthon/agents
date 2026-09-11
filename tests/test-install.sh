#!/bin/zsh
#
# Test install and uninstall using a temporary prefix directory.
# Never touches real $HOME/.claude/ directories.
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
CLAUDE_AGENTS_DIR="$HOME_DIR/.claude/agents"
CLAUDE_SKILLS_TARGET_DIR="$HOME_DIR/.claude/skills"
CLAUDE_RULES_DIR="$HOME_DIR/.claude/rules"
CLAUDE_HOOKS_DIR="$HOME_DIR/.claude/hooks"
AGENTS_USER_DIR="$HOME_DIR/.agents"
AGENTS_CONFIG_FILE="$AGENTS_USER_DIR/config.json"
MANIFEST_FILE="$AGENTS_USER_DIR/manifest.txt"

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

# Verify the shared write-guard hook script is installed and executable
GUARD_SCRIPT="$CLAUDE_HOOKS_DIR/write-guard.sh"
if [[ ! -f "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not installed: $GUARD_SCRIPT"
fi
if [[ ! -x "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not executable: $GUARD_SCRIPT"
fi
success "write-guard hook script installed and executable"

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

# Verify manifest has correct file count (CC only: 7 agents + 13 skills + 5 rules + 1 hook)
MANIFEST_FILE_COUNT=$(grep -v '^#' "$MANIFEST_FILE" | grep -v '^$' | wc -l | tr -d ' ')
if [[ "$MANIFEST_FILE_COUNT" -ge 20 ]]; then
    success "Manifest tracks $MANIFEST_FILE_COUNT files (expected >= 20)"
else
    error "Manifest has $MANIFEST_FILE_COUNT files (expected >= 20)"
fi

# Verify config file created by install
if [[ -f "$AGENTS_CONFIG_FILE" ]]; then
    success "Config file created by install"
else
    error "Config file not created by install"
fi

# Test config migration: old config gets new fields added
info "Testing config migration..."
echo '{"models": {"opus": "9.9", "sonnet": "8.8"}, "agents": {"explorer": {"cc": "sonnet"}}}' > "$AGENTS_CONFIG_FILE"

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

# Verify custom config was applied to installed files (CC shows model type, not version)
if grep -q '^model: sonnet$' "$CLAUDE_AGENTS_DIR/explorer.md"; then
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
    "cc": ["mcp__roundtrip__default"]
  },
  "agentTools": {
    "cc": {
      "committer": ["mcp__roundtrip__agent"]
    }
  }
}
TOOLSRT

"$REPO_ROOT/install.sh" > /dev/null

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

# Test: Stale file cleanup on reinstall
info "Test: Stale file cleanup on reinstall"

# Create a fake stale file at the HOME_DIR path and add to manifest
mkdir -p "$HOME_DIR/.claude/agents"
echo "stale content" > "$HOME_DIR/.claude/agents/stale-agent.md"
echo "$HOME_DIR/.claude/agents/stale-agent.md" >> "$MANIFEST_FILE"

# Reinstall — should detect and remove the stale file
"$REPO_ROOT/install.sh" > /dev/null

# Verify stale file was removed
if [[ -f "$HOME_DIR/.claude/agents/stale-agent.md" ]]; then
    error "Stale file was not removed on reinstall"
fi
success "Stale files cleaned up on reinstall"

# Test: Known orphan cleanup (files installed before manifest tracking)
info "Test: Known orphan cleanup (pre-manifest worker files)"

# Simulate worker files left over from an old install that predates manifest tracking.
# They are NOT in the manifest — only present on disk.
mkdir -p "$HOME_DIR/.claude/agents"
echo "old worker content" > "$HOME_DIR/.claude/agents/worker.md"

# Reinstall — should remove the worker files even though they're not in the manifest
"$REPO_ROOT/install.sh" > /dev/null

if [[ -f "$HOME_DIR/.claude/agents/worker.md" ]]; then
    error "Known orphan ~/.claude/agents/worker.md was not removed"
fi
success "Known orphan worker files cleaned up on reinstall"

# Test: all three category counts in the install summary ignore foreign files
# (regression — unrelated tools/the user also write into these shared
# directories; the summary must count what THIS install generated, not a blind
# scan of directories other tools/the user also write into). Plants a foreign
# file in every one of the shared destination directories.
info "Test: all three summary counts ignore foreign files in shared directories"

mkdir -p "$CLAUDE_AGENTS_DIR" "$CLAUDE_SKILLS_TARGET_DIR/foreign-skill" "$CLAUDE_RULES_DIR"
echo "foreign agent" > "$CLAUDE_AGENTS_DIR/foreign-tool.md"
echo "# foreign skill" > "$CLAUDE_SKILLS_TARGET_DIR/foreign-skill/SKILL.md"
echo "# foreign rule" > "$CLAUDE_RULES_DIR/foreign-tool.md"

EXPECTED_CC_AGENTS=$(find "$REPO_ROOT/generated/claude/agents" -name "*.md" | wc -l | tr -d ' ')
EXPECTED_CC_SKILLS=$(find "$REPO_ROOT/generated/claude/skills" -name "SKILL.md" | wc -l | tr -d ' ')
EXPECTED_CC_RULES=$(find "$REPO_ROOT/generated/claude/rules" -name "*.md" | wc -l | tr -d ' ')

INSTALL_OUTPUT=$("$REPO_ROOT/install.sh")

if echo "$INSTALL_OUTPUT" | grep -qE "Claude Code: ${EXPECTED_CC_AGENTS} agents, ${EXPECTED_CC_SKILLS} skills, ${EXPECTED_CC_RULES} rules"; then
    success "Claude Code counts (${EXPECTED_CC_AGENTS}/${EXPECTED_CC_SKILLS}/${EXPECTED_CC_RULES}) unaffected by foreign files in shared dirs"
else
    error "Claude Code counts were inflated by foreign files in shared directories"
fi

# Foreign files themselves must be left alone — none are tracked by our
# manifest, and install should never delete files it doesn't own.
for foreign in \
    "$CLAUDE_AGENTS_DIR/foreign-tool.md" \
    "$CLAUDE_SKILLS_TARGET_DIR/foreign-skill/SKILL.md" \
    "$CLAUDE_RULES_DIR/foreign-tool.md"; do
    if [[ ! -f "$foreign" ]]; then
        error "Foreign file was unexpectedly removed — install should not touch files it doesn't manage: $foreign"
    fi
done
success "Foreign files in all three shared directories left untouched"

rm -f "$CLAUDE_AGENTS_DIR/foreign-tool.md" "$CLAUDE_RULES_DIR/foreign-tool.md"
rm -rf "$CLAUDE_SKILLS_TARGET_DIR/foreign-skill"

# Test uninstall
info "Running uninstall..."
"$REPO_ROOT/install.sh" uninstall > /dev/null

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

# Verify the shared write-guard hook script removed
if [[ -f "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not removed: $GUARD_SCRIPT"
fi
success "write-guard hook script removed"

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
mkdir -p "$CLAUDE_AGENTS_DIR"
for agent in "$REPO_ROOT"/generated/claude/agents/*.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    ln -s "$agent" "$CLAUDE_AGENTS_DIR/$name"
done

# Run install — should migrate symlinks to copies
"$REPO_ROOT/install.sh" > /dev/null

for agent in "$REPO_ROOT"/generated/claude/agents/*.md; do
    [[ -f "$agent" ]] || continue
    name=$(basename "$agent")
    if [[ -L "$CLAUDE_AGENTS_DIR/$name" ]]; then
        error "Symlink not migrated to copy: $name"
    fi
    if [[ ! -f "$CLAUDE_AGENTS_DIR/$name" ]]; then
        error "File not present after migration: $name"
    fi
done
success "Symlinks migrated to copies"

# Clean up for final state
"$REPO_ROOT/install.sh" uninstall > /dev/null

echo ""
echo "${GREEN}All install tests passed (isolated mode)${NC}"
