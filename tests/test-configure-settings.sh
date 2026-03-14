#!/bin/bash
#
# Test configure-vscode-settings.js with various scenarios
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

PASSED=0
FAILED=0

run_test() {
    local name="$1"
    local input="$2"
    local expected_exit="$3"
    
    echo "$input" > "$TEST_DIR/settings.json"
    
    set +e
    node "$SCRIPT_DIR/../scripts/configure-vscode-settings.js" "$TEST_DIR/settings.json" >/dev/null 2>&1
    local exit_code=$?
    set -e
    
    if [[ $exit_code -ne $expected_exit ]]; then
        echo "❌ $name (exit $exit_code, expected $expected_exit)"
        FAILED=$((FAILED + 1))
        return 1
    fi
    return 0
}

verify_contains() {
    local file="$1"
    local pattern="$2"
    if grep -q "$pattern" "$file"; then
        return 0
    else
        echo "   Missing: $pattern"
        return 1
    fi
}

pass() { echo "✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "❌ $1"; FAILED=$((FAILED + 1)); }

# Test 1: Empty object
if run_test "Empty object" '{}' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/instructions"'; then
    pass "Empty object"
else
    fail "Empty object"
fi

# Test 2: Existing settings, no agent config
if run_test "Existing settings" '{ "editor.fontSize": 14, "terminal.integrated.fontSize": 12 }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"editor.fontSize"'; then
    pass "Existing settings"
else
    fail "Existing settings"
fi

# Test 3: Agent setting exists but without our entry
if run_test "Setting exists, missing entry" '{ "chat.agentFilesLocations": { "other/path": true } }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"other/path"'; then
    pass "Setting exists, missing entry"
else
    fail "Setting exists, missing entry"
fi

# Test 4: Already configured (should exit 1)
if run_test "Already configured" '{
  "chat.agentSkillsLocations": { "~/.copilot/skills": true, "~/.claude/skills": false },
  "chat.agentFilesLocations": { "~/.copilot/agents": true, "~/.claude/agents": false },
  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true, "~/.claude/rules": false },
  "chat.customAgentInSubagent.enabled": true,
  "chat.experimental.useSkillAdherencePrompt": true
}' 1; then pass "Already configured"; else fail "Already configured"; fi

# Test 5: Empty dict (no trailing comma issue)
if run_test "Empty setting dict" '{ "chat.agentFilesLocations": {} }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   ! grep -q 'true,}' "$TEST_DIR/settings.json"; then
    pass "Empty setting dict"
else
    fail "Empty setting dict"
fi

# Test 6: With comments (JSONC)
if run_test "With comments" '{ // comment
  "editor.fontSize": 14 /* block */ }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '// comment'; then
    pass "With comments"
else
    fail "With comments"
fi

# Test 7: Trailing comma
if run_test "Trailing comma" '{ "editor.fontSize": 14, }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"'; then
    pass "Trailing comma"
else
    fail "Trailing comma"
fi

# Test 8: Complex nested structure
if run_test "Complex nested" '{ "[python]": { "editor.formatOnSave": true }, "chat.agentFilesLocations": { "workspace/agents": true } }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"editor.formatOnSave"'; then
    pass "Complex nested"
else
    fail "Complex nested"
fi

# Test 9: File with BOM
printf '\xEF\xBB\xBF{ "editor.fontSize": 14 }' > "$TEST_DIR/settings.json"
if node "$SCRIPT_DIR/../scripts/configure-vscode-settings.js" "$TEST_DIR/settings.json" >/dev/null 2>&1 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"'; then
    pass "File with BOM"
else
    fail "File with BOM"
fi

# Test 10: Non-existent file
set +e
node "$SCRIPT_DIR/../scripts/configure-vscode-settings.js" "$TEST_DIR/nonexistent.json" >/dev/null 2>&1
exit_code=$?
set -e
if [[ $exit_code -eq 2 ]]; then pass "Non-existent file"; else fail "Non-existent file (exit $exit_code)"; fi

