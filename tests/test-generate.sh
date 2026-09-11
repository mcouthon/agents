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

# Test 5: generate copilot exits non-zero (command removed)
node scripts/generate.js copilot >/dev/null 2>&1 && fail "generate copilot should exit non-zero (command removed)" || pass "generate copilot exits non-zero (command removed)"

# Test 6: generated/copilot/ directory does not exist
if [[ ! -d "$SCRIPT_DIR/generated/copilot" ]]; then
  pass "generated/copilot/ directory does not exist"
else
  fail "generated/copilot/ directory still exists"
fi

# Test 7: No COPILOT-ONLY or CC-ONLY directives in generated CC files
if grep -rq 'COPILOT-ONLY\|CC-ONLY' "$SCRIPT_DIR/generated/claude/" 2>/dev/null; then
  fail "COPILOT-ONLY or CC-ONLY directives found in generated CC files"
else
  pass "No COPILOT-ONLY or CC-ONLY directives in generated CC files"
fi

# Test 8: No copilot: frontmatter in generated CC files
if grep -rq '^copilot:' "$SCRIPT_DIR/generated/claude/" 2>/dev/null; then
  fail "copilot: frontmatter found in generated CC files"
else
  pass "No copilot: frontmatter in generated CC files"
fi

# Test 9: Verify CC agent count
CC_AGENT_COUNT=$(find "$SCRIPT_DIR/generated/claude/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_AGENT_COUNT" -ge 6 ]]; then
  pass "Generated $CC_AGENT_COUNT CC agents (expected 6)"
else
  fail "Expected 6 CC agents, got $CC_AGENT_COUNT"
fi

# Test 10: Verify CC skill count
CC_SKILL_COUNT=$(find "$SCRIPT_DIR/generated/claude/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_SKILL_COUNT" -ge 12 ]]; then
  pass "Generated $CC_SKILL_COUNT CC skills (expected 13)"
else
  fail "Expected 13 CC skills, got $CC_SKILL_COUNT"
fi

