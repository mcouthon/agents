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

# Test 36: shared PreToolUse write-guard hook present (with the "reviewer"
# argv) in CC AND VS Code Copilot, absent from every other Copilot agent
# (guards Phase 2 (CC) + Phase 3 (VS Code Copilot) + Phase 5 (rename + argv) of
# task 100-reviewer-write-lockdown — the hard control. Both platforms reuse the
# same guard script verbatim.)
if grep -q "write-guard.sh reviewer" "$SCRIPT_DIR/generated/claude/agents/reviewer.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/claude/agents/reviewer.md"; then
  pass "Reviewer PreToolUse write-guard hook present in CC variant"
else
  fail "Reviewer PreToolUse write-guard hook missing from CC variant"
fi
if grep -q "write-guard.sh reviewer" "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md"; then
  pass "Reviewer PreToolUse write-guard hook present in VS Code Copilot variant"
else
  fail "Reviewer PreToolUse write-guard hook missing from VS Code Copilot variant"
fi
for agent in builder explorer conductor researcher; do
  if grep -q "write-guard.sh" "$SCRIPT_DIR/generated/copilot/agents/${agent}.agent.md"; then
    fail "write-guard hook leaked into Copilot ${agent} variant (Reviewer/Committer-only scoping broken)"
  else
    pass "write-guard hook absent from Copilot ${agent} variant (Reviewer/Committer-only scoping intact)"
  fi
done

# Test 36b: shared PreToolUse write-guard hook present (with the "committer"
# argv) in CC AND VS Code Copilot Committer variants (guards Phase 6 of task
# 100-reviewer-write-lockdown — the hard control extended to the Committer).
if grep -q "write-guard.sh committer" "$SCRIPT_DIR/generated/claude/agents/committer.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/claude/agents/committer.md"; then
  pass "Committer PreToolUse write-guard hook present in CC variant"
else
  fail "Committer PreToolUse write-guard hook missing from CC variant"
fi
if grep -q "write-guard.sh committer" "$SCRIPT_DIR/generated/copilot/agents/committer.agent.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/copilot/agents/committer.agent.md"; then
  pass "Committer PreToolUse write-guard hook present in VS Code Copilot variant"
else
  fail "Committer PreToolUse write-guard hook missing from VS Code Copilot variant"
fi

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

# Test 42: Committer Edit-tool mandate / shell-write prohibition present in both
# generated variants
# (guards Phase 4 of task 100-reviewer-write-lockdown against being lost in a
# future template refactor)
if grep -q "NEVER author or edit a file through the shell" "$SCRIPT_DIR/generated/claude/agents/committer.md" && \
   grep -q "NEVER author or edit a file through the shell" "$SCRIPT_DIR/generated/copilot/agents/committer.agent.md"; then
  pass "Committer Edit-tool mandate present in CC and Copilot variants"
else
  fail "Committer Edit-tool mandate missing from CC and/or Copilot variants"
fi

# Test 43: error-suppression prohibition present in both generated flavors
# (guards task 103-no-stderr-suppression against a future template refactor
# silently dropping the rule. Literals asserted here are contractual — see the
# task plan's literal-token table before rewording the rule.)
supp_ok=true
for f in \
  "$SCRIPT_DIR/generated/copilot/instructions/terminal.instructions.md" \
  "$SCRIPT_DIR/generated/claude/rules/terminal.md" \
  "$SCRIPT_DIR/generated/copilot/instructions/global.instructions.md" \
  "$SCRIPT_DIR/generated/claude/rules/global.md"; do
  grep -q 'NEVER suppress errors' "$f" || { supp_ok=false; echo "  Missing 'NEVER suppress errors' in $(basename $f)"; }
  grep -q '2>/dev/null' "$f"           || { supp_ok=false; echo "  Missing 2>/dev/null prohibition in $(basename $f)"; }
  grep -qF '|| true' "$f"              || { supp_ok=false; echo "  Missing '|| true' prohibition in $(basename $f)"; }
