#!/usr/bin/env python3
"""Reviewer write-guard: a PreToolUse hook that denies shell commands which
create, write, or modify a file, scoped to the Reviewer agent via subagent
frontmatter (Claude Code) / agent frontmatter (Copilot, Phase 3).

Host-agnostic by design: this script keys off `tool_input.command` regardless
of `tool_name` — Claude Code sends "Bash", GitHub Copilot sends
"runTerminalCommand". If there is no usable `command` field, the call is
allowed (no-op).

Deny mechanism: print a PreToolUse deny JSON payload to stdout and exit 0.
Allow: print nothing and exit 0. (Both CC and Copilot honor the JSON-stdout
deny form — see task 100-reviewer-write-lockdown, Phase 2 plan.)

Deny/allow policy (FOCUSED tier — see
.tasks/100-reviewer-write-lockdown/plan/phase-2-pretooluse-hook.md for the
full contract this implements):

  DENY: output redirection to a file (>, >>, >|, &>, &>>, but not /dev/null or
  an fd dup like 2>&1), tee, sed -i/--in-place, perl -i, heredocs (<</<<-, not
  the <<< here-string), touch, dd with of=, in-place/interactive editors (vi,
  vim, nvim, nano, ed, ex), awk program-internal >/>>, curl/wget
  download-to-file flags including bundled short forms (-o/-O/--output,
  -sO, -Lo, -qO, ...), and writes hidden inside a nested shell/interpreter
  wrapper (bash/sh/zsh -c, xargs ... sh -c, find -exec sh -c, python3 -c /
  perl -e / node -e, eval, including os.system()/subprocess chains —
  string-arg and list-argv forms alike, e.g. subprocess.run(['touch', 'f'])).
  `eval` is unwrapped the same way as `bash -c`/`sh -c`: its quoted (or bare
  unquoted-word) argument is extracted and recursively re-scanned, since bash
  evaluates an `eval` argument as shell code exactly like `sh -c`.

  ALLOW: redirection to /dev/null or an fd, read-only pipes, <<< here-strings,
  sed/awk without in-place/internal writes, plain curl/wget with no
  output flag, and out-of-scope tree ops (cp, mv, mkdir, rm, ln, git apply).

  Scanning is quote-aware: DENY patterns are matched only against UNQUOTED
  text, so `grep 'a > b' file`, `echo "x >> y"`, and `rg '>>' .` are allowed.
  A fixed set of known wrappers is recursively unwrapped and their inner
  command/code string is re-scanned, closing the nested-write bypass without
  treating every quoted substring in every command as suspect. Command-NAME
  and flag matching runs against a de-escaped token stream so backslash-
  obfuscated names (`t\ee`, `s\ed -i`, `v\i`) are still caught, while
  redirection-operator matching keeps true quote/escape state (an escaped
  `\>` really is inert in bash). `$(...)` and backtick command substitution
  are extracted and recursively re-scanned even when they sit inside double
  quotes (bash evaluates them there; only single quotes suppress them).

Accepted residual risk (deliberately NOT hardened further — 2026-07-26):
  This guard is a static, textual scan of the command string. It does not
  execute a real shell parser, so a small set of exotic, non-obvious shell
  quoting/execution forms can still slip a write past it:

  - ANSI-C quoting, e.g. `$'touch' f` — a bare `$'name'` word evaluates to a
    literal string in bash and is not itself a special construct the scanner
    special-cases.
  - Backslash-newline line-continuation splitting a command name across
    lines, e.g. `to\` + newline + `uch f` (bash joins the two physical lines
    into one logical `touch f` before executing).
  - `printf -v x "touch f"; $x` variable-indirection execution (the write
    command only appears as data assigned to a shell variable, then run via
    unquoted expansion).
  - The general class this represents: static shell-text scanning cannot see
    through arbitrary indirection — variable expansion, sourced files, or
    opaque scripts/binaries invoked by name — the same limitation already
    documented for opaque commands (`make`, `pytest`, a repo's own scripts).

  These all require an agent to DELIBERATELY construct unusual shell quoting
  or indirection to evade its own guard — that is outside the cooperative-
  but-overeager threat model this hook is designed for (a Reviewer that tries
  an ordinary write method, gets denied, and should stop/report a finding —
  not one adversarially crafting bypasses). The backstop for this residual
  risk is the Phase 1 prompt hardening
  (`templates/agents/reviewer.template.md`, "MUST NOT create, write, or
  modify any file by ANY means") plus this hook's coaching deny message,
  which together instruct the Reviewer to stop and report rather than keep
  hunting for a way around the block. See
  `.tasks/100-reviewer-write-lockdown/plan/phase-2-pretooluse-hook.md`
  (Known limitations) for the full write-up.
"""

