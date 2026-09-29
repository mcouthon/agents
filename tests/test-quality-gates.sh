#!/bin/zsh
# Unit tests for Phase 1 quality gate hooks:
#   hooks/post-edit-validate.sh  (PostToolUse)
#   hooks/quality-gate.sh        (Stop)
#   hooks/model-switch-logger.sh  (PreModelSwitch)
#   hooks/subagent-validate.sh   (SubagentStop)
#
# Validates: exit code 0 on allow/fail-open, exit code 2 on deny (Stop/
# SubagentStop), flat JSON systemMessage in stdout on deny (not
# hookSpecificOutput, not permissionDecision), additionalContext on
# PostToolUse fail, PAV tag-prefix format, and correct state-file
# behavior for the PostToolUse -> Stop chain.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
STATE_DIR="/tmp"

pass() { echo "OK $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

echo "Testing Phase 1 quality gate hooks..."
cd "$SCRIPT_DIR"

# --- post-edit-validate.sh (PostToolUse) -----------------------------------

PEV="$SCRIPT_DIR/hooks/post-edit-validate.sh"

# Valid input, .py file — writes state file, runs py_compile, no output
echo 'x = 1' > /tmp/cc-test-valid.py
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-1","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-valid.py"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PostToolUse: valid .py file -> exit 0, no output (validation passed)"
else
  fail "PostToolUse: valid .py file should exit 0 with no output, got exit=$exit_code out=$out"
fi

# Check state file was written with quality_gate status
if [[ -f "/tmp/cc-qg-test-pev-1.json" ]]; then
  state=$(cat /tmp/cc-qg-test-pev-1.json)
  if [[ "$state" == *'"quality_gate"'* && "$state" == *'"pass"'* ]]; then
    pass "PostToolUse: state file written with quality_gate pass status"
  else
    fail "PostToolUse: state file missing quality_gate pass, got: $state"
  fi
else
  fail "PostToolUse: state file not created"
fi
rm -f /tmp/cc-qg-test-pev-1.json

# Invalid .py file — should return additionalContext with PAV tag prefix
echo 'def broken(' > /tmp/cc-test-broken.py
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-2","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-broken.py"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && "$out" == *'"additionalContext"'* && "$out" == *'[quality-gate:FAIL]'* ]]; then
  pass "PostToolUse: invalid .py file -> exit 0, additionalContext with [quality-gate:FAIL] tag"
else
  fail "PostToolUse: invalid .py file should exit 0 with additionalContext+tag, got exit=$exit_code out=$out"
fi
# Check state file has fail status
if [[ -f "/tmp/cc-qg-test-pev-2.json" ]]; then
  state=$(cat /tmp/cc-qg-test-pev-2.json)
  if [[ "$state" == *'"fail"'* ]]; then
    pass "PostToolUse: state file written with quality_gate fail status"
  else
    fail "PostToolUse: state file missing fail status, got: $state"
  fi
fi
rm -f /tmp/cc-test-broken.py /tmp/cc-qg-test-pev-2.json

# Malformed input — fail open (exit 0, no output)
out=$(printf '%s' 'not valid json' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PostToolUse: malformed JSON -> exit 0, fail open (no output)"
else
  fail "PostToolUse: malformed JSON should exit 0 with no output, got exit=$exit_code out=$out"
fi

# Missing file_path — fail open
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-pev-3","tool_name":"Edit","tool_input":{}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PostToolUse: missing file_path -> exit 0, fail open"
else
  fail "PostToolUse: missing file_path should exit 0 and fail open, got exit=$exit_code out=$out"
fi

# Unknown extension — fail open (no validator)
echo 'hello' > /tmp/cc-test.xyz
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-4","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test.xyz"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PostToolUse: unknown extension -> exit 0, fail open (no validator)"
else
  fail "PostToolUse: unknown extension should exit 0 and fail open, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test.xyz /tmp/cc-qg-test-pev-4.json

# Transient-leak check: .py file carrying all four patterns -> flagged,
# non-blocking (exit 0), state records fail + transient-leak
echo '# Task 114 phase-2 workaround, see .tasks/114-agent-output-quality and ADR-007' > /tmp/cc-test-leak.py
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-5","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-leak.py"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && "$out" == *'"additionalContext"'* && "$out" == *'[quality-gate:FAIL] validator=transient-leak'* ]]; then
  pass "PostToolUse: transient-leak .py -> exit 0, additionalContext with [quality-gate:FAIL] validator=transient-leak"
else
  fail "PostToolUse: transient-leak .py should exit 0 with transient-leak additionalContext, got exit=$exit_code out=$out"
fi
if [[ -f "/tmp/cc-qg-test-pev-5.json" ]]; then
  state=$(cat /tmp/cc-qg-test-pev-5.json)
  if [[ "$state" == *'"fail"'* && "$state" == *'"transient-leak"'* ]]; then
    pass "PostToolUse: transient-leak state file records fail + transient-leak"
  else
    fail "PostToolUse: transient-leak state missing fail/transient-leak, got: $state"
  fi
else
  fail "PostToolUse: transient-leak state file not created"
fi
rm -f /tmp/cc-test-leak.py /tmp/cc-qg-test-pev-5.json

# Near-miss words (lowercase task_, bare numbers) do not trip the check
echo 'task_count = 3  # tasks queued' > /tmp/cc-test-noleak.py
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-6","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-noleak.py"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PostToolUse: near-miss .py -> exit 0, silent (patterns are narrow)"
else
  fail "PostToolUse: near-miss .py should be silent, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test-noleak.py /tmp/cc-qg-test-pev-6.json

# .go has no syntax validator — the transient check must still run
echo '// phase-2 of Task 114: see .tasks/114-agent-output-quality' > /tmp/cc-test-leak.go
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-7","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-leak.go"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && "$out" == *'[quality-gate:FAIL] validator=transient-leak'* ]]; then
  pass "PostToolUse: transient-leak .go (no syntax validator) still flagged"
else
  fail "PostToolUse: .go leak should flag transient-leak, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test-leak.go /tmp/cc-qg-test-pev-7.json

# Clean .go -> exit 0, silent, state still records the edit
echo 'package main' > /tmp/cc-test-clean.go
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-8","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-clean.go"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" && -f "/tmp/cc-qg-test-pev-8.json" ]]; then
  pass "PostToolUse: clean .go -> exit 0, silent, state written"