done
if [[ "$supp_ok" == true ]]; then
  pass "Error-suppression prohibition present in CC and Copilot instructions"
else
  fail "Error-suppression prohibition missing from CC and/or Copilot instructions"
fi

# Test 43b: Reviewer's /dev/null allowance is reconciled with the new rule in
# both flavors (the write-guard clause must cross-reference stderr suppression)
if grep -q '2>/dev/null' "$SCRIPT_DIR/generated/claude/agents/reviewer.md" && \
   grep -q '2>/dev/null' "$SCRIPT_DIR/generated/copilot/agents/reviewer.agent.md"; then
  pass "Reviewer /dev/null clause cross-references the stderr rule in CC and Copilot variants"
else
  fail "Reviewer /dev/null clause missing the stderr cross-reference in CC and/or Copilot variants"
fi

# ---------------------------------------------------------------------------
# mcpServers profiles + {{MCP_GUIDANCE}} substitution (Phase 3, task 102)
# ---------------------------------------------------------------------------

MCP_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$MCP_TMPDIR" 2>/dev/null' EXIT

mkdir -p "$MCP_TMPDIR/templates/agents"

# Fixture agent templates carrying the {{MCP_GUIDANCE}} placeholder and a
# host-injected {{VSCODE_*}} token, so substitution can be exercised without
# touching the real templates/ tree (Phase 4's job, not this phase's).
cat > "$MCP_TMPDIR/templates/agents/explorer.template.md" << 'EXPLORERFIXTURE'
---
name: Explorer
description: "Fixture agent for mcpServers substitution tests."

copilot:
  tools:
    [
      "read/readFile",
    ]
  model: opus

cc:
  tools: [
      Read,
    ]
  model: opus
---

# Explorer Fixture

Fixture body for testing.

{{MCP_GUIDANCE}}

Session log token: {{VSCODE_TARGET_SESSION_LOG}}
EXPLORERFIXTURE

cat > "$MCP_TMPDIR/templates/agents/builder.template.md" << 'BUILDERFIXTURE'
---
name: Builder
description: "Fixture agent for mcpServers substitution tests."

copilot:
  tools: ["read/readFile"]
  model: sonnet

cc:
  tools: [Read]
  model: sonnet
---

# Builder Fixture

Fixture body for testing.

{{MCP_GUIDANCE}}
BUILDERFIXTURE

# Verbatim expected bullets — plan §3.3 step 3 worked example.
PREFERRED_WITH='- Prefer `mcp_graphify_*` (Graphify code graph) for tracing symbols, usages and cross-file structure — reach for it before grep/glob. Always pass project_path="/absolute/path/to/workspace" on every call.'
PREFERRED_WITH_CC='- Prefer `mcp__graphifyy__*` (Graphify code graph) for tracing symbols, usages and cross-file structure — reach for it before grep/glob. Always pass project_path="/absolute/path/to/workspace" on every call.'
PREFERRED_WITHOUT='- Prefer `mcp_graphify_*` (Graphify code graph) for tracing symbols, usages and cross-file structure — reach for it before grep/glob.'
ONDEMAND_WITH='- `mcp_toolchain_*` (Toolchain APIs) is available for querying internal service metadata; look it up when the task calls for it. Always pass project_path="/absolute/path/to/workspace" on every call.'
ONDEMAND_WITHOUT='- `mcp_toolchain_*` (Toolchain APIs) is available for querying internal service metadata; look it up when the task calls for it.'

# Test 44: A preferred profile listing explorer renders per-platform toolNames.
mkdir -p "$MCP_TMPDIR/t44/config"
cat > "$MCP_TMPDIR/t44/config/config.json" << 'T44CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T44CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t44/config/config.json" \
  --output-dir "$MCP_TMPDIR/t44/output" >/dev/null 2>&1

