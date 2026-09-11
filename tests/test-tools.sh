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
    "cc": ["mcp__test__default"]
  },
  "agentTools": {
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

# All CC agents should have the default tool
if ! grep -q "mcp__test__default" \
  "$TOOLS_TMPDIR/t26/output/claude/agents/explorer.md"; then
  tools_ok=false; echo "  CC Explorer missing default tool"
fi

# Committer should have both default + agent-specific
if ! grep -q "mcp__test__agent_specific" \
  "$TOOLS_TMPDIR/t26/output/claude/agents/committer.md"; then
  tools_ok=false; echo "  CC Committer missing agent-specific tool"
fi

# Builder should NOT have agent-specific tool
if grep -q "mcp__test__agent_specific" \
  "$TOOLS_TMPDIR/t26/output/claude/agents/builder.md"; then
  tools_ok=false; echo "  CC Builder has agent-specific tool it shouldn't"
fi

[[ "$tools_ok" == true ]] && pass "Tools merge from config works" \
  || fail "Tools merge from config failed"

# Test 27: Empty/absent tools config — no tools added
# Sub-case A: explicit empty tools
mkdir -p "$TOOLS_TMPDIR/t27/config"
cat > "$TOOLS_TMPDIR/t27/config/config.json" << 'EMPTYCFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"cc": []},
  "agentTools": {"cc": {}}
}
EMPTYCFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t27/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t27/output" >/dev/null 2>&1

t27a_ok=true
# CC explorer should have zero injected tools
cc_actual_count=$(grep -c 'mcp__' "$TOOLS_TMPDIR/t27/output/claude/agents/explorer.md" 2>/dev/null) || true
cc_actual_count=${cc_actual_count:-0}
if [[ "$cc_actual_count" -ne 0 ]]; then
  t27a_ok=false; echo "  CC explorer has unexpected tools (actual=$cc_actual_count)"
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
cc_actual_count_b=$(grep -c 'mcp__' "$TOOLS_TMPDIR/t27b/output/claude/agents/explorer.md" 2>/dev/null) || true
cc_actual_count_b=${cc_actual_count_b:-0}
if [[ "$cc_actual_count_b" -ne 0 ]]; then
  t27b_ok=false; echo "  CC explorer has unexpected tools (actual=$cc_actual_count_b)"
fi
[[ "$t27b_ok" == true ]] && pass "Absent tools keys adds no tools (sub-case B)" \
  || fail "Absent tools keys added unexpected tools (sub-case B)"

# Test 28: Only defaultTools, no agentTools
mkdir -p "$TOOLS_TMPDIR/t28/config"
cat > "$TOOLS_TMPDIR/t28/config/config.json" << 'DEFONLY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {
    "cc": ["mcp__glean__search", "mcp__glean__summarize"]
  },
  "agentTools": {"cc": {}}
}
DEFONLY

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t28/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t28/output" >/dev/null 2>&1

t28_ok=true
# CC explorer has both defaults
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t28/output/claude/agents/explorer.md"; then
  t28_ok=false; echo "  CC explorer missing mcp__glean__search"
fi
if ! grep -q "mcp__glean__summarize" "$TOOLS_TMPDIR/t28/output/claude/agents/explorer.md"; then
  t28_ok=false; echo "  CC explorer missing mcp__glean__summarize"
fi
# CC committer has both defaults
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t28/output/claude/agents/committer.md"; then
  t28_ok=false; echo "  CC committer missing mcp__glean__search"
fi
if ! grep -q "mcp__glean__summarize" "$TOOLS_TMPDIR/t28/output/claude/agents/committer.md"; then
  t28_ok=false; echo "  CC committer missing mcp__glean__summarize"
fi
# No agent has agent-specific tools beyond defaults
if grep -q "mcp__github" "$TOOLS_TMPDIR/t28/output/claude/agents/explorer.md"; then
  t28_ok=false; echo "  CC explorer has unexpected agent-specific tools"
fi
[[ "$t28_ok" == true ]] && pass "Only defaultTools populates all agents" \
  || fail "Only defaultTools test failed"

