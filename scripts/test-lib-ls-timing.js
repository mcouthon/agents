#!/usr/bin/env node
"use strict";

// `a ls --json --all` on a warm cache: no git and no gh process at all, the
// median of five runs under 200 ms, data_version equal to max(events.id); one
// new commit in one fixture repo recomputes that tree's facts only (at most
// two git calls, all naming that repo), and the run after that spawns nothing.
// 200 active tasks over 4 git fixture repos, 8 phases each (half checked), 10
// all-checked tasks with a land record, 60 decisions, 900 session rows (40
// live with this test's pid) and plan files in 50 folders, plus a fifth repo
// holding no task and 100 ended rows inside the 24-hour window (two ended
// Conductor sessions on each of the 40 bound tasks, the newer winning
// resumable, and 20 unbound builder rows). The registration root holds ~900
// registrations of ~40 KB (the real root's shape): a run that walks it per
// task cannot hold the budget, so the budget is the no-walk proof.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SCRIPTS = __dirname;
const A = path.join(SCRIPTS, "bin", "a");

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const created = [];
const mktmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
};

// a counting git wrapper and a gh stub that never answers
const GUARD = mktmp("agents-lst-git-");
const GIT_LOG = path.join(GUARD, "git.log");
const GH_LOG = path.join(GUARD, "gh.log");
fs.writeFileSync(path.join(GUARD, "git"), `#!/bin/sh\nprintf '%s' "$(pwd)" >> '${GIT_LOG}'\nprintf ' %s' "$@" >> '${GIT_LOG}'\nprintf '\\n' >> '${GIT_LOG}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(GUARD, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${GH_LOG}'\nexit 1\n`, { mode: 0o755 });
const gitLines = () => (fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, "utf8").split("\n").filter(Boolean) : []);
const ghLines = () => (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean) : []);
const clearLogs = () => { fs.rmSync(GIT_LOG, { force: true }); fs.rmSync(GH_LOG, { force: true }); };

const T = mktmp("agents-lst-");
const HOME = path.join(T, "home");
const TASKS = path.join(T, "tasks");
const SESSIONS = path.join(T, "sessions");
const DB = path.join(T, "agents.db");
for (const d of [HOME, TASKS, SESSIONS]) fs.mkdirSync(d);
// the lib requires below must read the sandbox roots, never the real ones
Object.assign(process.env, {
  HOME, AGENTS_TASKS_ROOT: TASKS, AGENTS_SESSIONS_ROOT: SESSIONS, AGENTS_DB: DB,
  AGENTS_TEST_SKIP_IDENTITY: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});
delete process.env.AGENTS_SESSION_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
const env = { ...process.env, PATH: `${GUARD}:${process.env.PATH}` };

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const runLs = () => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("node", [A, "ls", "--json", "--all"], { env, encoding: "utf8", timeout: 60000 });
  return { status: r.status, ms: Number((process.hrtime.bigint() - t0) / 1000000n), out: r.stdout, err: r.stderr };
};