# Test 11: Verify CC rule count
CC_RULE_COUNT=$(find "$SCRIPT_DIR/generated/claude/rules" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CC_RULE_COUNT" -ge 4 ]]; then
  pass "Generated $CC_RULE_COUNT CC rules (expected 4)"
else
  fail "Expected 4 CC rules, got $CC_RULE_COUNT"
fi

# Test 12: Idempotent - second run should report unchanged or no changes
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

# Test 13: Global CC rule has no frontmatter
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

# Test 14: make validate exits 0
make validate >/dev/null 2>&1 && pass "make validate succeeds" || fail "make validate failed"

# Test 15: make cc exits 0
make cc >/dev/null 2>&1 && pass "make cc succeeds" || fail "make cc failed"

# Test 16: generate cc subcommand only
node scripts/generate.js cc >/dev/null 2>&1 && pass "Generate cc subcommand succeeds" || fail "Generate cc subcommand failed"

# Test 17: CC agents have required 'tools:' frontmatter
cc_fm_ok=true
for agent in "$SCRIPT_DIR"/generated/claude/agents/*.md; do
  [[ -f "$agent" ]] || continue
  if ! grep -q "^tools:" "$agent"; then
    cc_fm_ok=false
    echo "  Missing tools: in $(basename $agent)"
  fi
done
[[ "$cc_fm_ok" == true ]] && pass "CC agents have tools: frontmatter" || fail "CC agents missing tools: frontmatter"

# Test 18: CC rules with frontmatter have paths: scoping
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

# Test 19: Model resolution from config (using --output-dir instead of destructive rm)
TEST_DIR=$(mktemp -d)
cleanup_test_dir() { rm -rf "$TEST_DIR" 2>/dev/null; }
trap cleanup_test_dir EXIT
mkdir -p "$TEST_DIR/config"
printf '%s\n' '{"models": {"opus": "9.9", "sonnet": "8.8"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output" >/dev/null 2>&1
if grep -q '^model: opus$' "$TEST_DIR/output/claude/agents/explorer.md" && \
   grep -q '^model: sonnet$' "$TEST_DIR/output/claude/agents/reviewer.md"; then
  pass "Model resolution from config works"
else
  fail "Model not resolved from config"
fi

# Test 20: Malformed config fails loudly
printf '%s\n' '{"invalid": json}' > "$TEST_DIR/config/config.json"
if node scripts/generate.js all --config "$TEST_DIR/config/config.json" 2>/dev/null; then
  fail "Should fail on malformed JSON config"
else
  pass "Malformed config fails loudly"
fi

# Test 21: Default config file exists
if [[ -f "$SCRIPT_DIR/defaults/config.json" ]]; then
  pass "Default config file exists"
else
  fail "Default config file not found at defaults/config.json"
fi

# Test 22: --output-dir writes to custom location (CC only, no copilot/)
OUTPUT_TEST_DIR=$(mktemp -d)
node scripts/generate.js all --config defaults/config.json --output-dir "$OUTPUT_TEST_DIR" >/dev/null 2>&1
if [[ -d "$OUTPUT_TEST_DIR/claude/agents" && ! -d "$OUTPUT_TEST_DIR/copilot" ]]; then
  pass "--output-dir creates CC agents dir only (no copilot/)"
else
  fail "--output-dir did not create expected CC-only directory structure"
fi
rm -rf "$OUTPUT_TEST_DIR"

# Test 23: --config with missing file exits 2
if node scripts/generate.js all --config /nonexistent/config.json 2>/dev/null; then
  fail "Should fail on missing config file"
else
  code=$?
  [[ $code -eq 2 ]] && pass "Missing config exits 2" || fail "Missing config exited $code (expected 2)"
fi

# Test 24: No --config defaults to defaults/config.json
node scripts/generate.js all --dry-run >/dev/null 2>&1; compat_code=$?
[[ $compat_code -eq 0 || $compat_code -eq 1 ]] && pass "No --config flag uses default config.json" || fail "No --config flag failed (exit $compat_code)"

# Test 25: Truly unknown type "llama" still produces an unknown-type warning
printf '%s\n' '{"models":{"llama":"3"}}' > "$TEST_DIR/config/config.json"
STDERR25=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output25" 2>&1 >/dev/null)
if echo "$STDERR25" | grep -q 'Unknown model.*llama'; then
  pass "Unknown type llama still warns"
else
  fail "Unknown type llama should produce an unknown-type warning"
fi

# Test 26: Backward compatibility: no 'agents' section is inert
printf '%s\n' '{"models":{"opus":"7.1","sonnet":"7.2","haiku":"7.3"}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output26a" >/dev/null 2>&1
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output26b" >/dev/null 2>&1
diff -r "$TEST_DIR/output26a" "$TEST_DIR/output26b" >/dev/null 2>&1
diff26_rc=$?
if [[ $diff26_rc -eq 0 ]] && \
   ! grep -rq 'GPT' "$TEST_DIR/output26a" && \
   grep -q '^model: opus$' "$TEST_DIR/output26a/claude/agents/explorer.md"; then
  pass "No agents section: output is deterministic and uses template Claude defaults"
else
  fail "No agents section: output is deterministic and uses template Claude defaults"
fi

# Test 27: Reviewer no-write prohibition present in CC variant
# (guards Phase 1 of task 100-reviewer-write-lockdown against being lost in a
# future template refactor)
if grep -q "by ANY means" "$SCRIPT_DIR/generated/claude/agents/reviewer.md"; then
  pass "Reviewer no-write prohibition present in CC variant"
else
  fail "Reviewer no-write prohibition missing from CC variant"
fi

# Test 28: shared PreToolUse write-guard hook present (with the "reviewer"
# argv) in CC
# (guards Phase 2 (CC) of task 100-reviewer-write-lockdown — the hard control.)
if grep -q "write-guard.sh reviewer" "$SCRIPT_DIR/generated/claude/agents/reviewer.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/claude/agents/reviewer.md"; then
  pass "Reviewer PreToolUse write-guard hook present in CC variant"
else
  fail "Reviewer PreToolUse write-guard hook missing from CC variant"
fi

# Test 29: shared PreToolUse write-guard hook present (with the "committer"
# argv) in CC Committer variant
# (guards Phase 6 of task 100-reviewer-write-lockdown — the hard control
# extended to the Committer.)
if grep -q "write-guard.sh committer" "$SCRIPT_DIR/generated/claude/agents/committer.md" && \
   grep -q "PreToolUse" "$SCRIPT_DIR/generated/claude/agents/committer.md"; then
  pass "Committer PreToolUse write-guard hook present in CC variant"
else
  fail "Committer PreToolUse write-guard hook missing from CC variant"
fi

# Test 30: Committer Edit-tool mandate / shell-write prohibition present in CC
# (guards Phase 4 of task 100-reviewer-write-lockdown against being lost in a
# future template refactor)
if grep -q "NEVER author or edit a file through the shell" "$SCRIPT_DIR/generated/claude/agents/committer.md"; then
  pass "Committer Edit-tool mandate present in CC variant"
else
  fail "Committer Edit-tool mandate missing from CC variant"
fi

# Test 31: error-suppression prohibition present in CC instructions
# (guards task 103-no-stderr-suppression against a future template refactor
# silently dropping the rule. Literals asserted here are contractual — see the
# task plan's literal-token table before rewording the rule.)
supp_ok=true
for f in \
  "$SCRIPT_DIR/generated/claude/rules/terminal.md" \
  "$SCRIPT_DIR/generated/claude/rules/global.md"; do
  grep -q 'NEVER suppress errors' "$f" || { supp_ok=false; echo "  Missing 'NEVER suppress errors' in $(basename $f)"; }
  grep -q '2>/dev/null' "$f"           || { supp_ok=false; echo "  Missing 2>/dev/null prohibition in $(basename $f)"; }
  grep -qF '|| true' "$f"              || { supp_ok=false; echo "  Missing '|| true' prohibition in $(basename $f)"; }
done
if [[ "$supp_ok" == true ]]; then
  pass "Error-suppression prohibition present in CC instructions"
else
  fail "Error-suppression prohibition missing from CC instructions"
fi

# Test 32: Reviewer's /dev/null allowance is reconciled with the new rule in CC
# (the write-guard clause must cross-reference stderr suppression)
if grep -q '2>/dev/null' "$SCRIPT_DIR/generated/claude/agents/reviewer.md"; then
  pass "Reviewer /dev/null clause cross-references the stderr rule in CC variant"
else
  fail "Reviewer /dev/null clause missing the stderr cross-reference in CC variant"
fi

# Test 33: Conductor's task-discovery glob is directory-aware
# (task agent-latency-reduction, Phase 8 — guards against
# `Glob(".tasks/*")`/`Glob(".tasks/NNN*")` regressing to a pattern that matches
# files, not directories)
glob_ok=true
if grep -qF '.tasks/*/task.md' "$SCRIPT_DIR/generated/claude/agents/conductor.md"; then
  :
else
  glob_ok=false; echo "  Missing '.tasks/*/task.md' discovery pattern in generated/claude/agents/conductor.md"
fi
if grep -qF 'Glob(".tasks/*")' "$SCRIPT_DIR/generated/claude/agents/conductor.md" || \
   grep -qF 'Glob(".tasks/237*")' "$SCRIPT_DIR/generated/claude/agents/conductor.md"; then
  glob_ok=false; echo "  Broken .tasks/* discovery pattern still present in generated/claude/agents/conductor.md"
fi
if [[ "$glob_ok" == true ]]; then
  pass "Conductor's task-discovery glob is directory-aware"
else
  fail "Conductor's task-discovery glob regressed"
fi

# Test 34: producer-side checkpoint contracts survive regeneration (task 107,
# Phase 1). Three contractual literals, each asserted per-file rather than by
# count -- 'Worth your attention:' had zero occurrences repo-wide before this
# task, and the findings-sink heading exists nowhere else, so neither can be
# inflated by incidental reuse. The negative assertion is the one that fails
# before the change lands: the old absolute write ban must be gone.
producer_ok=true
for f in \
  "$SCRIPT_DIR/generated/claude/agents/explorer.md"; do
  grep -qF 'Worth your attention:' "$f" || { producer_ok=false; echo "  Missing 'Worth your attention:' contract in $(basename $f)"; }
  grep -qF 'nothing at the bar' "$f"    || { producer_ok=false; echo "  Missing the no-pad escape hatch in $(basename $f)"; }
done
for f in \
  "$SCRIPT_DIR/generated/claude/skills/phase-review/SKILL.md"; do
  grep -qF '## Plan Review — findings (advisory; NOT implementation steps)' "$f" \
    || { producer_ok=false; echo "  Missing findings-sink heading in $f"; }
  grep -qF 'any file in `plan/`' "$f" \
    && { producer_ok=false; echo "  Old absolute plan/ write ban still present in $f"; }
done
# The sink must not have been paid for with a permission widening (criterion (f)).
grep -qF 'allowed-tools: [Read, Grep, Glob, Edit, LSP]' "$SCRIPT_DIR/generated/claude/skills/phase-review/SKILL.md" \
  || { producer_ok=false; echo "  phase-review allowed-tools changed -- the findings sink must use Edit, not a new grant"; }
if [[ "$producer_ok" == true ]]; then
  pass "Explorer checkpoint contract and phase-review findings sink present in CC variant"
else
  fail "Explorer checkpoint contract and/or phase-review findings sink missing or permission-widened"
fi

# Test 35: Conductor's checkpoint presentation stays plain-prose (task 107,
# Phase 2). The load-bearing assertion is the negative one: 'verbatim' went from
# 9 occurrences per generated conductor file to 0, and it cannot reach 0 by
# accident. The positive literals each had zero occurrences repo-wide before this
# task, so incidental reuse elsewhere cannot mask a missing checkpoint format.
conductor_fmt_ok=true
for f in \
  "$SCRIPT_DIR/generated/claude/agents/conductor.md"; do
  grep -qF 'verbatim' "$f" \
    && { conductor_fmt_ok=false; echo "  'verbatim' presentation framing is back in $(basename $f)"; }
  grep -qF 'selection, not generation' "$f" \
    || { conductor_fmt_ok=false; echo "  Missing the selection-not-generation guarantee in $(basename $f)"; }
  grep -qF 'Worth your attention:' "$f" \
    || { conductor_fmt_ok=false; echo "  Step 2b format does not consume Explorer's attention block in $(basename $f)"; }
  grep -qF '## Plan Review — findings' "$f" \
    || { conductor_fmt_ok=false; echo "  Step 2b names no path for collapsed Medium/Low findings in $(basename $f)"; }
  grep -qF 'Also flagged:' "$f" \
    || { conductor_fmt_ok=false; echo "  Step 2d drops Reviewer's yellow issues instead of listing them in $(basename $f)"; }
done
if [[ "$conductor_fmt_ok" == true ]]; then
  pass "Conductor checkpoints present plain prose, consume Explorer's headline, and surface every Reviewer issue"
else
  fail "Conductor checkpoint presentation regressed to quoting framing or dropped a contract literal"
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

cc:
  tools: [Read]
  model: sonnet
---

# Builder Fixture

Fixture body for testing.

{{MCP_GUIDANCE}}
BUILDERFIXTURE

# Verbatim expected bullets — CC-only tool name conventions.
PREFERRED_WITH_CC='- Prefer `mcp__graphifyy__*` (Graphify code graph) for tracing symbols, usages and cross-file structure — reach for it before grep/glob. Always pass project_path="/absolute/path/to/workspace" on every call.'
PREFERRED_WITHOUT='- Prefer `mcp__graphifyy__*` (Graphify code graph) for tracing symbols, usages and cross-file structure — reach for it before grep/glob.'
ONDEMAND_WITH='- `mcp__toolchain__*` (Toolchain APIs) is available for querying internal service metadata; look it up when the task calls for it. Always pass project_path="/absolute/path/to/workspace" on every call.'
ONDEMAND_WITHOUT='- `mcp__toolchain__*` (Toolchain APIs) is available for querying internal service metadata; look it up when the task calls for it.'

# Test 36: A preferred profile listing explorer renders toolNames in the CC body.
mkdir -p "$MCP_TMPDIR/t36/config"
cat > "$MCP_TMPDIR/t36/config/config.json" << 'T36CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T36CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t36/config/config.json" \
  --output-dir "$MCP_TMPDIR/t36/output" >/dev/null 2>&1

t36_ok=true
t36_cc="$MCP_TMPDIR/t36/output/claude/agents/explorer.md"
grep -q 'mcp__graphifyy__\*' "$t36_cc" || { t36_ok=false; echo "  CC body missing toolNames"; }
[[ "$t36_ok" == true ]] && pass "Preferred profile renders toolNames in CC body" \
  || fail "Preferred profile toolNames rendering failed"

# Test 37: preferred vs on-demand produce genuinely different prose (not cosmetic variants).
mkdir -p "$MCP_TMPDIR/t37/config"
cat > "$MCP_TMPDIR/t37/config/config.json" << 'T37CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    },
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": "mcp__toolchain__*",
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for querying internal service metadata"
    }
  }
}
T37CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t37/config/config.json" \
  --output-dir "$MCP_TMPDIR/t37/output" >/dev/null 2>&1

