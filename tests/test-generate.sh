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
if [[ "$AGENT_COUNT" -ge 6 ]]; then
  pass "Generated $AGENT_COUNT Copilot agents (expected 6)"
else
  fail "Expected 6 Copilot agents, got $AGENT_COUNT"
fi

# Test 6: Verify Copilot skill count
SKILL_COUNT=$(find "$SCRIPT_DIR/generated/copilot/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SKILL_COUNT" -ge 12 ]]; then
  pass "Generated $SKILL_COUNT Copilot skills (expected 13)"
else
  fail "Expected 13 Copilot skills, got $SKILL_COUNT"
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
if [[ "$CC_AGENT_COUNT" -ge 6 ]]; then
  pass "Generated $CC_AGENT_COUNT CC agents (expected 6)"
else
  fail "Expected 6 CC agents, got $CC_AGENT_COUNT"
fi

# Test 9: Verify CC skill count
CC_SKILL_COUNT=$(find "$SCRIPT_DIR/generated/claude/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_SKILL_COUNT" -ge 12 ]]; then
  pass "Generated $CC_SKILL_COUNT CC skills (expected 13)"
else
  fail "Expected 13 CC skills, got $CC_SKILL_COUNT"
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
if grep -q "Claude Opus 9.9" "$TEST_DIR/output/copilot/agents/explorer.agent.md" && \
   grep -q "Claude Sonnet 8.8" "$TEST_DIR/output/copilot/agents/reviewer.agent.md"; then
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

