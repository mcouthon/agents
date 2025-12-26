#!/bin/zsh
#
# Validate skill structure and content
#

set -e

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="$SCRIPT_DIR/.."
SKILLS_DIR="$REPO_ROOT/.github/skills"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

error() { echo "${RED}❌${NC} $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "${YELLOW}⚠️${NC}  $1"; WARNINGS=$((WARNINGS + 1)); }
success() { echo "${GREEN}✓${NC} $1"; }

echo "Validating skills in $SKILLS_DIR"
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
    
    # Check for unique "use X mode" trigger
    if ! grep -q '"use [a-z-]* mode"' "$skill_file"; then
        warn "$skill_name: Missing unique 'use X mode' trigger"
    fi
    
    # Check line count (warn if over 300)
    lines=$(wc -l < "$skill_file" | tr -d ' ')
    if [[ $lines -gt 300 ]]; then
        warn "$skill_name: $lines lines (recommended < 300)"
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

if [[ $ERRORS -gt 0 ]]; then
    echo "${RED}$ERRORS errors${NC}, $WARNINGS warnings"
    exit 1
fi

if [[ $WARNINGS -gt 0 ]]; then
    echo "${YELLOW}$WARNINGS warnings${NC}, no errors"
else
    echo "${GREEN}All skills valid${NC}"
fi
