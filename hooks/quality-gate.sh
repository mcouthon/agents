#!/usr/bin/env python3
"""Stop hook: quality gate that prevents completion without validation.

Reads JSON from stdin (Stop event payload). Checks the session state file
(written by post-edit-validate.sh) to determine whether files were edited.
If edits happened, checks last_assistant_message for validation evidence
keywords. If no evidence found, denies stop with systemMessage (PAV-
structured tag-prefix format) telling the agent to run validation.

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
    message = (
        "[quality-gate:BLOCKED] Files were edited but no validation "
        "evidence found in the final message. Run 'make validate' or "
        "your project's test/lint/build commands and report the results "
        "before completing."
    )
    output = {"systemMessage": message}
    print(json.dumps(output))
    sys.exit(2)


if __name__ == "__main__":
    main()