t37_body="$MCP_TMPDIR/t37/output/claude/agents/explorer.md"
t37_ok=true
grep -qF -- "$PREFERRED_WITHOUT" "$t37_body" || { t37_ok=false; echo "  Missing preferred bullet text"; }
grep -qF -- "$ONDEMAND_WITHOUT" "$t37_body" || { t37_ok=false; echo "  Missing on-demand bullet text"; }
t37_ondemand_line=$(grep 'mcp__toolchain__\*' "$t37_body")
if [[ "$t37_ondemand_line" == *"before grep/glob"* ]]; then
  t37_ok=false; echo "  On-demand line incorrectly carries the preferred-only directive"
fi
[[ "$t37_ok" == true ]] && pass "Preferred and on-demand salience render genuinely different prose" \
  || fail "Salience values did not produce distinct prose"

# Test 38: A profile not listing explorer renders neither its displayName nor toolNames there.
mkdir -p "$MCP_TMPDIR/t38/config"
cat > "$MCP_TMPDIR/t38/config/config.json" << 'T38CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": "mcp__toolchain__*",
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "for querying internal service metadata"
    }
  }
}
T38CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t38/config/config.json" \
  --output-dir "$MCP_TMPDIR/t38/output" >/dev/null 2>&1

t38_body="$MCP_TMPDIR/t38/output/claude/agents/explorer.md"
t38_ok=true
grep -q "Toolchain APIs" "$t38_body" && { t38_ok=false; echo "  Explorer body has displayName from a profile that excludes it"; }
grep -q 'mcp__toolchain__\*' "$t38_body" && { t38_ok=false; echo "  Explorer body has toolNames from a profile that excludes it"; }
[[ "$t38_ok" == true ]] && pass "Profile excluding explorer renders nothing into its body" \
  || fail "Profile leaked into an agent not listed in its agents array"

