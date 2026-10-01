#!/usr/bin/env bash
# Unit tests for hooks/write-guard.sh PreToolUse write-guard hook.
# Tests deny cases (write primitives) and allow cases (read-only commands).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$SCRIPT_DIR/../hooks/write-guard.sh"
pass_count=0
fail_count=0

# Helper: feed a command string to the guard and check exit code.
# Usage: run_guard <command_string> <expected_exit> [agent_arg]
run_guard() {
    local cmd="$1"
    local expected_exit="$2"
    local agent="${3:-explorer}"
    local payload
    payload=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
        "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
    echo "$payload" | python3 "$GUARD" "$agent" >/dev/null 2>&1
    local actual_exit=$?
    if [[ "$actual_exit" -eq "$expected_exit" ]]; then
        ((pass_count++))
    else
        ((fail_count++))
        echo "FAIL: cmd='$cmd' expected exit $expected_exit, got $actual_exit"
    fi
}

# --- DENY cases (exit 2) ---

# Output redirection
run_guard 'echo hello > file.txt' 2
run_guard 'echo hello >> file.txt' 2
run_guard 'printf "x" > file.txt' 2

# tee writing to a file
run_guard 'echo hello | tee file.txt' 2
run_guard 'echo hello | tee -a file.txt' 2

# In-place editing
run_guard 'sed -i "s/a/b/" file.txt' 2
run_guard 'sed -i.bak "s/a/b/" file.txt' 2
run_guard 'perl -i -pe "s/a/b/" file.txt' 2

# touch (creating files)
run_guard 'touch newfile.txt' 2

# dd of=
run_guard 'dd if=/dev/zero of=file.txt bs=1k count=1' 2

# File-writing heredocs
run_guard 'cat > file.txt <<EOF' 2
run_guard 'cat >> file.txt <<EOF' 2

# python -c / perl -e / node -e writes
run_guard "python3 -c \"open('f','w').write('x')\"" 2
run_guard "perl -e \"open(F, '>f'); close F\"" 2
run_guard "node -e \"require('fs').writeFileSync('f','x')\"" 2

# curl / wget download-to-file
run_guard 'curl -o file.txt https://example.com' 2
run_guard 'curl -sO https://example.com/file' 2
run_guard 'curl -Lo file.txt https://example.com' 2
run_guard 'wget -O file.txt https://example.com' 2

# In-place/interactive editors
run_guard 'vim file.txt' 2
run_guard 'nano file.txt' 2
run_guard 'vi file.txt' 2

# Wrapper unwrapping
run_guard 'bash -c "echo x > file.txt"' 2
run_guard 'sh -c "touch file.txt"' 2
run_guard 'eval "echo x > file.txt"' 2

# --- ALLOW cases (exit 0) ---

# Read-only git commands
run_guard 'git log --oneline -10' 0
run_guard 'git show HEAD' 0
run_guard 'git diff --stat' 0
run_guard 'git status' 0
run_guard 'git add file.txt' 0
run_guard 'git commit -m "test"' 0

# Read-only search commands
run_guard 'grep -rn "pattern" .' 0
run_guard 'rg "pattern" --files' 0

# Read-only file commands
run_guard 'ls -la' 0
run_guard 'cat file.txt' 0
run_guard 'head -20 file.txt' 0
run_guard 'tail -20 file.txt' 0
run_guard 'find . -name "*.ts"' 0
run_guard 'wc -l file.txt' 0
run_guard 'file test.txt' 0
run_guard 'stat file.txt' 0

# Pipes (read-only)
run_guard 'git log | head -10' 0
run_guard 'grep pattern file | wc -l' 0

# /dev/null redirects (stderr suppression — allowed per ADR-014)
run_guard 'echo hello 2>/dev/null' 0
run_guard 'git log 2>/dev/null' 0

# Quoted operators (not redirects)
run_guard "grep 'a > b' file.txt" 0
run_guard "echo 'the >> operator'" 0

# Here-strings (not file writes)
run_guard 'cat <<< "hello"' 0

# Plain echo (no redirect target)
run_guard 'echo "just printing"' 0
run_guard 'echo hello' 0

# --- Edge cases ---

# Non-Bash tool_name should allow (exit 0)
payload_test='{"tool_name":"Read","tool_input":{"command":"cat file"}}'
echo "$payload_test" | python3 "$GUARD" explorer >/dev/null 2>&1
if [[ $? -eq 0 ]]; then
    ((pass_count++))
else
    ((fail_count++))
    echo "FAIL: non-Bash tool_name should exit 0"
fi

# Malformed JSON should fail open (exit 0)
echo 'not valid json' | python3 "$GUARD" explorer >/dev/null 2>&1
if [[ $? -eq 0 ]]; then
    ((pass_count++))
else
    ((fail_count++))
    echo "FAIL: malformed JSON should exit 0"
fi

# Missing tool_input.command should fail open (exit 0)
echo '{"tool_name":"Bash","tool_input":{}}' | python3 "$GUARD" explorer >/dev/null 2>&1
if [[ $? -eq 0 ]]; then
    ((pass_count++))
else
    ((fail_count++))
    echo "FAIL: missing command should exit 0"
fi

echo ""
echo "write-guard tests: $pass_count passed, $fail_count failed"
[[ "$fail_count" -eq 0 ]] || exit 1
