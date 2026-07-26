#!/bin/zsh
# Unit tests for scripts/migrate-config.js — the config-migration script that
# backfills missing keys from defaults/config.json into a user's
# ~/.agents/config.json on every `install.sh` run.
#
# Regression coverage for task 099-graphify-index-lifecycle Phase 1 review
# finding: the old merge only checked TOP-LEVEL keys (`if (!(key in config))`),
# so once a user's config already had a top-level key like `agentTools` (true
# for anyone who ever ran install.sh before this feature), newly-added NESTED
# grants under that key were silently never backfilled. These tests exercise
# the fixed recursive merge directly against the real script (no mocking —
# real temp files, real subprocess), asserting: (1) nested keys ARE backfilled
# when the parent key already exists, (2) a user's existing value — object,
# array, or scalar — is NEVER overwritten, and (3) the documented array policy
# (non-empty user array wins; empty/absent array is backfilled).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATE="$SCRIPT_DIR/scripts/migrate-config.js"
PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "✗ $1"; FAIL=$((FAIL + 1)); }

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Testing migrate-config.js..."

# run_migrate <config-json> <defaults-json> -> stdout of migrate-config.js;
# leaves the migrated config at $TMP_DIR/config.json for inspection.
run_migrate() {
  printf '%s' "$1" > "$TMP_DIR/config.json"
  printf '%s' "$2" > "$TMP_DIR/defaults.json"
  node "$MIGRATE" "$TMP_DIR/config.json" "$TMP_DIR/defaults.json"
}

config_get() {
  node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const v=process.argv[2].split('.').reduce((o,k)=>o&&o[k],c); console.log(JSON.stringify(v))" "$TMP_DIR/config.json" "$1"
}

# --- Baseline: absent top-level key is added whole (pre-existing behavior) --
out=$(run_migrate '{"models":{"opus":"9.9"}}' '{"models":{"opus":"5"},"defaultTools":{"cc":[]}}')
if [[ "$out" == "defaultTools" ]]; then
  pass "Absent top-level key backfilled and reported"
else
  fail "Absent top-level key not reported correctly, got: $out"
fi
if [[ "$(config_get defaultTools.cc)" == "[]" ]]; then
  pass "Absent top-level key's value copied whole from defaults"
else
  fail "Absent top-level key value not copied, got: $(config_get defaultTools.cc)"
fi

# --- Baseline: present top-level scalar/object is left alone, nothing added -
out=$(run_migrate '{"models":{"opus":"9.9","sonnet":"8.8"}}' '{"models":{"opus":"9.9","sonnet":"8.8"}}')
if [[ -z "$out" ]]; then
  pass "Fully-present config produces no output (idempotent)"
else
  fail "Fully-present config should add nothing, got: $out"
fi

# --- THE FIX: nested key backfilled when parent key already exists ----------
out=$(run_migrate \
  '{"agentTools":{"cc":{"committer":["mcp__roundtrip__agent"]}}}' \
  '{"agentTools":{"cc":{"committer":["x"],"explorer":["mcp__graphifyy__*","mcp__state-manager__code_index_status"],"builder":["mcp__graphifyy__*","mcp__state-manager__code_index_build"]}}}')
if [[ "$out" == *"agentTools.cc.explorer"* && "$out" == *"agentTools.cc.builder"* ]]; then
  pass "Nested keys backfilled under an already-present top-level key (dot-path reported)"
else
  fail "Nested keys NOT backfilled under existing top-level key, got: $out"
fi
if [[ "$out" != *"agentTools.cc.committer"* ]]; then
  pass "Already-present nested key not re-reported as added"
else
  fail "Already-present nested key incorrectly reported as added: $out"
fi
if [[ "$(config_get agentTools.cc.explorer)" == '["mcp__graphifyy__*","mcp__state-manager__code_index_status"]' ]]; then
  pass "Backfilled nested array value matches defaults"
else
  fail "Backfilled nested array value wrong: $(config_get agentTools.cc.explorer)"
fi

# --- User's existing nested scalar is NEVER overwritten, even if it differs -
out=$(run_migrate \
  '{"agents":{"conductor":{"copilot":"gpt"}}}' \
  '{"agents":{"conductor":{"copilot":"haiku"},"researcher":{"copilot":"haiku"}}}')
if [[ "$(config_get agents.conductor.copilot)" == '"gpt"' ]]; then
  pass "Existing nested scalar customization preserved (not overwritten by default)"
else
  fail "Existing nested scalar was overwritten! got: $(config_get agents.conductor.copilot)"
fi
if [[ "$out" == *"agents.researcher"* ]]; then
  pass "Sibling nested key absent from user config still backfilled"
else
  fail "Sibling nested key not backfilled, got: $out"
fi

# --- Array policy: non-empty user array wins, is never overwritten ---------
out=$(run_migrate \
  '{"defaultTools":{"cc":["mcp__roundtrip__default"]}}' \
  '{"defaultTools":{"cc":["graphifyy/*"]}}')
if [[ "$(config_get defaultTools.cc)" == '["mcp__roundtrip__default"]' ]]; then
  pass "Non-empty user array preserved as-is (not merged/overwritten)"
else
  fail "Non-empty user array was modified! got: $(config_get defaultTools.cc)"
fi
if [[ -z "$out" ]]; then
  pass "Non-empty user array reports nothing added"
else
  fail "Non-empty user array should not be reported as added, got: $out"
fi