# Test 39: mcpServers: {} in defaults/config.json is byte-identical to committed
# output — the regression gate that makes this phase safe to land alone.
DRYRUN39=$(node scripts/generate.js all --dry-run 2>&1)
if echo "$DRYRUN39" | grep -q "Would create\|Would update"; then
  fail "mcpServers: {} produced a diff against committed generated/ output"
else
  pass "mcpServers: {} produces byte-identical output to committed generated/"
fi

# Test 40: {{VSCODE_*}} host-injected tokens survive generation byte-for-byte.
mkdir -p "$MCP_TMPDIR/t40/config"
printf '%s\n' '{"models": {"opus": "4.6", "sonnet": "4.6"}}' > "$MCP_TMPDIR/t40/config/config.json"
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t40/config/config.json" \
  --output-dir "$MCP_TMPDIR/t40/output" >/dev/null 2>&1

if grep -qF '{{VSCODE_TARGET_SESSION_LOG}}' "$MCP_TMPDIR/t40/output/claude/agents/explorer.md"; then
  pass "{{VSCODE_*}} tokens survive generation byte-for-byte"
else
  fail "{{VSCODE_*}} token was corrupted or dropped by substitution"
fi

# Test 41: {{MCP_GUIDANCE}} with zero applicable profiles is removed entirely —
# no literal placeholder, no orphan blank-line run.
t41_ok=true
if grep -qF '{{MCP_GUIDANCE}}' "$MCP_TMPDIR/t40/output/claude/agents/explorer.md"; then
  t41_ok=false; echo "  Literal {{MCP_GUIDANCE}} survived with zero applicable profiles"
fi
if perl -0777 -ne 'exit(/\n\n\n/ ? 1 : 0)' "$MCP_TMPDIR/t40/output/claude/agents/explorer.md"; then
  :
else
  t41_ok=false; echo "  Orphan blank-line run left where {{MCP_GUIDANCE}} was removed"
fi
[[ "$t41_ok" == true ]] && pass "{{MCP_GUIDANCE}} with no applicable profiles leaves no trace" \
  || fail "{{MCP_GUIDANCE}} removal left a stray placeholder or blank-line run"

# Test 42: A credential-shaped key aborts generation (fatal, exit 2) — negative test.
mkdir -p "$MCP_TMPDIR/t42/config"
cat > "$MCP_TMPDIR/t42/config/config.json" << 'T42CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "leaky": {
      "displayName": "Leaky Server",
      "toolNames": "mcp__leaky__*",
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for testing the credential guard",
      "apiKey": "sk-live-123"
    }
  }
}
T42CFG

STDERR42=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t42/config/config.json" \
  --output-dir "$MCP_TMPDIR/t42/output" 2>&1 >/dev/null)
code42=$?
t42_ok=true
[[ $code42 -eq 2 ]] || { t42_ok=false; echo "  Expected exit 2, got $code42"; }
echo "$STDERR42" | grep -q "leaky" || { t42_ok=false; echo "  stderr does not name the offending profile"; }
echo "$STDERR42" | grep -qi "apiKey" || { t42_ok=false; echo "  stderr does not name the offending key"; }
[[ "$t42_ok" == true ]] && pass "Credential-shaped key aborts generation with exit 2" \
  || fail "Credential guard did not abort as expected"

# Test 43: A profile missing displayName warns and is skipped entirely (exit 0,
# no partial sentence rendered).
mkdir -p "$MCP_TMPDIR/t43/config"
cat > "$MCP_TMPDIR/t43/config/config.json" << 'T43CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "noName": {
      "toolNames": "mcp__noname__*",
      "salience": "on-demand",
      "agents": ["explorer"],
      "hint": "for testing a missing displayName"
    }
  }
}
T43CFG

STDERR43=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t43/config/config.json" \
  --output-dir "$MCP_TMPDIR/t43/output" 2>&1 >/dev/null)
code43=$?
t43_ok=true
[[ $code43 -eq 0 ]] || { t43_ok=false; echo "  Expected exit 0, got $code43"; }
echo "$STDERR43" | grep -qi "displayName" || { t43_ok=false; echo "  No warning about missing displayName"; }
grep -q 'mcp__noname_\*' "$MCP_TMPDIR/t43/output/claude/agents/explorer.md" && \
  { t43_ok=false; echo "  Body rendered a partial sentence despite missing displayName"; }
[[ "$t43_ok" == true ]] && pass "Profile missing displayName warns, exits 0, and is skipped entirely" \
  || fail "Missing-displayName profile was not handled correctly"

# --- Calling-convention cases: the load-bearing behaviour (plan cases 9-19) ---

# Test 44: preferred + callingConvention renders the exact verbatim line,
# including the literal argument syntax.
mkdir -p "$MCP_TMPDIR/t44/config"
cat > "$MCP_TMPDIR/t44/config/config.json" << 'T44CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": "pass project_path=\"/absolute/path/to/workspace\" on every call",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T44CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t44/config/config.json" \
  --output-dir "$MCP_TMPDIR/t44/output" >/dev/null 2>&1

t44_cc_line=$(grep '^- Prefer' "$MCP_TMPDIR/t44/output/claude/agents/explorer.md")
t44_ok=true
[[ "$t44_cc_line" == "$PREFERRED_WITH_CC" ]] || { t44_ok=false; echo "  CC line: $t44_cc_line"; }
[[ "$t44_ok" == true ]] && pass "preferred + callingConvention renders exact verbatim line" \
  || fail "preferred + callingConvention rendering mismatch"

# Test 45: on-demand + the SAME callingConvention renders the exact verbatim
# line — the regression that matters most: mechanics survive the quiet level.
mkdir -p "$MCP_TMPDIR/t45/config"
cat > "$MCP_TMPDIR/t45/config/config.json" << 'T45CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": "mcp__toolchain__*",
      "salience": "on-demand",
      "callingConvention": "pass project_path=\"/absolute/path/to/workspace\" on every call",
      "agents": ["explorer"],
      "hint": "for querying internal service metadata"
    }
  }
}
T45CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t45/config/config.json" \
  --output-dir "$MCP_TMPDIR/t45/output" >/dev/null 2>&1

