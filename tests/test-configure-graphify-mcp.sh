#!/bin/bash
#
# Test scripts/configure-graphify-mcp.js hermetically.
#
# Everything runs against real files in a mktemp'd git repo with a stubbed
# graphify-mcp on PATH and a fixture AGENTS config whose `build` writes an empty
# graph.json -- which both stubs the build (CI has no graphify) and proves it
# ran. Needs neither graphify nor VS Code.
#
# Six cases:
#   1 Create                     -- no .vscode/ -> file created, build ran, duplicate-scope warning
#   2 Create beside a neighbour  -- .vscode/settings.json stays byte-identical
#   3 Splice                     -- comments, trailing commas, CRLF, no-trailing-newline,
#                                   one-line servers block, empty "servers": {}
#   4 Idempotent                 -- exit 1, byte-identical, build skipped as fresh
#   5 Differing entry            -- exit 2, byte-identical, no build
#   6 Guards                     -- non-repo and $HOME refuse before any filesystem effect
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL="$SCRIPT_DIR/../scripts/configure-graphify-mcp.js"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

PASSED=0
FAILED=0
pass() { echo "✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "❌ $1"; FAILED=$((FAILED + 1)); }

OUT="$TEST_DIR/stdout.txt"
ERR="$TEST_DIR/stderr.txt"

# --- Stubbed graphify-mcp on PATH -------------------------------------------
# Copied from /bin/echo rather than written+chmod'ed so the executable bit comes
# for free and the stub is a real, runnable binary.
FAKE_BIN="$TEST_DIR/bin"
mkdir -p "$FAKE_BIN"
cp /bin/echo "$FAKE_BIN/graphify-mcp"
EXPECTED_COMMAND="$FAKE_BIN/graphify-mcp"

# --- Fixture AGENTS config --------------------------------------------------
# `build` stubs `graphify extract`: it creates the graph file the freshness
# check looks for, so "did the build run" is observable.
CFG="$TEST_DIR/agents-config.json"
printf '%s\n' '{ "code_index": { "build": "mkdir -p graphify-out && printf {} > graphify-out/graph.json", "graph_file": "graphify-out/graph.json", "code_extensions": [".js", ".py", ".sh"] } }' > "$CFG"

# --- Fake HOME carrying a user-scope graphifyy entry -----------------------
FAKE_HOME="$TEST_DIR/home"
mkdir -p "$FAKE_HOME/Library/Application Support/Code/User"
printf '%s\n' '{ "servers": { "graphifyy": { "type": "stdio", "command": "/Users/x/.local/bin/graphify-mcp-project" } } }' > "$FAKE_HOME/Library/Application Support/Code/User/mcp.json"

# --- JSONC -> JSON helper used by the assertions ---------------------------
JSONC="$TEST_DIR/jsonc-parse.js"
{
  printf '%s\n' 'const fs = require("fs");'
  printf '%s\n' 'const t = fs.readFileSync(process.argv[2], "utf8");'
  printf '%s\n' 'const s = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");'
  printf '%s\n' 'process.stdout.write(JSON.stringify(JSON.parse(s)));'
} > "$JSONC"

TOOL_EXIT=0
run_tool() { # $1 = dir to run in, $2.. = tool args
  local dir="$1"
  shift
  set +e
  (
    cd "$dir" &&
      HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" AGENTS_CONFIG_PATH="$CFG" \
        node "$TOOL" "$@"
  ) > "$OUT" 2> "$ERR"
  TOOL_EXIT=$?
  set -e
}

run_tool_home() { # like run_tool but with an explicit HOME (case 6)
  local dir="$1"
  local home="$2"
  shift 2
  set +e
  (
    cd "$dir" &&
      HOME="$home" PATH="$FAKE_BIN:$PATH" AGENTS_CONFIG_PATH="$CFG" \
        node "$TOOL" "$@"
  ) > "$OUT" 2> "$ERR"
  TOOL_EXIT=$?
  set -e
}

new_repo() { # $1 = name -> echoes the path
  local dir="$TEST_DIR/$1"
  mkdir -p "$dir"
  git init -q -b main "$dir"
  echo "$dir"
}

want_exit() {
  if [[ $TOOL_EXIT -ne $1 ]]; then
    echo "   exit $TOOL_EXIT, expected $1"
    echo "   stdout: $(cat "$OUT")"
    echo "   stderr: $(cat "$ERR")"
    return 1
  fi
}

has() { # file, fixed-string pattern
  if ! grep -qF -- "$2" "$1"; then
    echo "   missing from $(basename "$1"): $2"
    return 1
  fi
}

hasnt() {
  if grep -qF -- "$2" "$1"; then
    echo "   unexpectedly present in $(basename "$1"): $2"
    return 1
  fi
}

identical() {
  if ! cmp -s "$1" "$2"; then
    echo "   file changed: $1"
    return 1
  fi
}

# ===========================================================================
# Case 1 -- Create
# ===========================================================================
C1=$(new_repo case1)
if run_tool "$C1" &&
  want_exit 0 &&
  has "$C1/.vscode/mcp.json" '"graphifyy"' &&
  has "$C1/.vscode/mcp.json" '"cwd": "${workspaceFolder}"' &&
  has "$C1/.vscode/mcp.json" "\"command\": \"$EXPECTED_COMMAND\"" &&
  hasnt "$C1/.vscode/mcp.json" '"args"' &&
  hasnt "$C1/.vscode/mcp.json" '"autoStart"' &&
  # the stub build ran
  [[ -f "$C1/graphify-out/graph.json" ]] &&
  # tab-indented, LF, trailing newline -- matches what VS Code's own writer emits
  grep -q $'^\t"servers": {$' "$C1/.vscode/mcp.json" &&
  hasnt "$C1/.vscode/mcp.json" $'\r' &&
  [[ -z "$(tail -c 1 "$C1/.vscode/mcp.json")" ]] &&
  # strict-JSON parseable, id preserved
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!o.servers.graphifyy) throw new Error("missing servers.graphifyy")' "$C1/.vscode/mcp.json" &&
  # duplicate user-scope entry is warned about, and that file is never edited
  has "$ERR" "USER scope" &&
  has "$ERR" "mcp_graphify2_" &&
  has "$FAKE_HOME/Library/Application Support/Code/User/mcp.json" '"graphifyy"'; then
  pass "Create"
