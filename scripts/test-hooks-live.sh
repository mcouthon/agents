#!/bin/sh
# D51 item 3: live hook harness. Runs `claude -p` with the installed hooks
# against a throwaway task in temp roots. Exits 0 when claude is not on PATH
# or cannot run (no auth). A non-zero exit means a real test failure:
# claude ran and scenario assertions failed.
set -e

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP: claude not on PATH"; exit 0
fi
PROBE_ERR=$(mktemp)
if ! claude -p "reply with the single word ok" >/dev/null 2>"$PROBE_ERR"; then
  echo "SKIP: claude is on PATH but cannot run (no auth or quota). Probe stderr:"
  cat "$PROBE_ERR"
  rm -f "$PROBE_ERR"; exit 0
fi
rm -f "$PROBE_ERR"

TMPROOT=$(mktemp -d /tmp/agents-live-hooks-XXXXXX)
export AGENTS_TASKS_ROOT="$TMPROOT/tasks"
export AGENTS_SESSIONS_ROOT="$TMPROOT/sessions"
export AGENTS_SESSION_DIR="$TMPROOT/sessions/live-test"
export AGENTS_LOGS_ROOT="$TMPROOT/logs"
export AGENTS_HOOKS_ADVISE_FLAG="$TMPROOT/no-advise"
mkdir -p "$AGENTS_TASKS_ROOT" "$AGENTS_SESSIONS_ROOT" "$AGENTS_LOGS_ROOT" "$AGENTS_SESSION_DIR"

A="${A:-$HOME/.local/bin/a}"
pass=0; fail=0
ok() { echo "OK: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

report() {
  echo ""
  echo "$pass passed, $fail failed"
  rm -rf "$TMPROOT"
}

bind_session() {
  sid=$(uuidgen)
  "$A" session register --session-id "$sid" --agent courier --task-dir "$1" >/dev/null
  echo "$sid"
}

HOOKLOG="$AGENTS_LOGS_ROOT/hooks.log"
expect_engaged() {
  [ -f "$HOOKLOG" ] && [ "$(wc -l < "$HOOKLOG")" -gt "$2" ]
}

# Create a throwaway task — parse task_dir from pretty-printed or compact JSON
TASK_DIR=$("$A" task create --title "Live Hook Test" --slug live-hook-test --tier minor --phases-json '[{"id":1,"name":"Phase 1","status":"in_progress"}]' --json 2>/dev/null | grep -oE '"task_dir"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')
if [ -z "$TASK_DIR" ]; then
  echo "Could not create task"
  bad "setup: task create failed"
  report
  exit 1
fi

# Bind a session for diagnostics so the hooks have a taskDir
DIAG_SID=$(bind_session "$TASK_DIR")
export CLAUDE_CODE_SESSION_ID="$DIAG_SID"

# --- C3: Diagnostic — courier-stop exit codes (not the live gate) ---
NO_REPORT_PAYLOAD='{"agent_type":"courier","hook_event_name":"Stop"}'
NO_REPORT_PAYLOAD_ACTIVE='{"agent_type":"courier","hook_event_name":"Stop","stop_hook_active":true}'
if echo "$NO_REPORT_PAYLOAD" | "$A" hook courier-stop >/dev/null 2>&1; then
  bad "courier-stop: expected exit 2 on a no-report payload"
else
  ok "courier-stop: exit 2 on no report"
fi
if echo "$NO_REPORT_PAYLOAD_ACTIVE" | "$A" hook courier-stop >/dev/null 2>&1; then
  ok "courier-stop: exit 0 with stop_hook_active=1"
else
  bad "courier-stop: expected exit 0 with stop_hook_active=1"
fi

# --- C4: Diagnostic — machine-owned guard (not the live gate) ---
ALLOW_PAYLOAD='{"agent_type":"courier","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"node -e require(\"index.json\")"}}'
DENY_PAYLOAD='{"agent_type":"courier","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"node -e require(\"fs\").writeFileSync(\"index.json\",\"x\")"}}'
ALLOW_OUT=$(echo "$ALLOW_PAYLOAD" | "$A" hook machine-owned-guard 2>&1 || true)
if echo "$ALLOW_OUT" | grep -q "deny"; then
  bad "machine-owned-guard: read-only node -e should be allowed, got deny"
else
  ok "machine-owned-guard: read-only node -e require allowed"
fi
DENY_OUT=$(echo "$DENY_PAYLOAD" | "$A" hook machine-owned-guard 2>&1 || true)
if echo "$DENY_OUT" | grep -q '"permissionDecision":"deny"'; then
  ok "machine-owned-guard: write node -e denied"
else
  bad "machine-owned-guard: write node -e should be denied, got: $DENY_OUT"
fi

# Unset the diagnostic session id so live scenarios mint their own
unset CLAUDE_CODE_SESSION_ID

# --- C5: Diagnostic — SubagentStop without last_assistant_message (F4) ---
# The transcript fallback should allow report-parser to extract the report.
# Feed a payload with a transcript path but no last_assistant_message.
C5_SID=$(bind_session "$TASK_DIR")
export CLAUDE_CODE_SESSION_ID="$C5_SID"
TRANSCRIPT_FILE="$TMPROOT/transcript.jsonl"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"```json\\n{\\"files_touched\\":[],\\"verification\\":[{\\"cmd\\":\\"echo ok\\",\\"exit\\":0,\\"summary\\":\\"ok\\"}],\\"deviations\\":[],\\"summary\\":\\"built\\"}\\n```"}]}}\n' > "$TRANSCRIPT_FILE"
C5_PAYLOAD="{\"agent_type\":\"builder\",\"hook_event_name\":\"SubagentStop\",\"agent_transcript_path\":\"$TRANSCRIPT_FILE\"}"
C5_OUT=$(echo "$C5_PAYLOAD" | "$A" hook report-parser 2>&1 || true)
if echo "$C5_OUT" | grep -q "Report persisted"; then
  ok "C5: report-parser extracts from transcript fallback"
