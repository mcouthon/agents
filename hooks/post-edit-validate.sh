#!/usr/bin/env python3
"""PostToolUse hook: validates the file that was just edited/written.

Reads JSON from stdin (PostToolUse event payload). Determines the file
type from the extension and runs the appropriate validator. If validation
fails, returns additionalContext with a PAV-structured tag-prefix format
so PAV's transcript renderer (257 Phase 8) can parse it as a quality-gate
indicator. Also writes a session-scoped state file recording the edit
and quality-gate status, which the Stop hook (quality-gate.sh) reads.

Output format (PAV-parseable):
  [quality-gate:FAIL] validator=py_compile file=src/app.py
  <error output>

Fails open: malformed input, missing file path, or validator not
installed -> exit 0 silently (no context pollution, no blocked edit).

State file: /tmp/cc-qg-${session_id}.json
Format: {"edited": true, "files": ["/path"], "last_edit_ts": ...,
         "quality_gate": {"status": "fail", "validator": "...", "file": "..."}}
"""

import json
import os
import subprocess
import sys
import time


def get_validator(file_path):
    """Return (command, args) for the appropriate validator, or None."""
    ext = os.path.splitext(file_path)[1].lower()
    validators = {
        ".ts": ("npx", ["tsc", "--noEmit", file_path]),
        ".tsx": ("npx", ["tsc", "--noEmit", file_path]),
        ".js": ("npx", ["eslint", file_path]),
        ".jsx": ("npx", ["eslint", file_path]),
        ".py": ("python3", ["-m", "py_compile", file_path]),
        ".json": ("python3", ["-c", "import json, sys; json.load(open(sys.argv[1]))", file_path]),
        ".md": ("npx", ["markdownlint", file_path]),
    }
    return validators.get(ext)


def write_state_file(session_id, file_path, gate_status=None):
    """Write/update the session state file recording that an edit happened."""
    state_path = f"/tmp/cc-qg-{session_id}.json"
    state = {}
    if os.path.exists(state_path):
        try:
            with open(state_path) as f:
                state = json.load(f)
        except (json.JSONDecodeError, IOError):
            state = {}
    state["edited"] = True
    files = state.get("files", [])
    if file_path not in files:
        files.append(file_path)
    state["files"] = files
    state["last_edit_ts"] = time.time()
    if gate_status:
        state["quality_gate"] = gate_status
    try:
        with open(state_path, "w") as f:
            json.dump(state, f)
    except IOError:
        pass  # Fail open — state file is best-effort


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return  # Fail open on malformed input

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return

    file_path = tool_input.get("file_path", "")
    if not file_path:
        return

    session_id = payload.get("session_id", "unknown")

    # Only validate for Edit and Write tools (matcher also handles this,
    # but double-check in case the hook is invoked more broadly)
    if tool_name not in ("Edit", "Write"):
        write_state_file(session_id, file_path)
        return

    validator = get_validator(file_path)
    if not validator:
        write_state_file(session_id, file_path)
        return  # No validator for this file type — fail open

    cmd, args = validator
    try:
        result = subprocess.run(
            [cmd] + args,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            error_output = result.stderr or result.stdout or "Validation failed"
            # Truncate to avoid context pollution
            if len(error_output) > 2000:
                error_output = error_output[:2000] + "\n... (truncated)"
            validator_name = args[1] if args[0].startswith("-") and len(args) > 1 else args[0]
            # PAV-structured tag-prefix format
            message = (
                f"[quality-gate:FAIL] validator={validator_name} file={file_path}\n"
                f"{error_output}\n"
                f"Fix the issue before proceeding."
            )
            gate_status = {
                "status": "fail",
                "validator": validator_name,
                "file": file_path,
            }
            write_state_file(session_id, file_path, gate_status)
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": message,
                }
            }
            print(json.dumps(output))
        else:
            gate_status = {
                "status": "pass",
                "validator": args[1] if args[0].startswith("-") and len(args) > 1 else args[0],
                "file": file_path,
            }
            write_state_file(session_id, file_path, gate_status)
    except subprocess.TimeoutExpired:
        write_state_file(session_id, file_path)
        pass  # Validator timed out — fail open
    except FileNotFoundError:
        write_state_file(session_id, file_path)
        pass  # Validator not installed — fail open
    except Exception:
        write_state_file(session_id, file_path)
        pass  # Any other error — fail open


if __name__ == "__main__":
    main()