t44_ok=true
t44_copilot="$MCP_TMPDIR/t44/output/copilot/agents/explorer.agent.md"
t44_cc="$MCP_TMPDIR/t44/output/claude/agents/explorer.md"
grep -q 'mcp_graphify_\*' "$t44_copilot" || { t44_ok=false; echo "  Copilot body missing toolNames.copilot"; }
grep -q 'mcp__graphifyy__\*' "$t44_cc" || { t44_ok=false; echo "  CC body missing toolNames.cc"; }
grep -q 'mcp__graphifyy__\*' "$t44_copilot" && { t44_ok=false; echo "  Copilot body leaked CC tool name form"; }
grep -q 'mcp_graphify_\*' "$t44_cc" && { t44_ok=false; echo "  CC body leaked Copilot tool name form"; }
[[ "$t44_ok" == true ]] && pass "Preferred profile renders per-platform toolNames in body" \
  || fail "Preferred profile per-platform toolNames rendering failed"

# Test 45: preferred vs on-demand produce genuinely different prose (not cosmetic variants).
mkdir -p "$MCP_TMPDIR/t45/config"
cat > "$MCP_TMPDIR/t45/config/config.json" << 'T45CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    },
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": {"copilot": "mcp_toolchain_*", "cc": "mcp__toolchain__*"},
      "grant": {"copilot": "toolchain/*", "cc": "mcp__toolchain__*"},
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for querying internal service metadata"
    }
  }
}
T45CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t45/config/config.json" \
  --output-dir "$MCP_TMPDIR/t45/output" >/dev/null 2>&1

t45_body="$MCP_TMPDIR/t45/output/copilot/agents/explorer.agent.md"
t45_ok=true
grep -qF -- "$PREFERRED_WITHOUT" "$t45_body" || { t45_ok=false; echo "  Missing preferred bullet text"; }
grep -qF -- "$ONDEMAND_WITHOUT" "$t45_body" || { t45_ok=false; echo "  Missing on-demand bullet text"; }
t45_ondemand_line=$(grep 'mcp_toolchain_\*' "$t45_body")
if [[ "$t45_ondemand_line" == *"before grep/glob"* ]]; then
  t45_ok=false; echo "  On-demand line incorrectly carries the preferred-only directive"
fi
[[ "$t45_ok" == true ]] && pass "Preferred and on-demand salience render genuinely different prose" \
  || fail "Salience values did not produce distinct prose"

# Test 46: A profile not listing explorer renders neither its displayName nor toolNames there.
mkdir -p "$MCP_TMPDIR/t46/config"
cat > "$MCP_TMPDIR/t46/config/config.json" << 'T46CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": {"copilot": "mcp_toolchain_*", "cc": "mcp__toolchain__*"},
      "grant": {"copilot": "toolchain/*", "cc": "mcp__toolchain__*"},
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "for querying internal service metadata"
    }
  }
}
T46CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t46/config/config.json" \
  --output-dir "$MCP_TMPDIR/t46/output" >/dev/null 2>&1

t46_body="$MCP_TMPDIR/t46/output/copilot/agents/explorer.agent.md"
t46_ok=true
grep -q "Toolchain APIs" "$t46_body" && { t46_ok=false; echo "  Explorer body has displayName from a profile that excludes it"; }
grep -q 'mcp_toolchain_\*' "$t46_body" && { t46_ok=false; echo "  Explorer body has toolNames from a profile that excludes it"; }
[[ "$t46_ok" == true ]] && pass "Profile excluding explorer renders nothing into its body" \
  || fail "Profile leaked into an agent not listed in its agents array"

# Test 47: mcpServers: {} in defaults/config.json is byte-identical to committed
# output — the regression gate that makes this phase safe to land alone.
DRYRUN47=$(node scripts/generate.js all --dry-run 2>&1)
if echo "$DRYRUN47" | grep -q "Would create\|Would update"; then
  fail "mcpServers: {} produced a diff against committed generated/ output"
else
  pass "mcpServers: {} produces byte-identical output to committed generated/"
fi