import json
import re
import sys

COACHING_REASON_TEMPLATE = (
    "File writes are disabled for the Reviewer agent. Do NOT attempt another "
    "write method. Verify using existing repo commands/tests, or report this "
    "as a finding (e.g. \"could not verify X without writing a helper "
    "script\"). Matched pattern: {matched}"
)

MAX_UNWRAP_DEPTH = 20

# ---------------------------------------------------------------------------
# Quote-aware masking
# ---------------------------------------------------------------------------


def mask_quotes(text):
    """Return a same-length string with single/double-quoted characters
    (including the quote delimiters themselves) replaced by NUL, so DENY
    patterns are matched only against real (unquoted) shell operator text.
    Respects backslash-escaping within double quotes and at the top level.
    """
    masked = list(text)
    in_single = False
    in_double = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_single:
            masked[i] = "\x00"
            if c == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if c == "\\" and i + 1 < n:
                masked[i] = "\x00"
                masked[i + 1] = "\x00"
                i += 2
                continue
            masked[i] = "\x00"
            if c == '"':
                in_double = False
            i += 1
            continue
        # Not inside any quotes.
        if c == "'":
            in_single = True
            masked[i] = "\x00"
            i += 1
            continue
        if c == '"':
            in_double = True
            masked[i] = "\x00"
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            masked[i] = "\x00"
            masked[i + 1] = "\x00"
            i += 2
            continue
        i += 1
    return "".join(masked)


def mask_quotes_deescape(text):
    """Like mask_quotes, but backslash-escaped characters OUTSIDE quotes are
    DE-ESCAPED (the backslash is dropped, exposing the literal escaped
    character) instead of being masked to NUL. Quoted regions (single and
    double) are masked to NUL exactly as in mask_quotes — they remain inert.

    This defeats backslash-obfuscated command/flag names: bash executes
    `t\\ee`, `to\\uch`, `s\\ed -i`, `v\\i` as `tee`/`touch`/`sed -i`/`vi`
    (backslash before a non-special char is a no-op escape that bash
    strips), so word-boundary matching must see the de-escaped token.

    Used ONLY for command-NAME / flag word matching (tee/touch/sed/perl/
    editors/curl/wget/of=). Redirection-OPERATOR matching (>, >>, <<) must
    keep using mask_quotes's true quote/escape state instead, because an
    escaped operator like `\\>` is a different semantic class: it really is
    inert in bash (a literal '>' character, not a redirection operator).
    """
    out = []
    in_single = False
    in_double = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_single:
            out.append("\x00")
            if c == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if c == "\\" and i + 1 < n:
                out.append("\x00")
                out.append("\x00")
                i += 2
                continue
            out.append("\x00")
            if c == '"':
                in_double = False
            i += 1
            continue
        # Not inside any quotes.
        if c == "'":
            in_single = True
            out.append("\x00")
            i += 1
            continue
        if c == '"':
            in_double = True
            out.append("\x00")
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(text[i + 1])  # De-escape: drop backslash, keep char.
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def has_word(text, word):
    return re.search(r"\b" + re.escape(word) + r"\b", text) is not None


def extract_quoted_arg(text, idx):
    """Starting at (or before) idx, skip whitespace, then extract the
    contents of a single- or double-quoted argument from `text`. Returns
    None if no quote is found at the resulting position."""
    n = len(text)
    while idx < n and text[idx] in " \t":
        idx += 1
    if idx >= n or text[idx] not in ("'", '"'):
        return None
    quote = text[idx]
    idx += 1
    buf = []
    while idx < n:
        c = text[idx]
        if quote == '"' and c == "\\" and idx + 1 < n:
            buf.append(text[idx + 1])
            idx += 2
            continue
        if c == quote:
            return "".join(buf)
        buf.append(c)
        idx += 1
    return "".join(buf)  # Unterminated quote — best-effort.


# ---------------------------------------------------------------------------
# Top-level (quote-aware) DENY-pattern scan
# ---------------------------------------------------------------------------