t45_cc_line=$(grep 'mcp__toolchain__\*' "$MCP_TMPDIR/t45/output/claude/agents/explorer.md")
[[ "$t45_cc_line" == "$ONDEMAND_WITH" ]] && pass "on-demand + same callingConvention renders exact verbatim line" \
  || fail "on-demand + callingConvention rendering mismatch: $t45_cc_line"

# Test 46: cross-salience equality — the convention sentence itself is
# byte-identical between the preferred (t44) and on-demand (t45) renderings.
t46_conv_preferred=$(grep -o 'Always.*' "$MCP_TMPDIR/t44/output/claude/agents/explorer.md")
t46_conv_ondemand=$(grep -o 'Always.*' "$MCP_TMPDIR/t45/output/claude/agents/explorer.md")
[[ "$t46_conv_preferred" == "$t46_conv_ondemand" ]] && pass "Calling convention sentence is byte-identical across salience levels" \
  || fail "Calling convention sentence diverged between salience levels"

# Test 47: the argument syntax is literal, not paraphrased.
t47_ok=true
grep -qF 'project_path="/absolute/path/to/workspace"' "$MCP_TMPDIR/t44/output/claude/agents/explorer.md" || \
  { t47_ok=false; echo "  Literal syntax missing at preferred salience"; }
grep -qF 'project_path="/absolute/path/to/workspace"' "$MCP_TMPDIR/t45/output/claude/agents/explorer.md" || \
  { t47_ok=false; echo "  Literal syntax missing at on-demand salience"; }
[[ "$t47_ok" == true ]] && pass "Argument syntax is literal (not paraphrased) at both salience levels" \
  || fail "Argument syntax was paraphrased instead of literal"

# Test 48: both salience levels WITHOUT callingConvention render the exact
# verbatim "without" strings (no Always, no trailing punctuation).
t48_pref_line=$(grep '^- Prefer' "$t37_body")
t48_ond_line=$(grep 'mcp__toolchain__\*' "$t37_body")
t48_ok=true
[[ "$t48_pref_line" == "$PREFERRED_WITHOUT" ]] || { t48_ok=false; echo "  preferred: $t48_pref_line"; }
[[ "$t48_ond_line" == "$ONDEMAND_WITHOUT" ]] || { t48_ok=false; echo "  on-demand: $t48_ond_line"; }
[[ "$t48_ok" == true ]] && pass "Both salience levels without callingConvention render exact verbatim lines" \
  || fail "Without-callingConvention rendering mismatch"

# Test 49: a callingConvention authored with a trailing period and surrounding
# whitespace normalises identically to the clean form.
mkdir -p "$MCP_TMPDIR/t49/config"
cat > "$MCP_TMPDIR/t49/config/config.json" << 'T49CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": "  pass project_path=\"/absolute/path/to/workspace\" on every call.  ",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T49CFG

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t49/config/config.json" \
  --output-dir "$MCP_TMPDIR/t49/output" >/dev/null 2>&1

t49_line=$(grep '^- Prefer' "$MCP_TMPDIR/t49/output/claude/agents/explorer.md")
[[ "$t49_line" == "$PREFERRED_WITH_CC" ]] && pass "Whitespace/trailing-period callingConvention normalises to the clean form" \
  || fail "Normalisation failed: $t49_line"

# Test 50: empty-string callingConvention (table-driven) omits the clause
# cleanly at both salience levels — no "Always", no "Always .".
t50_ok=true
for conv in "" "   " "." " . "; do
  mkdir -p "$MCP_TMPDIR/t50/config"
  python3 - "$MCP_TMPDIR/t50/config/config.json" "$conv" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": conv,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    },
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": "mcp__toolchain__*",
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
    --config "$MCP_TMPDIR/t50/config/config.json" \
    --output-dir "$MCP_TMPDIR/t50/output" >/dev/null 2>&1

  t50_body="$MCP_TMPDIR/t50/output/claude/agents/explorer.md"
  t50_pref_line=$(grep '^- Prefer' "$t50_body")
  t50_ond_line=$(grep 'mcp__toolchain__\*' "$t50_body")
  if [[ "$t50_pref_line" != "$PREFERRED_WITHOUT" ]]; then
    t50_ok=false; echo "  conv=$(printf '%q' "$conv") preferred: $t50_pref_line"
  fi
  if [[ "$t50_ond_line" != "$ONDEMAND_WITHOUT" ]]; then
    t50_ok=false; echo "  conv=$(printf '%q' "$conv") on-demand: $t50_ond_line"
  fi
  if grep -q "Always \." "$t50_body"; then
    t50_ok=false; echo "  conv=$(printf '%q' "$conv") produced a broken 'Always .' fragment"
  fi
done
[[ "$t50_ok" == true ]] && pass "Empty-string callingConvention (table-driven) omits the clause cleanly" \
  || fail "Empty-string callingConvention did not normalise to the absent case"

# Test 51: absent and empty callingConvention are indistinguishable — the two
# generated files are byte-identical.
mkdir -p "$MCP_TMPDIR/t51/config-absent" "$MCP_TMPDIR/t51/config-empty"
cat > "$MCP_TMPDIR/t51/config-absent/config.json" << 'T51ABSENT'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T51ABSENT
cat > "$MCP_TMPDIR/t51/config-empty/config.json" << 'T51EMPTY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": "",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T51EMPTY

node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t51/config-absent/config.json" \
  --output-dir "$MCP_TMPDIR/t51/output-absent" >/dev/null 2>&1
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t51/config-empty/config.json" \
  --output-dir "$MCP_TMPDIR/t51/output-empty" >/dev/null 2>&1

if diff -q "$MCP_TMPDIR/t51/output-absent/claude/agents/explorer.md" \
            "$MCP_TMPDIR/t51/output-empty/claude/agents/explorer.md" >/dev/null; then
  pass "Absent and empty callingConvention produce byte-identical output"
else
  fail "Absent and empty callingConvention diverged"
fi

# Test 52: embedded newlines in displayName/hint/callingConvention are
# rejected — warn, exit 0, profile skipped entirely.
t52_ok=true

mkdir -p "$MCP_TMPDIR/t52/config-conv"
python3 - "$MCP_TMPDIR/t52/config-conv/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
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
STDERR52A=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t52/config-conv/config.json" \
  --output-dir "$MCP_TMPDIR/t52/output-conv" 2>&1 >/dev/null)
