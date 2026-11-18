#!/usr/bin/env node
"use strict";

/**
 * The suite pool driver scripts/check.sh delegates its fan-out to: runs the
 * given suites in a bounded pool, longest recorded first, and streams each
 * suite's result line as it finishes.
 *
 * Usage: node scripts/check-suites.js <rootDir> [--suite-budget-ms=N] [--suite-silence-ms=N] <suite.js>...
 *   <rootDir>  the caller's temp root; each suite runs under <rootDir>/<name>/
 *              (HOME, guard stubs, repo-policies fixture — byte-identical to
 *              check.sh's mkroot). The driver never removes <rootDir>: the
 *              caller's EXIT trap owns cleanup, and check.sh's guard-hit scan
 *              reads the per-suite guard logs after this process exits.
 *   suites     paths relative to the repo root (or absolute).
 *   --suite-budget-ms=N   replaces the outer ceiling — the private seam
 *              scripts/test-check-suites.js uses to exercise the ceiling
 *              kill causally at a tiny budget; not a user knob.
 *   --suite-silence-ms=N  replaces the silence budget — the private seam for
 *              the silence kill; not a user knob.
 *
 * Env read here (not passed through): CHECK_JOBS lowers the pool only;
 * CHECK_VERBOSE prints every suite's captured output, not just failures'.
 * Exactly one passthrough: AGENTS_TEST_TIMING, when set in this process's
 * env, is copied into each suite's env — the suite env is otherwise a clean
 * ten-variable set, and without the copy the timing gates could never fire
 * through check.sh.
 *
 * TERM/INT/HUP list every still-running suite (`stopping: <name> <pid>
 * <elapsed>s`), SIGTERM each tracked child, SIGKILL stragglers after a ~2 s
 * grace, and exit 128+signum. Never process.kill(0): this driver shares a
 * process group with the parent `a check` chain, and signaling the group
 * would take that chain — and the evidence row — down with it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

const [rootDir] = process.argv.slice(2);
// Two belts, keyed to what a hang actually looks like: a load-slowed suite
// and a hung suite are indistinguishable to a wall clock and perfectly
// distinguishable to an output stream — load slows a suite's rate, never its
// stream. So the primary belt kills on silence (the hang's signature, which
// fleet load cannot fake) and the wall survives only as an outermost ceiling.
// Silence, 180 s: the longest legitimate silent stretch a healthy suite can
// produce is its longest blocking call — the 120 s whole-verb budget
// (test-lib-corpus), with the setup shard's eval-probe wait (the bootstrap's
// ~90 s until-loop) bounded inside it, or a cold-start spawn under the worst
// observed twin-battery storm (43.9 s) — so 180 s is 1.5x the former, 4x the
// latter; a suite that keeps printing is unkillable by this belt at any
// load. The residual is a driver-side event-ordering race at the exact
// silence boundary (data arrived at the pipe, the timer fired first) — the
// same class of accepted sub-ms windows, unreachable at 4x margin. Ceiling,
// 600 s: never expected to fire on a healthy suite — post-audit the longest
// suite is 35 s recorded (test-lib-start-setup, the 2026-11-18 sweep; ~30 at
// true idle). The worst twin demand is ambient-dependent, and the honest
// numbers are both on record: at a matched quiet ambient a twin lands near
// 3x the recorded longest (~115 s, the 2026-11-17 calibration), while the
// worst observed storm day — the machine's standing floor at 12-29 (a
// backend service, a second agent session, crowdstrike) with a twin battery
// stacked on it, effective load ~30-45 — stretched the longest suite
// (test-lib-worktree, 23 s recorded) to 367 s in-pool and held green: a
// ~16x storm factor that still sits 1.6x under the ceiling, bounding any
// single suite inside the 850 s cap `a check`/`a land` impose (kill + drain
// + extras < 850 s). Before the split the longest chain was 252 s
// recorded-solo with that margin gone.
// The seams shrink both for the driver's own causal tests only.
const DEFAULT_SUITE_SILENCE_MS = 180000;
const DEFAULT_SUITE_CEILING_MS = 600000;
let suiteSilenceMs = DEFAULT_SUITE_SILENCE_MS;
let suiteCeilingMs = DEFAULT_SUITE_CEILING_MS;
const suiteArgs = [];
for (const a of process.argv.slice(3)) {
  let m = /^--suite-budget-ms=(\d+)$/.exec(a);
  if (m) suiteCeilingMs = Number(m[1]);
  else {
    m = /^--suite-silence-ms=(\d+)$/.exec(a);
    if (m) suiteSilenceMs = Number(m[1]);
    else suiteArgs.push(a);
  }
}
if (!rootDir || suiteArgs.length === 0) {
  console.error("usage: node scripts/check-suites.js <rootDir> [--suite-budget-ms=N] [--suite-silence-ms=N] <suite.js>...");
  process.exit(2);
}

// Launch order: longest recorded suite first. Integer seconds from the
// 2026-11-18 post-audit solo sweep (57/57 green — test-worktree-root-isolation
// is tabled for the first time) over the rebuilt battery: 77 duplicate
// assertions merged into their owners, the class-windows and child-lifecycle
// merges in engine-wait, the world-chaining in doctor and the installs. The
// sweep ran at the day's floor, not true idle: 1-min load 5.39-10.06 beside
// every line (the PAV backend and a second agent session standing; crowdstrike
// bursting) — the <6 gate never opened — and lines caught in a burst were
// re-run, last run wins. The recorded sum is 450.0 s (447 rounded); at true
// idle it reads lower by the ambient gap (the phase-2 calibration put ~5% on
// a 7-12 band). Durations only need to stay stable enough to order.
// Regenerate by running each suite solo and sorting the per-suite
// `<name> exit=… <sec>s` lines descending. Suites missing from the table
// (new ones) launch after every tabled suite, alphabetical among themselves.
// The three renewal suites (test-lib-restart, test-watcher,
// test-lib-start-resume) were re-timed solo on 2026-11-18 — their kick waits
// moved the ordering, the header's own re-time rule. test-doctor and
// test-watcher were re-timed again that day: their spend families (DS, AW14)
// moved them past their neighbors. Those four re-times fold into this table
// over the sweep's old numbers (restart 17, doctor 16, watcher 6, resume 20);
// a solo pass over the merged battery on 2026-11-18 (1-min load 6.0-9.2)
// confirmed them — restart 64.4 s, doctor 31.0 s, watcher 24.9 s, resume 20.0 s
// — and re-timed two suites those landings had grown past their slots: start
// 31 → 38 (41.1 then 37.7 s, last run wins) and worktree 23 → 25 (25.9 then
// 24.7 s). The tabled integers total 533.
const SERIAL_SECONDS = {
  "test-lib-restart": 63,
  "test-lib-start": 38,
  "test-lib-start-setup": 35,
  "test-pane-send": 33,
  "test-doctor": 30,
  "test-engine-wait": 25,
  "test-watcher": 25,
  "test-lib-worktree": 25,
  "test-install-node": 21,
  "test-lib-launch": 20,
  "test-install-shims": 20,
  "test-lib-derive": 19,
  "test-lib-start-resume": 18,
  "test-lib-db-migrate": 17,
  "test-lib-land": 13,
  "test-lib-roster": 12,
  "test-check-suites": 12,
  "test-lib-hook-two": 10,
  "test-lib-corpus": 8,
  "test-cli-contract": 7,
  "test-lib-db-import": 6,
  "test-lib-verbs": 6,
  "test-install-snapshot": 5,
  "test-lib-ls-timing": 5,
  "test-lib-task": 5,
  "test-lib-start-sweep": 4,
  "test-lib-events": 4,
  "test-lib-lock": 4,
  "test-lib-advise": 4,
  "test-lib-db": 4,
  "test-lib-sweep": 3,
  "test-lib-checkout-env": 3,
  "test-lib-setup": 3,
  "test-state-server": 2,
  "test-surface-guard": 2,
  "test-hooks-session": 2,
  "test-worktree-root-isolation": 2,
  "test-lib-check": 2,
  "test-task-probe": 2,
  "test-mcp-adapter": 2,
  "test-lib-repo": 2,
  "test-lib-hook-stubs": 2,
  "test-lib-session": 1,
  "test-lib-backup": 1,
  "test-lib-stub-resolution": 1,
  "test-lib-hooks": 1,
  "test-lib-trash": 1,
  "test-lib-repo-files": 1,
  "test-lib-policy": 1,
  "test-lib-decide": 1,
  "test-lib-task-md": 0,
  "test-post-to-pav": 0,
  "test-install-hooks": 0,
  "test-lib-pane": 0,
  "test-lib-render": 0,
  "test-roots-isolation": 0,
  "test-lib-adapter": 0,
};

const nameOf = (f) => path.basename(f, ".js");
const ordered = suiteArgs.slice().sort((a, b) => {
  const da = SERIAL_SECONDS[nameOf(a)];
  const db = SERIAL_SECONDS[nameOf(b)];
  if (da === undefined || db === undefined) {
    if (da !== undefined) return -1;
    if (db !== undefined) return 1;
    return nameOf(a) < nameOf(b) ? -1 : 1;
  }
  return db - da || (nameOf(a) < nameOf(b) ? -1 : 1);
});

// Pool: half the machine's cores, floored at 2, capped at the suite count —
// the wall-minimizer of the 2026-11-17 post-split sweep (CHECK_JOBS 7/5/4
// back-to-back: 150/160/174 s walls), so the borrowed convention stayed as
// the measured winner. CHECK_JOBS lowers only: non-numeric or <2
// values are ignored, a raise clamps to the default. The bound is per
// invocation; nothing here limits concurrent check.sh runs.
const DEFAULT_POOL = Math.max(2, Math.floor(os.cpus().length / 2));
const requested = Number.parseInt(process.env.CHECK_JOBS ?? "", 10);
const defaultHere = Math.min(DEFAULT_POOL, ordered.length);
const jobsValid = Number.isFinite(requested) && requested >= 2;
const pool = jobsValid ? Math.min(defaultHere, requested) : defaultHere;
const poolNote = !jobsValid
  ? "half the cores — the measured wall-minimizer; CHECK_JOBS lowers only"
  : requested < defaultHere
    ? `CHECK_JOBS=${requested} lowers the default ${defaultHere}`
    : `CHECK_JOBS=${requested} clamped to the default`;
console.log(`suites=${ordered.length} pool=${pool} (${poolNote}) first=${nameOf(ordered[0])}`);

// The git common dir keys the repo-policies fixture (a worktree's common dir
// is the main checkout's .git, so the fixture trusts the main checkout — the
// same resolution check.sh performs for its own mkroot).
const gc = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
if (gc.status !== 0) {
  console.error("git rev-parse failed: " + gc.stderr);
  process.exit(2);
}
const COMMON_DIR = path.dirname(gc.stdout.trim());

function mkroot(d) {
  fs.mkdirSync(path.join(d, "home/.claude"), { recursive: true });
  fs.mkdirSync(path.join(d, "xdg"), { recursive: true });
  fs.mkdirSync(path.join(d, "guard"), { recursive: true });
  fs.mkdirSync(path.join(d, "home/.agents"), { recursive: true });
  fs.writeFileSync(path.join(d, "cfg.json"), "{}");
  fs.writeFileSync(path.join(d, "home/.agents/repo-policies.json"), JSON.stringify({ [COMMON_DIR]: "direct" }));
  fs.writeFileSync(path.join(d, "guard/zmx"),
    '#!/bin/sh\ncase "$1" in --version) echo "zmx 0.8.1"; exit 0;; list) exit 0;; esac\n' +
    'echo "zmx $*" >> \'' + d + '/guard.log\'; exit 97\n');
  fs.writeFileSync(path.join(d, "guard/claude"),
    '#!/bin/sh\necho "claude $*" >> \'' + d + '/guard.log\'; exit 97\n');
  fs.chmodSync(path.join(d, "guard/zmx"), 0o755);
  fs.chmodSync(path.join(d, "guard/claude"), 0o755);
  fs.writeFileSync(path.join(d, "guard.log"), "");
}

// The ten-variable env every suite runs under — what check.sh's `env -i` line
// carried: a throwaway HOME, the guard stubs first on PATH, the fixture
// config, and a git identity that never touches the real one.
function suiteEnv(st) {
  return {
    HOME: path.join(st, "home"),
    PATH: path.join(st, "guard") + ":" + process.env.PATH,
    AGENTS_CONFIG_PATH: path.join(st, "cfg.json"),
    XDG_CONFIG_HOME: path.join(st, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EDITOR: "true",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...(process.env.AGENTS_TEST_TIMING !== undefined ? { AGENTS_TEST_TIMING: process.env.AGENTS_TEST_TIMING } : {}),
  };
}

const CAPTURE_CAP = 256 * 1024; // per-suite output kept to the last 256 KiB — failure text is at the end
const verbose = !!process.env.CHECK_VERBOSE && process.env.CHECK_VERBOSE !== "0";
const running = new Map(); // child process -> record
let nextIdx = 0;
let fails = 0;
let stopping = false;
let trapSignum = 0;
const t0 = process.hrtime.bigint();
const elapsedMs = (from) => Number(process.hrtime.bigint() - from) / 1e6;

function finish() {
  console.log(`fails=${fails} wall=${(elapsedMs(t0) / 1000).toFixed(2)}s`);
  process.exit(fails > 0 ? 1 : 0);
}

function onSuiteDone(rec, exitLabel) {
  rec.done = true;
  if (rec.ceilingTimer) clearTimeout(rec.ceilingTimer);
  if (rec.silenceTimer) clearTimeout(rec.silenceTimer);
  running.delete(rec.child);
  // spawn= is the observed child-spawn latency: the launch-to-first-output
  // interval (fork + exec + node boot + module load + first test output); a
  // suite that writes nothing until exit reports the close time.
  const spawnMs = rec.firstOutAt !== null
    ? Number(rec.firstOutAt - rec.startedAt) / 1e6
    : elapsedMs(rec.startedAt);
  console.log(`${rec.name} exit=${exitLabel} ${(elapsedMs(rec.startedAt) / 1000).toFixed(2)}s spawn=${Math.round(spawnMs)}ms`);
  if (exitLabel !== 0 || verbose) {
    const text = rec.out.replace(/\n+$/, "");
    if (text) console.log(text);
  }
  if (exitLabel !== 0) fails++;
  launch();
  if (stopping && running.size === 0) process.exit(128 + trapSignum);
  if (!stopping && running.size === 0 && nextIdx >= ordered.length) finish();
}

// The two belts' shared kill path: a suite killed by either belt is TERM'd,
// then KILL'd after the same ~2 s grace the signal handler gives, and
// labelled timeout — the backstop for a suite that hangs instead of failing.
// The silence belt fires on the silence budget without output; the ceiling on
// the wall ceiling. onSuiteDone then fails the battery and prints the
// suite's captured output.
function onSuiteTimeout(rec, belt) {
  if (rec.done || stopping) return;
  rec.timedOut = true;
  const secs = Math.floor((belt === "silence" ? suiteSilenceMs : suiteCeilingMs) / 1000);
  console.log(belt === "silence"
    ? `${rec.name} went silent for ${secs}s — killing it`
    : `${rec.name} ran past its ${secs}s ceiling — killing it`);
  try { rec.child.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    if (!rec.done) { try { rec.child.kill("SIGKILL"); } catch {} }
  }, 2000);
}

function launch() {
  while (!stopping && running.size < pool && nextIdx < ordered.length) {
    const f = ordered[nextIdx++];
    const st = path.join(rootDir, nameOf(f));
    mkroot(st);
    const child = spawn("node", [f], { cwd: REPO_ROOT, env: suiteEnv(st) });
    const rec = { name: nameOf(f), child, out: "", firstOutAt: null, startedAt: process.hrtime.bigint(), done: false, timedOut: false };
    rec.ceilingTimer = setTimeout(() => onSuiteTimeout(rec, "ceiling"), suiteCeilingMs);
    rec.silenceTimer = setTimeout(() => onSuiteTimeout(rec, "silence"), suiteSilenceMs);
    const capture = (d) => {
      if (rec.firstOutAt === null) rec.firstOutAt = process.hrtime.bigint();
      rec.out += d;
      if (rec.out.length > CAPTURE_CAP) rec.out = rec.out.slice(rec.out.length - CAPTURE_CAP);
      // Every output chunk re-arms the silence clock — a streaming suite can
      // never out-silence the belt, at any load.
      clearTimeout(rec.silenceTimer);
      rec.silenceTimer = setTimeout(() => onSuiteTimeout(rec, "silence"), suiteSilenceMs);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    running.set(child, rec);
    child.on("error", (e) => {
      rec.spawnError = e;
      // 'close' follows a failed spawn in current node; if it never does, finish here.
      setImmediate(() => { if (!rec.done) onSuiteDone(rec, "spawn-error"); });
    });
    child.on("close", (code, signal) => {
      if (rec.done) return;
      onSuiteDone(rec, rec.timedOut ? "timeout" : rec.spawnError ? "spawn-error" : signal ? signal : code);
    });
  }
}

const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    trapSignum = SIGNUM[sig];
    for (const rec of running.values()) {
      console.log(`stopping: ${rec.name} ${rec.child.pid} ${(elapsedMs(rec.startedAt) / 1000).toFixed(1)}s`);
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    if (running.size === 0) process.exit(128 + trapSignum);
    setTimeout(() => {
      for (const rec of running.values()) {
        try { rec.child.kill("SIGKILL"); } catch {}
      }
      process.exit(128 + trapSignum);
    }, 2000);
  });
}

// Guard self-probe (check.sh used to run this inline): one probe root, the
// stubs must answer exit 97, and the root is removed before the fan-out so
// the caller's guard-hit scan never sees it.
{
  const probeRoot = path.join(rootDir, "probe");
  mkroot(probeRoot);
  const probe = spawnSync("zmx", ["check-guard-probe"], {
    env: { HOME: path.join(probeRoot, "home"), PATH: path.join(probeRoot, "guard") + ":" + process.env.PATH },
  });
  fs.rmSync(probeRoot, { recursive: true, force: true });
  if (probe.status !== 97) {
    console.error("guard self-test failed (expect exit 97), got: " + probe.status);
    process.exit(2);
  }
}

launch();