# --- Array policy: empty user array is treated as unset and backfilled -----
out=$(run_migrate \
  '{"defaultTools":{"cc":[]}}' \
  '{"defaultTools":{"cc":["graphifyy/*"]}}')
if [[ "$(config_get defaultTools.cc)" == '["graphifyy/*"]' ]]; then
  pass "Empty user array backfilled from defaults"
else
  fail "Empty user array not backfilled, got: $(config_get defaultTools.cc)"
fi
if [[ "$out" == "defaultTools.cc" ]]; then
  pass "Empty-array backfill reported with dot-path"
else
  fail "Empty-array backfill not reported correctly, got: $out"
fi

# --- Type mismatch (user scalar where default is an object) is left alone --
out=$(run_migrate '{"agentTools":"disabled"}' '{"agentTools":{"cc":{"builder":["x"]}}}')
if [[ "$(config_get agentTools)" == '"disabled"' ]]; then
  pass "Type-mismatched user value left untouched (no recursion into a non-object)"
else
  fail "Type-mismatched user value was modified! got: $(config_get agentTools)"
fi
if [[ -z "$out" ]]; then
  pass "Type mismatch reports nothing added"
else
  fail "Type mismatch should not report anything added, got: $out"
fi

# --- Deep (3-level) nesting backfills correctly -----------------------------
out=$(run_migrate '{"a":{"b":{}}}' '{"a":{"b":{"c":{"d":1}}}}')
if [[ "$out" == "a.b.c" && "$(config_get a.b.c.d)" == "1" ]]; then
  pass "Three-level-deep nested key backfilled with correct dot-path and value"
else
  fail "Deep nested backfill failed, got out=$out value=$(config_get a.b.c.d)"
fi

# --- Prototype-pollution guard: __proto__/constructor/prototype keys --------
# Regression for task 099 second-review finding: `"__proto__" in {}` is always
# true (inherited accessor), so the old `!(key in targetObj)` check treated
# "__proto__" as "already present", read it via the getter (returning the
# real Object.prototype), passed isPlainObject, and recursed INTO
# Object.prototype — mutating it for the whole process.
#
# Pollution lives on the real (shared) Object.prototype, which only survives
# within a single Node process — a separate `node -e` subprocess can never
# observe it. So `check_no_pollution` requires migrate-config.js in-process
# (same Node process that ran the merge) and inspects `({}).polluted`
# immediately afterward, in that same process.
check_no_pollution() {
  local label="$1" config="$2" defaults="$3"
  printf '%s' "$config" > "$TMP_DIR/config.json"
  printf '%s' "$defaults" > "$TMP_DIR/defaults.json"
  # migrate-config.js itself prints backfilled dot-paths to stdout as a side
  # effect of being `require`d (its top-level `added.forEach(console.log)`
  # runs), so the pollution verdict is prefixed/suffixed by that noise -
  # match on substring rather than exact equality.
  local result
  result=$(node -e "
    process.argv[2] = '$TMP_DIR/config.json';
    process.argv[3] = '$TMP_DIR/defaults.json';
    require('$MIGRATE');
    console.log(({}).polluted === undefined ? 'VERDICT:clean' : 'VERDICT:POLLUTED:' + ({}).polluted);
  ")
  if [[ "$result" == *"VERDICT:clean"* ]]; then
    pass "$label"
  else
    fail "$label (got: $result)"
  fi
}

check_no_pollution \
  "__proto__ key in defaults does not pollute Object.prototype" \
  '{"agentTools":{}}' \
  '{"agentTools":{"__proto__":{"polluted":"YES"}}}'

out=$(run_migrate '{"agentTools":{}}' '{"agentTools":{"__proto__":{"polluted":"YES"}}}')
if [[ "$out" != *"__proto__"* ]]; then
  pass "__proto__ key is not reported as a backfilled path"
else
  fail "__proto__ key incorrectly reported as added: $out"
fi

check_no_pollution \
  "constructor key in defaults does not pollute Object.prototype" \
  '{"agentTools":{}}' \
  '{"agentTools":{"constructor":{"polluted":"YES2"}}}'

out=$(run_migrate '{"agentTools":{}}' '{"agentTools":{"constructor":{"polluted":"YES2"}}}')
if [[ "$out" != *"constructor"* ]]; then
  pass "constructor key is not reported as a backfilled path"
else
  fail "constructor key incorrectly reported as added: $out"
fi

check_no_pollution \
  "prototype key in defaults does not pollute Object.prototype" \
  '{"agentTools":{}}' \
  '{"agentTools":{"prototype":{"polluted":"YES3"}}}'

out=$(run_migrate '{"agentTools":{}}' '{"agentTools":{"prototype":{"polluted":"YES3"}}}')
if [[ "$out" != *"prototype"* ]]; then
  pass "prototype key is not reported as a backfilled path"
else
  fail "prototype key incorrectly reported as added: $out"
fi

# --- Missing CLI args / files: exits 0 quietly, no crash --------------------
node "$MIGRATE" > /dev/null 2>&1
if [[ $? -eq 0 ]]; then
  pass "Missing CLI args exits 0 quietly"
else
  fail "Missing CLI args should exit 0"
fi

node "$MIGRATE" "$TMP_DIR/does-not-exist.json" "$TMP_DIR/also-missing.json" > /dev/null 2>&1
if [[ $? -eq 0 ]]; then
  pass "Missing config/defaults files exits 0 quietly"
else
  fail "Missing config/defaults files should exit 0"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
