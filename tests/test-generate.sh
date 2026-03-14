#!/bin/zsh
# Integration tests for scripts/generate.js

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "✗ $1"; FAIL=$((FAIL + 1)); }

echo "Testing generate.js..."
cd "$SCRIPT_DIR"

# Test 1: --help exits 0
node scripts/generate.js --help >/dev/null 2>&1 && pass "Help flag works" || fail "Help flag failed"

# Test 2: Missing command exits 2
node scripts/generate.js >/dev/null 2>&1 && fail "Missing command should exit non-zero" || {
  code=$?
  [[ $code -eq 2 ]] && pass "Missing command exits 2" || fail "Missing command exited $code (expected 2)"
}

# Test 3: Dry run exits 0 or 1
node scripts/generate.js all --dry-run >/dev/null 2>&1; dry_code=$?
[[ $dry_code -eq 0 || $dry_code -eq 1 ]] && pass "Dry run succeeds" || fail "Dry run exited $dry_code"

# Test 4: Generate all files
node scripts/generate.js all --source "$SCRIPT_DIR/templates" >/dev/null 2>&1; gen_code=$?
[[ $gen_code -eq 0 || $gen_code -eq 1 ]] && pass "Generate all succeeds" || fail "Generate all exited $gen_code"

# Test 5: Verify Copilot agent file count
AGENT_COUNT=$(find "$SCRIPT_DIR/generated/copilot/agents" -name "*.agent.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$AGENT_COUNT" -ge 7 ]]; then
  pass "Generated $AGENT_COUNT Copilot agents (expected 7)"
else
  fail "Expected 7 Copilot agents, got $AGENT_COUNT"
fi

# Test 6: Verify Copilot skill count
SKILL_COUNT=$(find "$SCRIPT_DIR/generated/copilot/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SKILL_COUNT" -ge 12 ]]; then
  pass "Generated $SKILL_COUNT Copilot skills (expected 12)"
else
  fail "Expected 12 Copilot skills, got $SKILL_COUNT"
fi

# Test 7: Verify Copilot instruction count
INSTR_COUNT=$(find "$SCRIPT_DIR/generated/copilot/instructions" -name "*.instructions.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$INSTR_COUNT" -ge 4 ]]; then
  pass "Generated $INSTR_COUNT Copilot instructions (expected 4)"
else
  fail "Expected 4 Copilot instructions, got $INSTR_COUNT"
fi

# Test 8: Verify CC agent count
CC_AGENT_COUNT=$(find "$SCRIPT_DIR/generated/claude/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_AGENT_COUNT" -ge 7 ]]; then
  pass "Generated $CC_AGENT_COUNT CC agents (expected 7)"
else
  fail "Expected 7 CC agents, got $CC_AGENT_COUNT"
fi

# Test 9: Verify CC skill count
CC_SKILL_COUNT=$(find "$SCRIPT_DIR/generated/claude/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_SKILL_COUNT" -ge 12 ]]; then
  pass "Generated $CC_SKILL_COUNT CC skills (expected 12)"
else
  fail "Expected 12 CC skills, got $CC_SKILL_COUNT"
fi