# Test 29: Only agentTools, no defaultTools
mkdir -p "$TOOLS_TMPDIR/t29/config"
cat > "$TOOLS_TMPDIR/t29/config/config.json" << 'AGENTONLY'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"cc": []},
  "agentTools": {
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
    "cc": ["mcp__glean__search", "mcp__glean__summarize"]
  },
  "agentTools": {
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

# CC explorer does NOT have github tool
if grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t30/output/claude/agents/explorer.md"; then
  t30_ok=false; echo "  CC explorer has github tool it shouldn't"
fi

# CC builder: has glean tools only
if ! grep -q "mcp__glean__search" "$TOOLS_TMPDIR/t30/output/claude/agents/builder.md"; then
  t30_ok=false; echo "  CC builder missing mcp__glean__search"
fi
if grep -q "mcp__github__get_commit" "$TOOLS_TMPDIR/t30/output/claude/agents/builder.md"; then
  t30_ok=false; echo "  CC builder has github tool it shouldn't"
fi

[[ "$t30_ok" == true ]] && pass "Realistic mixed config merges correctly" \
  || fail "Realistic mixed config merge failed"

# Test 31: Output format correctness — targeted syntax check
# Reuses Test 30's output directory
t31_ok=true

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
    "cc": ["mcp__has\"quote"]
  },
  "agentTools": {"cc": {}}
}
ESCAPECFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t32/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t32/output" >/dev/null 2>&1

t32_ok=true

# CC: check for tool with quote in name
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
    "cc": ["mcp__dupe"]
  },
  "agentTools": {
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

# Per the §3.2 dedupe spec, a tool duplicated across defaultTools and
# agentTools is still WARNED about but now collapses to a single occurrence
# (first-occurrence-wins, applied uniformly across all three grant sources).
dupe_count=$(grep -c "mcp__dupe" "$TOOLS_TMPDIR/t33/output/claude/agents/builder.md" 2>/dev/null) || true
if [[ "$dupe_count" -ne 1 ]]; then
  t33_ok=false; echo "  Expected 1 occurrence of dupe tool (deduped), got $dupe_count"
fi

[[ "$t33_ok" == true ]] && pass "Duplicate tools warned and deduped to one occurrence" \
  || fail "Duplicate tool handling failed"

# ---------------------------------------------------------------------------
# mcpServers profile grant derivation + dedupe (Phase 3, task 102)
# ---------------------------------------------------------------------------

mkdir -p "$TOOLS_TMPDIR/t34" "$TOOLS_TMPDIR/t35" "$TOOLS_TMPDIR/t36" \
         "$TOOLS_TMPDIR/t38" "$TOOLS_TMPDIR/t39"

# Test 34: A profile listing builder appends grant.cc to
# builder's tools: on CC.
mkdir -p "$TOOLS_TMPDIR/t34/config"
cat > "$TOOLS_TMPDIR/t34/config/config.json" << 'T34CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "grant": "mcp__graphifyy__*",
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T34CFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t34/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t34/output" >/dev/null 2>&1

t34_ok=true
grep -q 'mcp__graphifyy__\*' "$TOOLS_TMPDIR/t34/output/claude/agents/builder.md" || \
  { t34_ok=false; echo "  CC builder missing grant.cc"; }
[[ "$t34_ok" == true ]] && pass "Profile grant reaches tools: on CC" \
  || fail "Profile grant did not reach tools: on CC"

# Test 35: A profile grant duplicating an existing defaultTools entry appears
# exactly once in the generated tools: array.
mkdir -p "$TOOLS_TMPDIR/t35/config"
cat > "$TOOLS_TMPDIR/t35/config/config.json" << 'T35CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"cc": ["mcp__graphifyy__*"]},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "grant": "mcp__graphifyy__*",
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T35CFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t35/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t35/output" >/dev/null 2>&1

t35_count=$(awk '/^---$/{c++; next} c==1' "$TOOLS_TMPDIR/t35/output/claude/agents/builder.md" | grep -c 'mcp__graphifyy__\*' 2>/dev/null) || true
[[ "${t35_count:-0}" -eq 1 ]] && pass "Profile grant duplicating defaultTools appears exactly once" \
  || fail "Profile grant duplicating defaultTools appeared $t35_count times (expected 1)"

# Test 36: Dedupe order is deterministic and matches the §3.2 spec.
# defaultTools=[a,b], agentTools=[b,c], profile1 grants [c,d], profile2
# grants [d,e] -> appended entries must be exactly a,b,c,d,e IN THAT ORDER.
# defaultTools<->agentTools overlap on "b" still warns; profile overlaps on
# "c"/"d" are silent.
mkdir -p "$TOOLS_TMPDIR/t36/config"
cat > "$TOOLS_TMPDIR/t36/config/config.json" << 'T36CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "defaultTools": {"cc": ["a", "b"]},
  "agentTools": {"cc": {"builder": ["b", "c"]}},
  "mcpServers": {
    "profOne": {
      "displayName": "Profile One",
      "toolNames": "mcp__one__*",
      "grant": ["c", "d"],
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "profile one hint"
    },
    "profTwo": {
      "displayName": "Profile Two",
      "toolNames": "mcp__two__*",
      "grant": ["d", "e"],
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "profile two hint"
    }
  }
}
T36CFG

