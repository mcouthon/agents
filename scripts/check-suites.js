#!/usr/bin/env node
"use strict";

/**
 * The suite pool driver scripts/check.sh delegates its fan-out to: runs the
 * given suites in a bounded pool, longest recorded first, and streams each
 * suite's result line as it finishes.
 *
 * Usage: node scripts/check-suites.js <rootDir> [--suite-budget-ms=N] <suite.js>...
 *   <rootDir>  the caller's temp root; each suite runs under <rootDir>/<name>/
 *              (HOME, guard stubs, repo-policies fixture — byte-identical to
 *              check.sh's mkroot). The driver never removes <rootDir>: the
 *              caller's EXIT trap owns cleanup, and check.sh's guard-hit scan
 *              reads the per-suite guard logs after this process exits.
 *   suites     paths relative to the repo root (or absolute).
 *   --suite-budget-ms=N   replaces the per-suite wall budget — the private
 *              seam scripts/test-check-suites.js uses to exercise the kill
 *              causally at a tiny budget; not a user knob.
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
// Per-suite wall budget: a suite that outlives it is killed (TERM, then KILL
// after the signal handler's ~2 s grace) and labelled timeout — the backstop
// for a suite that hangs instead of failing (a missing node_modules once
// made a suite poll forever, silently, for hours). 180 s: the corpus's
// slowest real suite walls ~117 s under a full pool (test-lib-start —
// genuine `a start` cycles, 80 s solo), the third-slowest ~44 s, so 180 s is
// ~1.5x the worst with 4x over the rest — and a kill at 180 s plus the full
// drain (the battery walls ~124 s) still sits far inside the 850 s cap
// `a check`/`a land` impose, so the suite's own name and tail surface long
// before the outer cap flattens everything. --suite-budget-ms= shrinks it for
// the driver's own causal test only.
const DEFAULT_SUITE_TIMEOUT_MS = 180000;
let suiteBudgetMs = DEFAULT_SUITE_TIMEOUT_MS;
const suiteArgs = [];
for (const a of process.argv.slice(3)) {
  const m = /^--suite-budget-ms=(\d+)$/.exec(a);
  if (m) suiteBudgetMs = Number(m[1]);
  else suiteArgs.push(a);
}
if (!rootDir || suiteArgs.length === 0) {
  console.error("usage: node scripts/check-suites.js <rootDir> [--suite-budget-ms=N] <suite.js>...");
  process.exit(2);
}

// Launch order: longest recorded suite first. Integer seconds from the
// 2026-11-07 serial calibration (every suite run alone, 42/42 green);
// durations only need to stay stable enough to order. Regenerate by running
// each suite solo and sorting the per-suite `<name> exit=… <sec>s` lines
// descending. Suites missing from the table (new ones) launch after every
// tabled suite, alphabetical among themselves.
const SERIAL_SECONDS = {
  "test-lib-worktree": 20,
  "test-lib-start": 76,
  "test-engine-wait": 43,
  "test-lib-derive": 41,
  "test-install-snapshot": 39,
  "test-lib-roster": 38,
  "test-pane-send": 33,
  "test-lib-task": 24,
  "test-lib-checkout-env": 20,
  "test-lib-db-migrate": 17,
  "test-lib-verbs": 14,
  "test-lib-events": 13,
  "test-lib-hook-two": 12,
  "test-lib-land": 11,
  "test-lib-corpus": 8,
  "test-doctor": 7,
  "test-lib-db-import": 6,
  "test-lib-db": 6,
  "test-lib-ls-timing": 5,
  "test-cli-contract": 5,
  "test-lib-lock": 4,
  "test-lib-sweep": 4,
  "test-lib-trash": 4,
  "test-lib-advise": 3,
  "test-lib-hook-stubs": 3,
  "test-lib-check": 2,
  "test-lib-stub-resolution": 2,
  "test-hooks-session": 2,
  "test-mcp-adapter": 2,
  "test-state-server": 2,
  "test-surface-guard": 2,
  "test-task-probe": 2,
  "test-lib-decide": 1,
  "test-lib-policy": 1,
  "test-lib-repo-files": 1,
  "test-lib-repo": 1,
  "test-lib-session": 1,
  "test-lib-task-md": 1,
  "test-lib-adapter": 0,
  "test-lib-hooks": 0,
  "test-lib-render": 0,
  "test-install-hooks": 0,
  "test-post-to-pav": 0,
  "test-roots-isolation": 0,
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

// Pool: half the machine's cores, floored at 2, capped at the suite count — a
// convention borrowed from heavyweight-worker test runners, not a measurement
// for any particular machine. CHECK_JOBS lowers only: non-numeric or <2
// values are ignored, a raise clamps to the default. The bound is per
// invocation; nothing here limits concurrent check.sh runs.
const DEFAULT_POOL = Math.max(2, Math.floor(os.cpus().length / 2));
const requested = Number.parseInt(process.env.CHECK_JOBS ?? "", 10);
const defaultHere = Math.min(DEFAULT_POOL, ordered.length);
const jobsValid = Number.isFinite(requested) && requested >= 2;
const pool = jobsValid ? Math.min(defaultHere, requested) : defaultHere;
const poolNote = !jobsValid
  ? "half the cores — a convention, not a measurement; CHECK_JOBS lowers only"
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
  if (rec.timer) clearTimeout(rec.timer);
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

// The per-suite budget: a suite that outlives it is killed (TERM, then KILL
// after the same ~2 s grace the signal handler gives) and labelled timeout —
// the backstop for a suite that hangs instead of failing. onSuiteDone then
// fails the battery and prints the suite's captured output.
function onSuiteTimeout(rec) {
  if (rec.done || stopping) return;
  rec.timedOut = true;
  console.log(`${rec.name} ran past its ${Math.round(suiteBudgetMs / 1000)}s budget — killing it`);
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
    rec.timer = setTimeout(() => onSuiteTimeout(rec), suiteBudgetMs);
    const capture = (d) => {
      if (rec.firstOutAt === null) rec.firstOutAt = process.hrtime.bigint();
      rec.out += d;
      if (rec.out.length > CAPTURE_CAP) rec.out = rec.out.slice(rec.out.length - CAPTURE_CAP);
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
