"use strict";

// The worktree bootstrap: the record in the worktree's git dir is the state's
// home, `a setup run` is the one runner, and the bootstrap runs hosted in the
// engine's own Setup-<id8> zmx session (or in the caller's stdio when zmx is
// absent) — launched through the one verified path: the belt waits for the
// runner's pid to land, retries once, and a launch that does not take
// reconciles the record to failed, so no surface ever names a pane that is not
// hosting a live bootstrap. The runner recognizes its own launch record
// through the session's ZMX_SESSION, so the launcher's pre-launch record never
// reads as a competing bootstrap. Resolve, the runner, the verbs and prime's
// setup field behave identically on every hosting; the marker (setup-complete)
// keeps the run-once semantics that predate the record, and deleting it is the
// re-run gesture.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const LAUNCH_GRACE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 850000;
const DEFAULT_BELT_MS = 10000;
const TAIL_LINES = 5;

function fail(exitCode, message, code, detail) {
  const err = new Error(message);
  err.exitCode = exitCode;
  if (code) err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** The runner's own timeout, read per call so a test need not sleep the full window. */
function timeoutMs() {
  return parseInt(process.env.AGENTS_SETUP_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
}

/** The launch belt: how long one setup-launch attempt waits for the runner's pid. */
function beltMs() {
  return parseInt(process.env.AGENTS_SETUP_LAUNCH_BELT_MS, 10) || DEFAULT_BELT_MS;
}

function sleep(seconds) {
  execFileSync("/bin/sleep", [String(seconds)], { stdio: ["ignore", "ignore", "ignore"] });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function tryReal(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// The absolute `a` this engine runs: valid in a checkout and in the installed
// snapshot (~/.agents/bin/current) — both carry scripts/bin/a.
function aPath() {
  return path.join(__dirname, "..", "bin", "a");
}

/** Marker, record and log paths inside the worktree's git dir (nulls when the path is not a repo). */
function pathsFor(wtPath) {
  try {
    const gitdir = execFileSync("git", ["-C", wtPath, "rev-parse", "--absolute-git-dir"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
    return { gitdir, marker: path.join(gitdir, "setup-complete"), record: path.join(gitdir, "setup.json"), log: path.join(gitdir, "setup.log") };
  } catch {
    return { gitdir: null, marker: null, record: null, log: null };
  }
}

/**
 * The raw record: parsed, null when absent, `{torn: true}` when a writer is
 * mid-write — a torn read reads as pending, never as absent.
 */
function readRecord(p) {
  if (!p.record) return null;
  let raw;
  try { raw = fs.readFileSync(p.record, "utf8"); } catch { return null; }
  try { return JSON.parse(raw); } catch { return { torn: true }; }
}

function writeRecord(p, fields) {
  fs.writeFileSync(p.record, JSON.stringify(fields, null, 2) + "\n");
}

/** Merge fields into the existing record (the engine's pane patches). */
function patchRecord(wtPath, fields) {
  const p = pathsFor(wtPath);
  if (!p.record) return;
  const rec = readRecord(p) || {};
  writeRecord(p, { ...rec, ...fields });
}

function tailOf(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-TAIL_LINES).join("\n");
  } catch {
    return null;
  }
}

/** zmx facts for the belt check, fetched only when a pid-less record needs them. */
function zmxFacts() {
  try {
    return require("./start").zmxSessions();
  } catch {
    return null;
  }
}

/**
 * The worktree's setup state, from the marker and the record:
 * `none | pending | complete | failed` (+ the record's fields, the marker and
 * log paths). `opts.zmx` is a zmxSessions-shaped list — a fresh one is
 * fetched only when a pid-less pending record needs the belt check; `null`
 * means no zmx facts (the belt is then granted inside the grace, never
 * disproved). The marker is the completion truth: a completed record without
 * it reads as nothing (the re-run gesture), a pending record without a live
 * pid as failed — "the pane is gone" when the pid died, "the runner never
 * started" when none ever landed. PAV's roster row is never consulted: the
 * record's pid, and inside the launch gap the pane's session in the zmx
 * list, is the truth.
 */
function resolve(wtPath, opts = {}) {
  const p = pathsFor(wtPath);
  const base = {
    state: "none", command: null, pane: null, pane_kind: null, pav_terminal_id: null, pid: null,
    started_at: null, finished_at: null, exit_code: null, error: null, tail: null,
    marker: p.marker, log: p.log,
  };
  if (!p.gitdir) return base;
  const rec = readRecord(p);
  if (!rec) {
    return fs.existsSync(p.marker) ? { ...base, state: "complete" } : base;
  }
  const out = {
    ...base,
    command: rec.command !== undefined ? rec.command : null,
    pane: rec.pane !== undefined ? rec.pane : null,
    pane_kind: rec.pane_kind !== undefined ? rec.pane_kind : null,
    pav_terminal_id: rec.pav_terminal_id !== undefined ? rec.pav_terminal_id : null,
    pid: rec.pid !== undefined ? rec.pid : null,
    started_at: rec.started_at !== undefined ? rec.started_at : null,
    finished_at: rec.finished_at !== undefined ? rec.finished_at : null,
    exit_code: rec.exit_code !== undefined ? rec.exit_code : null,
    error: rec.error !== undefined ? rec.error : null,
    tail: rec.tail !== undefined ? rec.tail : null,
  };
  // The marker is the completion truth; the record's completed fields ride
  // along for status when the record itself says complete (a pending or
  // failed record under a hand-planted marker stays bare).
  if (fs.existsSync(p.marker)) {
    return rec.torn || rec.state === "complete" ? { ...out, state: "complete" } : { ...base, state: "complete" };
  }
  if (rec.torn) return { ...out, state: "pending" };
  if (rec.state === "failed") return { ...out, state: "failed" };
  if (rec.state !== "pending" && rec.state !== "complete") return base;
  if (rec.state === "complete") return base; // the marker is the completion truth; its absence means re-run
  const isPidAlive = require("./session").isPidAlive;
  if (out.pid && isPidAlive(out.pid)) return { ...out, state: "pending" };
  if (out.pid) return { ...out, state: "failed", error: out.error || "the pane is gone" };
  // The pid never landed: the launch-gap belt — the pane's session in the zmx
  // list, listed and not ended (a pane that died without a pid is a launch
  // that did not take, not a launch in progress), inside the grace. The launch
  // gap is seconds; past the grace, a pid that has not landed never will (a
  // lost line or a launch crash — the next start relaunches).
  const startedAt = out.started_at ? Date.parse(out.started_at) : NaN;
  const withinGrace = !isNaN(startedAt) && Date.now() - startedAt <= LAUNCH_GRACE_MS;
  let zmx = opts.zmx;
  if (zmx === undefined) zmx = zmxFacts();
  const panePresent = !out.pane || zmx === null || (zmx || []).some((z) => z.name === out.pane && !z.ended);
  if (withinGrace && panePresent) return { ...out, state: "pending" };
  return { ...out, state: "failed", error: "the runner never started" };
}

/**
 * The bootstrap runner: `a setup run <worktree>`, hosted in a pane or run by
 * hand. Refuses a path that is not a non-main worktree, an already-complete
 * setup (delete the marker to re-run) and a live second bootstrap (the
 * double-run guard, naming the pane — except the launcher's own launch-gap
 * record, recognized through the session's ZMX_SESSION); then records its pid
 * as its first act, streams the command through tee into the log with the
 * clean-base env, and records the outcome — the marker on success, the exit
 * code and tail on failure, `exit_code: null` + `error` when the run did not
 * complete.
 * @returns {{state: "complete"|"failed", exit_code: number|null, error?: string, tail?: string, marker: string, log: string}}
 */
function run(wtPath) {
  const key = require("./repo").repoKey(wtPath);
  if (tryReal(wtPath) === tryReal(key.main_root)) {
    throw fail(2, `${wtPath} is not a worktree (it is the repo's main checkout); a setup runs in a task worktree`, "not_a_worktree",
      { remedy: "pass a worktree path — `a start <task> --worktree` creates one" });
  }
  const p = pathsFor(wtPath);
  if (!p.gitdir) {
    throw fail(2, `${wtPath} is not inside a git repository`, "not_a_worktree",
      { remedy: "pass a worktree path — `a start <task> --worktree` creates one" });
  }
  const command = require("./start").setupCommand(key);
  if (!command) {
    throw fail(2, `no setup command is configured for ${key.key}; add repos["${key.key}"].setup in ~/.agents/config.json`, "setup_unconfigured",
      { remedy: "configure repos[origin].setup, or run the bootstrap by hand" });
  }
  const st = resolve(wtPath, {});
  if (st.state === "complete") {
    throw fail(2, `the worktree's setup is already complete (the marker exists); delete it to re-run: rm ${p.marker}`, "setup_complete",
      { remedy: `delete the marker to re-run: rm ${p.marker}` });
  }
  if (st.state === "pending") {
    // The launcher's own record: the runner was exec'd into the very session
    // the pending record names (its ZMX_SESSION) before its pid could land —
    // that is this launch, not a competing bootstrap. Everything else is the
    // guard's purpose: a live pid (a real concurrent bootstrap), or a hand
    // runner outside the pane during a genuine launch gap.
    const ownLaunch = !st.pid && st.pane && process.env.ZMX_SESSION === st.pane;
    if (!ownLaunch) {
      const where = st.pane ? `pane ${st.pane}` : `pid ${st.pid}`;
      throw fail(2, `a setup is already running in ${wtPath} (${where}); wait for it: a setup wait ${wtPath}`, "setup_running",
        { remedy: `wait for it (\`a setup wait ${wtPath}\`) or inspect it: a setup status ${wtPath}` });
    }
  }
  const prev = readRecord(p) || {};
  const rec = {
    v: 1, state: "pending", command,
    pane_kind: prev.pane_kind || null, pane: prev.pane || null, pav_terminal_id: prev.pav_terminal_id || null,
    pid: process.pid, log: p.log, started_at: new Date().toISOString(),
  };
  fs.writeFileSync(p.log, "");
  writeRecord(p, rec);
  // The subshell scopes a multi-statement command's whole output into the
  // pipe (a bare `a; b` would leave everything but the last statement on the
  // caller's stdio); pipefail preserves the command's own status through it.
  const wrapped = `set -o pipefail; ( ${command} ) 2>&1 | tee ${shellQuote(p.log)}`;
  const r = spawnSync("zsh", ["-c", wrapped], {
    cwd: wtPath, stdio: ["ignore", "inherit", "inherit"],
    env: require("./checkout-env").setupEnv(), timeout: timeoutMs(),
  });
  const tail = tailOf(p.log);
  const finishedAt = new Date().toISOString();
  if (r.error) {
    writeRecord(p, { ...rec, state: "failed", exit_code: null, error: r.error.message, finished_at: finishedAt, tail });
    return { state: "failed", exit_code: null, error: r.error.message, tail, marker: p.marker, log: p.log };
  }
  if (r.status === null) {
    const error = `killed by ${r.signal || "an unknown signal"}`;
    writeRecord(p, { ...rec, state: "failed", exit_code: null, error, finished_at: finishedAt, tail });
    return { state: "failed", exit_code: null, error, tail, marker: p.marker, log: p.log };
  }
  if (r.status === 0) {
    try { fs.writeFileSync(p.marker, ""); } catch {}
    writeRecord(p, { ...rec, state: "complete", exit_code: 0, finished_at: finishedAt, tail });
    return { state: "complete", exit_code: 0, tail, marker: p.marker, log: p.log };
  }
  writeRecord(p, { ...rec, state: "failed", exit_code: r.status, finished_at: finishedAt, tail });
  return { state: "failed", exit_code: r.status, tail, marker: p.marker, log: p.log };
}

/** The resolved state for `a setup status` — never throws, always exits 0. */
function statusOf(wtPath) {
  return resolve(wtPath, {});
}

/**
 * `a setup wait`: poll the record and marker every 500 ms — complete exits 0,
 * failed exits 1 (the record's exit code, error and tail ride along), a
 * budget that expires while still pending exits 3. The default budget is the
 * runner's own timeout in seconds.
 */
function wait(wtPath, timeoutSec) {
  const knob = parseInt(process.env.AGENTS_SETUP_TIMEOUT_MS, 10);
  const budgetSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : (knob ? Math.max(1, Math.round(knob / 1000)) : DEFAULT_TIMEOUT_MS / 1000);
  const deadline = Date.now() + budgetSec * 1000;
  for (;;) {
    const st = resolve(wtPath, {});
    if (st.state === "complete") return { state: "complete", exitCode: 0 };
    if (st.state === "failed") {
      return { state: "failed", exitCode: 1, exit_code: st.exit_code, error: st.error, tail: st.tail, pane: st.pane, marker: st.marker, log: st.log };
    }
    if (Date.now() + 500 >= deadline) return { state: st.state, exitCode: 3, pane: st.pane };
    sleep(0.5);
  }
}

/** Write the pending record, naming the hosting pane before the pane's process exists — a crash mid-launch never hides a pending bootstrap. */
function begin(wtPath, { command, paneKind, pane }) {
  const p = pathsFor(wtPath);
  if (!p.record) {
    throw fail(2, `cannot locate the worktree's git dir for ${wtPath}`, "no_gitdir",
      { remedy: "pass a worktree of the repo" });
  }
  writeRecord(p, {
    v: 1, state: "pending", command,
    pane_kind: paneKind || null, pane: pane || null, pav_terminal_id: null,
    pid: null, log: p.log, started_at: new Date().toISOString(),
  });
  return p;
}

/**
 * The one launch path: name the pane in the record, `zmx run` the runner into
 * the engine's own Setup session, and verify the launch with the belt — the
 * runner's pid landing, or the record leaving pending (a bootstrap that
 * finishes — or fails — inside the belt still proves the launch took). zmx's
 * run contract is fire-and-forget (exit 0 means the line was sent, never that
 * it ran, and a session whose process exits leaves `zmx ls` entirely), so the
 * belt is the only proof a pane is really hosting the bootstrap. One retry
 * with the same pane name (an idle first session receives the second line; a
 * dead one frees the name), then a double expiry reconciles the record to
 * failed — no surface may claim a running pane for a launch that did not
 * take. A send fault before any launch was verified returns `spawn` (nothing
 * exists: the pane never entered the list, so the record resolves failed and
 * the caller's in-process fallback is safe); on the retry it joins the
 * belt's reconciliation instead — a record still pending is exactly what
 * that fallback's double-run guard refuses. The record must already say
 * pending (the caller's begin).
 * @returns {{launched: true, live: boolean, pane: string}|{launched: false, why: "belt"}|{launched: false, why: "spawn", detail: string}}
 */
function launchZmxSession(wt, { pane }) {
  patchRecord(wt, { pane_kind: "zmx", pane, pav_terminal_id: null });
  const runLine = () => spawnSync("zmx", ["run", pane, "-d", "exec", process.execPath, aPath(), "setup", "run", wt],
    { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
  const faultOf = (r) => r.error ? r.error.message : (r.stderr || "").trim() || `exit ${r.status}`;
  let retryFault = null; // the retry's own send fault, named in the did-not-take record
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = runLine();
    if (r.error || r.status !== 0) {
      if (attempt === 0) return { launched: false, why: "spawn", detail: faultOf(r) };
      // A send fault on the retry follows a belt expiry: the launch did not
      // take, and a record still pending is what the caller's in-process
      // fallback refuses as a double-run — reconcile it with the belt instead.
      retryFault = faultOf(r);
      break;
    }
    const deadline = Date.now() + beltMs();
    for (;;) {
      const rec = readRecord(pathsFor(wt));
      if (rec && !rec.torn && rec.state !== "pending") return { launched: true, live: false, pane };
      if (rec && rec.pid) return { launched: true, live: true, pane };
      if (Date.now() >= deadline) break;
      sleep(0.25);
    }
  }
  const error = retryFault
    ? `the launch did not take — the runner's pid never landed; the retry's zmx run failed: ${retryFault}`
    : "the launch did not take — the runner's pid never landed";
  patchRecord(wt, { state: "failed", error, finished_at: new Date().toISOString() });
  return { launched: false, why: "belt" };
}

/**
 * Best-effort teardown of the setup session a failed start owns, before the
 * force-remove: zmx-kill its session (the exec'd runner goes down with it), so
 * no bootstrap ever writes into a removed tree. Throws when the kill fails —
 * the rollback's warn names it.
 */
function stopPane(setup) {
  if (!setup || !setup.pane) return;
  const r = spawnSync("zmx", ["kill", setup.pane], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error || r.status !== 0) {
    throw new Error(r.error ? r.error.message : `zmx kill ${setup.pane} failed (exit ${r.status})`);
  }
}

module.exports = { resolve, run, wait, statusOf, begin, patchRecord, launchZmxSession, stopPane, pathsFor, aPath, timeoutMs };
