"use strict";

/**
 * Shell write-primitive detection — ports the logic from the original
 * Python hooks/write-guard.sh (ADR-015) to JavaScript so it can run as a
 * global `a hook write-guard` handler alongside the other enforcement hooks.
 *
 * Detects: redirection (> >>), tee, sed -i / perl -i, touch, dd of=,
 * in-place editors, curl/wget download-to-file, python -c / perl -e /
 * node -e file writes. Quote-aware: strips single-quoted segments before
 * shell-level matching so `grep 'a > b'` is not a false positive. Recursively
 * unwraps bash -c / python3 -c / node -e / eval wrappers and scans the
 * inner code. Command substitutions $(...) and backticks are also scanned.
 *
 * The threat model is a cooperative-but-overeager agent reaching for a shell
 * workaround, not an adversary deliberately evading detection.
 */

const COACHING_MESSAGES = {
  explorer:
    "Your shell is read-only for recon (git history, log inspection, " +
    "process state). Use Edit/Write tools for `.tasks/` files — do not " +
    "write via Bash. Do not retry another write method.",
  reviewer:
    "Your shell access is for verification only (running tests, reading " +
    "state). Do not write files via Bash — report a finding instead.",
  committer:
    "Use the Edit tool for file changes — do not write files via Bash.",
};

const DEFAULT_COACHING =
  "This agent's shell access is read-only. Do not write files via Bash.";

function getCoaching(agentType) {
  return COACHING_MESSAGES[agentType] || DEFAULT_COACHING;
}

// Shell-level write primitives. Checked after stripping single-quoted segments
// to avoid false positives on operators inside quotes (e.g. grep 'a > b').
const SHELL_DENY_PATTERNS = [
  // Output redirection > and >> to a file (not /dev/null, /dev/fd/*, &N, or <<< here-strings)
  /(?<![<])>{1,2}\s*(?!\s*(?:\/dev\/(?:null|fd\/|stdout|stderr)|&\d))(?!.*<<<)/,
  // tee writing to a file (not tee /dev/null, tee /dev/fd/, tee &N)
  /\btee\b(?!\s+(?:\/dev\/(?:null|fd)|&\d))/,
  // In-place editing: sed -i, perl -i
  /\bsed\s+-i/,
  /\bperl\s+-i/,
  // touch (creating files)
  /\btouch\b/,
  // dd of= (writing to a file)
  /\bdd\b.*\bof\s*=\s*\S/,
  // In-place/interactive editors
  /\b(?:vi|vim|nvim|nano|ed|ex)\b(?!\s+-[A-Za-z]*v)/,
  // curl / wget download-to-file
  /\bcurl\b.*(?:\s-[LoOsS]+|--output\b|--output-document\b)/,
  /\bwget\b.*(?:\s-[LoOsS]+|--output-document\b)/,
];

// Code-level write primitives. Checked WITHOUT stripping single quotes because
// the code content (e.g., 'w' mode in open('f','w')) is significant.
const CODE_DENY_PATTERNS = [
  // python -c / python3 -c with open(...,'w') or open(...,"w")
  /\bopen\s*\([^)]*["'][^"']*["']\s*,\s*["']w/,
  // perl -e with open(F, '>...') or open(F, ">...")
  /\bopen\s*\([^)]*["']>\s*["']?/,
  // node -e with writeFileSync/appendFileSync/createWriteStream
  /\b(?:writeFileSync|appendFileSync|createWriteStream)\b/,
];

// Wrapper patterns to recursively unwrap (bash -c "cmd", python3 -c "cmd", etc.)
const WRAPPER_PATTERNS = [
  /^\s*(?:bash|sh|zsh)\s+-c\s+["'](.*)["']\s*$/,
  /^\s*xargs\s+.*?\s(?:bash|sh|zsh)\s+-c\s+["'](.*)["']\s*$/,
  /^\s*find\s+.*?\s-exec\s+(?:bash|sh|zsh)\s+-c\s+["'](.*)["']\s*(?:\{\}\s*\\;|\+)\s*$/,
  /^\s*python3?\s+-c\s+["'](.*)["']\s*$/,
  /^\s*perl\s+-e\s+["'](.*)["']\s*$/,
  /^\s*node\s+-e\s+["'](.*)["']\s*$/,
  /^\s*eval\s+["'](.*)["']\s*$/,
];

function stripSingleQuotes(text) {
  return text.replace(/'[^']*'/g, "''");
}

function unwrapCommand(command) {
  let current = command;
  for (let i = 0; i < 5; i++) {
    let unwrapped = false;
    for (const pattern of WRAPPER_PATTERNS) {
      const m = current.match(pattern);
      if (m) {
        current = m[1].trim();
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  return current;
}

function extractCommandSubstitutions(text) {
  const subs = [];
  const re1 = /\$\(([^)]*)\)/g;
  let m;
  while ((m = re1.exec(text)) !== null) subs.push(m[1]);
  const re2 = /`([^`]*)`/g;
  while ((m = re2.exec(text)) !== null) subs.push(m[1]);
  return subs;
}

/**
 * Scan a command string for write primitives. Returns true if a deny match is found.
 */
function scanCommand(command) {
  // --- Shell-level check: strip single quotes, unwrap, then match ---
  const deEscaped = stripSingleQuotes(command);
  const unwrapped = unwrapCommand(deEscaped);

  for (const pattern of SHELL_DENY_PATTERNS) {
    if (pattern.test(unwrapped) || pattern.test(deEscaped)) return true;
  }

  // --- Code-level check: do NOT strip single quotes (code content is significant) ---
  const codeUnwrapped = unwrapCommand(command);

  for (const pattern of CODE_DENY_PATTERNS) {
    if (pattern.test(command) || pattern.test(codeUnwrapped)) return true;
  }

  // --- Command substitutions: $(...) and backticks inside double quotes ---
  const subs = extractCommandSubstitutions(command);
  for (const sub of subs) {
    const deSub = stripSingleQuotes(sub);
    const unwrappedSub = unwrapCommand(deSub);
    for (const pattern of SHELL_DENY_PATTERNS) {
      if (pattern.test(unwrappedSub)) return true;
    }
    const unwrappedSubRaw = unwrapCommand(sub);
    for (const pattern of CODE_DENY_PATTERNS) {
      if (pattern.test(sub) || pattern.test(unwrappedSubRaw)) return true;
    }
  }

  return false;
}

module.exports = {
  COACHING_MESSAGES,
  getCoaching,
  scanCommand,
  SHELL_DENY_PATTERNS,
  CODE_DENY_PATTERNS,
  WRAPPER_PATTERNS,
};
