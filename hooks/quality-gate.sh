#!/usr/bin/env python3
"""Stop hook: quality gate that prevents completion without validation.

Reads JSON from stdin (Stop event payload). Checks the session state file
(written by post-edit-validate.sh) to determine whether files were edited.
If edits happened, checks last_assistant_message for validation evidence
keywords. If no evidence found, denies stop with systemMessage (PAV-
structured tag-prefix format) telling the agent to run validation.

Block-count tracking: increments block_count in the state file on each
block. After 2+ blocks, escalates the message. After 5 blocks, allows
stop as a safety valve to prevent infinite loops.

Writes the block message to both stdout (JSON systemMessage) and stderr
(so the hook runner does not report "No stderr output" on exit 2).

Uses systemMessage (NOT additionalContext) because systemMessage provides
continuation context when the hook blocks — the correct semantic for Stop
deny cases. PostToolUse uses additionalContext because it cannot block.
Blocking is via exit code 2 (with systemMessage in stdout), not
permissionDecision in JSON output.

Fails open: malformed input, missing state file, or no edits -> exit 0.
"""

import json
import os
import re
import sys


# Keywords that indicate the agent ran validation commands.
# Matched case-insensitively against last_assistant_message.
VALIDATION_KEYWORDS = [
    r"\bmake\b", r"\bmake\s+validate\b", r"\bmake\s+test\b",
    r"\bnpm\s+test\b", r"\bnpm\s+run\b",
    r"\bpytest\b", r"\bpython\s+-m\s+pytest\b",
    r"\btsc\b", r"\beslint\b", r"\bruff\b",
    r"\bmarkdownlint\b",
    r"\bPASS\b", r"\bFAIL\b", r"\bpassed\b", r"\bfailed\b",
    r"\blint\s+clean\b", r"\btypes\s+clean\b",
    r"\btests?\s+pass", r"\bno\s+errors?\b",
]

VALIDATION_RE = re.compile(
    "|".join(VALIDATION_KEYWORDS), re.IGNORECASE
)


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return  # Fail open on malformed input

    session_id = payload.get("session_id", "unknown")
    last_message = payload.get("last_assistant_message", "")

    # Read state file written by post-edit-validate.sh
    state_path = f"/tmp/cc-qg-{session_id}.json"
    if not os.path.exists(state_path):
        return  # No edits recorded — allow stop

    try:
        with open(state_path) as f:
            state = json.load(f)
    except (json.JSONDecodeError, IOError):
        return  # Can't read state — fail open

    if not state.get("edited", False):
        return  # No edits — allow stop

    # Check last_assistant_message for validation evidence
    if VALIDATION_RE.search(last_message):
        # Validation evidence found — allow stop and clean up state file
        try:
            os.unlink(state_path)
        except OSError:
            pass
        return

    # Edits happened but no validation evidence in final message — deny stop
    block_count = state.get("block_count", 0) + 1
    state["block_count"] = block_count
    try:
        with open(state_path, "w") as f:
            json.dump(state, f)
    except (IOError, OSError):
        pass  # Best-effort — block anyway

    # Safety valve: after 5 blocks, allow stop to prevent infinite loops
    if block_count >= 5:
        return

    if block_count >= 2:
        message = (
            f"[quality-gate:BLOCKED] (attempt {block_count}) You have "
            f"been blocked {block_count} times. Run `make validate` or "
            f"your project's test/lint/build commands NOW and paste the "
            f"actual output. Do not claim completion without showing "
            f"validation results."
        )
    else:
        message = (
            "[quality-gate:BLOCKED] Files were edited but no validation "
            "evidence found in the final message. Run 'make validate' or "
            "your project's test/lint/build commands and report the results "
            "before completing."
        )

    output = {"systemMessage": message}
    print(json.dumps(output))
    print(message, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
