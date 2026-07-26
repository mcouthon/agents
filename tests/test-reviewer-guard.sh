#!/bin/zsh
# Unit tests for hooks/reviewer-write-guard.sh — the Reviewer-scoped
# PreToolUse Bash write-guard (task 100-reviewer-write-lockdown, Phase 2).
#
# Validates the unwrap-then-scan design (quote-aware top-level scan +
# recursive wrapper unwrap), NOT raw-scan: the ALLOW table below includes
# quoted-operator vectors (e.g. `grep 'a > b' file`) that a naive raw-scan
# would incorrectly deny.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/hooks/reviewer-write-guard.sh"
PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "✗ $1"; FAIL=$((FAIL + 1)); }

echo "Testing Reviewer write-guard hook..."
cd "$SCRIPT_DIR"

# Build a PreToolUse JSON payload and feed it to the guard.
# $1 = tool_name (e.g. "Bash" or "runTerminalCommand"), $2 = command string.
run_guard() {
  python3 -c 'import json,sys; print(json.dumps({"tool_name": sys.argv[1], "tool_input": {"command": sys.argv[2]}}))' "$1" "$2" | python3 "$GUARD"
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

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