// four fixture repos, their main pushed to a local origin
const repos = [];
for (let i = 0; i < 4; i++) {
  const dir = path.join(T, `repo${i}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# r${i}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "update-ref", `refs/remotes/origin/main`, "HEAD");
  repos.push({ dir, key: `lst/repo${i}` });
}

// the database: 200 tasks over the four repos, 8 phases each; the first ten of
// every repo all-checked with a land record; half the others checked; plan
// files in 50 folders; 60 decisions; 900 sessions, 40 of them live here
const db = new DatabaseSync(DB);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
const dbLib = require(path.join(SCRIPTS, "lib", "db"));
const conn = dbLib.open({ create: true });
for (const r of repos) dbLib.upsertRepo(r.key, { main_root: r.dir });
// a fifth repo holding no task, so `repos` serves a task-less row
const emptyRepo = path.join(T, "repo-empty");
fs.mkdirSync(emptyRepo);
dbLib.upsertRepo("lst/repo-empty", { main_root: emptyRepo });
let decisionsMade = 0;
let planFolders = 0;
const liveRows = [];
const headOf = (r) => git(r.dir, "rev-parse", "HEAD");
for (let n = 1; n <= 200; n++) {
  const repo = repos[(n - 1) % 4];
  const dirName = `${String(n).padStart(3, "0")}-job-${n}`;
  const taskDir = path.join(TASKS, repo.key, dirName);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), `# Job ${n}\n`);
  const allChecked = (n - 1) % 4 === 0 && n <= 40; // ten per repo
  const phases = Array.from({ length: 8 }, (_, k) => ({ id: k + 1, name: `P${k + 1}`, after: k > 0 ? [k] : [] }));
  const id = dbLib.createTaskRow({
    repoKey: repo.key, dirName, taskDir, slug: dirName, number: n, title: `Job ${n}`,
    tier: "standard", mode: "full", created: "2026-10-01", approvals: "none", land: "per_phase",
    worktreePath: null, branch: null, phases,
  });
  const checkedCount = allChecked ? 8 : 4;
  for (let k = 1; k <= checkedCount; k++) dbLib.insertCheckmark(id, k, "seed", "2026-10-05T10:00:00.000Z");
  if (allChecked) dbLib.appendEvent({ kind: "land", taskId: id, detail: JSON.stringify({ head: headOf(repo), migrated: true }) });
  if (n % 4 === 2 && decisionsMade < 60) {
    dbLib.insertDecision({ task_id: id, phase_id: 1, choice: "approve", plan_hash: null, quote: "go", recorded_by: "seed", decided_at: "2026-10-02T10:00:00.000Z" });
    decisionsMade++;
  }
  if (planFolders < 50 && n % 4 === 3) {
    fs.mkdirSync(path.join(taskDir, "plan"), { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan", "phase-5-build.md"), "# plan\n");
    planFolders++;
  }
  if (n % 5 === 0) liveRows.push({ taskDir, repo });
}
for (let s = 1; s <= 900; s++) {
  const live = s <= 40;
  const reg = live
    ? { session_id: `lst-live-${s}`, repo_key: liveRows[s - 1].repo.key, task_dir: liveRows[s - 1].taskDir, agent: "conductor", origin: "cli", cwd: liveRows[s - 1].repo.dir, pid: process.pid, created_at: "2026-10-28T10:00:00.000Z" }
    : { session_id: `lst-old-${s}`, repo_key: repos[s % 4].key, task_dir: null, agent: "courier", origin: "cli", cwd: T, pid: 999999, created_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-02T10:00:00.000Z" };
  db.prepare(`INSERT INTO sessions (entry_id, session_id, terminal_id, repo_key, task_dir, agent, origin, cwd, pid, created_at, updated_at, ended_at, doc)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`e${s}`, reg.session_id, reg.repo_key, reg.task_dir, reg.agent, reg.origin, reg.cwd, live ? process.pid : 999999,
      reg.created_at, reg.created_at, reg.ended_at || null, JSON.stringify(reg));
}
// the ended rows the new fields read: two ended Conductor sessions on each
// bound task (the newer ended_at wins resumable) and unbound rows of other
// agents, all inside the 24-hour window; the 860 rows above sit outside it
const HOUR = 3600000;
const AT_NEW = new Date(Date.now() - 1 * HOUR).toISOString();
const AT_MID = new Date(Date.now() - Math.round(1.5 * HOUR)).toISOString();
const AT_OLD = new Date(Date.now() - 2 * HOUR).toISOString();
const endedSeed = (sid, repoKey, taskDir, agent, origin, cwd, at) => {
  const reg = { session_id: sid, repo_key: repoKey, task_dir: taskDir, agent, origin, cwd, pid: 999999,
    created_at: "2026-10-28T09:00:00.000Z", ended_at: at };
  db.prepare(`INSERT INTO sessions (entry_id, session_id, terminal_id, repo_key, task_dir, agent, origin, cwd, pid, created_at, updated_at, ended_at, doc)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`e-${sid}`, sid, repoKey, taskDir, agent, origin, cwd, 999999, reg.created_at, at, at, JSON.stringify(reg));
};
for (let i = 0; i < liveRows.length; i++) {
  endedSeed(`lst-end-${i}-a`, liveRows[i].repo.key, liveRows[i].taskDir, "conductor", "dispatch", liveRows[i].repo.dir, AT_OLD);
  endedSeed(`lst-end-${i}-b`, liveRows[i].repo.key, liveRows[i].taskDir, "conductor", "dispatch", liveRows[i].repo.dir, AT_NEW);
}
for (let i = 0; i < 20; i++) endedSeed(`lst-done-${i}`, repos[i % 4].key, null, "builder", "cli", T, AT_MID);
db.close();

// the registration root, populated like the real one (~900 dirs, ~40 KB each):
// unbound, ended and never in the sessions table, so only a walk reads them
{
  const pad = "x".repeat(40000);
  for (let i = 0; i < 900; i++) {
    const dir = path.join(SESSIONS, `reg-${String(i).padStart(4, "0")}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "registration.json"),
      JSON.stringify({ session_id: `pad-${i}`, repo_key: null, task_dir: null, agent: "conductor",
        cwd: T, pid: 999999, created_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", pad }));
  }
}
const maxEventId = () => {
  const d = new DatabaseSync(DB, { readOnly: true });
  try { return Number(d.prepare("SELECT max(id) AS n FROM events").get().n); } finally { d.close(); }
};

// warm the cache, then the five timed runs
{
  const warm = runLs();
  const warmOut = JSON.parse(warm.out || "{}");
  check(warm.status === 0 && Array.isArray(warmOut.tasks) && warmOut.tasks.length === 200,
    `the warm-up run lists the 200 tasks (exit ${warm.status}, ${warmOut.tasks && warmOut.tasks.length}: ${(warm.err || "").slice(0, 200)})`);
  check(Array.isArray(warmOut.sessions) && warmOut.sessions.length === 40,
    `the 40 live sessions sit on their own rows (${warmOut.sessions && warmOut.sessions.length})`);
  check(Array.isArray(warmOut.repos) && JSON.stringify(warmOut.repos.map((r) => r.repo_key)) === JSON.stringify(
    ["lst/repo0", "lst/repo1", "lst/repo2", "lst/repo3", "lst/repo-empty"])
    && warmOut.repos.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["main_root", "repo_key"])),
    `repos holds every row, the task-less one last although its key sorts first (${JSON.stringify(warmOut.repos && warmOut.repos.map((r) => r.repo_key))})`);
  check(warmOut.tasks.every((t) => t.phases_total === 8) && warmOut.tasks.filter((t) => t.phases_checked === 8).length === 10
    && warmOut.tasks.every((t) => t.phases_checked === 4 || t.phases_checked === 8),
    `every task row carries its phase counts, 10 of them all-checked (${warmOut.tasks.filter((t) => t.phases_checked === 8).length})`);
  const resumable = warmOut.tasks.filter((t) => t.resumable);
  check(resumable.length === 40 && resumable.every((t) => t.resumable.agent === "conductor" && t.resumable.ended_at === AT_NEW),
    `the 40 bound tasks carry the newer of their two ended Conductor sessions (${resumable.length})`);
  check(Array.isArray(warmOut.ended_sessions) && warmOut.ended_sessions.length === 100
    && warmOut.ended_sessions.every((e, i, a) => i === 0 || a[i - 1].ended_at >= e.ended_at)
    && warmOut.ended_sessions.some((e) => e.task_dir === null)
    && warmOut.ended_sessions.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(["agent", "ended_at", "session_id", "task_dir"])),
    `ended_sessions holds the 100 in-window rows newest first, unbound included (${warmOut.ended_sessions && warmOut.ended_sessions.length})`);
}
{
  clearLogs();
  const runs = [runLs(), runLs(), runLs(), runLs(), runLs()];
  const times = runs.map((r) => r.ms).sort((a, b) => a - b);
  const median = times[2];
  const dataVersion = JSON.parse(runs[0].out).data_version;
  console.log(`ls timing: median ${median} ms of [${runs.map((r) => r.ms).join(", ")}]`);
  check(runs.every((r) => r.status === 0), `every warm run exits 0 (${runs.map((r) => r.status).join(",")})`);
  check(median < 200, `the median of five warm runs is under 200 ms (${median} ms)`);
  check(gitLines().length === 0, `a warm cache spawns no git at all (${JSON.stringify(gitLines().slice(0, 3))})`);
  check(ghLines().length === 0, `a warm cache spawns no gh at all (${JSON.stringify(ghLines().slice(0, 3))})`);
  check(dataVersion === maxEventId(), `data_version equals max(events.id) (${dataVersion} vs ${maxEventId()})`);
}

// one new commit in one fixture repo's main checkout: that tree's facts recompute, nothing else
{
  const repo = repos[1];
  fs.writeFileSync(path.join(repo.dir, "one-more.txt"), "x\n");
  git(repo.dir, "add", "one-more.txt");
  git(repo.dir, "commit", "-q", "-m", "one more");
  clearLogs();
  const after = runLs();
  const calls = gitLines();
  const namingRepo = calls.filter((l) => l.startsWith(repo.dir));
  check(after.status === 0, `the run after the commit exits 0 (${after.status}: ${(after.err || "").slice(0, 200)})`);
  check(calls.length > 0 && calls.length === namingRepo.length,
    `every git call of the run after the commit names that repo (${JSON.stringify(calls)})`);
  check(calls.length <= 2, `at most two git calls (that tree's commits-since and unlanded) (${calls.length})`);
  check(after.ms < 1000, `the run after the commit finishes under 1 s (${after.ms} ms)`);
  const next = runLs();
  check(next.status === 0 && gitLines().length === calls.length,
    `the run after that spawns no further git (${gitLines().length - calls.length} new)`);
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