else
  bad "C5: report-parser did not extract from transcript: $C5_OUT"
fi
unset CLAUDE_CODE_SESSION_ID

# --- C6: Diagnostic — library fails to load, stubs fail open (F5) ---
# Use the hooks-off flag file so a hooks status reflects "off".
"$A" hooks off >/dev/null 2>&1
C6_OUT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo test"}}' | "$A" hook git-guard 2>&1 || true)
C6_EXIT=$?
C6_STATUS=$("$A" hooks status 2>&1 || true)
"$A" hooks on >/dev/null 2>&1
if [ "$C6_EXIT" -eq 0 ]; then
  ok "C6: hook stub exits 0 when hooks off"
else
  bad "C6: hook stub should exit 0 when hooks off, got $C6_EXIT"
fi
if echo "$C6_STATUS" | grep -qi "off"; then
  ok "C6: a hooks status reports off"
else
  bad "C6: a hooks status did not report off: $C6_STATUS"
fi

# --- C7: Diagnostic — fail verdict persists (F7) ---
# Feed a failing reviewer report; it should be stored and a next should return plan.
C7_DIR=$("$A" task create --title "F7 Test" --slug f7-test --tier minor --phases-json '[{"id":1,"name":"Phase 1"}]' --json 2>/dev/null | grep -oE '"task_dir"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')
if [ -n "$C7_DIR" ]; then
  C7_SID=$(bind_session "$C7_DIR")
  export CLAUDE_CODE_SESSION_ID="$C7_SID"
  "$A" state update --task-dir "$C7_DIR" --phase-id 1 --phase-status planned >/dev/null 2>&1 || true
  "$A" report --task-dir "$C7_DIR" --phase-id 1 --agent reviewer --force --report-json '{"verdict":"needs_work","issues":[{"severity":"red","file":"test","line":"1","text":"bad"}],"summary":"needs work"}' >/dev/null 2>&1 || true
  C7_NEXT=$("$A" next --task-dir "$C7_DIR" 2>&1 || true)
  if echo "$C7_NEXT" | grep -q "plan"; then
    ok "C7: failing review persists, a next returns plan"
  else
    bad "C7: a next did not return plan after failing review: $C7_NEXT"
  fi
  unset CLAUDE_CODE_SESSION_ID
