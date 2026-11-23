#!/usr/bin/env node
"use strict";

// a check: record a check_run event for a command run in the task's tree.
// Temp bare origin, a clone, a task worktree; `gh` is a PATH stub.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-check-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "bin"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["CLAUDE_CODE_SESSION_ID", "AGENTS_SESSION_DIR"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const { POLICIES_PATH } = require("./lib/policy");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

db.open({ create: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = path.join(path.dirname(process.env.AGENTS_TASKS_ROOT), "repos");
fs.mkdirSync(root, { recursive: true });
let counter = 0;
const A = path.join(__dirname, "bin", "a");

function fixture() {
  const n = ++counter;
  const origin = path.join(root, `origin${n}.git`);
  const main = path.join(root, `main${n}`);
  const wt = path.join(root, `wt${n}`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  fs.writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "task-branch", wt, "origin/main");
  fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feature");
  const key = repoKey(main);
  const created = taskLib.createTask({ repo: key, title: `T${n}`, slug: `t${n}`, session_id: "s", phases: [{ id: 1, name: "One" }] });
  const taskId = db.taskIdOf(created.task_dir);
  db.setTaskWorktree(taskId, { worktreePath: wt, branch: "task-branch" });
  fs.writeFileSync(POLICIES_PATH, JSON.stringify({ [key.main_root]: "direct" }));
  return { origin, main, wt, key, taskDir: created.task_dir, taskId };
}

function runCheck(args, cwd) {
  const r = spawnSync(process.execPath, [A, "check", ...args], {
    encoding: "utf8", cwd: cwd || process.env.AGENTS_TEST_TMP, timeout: 30000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// CK1: a clean tree, "true" — exits 0, JSON carries {command, tree, exit, at}, event recorded.
{
  const fx = fixture();
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const before = db.intentRecency(fx.taskId);
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "true"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 0, `CK1: "true" exits 0 (exit ${r.status})`);
  check(json && json.command === "true" && json.tree === treeHash && json.exit === 0 && typeof json.at === "string",
    `CK1: JSON is {command, tree, exit, at} (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 1 && runs[0].command === "true" && runs[0].tree === treeHash && runs[0].exit === 0,
    `CK1: a check_run event holds {command, tree, exit} (got ${runs.length} runs)`);
  // CK5 (guard): no intent event appended.
  const after = db.intentRecency(fx.taskId);
  check(JSON.stringify(before) === JSON.stringify(after),
    `CK5: intentRecency unchanged (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
}

// CK2: "false" — exits 1, event recorded with exit 1.
{
  const fx = fixture();
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "false"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 1, `CK2: "false" exits 1 (exit ${r.status})`);
  check(json && json.exit === 1 && json.command === "false" && json.tree === treeHash,
    `CK2: JSON carries exit 1 (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 1 && runs[0].exit === 1 && runs[0].command === "false",
    `CK2: the recorded event has exit 1 (got exit ${runs.length > 0 ? runs[0].exit : "none"})`);
}

// CK3: a dirty tree is refused, exit 2, with the remedy; no event.
{
  const fx = fixture();
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "dirty\n");
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "true"]);
  check(r.status === 2, `CK3: dirty tree exits 2 (exit ${r.status})`);
  check(/Remedy: commit or stash/.test(r.err), `CK3: refusal names the remedy (${r.err.split("\n")[0]})`);
  const runs = db.listCheckRuns(fx.taskId);
  check(runs.length === 0, `CK3: no event recorded for a refused check (got ${runs.length})`);
}

// CK4: no command after -- is a usage error, exit 2, naming the form.
{
  const fx = fixture();
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json"]);
  check(r.status === 2, `CK4: no command exits 2 (exit ${r.status})`);
  check(/Usage: a check/.test(r.err), `CK4: usage names the form (${r.err.split("\n")[0]})`);
}

// CK6: the command runs in the task's worktree — "pwd" prints the worktree path.
{
  const fx = fixture();
  const r = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--json", "--", "pwd"]);
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 0, `CK6: "pwd" exits 0 (exit ${r.status})`);
  check(json && json.exit === 0, `CK6: JSON carries exit 0 (${json ? JSON.stringify(json) : r.out.slice(0, 80)})`);
  // The non-JSON stdout of "pwd" is the worktree path; under --json it is captured in the event detail only.
  // Run without --json to see the cwd output.
  const r2 = runCheck(["--task-dir", fx.taskDir, "--repo", fx.main, "--", "pwd"]);
  const pwd = r2.out.trim();
  check(r2.status === 0 && pwd === fs.realpathSync(fx.wt), `CK6: "pwd" prints the worktree path (got ${pwd})`);
}

const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const poolDir = () => path.join(process.env.HOME, ".agents", "test-slots");
const setSlots = (value) => fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(value === undefined ? {} : { tests: { slots: value } }));
const holderFile = (i, holder) => {
  fs.mkdirSync(path.join(poolDir(), `${i}.lock`), { recursive: true });
  fs.writeFileSync(path.join(poolDir(), `${i}.lock`, "holder"), JSON.stringify({ session_id: "s", task: "other/task", verb: "check", since: new Date().toISOString(), ...holder }));
};
const resetPool = () => fs.rmSync(poolDir(), { recursive: true, force: true });
const relTask = (fx) => path.relative(process.env.AGENTS_TASKS_ROOT, fx.taskDir);

/** The command a slot test runs: `s`, a second of work, `e`, into a marker file. */
function markerCommand(marker) { return `printf s >> ${sq(marker)}; sleep 1; printf e >> ${sq(marker)}`; }
const checkArgs = (fx, cmd, extra = []) => ["--task-dir", fx.taskDir, "--repo", fx.main, ...extra, "--", cmd];

/** Start every `a check` at once; return each run's {status, out, err}. */
function runTogether(argSets, env = {}) {
  const tag = path.join(process.env.AGENTS_TEST_TMP, `tog${++counter}`);
  const starts = argSets.map((args, i) => `(node ${sq(A)} check ${args.map(sq).join(" ")} > ${sq(`${tag}.${i}.out`)} 2> ${sq(`${tag}.${i}.err`)}; echo $? > ${sq(`${tag}.${i}.status`)}) &`);
  spawnSync("sh", ["-c", `${starts.join("\n")}\nwait`], { env: { ...process.env, ...env }, timeout: 60000, encoding: "utf8" });
  return argSets.map((_, i) => ({
    status: Number(fs.readFileSync(`${tag}.${i}.status`, "utf8")),
    out: fs.readFileSync(`${tag}.${i}.out`, "utf8"),
    err: fs.readFileSync(`${tag}.${i}.err`, "utf8"),
  }));
}

/** The most `s` markers open at once in a marker string like "ssees e". */
function maxOpen(marker) {
  let open = 0, most = 0;
  for (const c of marker) { open += c === "s" ? 1 : -1; most = Math.max(most, open); }
  return most;
}
const markerOf = (name) => path.join(process.env.AGENTS_TEST_TMP, name);
const readMarker = (m) => (fs.existsSync(m) ? fs.readFileSync(m, "utf8") : "");

// CK7: with no tests.slots set, three simultaneous checks run two at a time; the third waits and says who holds the slots.
{
  setSlots(undefined);
  const fxs = [fixture(), fixture(), fixture()];
  const marker = markerOf("ck7.marker");
  const runs = runTogether(fxs.map((fx) => checkArgs(fx, markerCommand(marker))));
  const m = readMarker(marker);
  check(runs.every((r) => r.status === 0), `CK7: all three exit 0 (${runs.map((r) => r.status)})`);
  check(m.length === 6 && m.startsWith("ss") && maxOpen(m) === 2 && m.indexOf("e") < m.lastIndexOf("s"),
    `CK7: two overlap, never three, and the third starts after the first ends (marker ${m})`);
  check(fxs.every((fx) => db.listCheckRuns(fx.taskId).length === 1), "CK7: every run recorded a check_run");
  const waiters = runs.filter((r) => /waiting for a test slot/.test(r.err));
  const holdersNamed = waiters.length === 1 && fxs.filter((fx) => waiters[0].err.includes(relTask(fx))).length === 2;
  check(holdersNamed && /since \d\d:\d\d:\d\d/.test(waiters[0].err),
    `CK7: exactly one run printed the queue line, naming the two holders' tasks and since when (${waiters.length} waiters)`);
}

// CK7b: tests.slots = 1 serializes the runs.
{
  setSlots(1);
  const fxs = [fixture(), fixture()];
  const marker = markerOf("ck7b.marker");
  const runs = runTogether(fxs.map((fx) => checkArgs(fx, markerCommand(marker))));
  check(runs.every((r) => r.status === 0) && readMarker(marker) === "sese", `CK7b: with one slot the runs go s e s e (marker ${readMarker(marker)}, exits ${runs.map((r) => r.status)})`);
  check(runs.filter((r) => /waiting for a test slot/.test(r.err)).length === 1, "CK7b: one run printed the queue line");
}

// CK8: both slots held by live runs and the wait capped: the run refuses test_slot_busy with a remedy, never runs, records nothing.
{
  setSlots(undefined);
  resetPool();
  const holders = [0, 1].map(() => require("child_process").spawn("sleep", ["30"], { stdio: "ignore" }));
  holders.forEach((h, i) => holderFile(i, { pid: h.pid, task: `repo/held-${i}` }));
  const fx = fixture();
  const marker = markerOf("ck8.marker");
  const r = spawnSync(process.execPath, [A, "check", ...checkArgs(fx, markerCommand(marker), ["--json"])], { encoding: "utf8", timeout: 30000, env: { ...process.env, AGENTS_SLOT_WAIT_MS: "300" } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  holders.forEach((h) => h.kill());
  check(r.status === 2 && json && json.error === "test_slot_busy", `CK8: a full pool refuses test_slot_busy, exit 2 (exit ${r.status}, ${r.stdout.slice(0, 80)})`);
  check(/Remedy: .*tests\.slots/.test(r.stderr) && /held-0/.test(r.stderr) && /held-1/.test(r.stderr), `CK8: the refusal names a remedy and both holders (${r.stderr.split("\n").slice(0, 2).join(" | ")})`);
  check(readMarker(marker) === "" && db.listCheckRuns(fx.taskId).length === 0, "CK8: the command never ran and no check_run was recorded");
  const waitingDir = path.join(poolDir(), "waiting");
  check(!fs.existsSync(waitingDir) || fs.readdirSync(waitingDir).length === 0, "CK8: the timed-out run left no waiting marker");
  resetPool();
}

// CK9: a slot held by a dead pid is reclaimed at once, silently; the live holder's slot is untouched.
{
  setSlots(undefined);
  resetPool();
  const live = require("child_process").spawn("sleep", ["30"], { stdio: "ignore" });
  holderFile(0, { pid: 999999 });
  holderFile(1, { pid: live.pid });
  const fx = fixture();
  const r = runCheck(checkArgs(fx, "true", ["--json"]));
  live.kill();
  check(r.status === 0 && !/waiting for a test slot/.test(r.err), `CK9: a dead holder's slot is taken without waiting (exit ${r.status}, ${r.err.slice(0, 60)})`);
  check(!fs.existsSync(path.join(poolDir(), "0.lock")) && fs.existsSync(path.join(poolDir(), "1.lock", "holder")), "CK9: slot 0 is released afterwards and the live holder's slot 1 remains");
  resetPool();
}

// CK10: anything but a positive integer in tests.slots refuses test_slots_invalid with a remedy; nothing runs.
for (const bad of [0, "two", 1.5]) {
  setSlots(bad);
  const fx = fixture();
  const marker = markerOf(`ck10-${counter}.marker`);
  const r = runCheck(checkArgs(fx, markerCommand(marker), ["--json"]));
  let json = null;
  try { json = JSON.parse(r.out); } catch {}
  check(r.status === 2 && json && json.error === "test_slots_invalid" && /Remedy: .*tests\.slots/.test(r.err), `CK10: tests.slots ${JSON.stringify(bad)} refuses test_slots_invalid with a remedy (exit ${r.status}, ${r.out.slice(0, 70)})`);
  check(readMarker(marker) === "" && db.listCheckRuns(fx.taskId).length === 0, `CK10: tests.slots ${JSON.stringify(bad)} ran nothing and recorded nothing`);
}

// CK11: the run that waited reports it in its --json result; the run that did not has no slot_wait.
{
  setSlots(1);
  const fxs = [fixture(), fixture()];
  const marker = markerOf("ck11.marker");
  const runs = runTogether(fxs.map((fx) => checkArgs(fx, markerCommand(marker), ["--json"])));
  const jsons = runs.map((r) => JSON.parse(r.out));
  const waited = jsons.filter((j) => j.slot_wait);
  const holderIdx = jsons.findIndex((j) => !j.slot_wait);
  check(runs.every((r) => r.status === 0) && waited.length === 1 && holderIdx !== -1, `CK11: exactly one run reports slot_wait (${JSON.stringify(jsons.map((j) => j.slot_wait))})`);
  const note = waited.length === 1 ? waited[0].slot_wait : "";
  check(note.startsWith("waited ") && note.endsWith(`for a slot held by task ${relTask(fxs[holderIdx])}`), `CK11: slot_wait names the holder's task (${note})`);
}

// CK12: --no-record runs the command on an uncommitted tree, passes its exit code through, and records nothing.
{
  setSlots(undefined);
  const fx = fixture();
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "dirty\n");
  const ok = runCheck(checkArgs(fx, "touch ran.txt", ["--json", "--no-record"]));
  let json = null;
  try { json = JSON.parse(ok.out); } catch {}
  check(ok.status === 0 && fs.existsSync(path.join(fx.wt, "ran.txt")), `CK12: the command ran in the dirty worktree and exited 0 (exit ${ok.status}, ${ok.err.split("\n")[0]})`);
  check(json && json.recorded === false && json.tree === null && json.at === null && json.exit === 0, `CK12: the JSON says nothing was recorded (${json ? JSON.stringify(json) : ok.out.slice(0, 80)})`);
  const bad = runCheck(checkArgs(fx, "false", ["--json", "--no-record"]));
  check(bad.status === 1, `CK12: a failing command's own exit code passes through (exit ${bad.status})`);
  check(db.listCheckRuns(fx.taskId).length === 0, `CK12: no check_run was recorded (got ${db.listCheckRuns(fx.taskId).length})`);
}

// CK13: --no-record still takes a slot: with the pool held and the wait capped it refuses test_slot_busy and never runs.
{
  setSlots(undefined);
  resetPool();
  const holders = [0, 1].map(() => require("child_process").spawn("sleep", ["30"], { stdio: "ignore" }));
  holders.forEach((h, i) => holderFile(i, { pid: h.pid, task: `repo/held-${i}` }));
  const fx = fixture();
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "dirty\n");
  const marker = markerOf("ck13.marker");
  const r = spawnSync(process.execPath, [A, "check", ...checkArgs(fx, markerCommand(marker), ["--json", "--no-record"])], { encoding: "utf8", timeout: 30000, env: { ...process.env, AGENTS_SLOT_WAIT_MS: "300" } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  holders.forEach((h) => h.kill());
  check(r.status === 2 && json && json.error === "test_slot_busy", `CK13: a full pool refuses test_slot_busy on a dirty tree, exit 2 (exit ${r.status}, ${r.stdout.slice(0, 80)})`);
  check(readMarker(marker) === "", "CK13: the command never ran");
  resetPool();
}
setSlots(undefined);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
