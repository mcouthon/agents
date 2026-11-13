"use strict";

// The worktree bootstrap: the record in the worktree's git dir is the state's
// home, `a setup run` is the one runner, and the hosting ladder picks only
// where the bootstrap's process lives — a PAV pane (created through PAV's
// terminal API, the runner injected into its shell), the engine's own
// Setup-<id8> zmx session, or the caller's own stdio. Resolve, the runner,
// the verbs and prime's setup field behave identically on every rung; the
// marker (setup-complete) keeps the run-once semantics that predate the
// record, and deleting it is the re-run gesture.

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

function warn(message) {
  process.stderr.write(message + "\n");
}

/** The runner's own timeout, read per call so a test need not sleep the full window. */
function timeoutMs() {
  return parseInt(process.env.AGENTS_SETUP_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
}

/** The launch belt: how long a PAV-pane launch waits for the runner's pid. */
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
  // list, inside the grace. The launch gap is seconds; past the grace, a pid
  // that has not landed never will (a lost injected line or a launch crash —
  // the next start relaunches).
  const startedAt = out.started_at ? Date.parse(out.started_at) : NaN;
  const withinGrace = !isNaN(startedAt) && Date.now() - startedAt <= LAUNCH_GRACE_MS;
  let zmx = opts.zmx;
  if (zmx === undefined) zmx = zmxFacts();
  const panePresent = !out.pane || zmx === null || (zmx || []).some((z) => z.name === out.pane);
  if (withinGrace && panePresent) return { ...out, state: "pending" };
  return { ...out, state: "failed", error: "the runner never started" };
}

/**
 * The bootstrap runner: `a setup run <worktree>`, hosted in a pane or run by
 * hand. Refuses a path that is not a non-main worktree, an already-complete
 * setup (delete the marker to re-run) and a live second bootstrap (the
 * double-run guard, naming the pane); then records its pid as its first act,
 * streams the command through tee into the log with the clean-base env, and
 * records the outcome — the marker on success, the exit code and tail on
 * failure, `exit_code: null` + `error` when the run did not complete.
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
    const where = st.pane ? `pane ${st.pane}` : `pid ${st.pid}`;
    throw fail(2, `a setup is already running in ${wtPath} (${where}); wait for it: a setup wait ${wtPath}`, "setup_running",
      { remedy: `wait for it (\`a setup wait ${wtPath}\`) or inspect it: a setup status ${wtPath}` });
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

/** Write the pending record before any pane exists — a crash mid-launch never hides a pending bootstrap. */
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

/** One sync curl against PAV's terminal API in postToPav's shape; the HTTP code rides the body's tail. */
function pavPaneRequest(method, port, pathTail, data) {
  const url = `http://localhost:${port}/api/coding/terminals${pathTail}`;
  const args = ["-s", "-w", "\n%{http_code}", "-X", method, "-H", "Content-Type: application/json"];
  if (data !== undefined) args.push("-d", data);
  args.push("--connect-timeout", "1", "--max-time", "2", url);
  try {
    const out = execFileSync("curl", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    const parts = out.split("\n");
    const code = Number(parts.pop());
    return { ok: Number.isInteger(code) && code >= 200 && code < 300, code, body: parts.join("\n") };
  } catch (err) {
    return { ok: false, code: null, body: "", why: err.message };
  }
}

/** The raw chunked inject: a settle beat for the login shell, then ~200-char
 * chunks ~0.3 s apart through `zmx send` (pane-send cannot target this pane —
 * it requires an engine registration claiming the name). */
function injectLine(pane, line) {
  sleep(1);
  const text = line + "\r";
  const size = 200;
  for (let i = 0; i < text.length; i += size) {
    if (i > 0) sleep(0.3);
    const r = spawnSync("zmx", ["send", pane], {
      input: text.slice(i, i + size), encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : (r.stderr || "").trim() || `exit ${r.status}`;
      throw fail(1, `zmx send failed for ${pane}: ${why}`, "send_failed");
    }
  }
}

/**
 * Rung 1 of the hosting ladder: create the pane through PAV's terminal API,
 * patch the record with its identity, inject the runner into its shell and
 * confirm the launch with the belt (the record's pid landing, or a
 * non-pending state — a fast bootstrap may complete inside the belt). The
 * record must already say pending (the caller's begin). A hosting refusal
 * never fails the start: a refused POST, a send error or a belt expiry
 * returns `{launched: false}` — with the pane deleted when one was created —
 * and the caller drops to rung 2.
 * @returns {{launched: true, pane: string, pavId: string}|{launched: false, why: string}}
 */
function launchPavPane({ wt, port }) {
  const post = pavPaneRequest("POST", port, "", JSON.stringify({ agent: "shell", cwd: path.resolve(wt) }));
  if (!post.ok) return { launched: false, why: post.code === null ? "pav is unreachable" : `pav answered ${post.code}` };
  let paneInfo = null;
  try { paneInfo = JSON.parse(post.body); } catch { paneInfo = null; }
  if (!paneInfo || !paneInfo.session_name || paneInfo.id === undefined || paneInfo.id === null) {
    return { launched: false, why: "pav answered without a terminal" };
  }
  const pane = String(paneInfo.session_name);
  const pavId = String(paneInfo.id);
  patchRecord(wt, { pane_kind: "pav", pane, pav_terminal_id: pavId });
  const dropPane = () => {
    const del = pavPaneRequest("DELETE", port, `/${encodeURIComponent(pavId)}`);
    if (!del.ok) warn(`worktree setup: could not remove the PAV pane ${pane} (DELETE answered ${del.code === null ? "nothing" : del.code}) — close it in the workspace`);
  };
  try {
    injectLine(pane, `exec ${aPath()} setup run ${path.resolve(wt)}`);
  } catch (err) {
    dropPane();
    return { launched: false, why: err.message };
  }
  const deadline = Date.now() + beltMs();
  for (;;) {
    const rec = readRecord(pathsFor(wt));
    if (rec && !rec.torn && rec.state !== "pending") return { launched: true, pane, pavId };
    if (rec && rec.pid) return { launched: true, pane, pavId };
    if (Date.now() >= deadline) break;
    sleep(0.25);
  }
  dropPane();
  return { launched: false, why: "the injected line did not start the runner" };
}

/**
 * Best-effort teardown of the setup pane a failed start owns, before the
 * force-remove: DELETE the PAV terminal (its zmx session and the exec'd
 * runner go with it), and when the DELETE fails — or no port is configured —
 * zmx-kill the pane's session, which the kill can still reach, so a failed
 * DELETE never leaves a bootstrap writing into the removed tree. Throws only
 * when the kill fails too — the rollback's warn names it.
 */
function stopPane(setup) {
  if (!setup) return;
  if (setup.kind === "pav" && setup.pavId) {
    const port = ((require("./config").loadConfig().pav || {}).port);
    if (port) {
      const r = pavPaneRequest("DELETE", port, `/${encodeURIComponent(setup.pavId)}`);
      if (r.ok) return;
    }
  }
  if (setup.pane) {
    const r = spawnSync("zmx", ["kill", setup.pane], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    if (r.error || r.status !== 0) {
      throw new Error(r.error ? r.error.message : `zmx kill ${setup.pane} failed (exit ${r.status})`);
    }
  }
}

module.exports = { resolve, run, wait, statusOf, begin, patchRecord, launchPavPane, stopPane, pathsFor, aPath, timeoutMs };
