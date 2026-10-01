#!/usr/bin/env python3
"""PreToolUse hook: write-guard that denies shell file-write primitives.

Reads JSON from stdin (PreToolUse event payload containing tool_name and
tool_input.command). Denies Bash commands that write files (redirection, tee,
sed -i, touch, dd of=, heredoc-to-file, python -c/perl -e/node -e writes,
curl/wget download-to-file, in-place editors) while allowing read-only
commands (git log, grep, ls, cat, head, rg, etc.).

Agent identity is passed as argv[1] (positional, from the hook command
string — e.g. "write-guard.sh explorer") to select a coaching message.
Falls back to stdin JSON agent_type field, then a generic default.

Fails open: malformed JSON, missing tool_input.command, or parser errors
exit 0 (never block on parse failure — the prose constraint is the backstop).
"""

import json
import re
import sys


COACHING_MESSAGES = {
    "explorer": (
        "Your shell is read-only for recon (git history, log inspection, "
        "process state). Use Edit/Write tools for `.tasks/` files — do not "
        "write via Bash. Do not retry another write method."
    ),
    "reviewer": (
        "Your shell access is for verification only (running tests, reading "
        "state). Do not write files via Bash — report a finding instead."
    ),
    "committer": (
        "Use the Edit tool for file changes — do not write files via Bash."
    ),
}

DEFAULT_COACHING = "This agent's shell access is read-only. Do not write files via Bash."

# Shell-level write primitives. Checked after stripping single-quoted segments
# to avoid false positives on operators inside quotes (e.g. grep 'a > b').
SHELL_DENY_PATTERNS = [
    # Output redirection > and >> to a file (not /dev/null, /dev/fd/*, &N, or <<< here-strings)
    re.compile(r'(?<![<])>{1,2}\s*(?!/dev/(?:null|fd/|stdout|stderr)|&\d)(?!.*<<<)'),
    # tee writing to a file (not tee /dev/null, tee /dev/fd/, tee &N)
    re.compile(r'\btee\b(?!\s+(?:/dev/(?:null|fd)|&\d))'),
    # In-place editing: sed -i, perl -i
    re.compile(r'\bsed\s+-i'),
    re.compile(r'\bperl\s+-i'),
    # touch (creating files)
    re.compile(r'\btouch\b'),
    # dd of= (writing to a file)
    re.compile(r'\bdd\b.*\bof\s*=\s*\S'),
    # In-place/interactive editors
    re.compile(r'\b(?:vi|vim|nvim|nano|ed|ex)\b(?!\s+-[A-Za-z]*v)'),
    # curl / wget download-to-file
    re.compile(r'\bcurl\b.*(?:\s-[LoOsS]+|--output\b|--output-document\b)'),
    re.compile(r'\bwget\b.*(?:\s-[LoOsS]+|--output-document\b)'),
]

# Code-level write primitives. Checked WITHOUT stripping single quotes because
# the code content (e.g., 'w' mode in open('f','w')) is significant. These match
# against both the original command and the wrapper-unwrapped inner code.
CODE_DENY_PATTERNS = [
    # python -c / python3 -c with open(...,'w') or open(...,"w")
    re.compile(r'\bopen\s*\([^)]*["\'][^"\']*["\']\s*,\s*["\']w'),
    # perl -e with open(F, '>...') or open(F, ">...")
    re.compile(r'\bopen\s*\([^)]*["\']>\s*["\']?'),
    # node -e with writeFileSync/appendFileSync/createWriteStream
    re.compile(r'\b(?:writeFileSync|appendFileSync|createWriteStream)\b'),
]