else
  fail "PostToolUse: clean .go should be silent with state written, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test-clean.go /tmp/cc-qg-test-pev-8.json

# Markdown is excluded from the transient check (validator noise may still
# appear — environment-dependent — but never transient-leak)
echo 'See .tasks/114-agent-output-quality phase-2 (Task 114, ADR-007)' > /tmp/cc-test-leak.md
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-9","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-leak.md"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && "$out" != *'transient-leak'* ]]; then
  pass "PostToolUse: .md excluded from transient check"
else
  fail "PostToolUse: .md must not produce transient-leak, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test-leak.md /tmp/cc-qg-test-pev-9.json

# Files under .tasks/ are exempt (scratch plans legitimately reference
# task/phase vocabulary) — use a .py path to prove the path guard, not the
# extension guard, is what exempts it
mkdir -p /tmp/cc-tasks-dir/.tasks/114-x
echo '# Task 114 phase-2 scratch' > /tmp/cc-tasks-dir/.tasks/114-x/scratch.py
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-10","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-tasks-dir/.tasks/114-x/scratch.py"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && "$out" != *'transient-leak'* ]]; then
  pass "PostToolUse: files under .tasks/ exempt from transient check"
else
  fail "PostToolUse: .tasks/ path should be exempt, got exit=$exit_code out=$out"
fi
rm -rf /tmp/cc-tasks-dir /tmp/cc-qg-test-pev-10.json