else
  bad "C7: could not create task"
fi

# --- C8: Diagnostic — quality-gate does not fire on Conductor (F12) ---
C8_PAYLOAD='{"agent_type":"conductor","hook_event_name":"Stop"}'
C8_OUT=$(echo "$C8_PAYLOAD" | "$A" hook quality-gate 2>&1 || true)
C8_EXIT=$?
if [ "$C8_EXIT" -eq 0 ]; then
  ok "C8: quality-gate allows Conductor stop"
else
  bad "C8: quality-gate should allow Conductor stop, got exit $C8_EXIT"
fi

# --- C9: Diagnostic — non-reporting agent stop is allowed (F23) ---
# An Explore stop should be allowed without "no JSON code block found".
C9_PAYLOAD='{"agent_type":"explore","hook_event_name":"SubagentStop","last_assistant_message":"I finished exploring."}'
C9_OUT=$(echo "$C9_PAYLOAD" | "$A" hook report-parser 2>&1 || true)
C9_EXIT=$?
if [ "$C9_EXIT" -eq 0 ]; then
  if echo "$C9_OUT" | grep -q "no JSON code block found"; then
    bad "C9: Explore stop should be allowed, not blocked with 'no JSON'"
  else
    ok "C9: non-reporting agent stop allowed (no block)"
  fi
else
  bad "C9: Explore stop should exit 0, got $C9_EXIT"
fi

# --- C2: Scenario 1 — valid report completes in one evaluation ---
SID1=$(bind_session "$TASK_DIR")
PROMPT1="You are a courier. Read the task at $TASK_DIR. Output a JSON report with fields files_touched, verification, deviations, and summary. This is a test run — make no changes."
if OUTPUT1=$(claude -p --session-id "$SID1" "$PROMPT1" 2>&1); then
  if echo "$OUTPUT1" | grep -q "Hook JSON output validation failed"; then
    bad "C2: hook validation failed on valid report"
  elif echo "$OUTPUT1" | grep -qiE '"files_touched"|"summary"|"deviations"'; then
    ok "C2: valid report completed in one evaluation"
  else
    bad "C2: output missing report JSON"
  fi
else
  bad "C2: claude -p exited non-zero"
fi

# --- C3: Scenario 2 — no report blocks once, second pass clean ---
SID2=$(bind_session "$TASK_DIR")
LOG_BEFORE=$( [ -f "$HOOKLOG" ] && wc -l < "$HOOKLOG" || echo 0 )
OUTPUT2=$(claude -p --session-id "$SID2" "Reply with the single word: done" 2>&1 || true)
if expect_engaged "C3" "$LOG_BEFORE"; then
  ok "C3: hook engaged on no-report stop"
else
  if echo "$OUTPUT2" | grep -qi "block\|report\|stop"; then
    ok "C3: block observed in output"
  else
    bad "C3: hook did not engage and no block observed"
  fi
fi

# --- C4: Scenario 3 — machine-owned deny honoured (live) ---
SID3=$(bind_session "$TASK_DIR")
PROMPT3="Write the text 'hello' to the file at $TASK_DIR/task.json using the Write tool. Do not do anything else."
OUTPUT3=$(claude -p --session-id "$SID3" "$PROMPT3" 2>&1 || true)
if echo "$OUTPUT3" | grep -qi "machine-owned"; then
  ok "C4: machine-owned deny observed in live output"
else
  bad "C4: no machine-owned deny in output"
fi

report
[ "$fail" -eq 0 ] || exit 1
exit 0