REDIR_RE = re.compile(r"(\d*)(&>>|&>|>>|>\||>)(\s*)(\S*)")
HEREDOC_RE = re.compile(r"(?<!<)<<-?(?!<)")
TEE_RE = re.compile(r"\btee\b")
INPLACE_FLAG_RE = re.compile(r"(?:^|\s)-i(?:\S*)?(?:\s|$)|--in-place\b")
TOUCH_RE = re.compile(r"\btouch\b")
DD_RE = re.compile(r"\bdd\b")
DD_OF_RE = re.compile(r"(?:^|\s)of=")
EDITOR_RE = re.compile(r"\b(?:vi|vim|nvim|nano|ed|ex)\b")
# Matches standalone -o/-O/--output AND -o/-O bundled with other short flags
# in the same dash group (curl -sO, curl -Lo, wget -qO) — a single-dash run
# of letters containing an 'o'/'O' anywhere. Long options always use "--",
# which this alternative cannot match. Only ever searched within a single
# curl/wget command SEGMENT (see curl_wget_download below), never over the
# whole command string, so an unrelated downstream `-o` (e.g. `sort -o
# file`, `grep -o result`, `ls -o file`) piped after a curl/wget call is
# never misattributed to it.
DOWNLOAD_FLAG_RE = re.compile(r"(?:^|\s)(-[A-Za-z]*[oO][A-Za-z]*\b|--output\b)")

# Splits a command into pipeline/list segments so curl/wget download-flag
# detection can be scoped to the segment(s) the curl/wget invocation itself
# owns, rather than the whole command string.
CMD_SEGMENT_SPLIT_RE = re.compile(r"\|\||&&|\||;|\n")

# Matches only when curl/wget is the segment's OWN first word (optionally
# after leading whitespace/masked-quote NUL padding), immediately followed by
# whitespace/NUL or end-of-segment. This is intentionally stricter than a bare
# \b word match: \bcurl\b would also match inside `curl-report` (a `-` is a
# non-word/word boundary too), which is not an invocation of curl at all.
CURL_WGET_CMD_RE = re.compile(r"^[ \t\x00]*(curl|wget)(?=[ \t\x00]|$)")


def scan_awk_internal_write(text, masked):
    """Item 9: an awk program's OWN >/>> is a real write, so it is
    intentionally scanned INSIDE its quotes (the one carve-out to the
    quote-aware rule)."""
    for m in re.finditer(r"\bawk\b", masked):
        idx = m.end()
        j = idx
        quote_idx = None
        while j < len(text):
            ch = text[j]
            if ch in ("'", '"'):
                quote_idx = j
                break
            if ch in (";", "|", "&", "\n"):
                break
            j += 1
        if quote_idx is None:
            continue
        prog = extract_quoted_arg(text, quote_idx)
        if prog is not None and ">" in prog:
            return "awk program internal redirection ({!r})".format(prog)
    return None


def curl_wget_download(word_scan):
    """Scope the download-flag match to only the pipeline/list segment(s)
    whose OWN first word is curl/wget (split on |, ||, &&, ;, and newlines).

    The prior approach gated on curl/wget appearing ANYWHERE in the whole
    command and then scanned the ENTIRE string for a download flag, so a
    read-only pipeline like `curl https://x | sort -o file` was denied by the
    unrelated downstream `sort -o` — and `echo curl-report && ls -o file` was
    denied merely because the substring "curl" appeared in an unrelated word.
    Splitting into segments and requiring curl/wget to be that segment's own
    first word fixes both false positives while still catching `curl -sO
    url`, `curl -Lo out url`, `wget -qO out url` (flag lives in the same
    segment as the curl/wget invocation)."""
    for segment in CMD_SEGMENT_SPLIT_RE.split(word_scan):
        if not CURL_WGET_CMD_RE.match(segment):
            continue
        m = DOWNLOAD_FLAG_RE.search(segment)
        if m:
            return "curl/wget download-to-file flag ({})".format(m.group(1))
    return None


