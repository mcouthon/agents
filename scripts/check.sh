#!/bin/zsh
# Runs the test suites in a bounded pool, longest recorded first, under throwaway HOMEs, with guard stubs for zmx and claude.
# Usage: zsh scripts/check.sh [full | lib | rest | extras | <suite> ...]
#   <suite> runs scripts/test-lib-<suite>.js, else scripts/test-<suite>.js
#   lib: every test-lib-*.js; rest: every other test-*.js plus extras; full: lib and rest
#   extras: a --help, the generate dry-run, tests/test-generate.sh, tests/test-migrate-config.sh, the surface guard
# Exits 1 when a suite or check fails, a named suite is missing, or a guard stub was called.
# A failing suite's output is printed in full (the last 256 KiB; every log with CHECK_VERBOSE=1); the temp dir is removed on exit.
# Each suite runs under its own temp root (HOME, guard stubs, repo-policies fixture); suites run in a bounded pool, longest recorded first; CHECK_JOBS lowers the pool only.
# A suite that goes silent for three minutes — or outlives a ten-minute outer ceiling — is killed and fails the battery with its name and captured output; a slow suite is never killed.
set -u
R=${0:A:h:h}; cd "$R" || exit 2
M=$(git rev-parse --path-format=absolute --git-common-dir) || exit 2; M=${M:h}
T=$(mktemp -d "${TMPDIR:-/tmp}/agents-check.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT
F=0; X=0; typeset -U L; L=()

for a in ${@:-full}; do
  case $a in
    full|lib) L+=(scripts/test-lib-*.js(N)) ;|
    full|rest) for f in scripts/test-*.js(N); do [[ $f == scripts/test-lib-* ]] || L+=($f); done; X=1 ;;
    lib) ;;
    extras) X=1 ;;
    *) if [[ -f scripts/test-lib-$a.js ]]; then L+=(scripts/test-lib-$a.js); elif [[ -f scripts/test-$a.js ]]; then L+=(scripts/test-$a.js); else print "suite $a missing (no scripts/test-lib-$a.js or scripts/test-$a.js)"; F=1; fi ;;
  esac
done

# Set up a per-suite temp root: HOME/.claude, XDG, guard stubs, repo-policies fixture.
mkroot() {
  local d="$1"
  mkdir -p "$d/home/.claude" "$d/xdg" "$d/guard"
  print '{}' > "$d/cfg.json"
  mkdir -p "$d/home/.agents"
  print -r -- "{\"$M\": \"direct\"}" > "$d/home/.agents/repo-policies.json"
  print -rl -- '#!/bin/sh' 'case "$1" in --version) echo "zmx 0.8.1"; exit 0;; list) exit 0;; esac' "echo \"zmx \$*\" >> '$d/guard.log'; exit 97" > "$d/guard/zmx"
  print -rl -- '#!/bin/sh' "echo \"claude \$*\" >> '$d/guard.log'; exit 97" > "$d/guard/claude"
  chmod +x "$d/guard/zmx" "$d/guard/claude"
  : > "$d/guard.log"
}

# Suites: a bounded pool, longest recorded first (scripts/check-suites.js).
if (( ${#L} > 0 )); then
  node scripts/check-suites.js "$T" $L &
  D=$!
  trap 'kill -TERM $D 2>/dev/null; wait $D; exit 130' TERM INT HUP
  wait $D; F=$?
  trap - TERM INT HUP
fi

# Extras (sequential, each in its own dir).
if (( X )); then
  mkroot "$T/extras"
  rx() {
    n=$1; s=$SECONDS; shift
    env -i HOME="$T/extras/home" PATH="$T/extras/guard:$PATH" AGENTS_CONFIG_PATH="$T/extras/cfg.json" XDG_CONFIG_HOME="$T/extras/xdg" GIT_CONFIG_NOSYSTEM=1 GIT_EDITOR=true GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com "$@" > "$T/extras/$n.out" 2>&1
    c=$?; el=$(( SECONDS - s ))
    print "$n exit=$c ${el}s"
    (( c == 0 )) || F=1
    (( c == 0 && ! ${CHECK_VERBOSE:-0} )) || cat "$T/extras/$n.out"
  }
  rx help node scripts/bin/a --help
  print "help lines=$(wc -l < "$T/extras/help.out")"
  rx dry-run node scripts/generate.js all --config defaults/config.json --dry-run
  rx test-generate.sh env HOME="$(mktemp -d "$T/extras/genhome.XXXXXX")" zsh tests/test-generate.sh
  rx test-migrate-config.sh zsh tests/test-migrate-config.sh
  rx surface-guard node scripts/surface-guard.js
fi

# Sum guard hits across all per-suite logs (and the extras log).
H=0
for g in "$T"/*/guard.log(N) "$T"/extras/guard.log(N); do
  [[ -f "$g" ]] || continue
  h=${$(wc -l < "$g")// /}
  H=$(( H + h ))
done
print "guard hits=$H (expect 0)"
(( H == 0 )) || { F=1; for g in "$T"/*/guard.log(N) "$T"/extras/guard.log(N); do [[ -f "$g" ]] && [[ -s "$g" ]] && cat "$g"; done; }
print "total ${SECONDS}s"
if (( F )); then print "check: FAILED"; else print "check: ok"; fi
exit $F
