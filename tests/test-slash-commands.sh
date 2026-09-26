#!/bin/zsh
# Tests for Phase 2 slash command skills.
# Verifies: generated SKILL.md files exist, frontmatter is correct,
# dynamic context injection commands are present, access control fields
# are present, allowed-tools match expected set.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "OK $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

echo "Testing Phase 2 slash command skills..."
cd "$SCRIPT_DIR"

GEN_SKILLS="$SCRIPT_DIR/generated/claude/skills"

# --- File existence --------------------------------------------------------

for skill in plan-phase build-phase ship session-checkpoint; do
  if [[ -f "$GEN_SKILLS/$skill/SKILL.md" ]]; then
    pass "Generated skill exists: $skill"
  else
    fail "Generated skill missing: $skill/SKILL.md"
  fi
done

# --- plan-phase frontmatter ------------------------------------------------

PP="$GEN_SKILLS/plan-phase/SKILL.md"
if grep -q 'name: plan-phase' "$PP"; then
  pass "plan-phase: name field present"
else
  fail "plan-phase: name field missing"
fi

if grep -q 'arguments:' "$PP"; then
  pass "plan-phase: arguments field present"
else
  fail "plan-phase: arguments field missing"
fi

if grep -q 'allowed-tools:' "$PP"; then
  pass "plan-phase: allowed-tools field present"
else
  fail "plan-phase: allowed-tools field missing"
fi

# Dynamic context injection (jq command with state.json)
if grep -q 'state.json' "$PP" && grep -q 'not_started' "$PP"; then
  pass "plan-phase: dynamic context injection references state.json + not_started"
else
  fail "plan-phase: dynamic context injection missing state.json or not_started reference"
fi

# --- build-phase frontmatter -----------------------------------------------

BP="$GEN_SKILLS/build-phase/SKILL.md"
if grep -q 'name: build-phase' "$BP"; then
  pass "build-phase: name field present"
else
  fail "build-phase: name field missing"
fi

if grep -q 'arguments:' "$BP" && grep -q 'phase_number' "$BP"; then
  pass "build-phase: arguments field with phase_number present"
else
  fail "build-phase: arguments field or phase_number missing"
fi

if grep -q 'Task(Builder)' "$BP"; then
  pass "build-phase: Task(Builder) in allowed-tools"
else
  fail "build-phase: Task(Builder) missing from allowed-tools"
fi

# Dynamic context injection
if grep -q 'state.json' "$BP" && grep -q 'phase_number' "$BP"; then
  pass "build-phase: dynamic context injection references state.json + phase_number"
else
  fail "build-phase: dynamic context injection missing state.json or phase_number"
fi

# Quality gate reference (Phase 1 integration)
if grep -q 'quality' "$BP" || grep -q 'PostToolUse' "$BP"; then
  pass "build-phase: references Phase 1 quality gates"
else
  fail "build-phase: no reference to Phase 1 quality gates"
fi

# --- ship frontmatter ------------------------------------------------------

SH="$GEN_SKILLS/ship/SKILL.md"
if grep -q 'name: ship' "$SH"; then
  pass "ship: name field present"
else
  fail "ship: name field missing"
fi

if grep -q 'disable-model-invocation: true' "$SH"; then
  pass "ship: disable-model-invocation present (user-triggered only)"
else
  fail "ship: disable-model-invocation missing"
fi

if grep -q 'Task(Committer)' "$SH"; then
  pass "ship: Task(Committer) in allowed-tools"
else
  fail "ship: Task(Committer) missing from allowed-tools"
fi

# Dynamic context injection (git status + state.json)
if grep -q 'git status' "$SH"; then
  pass "ship: dynamic context injection includes git status"
else
  fail "ship: dynamic context injection missing git status"
fi

if grep -q 'in_progress' "$SH"; then
  pass "ship: dynamic context injection checks in_progress phase"
else
  fail "ship: dynamic context injection missing in_progress check"
fi

# --- session-checkpoint frontmatter ---------------------------------------

SC="$GEN_SKILLS/session-checkpoint/SKILL.md"
if grep -q 'name: session-checkpoint' "$SC"; then
  pass "session-checkpoint: name field present"
else
  fail "session-checkpoint: name field missing"
fi

if grep -q 'allowed-tools:' "$SC" && grep -q 'Read' "$SC"; then
  pass "session-checkpoint: allowed-tools with Read present"
else
  fail "session-checkpoint: allowed-tools or Read missing"
fi

# Dynamic context injection (session prime format)
if grep -q 'state.json' "$SC" && grep -q 'Phases:' "$SC"; then
  pass "session-checkpoint: dynamic context injection includes session prime"
else
  fail "session-checkpoint: dynamic context injection missing session prime"
fi

# Read-only (no Edit, Write, Bash in allowed-tools)
if ! grep -q 'Edit\|Write\|Bash' <(grep 'allowed-tools:' "$SC"); then
  pass "session-checkpoint: read-only (no Edit/Write/Bash in allowed-tools)"
else
  fail "session-checkpoint: allowed-tools should be read-only (no Edit/Write/Bash)"
fi

# --- No disable-model-invocation on non-ship commands ----------------------

for skill_file in "$PP" "$BP" "$SC"; do
  skill_name=$(grep 'name:' "$skill_file" | head -1 | awk '{print $2}')
  if grep -q 'disable-model-invocation' "$skill_file"; then
    fail "$skill_name: should NOT have disable-model-invocation (only ship does)"
  else
    pass "$skill_name: correctly lacks disable-model-invocation"
  fi
done

# --- install.sh check_generated_files includes new skills ------------------

INSTALL="$SCRIPT_DIR/install.sh"
for skill in plan-phase build-phase ship session-checkpoint; do
  if grep -q "$skill" "$INSTALL"; then
    pass "install.sh: check_generated_files includes $skill"
  else
    fail "install.sh: check_generated_files missing $skill"
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All tests passed!"
