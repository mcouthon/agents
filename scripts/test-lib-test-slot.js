#!/usr/bin/env node
"use strict";

// The machine-wide test slots: oldest-waiter-first admission, waiting-marker upkeep, the queue line, holders().

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-slot-"));
  for (const d of ["home", "tasks"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), JSON.stringify({ tests: { slots: 2 } }));
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_TEST_TMP: t,
  });
  delete process.env.AGENTS_SLOT_WAIT_MS;
})();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const slot = require("./lib/test-slot");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const tmp = process.env.AGENTS_TEST_TMP;
const poolDir = path.join(process.env.HOME, ".agents", "test-slots");
const waitingDir = path.join(poolDir, "waiting");
const taskDir = (name) => path.join(process.env.AGENTS_TASKS_ROOT, "repo", name);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const resetPool = () => fs.rmSync(poolDir, { recursive: true, force: true });
const waitingFiles = () => (fs.existsSync(waitingDir) ? fs.readdirSync(waitingDir) : []);
const setSlots = (n) => fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ tests: { slots: n } }));

function waitFor(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; sleepMs(25); }
  console.log(`(timed out waiting for ${what})`);
  return false;
}

function holdSlot(i, pid, task) {
  fs.mkdirSync(path.join(poolDir, `${i}.lock`), { recursive: true });
  fs.writeFileSync(path.join(poolDir, `${i}.lock`, "holder"), JSON.stringify({ session_id: "s", pid, task, verb: "check", since: new Date().toISOString() }));
}
const freeSlot = (i) => fs.rmSync(path.join(poolDir, `${i}.lock`), { recursive: true, force: true });
const liveSleeper = () => spawn("sleep", ["60"], { stdio: "ignore" });

/** A waiter: a child that takes a slot, appends `<name>@<time>` to the log on acquire, and appends `<name>:done` once it releases. */
function startWaiter(name, log, { hold = 0, waitMs } = {}) {
  const script = `
    const fs = require("fs");
    const slot = require(${JSON.stringify(path.join(__dirname, "lib", "test-slot"))});
    const r = slot.withTestSlot({ verb: "check", taskDir: ${JSON.stringify(taskDir(name))} }, () => {
      fs.appendFileSync(${JSON.stringify(log)}, "${name}@" + Date.now() + "\\n");
      const end = Date.now() + ${hold}; while (Date.now() < end) {}
    });
    fs.appendFileSync(${JSON.stringify(log)}, "${name}:done:" + (r.slot_wait || "") + "\\n");
  `;
  const env = { ...process.env, ...(waitMs ? { AGENTS_SLOT_WAIT_MS: String(waitMs) } : {}) };
  const errFile = path.join(tmp, `${name}.${Date.now()}.err`);
  const child = spawn(process.execPath, ["-e", script], { env, stdio: ["ignore", "ignore", fs.openSync(errFile, "w")] });
  return { child, stderr: () => fs.readFileSync(errFile, "utf8") };
}
const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const acquired = (log, name) => readLog(log).some((l) => l.startsWith(`${name}@`));
const markerFor = (child) => path.join(waitingDir, `${child.pid}.json`);

// The wait cap defaults to 300 s.
check(slot.waitMs() === 300000, `waitMs defaults to 300000 (got ${slot.waitMs()})`);

// ST-oldest: the older waiter is admitted before the younger one, however the slots free.
{
  resetPool();
  setSlots(2);
  const log = path.join(tmp, "oldest.log");
  const sleepers = [liveSleeper(), liveSleeper()];
  holdSlot(0, sleepers[0].pid, "repo/h0");
  holdSlot(1, sleepers[1].pid, "repo/h1");
  const a = startWaiter("A", log, { hold: 20000 });
  check(waitFor(() => fs.existsSync(markerFor(a.child)), "A's waiting marker"), "ST-oldest: a queued run registers a waiting marker");
  const b = startWaiter("B", log);
  check(waitFor(() => fs.existsSync(markerFor(b.child)), "B's waiting marker"), "ST-oldest: the younger run registers one too");
  freeSlot(0);
  check(waitFor(() => acquired(log, "A"), "A acquire"), "ST-oldest: the freed slot goes to the older waiter");
  sleepMs(400);
  check(!acquired(log, "B"), "ST-oldest: the younger waiter is still waiting while the other slot is held");
  freeSlot(1);
  check(waitFor(() => acquired(log, "B"), "B acquire"), "ST-oldest: the second freed slot admits the younger waiter");
  const lines = readLog(log);
  const atOf = (n) => Number(lines.find((l) => l.startsWith(`${n}@`)).split("@")[1]);
  check(atOf("A") <= atOf("B"), "ST-oldest: A acquired no later than B");
  check(waitFor(() => waitingFiles().length === 0, "markers gone"), "ST-oldest: both markers are gone after admission");
  sleepers.forEach((s) => s.kill());
  a.child.kill(); b.child.kill();
}