code52a=$?
[[ $code52a -eq 0 ]] || { t52_ok=false; echo "  callingConvention newline: expected exit 0, got $code52a"; }
echo "$STDERR52A" | grep -qi "callingConvention" || { t52_ok=false; echo "  callingConvention newline: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t52/output-conv/claude/agents/explorer.md" && \
  { t52_ok=false; echo "  callingConvention newline: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t52/config-hint"
python3 - "$MCP_TMPDIR/t52/config-hint/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols\nand cross-file structure"
    }
  }
}
with open(sys.argv[1], "w") as f:
  json.dump(config, f)
PYEOF
STDERR52B=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t52/config-hint/config.json" \
  --output-dir "$MCP_TMPDIR/t52/output-hint" 2>&1 >/dev/null)
code52b=$?
[[ $code52b -eq 0 ]] || { t52_ok=false; echo "  hint newline: expected exit 0, got $code52b"; }
echo "$STDERR52B" | grep -qi "hint" || { t52_ok=false; echo "  hint newline: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t52/output-hint/claude/agents/explorer.md" && \
  { t52_ok=false; echo "  hint newline: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t52/config-name"
python3 - "$MCP_TMPDIR/t52/config-name/config.json" << 'PYEOF'
import json, sys
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify\r\ncode graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
with open(sys.argv[1], "w") as f:
  json.dump(config, f)
PYEOF
STDERR52C=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t52/config-name/config.json" \
  --output-dir "$MCP_TMPDIR/t52/output-name" 2>&1 >/dev/null)
code52c=$?
[[ $code52c -eq 0 ]] || { t52_ok=false; echo "  displayName newline: expected exit 0, got $code52c"; }
echo "$STDERR52C" | grep -qi "displayName" || { t52_ok=false; echo "  displayName newline: no warning"; }
grep -q 'mcp__graphifyy_\*' "$MCP_TMPDIR/t52/output-name/claude/agents/explorer.md" && \
  { t52_ok=false; echo "  displayName newline: profile was not skipped"; }

[[ "$t52_ok" == true ]] && pass "Embedded newlines in displayName/hint/callingConvention are rejected (warn, exit 0, skipped)" \
  || fail "Embedded-newline rejection did not behave as specified"

# Test 53: 120/121-character boundary pair — 120 accepted, 121 rejected.
CONV120=$(head -c 120 /dev/zero | tr '\0' 'a')
CONV121=$(head -c 121 /dev/zero | tr '\0' 'a')

mkdir -p "$MCP_TMPDIR/t53/config-120" "$MCP_TMPDIR/t53/config-121"
python3 - "$MCP_TMPDIR/t53/config-120/config.json" "$CONV120" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
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
python3 - "$MCP_TMPDIR/t53/config-121/config.json" "$CONV121" << 'PYEOF'
import json, sys
path, conv = sys.argv[1], sys.argv[2]
config = {
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
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

t53_ok=true
node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t53/config-120/config.json" \
  --output-dir "$MCP_TMPDIR/t53/output-120" >/dev/null 2>&1
grep -qF "$CONV120" "$MCP_TMPDIR/t53/output-120/claude/agents/explorer.md" || \
  { t53_ok=false; echo "  120-char callingConvention was rejected (should be accepted)"; }

STDERR53=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t53/config-121/config.json" \
  --output-dir "$MCP_TMPDIR/t53/output-121" 2>&1 >/dev/null)
code53=$?
[[ $code53 -eq 0 ]] || { t53_ok=false; echo "  121-char callingConvention: expected exit 0, got $code53"; }
echo "$STDERR53" | grep -qi "callingConvention" || { t53_ok=false; echo "  121-char callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t53/output-121/claude/agents/explorer.md" && \
  { t53_ok=false; echo "  121-char callingConvention: profile was not skipped"; }

[[ "$t53_ok" == true ]] && pass "120/121-character boundary: 120 accepted, 121 rejected" \
  || fail "Length-boundary enforcement failed"

# Test 54: a non-string callingConvention (number, or object with no
# recognised platform key) is rejected — warn, exit 0, profile skipped entirely.
t54_ok=true

mkdir -p "$MCP_TMPDIR/t54/config-number"
cat > "$MCP_TMPDIR/t54/config-number/config.json" << 'T54NUMBER'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": 42,
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T54NUMBER
STDERR54A=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t54/config-number/config.json" \
  --output-dir "$MCP_TMPDIR/t54/output-number" 2>&1 >/dev/null)
code54a=$?
[[ $code54a -eq 0 ]] || { t54_ok=false; echo "  numeric callingConvention: expected exit 0, got $code54a"; }
echo "$STDERR54A" | grep -qi "callingConvention" || { t54_ok=false; echo "  numeric callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t54/output-number/claude/agents/explorer.md" && \
  { t54_ok=false; echo "  numeric callingConvention: profile was not skipped"; }

mkdir -p "$MCP_TMPDIR/t54/config-noplatform"
cat > "$MCP_TMPDIR/t54/config-noplatform/config.json" << 'T54NOPLATFORM'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "salience": "preferred",
      "callingConvention": {"foo": "bar"},
      "agents": ["explorer"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T54NOPLATFORM
STDERR54B=$(node scripts/generate.js all --source "$MCP_TMPDIR/templates" \
  --config "$MCP_TMPDIR/t54/config-noplatform/config.json" \
  --output-dir "$MCP_TMPDIR/t54/output-noplatform" 2>&1 >/dev/null)
code54b=$?
[[ $code54b -eq 0 ]] || { t54_ok=false; echo "  no-platform-key callingConvention: expected exit 0, got $code54b"; }
echo "$STDERR54B" | grep -qi "callingConvention" || { t54_ok=false; echo "  no-platform-key callingConvention: no warning"; }
grep -q "Graphify code graph" "$MCP_TMPDIR/t54/output-noplatform/claude/agents/explorer.md" && \
  { t54_ok=false; echo "  no-platform-key callingConvention: profile was not skipped"; }

[[ "$t54_ok" == true ]] && pass "Non-string callingConvention (number or keyless object) is rejected and skipped" \
  || fail "Non-string callingConvention was not rejected as specified"

# ---------------------------------------------------------------------------
# Test 55: drift guard — the Tool Preference: Code Navigation block is
# byte-identical across all four agent templates that carry it (task
# agent-latency-reduction, Phase 7 reduced form — the extraction itself was
# dropped as re-measurement showed only 1.8% duplication and zero latency
# effect; this test locks down the maintainability risk the extraction would
# have addressed, which is real: Phase 6 had to make this exact 4-way edit
# twice, once for getDiagnostics removal and once for the navigation-order
# reconciliation).
#
# Rewritten (task graphify-usage-telemetry, Phase 17): the block is no longer
# wrapped in a single outer <!-- CC-ONLY --> — it un-scopes to shared prose
# plus one narrow inner CC-ONLY around just the `LSP` clause, so the guidance
# is shared. The extractor now keys on the heading and the fallback sentence,
# not on the (removed) outer directive pair, and it still fails on a drifted
# block — proven by a local drift-and-restore check below.
extract_tool_pref_block() {
  awk '
    /^### Tool Preference: Code Navigation$/ { buf=$0; instart=1; next }
    instart {
      buf = buf "\n" $0
      if ($0 ~ /return nothing\.$/) {
        print buf
        instart=0
      }
    }
  ' "$1"
}

TOOLPREF_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$MCP_TMPDIR" "$TOOLPREF_TMPDIR" 2>/dev/null' EXIT

toolpref_ok=true
for agent in builder explorer reviewer researcher; do
  extract_tool_pref_block "$SCRIPT_DIR/templates/agents/$agent.template.md" \
    > "$TOOLPREF_TMPDIR/$agent.block"
  lines=$(grep -c '^' "$TOOLPREF_TMPDIR/$agent.block")
  if [[ "$lines" -ne 8 ]]; then
    toolpref_ok=false
    echo "  $agent.template.md: Tool Preference block is $lines lines, expected 8"
  fi
done

for agent in explorer reviewer researcher; do
  if ! diff -q "$TOOLPREF_TMPDIR/builder.block" "$TOOLPREF_TMPDIR/$agent.block" > /dev/null; then
    toolpref_ok=false
    echo "  builder.template.md's Tool Preference block drifted from $agent.template.md's"
  fi
done

if [[ "$toolpref_ok" == true ]]; then
  pass "Tool Preference: Code Navigation block is byte-identical across builder/explorer/reviewer/researcher"
else
  fail "Tool Preference: Code Navigation block has drifted across the four agent templates"
fi

# Test 55b: prove the rewritten extractor still fails on a real drift —
# drift builder's block locally, confirm the guard fires, then restore.
# Never touches the real template on disk (works on a scratch copy only).
cp "$SCRIPT_DIR/templates/agents/builder.template.md" "$TOOLPREF_TMPDIR/builder.drifted.md"
perl -0777 -pi -e 's/(### Tool Preference: Code Navigation\n\nFor symbols, references and cross-file structure, prefer these over )grep\/glob search(, in order:)/${1}DRIFTED WORDING${2}/' \
  "$TOOLPREF_TMPDIR/builder.drifted.md"
extract_tool_pref_block "$TOOLPREF_TMPDIR/builder.drifted.md" > "$TOOLPREF_TMPDIR/builder.drifted.block"
if diff -q "$TOOLPREF_TMPDIR/explorer.block" "$TOOLPREF_TMPDIR/builder.drifted.block" > /dev/null; then
  fail "Test 55's drift guard did not fire against a deliberately drifted block"
else
  pass "Test 55's drift guard fires against a deliberately drifted block (drift-and-restore proof)"
fi

# Test 56: a config with no code-index server produces no code-index instruction
# and no leftovers — the guard the config-driven guidance rewrite needs (task
# graphify-usage-telemetry, Phase 11). Generated against the real templates
# (no --source override) so it exercises what a real install would produce.
T56_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$MCP_TMPDIR" "$TOOLPREF_TMPDIR" "$T56_TMPDIR" 2>/dev/null' EXIT

printf '%s\n' '{"models": {"opus": "5", "sonnet": "5"}}' > "$T56_TMPDIR/config.json"
node scripts/generate.js all --config "$T56_TMPDIR/config.json" \
  --output-dir "$T56_TMPDIR/output" >/dev/null 2>&1

t56_body="$T56_TMPDIR/output/claude/agents/explorer.md"
t56_ok=true

if [[ ! -f "$t56_body" ]]; then
  t56_ok=false
  echo "  Test 56: $t56_body was not generated"
else
  # Anti-vacuity control first: a truncated/empty body must not make the
  # absence checks below pass by accident.
  if ! grep -q 'Tool Preference: Code Navigation' "$t56_body" || \
     ! grep -q 'The `LSP` tool' "$t56_body"; then
    t56_ok=false
    echo "  Test 56: Tool Preference: Code Navigation block missing — body may be truncated, absence checks would be vacuous"
  fi

  if [[ "$(grep -c 'code_index' "$t56_body")" -ne 0 ]]; then
    t56_ok=false
    echo "  Test 56: explorer.md with no code-index server still mentions code_index"
  fi

  if [[ "$(grep -ci 'graphif' "$t56_body")" -ne 0 ]]; then
    t56_ok=false
    echo "  Test 56: explorer.md with no mcpServers profile still mentions Graphify (case-insensitive)"
  fi

  if [[ "$(grep -cF '{{MCP_GUIDANCE}}' "$t56_body")" -ne 0 ]]; then
    t56_ok=false
    echo "  Test 56: literal {{MCP_GUIDANCE}} placeholder survived"
  fi

  if perl -0777 -ne 'exit(/\n\n\n/ ? 1 : 0)' "$t56_body"; then
    :
  else
    t56_ok=false
    echo "  Test 56: orphan blank-line run left where the guidance bullet was removed"
  fi
fi

[[ "$t56_ok" == true ]] && pass "No-code-index-server config produces no code-index/vendor mentions and a well-formed navigation block" \
  || fail "No-code-index-server config leaked a code-index mention, a vendor name, or left generation debris"

# Positive control against the committed default output (no generation needed —
# make validate/Test 39 already proves it is current). explorer.md and builder.md
# hold the code_index_build grant plus the guidance bullet (2 occurrences each);
# explorer.md's frontmatter-only code_index_status count is 1 now that the
# template's prose step naming it was deleted; reviewer.md/researcher.md hold 1
# (the shared bullet's "if you hold it" hedge, naming the tool without granting
# it). A 3 on explorer/builder means a template re-grew an unconditional line; a
# 1 there means the grant or the bullet is missing; a 0 on reviewer/researcher
# would wrongly force the bullet out of two agents that legitimately want it.
t56_default_ok=true
default_explorer="$SCRIPT_DIR/generated/claude/agents/explorer.md"
default_builder="$SCRIPT_DIR/generated/claude/agents/builder.md"
if [[ "$(grep -c 'code_index_build' "$default_explorer")" -ne 2 ]]; then
  t56_default_ok=false
  echo "  Test 56: committed explorer.md's code_index_build count drifted from 2 (tools: grant + bullet)"
fi
if [[ "$(grep -c 'code_index_status' "$default_explorer")" -ne 1 ]]; then
  t56_default_ok=false
  echo "  Test 56: committed explorer.md's code_index_status count drifted from 1 (frontmatter grant only)"
fi

[[ "$t56_default_ok" == true ]] && pass "Committed explorer.md carries exactly the expected code_index_build/code_index_status counts" \
  || fail "Committed explorer.md's code_index occurrence counts drifted from what Phase 11 installed"

# Test 57: LSP-clause scope control — the CC-only built-in tool name `LSP`
# appears in every CC body. This is what catches an over-broad un-scoping of
# the Tool Preference: Code Navigation block (task graphify-usage-telemetry,
# Phase 17).
t57_ok=true
for agent in builder explorer reviewer researcher; do
  cc_body="$SCRIPT_DIR/generated/claude/agents/$agent.md"
  if [[ "$(grep -c '\`LSP\`' "$cc_body")" -eq 0 ]]; then
    t57_ok=false
    echo "  Test 57: $cc_body is missing its LSP tool-preference clause"
  fi
done

[[ "$t57_ok" == true ]] && pass "The LSP clause renders in every CC body" \
  || fail "The LSP clause's rendering has drifted"

# Test 58: no placeholder residue anywhere under generated/ — a repo-wide
# guard, not just the single-body check Test 56 already runs, since Phase 17
# touches all four templates' guidance block at once.
if rg -q '\{\{' "$SCRIPT_DIR/generated/"; then
  fail "Literal {{...}} placeholder residue found under generated/"
else
  pass "No literal {{...}} placeholder residue anywhere under generated/"
fi

# Tests 59-64: agents.<name>.cc per-agent override (task
# 110-glm52-experiment-compat, Phase 1) + platforms enforcement + the
# CC-only `inherit` sentinel. Each generated CC agent file contains exactly
# one line matching ^model:, so grep -c '^model: <tier>$' == 1 is a
# non-vacuous guard.

# Test 59: a cc override moves the CC tier
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5"},"agents":{"builder":{"cc":"opus"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output59" >/dev/null 2>&1
if [[ "$(grep -c '^model: opus$' "$TEST_DIR/output59/claude/agents/builder.md")" -eq 1 ]]; then
  pass "cc override: builder CC moves to opus"
else
  fail "cc override: builder CC moves to opus"
fi

# Test 60: the cc override is independent
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5"},"agents":{"explorer":{"cc":"sonnet"}}}' > "$TEST_DIR/config/config.json"
node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output60" >/dev/null 2>&1
if [[ "$(grep -c '^model: sonnet$' "$TEST_DIR/output60/claude/agents/explorer.md")" -eq 1 ]]; then
  pass "cc override: explorer CC moves to sonnet"
else
  fail "cc override: explorer CC moves to sonnet"
fi

# Test 61: a cc override to a removed GPT type is rejected, loudly
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5","gpt-terra":"5.6 Terra"},"agents":{"builder":{"cc":"gpt-terra"}}}' > "$TEST_DIR/config/config.json"
STDERR61=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output61" 2>&1 >/dev/null)
if [[ "$(grep -c '^model: sonnet$' "$TEST_DIR/output61/claude/agents/builder.md")" -eq 1 ]] && \
   ! grep -q 'gpt' "$TEST_DIR/output61/claude/agents/builder.md" && \
   echo "$STDERR61" | grep -q 'Unknown model type "gpt-terra"'; then
  pass "cc override to removed GPT type gpt-terra is rejected as unknown; CC builder keeps sonnet"
else
  fail "cc override to removed GPT type gpt-terra is rejected as unknown; CC builder keeps sonnet"
fi

# Test 62: an unknown cc type is rejected and warns
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5"},"agents":{"builder":{"cc":"llama"}}}' > "$TEST_DIR/config/config.json"
STDERR62=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output62" 2>&1 >/dev/null)
if [[ "$(grep -c '^model: sonnet$' "$TEST_DIR/output62/claude/agents/builder.md")" -eq 1 ]] && \
   echo "$STDERR62" | grep -q 'Unknown model type "llama" for agent "builder"'; then
  pass "cc override to unknown type llama is rejected and warns; CC builder keeps sonnet"
else
  fail "cc override to unknown type llama is rejected and warns; CC builder keeps sonnet"
fi

# Test 63: the committed CC tier map is the one the GLM experiment relies on
# (task 110-glm52-experiment-compat, Finding 1) — should not drift silently.
t63_ok=true
for pair in conductor:opus explorer:opus builder:sonnet reviewer:sonnet committer:haiku researcher:haiku; do
  agent="${pair%%:*}"
  tier="${pair##*:}"
  f="$SCRIPT_DIR/generated/claude/agents/${agent}.md"
  if [[ "$(grep -c "^model: ${tier}\$" "$f")" -ne 1 ]]; then
    t63_ok=false
    echo "  Test 63: $f does not have exactly one '^model: ${tier}\$' line"
  fi
done
[[ "$t63_ok" == true ]] && pass "Committed CC agents carry the tier map the GLM experiment relies on" \
  || fail "Committed CC agent tier map drifted from conductor/explorer=opus, builder/reviewer=sonnet, committer/researcher=haiku"

# Test 64: cc: "inherit" is accepted verbatim
printf '%s\n' '{"models":{"opus":"5","sonnet":"5","haiku":"4.5"},"agents":{"explorer":{"cc":"inherit"}}}' > "$TEST_DIR/config/config.json"
STDERR64=$(node scripts/generate.js all --config "$TEST_DIR/config/config.json" --output-dir "$TEST_DIR/output64" 2>&1 >/dev/null)
if [[ "$(grep -c '^model: inherit$' "$TEST_DIR/output64/claude/agents/explorer.md")" -eq 1 ]] && \
   ! echo "$STDERR64" | grep -q 'Warning:'; then
  pass "cc: inherit is emitted verbatim into CC explorer, no warning"
else
  fail "cc: inherit is emitted verbatim into CC explorer, no warning"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
