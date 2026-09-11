#!/usr/bin/env python3
"""SubagentStop hook: validates that subagents returned meaningful output.

Reads JSON from stdin (SubagentStop event payload). Checks that
last_assistant_message is non-empty and has a minimum length (indicating
the subagent produced structured output, not a truncated/empty response).

If output is empty or too short, denies stop with systemMessage (PAV-
structured tag-prefix format) telling the subagent to provide complete
output. The subagent continues execution and can retry.

Uses systemMessage (flat JSON, not wrapped in hookSpecificOutput) because
systemMessage provides continuation context when the hook blocks — the
correct semantic for SubagentStop deny cases. PostToolUse uses
additionalContext because it cannot block. SubagentStop supports both
fields; systemMessage is the right choice, not the only one. Blocking is
via exit code 2 (with systemMessage in stdout), not permissionDecision.

Fails open on malformed input.
"""

import json
import sys

MIN_MESSAGE_LENGTH = 50  # Bytes — below this, output is likely truncated


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return  # Fail open on malformed input

    last_message = payload.get("last_assistant_message", "")
    agent_type = payload.get("agent_type", "unknown")

    if not last_message or not last_message.strip():
        message = (
            f"[subagent-validate:BLOCKED] Subagent ({agent_type}) returned "
            f"empty output. Provide a complete summary of your work "
            f"before stopping."
        )
        output = {"systemMessage": message}
        print(json.dumps(output))
        sys.exit(2)

    if len(last_message.strip()) < MIN_MESSAGE_LENGTH:
        message = (
            f"[subagent-validate:BLOCKED] Subagent ({agent_type}) returned "
            f"very short output ({len(last_message.strip())} chars). This "
            f"may indicate truncation. Provide a complete summary of your "
            f"work, including what you did and what you found, before "
            f"stopping."
        )
        output = {"systemMessage": message}
        print(json.dumps(output))
        sys.exit(2)

    # Output looks sufficient — allow stop
    # (exit 0 with no stdout = allow)


if __name__ == "__main__":
    main()