STDERR36=$(node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t36/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t36/output" 2>&1 >/dev/null)

t36_file="$TOOLS_TMPDIR/t36/output/claude/agents/builder.md"
t36_order=$(awk '/^---$/{c++; next} c==1' "$t36_file" | grep -oE '"[a-e]",?$' | tr -d ',"' | tr '\n' ',')
t36_ok=true
[[ "$t36_order" == "a,b,c,d,e," ]] || { t36_ok=false; echo "  Dedupe order: got '$t36_order', expected 'a,b,c,d,e,'"; }
echo "$STDERR36" | grep -q '"b".*appears in both' || { t36_ok=false; echo "  Missing defaultTools/agentTools overlap warning for 'b'"; }
echo "$STDERR36" | grep -q '"c".*appears in both' && { t36_ok=false; echo "  Unexpected warning for profile-overlap 'c'"; }
echo "$STDERR36" | grep -q '"d".*appears in both' && { t36_ok=false; echo "  Unexpected warning for profile-overlap 'd'"; }
[[ "$t36_ok" == true ]] && pass "Dedupe order matches §3.2 spec (defaults -> agentTools -> profiles, first-occurrence-wins)" \
  || fail "Dedupe order or warning policy did not match §3.2 spec"

# Test 37: Dedupe is idempotent — running the generator twice over case 36's
# config produces byte-identical output.
node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t36/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t36/output2" >/dev/null 2>&1
if diff -q "$t36_file" "$TOOLS_TMPDIR/t36/output2/claude/agents/builder.md" >/dev/null; then
  pass "Dedupe is idempotent across repeated runs"
else
  fail "Dedupe produced different output on a second run"
fi

# Test 38: Grants are appended correctly to both the multi-line (Format A,
# explorer) and single-line (Format B, researcher) tools: layouts.
mkdir -p "$TOOLS_TMPDIR/t38/config"
cat > "$TOOLS_TMPDIR/t38/config/config.json" << 'T38CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "codeGraph": {
      "displayName": "Graphify code graph",
      "toolNames": "mcp__graphifyy__*",
      "grant": "mcp__graphifyy-fmt-test__*",
      "salience": "on-demand",
      "agents": ["explorer", "researcher"],
      "hint": "for tracing symbols, usages and cross-file structure"
    }
  }
}
T38CFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t38/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t38/output" >/dev/null 2>&1

t38_ok=true
grep -q 'mcp__graphifyy-fmt-test__\*' "$TOOLS_TMPDIR/t38/output/claude/agents/explorer.md" || \
  { t38_ok=false; echo "  Format A (explorer, multi-line tools:) missing grant"; }
grep -q 'mcp__graphifyy-fmt-test__\*' "$TOOLS_TMPDIR/t38/output/claude/agents/researcher.md" || \
  { t38_ok=false; echo "  Format B (researcher, single-line tools:) missing grant"; }
[[ "$t38_ok" == true ]] && pass "Profile grants append correctly to both Format A and Format B tools: layouts" \
  || fail "Profile grant did not append correctly to one of the tools: layouts"

# Test 39: A profile whose grant is an array of two narrow tool
# grants — both appear as separate tools: entries (F6 narrow-grant path).
mkdir -p "$TOOLS_TMPDIR/t39/config"
cat > "$TOOLS_TMPDIR/t39/config/config.json" << 'T39CFG'
{
  "models": {"opus": "4.6", "sonnet": "4.6"},
  "mcpServers": {
    "toolchainApi": {
      "displayName": "Toolchain APIs",
      "toolNames": "mcp__toolchain__*",
      "grant": ["mcp__toolchain__list_services", "mcp__toolchain__describe_service"],
      "salience": "on-demand",
      "agents": ["builder"],
      "hint": "for querying internal service metadata"
    }
  }
}
T39CFG

node scripts/generate.js all \
  --config "$TOOLS_TMPDIR/t39/config/config.json" \
  --output-dir "$TOOLS_TMPDIR/t39/output" >/dev/null 2>&1

t39_ok=true
grep -q 'mcp__toolchain__list_services' "$TOOLS_TMPDIR/t39/output/claude/agents/builder.md" || \
  { t39_ok=false; echo "  Missing first narrow grant entry"; }
grep -q 'mcp__toolchain__describe_service' "$TOOLS_TMPDIR/t39/output/claude/agents/builder.md" || \
  { t39_ok=false; echo "  Missing second narrow grant entry"; }
[[ "$t39_ok" == true ]] && pass "Array grant expands to separate tools: entries" \
  || fail "Array grant did not expand to separate tools: entries"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