# Test 48: {{VSCODE_*}} host-injected tokens survive generation byte-for-byte.
mkdir -p "$MCP_TMPDIR/t48/config"
printf '%s\n' '{"models": {"opus": "4.6", "sonnet": "4.6"}}' > "$MCP_TMPDIR/t48/config/config.json"
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t48/config/config.json" \
  --output-dir "$MCP_TMPDIR/t48/output" >/dev/null 2>&1

if grep -qF '{{VSCODE_TARGET_SESSION_LOG}}' "$MCP_TMPDIR/t48/output/copilot/agents/explorer.agent.md" && \
   grep -qF '{{VSCODE_TARGET_SESSION_LOG}}' "$MCP_TMPDIR/t48/output/claude/agents/explorer.md"; then
  pass "{{VSCODE_*}} tokens survive generation byte-for-byte"
else
  fail "{{VSCODE_*}} token was corrupted or dropped by substitution"
fi

# Test 49: {{MCP_GUIDANCE}} with zero applicable profiles is removed entirely —
# no literal placeholder, no orphan blank-line run.
t49_ok=true
if grep -qF '{{MCP_GUIDANCE}}' "$MCP_TMPDIR/t48/output/copilot/agents/explorer.agent.md"; then
  t49_ok=false; echo "  Literal {{MCP_GUIDANCE}} survived with zero applicable profiles"
fi
if perl -0777 -ne 'exit(/\n\n\n/ ? 1 : 0)' "$MCP_TMPDIR/t48/output/copilot/agents/explorer.agent.md"; then
  :
else
  t49_ok=false; echo "  Orphan blank-line run left where {{MCP_GUIDANCE}} was removed"
fi
[[ "$t49_ok" == true ]] && pass "{{MCP_GUIDANCE}} with no applicable profiles leaves no trace" \
  || fail "{{MCP_GUIDANCE}} removal left a stray placeholder or blank-line run"

# Test 50: A credential-shaped key aborts generation (fatal, exit 2) — negative test.
mkdir -p "$MCP_TMPDIR/t50/config"
cat > "$MCP_TMPDIR/t50/config/config.json" << 'T50CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "leaky": {
      "displayName": "Leaky Server",
      "toolNames": {"copilot": "mcp_leaky_*", "cc": "mcp__leaky__*"},
      "grant": {"copilot": "leaky/*", "cc": "mcp__leaky__*"},
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for testing the credential guard",
      "apiKey": "sk-live-123"
    }
  }
}
T50CFG

STDERR50=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t50/config/config.json" \
  --output-dir "$MCP_TMPDIR/t50/output" 2>&1 >/dev/null)
code50=$?
t50_ok=true
[[ $code50 -eq 2 ]] || { t50_ok=false; echo "  Expected exit 2, got $code50"; }
echo "$STDERR50" | grep -q "leaky" || { t50_ok=false; echo "  stderr does not name the offending profile"; }
echo "$STDERR50" | grep -qi "apiKey" || { t50_ok=false; echo "  stderr does not name the offending key"; }
[[ "$t50_ok" == true ]] && pass "Credential-shaped key aborts generation with exit 2" \
  || fail "Credential guard did not abort as expected"

# Test 51: A profile missing displayName warns and is skipped entirely (exit 0,
# no partial sentence rendered).
mkdir -p "$MCP_TMPDIR/t51/config"
cat > "$MCP_TMPDIR/t51/config/config.json" << 'T51CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "noName": {
      "toolNames": {"copilot": "mcp_noname_*", "cc": "mcp__noname__*"},
      "grant": {"copilot": "noname/*", "cc": "mcp__noname__*"},
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for testing a missing displayName"
    }
  }
}
T51CFG

STDERR51=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t51/config/config.json" \
  --output-dir "$MCP_TMPDIR/t51/output" 2>&1 >/dev/null)
