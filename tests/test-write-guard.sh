#!/bin/zsh
# Unit tests for hooks/write-guard.sh — the shared, multi-agent-aware
# PreToolUse Bash write-guard (task 100-reviewer-write-lockdown, Phases 2/5).
#
# Validates the unwrap-then-scan design (quote-aware top-level scan +
# recursive wrapper unwrap), NOT raw-scan: the ALLOW table below includes
# quoted-operator vectors (e.g. `grep 'a > b' file`) that a naive raw-scan
# would incorrectly deny.
#
# The DENY/ALLOW matrix below invokes the guard with the "reviewer" argv
# (matching how the Reviewer agent is actually wired, per
# templates/agents/reviewer.template.md) so the deny/allow POLICY assertions
# and the pinned Reviewer coaching substring stay meaningful. Phase 5's
# agent-aware message selection (argv precedence, stdin `agent_type`
# fallback, Committer/default messages) is covered separately below.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/hooks/write-guard.sh"
PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "✗ $1"; FAIL=$((FAIL + 1)); }

echo "Testing shared write-guard hook..."
cd "$SCRIPT_DIR"

# Build a PreToolUse JSON payload and feed it to the guard with the
# "reviewer" argv (the DENY/ALLOW matrix below only cares about the
# deny/allow decision + the pinned Reviewer coaching substring).
# $1 = tool_name (e.g. "Bash" or "runTerminalCommand"), $2 = command string.
run_guard() {
  python3 -c 'import json,sys; print(json.dumps({"tool_name": sys.argv[1], "tool_input": {"command": sys.argv[2]}}))' "$1" "$2" | python3 "$GUARD" reviewer
}

