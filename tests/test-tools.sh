#!/bin/zsh
# Integration tests for tools merge in scripts/generate.js

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "✗ $1"; FAIL=$((FAIL + 1)); }

echo "Testing tools merge..."
cd "$SCRIPT_DIR"

TOOLS_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TOOLS_TMPDIR"' EXIT

mkdir -p "$TOOLS_TMPDIR/t26" "$TOOLS_TMPDIR/t27" "$TOOLS_TMPDIR/t27b" \
         "$TOOLS_TMPDIR/t28" "$TOOLS_TMPDIR/t29" "$TOOLS_TMPDIR/t30" "$TOOLS_TMPDIR/t31"

# Test 26: Tools merge from config (defaultTools + agentTools)
mkdir -p "$TOOLS_TMPDIR/t26/config"
cat > "$TOOLS_TMPDIR/t26/config/config.json" << 'TOOLSCFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "copilot": ["toolchain/test-default"],
    "cc": ["mcp__test__default"]
  },
  "agentTools": {
    "copilot": {
      "committer": ["toolchain/test-agent-specific"]
    },
    "cc": {
      "committer": ["mcp__test__agent_specific"]
    }
  }
}
TOOLSCFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t26/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t26/output" >/dev/null 2>&1

tools_ok=true

# All Copilot agents should have the default tool
if ! grep -q "toolchain/test-default" \
  "$TOOLS_TMPDIR/t26/output/copilot/agents/explorer.agent.md"; then
  tools_ok=false; echo "  Explorer missing default tool"
fi

# Committer should have both default + agent-specific
if ! grep -q "toolchain/test-agent-specific" \
  "$TOOLS_TMPDIR/t26/output/copilot/agents/committer.agent.md"; then
  tools_ok=false; echo "  Committer missing agent-specific tool"
fi

# Builder should NOT have agent-specific tool
if grep -q "toolchain/test-agent-specific" \
  "$TOOLS_TMPDIR/t26/output/copilot/agents/builder.agent.md"; then
  tools_ok=false; echo "  Builder has agent-specific tool it shouldn't"
fi

# CC: all agents get default
if ! grep -q "mcp__test__default" \
  "$TOOLS_TMPDIR/t26/output/claude/agents/explorer.md"; then
  tools_ok=false; echo "  CC Explorer missing default tool"
fi

# CC: committer gets agent-specific
if ! grep -q "mcp__test__agent_specific" \
  "$TOOLS_TMPDIR/t26/output/claude/agents/committer.md"; then
  tools_ok=false; echo "  CC Committer missing agent-specific tool"
fi

[[ "$tools_ok" == true ]] && pass "Tools merge from config works" \
  || fail "Tools merge from config failed"

# Test 27: Empty/absent tools config — no tools added
# Sub-case A: explicit empty tools
mkdir -p "$TOOLS_TMPDIR/t27/config"
cat > "$TOOLS_TMPDIR/t27/config/config.json" << 'EMPTYCFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"copilot": [], "cc": []},
  "agentTools": {"copilot": {}, "cc": {}}
}
EMPTYCFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t27/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t27/output" >/dev/null 2>&1

# Generate baseline with defaults/config.json for comparison
node scripts/generate.js all \
  --config defaults/config.json \
  --output-dir "$TOOLS_TMPDIR/t27/baseline" >/dev/null 2>&1

t27a_ok=true
# Copilot explorer should match baseline (no extra tools added)
baseline_count=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27/baseline/copilot/agents/explorer.agent.md" 2>/dev/null) || true
baseline_count=${baseline_count:-0}
actual_count=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27/output/copilot/agents/explorer.agent.md" 2>/dev/null) || true
actual_count=${actual_count:-0}
if [[ "$actual_count" -ne "$baseline_count" ]]; then
  t27a_ok=false; echo "  Copilot explorer has extra tools (baseline=$baseline_count, actual=$actual_count)"
fi
cc_baseline_count=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27/baseline/claude/agents/explorer.md" 2>/dev/null) || true
cc_baseline_count=${cc_baseline_count:-0}
cc_actual_count=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27/output/claude/agents/explorer.md" 2>/dev/null) || true
cc_actual_count=${cc_actual_count:-0}
if [[ "$cc_actual_count" -ne "$cc_baseline_count" ]]; then
  t27a_ok=false; echo "  CC explorer has extra tools (baseline=$cc_baseline_count, actual=$cc_actual_count)"
fi
[[ "$t27a_ok" == true ]] && pass "Empty tools config adds no tools (sub-case A)" \
  || fail "Empty tools config added unexpected tools (sub-case A)"