# Wrapper patterns to recursively unwrap (bash -c "cmd", python3 -c "cmd", etc.)
WRAPPER_PATTERNS = [
    re.compile(r'^\s*(?:bash|sh|zsh)\s+-c\s+["\'](.*)["\']\s*$'),
    re.compile(r'^\s*xargs\s+.*?\s(?:bash|sh|zsh)\s+-c\s+["\'](.*)["\']\s*$'),
    re.compile(r'^\s*find\s+.*?\s-exec\s+(?:bash|sh|zsh)\s+-c\s+["\'](.*)["\']\s*(?:\{\}\s*\\;|\+)\s*$'),
    re.compile(r'^\s*python3?\s+-c\s+["\'](.*)["\']\s*$'),
    re.compile(r'^\s*perl\s+-e\s+["\'](.*)["\']\s*$'),
    re.compile(r'^\s*node\s+-e\s+["\'](.*)["\']\s*$'),
    re.compile(r'^\s*eval\s+["\'](.*)["\']\s*$'),
]


def resolve_agent_id(argv, payload):
    """Determine agent identity from argv[1] or stdin JSON agent_type field."""
    if len(argv) > 1 and argv[1]:
        return argv[1].lower()
    agent_type = payload.get("agent_type")
    if agent_type:
        return str(agent_type).lower()
    return "default"


def get_coaching(agent_id):
    """Select the coaching message by agent id."""
    return COACHING_MESSAGES.get(agent_id, DEFAULT_COACHING)


def strip_single_quotes(text):
    """Replace single-quoted segments with empty strings.

    This prevents false positives on shell operators inside single quotes
    (e.g. grep 'a > b' file). Used for shell-level pattern matching only.
    """
    return re.sub(r"'[^']*'", "''", text)


def unwrap_command(command):
    """Recursively unwrap shell/interpreter wrappers, returning the inner command."""
    current = command
    for _ in range(5):
        unwrapped = False
        for pattern in WRAPPER_PATTERNS:
            m = pattern.match(current)
            if m:
                current = m.group(1).strip()
                unwrapped = True
                break
        if not unwrapped:
            break
    return current


def extract_command_substitutions(text):
    """Extract $(...) and backtick command substitution content."""
    subs = []
    for m in re.finditer(r'\$\(([^)]*)\)', text):
        subs.append(m.group(1))
    for m in re.finditer(r'`([^`]*)`', text):
        subs.append(m.group(1))
    return subs


def scan_command(command):
    """Scan a command string for write primitives. Returns True if a deny match is found."""
    # --- Shell-level check: strip single quotes, unwrap, then match ---
    de_escaped = strip_single_quotes(command)
    unwrapped = unwrap_command(de_escaped)

    for pattern in SHELL_DENY_PATTERNS:
        if pattern.search(unwrapped) or pattern.search(de_escaped):
            return True

    # --- Code-level check: do NOT strip single quotes (code content is significant) ---
    # Check against both the original command and the unwrapped inner code
    code_unwrapped = unwrap_command(command)

    for pattern in CODE_DENY_PATTERNS:
        if pattern.search(command) or pattern.search(code_unwrapped):
            return True

    # --- Command substitutions: $(...) and backticks inside double quotes ---
    subs = extract_command_substitutions(command)
    for sub in subs:
        de_sub = strip_single_quotes(sub)
        unwrapped_sub = unwrap_command(de_sub)
        for pattern in SHELL_DENY_PATTERNS:
            if pattern.search(unwrapped_sub):
                return True
        unwrapped_sub_raw = unwrap_command(sub)
        for pattern in CODE_DENY_PATTERNS:
            if pattern.search(sub) or pattern.search(unwrapped_sub_raw):
                return True

    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    tool_input = payload.get("tool_input", {})
    command = tool_input.get("command", "")
    if not command:
        sys.exit(0)

    agent_id = resolve_agent_id(sys.argv, payload)

    try:
        should_deny = scan_command(command)
    except Exception:
        sys.exit(0)

    if should_deny:
        coaching = get_coaching(agent_id)
        output = {
            "hookSpecificOutput": {
                "permissionDecision": "deny",
                "permissionDecisionReason": coaching,
            }
        }
        print(json.dumps(output))
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