else
  fail "Create"
fi

# ===========================================================================
# Case 2 -- Create beside a neighbour (the real shape of ~/dev/sdr)
# ===========================================================================
C2=$(new_repo case2)
mkdir -p "$C2/.vscode"
printf '%s\n' '{' '  // a neighbour we must not touch' '  "editor.formatOnSave": true,' '}' > "$C2/.vscode/settings.json"
cp "$C2/.vscode/settings.json" "$TEST_DIR/settings.snapshot"
if run_tool "$C2" &&
  want_exit 0 &&
  has "$C2/.vscode/mcp.json" '"graphifyy"' &&
  identical "$C2/.vscode/settings.json" "$TEST_DIR/settings.snapshot" &&
  [[ ! -f "$C2/.vscode/mcp.json.backup" ]]; then
  pass "Create beside a neighbour"
else
  fail "Create beside a neighbour"
fi

# ===========================================================================
# Case 3 -- Splice. The case a JSON.parse/JSON.stringify rewrite cannot pass.
#
# Fixture 3a is CRLF, has no trailing newline, carries two trailing commas, and
# -- placed BEFORE the real key -- a COMMENTED-OUT `"servers"` block, the shape
# a user leaves behind when they park their old config. It has its own `:` and
# `{`, so a raw indexOf('"servers"') scan splices the entry INSIDE the comment.
# 3b is a one-line servers block; 3c is an empty `"servers": {}`.
# ===========================================================================
C3=$(new_repo case3)
mkdir -p "$C3/.vscode"
printf '{\r\n\t// "servers": { "old": { "type": "stdio", "command": "/x" } },\r\n\t"servers": {\r\n\t\t"other": {\r\n\t\t\t"type": "stdio",\r\n\t\t\t"command": "/bin/true",\r\n\t\t},\r\n\t},\r\n}' > "$C3/.vscode/mcp.json"
cp "$C3/.vscode/mcp.json" "$TEST_DIR/mcp3a.snapshot"

CASE3_OK=1
run_tool "$C3"
want_exit 0 || CASE3_OK=0
has "$C3/.vscode/mcp.json" '"graphifyy"' || CASE3_OK=0
# the neighbour, its trailing comma and its formatting all survive
has "$C3/.vscode/mcp.json" '"other"' || CASE3_OK=0
has "$C3/.vscode/mcp.json" '"command": "/bin/true",' || CASE3_OK=0
# the commented-out block survives intact and was NOT spliced into
has "$C3/.vscode/mcp.json" '// "servers": { "old": { "type": "stdio", "command": "/x" } },' || CASE3_OK=0
if grep -F '// "servers"' "$C3/.vscode/mcp.json" | grep -qF 'graphifyy'; then CASE3_OK=0; fi
# CRLF is preserved on the inserted lines, and no trailing newline was added
grep -qU $'"cwd": "${workspaceFolder}"\r' "$C3/.vscode/mcp.json" || CASE3_OK=0
[[ -n "$(tail -c 1 "$C3/.vscode/mcp.json")" ]] || CASE3_OK=0
# still parses as JSONC, with both servers present
node "$JSONC" "$C3/.vscode/mcp.json" > "$TEST_DIR/parsed3a.json" || CASE3_OK=0
has "$TEST_DIR/parsed3a.json" '"graphifyy"' || CASE3_OK=0
has "$TEST_DIR/parsed3a.json" '"other"' || CASE3_OK=0
has "$TEST_DIR/parsed3a.json" '"cwd":"${workspaceFolder}"' || CASE3_OK=0
# a backup of the pre-splice file sits beside it, byte-identical to the original
identical "$C3/.vscode/mcp.json.backup" "$TEST_DIR/mcp3a.snapshot" || CASE3_OK=0