# Sub-case B: keys absent entirely
mkdir -p "$TOOLS_TMPDIR/t27b/config"
cat > "$TOOLS_TMPDIR/t27b/config/config.json" << 'ABSENTCFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"}
}
ABSENTCFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t27b/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t27b/output" >/dev/null 2>&1

t27b_ok=true
actual_count_b=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27b/output/copilot/agents/explorer.agent.md" 2>/dev/null) || true
actual_count_b=${actual_count_b:-0}
if [[ "$actual_count_b" -ne "$baseline_count" ]]; then
  t27b_ok=false; echo "  Copilot explorer has extra tools (baseline=$baseline_count, actual=$actual_count_b)"
fi
cc_actual_count_b=$(grep -c 'toolchain/\|mcp__' "$TOOLS_TMPDIR/t27b/output/claude/agents/explorer.md" 2>/dev/null) || true
cc_actual_count_b=${cc_actual_count_b:-0}
if [[ "$cc_actual_count_b" -ne "$cc_baseline_count" ]]; then
  t27b_ok=false; echo "  CC explorer has extra tools (baseline=$cc_baseline_count, actual=$cc_actual_count_b)"
fi
[[ "$t27b_ok" == true ]] && pass "Absent tools keys adds no tools (sub-case B)" \
  || fail "Absent tools keys added unexpected tools (sub-case B)"

# Test 28: Only defaultTools, no agentTools
mkdir -p "$TOOLS_TMPDIR/t28/config"
cat > "$TOOLS_TMPDIR/t28/config/config.json" << 'DEFONLY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "copilot": ["toolchain/glean-search", "toolchain/glean-summarize"],
    "cc": ["mcp__glean__search", "mcp__glean__summarize"]
  },
  "agentTools": {"copilot": {}, "cc": {}}
}
DEFONLY

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t28/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t28/output" >/dev/null 2>&1

t28_ok=true
# Copilot explorer has both defaults
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t28/output/copilot/agents/explorer.agent.md"; then
  t28_ok=false; echo "  Copilot explorer missing glean-search"
fi
if ! grep -q "toolchain/glean-summarize" "$TOOLS_TMPDIR/t28/output/copilot/agents/explorer.agent.md"; then
  t28_ok=false; echo "  Copilot explorer missing glean-summarize"
fi
# Copilot committer has both defaults
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t28/output/copilot/agents/committer.agent.md"; then
  t28_ok=false; echo "  Copilot committer missing glean-search"
fi
if ! grep -q "toolchain/glean-summarize" "$TOOLS_TMPDIR/t28/output/copilot/agents/committer.agent.md"; then
  t28_ok=false; echo "  Copilot committer missing glean-summarize"
fi
# CC explorer has both defaults
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t28/output/claude/agents/explorer.md"; then
  t28_ok=false; echo "  CC explorer missing mcp__glean__search"
fi
if ! grep -q "mcp__glean__summarize" "$TOOLS_TMPDIR/t28/output/claude/agents/explorer.md"; then
  t28_ok=false; echo "  CC explorer missing mcp__glean__summarize"
fi
# No agent has agent-specific tools beyond defaults
if grep -q "toolchain/github\|mcp__github" "$TOOLS_TMPDIR/t28/output/copilot/agents/explorer.agent.md"; then
  t28_ok=false; echo "  Copilot explorer has unexpected agent-specific tools"
fi
[[ "$t28_ok" == true ]] && pass "Only defaultTools populates all agents" \
  || fail "Only defaultTools test failed"

# Test 29: Only agentTools, no defaultTools
mkdir -p "$TOOLS_TMPDIR/t29/config"
cat > "$TOOLS_TMPDIR/t29/config/config.json" << 'AGENTONLY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"copilot": [], "cc": []},
  "agentTools": {
    "copilot": {
      "committer": ["toolchain/github-get-commit", "toolchain/github-list-pull-requests"]
    },
    "cc": {
      "committer": ["mcp__github__get_commit", "mcp__github__list_pull_requests"]
    }
  }
}
AGENTONLY

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t29/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t29/output" >/dev/null 2>&1

t29_ok=true
# Copilot committer has agent-specific tools
if ! grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t29/output/copilot/agents/committer.agent.md"; then
  t29_ok=false; echo "  Copilot committer missing github-get-commit"
fi
if ! grep -q "toolchain/github-list-pull-requests" "$TOOLS_TMPDIR/t29/output/copilot/agents/committer.agent.md"; then
  t29_ok=false; echo "  Copilot committer missing github-list-pull-requests"
fi
# Copilot explorer does NOT have those tools
if grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t29/output/copilot/agents/explorer.agent.md"; then
  t29_ok=false; echo "  Copilot explorer has committer-only tool"
