#!/usr/bin/env python3
"""PreModelSwitch hook: logs model switches to stderr.

Reads JSON from stdin (PreModelSwitch event payload). Logs the model
change to stderr with timestamp. Always exits 0 (annotate, never block).

Note: PreModelSwitch stdin does NOT include a switch_reason field.
Only from_model and to_model are available.

Fails open on malformed input.
"""

import json
import sys
import time


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return  # Fail open on malformed input

    from_model = payload.get("from_model", "unknown")
    to_model = payload.get("to_model", "unknown")
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S")

    sys.stderr.write(
        f"[model-switch] {from_model} -> {to_model} at {timestamp}\n"
    )


if __name__ == "__main__":
    main()