def quote_aware_scan(text):
    """Scan `text` for DENY patterns.

    Two parallel views are used:
    - `masked` (mask_quotes): true quote/escape state — used for redirection
      OPERATORS (>, >>, <<), where an escaped operator (`\\>`) is genuinely
      inert in bash.
    - `word_scan` (mask_quotes_deescape): quoted regions stay masked/inert,
      but unquoted backslash-escapes are stripped — used for command-NAME
      and flag word matching, so `t\\ee`/`s\\ed -i`/`v\\i` are seen as
      `tee`/`sed -i`/`vi` (bash executes them as such).

    Item 9 (awk) is the one carve-out that intentionally looks inside its
    own quoted program argument, and keeps using true quote state (`masked`)
    since it needs an exact source-text offset for extract_quoted_arg.
    """
    masked = mask_quotes(text)
    word_scan = mask_quotes_deescape(text)

    awk_hit = scan_awk_internal_write(text, masked)
    if awk_hit:
        return awk_hit

    for m in REDIR_RE.finditer(masked):
        op = m.group(2)
        target = m.group(4) or ""
        if target == "/dev/null" or target.startswith("&"):
            continue  # Allowed: bit-bucket or fd-dup redirection.
        return "output redirection to file ({}{})".format(op, target)

    if HEREDOC_RE.search(masked):
        return "heredoc (<< / <<-)"

    if TEE_RE.search(word_scan):
        return "tee (writes stdin to a file)"

    if has_word(word_scan, "sed") and INPLACE_FLAG_RE.search(word_scan):
        return "sed -i / --in-place (in-place file edit)"

    if has_word(word_scan, "perl") and INPLACE_FLAG_RE.search(word_scan):
        return "perl -i (in-place file edit)"

    if TOUCH_RE.search(word_scan):
        return "touch (creates/updates a file)"

    if DD_RE.search(word_scan) and DD_OF_RE.search(word_scan):
        return "dd with of= (writes a file)"

    if EDITOR_RE.search(word_scan):
        return "interactive/in-place editor (vi/vim/nvim/nano/ed/ex)"

    dl = curl_wget_download(word_scan)
    if dl:
        return dl

    return None


def extract_command_substitutions(text):
    """Return the inner strings of every `$(...)` and `` `...` `` command
    substitution span in `text` that bash will actually evaluate.

    Bash evaluates command substitution both at the top level AND inside
    double quotes — only single quotes suppress it. So `echo "$(touch f)"`
    and `` echo "`touch f`" `` run `touch f` even though it sits inside a
    double-quoted argument (where mask_quotes/mask_quotes_deescape correctly
    treat the surrounding text as inert for other purposes). This walks the
    raw text tracking quote state and extracts every such span (recursing
    through nested parens for `$(...)`) so find_deny can re-scan its content
    as a real nested command, regardless of whether it happens to sit inside
    double quotes or not. Spans inside single quotes are correctly skipped
    (bash does not expand `$(...)`/backticks there).
    """
    spans = []
    in_single = False
    in_double = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_single:
            if c == "'":
                in_single = False
            i += 1
            continue
        if c == "'":
            in_single = True
            i += 1
            continue
        if c == '"':
            in_double = not in_double
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            i += 2
            continue
        if c == "$" and i + 1 < n and text[i + 1] == "(":
            depth = 1
            j = i + 2
            start = j
            while j < n and depth > 0:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            spans.append(text[start:j])
            i = j + 1
            continue
        if c == "`":
            j = i + 1
            start = j
            while j < n and text[j] != "`":
                j += 1
            spans.append(text[start:j])
            i = j + 1
            continue
        i += 1
    return spans


# ---------------------------------------------------------------------------
# Recursive unwrap of known shell/interpreter wrappers
# ---------------------------------------------------------------------------

SHELL_C_RE = re.compile(r"\b(?:bash|sh|zsh)\b(?:\s+-[A-Za-z]+)*\s+-c\s+")
PYTHON_C_RE = re.compile(r"\bpython3?\b\s+-c\s+")
PERL_E_RE = re.compile(r"\bperl\b\s+-e\s+")
NODE_E_RE = re.compile(r"\bnode\b\s+-e\s+")
EVAL_RE = re.compile(r"\beval\b")
# Terminates an unquoted `eval <words...>` argument list at the next command
# separator (bash re-joins eval's argv with spaces and evaluates it as one
# command, so an unquoted form runs until the shell would otherwise end the
# command).
EVAL_UNQUOTED_END_RE = re.compile(r"[;&|\n]")

PY_OPEN_WRITE_RE = re.compile(
    r"open\([^)]*['\"](?:w\+?|a\+?|x\+?|wb|ab|xb)['\"]"
)
PY_WRITE_CALL_RE = re.compile(r"\.write(?:lines)?\(")
PY_PATHLIB_WRITE_RE = re.compile(r"\bwrite_text\(|\bwrite_bytes\(")
PY_OS_OPEN_RE = re.compile(r"os\.open\([^)]*O_(?:WRONLY|CREAT|APPEND)")
PERL_WRITE_RE = re.compile(r"open\s*\([^)]*['\"]>")
NODE_WRITE_RE = re.compile(r"writeFile|createWriteStream")

PY_SYSTEM_CALL_RE = re.compile(r"os\.system\(\s*['\"](.*?)['\"]\s*\)")
PY_SUBPROCESS_CALL_RE = re.compile(r"subprocess\.\w+\(\s*['\"](.*?)['\"]")
PY_SUBPROCESS_LIST_RE = re.compile(r"subprocess\.\w+\(\s*\[(.*?)\]")
PY_LIST_STR_ITEM_RE = re.compile(r"""['"]([^'"]*)['"]""")