// ST-newcomer: a slot freed while a fresh run arrives goes to the queued waiter, not the newcomer.
{
  resetPool();
  setSlots(1);
  const log = path.join(tmp, "newcomer.log");
  const sleeper = liveSleeper();
  holdSlot(0, sleeper.pid, "repo/h0");
  const a = startWaiter("A", log, { hold: 300 });
  waitFor(() => fs.existsSync(markerFor(a.child)), "A's waiting marker");
  freeSlot(0);
  const c = startWaiter("C", log);
  check(waitFor(() => acquired(log, "A") && acquired(log, "C"), "A and C acquire"), "ST-newcomer: both eventually run");
  const order = readLog(log).filter((l) => l.includes("@")).map((l) => l.split("@")[0]).join("");
  check(order === "AC", `ST-newcomer: the queued waiter runs first (order ${order})`);
  sleeper.kill();
  a.child.kill(); c.child.kill();
}

// ST-dead-marker: a dead pid's marker and a live pid's marker past the wait cap never block the line, and both are cleaned.
{
  resetPool();
  setSlots(2);
  fs.mkdirSync(waitingDir, { recursive: true });
  const old = Date.now() - 400000;
  const live = liveSleeper();
  fs.writeFileSync(path.join(waitingDir, "999999.json"), JSON.stringify({ pid: 999999, task: "repo/ghost", since_ms: old + 399000 }));
  fs.writeFileSync(path.join(waitingDir, `${live.pid}.json`), JSON.stringify({ pid: live.pid, task: "repo/stale", since_ms: old }));
  const log = path.join(tmp, "dead.log");
  const w = startWaiter("W", log);
  check(waitFor(() => acquired(log, "W"), "W acquire"), "ST-dead-marker: a dead or over-age marker does not block an admission");
  check(waitFor(() => waitingFiles().length === 0, "markers cleaned"), `ST-dead-marker: both stale markers are removed (left ${waitingFiles()})`);
  live.kill();
  w.child.kill();
}

// ST-cleanup: a run's marker is gone after it finished, and after its function threw.
{
  resetPool();
  setSlots(2);
  const ok = slot.withTestSlot({ verb: "check", taskDir: taskDir("fine") }, () => "result");
  check(ok.value === "result" && waitingFiles().length === 0 && !fs.existsSync(path.join(poolDir, "0.lock")), "ST-cleanup: a finished run leaves no marker and no held slot");
  let threw = null;
  try { slot.withTestSlot({ verb: "check", taskDir: taskDir("boom") }, () => { throw new Error("boom"); }); } catch (err) { threw = err; }
  check(threw && threw.message === "boom" && waitingFiles().length === 0 && !fs.existsSync(path.join(poolDir, "0.lock")), "ST-cleanup: a throwing run releases its slot and marker and rethrows");
}

// The queue line is printed on first block and again when the holder set changes; the wait is reported on success.
{
  resetPool();
  setSlots(1);
  const log = path.join(tmp, "line.log");
  const s1 = liveSleeper(), s2 = liveSleeper();
  holdSlot(0, s1.pid, "repo/first");
  const w = startWaiter("L", log);
  check(waitFor(() => /waiting for a test slot \(1 of 1 in use\): repo\/first \(check, pid \d+\) since \d\d:\d\d:\d\d/.test(w.stderr()), "first queue line"), `queue line names the holder and since (${w.stderr().trim()})`);
  freeSlot(0);
  holdSlot(0, s2.pid, "repo/second");
  check(waitFor(() => /repo\/second/.test(w.stderr()), "re-printed line"), "the queue line prints again when the holder changes");
  const lineCount = (w.stderr().match(/waiting for a test slot/g) || []).length;
  sleepMs(400);
  check((w.stderr().match(/waiting for a test slot/g) || []).length === lineCount, "the queue line does not repeat while the holders stay the same");
  freeSlot(0);
  check(waitFor(() => readLog(log).some((l) => l.startsWith("L:done:")), "L done"), "the waiter finishes once the slot frees");
  const done = readLog(log).find((l) => l.startsWith("L:done:"));
  check(/^L:done:waited .* for a slot held by task repo\/first$/.test(done), `the result carries slot_wait naming the holder (${done})`);
  check(/waited .* for a slot held by task repo\/first/.test(w.stderr()), "the same note goes to stderr on acquire");
  s1.kill(); s2.kill();
  w.child.kill();
}

// holders() lists live holders only.
{
  resetPool();
  setSlots(2);
  const live = liveSleeper();
  holdSlot(0, live.pid, "repo/live");
  holdSlot(1, 999999, "repo/dead");
  const got = slot.holders();
  check(got.length === 1 && got[0].task === "repo/live" && got[0].pid === live.pid, `holders() lists the live holder and omits the dead one (${JSON.stringify(got.map((h) => h.task))})`);
  live.kill();
}

// The count must be a positive integer; the refusal carries a remedy.
{
  setSlots(0);
  let err = null;
  try { slot.slotCount(); } catch (e) { err = e; }
  check(err && err.code === "test_slots_invalid" && err.exitCode === 2 && /Remedy: .*tests\.slots/.test(err.message), "slotCount refuses an invalid count with a remedy");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  check(slot.slotCount() === 2, "an unset count reads as 2");
  setSlots(5);
  check(slot.slotCount() === 5, "a set count is read live");
}

resetPool();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