# Missing wrapped binary (npx installed, markdownlint-cli not) must fail
# open: the npm error never reaches additionalContext. Deterministic in all
# three environments: binary missing -> fail-open silence; installed and
# clean -> silence; installed and dirty -> real lint output, which never
# contains the npm string.
echo '## Heading' > /tmp/cc-test-mdopen.md
out=$(python3 -c 'import json,sys; print(json.dumps({"session_id":"test-pev-11","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-test-mdopen.md"}}))' | python3 "$PEV")
exit_code=$?
if [[ $exit_code -eq 0 && ( -z "$out" || "$out" != *'could not determine executable to run'* ) ]]; then
  pass "PostToolUse: missing wrapped validator binary fails open (no npx noise)"
else
  fail "PostToolUse: npx missing-binary noise leaked into additionalContext, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-test-mdopen.md /tmp/cc-qg-test-pev-11.json

# --- quality-gate.sh (Stop) ------------------------------------------------

QG="$SCRIPT_DIR/hooks/quality-gate.sh"

# No state file — allow stop (exit 0, no edits)
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-qg-1","last_assistant_message":"Done"}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "Stop: no state file -> exit 0, allow stop (no edits)"
else
  fail "Stop: no state file should exit 0 and allow stop, got exit=$exit_code out=$out"
fi

# State file with edited=true, no validation keywords -> deny (exit 2) with systemMessage
echo '{"edited": true, "files": ["/tmp/test.ts"]}' > /tmp/cc-qg-test-qg-2.json
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-qg-2","last_assistant_message":"I am done with the changes."}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 2 && "$out" == *'"systemMessage"'* && "$out" == *'[quality-gate:BLOCKED]'* ]]; then
  pass "Stop: edits without validation -> exit 2, systemMessage + [quality-gate:BLOCKED] tag"
else
  fail "Stop: edits without validation should exit 2 with systemMessage, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-qg-test-qg-2.json

# State file with edited=true, validation keywords present -> allow (exit 0)
echo '{"edited": true, "files": ["/tmp/test.ts"]}' > /tmp/cc-qg-test-qg-3.json
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-qg-3","last_assistant_message":"Tests PASS, lint clean, make validate passed."}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "Stop: edits with validation evidence -> exit 0, allow stop"
else
  fail "Stop: edits with validation evidence should exit 0 and allow, got exit=$exit_code out=$out"
fi
# State file should be cleaned up on allow
if [[ ! -f "/tmp/cc-qg-test-qg-3.json" ]]; then
  pass "Stop: state file cleaned up on allow"
else
  fail "Stop: state file should be cleaned up on allow"
fi

# State file with edited=false -> allow stop (exit 0)
echo '{"edited": false, "files": []}' > /tmp/cc-qg-test-qg-4.json
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-qg-4","last_assistant_message":"Done."}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "Stop: edited=false -> exit 0, allow stop"
else
  fail "Stop: edited=false should exit 0 and allow, got exit=$exit_code out=$out"
fi
rm -f /tmp/cc-qg-test-qg-4.json

