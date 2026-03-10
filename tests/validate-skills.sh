#!/bin/zsh
#
# Validate agent and skill structure and content
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="$SCRIPT_DIR/.."
AGENTS_DIR="$REPO_ROOT/generated/copilot/agents"
SKILLS_DIR="$REPO_ROOT/generated/copilot/skills"

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

# Validate Custom Agents
echo "═══════════════════════════════════════════"
echo "Validating Custom Agents in $AGENTS_DIR"
echo "═══════════════════════════════════════════"
echo ""

for agent_file in "$AGENTS_DIR"/*.agent.md; do
    [[ -f "$agent_file" ]] || continue
    
    agent_name=$(basename "$agent_file" .agent.md)
    
    # Check frontmatter has name
    if ! grep -q "^name:" "$agent_file"; then
        error "$agent_name: Missing 'name' in frontmatter"
    fi
    
    # Check frontmatter has description
    if ! grep -q "^description:" "$agent_file"; then
        error "$agent_name: Missing 'description' in frontmatter"
    fi
    
    # Check frontmatter has tools
    if ! grep -q "^tools:" "$agent_file"; then
        error "$agent_name: Missing 'tools' in frontmatter"
    fi
    
    # Check for handoffs (optional but expected for workflow agents)
    if ! grep -q "^handoffs:" "$agent_file"; then
        if [[ "$agent_name" != "reviewer" ]]; then
            warn "$agent_name: No 'handoffs' defined"
        fi
    fi
    
    # Check line count
    lines=$(wc -l < "$agent_file" | tr -d ' ')
    
    success "$agent_name.agent.md: Valid ($lines lines)"
done

echo ""
echo "═══════════════════════════════════════════"
echo "Validating Agent Skills in $SKILLS_DIR"
echo "═══════════════════════════════════════════"
echo ""

# Check each skill
for skill_dir in "$SKILLS_DIR"/*/; do
    [[ -d "$skill_dir" ]] || continue
    
    skill_name=$(basename "$skill_dir")
    skill_file="$skill_dir/SKILL.md"
    
    # Check SKILL.md exists
    if [[ ! -f "$skill_file" ]]; then
        error "$skill_name: Missing SKILL.md"
        continue
    fi
    
    # Check frontmatter has name
    if ! grep -q "^name:" "$skill_file"; then
        error "$skill_name: Missing 'name' in frontmatter"
    fi
    
    # Check frontmatter has description
    if ! grep -q "^description:" "$skill_file"; then
        error "$skill_name: Missing 'description' in frontmatter"
    fi
    
    # Check description contains "Triggers on:"
    if ! grep -q "Triggers on:" "$skill_file"; then
        warn "$skill_name: No 'Triggers on:' in description"
    fi
    
    # Check for unique "use X mode" trigger (accepts single or double quotes)
    if ! grep -qE "'use [a-z-]+ mode'|\"use [a-z-]+ mode\"" "$skill_file"; then
        warn "$skill_name: Missing unique 'use X mode' trigger"
    fi
    
    # Check description contains "Use when" (in first ~100 chars of description)
    desc_start=$(sed -n '/^description:/p' "$skill_file" | head -c 150)
    if ! echo "$desc_start" | grep -qi "use when"; then
        warn "$skill_name: Description should start with 'Use when' (focus on triggers, not workflow)"
    fi
    
    # Check description length (extract description block, count chars)
    desc_length=$(sed -n '/^description:/,/^---/p' "$skill_file" | grep -v '^---' | wc -c | tr -d ' ')
    if [[ $desc_length -gt 500 ]]; then
        warn "$skill_name: Description is $desc_length chars (recommended < 500)"
    fi
    
    # Check line count (warn if over 500 - progressive disclosure)
    lines=$(wc -l < "$skill_file" | tr -d ' ')
    if [[ $lines -gt 500 ]]; then
        warn "$skill_name: $lines lines (recommended < 500, use separate files for heavy reference)"
    elif [[ $lines -gt 300 ]]; then
        info "$skill_name: $lines lines (consider splitting if it grows further)"
    fi
    
    success "$skill_name: Valid ($lines lines)"
done

echo ""

# Check for duplicate triggers across skills
echo "Checking for duplicate 'use X mode' triggers..."
triggers=$(grep -h '"use [a-z-]* mode"' "$SKILLS_DIR"/*/SKILL.md 2>/dev/null | sort)
duplicates=$(echo "$triggers" | uniq -d)
if [[ -n "$duplicates" ]]; then
    error "Duplicate triggers found:"
    echo "$duplicates"
fi

echo ""
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
    lines=$(wc -l < "$skill_file" | tr -d ' ')
    success "$name (CC): Valid ($lines lines)"
done

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
echo "Checking cross-platform parity..."
echo "═══════════════════════════════════════════"
echo ""

copilot_agents=$(find "$REPO_ROOT/generated/copilot/agents" -name "*.agent.md" 2>/dev/null | wc -l | tr -d ' ')
cc_agents=$(find "$REPO_ROOT/generated/claude/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$copilot_agents" -eq "$cc_agents" ]]; then
    success "Agent count matches ($copilot_agents)"
else
    error "Agent count mismatch: Copilot=$copilot_agents CC=$cc_agents"
fi

copilot_skills=$(find "$REPO_ROOT/generated/copilot/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
cc_skills=$(find "$REPO_ROOT/generated/claude/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [[ "$copilot_skills" -eq "$cc_skills" ]]; then
    success "Skill count matches ($copilot_skills)"
else
    error "Skill count mismatch: Copilot=$copilot_skills CC=$cc_skills"
fi

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