fi
# CC committer has agent-specific tools
if ! grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t29/output/claude/agents/committer.md"; then
  t29_ok=false; echo "  CC committer missing mcp__github__get_commit"
fi
if ! grep -q "mcp__github__list_pull_requests" "$TOOLS_TMPDIR/t29/output/claude/agents/committer.md"; then
  t29_ok=false; echo "  CC committer missing mcp__github__list_pull_requests"
fi
# CC explorer does NOT have those tools
if grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t29/output/claude/agents/explorer.md"; then
  t29_ok=false; echo "  CC explorer has committer-only tool"
fi
[[ "$t29_ok" == true ]] && pass "Only agentTools targets specific agents" \
  || fail "Only agentTools test failed"

# Test 30: Realistic mixed config with multiple agents
mkdir -p "$TOOLS_TMPDIR/t30/config"
cat > "$TOOLS_TMPDIR/t30/config/config.json" << 'MIXEDCFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "copilot": ["toolchain/glean-search", "toolchain/glean-summarize"],
    "cc": ["mcp__glean__search", "mcp__glean__summarize"]
  },
  "agentTools": {
    "copilot": {
      "committer": ["toolchain/github-get-commit", "toolchain/github-list-pull-requests"],
      "conductor": ["toolchain/github-get-commit"]
    },
    "cc": {
      "committer": ["mcp__github__get_commit"]
    }
  }
}
MIXEDCFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t30/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t30/output" >/dev/null 2>&1

t30_ok=true
# Copilot explorer: has glean tools, does NOT have github tools
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t30/output/copilot/agents/explorer.agent.md"; then
  t30_ok=false; echo "  Copilot explorer missing glean-search"
fi
if grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t30/output/copilot/agents/explorer.agent.md"; then
  t30_ok=false; echo "  Copilot explorer has github tool it shouldn't"
fi

# Copilot committer: has glean AND github tools
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t30/output/copilot/agents/committer.agent.md"; then
  t30_ok=false; echo "  Copilot committer missing glean-search"
fi
if ! grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t30/output/copilot/agents/committer.agent.md"; then
  t30_ok=false; echo "  Copilot committer missing github-get-commit"
fi
if ! grep -q "toolchain/github-list-pull-requests" "$TOOLS_TMPDIR/t30/output/copilot/agents/committer.agent.md"; then
  t30_ok=false; echo "  Copilot committer missing github-list-pull-requests"
fi

# Copilot conductor: has glean AND github-get-commit
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t30/output/copilot/agents/conductor.agent.md"; then
  t30_ok=false; echo "  Copilot conductor missing glean-search"
fi
if ! grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t30/output/copilot/agents/conductor.agent.md"; then
  t30_ok=false; echo "  Copilot conductor missing github-get-commit"
fi

# Copilot builder: has glean tools only
if ! grep -q "toolchain/glean-search" "$TOOLS_TMPDIR/t30/output/copilot/agents/builder.agent.md"; then
  t30_ok=false; echo "  Copilot builder missing glean-search"
fi
if grep -q "toolchain/github-get-commit" "$TOOLS_TMPDIR/t30/output/copilot/agents/builder.agent.md"; then
  t30_ok=false; echo "  Copilot builder has github tool it shouldn't"
fi

# CC explorer: has glean tools
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t30/output/claude/agents/explorer.md"; then
  t30_ok=false; echo "  CC explorer missing mcp__glean__search"
fi
if ! grep -q "mcp__glean__summarize" "$TOOLS_TMPDIR/t30/output/claude/agents/explorer.md"; then
  t30_ok=false; echo "  CC explorer missing mcp__glean__summarize"
fi

# CC committer: has glean AND github tools
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t30/output/claude/agents/committer.md"; then
  t30_ok=false; echo "  CC committer missing mcp__glean__search"
fi
if ! grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t30/output/claude/agents/committer.md"; then
  t30_ok=false; echo "  CC committer missing mcp__github__get_commit"
fi

# CC conductor: has glean tools only (no CC conductor in agentTools)
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t30/output/claude/agents/conductor.md"; then
  t30_ok=false; echo "  CC conductor missing mcp__glean__search"
fi
if grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t30/output/claude/agents/conductor.md"; then
  t30_ok=false; echo "  CC conductor has github tool it shouldn't"
fi

[[ "$t30_ok" == true ]] && pass "Realistic mixed config merges correctly" \
  || fail "Realistic mixed config merge failed"

# Test 31: Output format correctness — targeted syntax check
# Reuses Test 30's output directory
t31_ok=true