# Build a PreToolUse JSON payload with an optional stdin `agent_type` and
# feed it to the guard with an optional argv agent id, for message-selection
# tests. $1 = command string, $2 = stdin agent_type (may be empty string),
# $3... = argv to pass to the guard (may be omitted entirely).
run_guard_agent() {
  local cmd="$1" agent_type="$2"
  shift 2
  python3 -c 'import json,sys
payload={"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}
if sys.argv[2]:
    payload["agent_type"] = sys.argv[2]
print(json.dumps(payload))' "$cmd" "$agent_type" | python3 "$GUARD" "$@"
}

is_deny() {
  [[ "$1" == *'"permissionDecision": "deny"'* || "$1" == *'"permissionDecision":"deny"'* ]]
}

# --- DENY table -------------------------------------------------------------
# Every case here must DENY under BOTH tool_name "Bash" and
# "runTerminalCommand" (host-agnostic — Phase 3/Copilot reuses this script),
# and every deny must carry the coaching permissionDecisionReason substring.
DENY_CMDS=(
  $'cat > /tmp/foo.py <<\'EOF\'\necho hi\nEOF'
  $'cat <<EOF'
  $'echo x > out.txt'
  $'echo x >> out.txt'
  $'printf \'%s\' y | tee file'
  $'sed -i \'s/a/b/\' f.py'
  $'python3 -c "open(\'x\',\'w\').write(\'1\')"'
  $'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"'
  $'perl -i -pe \'s/a/b/\' f'
  $'touch newfile'
  $'dd if=/dev/zero of=blob bs=1 count=1'
  $'vim file'
  $'nano f'
  $'ed f'
  $'bash -c "echo x > /tmp/f"'
  $'sh -c \'echo hi >> f\''
  $'python3 -c "import os; os.system(\'touch f\')"'
  $'zsh -c "echo x > f"'
  $'env FOO=bar bash -c "echo x > f"'
  $'xargs -I{} sh -c \'echo {} > f\''
  $'find . -exec sh -c \'echo {} > f\' \\;'
  $'awk \'{print $0 > "out"}\' file'
  $'curl -o out.html https://example.com'
  $'curl -O https://example.com/file.txt'
  $'wget -O out.html https://example.com'
  $'wget -o log.txt https://example.com'

  # --- Adversarial-audit regression vectors (4 confirmed bypasses) ---------
  # 1. Backslash-escaped command names: word matching must run on a
  #    de-escaped token stream (bash strips a backslash before a
  #    non-special char, so `t\ee` executes as `tee`, etc.).
  $'t\\ee /tmp/x'
  $'to\\uch /tmp/x'
  $'s\\ed -i s/a/b/ f'
  $'v\\i f'
  $'\\t\\o\\u\\c\\h f'

  # 2. $(...) / backtick command substitution is evaluated by bash even
  #    inside double quotes (only single quotes suppress it) — must be
  #    extracted and re-scanned regardless of surrounding quoting.
  $'echo "$(touch f)"'
  $'echo "`touch f`"'
  $'echo "$(echo x > f)"'
  $'foo="$(sed -i s/a/b/ f)"'

  # 3. Bundled short flags for curl/wget download-to-file (-o/-O bundled
  #    with other short flags in the same dash group).
  $'curl -sO https://example.com/file'
  $'curl -Lo out.html https://example.com'
  $'wget -qO out.html https://example.com'

  # 4. python3 -c subprocess list-argv form (argv[0] is a write command).
  $'python3 -c "import subprocess; subprocess.run([\'touch\',\'/tmp/pwned\'])"'
  $'python3 -c "import subprocess; subprocess.call([\'tee\',\'f\'])"'

  # --- Final fix pass: eval wrapper (bounded, 2026-07-26) ------------------
  # `eval` executes its string argument as shell code, same as `sh -c` — it
  # must be recognized as an unwrap-able wrapper so a write hidden inside its
  # quoted argument is still caught.
  $'eval "touch f"'
  $'eval \'echo x > f\''
  $'eval \'sed -i s/a/b/ f\''
)

for cmd in "${DENY_CMDS[@]}"; do
  label="${cmd:0:60}"

  out=$(run_guard "Bash" "$cmd")
  if is_deny "$out"; then
    pass "DENY (Bash): $label"
  else
    fail "DENY (Bash) expected but ALLOWED: $label -> $out"
  fi

  if [[ "$out" == *"Do NOT attempt another write method"* ]]; then
    pass "Coaching permissionDecisionReason present: $label"
  else
    fail "Coaching permissionDecisionReason MISSING: $label -> $out"
  fi

  out2=$(run_guard "runTerminalCommand" "$cmd")
  if is_deny "$out2"; then
    pass "DENY (runTerminalCommand, host-agnostic): $label"
  else
    fail "DENY (runTerminalCommand) expected but ALLOWED: $label -> $out2"
  fi
done

# --- ALLOW table -------------------------------------------------------------
# Includes the quote-aware ALLOW vectors, here-string, plain curl/wget, and
# out-of-scope tree ops (clarification 1) — none of these may ever deny.
ALLOW_CMDS=(
  $'pytest -q'
  $'npm test'
  $'make validate'
  $'tsc --noEmit'
  $'git diff -- src/app.ts'
  $'grep -rn foo src | head'
  $'cat package.json'
  $'echo hi > /dev/null'
  $'some_cmd 2>&1 | tail'
  $'sed \'s/a/b/\' f.py'
  $'ls -la 2>/dev/null'
  $'awk \'{print $1}\' f'
  $'grep x <<< "$var"'
  $'curl https://example.com'
  $'wget https://example.com'
  $'grep \'a > b\' file'
  $'echo "x >> y"'
  $'rg \'>>\' .'
  $'cp a b'
  $'mv a b'
  $'mkdir newdir'
  $'rm f'
  $'ln -s a b'
  $'git apply patch.diff'
  $'git add path/to/file'
  $'git commit -m "x"'

  # Regression: single-quoted $(...) is inert in bash (single quotes
  # suppress command substitution) — must stay ALLOW, unlike the
  # double-quoted/backtick/unquoted forms in the DENY table above.
  $'echo \'$(touch f)\''

  # --- Final fix pass: eval read-only + curl/wget download-flag scoping
  # (bounded, 2026-07-26) ----------------------------------------------------
  # `eval` unwrapping must not false-positive on a read-only inner command.
  $'eval "grep x file"'
  # curl/wget download-flag detection must be scoped to curl/wget's OWN
  # pipeline segment, not the whole command string — an unrelated downstream
  # `-o` (sort/grep/ls) must not be misattributed to an upstream curl/wget.
  $'curl https://example.com | sort -o f'
  $'curl https://example.com | grep -o r'
  $'ls -o f'
)

for cmd in "${ALLOW_CMDS[@]}"; do
  label="${cmd:0:60}"
  out=$(run_guard "Bash" "$cmd")
  if is_deny "$out"; then
    fail "ALLOW expected but DENIED: $label -> $out"
  else
    pass "ALLOW: $label"
  fi
done

# --- Committer real job stays functional (Phase 6) --------------------------
# Under the actual "committer" argv (how the Committer agent is wired per
# templates/agents/committer.template.md), git operations must stay ALLOWED —
# these are the Committer's core job, not write-primitives.
for cmd in 'git add path/to/file' 'git commit -m "x"'; do
  out=$(run_guard_agent "$cmd" "" committer)
  if is_deny "$out"; then
    fail "Committer (argv=committer) core git op wrongly DENIED: $cmd -> $out"
  else
    pass "Committer (argv=committer) core git op stays ALLOWED: $cmd"
  fi
done

# --- Malformed / defensive input --------------------------------------------
out=$(printf '%s' 'not valid json' | python3 "$GUARD")
if [[ -z "$out" ]]; then
  pass "Malformed JSON input -> allow (no output)"
else
  fail "Malformed JSON input should allow silently, got: $out"
fi

out=$(printf '%s' '{"tool_name":"Bash","tool_input":{}}' | python3 "$GUARD")
if [[ -z "$out" ]]; then
  pass "Missing tool_input.command -> allow (no output)"
else
  fail "Missing tool_input.command should allow silently, got: $out"
fi

# --- Agent-aware coaching message selection (Phase 5) ------------------------
# The deny/allow POLICY never changes with agent id — only the coaching
# `permissionDecisionReason` text does. Every case below uses the same DENY
# command (`touch x`) so only the message-selection mechanism is exercised.
DENY_CMD='touch x'
REVIEWER_SUBSTR='Do NOT attempt another write method'
COMMITTER_SUBSTR='Use the `Edit` tool'
DEFAULT_SUBSTR='Use your editing tool'
MATCHED_SUFFIX='Matched pattern:'

# argv "reviewer" -> Reviewer message.
out=$(run_guard_agent "$DENY_CMD" "" reviewer)
if [[ "$out" == *"$REVIEWER_SUBSTR"* && "$out" == *"$MATCHED_SUFFIX"* ]]; then
  pass "argv=reviewer -> Reviewer coaching message (with Matched pattern suffix)"
else
  fail "argv=reviewer should yield the Reviewer message, got: $out"
fi

# argv "committer" -> Committer message.
out=$(run_guard_agent "$DENY_CMD" "" committer)
if [[ "$out" == *"$COMMITTER_SUBSTR"* && "$out" == *"$MATCHED_SUFFIX"* ]]; then
  pass "argv=committer -> Committer coaching message (with Matched pattern suffix)"
else
  fail "argv=committer should yield the Committer message, got: $out"
fi

# stdin agent_type "Committer", NO argv -> Committer message (fallback path;
# also proves case-insensitivity via the mixed-case stdin value).
out=$(run_guard_agent "$DENY_CMD" "Committer")
if [[ "$out" == *"$COMMITTER_SUBSTR"* ]]; then
  pass "stdin agent_type=Committer, no argv -> Committer coaching message (fallback)"
else
  fail "stdin agent_type=Committer with no argv should yield the Committer message, got: $out"
fi

# stdin agent_type "Reviewer", NO argv -> Reviewer message (fallback path).
out=$(run_guard_agent "$DENY_CMD" "Reviewer")
if [[ "$out" == *"$REVIEWER_SUBSTR"* ]]; then
  pass "stdin agent_type=Reviewer, no argv -> Reviewer coaching message (fallback)"
else
  fail "stdin agent_type=Reviewer with no argv should yield the Reviewer message, got: $out"
fi

# Neither argv nor stdin agent_type -> default message.
out=$(run_guard_agent "$DENY_CMD" "")
if [[ "$out" == *"$DEFAULT_SUBSTR"* ]]; then
  pass "No agent id (argv or stdin) -> default coaching message"
else
  fail "No agent id should yield the default message, got: $out"
fi

# Unknown argv (e.g. builder, not yet wired to this guard) -> default message.
out=$(run_guard_agent "$DENY_CMD" "" builder)
if [[ "$out" == *"$DEFAULT_SUBSTR"* ]]; then
  pass "Unknown argv (builder) -> default coaching message"
else
  fail "Unknown argv (builder) should yield the default message, got: $out"
fi

# argv WINS when both argv and a DIFFERING stdin agent_type are present —
# proves argv precedence over the stdin fallback, not just presence/absence.
out=$(run_guard_agent "$DENY_CMD" "Reviewer" committer)
if [[ "$out" == *"$COMMITTER_SUBSTR"* && "$out" != *"$REVIEWER_SUBSTR"* ]]; then
  pass "argv=committer wins over conflicting stdin agent_type=Reviewer"
else
  fail "argv should win over a differing stdin agent_type, got: $out"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