code51=$?
t51_ok=true
[[ $code51 -eq 0 ]] || { t51_ok=false; echo "  Expected exit 0, got $code51"; }
echo "$STDERR51" | grep -qi "displayName" || { t51_ok=false; echo "  No warning about missing displayName"; }
grep -q 'mcp_noname_\*' "$MCP_TMPDIR/t51/output/copilot/agents/explorer.agent.md" && \
  { t51_ok=false; echo "  Body rendered a partial sentence despite missing displayName"; }
[[ "$t51_ok" == true ]] && pass "Profile missing displayName warns, exits 0, and is skipped entirely" \
  || fail "Missing-displayName profile was not handled correctly"

# --- Calling-convention cases: the load-bearing behaviour (plan cases 9-19) ---

# Test 52: preferred + callingConvention renders the exact verbatim line on
# both platforms, including the literal argument syntax.
mkdir -p "$MCP_TMPDIR/t52/config"
cat > "$MCP_TMPDIR/t52/config/config.json" << 'T52CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": "pass project_path=\"/absolute/path/to/workspace\" on every call",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T52CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t52/config/config.json" \
  --output-dir "$MCP_TMPDIR/t52/output" >/dev/null 2>&1

t52_copilot_line=$(grep '^- Prefer' "$MCP_TMPDIR/t52/output/copilot/agents/explorer.agent.md")
t52_cc_line=$(grep '^- Prefer' "$MCP_TMPDIR/t52/output/claude/agents/explorer.md")
t52_ok=true
[[ "$t52_copilot_line" == "$PREFERRED_WITH" ]] || { t52_ok=false; echo "  Copilot line: $t52_copilot_line"; }
[[ "$t52_cc_line" == "$PREFERRED_WITH_CC" ]] || { t52_ok=false; echo "  CC line: $t52_cc_line"; }
[[ "$t52_ok" == true ]] && pass "preferred + callingConvention renders exact verbatim line on both platforms" \
  || fail "preferred + callingConvention rendering mismatch"

# Test 53: on-demand + the SAME callingConvention renders the exact verbatim
# line — the regression that matters most: mechanics survive the quiet level.
mkdir -p "$MCP_TMPDIR/t53/config"
cat > "$MCP_TMPDIR/t53/config/config.json" << 'T53CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": {"copilot": "mcp_toolchain_*", "cc": "mcp__toolchain__*"},
      "grant": {"copilot": "toolchain/*", "cc": "mcp__toolchain__*"},
      "salience": "on-demand",
      "callingConvention": "pass project_path=\"/absolute/path/to/workspace\" on every call",
      "agents": ["explorer"],
      "hint": "for querying internal service metadata"
    }
  }
}
T53CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t53/config/config.json" \
  --output-dir "$MCP_TMPDIR/t53/output" >/dev/null 2>&1

t53_copilot_line=$(grep 'mcp_toolchain_\*' "$MCP_TMPDIR/t53/output/copilot/agents/explorer.agent.md")
[[ "$t53_copilot_line" == "$ONDEMAND_WITH" ]] && pass "on-demand + same callingConvention renders exact verbatim line" \
  || fail "on-demand + callingConvention rendering mismatch: $t53_copilot_line"

# Test 54: cross-salience equality — the convention sentence itself is
# byte-identical between the preferred (t52) and on-demand (t53) renderings.
t54_conv_preferred=$(grep -o 'Always.*' "$MCP_TMPDIR/t52/output/copilot/agents/explorer.agent.md")
t54_conv_ondemand=$(grep -o 'Always.*' "$MCP_TMPDIR/t53/output/copilot/agents/explorer.agent.md")
[[ "$t54_conv_preferred" == "$t54_conv_ondemand" ]] && pass "Calling convention sentence is byte-identical across salience levels" \
  || fail "Calling convention sentence diverged between salience levels"

# Test 55: the argument syntax is literal, not paraphrased, at both salience levels.
t55_ok=true
grep -qF 'project_path="/absolute/path/to/workspace"' "$MCP_TMPDIR/t52/output/copilot/agents/explorer.agent.md" || \
  { t55_ok=false; echo "  Literal syntax missing at preferred salience"; }