# Test 11: Empty file
> "$TEST_DIR/settings.json"
set +e
node "$SCRIPT_DIR/../scripts/configure-vscode-settings.js" "$TEST_DIR/settings.json" >/dev/null 2>&1
exit_code=$?
set -e
if [[ $exit_code -eq 2 ]]; then pass "Empty file"; else fail "Empty file (exit $exit_code)"; fi

# Test 12: Whitespace-only file
printf '   \n  ' > "$TEST_DIR/settings.json"
set +e
node "$SCRIPT_DIR/../scripts/configure-vscode-settings.js" "$TEST_DIR/settings.json" >/dev/null 2>&1
exit_code=$?
set -e
if [[ $exit_code -eq 2 ]]; then pass "Whitespace-only file"; else fail "Whitespace-only file (exit $exit_code)"; fi

# Test 13: Nested objects
if run_test "Nested similar keys" '{ "[python]": { "editor.formatOnSave": true }, "workbench.colorCustomizations": { "statusBar.background": "#005f87" } }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"editor.formatOnSave"'; then
    pass "Nested similar keys"
else
    fail "Nested similar keys"
fi

# Test 14: All settings already configured (including booleans)
if run_test "All settings configured" '{
  "chat.agentSkillsLocations": { "~/.copilot/skills": true, "~/.claude/skills": false },
  "chat.agentFilesLocations": { "~/.copilot/agents": true, "~/.claude/agents": false },
  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true, "~/.claude/rules": false },
  "chat.customAgentInSubagent.enabled": true,
  "chat.experimental.useSkillAdherencePrompt": true
}' 1; then pass "All settings configured"; else fail "All settings configured"; fi

# Test 15: Realistic large settings.json
LARGE_SETTINGS='{ "editor.fontSize": 14, "[python]": { "editor.formatOnSave": true }, "github.copilot.enable": { "*": true } }'
if run_test "Realistic large file" "$LARGE_SETTINGS" 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/agents"' &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/skills"' &&
   verify_contains "$TEST_DIR/settings.json" '"editor.fontSize"'; then
    pass "Realistic large file"
else
    fail "Realistic large file"
fi

# Test 16: Partially configured
if run_test "Partially configured" '{ "chat.agentFilesLocations": { "~/.copilot/agents": true }, "chat.customAgentInSubagent.enabled": true }' 0 &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/instructions"' &&
   verify_contains "$TEST_DIR/settings.json" '"~/.copilot/skills"'; then
    pass "Partially configured"
else
    fail "Partially configured"
fi

# =========================================================================
# Value Correction Tests (PR #8 use case)
# =========================================================================

# Test 17: Boolean with wrong value
if run_test "Correct wrong boolean" '{ "chat.customAgentInSubagent.enabled": false }' 0 &&
   grep -q '"chat.customAgentInSubagent.enabled": true' "$TEST_DIR/settings.json"; then
    pass "Correct wrong boolean"
else
    fail "Correct wrong boolean"
fi

# Test 18: Object entry with wrong value
if run_test "Correct wrong entry" '{ "chat.agentFilesLocations": { "~/.copilot/agents": false } }' 0 &&
   grep -q '"~/.copilot/agents": true' "$TEST_DIR/settings.json"; then
    pass "Correct wrong entry"
else
    fail "Correct wrong entry"
fi

# Test 19: Claude entry should be false
if run_test "Correct claude entry" '{ "chat.agentFilesLocations": { "~/.claude/agents": true } }' 0 &&
   grep -q '"~/.claude/agents": false' "$TEST_DIR/settings.json"; then
    pass "Correct claude entry"
else
    fail "Correct claude entry"
fi

# Test 20: Mixed correct/wrong/missing
if run_test "Mixed values" '{ "chat.agentFilesLocations": { "~/.copilot/agents": false, "~/.claude/agents": true }, "chat.customAgentInSubagent.enabled": false }' 0 &&
   grep -q '"~/.copilot/agents": true' "$TEST_DIR/settings.json" &&
   grep -q '"~/.claude/agents": false' "$TEST_DIR/settings.json" &&
   grep -q '"chat.customAgentInSubagent.enabled": true' "$TEST_DIR/settings.json"; then
    pass "Mixed values"
else
    fail "Mixed values"
fi

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
