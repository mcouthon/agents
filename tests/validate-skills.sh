#!/bin/zsh
#
# Validate agent and skill structure and content
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

error() { echo "${RED}❌${NC} $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "${YELLOW}⚠️${NC}  $1"; WARNINGS=$((WARNINGS + 1)); }
success() { echo "${GREEN}✓${NC} $1"; }
info() { echo "${BLUE}ℹ${NC} $1"; }

echo "═══════════════════════════════════════════"
echo "Validating CC Agents in $REPO_ROOT/generated/claude/agents/"
echo "═══════════════════════════════════════════"
echo ""

CC_AGENTS_DIR="$REPO_ROOT/generated/claude/agents"
for agent_file in "$CC_AGENTS_DIR"/*.md; do
    [[ -f "$agent_file" ]] || continue
    name=$(basename "$agent_file" .md)
    if ! grep -q "^tools:" "$agent_file"; then
        error "$name (CC): Missing 'tools' in frontmatter"
    fi
    if ! grep -q "^model:" "$agent_file"; then
        warn "$name (CC): No 'model' in frontmatter"
    fi
    lines=$(wc -l < "$agent_file" | tr -d ' ')
    success "$name (CC): Valid ($lines lines)"
done

echo ""
echo "═══════════════════════════════════════════"
echo "Validating CC Skills in $REPO_ROOT/generated/claude/skills/"
echo "═══════════════════════════════════════════"
echo ""

CC_SKILLS_DIR="$REPO_ROOT/generated/claude/skills"
for skill_dir in "$CC_SKILLS_DIR"/*/; do
    [[ -d "$skill_dir" ]] || continue
    name=$(basename "$skill_dir")
    skill_file="$skill_dir/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        error "$name (CC): Missing SKILL.md"
        continue
    fi
    if ! grep -q "^name:" "$skill_file"; then
        error "$name (CC): Missing 'name'"
    fi
    if ! grep -q "^description:" "$skill_file"; then
        error "$name (CC): Missing 'description'"
    fi
    # Check line count (warn if over 500 - progressive disclosure)
    lines=$(wc -l < "$skill_file" | tr -d ' ')
    if [[ $lines -gt 500 ]]; then
        warn "$name (CC): $lines lines (recommended < 500, use separate files for heavy reference)"
    elif [[ $lines -gt 300 ]]; then
        info "$name (CC): $lines lines (consider splitting if it grows further)"
    fi
    success "$name (CC): Valid ($lines lines)"
done

echo ""

# Check for duplicate triggers across CC skills
echo "Checking for duplicate 'use X mode' triggers..."
triggers=$(grep -h '"use [a-z-]* mode"' "$CC_SKILLS_DIR"/*/SKILL.md 2>/dev/null | sort)
duplicates=$(echo "$triggers" | uniq -d)
if [[ -n "$duplicates" ]]; then
    error "Duplicate triggers found:"
    echo "$duplicates"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "Validating CC Rules in $REPO_ROOT/generated/claude/rules/"
echo "═══════════════════════════════════════════"
echo ""

CC_RULES_DIR="$REPO_ROOT/generated/claude/rules"
for rule_file in "$CC_RULES_DIR"/*.md; do
    [[ -f "$rule_file" ]] || continue
    name=$(basename "$rule_file" .md)
    if [[ "$name" == "global" ]]; then
        first_line=$(head -1 "$rule_file")
        if [[ "$first_line" == "---" ]]; then
            error "global rule should not have frontmatter"
        fi
    fi
    lines=$(wc -l < "$rule_file" | tr -d ' ')
    success "$name (CC rule): Valid ($lines lines)"
done

echo ""
echo "═══════════════════════════════════════════"

if [[ $ERRORS -gt 0 ]]; then
    echo "${RED}$ERRORS errors${NC}, $WARNINGS warnings"
    exit 1
fi

if [[ $WARNINGS -gt 0 ]]; then
    echo "${YELLOW}$WARNINGS warnings${NC}, no errors"
else
    echo "${GREEN}All skills valid${NC}"
fi