grep -qF 'project_path="/absolute/path/to/workspace"' "$MCP_TMPDIR/t53/output/copilot/agents/explorer.agent.md" || \
  { t55_ok=false; echo "  Literal syntax missing at on-demand salience"; }
[[ "$t55_ok" == true ]] && pass "Argument syntax is literal (not paraphrased) at both salience levels" \
  || fail "Argument syntax was paraphrased instead of literal"

# Test 56: both salience levels WITHOUT callingConvention render the exact
# verbatim "without" strings (no Always, no trailing punctuation).
t56_pref_line=$(grep '^- Prefer' "$t45_body")
t56_ond_line=$(grep 'mcp_toolchain_\*' "$t45_body")
t56_ok=true
[[ "$t56_pref_line" == "$PREFERRED_WITHOUT" ]] || { t56_ok=false; echo "  preferred: $t56_pref_line"; }
[[ "$t56_ond_line" == "$ONDEMAND_WITHOUT" ]] || { t56_ok=false; echo "  on-demand: $t56_ond_line"; }
[[ "$t56_ok" == true ]] && pass "Both salience levels without callingConvention render exact verbatim lines" \
  || fail "Without-callingConvention rendering mismatch"

# Test 57: a callingConvention authored with a trailing period and surrounding
# whitespace normalises identically to the clean form.
mkdir -p "$MCP_TMPDIR/t57/config"
cat > "$MCP_TMPDIR/t57/config/config.json" << 'T57CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": "  pass project_path=\"/absolute/path/to/workspace\" on every call.  ",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T57CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t57/config/config.json" \
  --output-dir "$MCP_TMPDIR/t57/output" >/dev/null 2>&1

t57_line=$(grep '^- Prefer' "$MCP_TMPDIR/t57/output/copilot/agents/explorer.agent.md")
[[ "$t57_line" == "$PREFERRED_WITH" ]] && pass "Whitespace/trailing-period callingConvention normalises to the clean form" \
  || fail "Normalisation failed: $t57_line"

# Test 58: empty-string callingConvention (table-driven) omits the clause
# cleanly at both salience levels — no "Always", no "Always .".
t58_ok=true
for conv in "" "   " "." " . "; do
  mkdir -p "$MCP_TMPDIR/t58/config"
  python3 - "$MCP_TMPDIR/t58/config/config.json" "$conv" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": conv,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    },
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": {"copilot": "mcp_toolchain_*", "cc": "mcp__toolchain__*"},
      "grant": {"copilot": "toolchain/*", "cc": "mcp__toolchain__*"},
      "salience": "on-demand",
      "callingConvention": conv,
      "agents": ["explorer"],
      "hint": "for querying internal service metadata"
    }
  }
}
with open(path, "w") as f:
  json.dump(config, f)
PYEOF

  node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
    --config "$MCP_TMPDIR/t58/config/config.json" \
    --output-dir "$MCP_TMPDIR/t58/output" >/dev/null 2>&1

  t58_body="$MCP_TMPDIR/t58/output/copilot/agents/explorer.agent.md"
  t58_pref_line=$(grep '^- Prefer' "$t58_body")
  t58_ond_line=$(grep 'mcp_toolchain_\*' "$t58_body")
  if [[ "$t58_pref_line" != "$PREFERRED_WITHOUT" ]]; then
    t58_ok=false; echo "  conv=$(printf '%q' "$conv") preferred: $t58_pref_line"
  fi
  if [[ "$t58_ond_line" != "$ONDEMAND_WITHOUT" ]]; then
    t58_ok=false; echo "  conv=$(printf '%q' "$conv") on-demand: $t58_ond_line"
  fi
  if grep -q "Always \." "$t58_body"; then
    t58_ok=false; echo "  conv=$(printf '%q' "$conv") produced a broken 'Always .' fragment"
  fi
done
[[ "$t58_ok" == true ]] && pass "Empty-string callingConvention (table-driven) omits the clause cleanly" \
  || fail "Empty-string callingConvention did not normalise to the absent case"

