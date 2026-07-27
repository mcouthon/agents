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
CLAUDE_HOOKS_DIR="$HOME_DIR/.claude/hooks"
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

# Verify the shared write-guard hook script is installed and executable
GUARD_SCRIPT="$CLAUDE_HOOKS_DIR/write-guard.sh"
if [[ ! -f "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not installed: $GUARD_SCRIPT"
fi
if [[ ! -x "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not executable: $GUARD_SCRIPT"
fi
success "write-guard hook script installed and executable"

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
if grep -q "Claude Opus 9.9" "$VSCODE_AGENTS_DIR/explorer.agent.md"; then
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

# Test: models.gpt + agents override survives migrate + install round-trip
info "Testing models.gpt + agents override round-trip..."
cat > "$AGENTS_CONFIG_FILE" << 'GPTAGENTRT'
{
  "models": { "opus": "9.9", "sonnet": "8.8", "gpt": "5.5" },
  "agents": { "conductor": { "copilot": "gpt" } }
}
GPTAGENTRT

"$REPO_ROOT/install.sh" > /dev/null

# Assert models.gpt preserved in user config (migrate must not drop it)
if node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(c.models.gpt==='5.5'?0:1)" "$AGENTS_CONFIG_FILE"; then
    success "models.gpt preserved in config after migrate+install"
else
    error "models.gpt was lost or corrupted after migrate+install!"
fi

# Assert agents.conductor.copilot preserved in user config (migrate must not drop it)
if node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(c.agents&&c.agents.conductor&&c.agents.conductor.copilot==='gpt'?0:1)" "$AGENTS_CONFIG_FILE"; then
    success "agents.conductor.copilot preserved in config after migrate+install"
else
    error "agents.conductor.copilot was lost or corrupted after migrate+install!"
fi

# Assert Copilot conductor reflects the override: GPT-5.5
if grep -q "GPT-5.5" "$VSCODE_AGENTS_DIR/conductor.agent.md"; then
    success "Copilot conductor shows GPT-5.5 after agents override"
else
    error "Copilot conductor does not show GPT-5.5 — override not applied!"
fi

# Assert CC conductor stays on Claude Opus (override must not leak into CC)
if grep -q "^model: opus" "$CLAUDE_AGENTS_DIR/conductor.md"; then
    success "CC conductor stays model: opus (not affected by non-Claude override)"
else
    error "CC conductor model: opus is missing — non-Claude override may have leaked into CC!"
fi

# Negative: GPT-5.5 must NOT appear in the CC conductor
if ! grep -q "GPT-5.5" "$CLAUDE_AGENTS_DIR/conductor.md"; then
    success "CC conductor does not contain GPT-5.5 (no leakage)"
else
    error "GPT-5.5 found in CC conductor — non-Claude type leaked into CC output!"
fi

# Negative isolation: GPT-5.5 must NOT appear in a non-overridden Copilot agent
if ! grep -q "GPT-5.5" "$VSCODE_AGENTS_DIR/explorer.agent.md"; then
    success "Copilot explorer does not contain GPT-5.5 (override is scoped to conductor)"
else
    error "GPT-5.5 found in Copilot explorer — agents override is not scoped correctly!"
fi

# Test: models.gpt-terra + models.gpt-sol survive migrate + install round-trip (Task 094)
info "Testing models.gpt-terra + models.gpt-sol round-trip..."
cat > "$AGENTS_CONFIG_FILE" << 'GPTVARIANTRT'
{
  "models": { "opus": "4.6", "sonnet": "4.6", "haiku": "4.5", "gpt-terra": "5.6 Terra", "gpt-sol": "5.6 Sol" },
  "agents": { "conductor": { "copilot": "gpt-terra" }, "explorer": { "copilot": "gpt-sol" } }
}
GPTVARIANTRT

"$REPO_ROOT/install.sh" > /dev/null

# Assert both new keys preserved in user config (migrate must not drop them)
if node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(c.models['gpt-terra']==='5.6 Terra'&&c.models['gpt-sol']==='5.6 Sol'?0:1)" "$AGENTS_CONFIG_FILE"; then
    success "models.gpt-terra and models.gpt-sol preserved in config after migrate+install"
else
    error "models.gpt-terra / models.gpt-sol was lost or corrupted after migrate+install!"
fi

# Assert installed Copilot conductor reflects gpt-terra override
if grep -q "GPT-5.6 Terra" "$VSCODE_AGENTS_DIR/conductor.agent.md"; then
    success "Copilot conductor shows GPT-5.6 Terra after agents override"
else
    error "Copilot conductor does not show GPT-5.6 Terra — override not applied!"
fi

# Assert installed Copilot explorer reflects gpt-sol override
if grep -q "GPT-5.6 Sol" "$VSCODE_AGENTS_DIR/explorer.agent.md"; then
    success "Copilot explorer shows GPT-5.6 Sol after agents override"
else
    error "Copilot explorer does not show GPT-5.6 Sol — override not applied!"
fi

# Assert CC conductor stays on Claude Opus (override must not leak into CC)
if grep -q "^model: opus" "$CLAUDE_AGENTS_DIR/conductor.md"; then
    success "CC conductor stays model: opus (not affected by gpt-terra override)"
else
    error "CC conductor model: opus is missing — gpt-terra override may have leaked into CC!"
fi

# Negative: GPT must NOT appear in the CC conductor
if ! grep -q "GPT" "$CLAUDE_AGENTS_DIR/conductor.md"; then
    success "CC conductor does not contain GPT (no leakage)"
else
    error "GPT found in CC conductor — non-Claude type leaked into CC output!"
fi

# Test: Stale file cleanup on reinstall
info "Test: Stale file cleanup on reinstall"

# Create a fake stale file at the HOME_DIR path and add to manifest
mkdir -p "$HOME_DIR/.copilot/agents"
echo "stale content" > "$HOME_DIR/.copilot/agents/stale-agent.agent.md"
echo "$HOME_DIR/.copilot/agents/stale-agent.agent.md" >> "$MANIFEST_FILE"

# Reinstall — should detect and remove the stale file
"$REPO_ROOT/install.sh" > /dev/null

# Verify stale file was removed
if [[ -f "$HOME_DIR/.copilot/agents/stale-agent.agent.md" ]]; then
    error "Stale file was not removed on reinstall"
fi
success "Stale files cleaned up on reinstall"

# Test: Known orphan cleanup (files installed before manifest tracking)
info "Test: Known orphan cleanup (pre-manifest worker files)"

# Simulate worker files left over from an old install that predates manifest tracking.
# They are NOT in the manifest — only present on disk.
mkdir -p "$HOME_DIR/.claude/agents" "$HOME_DIR/.copilot/agents"
echo "old worker content" > "$HOME_DIR/.claude/agents/worker.md"
echo "old worker content" > "$HOME_DIR/.copilot/agents/worker.agent.md"

# Reinstall — should remove the worker files even though they're not in the manifest
"$REPO_ROOT/install.sh" > /dev/null

if [[ -f "$HOME_DIR/.claude/agents/worker.md" ]]; then
    error "Known orphan ~/.claude/agents/worker.md was not removed"
fi
if [[ -f "$HOME_DIR/.copilot/agents/worker.agent.md" ]]; then
    error "Known orphan ~/.copilot/agents/worker.agent.md was not removed"
fi
success "Known orphan worker files cleaned up on reinstall"

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

# Verify the shared write-guard hook script removed
if [[ -f "$GUARD_SCRIPT" ]]; then
    error "write-guard hook script not removed: $GUARD_SCRIPT"
fi
success "write-guard hook script removed"

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
