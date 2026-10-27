#!/bin/zsh
# Runs the test suites under a throwaway HOME, with guard stubs for zmx and claude.
# Usage: zsh scripts/check.sh [full | lib | rest | extras | <suite> ...]
#   <suite> runs scripts/test-lib-<suite>.js, else scripts/test-<suite>.js
#   lib: every test-lib-*.js; rest: every other test-*.js plus extras; full: lib and rest
#   extras: a --help, the generate dry-run, tests/test-generate.sh
# Exits 1 when a suite or check fails, a named suite is missing, or a guard stub was called.
# A failing command's log is printed in full (every log with CHECK_VERBOSE=1); the temp dir is removed on exit.
set -u
R=${0:A:h:h}; cd "$R" || exit 2
M=$(git rev-parse --path-format=absolute --git-common-dir) || exit 2; M=${M:h}
T=$(mktemp -d "${TMPDIR:-/tmp}/agents-check.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.claude" "$T/xdg" "$T/guard"; print '{}' > "$T/cfg.json"
print -r -- "{\"$M\": \"direct\"}" > "$T/home/.claude/repo-policies.json"
print -rl -- '#!/bin/sh' 'case "$1" in --version) echo "zmx 0.8.1"; exit 0;; list) exit 0;; esac' "echo \"zmx \$*\" >> '$T/guard.log'; exit 97" > "$T/guard/zmx"
print -rl -- '#!/bin/sh' "echo \"claude \$*\" >> '$T/guard.log'; exit 97" > "$T/guard/claude"
chmod +x "$T/guard/zmx" "$T/guard/claude"; : > "$T/guard.log"
e() { env -i HOME="$T/home" PATH="$T/guard:$PATH" AGENTS_CONFIG_PATH="$T/cfg.json" XDG_CONFIG_HOME="$T/xdg" GIT_CONFIG_NOSYSTEM=1 GIT_EDITOR=true GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com "$@"; }
F=0; X=0; typeset -U L; L=()
r() { local n=$1 l=$2 s=$SECONDS; shift 2; e "$@" > "$l" 2>&1; local c=$?; print "$n exit=$c $(( SECONDS - s ))s"; (( c == 0 )) || F=1; (( c == 0 && ! ${CHECK_VERBOSE:-0} )) || cat "$l"; }
e zmx check-guard-probe; [[ $? == 97 ]] || { print "guard self-test failed (expect exit 97)"; exit 2; }; : > "$T/guard.log"
for a in ${@:-full}; do
  case $a in
    full|lib) L+=(scripts/test-lib-*.js(N)) ;|
    full|rest) for f in scripts/test-*.js(N); do [[ $f == scripts/test-lib-* ]] || L+=($f); done; X=1 ;;
    lib) ;;
    extras) X=1 ;;
    *) if [[ -f scripts/test-lib-$a.js ]]; then L+=(scripts/test-lib-$a.js); elif [[ -f scripts/test-$a.js ]]; then L+=(scripts/test-$a.js); else print "suite $a missing (no scripts/test-lib-$a.js or scripts/test-$a.js)"; F=1; fi ;;
  esac
done
for f in $L; do r "${f:t:r}" "$T/${f:t:r}.out" node "$f"; done
if (( X )); then
  r help "$T/help.out" node scripts/bin/a --help; print "help lines=$(wc -l < "$T/help.out")"
  r dry-run "$T/gen.out" node scripts/generate.js all --config defaults/config.json --dry-run
  r test-generate.sh "$T/gensh.out" env HOME="$(mktemp -d "$T/genhome.XXXXXX")" zsh tests/test-generate.sh
fi
H=${$(wc -l < "$T/guard.log")// /}; print "guard hits=$H (expect 0)"; (( H == 0 )) || { F=1; cat "$T/guard.log"; }
print "total ${SECONDS}s"; if (( F )); then print "check: FAILED"; else print "check: ok"; fi
exit $F