# Test 26: Registry type "gpt" in models does not produce an unknown-type warning
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt":"5.5"}}' > "$TEST_DIR/config/config.json"
STDERR26=$(node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output26" 2>&1 >/dev/null)
if echo "$STDERR26" | grep -q 'Unknown model.*gpt'; then
  fail "Registry type gpt should not produce an unknown-type warning"
else
  pass "Registry type gpt accepted silently (no warning)"
fi

# Test 27: Truly unknown type "llama" still produces an unknown-type warning
printf '%s\n' '{"models":{"llama":"3"}}' > "$TEST_DIR/config/config.json"
STDERR27=$(node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output27" 2>&1 >/dev/null)
if echo "$STDERR27" | grep -q 'Unknown model.*llama'; then
  pass "Unknown type llama still warns"
else
  fail "Unknown type llama should produce an unknown-type warning"
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

# Tests 28-32: per-agent 'agents' override (Phase 3 behavior). Numbering appends
# cleanly; existing 20/21/26/27/22-25 ordering is intentionally left as-is.

# Test 28: Per-agent override yields GPT in Copilot; CC isolation (no leak)
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt":"5.5"},"agents":{"explorer":{"copilot":"gpt"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output28" >/dev/null 2>&1
if grep -q 'model: \["GPT-5.5"\]' "$TEST_DIR/output28/copilot/agents/explorer.agent.md" && \
   grep -q '^model: opus$' "$TEST_DIR/output28/claude/agents/explorer.md" && \
   ! grep -q 'GPT' "$TEST_DIR/output28/claude/agents/explorer.md"; then
  pass "Per-agent override: explorer Copilot is GPT-5.5, CC stays opus (no leak)"
else
  fail "Per-agent override: explorer Copilot is GPT-5.5, CC stays opus (no leak)"
fi

# Test 29: Conductor array-collapse; CC stays opus
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt":"5.5"},"agents":{"conductor":{"copilot":"gpt"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output29" >/dev/null 2>&1
if grep -q 'model: \["GPT-5.5"\]' "$TEST_DIR/output29/copilot/agents/conductor.agent.md" && \
   ! grep -q 'Claude Sonnet' "$TEST_DIR/output29/copilot/agents/conductor.agent.md" && \
   grep -q '^model: opus$' "$TEST_DIR/output29/claude/agents/conductor.md"; then
  pass "Conductor override: copilot array collapses to [GPT-5.5], CC stays opus"
else
  fail "Conductor override: copilot array collapses to [GPT-5.5], CC stays opus"
fi

# Test 30: Backward compatibility: no 'agents' section is inert
printf '%s\n' '{"models":{"opus":"7.1","sonnet":"7.2","haiku":"7.3"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output30a" >/dev/null 2>&1
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output30b" >/dev/null 2>&1
diff -r "$TEST_DIR/output30a" "$TEST_DIR/output30b" >/dev/null 2>&1
diff30_rc=$?
if [[ $diff30_rc -eq 0 ]] && \
   ! grep -rq 'GPT' "$TEST_DIR/output30a" && \
   grep -q '^model: opus$' "$TEST_DIR/output30a/claude/agents/explorer.md"; then
  pass "No agents section: output is deterministic and uses template Claude defaults"
else
  fail "No agents section: output is deterministic and uses template Claude defaults"
fi

# Test 31a: Unknown override type warns
printf '%s\n' '{"models":{"opus":"4.6"},"agents":{"explorer":{"copilot":"llama"}}}' > "$TEST_DIR/config/config.json"
STDERR31A=$(node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output31a" 2>&1 >/dev/null)
if echo "$STDERR31A" | grep -q 'Unknown model type "llama" for agent "explorer"'; then
  pass "Override unknown type warns (agents path)"
else
  fail "Override unknown type warns (agents path)"
fi

# Test 31b: Known type with no version entry warns
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5"},"agents":{"explorer":{"copilot":"gpt"}}}' > "$TEST_DIR/config/config.json"
STDERR31B=$(node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output31b" 2>&1 >/dev/null)
if echo "$STDERR31B" | grep -q 'Model type "gpt" for agent "explorer" has no version entry'; then
  pass "Override known type without models version warns (agents path)"
else
  fail "Override known type without models version warns (agents path)"
fi

# Test 32: Override for a non-existent agent name is a silent no-op
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt":"5.5"},"agents":{"nonexistent":{"copilot":"gpt"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output32" >/dev/null 2>&1
rc32=$?
STDERR32=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output32b" 2>&1 >/dev/null)
if [[ $rc32 -eq 0 ]] && \
   grep -q 'model: \["Claude Opus 4.6", "Claude Opus 5", "Claude Opus 4.8"\]' "$TEST_DIR/output32/copilot/agents/explorer.agent.md" && \
   ! grep -rq 'GPT' "$TEST_DIR/output32" && \
   ! echo "$STDERR32" | grep -q 'Warning:'; then
  pass "Override for unknown agent name is a silent no-op (no crash, no effect)"
else
  fail "Override for unknown agent name is a silent no-op (no crash, no effect)"
fi

# Test 33: GPT-5.6 Terra/Sol coexistence render + CC isolation (Task 094)
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt-terra":"5.6 Terra","gpt-sol":"5.6 Sol"},"agents":{"conductor":{"copilot":"gpt-terra"},"explorer":{"copilot":"gpt-sol"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output33" >/dev/null 2>&1
if grep -q 'model: \["GPT-5.6 Terra"\]' "$TEST_DIR/output33/copilot/agents/conductor.agent.md" && \
   grep -q 'model: \["GPT-5.6 Sol"\]' "$TEST_DIR/output33/copilot/agents/explorer.agent.md" && \
   grep -q '^model: opus$' "$TEST_DIR/output33/claude/agents/conductor.md" && \
   ! grep -q 'GPT' "$TEST_DIR/output33/claude/agents/conductor.md" && \
   ! grep -q 'GPT' "$TEST_DIR/output33/claude/agents/explorer.md"; then
  pass "GPT-5.6 Terra/Sol coexist: conductor Terra, explorer Sol, CC stays opus (no leak)"
else
  fail "GPT-5.6 Terra/Sol coexist: conductor Terra, explorer Sol, CC stays opus (no leak)"
fi

# Test 34: gpt-terra/gpt-sol in models does not produce an unknown-type warning
printf '%s\n' '{"models":{"opus":"4.6","sonnet":"4.6","haiku":"4.5","gpt-terra":"5.6 Terra","gpt-sol":"5.6 Sol"},"agents":{"conductor":{"copilot":"gpt-terra"},"explorer":{"copilot":"gpt-sol"}}}' > "$TEST_DIR/config/config.json"
STDERR34=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output34" 2>&1 >/dev/null)
if echo "$STDERR34" | grep -q 'Unknown model type "gpt-terra"' || echo "$STDERR34" | grep -q 'Unknown model type "gpt-sol"'; then
  fail "Registry types gpt-terra/gpt-sol should not produce an unknown-type warning"
else
  pass "Registry types gpt-terra/gpt-sol accepted silently (no warning)"
fi

# Test 35: Reviewer no-write prohibition present in both generated variants
# (guards Phase 1 of task 100-reviewer-write-lockdown against being lost in a
# future template refactor)
if grep -q "by ANY means" "$SCRIPT_DIR/generated/claude/agents/reviewer.md" && \
   grep -q "by ANY means" "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md"; then
  pass "Reviewer no-write prohibition present in CC and Copilot variants"
else
  fail "Reviewer no-write prohibition missing from CC and/or Copilot variants"
fi

# Test 36: Reviewer PreToolUse write-guard hook present in CC AND VS Code Copilot,
# absent from every other Copilot agent
# (guards Phase 2 (CC) + Phase 3 (VS Code Copilot) of task 100-reviewer-write-lockdown
# — the hard control. Both platforms reuse the same guard script verbatim.)
if grep -q "reviewer-write-guard.sh" "$SCRIPT_DIR/generated/claude/agents/reviewer.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/claude/agents/reviewer.md"; then
  pass "Reviewer PreToolUse write-guard hook present in CC variant"
else
  fail "Reviewer PreToolUse write-guard hook missing from CC variant"
fi
if grep -q "reviewer-write-guard.sh" "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md"; then
  pass "Reviewer PreToolUse write-guard hook present in VS Code Copilot variant"
else
  fail "Reviewer PreToolUse write-guard hook missing from VS Code Copilot variant"
fi
for agent in builder committer explorer; do
  if grep -q "reviewer-write-guard.sh" "$SCRIPT_DIR/generated/copilot/agents/${agent}.agent.md"; then
    fail "Reviewer write-guard hook leaked into Copilot ${agent} variant (Reviewer-only scoping broken)"
  else
    pass "Reviewer write-guard hook absent from Copilot ${agent} variant (Reviewer-only scoping intact)"
  fi
done

# Tests 37-41: per-tier same-tier fallback ARRAYS (Phase 1 of task
# 101-deterministic-model-selection). VS Code treats model: as a prioritized
# fallback list; each agent's array must list only its own tier (plus documented
# hidden/cross-tier safety nets), configured version leading.

# Test 37: opus-tier fallback array is same-tier only (no cross-tier Sonnet)
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output37" >/dev/null 2>&1
if grep -q 'model: \["Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.6"\]' "$TEST_DIR/output37/copilot/agents/conductor.agent.md" && \
   ! grep -Eq '^model: .*Claude Sonnet' "$TEST_DIR/output37/copilot/agents/conductor.agent.md"; then
  pass "Copilot conductor emits opus-tier fallback array (same-tier only, no Sonnet)"
else
  fail "Copilot conductor should emit opus-tier-only fallback array"
fi

# Test 38: sonnet-tier array includes the hidden Sonnet 4.6 fallback
if grep -q 'model: \["Claude Sonnet 5", "Claude Sonnet 4.6"\]' "$TEST_DIR/output37/copilot/agents/builder.agent.md"; then
  pass "Copilot builder emits sonnet-tier fallback array (Sonnet 5 -> hidden Sonnet 4.6)"
else
  fail "Copilot builder should emit sonnet-tier fallback array"
fi

# Test 39: haiku-tier array falls back cross-tier to ENABLED Sonnet 5 (no enabled haiku)
if grep -q 'model: \["Claude Haiku 4.5", "Claude Sonnet 5"\]' "$TEST_DIR/output37/copilot/agents/researcher.agent.md" && \
   grep -q 'model: \["Claude Haiku 4.5", "Claude Sonnet 5"\]' "$TEST_DIR/output37/copilot/agents/committer.agent.md"; then
  pass "Copilot researcher/committer emit haiku-tier array with ENABLED Sonnet 5 safety net"
else
  fail "Copilot researcher/committer should emit haiku-tier fallback array"
fi

# Test 40: configured version LEADS the array (primary-first ordering)
printf '%s\n' '{"models":{"opus":"4.8","sonnet":"5","haiku":"4.5"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output40" >/dev/null 2>&1
if grep -q 'model: \["Claude Opus 4.8", "Claude Opus 5", "Claude Opus 4.6"\]' "$TEST_DIR/output40/copilot/agents/explorer.agent.md"; then
  pass "Copilot: configured opus version (4.8) leads the tier array, rest best-first deduped"
else
  fail "Copilot: configured version should lead the tier fallback array"
fi

# Test 41: stale/invalid primary (not in COPILOT_TIER_FALLBACKS) still yields a
# same-tier array - primary first, then the valid same-tier fallbacks, no crash
# and no cross-tier leak. Demonstrates array resilience even with a stale pin.
printf '%s\n' '{"models":{"opus":"7.1","sonnet":"5","haiku":"4.5"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js copilot --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output41" >/dev/null 2>&1
rc41=$?
if [[ $rc41 -eq 0 ]] && \
   grep -q 'model: \["Claude Opus 7.1", "Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.6"\]' "$TEST_DIR/output41/copilot/agents/explorer.agent.md" && \
   ! grep -Eq '^model: .*Claude Sonnet' "$TEST_DIR/output41/copilot/agents/explorer.agent.md"; then
  pass "Copilot: stale/invalid primary (opus 7.1) still lands a same-tier array (no crash, no cross-tier leak)"
else
  fail "Copilot: stale/invalid primary should still yield a same-tier array headed by itself"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
