#!/usr/bin/env node
"use strict";

// `a tasks sweep`: the done list over the derived predicate (every phase
// checked and the landing landed, quiet past the grace, no live session), the
// unresolved list apart with its close line, and the guarded fetch. One
// sandbox holds the tasks root, the sessions root, the database and every
// fixture repo; a sibling outside it stands for a real checkout.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { sweep, findTasks, daysAgo } = require("./lib/tasks-sweep");
const { createTask, checkPhase } = require("./lib/task");
const { repoKey } = require("./lib/repo");
const db = require("./lib/db");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-sweep-")));
const OTHER = `${BASE}-other`;
process.env.AGENTS_TASKS_ROOT = path.join(BASE, "tasks");
process.env.AGENTS_SESSIONS_ROOT = path.join(BASE, "sessions");
process.env.AGENTS_DB = path.join(BASE, "agents.db");
process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
process.env.HOME = path.join(BASE, "home");
for (const d of [process.env.AGENTS_TASKS_ROOT, process.env.AGENTS_SESSIONS_ROOT, process.env.HOME, path.join(BASE, "repos"), path.join(BASE, "origins"), path.join(OTHER, "repos")]) {
  fs.mkdirSync(d, { recursive: true });
}

const CLI = path.join(__dirname, "bin", "a");
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A fixture repo with a bare origin: clone at BASE/repos/<name>, origin at BASE/origins/<name>.git. */
function makeRepo(name, root = BASE) {
  const origin = path.join(root, "origins", `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const dir = path.join(root, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
  return dir;
}

/** The policy file lists every fixture repo direct (the landing's `no land record` reason). */
function listDirect(mainRoots) {
  const file = path.join(process.env.HOME, ".agents", "repo-policies.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = {};
  for (const m of mainRoots) doc[m] = { push: "direct" };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

/** Check every phase of a task. */
function markDone(taskDir) {
  const doc = require("./lib/task").readTaskJson(taskDir);
  for (const p of doc.phases) checkPhase({ taskDir, phaseId: p.id });
}

/** A landed task: every phase checked and a land event whose head is on origin/main. */
function landIt(taskDir, repo) {
  markDone(taskDir);
  const taskId = db.taskIdOf(taskDir);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  db.appendEvent({ kind: "land", taskId, detail: JSON.stringify({ head, migrated: true }) });
}

/** Move a task's intent events back `days`; the land event stays a second after the checkmarks. */
function backdate(taskDir, days) {
  const taskId = db.taskIdOf(taskDir);
  const at = new Date(Date.now() - days * 86400000).toISOString();
  const atPlus = new Date(Date.parse(at) + 1000).toISOString();
  const conn = db.open();
  conn.tx(() => {
    conn.run("UPDATE events SET at = ? WHERE task_id = ? AND kind != 'land'", at, taskId);
    conn.run("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'land'", atPlus, taskId);
    conn.run("UPDATE checkmarks SET checked_at = ? WHERE task_id = ?", at, taskId);
  });
  db.close();
}

const cliEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
const aLs = (repo) => spawnSync("node", [CLI, "ls", "--json", "--repo", repo], { encoding: "utf8", env: cliEnv, cwd: BASE });

// --- Test 1: daysAgo computes age correctly ---
{
  const now = new Date().toISOString();
  const age = daysAgo(now);
  if (age < 0.01) ok("daysAgo: now → ~0 days");
  else fail_(`daysAgo: now should be ~0, got ${age}`);

  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  const age5 = daysAgo(old);
  if (age5 >= 4.9 && age5 <= 5.1) ok("daysAgo: 5 days ago → ~5");
  else fail_(`daysAgo: 5 days ago should be ~5, got ${age5}`);

  if (daysAgo(null) === Infinity) ok("daysAgo: null → Infinity");
  else fail_("daysAgo: null should be Infinity");
}

// --- Test 2: the done list is the derived predicate; a landed task 3d1h old lists, one 2 days old does not ---
{
  const repo = makeRepo("done-list");
  listDirect([repo]);
  const key = repoKey(repo);
  const old = createTask({ repo: key, title: "Old Done", slug: "old-done", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(old.task_dir, repo);
  backdate(old.task_dir, 3 + 1 / 24);

  const recent = createTask({ repo: key, title: "Recent Done", slug: "recent-done", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(recent.task_dir, repo);

  const active = createTask({ repo: key, title: "Active", slug: "active-task", session_id: "s", phases: [{ id: 1, name: "P1" }] });

  // two `a ls --json` runs in a row write nothing (reads never move the events)
  const before = db.maxEventId();
  const l1 = aLs(repo);
  const l2 = aLs(repo);
  const after = db.maxEventId();
  if (l1.status === 0 && l2.status === 0 && before === after) ok("two a ls runs leave max(events.id) unchanged");
  else fail_(`two a ls runs: exits ${l1.status},${l2.status}; max event id ${before} → ${after}`);

  const { done, unresolved } = findTasks(key);
  const slugs = done.map((r) => r.slug);
  if (slugs.includes("old-done")) ok("the done list holds the landed task 3d1h old");
  else fail_(`the done list should hold 'old-done', got ${JSON.stringify(slugs)}`);
  if (!slugs.includes("recent-done")) ok("a landed task 0 days old does not list (the 3-day grace)");
  else fail_("the 3-day grace should keep 'recent-done' out");
  if (!slugs.includes("active-task")) ok("an unchecked task never lists as done");
  else fail_("an unchecked task should not list as done");

  const older = findTasks(key, { olderThanDays: 0 });
  if (older.done.map((r) => r.slug).includes("recent-done")) ok("a zero grace lists both landed tasks");
  else fail_(`a zero grace should list 'recent-done' too, got ${JSON.stringify(older.done.map((r) => r.slug))}`);
}

// --- Test 3: an all-checked direct-repo task with no land event lists unresolved with its close line ---
{
  const repo = makeRepo("no-land");
  listDirect([repo]);
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "No Land", slug: "no-land", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  markDone(r.task_dir);

  const { done, unresolved } = findTasks(key);
  if (done.length === 0) ok("a task with no land record is not done");
  else fail_(`a task with no land record should not be done, got ${JSON.stringify(done)}`);
  const row = unresolved.find((u) => u.slug === "no-land");
  if (row && row.reason === "unresolved (no land record)") ok("the unresolved list names it 'unresolved (no land record)'");
  else fail_(`the unresolved reason should be 'no land record', got ${JSON.stringify(row)}`);
  if (row && row.close === `a task close --task-dir ${r.task_dir}`) ok("the unresolved row carries the close line");
  else fail_(`the unresolved close line is wrong: ${JSON.stringify(row)}`);

  const applied = sweep({ repoKeyObj: key, apply: true });
  if (applied.closed.length === 0 && fs.existsSync(r.task_dir)) ok("--apply archives nothing unresolved");
  else fail_(`--apply should not archive an unresolved task, closed=${JSON.stringify(applied.closed)}`);
}

// --- Test 4: sweep dry-run lists, --apply archives through closeTask ---
{
  const repo = makeRepo("apply");
  listDirect([repo]);
  const key = repoKey(repo);
  const r1 = createTask({ repo: key, title: "Sweep Me", slug: "sweep-me", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(r1.task_dir, repo);
  backdate(r1.task_dir, 4);

  const dry = sweep({ repoKeyObj: key, apply: false });
  if (dry.listed.length === 1 && dry.listed[0].slug === "sweep-me" && dry.closed.length === 0 && dry.fetch.ok === true) {
    ok("dry run: lists the landed task, closes nothing, fetches the repo");
  } else fail_(`dry run: listed=${JSON.stringify(dry.listed)} closed=${dry.closed.length} fetch=${JSON.stringify(dry.fetch)}`);
  if (fs.existsSync(r1.task_dir)) ok("dry run: the task dir remains");
  else fail_("dry run: the task dir should remain");

  const applied = sweep({ repoKeyObj: key, apply: true });
  if (applied.closed.length === 1 && applied.closed[0].action === "archive" && !fs.existsSync(r1.task_dir)
    && fs.existsSync(applied.closed[0].archivePath)) {
    ok("--apply archives the landed task (a move, reversible)");
  } else fail_(`--apply: closed=${JSON.stringify(applied.closed)}`);
}

// --- Test 5: a live session keeps a landed task out of the done list ---
{
  const repo = makeRepo("live");
  listDirect([repo]);
  const key = repoKey(repo);
  const r = createTask({ repo: key, title: "Live", slug: "live-held", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(r.task_dir, repo);
  backdate(r.task_dir, 4);
  require("./lib/session").register({ session_id: "sweep-live", pid: process.pid, cwd: repo, agent: "builder", repo_key: key.key, task_dir: r.task_dir });

  const { done } = findTasks(key);
  if (done.length === 0) ok("a live bound session keeps the task out of the done list");
  else fail_(`a live bound session should keep the task out, got ${JSON.stringify(done)}`);
  require("./lib/session").unregister("sweep-live");
  const after = findTasks(key);
  if (after.done.length === 1) ok("once the session ends the task lists again");
  else fail_(`once the session ends the task should list, got ${JSON.stringify(after.done)}`);
}

// --- Test 6: the fetch obeys the sandbox guard ---
{
  const wrapperDir = path.join(BASE, "bin");
  const log = path.join(BASE, "git.log");
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, "git"), `#!/bin/sh\nprintf '%s' "$(pwd)" >> '${log}'\nprintf ' %s' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const env = { ...cliEnv, PATH: `${wrapperDir}:${process.env.PATH}` };

  const inside = makeRepo("inside");
  const outside = makeRepo("outside", OTHER);
  listDirect([inside, outside]);
  const inKey = repoKey(inside);
  const outKey = repoKey(outside);
  const t1 = createTask({ repo: inKey, title: "In", slug: "in", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(t1.task_dir, inside);
  const t2 = createTask({ repo: outKey, title: "Out", slug: "out", session_id: "s", phases: [{ id: 1, name: "P1" }] });
  landIt(t2.task_dir, outside);

  fs.rmSync(log, { force: true });
  const rIn = spawnSync("node", [CLI, "tasks", "sweep", "--repo", inside], { encoding: "utf8", env, cwd: BASE });
  const inOut = JSON.parse(rIn.stdout);
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const fetches = logText.split("\n").filter((l) => l.includes(" fetch "));
  if (rIn.status === 0 && inOut.fetch.ok === true && fetches.length === 1 && fetches[0].startsWith(inside)) {
    ok("the repo under the root is fetched exactly once");
  } else fail_(`the inside fetch: exit=${rIn.status} fetch=${JSON.stringify(inOut.fetch)} lines=${JSON.stringify(fetches)}`);

  const rOut = spawnSync("node", [CLI, "tasks", "sweep", "--older-than", "0d", "--repo", outside], { encoding: "utf8", env, cwd: BASE });
  const outJson = JSON.parse(rOut.stdout);
  const log2 = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const fetches2 = log2.split("\n").filter((l) => l.includes(" fetch "));
  if (rOut.status === 0 && outJson.fetch.ok === false && outJson.fetch.reason === "outside sandbox"
    && fetches2.every((l) => !l.startsWith(outside))) {
    ok("the repo outside the root is listed 'outside sandbox' and never fetched");
  } else fail_(`the outside fetch: exit=${rOut.status} fetch=${JSON.stringify(outJson.fetch)} lines=${JSON.stringify(fetches2)}`);
  if (outJson.listed.length === 1 && outJson.listed[0].slug === "out") ok("the outside task still derives from its local refs and lists (grace zero)");
  else fail_(`the outside task should still list from local refs, got ${JSON.stringify(outJson.listed)}`);
}

fs.rmSync(BASE, { recursive: true, force: true });
fs.rmSync(OTHER, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