# Copilot agents: tools section exists and all entries are quoted
for agent_file in "$TOOLS_TMPDIR/t30/output/copilot/agents"/*.agent.md; do
  [[ -f "$agent_file" ]] || continue
  # Extract the frontmatter tools block
  in_tools=false
  has_tools=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^tools: ]]; then
      in_tools=true; has_tools=true; continue
    fi
    if [[ "$in_tools" == true ]]; then
      trimmed="${line##*( )}"  # trim leading whitespace
      # End of block when we hit a non-indented line that's not part of tools
      if [[ ! "$line" =~ ^[[:space:]] && -n "$trimmed" ]]; then
        break
      fi
      # Skip bracket-only lines and blank lines
      [[ "$trimmed" == "[" || "$trimmed" == "]" || -z "$trimmed" ]] && continue
      # All Copilot tool entries must be quoted
      if [[ ! "$trimmed" =~ ^\" ]]; then
        t31_ok=false; echo "  $(basename "$agent_file"): unquoted Copilot tool entry: $trimmed"
      fi
    fi
  done < "$agent_file"
  if [[ "$has_tools" == false ]]; then
    t31_ok=false; echo "  $(basename "$agent_file"): Copilot agent missing tools block"
  fi
done

# CC agents: tools block exists (can be multi-line)
for agent_file in "$TOOLS_TMPDIR/t30/output/claude/agents"/*.md; do
  [[ -f "$agent_file" ]] || continue
  if ! grep -q '^tools:' "$agent_file" 2>/dev/null; then
    t31_ok=false; echo "  $(basename "$agent_file"): CC agent missing tools line"
  fi
done

[[ "$t31_ok" == true ]] && pass "Output format correctness (tools syntax)" \
  || fail "Output format correctness check failed"

# Test 32: Tool names with special characters are properly escaped
mkdir -p "$TOOLS_TMPDIR/t32/config"
cat > "$TOOLS_TMPDIR/t32/config/config.json" << 'ESCAPECFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "copilot": ["toolchain/has\"quote"],
    "cc": ["mcp__has\"quote"]
  },
  "agentTools": {"copilot": {}, "cc": {}}
}
ESCAPECFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t32/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t32/output" >/dev/null 2>&1

t32_ok=true

# Copilot: tool with quote should be properly escaped in YAML
# JSON.stringify produces \"  so it should appear as: "toolchain/has\"quote"
copilot_line=$(grep 'has.*quote' "$TOOLS_TMPDIR/t32/output/copilot/agents/builder.agent.md" || true)
if [[ -z "$copilot_line" ]]; then
  t32_ok=false; echo "  Copilot builder missing tool with quote in name"
elif echo "$copilot_line" | grep -qE '"toolchain/has\\"quote"'; then
  : # Properly escaped — good
else
  t32_ok=false; echo "  Copilot builder: tool with quote not properly escaped: $copilot_line"
fi

# CC: same check for single-line format
cc_line=$(grep 'has.*quote' "$TOOLS_TMPDIR/t32/output/claude/agents/builder.md" || true)
if [[ -z "$cc_line" ]]; then
  t32_ok=false; echo "  CC builder missing tool with quote in name"
elif echo "$cc_line" | grep -qE '"mcp__has\\"quote"'; then
  : # Properly escaped — good
else
  t32_ok=false; echo "  CC builder: tool with quote not properly escaped: $cc_line"
fi

[[ "$t32_ok" == true ]] && pass "Special characters in tool names are escaped" \
  || fail "Special character escaping failed"

# Test 33: Duplicate tools produce a warning
mkdir -p "$TOOLS_TMPDIR/t33/config"
cat > "$TOOLS_TMPDIR/t33/config/config.json" << 'DUPECFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "copilot": ["toolchain/dupe-tool"],
    "cc": ["mcp__dupe"]
  },
  "agentTools": {
    "copilot": {
      "builder": ["toolchain/dupe-tool"]
    },
    "cc": {
      "builder": ["mcp__dupe"]
    }
  }
}
DUPECFG

dupe_output=$(node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t33/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t33/output" 2>&1)

t33_ok=true
if echo "$dupe_output" | grep -qi "duplicate\|dupe"; then
  : # Warning found — good
else
  t33_ok=false; echo "  No duplicate tool warning emitted"
fi

# Also verify the duplicate actually appears in output (still gets added)
dupe_count=$(grep -c "toolchain/dupe-tool" "$TOOLS_TMPDIR/t33/output/copilot/agents/builder.agent.md" 2>/dev/null) || true
if [[ "$dupe_count" -ne 2 ]]; then
  t33_ok=false; echo "  Expected 2 occurrences of dupe tool, got $dupe_count"
fi

[[ "$t33_ok" == true ]] && pass "Duplicate tools warned and still added" \
  || fail "Duplicate tool handling failed"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