# Test 10: Verify CC rule count
CC_RULE_COUNT=$(find "$SCRIPT_DIR/generated/claude/rules" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_RULE_COUNT" -ge 4 ]]; then
  pass "Generated $CC_RULE_COUNT CC rules (expected 4)"
else
  fail "Expected 4 CC rules, got $CC_RULE_COUNT"
fi

# Test 11: Idempotent - second run should report unchanged or no changes
OUTPUT=$(node scripts/generate.js all 2>&1)
node scripts/generate.js all >/dev/null 2>&1
idem_code=$?
[[ $idem_code -eq 1 ]] && pass "Idempotent: second run exits 1 (no changes)" || {
  # Check if updated shows - there should be no updates
  if echo "$OUTPUT" | grep -q "(updated)"; then
    fail "Idempotent: second run still updating files"
  else
    pass "Idempotent: no files updated on second run"
  fi
}

# Test 12: Global CC rule has no frontmatter
GLOBAL_RULE="$SCRIPT_DIR/generated/claude/rules/global.md"
if [[ -f "$GLOBAL_RULE" ]]; then
  first_line=$(head -1 "$GLOBAL_RULE")
  if [[ "$first_line" != "---" ]]; then
    pass "Global CC rule has no frontmatter"
  else
    fail "Global CC rule should have no frontmatter"
  fi
else
  fail "Global CC rule file not found"
fi

# Test 13: make validate exits 0
make validate >/dev/null 2>&1 && pass "make validate succeeds" || fail "make validate failed"

# Test 14: make copilot exits 0
make copilot >/dev/null 2>&1 && pass "make copilot succeeds" || fail "make copilot failed"

# Test 15: make cc exits 0
make cc >/dev/null 2>&1 && pass "make cc succeeds" || fail "make cc failed"

# Test 16: generate copilot subcommand only
node scripts/generate.js copilot >/dev/null 2>&1 && pass "Generate copilot subcommand succeeds" || fail "Generate copilot subcommand failed"

# Test 17: generate cc subcommand only
node scripts/generate.js cc >/dev/null 2>&1 && pass "Generate cc subcommand succeeds" || fail "Generate cc subcommand failed"

# Test 18: CC agents have required 'tools:' frontmatter
cc_fm_ok=true
for agent in "$SCRIPT_DIR"/generated/claude/agents/*.md; do
  [[ -f "$agent" ]] || continue
  if ! grep -q "^tools:" "$agent"; then
    cc_fm_ok=false
    echo "  Missing tools: in $(basename $agent)"
  fi
done
[[ "$cc_fm_ok" == true ]] && pass "CC agents have tools: frontmatter" || fail "CC agents missing tools: frontmatter"

# Test 19: CC rules with frontmatter have paths: scoping
cc_paths_ok=true
for rule in "$SCRIPT_DIR"/generated/claude/rules/*.md; do
  [[ -f "$rule" ]] || continue
  first_line=$(head -1 "$rule")
  # Only check rules that have frontmatter (global and terminal apply unconditionally)
  [[ "$first_line" == "---" ]] || continue
  if ! grep -q "^paths:" "$rule"; then
    cc_paths_ok=false
    echo "  Missing paths: in $(basename $rule)"
  fi
done
[[ "$cc_paths_ok" == true ]] && pass "CC rules with frontmatter have paths: scoping" || fail "CC rules missing paths: scoping"

# Test 20: Model resolution from config (using --output-dir instead of destructive rm)
TEST_DIR=$(mktemp -d)
cleanup_test_dir() { rm -rf "$TEST_DIR" 2>/dev/null; }
trap cleanup_test_dir EXIT
mkdir -p "$TEST_DIR/config"
printf '%s\n' '{"models": {"opus": "9.9", "sonnet": "8.8"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output" >/dev/null 2>&1
if grep -q "Claude Opus 9.9 (copilot)" "$TEST_DIR/output/copilot/agents/explorer.agent.md" && \
   grep -q "Claude Sonnet 8.8 (copilot)" "$TEST_DIR/output/copilot/agents/reviewer.agent.md"; then
  pass "Model resolution from config works"
else
  fail "Model not resolved from config"
fi

# Test 21: Malformed config fails loudly
printf '%s\n' '{"invalid": json}' > "$TEST_DIR/config/config.json"
if node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" 2>/dev/null; then
  fail "Should fail on malformed JSON config"
else
  pass "Malformed config fails loudly"
fi

# Test 22: Default config file exists
if [[ -f "$SCRIPT_DIR/defaults/config.json" ]]; then
  pass "Default config file exists"
else
  fail "Default config file not found at defaults/config.json"
fi

# Test 23: --output-dir writes to custom location
OUTPUT_TEST_DIR=$(mktemp -d)
node scripts/generate.js all --config defaults/config.json --output-dir "$OUTPUT_TEST_DIR" >/dev/null 2>&1
if [[ -d "$OUTPUT_TEST_DIR/copilot/agents" && -d "$OUTPUT_TEST_DIR/claude/agents" ]]; then
  pass "--output-dir creates both platform dirs"
else
  fail "--output-dir did not create expected directories"
fi
rm -rf "$OUTPUT_TEST_DIR"

# Test 24: --config with missing file exits 2
if node scripts/generate.js copilot --config /nonexistent/config.json 2>/dev/null; then
  fail "Should fail on missing config file"
else
  code=$?
  [[ $code -eq 2 ]] && pass "Missing config exits 2" || fail "Missing config exited $code (expected 2)"
fi

# Test 25: No --config defaults to defaults/config.json
node scripts/generate.js all --dry-run >/dev/null 2>&1; compat_code=$?
[[ $compat_code -eq 0 || $compat_code -eq 1 ]] && pass "No --config flag uses default config.json" || fail "No --config flag failed (exit $compat_code)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