# Test 59: absent and empty callingConvention are indistinguishable — the two
# generated files are byte-identical.
mkdir -p "$MCP_TMPDIR/t59/config-absent" "$MCP_TMPDIR/t59/config-empty"
cat > "$MCP_TMPDIR/t59/config-absent/config.json" << 'T59ABSENT'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T59ABSENT
cat > "$MCP_TMPDIR/t59/config-empty/config.json" << 'T59EMPTY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": "",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T59EMPTY

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t59/config-absent/config.json" \
  --output-dir "$MCP_TMPDIR/t59/output-absent" >/dev/null 2>&1
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t59/config-empty/config.json" \
  --output-dir "$MCP_TMPDIR/t59/output-empty" >/dev/null 2>&1

if diff -q "$MCP_TMPDIR/t59/output-absent/copilot/agents/explorer.agent.md" \
            "$MCP_TMPDIR/t59/output-empty/copilot/agents/explorer.agent.md" >/dev/null; then
  pass "Absent and empty callingConvention produce byte-identical output"
else
  fail "Absent and empty callingConvention diverged"
fi

# Test 60: embedded newlines in displayName/hint/callingConvention are
# rejected — warn, exit 0, profile skipped entirely.
t60_ok=true

mkdir -p "$MCP_TMPDIR/t60/config-conv"
python3 - "$MCP_TMPDIR/t60/config-conv/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": "pass project_path=\"/abs\"\non every call",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
with open(sys.argv[1], "w") as f:
  json.dump(config, f)
PYEOF
STDERR60A=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t60/config-conv/config.json" \
  --output-dir "$MCP_TMPDIR/t60/output-conv" 2>&1 >/dev/null)
code60a=$?
[[ $code60a -eq 0 ]] || { t60_ok=false; echo "  callingConvention newline: expected exit 0, got $code60a"; }
echo "$STDERR60A" | grep -qi "callingConvention" || { t60_ok=false; echo "  callingConvention newline: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t60/output-conv/copilot/agents/explorer.agent.md" && \
  { t60_ok=false; echo "  callingConvention newline: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t60/config-hint"
python3 - "$MCP_TMPDIR/t60/config-hint/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols\nand cross-file structure"
    }
  }
}
with open(sys.argv[1], "w") as f:
  json.dump(config, f)
PYEOF
STDERR60B=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t60/config-hint/config.json" \
  --output-dir "$MCP_TMPDIR/t60/output-hint" 2>&1 >/dev/null)