# Malformed input -> fail open (exit 0)
out=$(printf '%s' 'not json' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "Stop: malformed JSON -> exit 0, fail open"
else
  fail "Stop: malformed JSON should exit 0 and fail open, got exit=$exit_code out=$out"
fi

# --- model-switch-logger.sh (PreModelSwitch) -------------------------------

MSL="$SCRIPT_DIR/hooks/model-switch-logger.sh"

# Valid input — logs to stderr, no stdout (no switch_reason in payload)
err=$(python3 -c 'import json; print(json.dumps({"from_model":"sonnet","to_model":"opus"}))' | python3 "$MSL" 2>&1 >/dev/null)
if [[ "$err" == *"[model-switch]"* && "$err" == *"sonnet -> opus"* ]]; then
  pass "PreModelSwitch: logs model switch to stderr (no switch_reason)"
else
  fail "PreModelSwitch: should log to stderr, got: $err"
fi

# Stdout should be empty, exit 0 (no JSON output — always allow)
out=$(python3 -c 'import json; print(json.dumps({"from_model":"sonnet","to_model":"opus"}))' | python3 "$MSL" 2>/dev/null)
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PreModelSwitch: exit 0, no stdout (always allow)"
else
  fail "PreModelSwitch: should exit 0 with no stdout, got exit=$exit_code out=$out"
fi

# Malformed input -> fail open (exit 0)
out=$(printf '%s' 'not json' | python3 "$MSL" 2>/dev/null)
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "PreModelSwitch: malformed JSON -> exit 0, fail open"
else
  fail "PreModelSwitch: malformed JSON should exit 0 and fail open, got exit=$exit_code out=$out"
fi

# --- subagent-validate.sh (SubagentStop) -----------------------------------

SV="$SCRIPT_DIR/hooks/subagent-validate.sh"

# Empty message -> deny (exit 2) with systemMessage + PAV tag
out=$(python3 -c 'import json; print(json.dumps({"agent_type":"Builder","last_assistant_message":""}))' | python3 "$SV")
exit_code=$?
if [[ $exit_code -eq 2 && "$out" == *'"systemMessage"'* && "$out" == *'[subagent-validate:BLOCKED]'* ]]; then
  pass "SubagentStop: empty message -> exit 2, systemMessage + [subagent-validate:BLOCKED] tag"
else
  fail "SubagentStop: empty message should exit 2 with systemMessage, got exit=$exit_code out=$out"
fi

# Very short message -> deny (exit 2) with systemMessage
out=$(python3 -c 'import json; print(json.dumps({"agent_type":"Builder","last_assistant_message":"Done."}))' | python3 "$SV")
exit_code=$?
if [[ $exit_code -eq 2 && "$out" == *'"systemMessage"'* ]]; then
  pass "SubagentStop: very short message -> exit 2, systemMessage"
else
  fail "SubagentStop: very short message should exit 2 with systemMessage, got exit=$exit_code out=$out"
fi

# Adequate message -> allow (exit 0, no systemMessage)
out=$(python3 -c 'import json; print(json.dumps({"agent_type":"Builder","last_assistant_message":"I implemented the changes. Created the new file and updated the existing module. All tests pass."}))' | python3 "$SV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "SubagentStop: adequate message -> exit 0, allow"
else
  fail "SubagentStop: adequate message should exit 0 with no output, got exit=$exit_code out=$out"
fi

# Malformed input -> fail open (exit 0)
out=$(printf '%s' 'not json' | python3 "$SV")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "SubagentStop: malformed JSON -> exit 0, fail open"
else
  fail "SubagentStop: malformed JSON should exit 0 and fail open, got exit=$exit_code out=$out"
fi

# --- PostToolUse -> Stop integration (state file chain) --------------------

# Simulate the full chain: edit -> validate -> stop
echo 'x = 1' > /tmp/cc-chain-test.py
# Step 1: PostToolUse fires on edit
python3 -c 'import json,sys; print(json.dumps({"session_id":"test-chain-1","tool_name":"Edit","tool_input":{"file_path":"/tmp/cc-chain-test.py"}}))' | python3 "$PEV" > /dev/null

# Step 2: Stop fires with no validation evidence -> deny (exit 2) with systemMessage
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-chain-1","last_assistant_message":"I made the changes."}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 2 && "$out" == *'"systemMessage"'* ]]; then
  pass "Chain: edit -> stop without validation -> exit 2, systemMessage"
else
  fail "Chain: edit -> stop without validation should exit 2 with systemMessage, got exit=$exit_code out=$out"
fi

# Step 3: Stop fires with validation evidence -> allow (exit 0)
out=$(python3 -c 'import json; print(json.dumps({"session_id":"test-chain-1","last_assistant_message":"Implementation complete. Tests PASS, make validate passed."}))' | python3 "$QG")
exit_code=$?
if [[ $exit_code -eq 0 && -z "$out" ]]; then
  pass "Chain: edit -> stop with validation -> exit 0, allow"
else
  fail "Chain: edit -> stop with validation should exit 0 and allow, got exit=$exit_code out=$out"
fi

# Cleanup
rm -f /tmp/cc-chain-test.py /tmp/cc-qg-test-chain-1.json /tmp/cc-test-valid.py

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