def extract_subprocess_list_command(code):
    """Extract a subprocess.run/call/Popen/...(['argv0', 'argv1', ...]) list-
    argument first call, and rejoin its string elements into a synthetic
    shell command string for recursive scanning. Catches the list-argv
    subprocess form that PY_SUBPROCESS_CALL_RE misses (it only matches a
    quoted-string first argument), e.g.
    subprocess.run(['touch', '/tmp/pwned']) or subprocess.call(['tee', 'f']).
    """
    m = PY_SUBPROCESS_LIST_RE.search(code)
    if not m:
        return None
    items = PY_LIST_STR_ITEM_RE.findall(m.group(1))
    if not items:
        return None
    return " ".join(items)


def try_unwrap(text):
    """Recognize a fixed set of shell-invoking wrappers and interpreter-eval
    forms and extract the inner command/code string. Returns
    (kind, inner_text) or None if text is not a recognized wrapper."""
    m = SHELL_C_RE.search(text)
    if m:
        inner = extract_quoted_arg(text, m.end())
        if inner is not None:
            return ("shell", inner)
    m = PYTHON_C_RE.search(text)
    if m:
        inner = extract_quoted_arg(text, m.end())
        if inner is not None:
            return ("python", inner)
    m = PERL_E_RE.search(text)
    if m:
        inner = extract_quoted_arg(text, m.end())
        if inner is not None:
            return ("perl", inner)
    m = NODE_E_RE.search(text)
    if m:
        inner = extract_quoted_arg(text, m.end())
        if inner is not None:
            return ("node", inner)
    m = EVAL_RE.search(text)
    if m:
        inner = extract_quoted_arg(text, m.end())
        if inner is None:
            rest = text[m.end():].lstrip(" \t")
            end = EVAL_UNQUOTED_END_RE.search(rest)
            unquoted = (rest[: end.start()] if end else rest).strip()
            inner = unquoted or None
        if inner is not None:
            return ("shell", inner)
    return None


def interpreter_write_scan(code, lang):
    if lang == "python":
        if PY_OPEN_WRITE_RE.search(code):
            return "python write via open() ({!r})".format(code)
        if PY_WRITE_CALL_RE.search(code):
            return "python write via .write()/.writelines() ({!r})".format(code)
        if PY_PATHLIB_WRITE_RE.search(code):
            return "python pathlib write_text()/write_bytes() ({!r})".format(code)
        if PY_OS_OPEN_RE.search(code):
            return "python os.open() write flags ({!r})".format(code)
    elif lang == "perl":
        if PERL_WRITE_RE.search(code) or re.search(r"(?:^|\s)-i\b", code):
            return "perl file write ({!r})".format(code)
    elif lang == "node":
        if NODE_WRITE_RE.search(code):
            return "node fs write ({!r})".format(code)
    return None


def extract_system_call_command(code, lang):
    """If interpreter code shells out via os.system()/subprocess.*() with a
    literal command string (or a list-argv form), extract a synthetic
    command string so it can be recursed through the shell scan (catches
    e.g. python3 -c "os.system('touch f')" and
    python3 -c "subprocess.run(['touch', 'f'])")."""
    if lang != "python":
        return None
    m = PY_SYSTEM_CALL_RE.search(code)
    if m:
        return m.group(1)
    m = PY_SUBPROCESS_CALL_RE.search(code)
    if m:
        return m.group(1)
    return extract_subprocess_list_command(code)


def find_deny(text, depth=0):
    if depth > MAX_UNWRAP_DEPTH:
        return None

    hit = quote_aware_scan(text)
    if hit:
        return hit

    for inner in extract_command_substitutions(text):
        hit = find_deny(inner, depth + 1)
        if hit:
            return hit

    unwrapped = try_unwrap(text)
    if unwrapped:
        kind, inner = unwrapped
        if kind == "shell":
            return find_deny(inner, depth + 1)
        hit = interpreter_write_scan(inner, kind)
        if hit:
            return hit
        cmd_str = extract_system_call_command(inner, kind)
        if cmd_str is not None:
            return find_deny(cmd_str, depth + 1)

    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return  # Malformed input — allow (fail open on parse errors only).

    tool_input = payload.get("tool_input") if isinstance(payload, dict) else None
    if not isinstance(tool_input, dict):
        return

    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return

    matched = find_deny(command)
    if not matched:
        return

    reason = COACHING_REASON_TEMPLATE.format(matched=matched)
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