code60b=$?
[[ $code60b -eq 0 ]] || { t60_ok=false; echo "  hint newline: expected exit 0, got $code60b"; }
echo "$STDERR60B" | grep -qi "hint" || { t60_ok=false; echo "  hint newline: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t60/output-hint/copilot/agents/explorer.agent.md" && \
  { t60_ok=false; echo "  hint newline: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t60/config-name"
python3 - "$MCP_TMPDIR/t60/config-name/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify\r\ncode graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
with open(sys.argv[1], "w") as f:
  json.dump(config, f)
PYEOF
STDERR60C=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t60/config-name/config.json" \
  --output-dir "$MCP_TMPDIR/t60/output-name" 2>&1 >/dev/null)
code60c=$?
[[ $code60c -eq 0 ]] || { t60_ok=false; echo "  displayName newline: expected exit 0, got $code60c"; }
echo "$STDERR60C" | grep -qi "displayName" || { t60_ok=false; echo "  displayName newline: no warning"; }
grep -q 'mcp_graphify_\*' "$MCP_TMPDIR/t60/output-name/copilot/agents/explorer.agent.md" && \
  { t60_ok=false; echo "  displayName newline: profile was not skipped"; }

[[ "$t60_ok" == true ]] && pass "Embedded newlines in displayName/hint/callingConvention are rejected (warn, exit 0, skipped)" \
  || fail "Embedded-newline rejection did not behave as specified"

# Test 61: 120/121-character boundary pair — 120 accepted, 121 rejected.
CONV120=$(head -c 120 /dev/zero | tr '\0' 'a')
CONV121=$(head -c 121 /dev/zero | tr '\0' 'a')

mkdir -p "$MCP_TMPDIR/t61/config-120" "$MCP_TMPDIR/t61/config-121"
python3 - "$MCP_TMPDIR/t61/config-120/config.json" "$CONV120" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": conv,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
with open(path, "w") as f:
  json.dump(config, f)
PYEOF
python3 - "$MCP_TMPDIR/t61/config-121/config.json" "$CONV121" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": conv,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
with open(path, "w") as f:
  json.dump(config, f)
PYEOF

t61_ok=true
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t61/config-120/config.json" \
  --output-dir "$MCP_TMPDIR/t61/output-120" >/dev/null 2>&1
grep -qF "$CONV120" "$MCP_TMPDIR/t61/output-120/copilot/agents/explorer.agent.md" || \
  { t61_ok=false; echo "  120-char callingConvention was rejected (should be accepted)"; }

STDERR61=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t61/config-121/config.json" \
  --output-dir "$MCP_TMPDIR/t61/output-121" 2>&1 >/dev/null)
code61=$?
[[ $code61 -eq 0 ]] || { t61_ok=false; echo "  121-char callingConvention: expected exit 0, got $code61"; }
echo "$STDERR61" | grep -qi "callingConvention" || { t61_ok=false; echo "  121-char callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t61/output-121/copilot/agents/explorer.agent.md" && \
  { t61_ok=false; echo "  121-char callingConvention: profile was not skipped"; }

[[ "$t61_ok" == true ]] && pass "120/121-character boundary: 120 accepted, 121 rejected" \
  || fail "Length-boundary enforcement failed"

# Test 62: a non-string callingConvention (number, or object with no
# recognised platform key) is rejected — warn, exit 0, profile skipped entirely.
t62_ok=true

mkdir -p "$MCP_TMPDIR/t62/config-number"
cat > "$MCP_TMPDIR/t62/config-number/config.json" << 'T62NUMBER'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": 42,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T62NUMBER
STDERR62A=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t62/config-number/config.json" \
  --output-dir "$MCP_TMPDIR/t62/output-number" 2>&1 >/dev/null)
code62a=$?
[[ $code62a -eq 0 ]] || { t62_ok=false; echo "  numeric callingConvention: expected exit 0, got $code62a"; }
echo "$STDERR62A" | grep -qi "callingConvention" || { t62_ok=false; echo "  numeric callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t62/output-number/copilot/agents/explorer.agent.md" && \
  { t62_ok=false; echo "  numeric callingConvention: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t62/config-noplatform"
cat > "$MCP_TMPDIR/t62/config-noplatform/config.json" << 'T62NOPLATFORM'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": {"copilot": "mcp_graphify_*", "cc": "mcp__graphifyy__*"},
      "grant": {"copilot": "graphifyy/*", "cc": "mcp__graphifyy__*"},
      "salience": "preferred",
      "callingConvention": {"foo": "bar"},
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T62NOPLATFORM
STDERR62B=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t62/config-noplatform/config.json" \
  --output-dir "$MCP_TMPDIR/t62/output-noplatform" 2>&1 >/dev/null)
code62b=$?
[[ $code62b -eq 0 ]] || { t62_ok=false; echo "  no-platform-key callingConvention: expected exit 0, got $code62b"; }
echo "$STDERR62B" | grep -qi "callingConvention" || { t62_ok=false; echo "  no-platform-key callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t62/output-noplatform/copilot/agents/explorer.agent.md" && \
  { t62_ok=false; echo "  no-platform-key callingConvention: profile was not skipped"; }

[[ "$t62_ok" == true ]] && pass "Non-string callingConvention (number or keyless object) is rejected and skipped" \
  || fail "Non-string callingConvention was not rejected as specified"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
