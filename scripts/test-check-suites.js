#!/usr/bin/env node
"use strict";
// The check-suites driver's own suite: drives the driver's CLI against tiny
// fixture suites in this test's temp dir — never scripts/check.sh itself, so
// no run ever recurses into the real suite pool. The driver's knobs reach it
// through the child env (CHECK_JOBS), not argv.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const DRIVER = path.join(__dirname, "check-suites.js");
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-check-suites-")));
const FIXTURES = path.join(T, "fixtures");
fs.mkdirSync(FIXTURES);

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

// A fixture runs under the driver's suite env (HOME = <root>/<name>/home), so
// a start marker written to HOME lands inside the root the driver was given.
const MARK = 'require("fs").writeFileSync(require("path").join(process.env.HOME, "started"), String(Date.now()));';
function fixture(name, body) {
  const p = path.join(FIXTURES, name + ".js");
  fs.writeFileSync(p, body + "\n");
  return p;
}
const markerOf = (root, name) => {
  const p = path.join(root, name, "home", "started");
  return fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : null;
};

// Hermetic child env: the driver's own knobs are unset unless a scenario
// sets them, so an exported CHECK_JOBS/AGENTS_TEST_TIMING in the surrounding
// run cannot leak into the driver under test.
function childEnv(extra = {}) {
  const e = { ...process.env, ...extra };
  for (const k of ["CHECK_JOBS", "CHECK_VERBOSE", "AGENTS_TEST_TIMING"]) {
    if (!(k in extra)) delete e[k];
  }
  return e;
}
function runDriver(fixtures, extra = {}, flags = []) {
  const root = fs.mkdtempSync(path.join(T, "run-"));
  const r = spawnSync(process.execPath, [DRIVER, root, ...flags, ...fixtures], { encoding: "utf8", env: childEnv(extra) });
  return { root, status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const headerOf = (out) => {
  const m = out.split("\n")[0].match(/^suites=(\d+) pool=(\d+) \((.+)\) first=(\S+)$/);
  return m ? { suites: Number(m[1]), pool: Number(m[2]), note: m[3], first: m[4] } : null;
};

const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => fixture("pool-" + c, 'console.log("ok");'));
const aSlow = fixture("a-slow", 'console.log("slow"); setTimeout(() => process.exit(0), 400);');
const bFast = fixture("b-fast", 'console.log("fast");');
const boom = fixture("boom", 'console.log("boom output line"); process.exit(3);');
const sleepBody = 'require("fs").writeFileSync(require("path").join(process.env.HOME, "armed"), "1");\nsetTimeout(() => {}, 120000);';
const oA = fixture("o-a", `${MARK}\nsetTimeout(() => process.exit(0), 400);`);
const oB = fixture("o-b", `${MARK}\nsetTimeout(() => process.exit(0), 400);`);
const oC = fixture("o-c", `${MARK}`);
const tFlag = fixture("t-flag", 'console.log("timing=" + (process.env.AGENTS_TEST_TIMING === undefined ? "unset" : process.env.AGENTS_TEST_TIMING)); process.exit(1);');

let trapChild = null;

async function main() {
  // Pool semantics: the header's pool= is half the cores floored at 2 and
  // capped at the suite count; CHECK_JOBS lowers only, never raises.
  const defaultPool = Math.min(Math.max(2, Math.floor(os.cpus().length / 2)), eight.length);
  {
    const r = runDriver(eight);
    const h = headerOf(r.out);
    check(h && h.suites === 8 && h.pool === defaultPool,
      `pool: unset runs at half the cores, floored at 2, capped at the suite count (pool=${h && h.pool}, expected ${defaultPool})`);
    check(h && h.note === "half the cores — a convention, not a measurement; CHECK_JOBS lowers only",
      "pool: the default header labels the number a convention");
    check(h && h.first === "pool-a", `pool: the header names the first-launched suite (${h && h.first})`);
    check(r.status === 0, `pool: the all-passing run exits 0 (${r.status})`);
  }
  {
    const r = runDriver(eight, { CHECK_JOBS: "2" });
    const h = headerOf(r.out);
    check(h && h.pool === 2, `pool: CHECK_JOBS=2 lowers the pool to 2 (pool=${h && h.pool})`);
  }
  {
    const r = runDriver(eight, { CHECK_JOBS: "1" });
    const h = headerOf(r.out);
    check(h && h.pool === defaultPool, `pool: CHECK_JOBS below the floor is ignored (pool=${h && h.pool}, expected ${defaultPool})`);
  }
  {
    const r = runDriver(eight, { CHECK_JOBS: "99" });
    const h = headerOf(r.out);
    check(h && h.pool === defaultPool && h.note === "CHECK_JOBS=99 clamped to the default",
      `pool: a raise attempt clamps to the default and says so (pool=${h && h.pool}, note=${h && h.note})`);
  }
  {
    const r = runDriver(eight, { CHECK_JOBS: "bogus" });
    const h = headerOf(r.out);
    check(h && h.pool === defaultPool, `pool: a non-numeric CHECK_JOBS is ignored (pool=${h && h.pool})`);
  }

  // Streaming: result lines print in completion order, not launch order.
  {
    const r = runDriver([aSlow, bFast]);
    const fast = r.out.match(/^b-fast exit=0 [\d.]+s spawn=\d+ms$/m);
    const slow = r.out.match(/^a-slow exit=0 [\d.]+s spawn=\d+ms$/m);
    check(r.status === 0, `streaming: the two-fixture run exits 0 (${r.status})`);
    check(!!fast && !!slow, "streaming: both result lines carry exit=, a duration and spawn=");
    const fastAt = r.out.indexOf("b-fast exit=");
    const slowAt = r.out.indexOf("a-slow exit=");
    check(fastAt >= 0 && slowAt >= 0 && fastAt < slowAt,
      "streaming: the immediate suite's line prints before the sleeping first-launched one (completion order)");
    const h = headerOf(r.out);
    check(h && h.first === "a-slow", `streaming: the header names the sleeping suite as first-launched (${h && h.first})`);
  }

  // Aggregation: one failing fixture fails the run, its line says exit=3, its
  // captured output prints, and the summary counts it.
  {
    const r = runDriver([boom]);
    check(r.status === 1, `aggregation: a failing fixture fails the whole run (${r.status})`);
    check(/^boom exit=3 [\d.]+s spawn=\d+ms$/m.test(r.out), "aggregation: the failing line reads exit=3");
    check(r.out.includes("boom output line"), "aggregation: the failing fixture's captured output prints");
    check(/^fails=1 wall=[\d.]+s$/m.test(r.out), "aggregation: the summary line counts the failure");
  }

  // Order consistency: with CHECK_JOBS=2 over three untabled fixtures, the
  // first two (alphabetical) take the pool's slots and the third waits —
  // proven by start markers, which only grow later under load.
  {
    const r = runDriver([oA, oB, oC], { CHECK_JOBS: "2" });
    const h = headerOf(r.out);
    check(h && h.first === "o-a", `order: the header's first= names the alphabetically-first untabled suite (${h && h.first})`);
    const aAt = markerOf(r.root, "o-a"), bAt = markerOf(r.root, "o-b"), cAt = markerOf(r.root, "o-c");
    check(aAt !== null && bAt !== null && cAt !== null, "order: all three fixtures ran and wrote start markers");
    check(cAt - aAt >= 250,
      `order: the third fixture waits for a free slot while the first two run (${cAt - aAt} ms after the first)`);
    check(r.status === 0, `order: the bounded run exits 0 (${r.status})`);
  }

  // The trap: a sleeping fixture plus SIGTERM to the driver mid-run.
  {
    const root = fs.mkdtempSync(path.join(T, "trap-"));
    trapChild = spawn(process.execPath, [DRIVER, root, fixture("zz-sleep", sleepBody)], { env: childEnv() });
    let out = "";
    trapChild.stdout.on("data", (d) => { out += d; });
    trapChild.stderr.on("data", (d) => { out += d; });
    const armed = path.join(root, "zz-sleep", "home", "armed");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(armed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    check(fs.existsSync(armed), "trap: the sleeping fixture is running under the driver");
    const termAt = Date.now();
    trapChild.kill("SIGTERM");
    const code = await new Promise((resolve) => trapChild.on("close", resolve));
    check(code === 143, `trap: the driver exits 128+signum on SIGTERM (${code})`);
    check(Date.now() - termAt < 2500, `trap: the driver stops within ~2 s of the signal (${Date.now() - termAt} ms)`);
    const stop = out.match(/^stopping: zz-sleep (\d+) ([\d.]+)s$/m);
    check(!!stop, `trap: a stopping line names the suite, its pid and its elapsed time (${JSON.stringify(out.split("\n").filter(Boolean))})`);
    if (stop) {
      const pid = Number(stop[1]);
      let gone = false;
      for (let i = 0; i < 15 && !gone; i++) {
        try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { gone = true; }
      }
      check(gone, `trap: the sleeping fixture (pid ${pid}) is killed via the tracked pid`);
    }
    check(fs.existsSync(armed), "trap: the driver leaves the caller's temp root in place (the caller owns cleanup)");
    trapChild = null;
  }

  // The outer ceiling: a hanging fixture is killed at the ceiling, its line
  // reads exit=timeout, the run fails with the captured output, and the
  // sibling suite still completes. The ceiling is shrunk through the driver's
  // private argv seam, so no clock is read.
  {
    const hang = fixture("zz-hang", sleepBody + 'console.log("hang-tail");');
    const sibling = fixture("zz-ok", 'console.log("ok-tail");');
    const r = runDriver([hang, sibling], {}, ["--suite-budget-ms=2000"]);
    check(r.status === 1, `ceiling: a suite that hangs fails the run (${r.status})`);
    check(/zz-hang ran past its 2s ceiling/.test(r.out), "ceiling: the kill line names the suite and its ceiling");
    check(/^zz-hang exit=timeout [\d.]+s spawn=\d+ms$/m.test(r.out), "ceiling: the killed suite's result line reads exit=timeout");
    check(/^zz-ok exit=0 [\d.]+s spawn=\d+ms$/m.test(r.out), "ceiling: the sibling suite still completes");
    check(r.out.includes("hang-tail"), "ceiling: the killed suite's captured output prints");
    check(/^fails=1 wall=[\d.]+s$/m.test(r.out), "ceiling: the summary counts the killed suite");
  }

  // The silence belt: a fixture that prints once then hangs goes silent and is
  // killed at the silence bound — the hang's signature, which load cannot
  // fake (a load-slowed suite still streams; the next block proves it).
  {
    const quiet = fixture("zz-quiet", sleepBody + 'console.log("quiet-tail");');
    const sibling = fixture("zz-ok2", 'console.log("ok-tail2");');
    const r = runDriver([quiet, sibling], {}, ["--suite-silence-ms=500"]);
    check(r.status === 1, `silence: a suite that goes quiet fails the run (${r.status})`);
    check(/zz-quiet went silent for 0s/.test(r.out), "silence: the kill line names the suite and its silence bound");
    check(/^zz-quiet exit=timeout [\d.]+s spawn=\d+ms$/m.test(r.out), "silence: the killed suite's result line reads exit=timeout");
    check(/^zz-ok2 exit=0 [\d.]+s spawn=\d+ms$/m.test(r.out), "silence: the sibling suite still completes");
    check(r.out.includes("quiet-tail"), "silence: the killed suite's captured output prints");
    check(/^fails=1 wall=[\d.]+s$/m.test(r.out), "silence: the summary counts the killed suite");
  }

  // Output resets the silence clock: a fixture that streams every 100 ms
  // survives a 500 ms silence bound (tick 6 is past it) and dies only at the
  // ceiling — one run proving the reset and the two belts' independence.
  {
    const stream = fixture("zz-stream",
      'let n = 0;\nconst t = setInterval(() => { console.log("tick " + (++n)); }, 100);\nsetTimeout(() => {}, 2000);');
    const r = runDriver([stream], {}, ["--suite-silence-ms=500", "--suite-budget-ms=1500"]);
    check(r.status === 1, `reset: a streaming suite that never exits fails the run at the ceiling (${r.status})`);
    check(r.out.includes("tick 6"), "reset: the streamer printed past the 500 ms silence bound (output resets the clock)");
    check(/zz-stream ran past its 1s ceiling/.test(r.out), "reset: the kill comes from the ceiling belt, not the silence belt");
    check(/^zz-stream exit=timeout [\d.]+s spawn=\d+ms$/m.test(r.out), "reset: the killed suite's result line reads exit=timeout");
    check(/^fails=1 wall=[\d.]+s$/m.test(r.out), "reset: the summary counts the killed suite");
  }

  // A suite silent from birth (the missing-node_modules class) dies at the
  // silence belt without ever emitting a byte.
  {
    const born = fixture("zz-born-silent", 'setTimeout(() => {}, 120000);');
    const r = runDriver([born], {}, ["--suite-silence-ms=300"]);
    check(r.status === 1, `birth-silent: a suite that never prints fails the run (${r.status})`);
    check(/zz-born-silent went silent for 0s/.test(r.out), "birth-silent: the silence belt kills a suite that emitted no byte");
    check(/^zz-born-silent exit=timeout [\d.]+s spawn=\d+ms$/m.test(r.out), "birth-silent: the killed suite's result line reads exit=timeout");
    check(/^fails=1 wall=[\d.]+s$/m.test(r.out), "birth-silent: the summary counts the killed suite");
  }

  // Passthrough: AGENTS_TEST_TIMING is the one variable the driver copies from
  // its own env into each suite's env — the timing gates ride on it.
  {
    const r1 = runDriver([tFlag], { AGENTS_TEST_TIMING: "1" });
    check(r1.out.includes("timing=1"), "passthrough: AGENTS_TEST_TIMING set in the driver env reaches the suite env");
    const r2 = runDriver([tFlag]);
    check(r2.out.includes("timing=unset"), "passthrough: an unset AGENTS_TEST_TIMING stays out of the suite env");
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  if (trapChild) trapChild.kill("SIGKILL");
  console.error(e);
  process.exit(1);
});