# 3b -- one-line servers block
C3B=$(new_repo case3b)
mkdir -p "$C3B/.vscode"
printf '%s\n' '{ "servers": { "other": { "type": "stdio", "command": "/bin/true" } } }' > "$C3B/.vscode/mcp.json"
run_tool "$C3B"
want_exit 0 || CASE3_OK=0
node "$JSONC" "$C3B/.vscode/mcp.json" > "$TEST_DIR/parsed3b.json" || CASE3_OK=0
has "$TEST_DIR/parsed3b.json" '"graphifyy"' || CASE3_OK=0
has "$TEST_DIR/parsed3b.json" '"other"' || CASE3_OK=0

# 3c -- empty "servers": {}
C3C=$(new_repo case3c)
mkdir -p "$C3C/.vscode"
printf '%s\n' '{' '	"servers": {}' '}' > "$C3C/.vscode/mcp.json"
run_tool "$C3C"
want_exit 0 || CASE3_OK=0
node "$JSONC" "$C3C/.vscode/mcp.json" > "$TEST_DIR/parsed3c.json" || CASE3_OK=0
has "$TEST_DIR/parsed3c.json" '"graphifyy"' || CASE3_OK=0
# no orphaned comma from splicing into an empty object
hasnt "$C3C/.vscode/mcp.json" '},' || CASE3_OK=0

if [[ $CASE3_OK -eq 1 ]]; then pass "Splice"; else fail "Splice"; fi

# ===========================================================================
# Case 4 -- Idempotent (re-run case 1's directory)
# ===========================================================================
cp "$C1/.vscode/mcp.json" "$TEST_DIR/mcp1.snapshot"
if run_tool "$C1" &&
  want_exit 1 &&
  identical "$C1/.vscode/mcp.json" "$TEST_DIR/mcp1.snapshot" &&
  has "$OUT" "already has a matching servers.graphifyy" &&
  has "$OUT" "index: skipped (fresh)" &&
  [[ ! -f "$C1/.vscode/mcp.json.backup" ]]; then
  pass "Idempotent"
else
  fail "Idempotent"
fi

# ===========================================================================
# Case 5 -- Differing entry: never modified, no build
# ===========================================================================
C5=$(new_repo case5)
mkdir -p "$C5/.vscode"
printf '%s\n' '{' '	"servers": {' '		"graphifyy": {' '			"type": "stdio",' '			"command": "/nope/graphify-mcp",' '			"cwd": "${workspaceFolder}"' '		}' '	}' '}' > "$C5/.vscode/mcp.json"
cp "$C5/.vscode/mcp.json" "$TEST_DIR/mcp5.snapshot"
if run_tool "$C5" &&
  want_exit 2 &&
  identical "$C5/.vscode/mcp.json" "$TEST_DIR/mcp5.snapshot" &&
  has "$ERR" "/nope/graphify-mcp" &&
  has "$ERR" "$EXPECTED_COMMAND" &&
  [[ ! -f "$C5/graphify-out/graph.json" ]] &&
  [[ ! -f "$C5/.vscode/mcp.json.backup" ]]; then
  pass "Differing entry"
else
  fail "Differing entry"
fi

# ===========================================================================
# Case 6 -- Guards refuse before any filesystem effect
# ===========================================================================
CASE6_OK=1

# 6a -- not a git repository
C6A="$TEST_DIR/case6a"
mkdir -p "$C6A"
run_tool "$C6A"
want_exit 2 || CASE6_OK=0
has "$ERR" "not inside a git repository" || CASE6_OK=0
[[ ! -e "$C6A/.vscode" ]] || CASE6_OK=0
[[ ! -e "$C6A/graphify-out" ]] || CASE6_OK=0

# 6b -- the repo root IS $HOME (a dotfiles repo would otherwise pass the repo test)
C6B=$(new_repo case6b)
run_tool_home "$C6B" "$C6B"
want_exit 2 || CASE6_OK=0
has "$ERR" "is the home directory" || CASE6_OK=0
[[ ! -e "$C6B/.vscode" ]] || CASE6_OK=0
[[ ! -e "$C6B/graphify-out" ]] || CASE6_OK=0

if [[ $CASE6_OK -eq 1 ]]; then pass "Guards"; else fail "Guards"; fi

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
[[ $FAILED -eq 0 ]]
