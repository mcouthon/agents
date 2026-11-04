#!/usr/bin/env node
"use strict";
// task-probe: the deterministic probe strip — origin, tree, worktrees and
// behind-main, advice from the engine's own derivation, the a-check rows, and
// the cross-repo callers of a verb (the ledger-55 class: a caller of a
// deleted verb found in a second repo). Advisory: it exits 0 with facts.
// Isolation: nothing here may touch the real HOME, db, git config or tasks.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-task-probe-")));
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"), { recursive: true });
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_DB", "AGENTS_TASKS_ROOT",
    "AGENTS_SESSIONS_ROOT", "ZMX_SESSION", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const PROBE = path.join(__dirname, "bin", "task-probe");

const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }
const mk = (label) => { const d = path.join(T, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`); fs.mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// ---------------------------------------------------------------- the fixture

const root = mk("world");
const dbFile = path.join(root, "agents.db");
const tasksRoot = path.join(root, "tasks");
const sessionsRoot = path.join(root, "sessions");
fs.mkdirSync(tasksRoot);
fs.mkdirSync(sessionsRoot);
Object.assign(process.env, { AGENTS_DB: dbFile, AGENTS_TASKS_ROOT: tasksRoot, AGENTS_SESSIONS_ROOT: sessionsRoot });
db.open({ create: true });

function initRepo(dir, { origin = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# probe\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (origin) {
    git(path.dirname(origin), "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "-u", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
  }
  return repoKey(dir);
}

// Repo A: origin, a main checkout, and one worktree left behind origin/main.
const a = path.join(root, "a");
const keyA = initRepo(a, { origin: path.join(root, "origin-a.git") });
const wtA = path.join(root, "wt-a");
git(a, "worktree", "add", "-q", wtA, "-b", "wt/004-four");
fs.writeFileSync(path.join(a, "second.md"), "second\n");
git(a, "add", ".");
git(a, "commit", "-q", "-m", "advance origin");
git(a, "push", "-q", "origin", "main");
const originSha = git(a, "rev-parse", "refs/remotes/origin/main");

// Repo B: no origin, and the callers of a verb the agents repo deleted.
const b = path.join(root, "b");
const keyB = initRepo(b);
fs.writeFileSync(path.join(b, "b1.py"), [
  "# repo b helpers",
  '# a worktree remove ("worktree", "remove") — the one caller line',
  "# end",
].join("\n") + "\n");
fs.writeFileSync(path.join(b, "b2.py"), 'args = ["worktree", "remove", path, "--json"]\n');
fs.writeFileSync(path.join(b, "b3.py"), "# a sweep of the tasks ran this morning\n");
git(b, "add", ".");
git(b, "commit", "-q", "-m", "callers");

// Repo C: its checkout disappears while its rows stay.
const c = path.join(root, "c");
const keyC = initRepo(c, { origin: path.join(root, "origin-c.git") });

const mkTask = (repo, slug, title, phases, mode = "fast") => taskLib.createTask({
  repo, title, slug, mode, tier: "standard", phases, description: "",
}).task_dir;

const t1 = mkTask(keyA, "one", "One", [{ id: 1, name: "Build" }]);
const t2 = mkTask(keyA, "two", "Two", [], "full");
const t3 = mkTask(keyA, "three", "Three", [{ id: 1, name: "Build" }]);
const t4 = mkTask(keyA, "four", "Four", [{ id: 1, name: "Build" }]);
const t5 = mkTask(keyB, "five", "Five", [{ id: 1, name: "Build" }]);
const t6 = mkTask(keyC, "six", "Six", [{ id: 1, name: "Build" }]);

// T2 keeps zero phases (the question advice); T3 gets a plan (the build move).
fs.mkdirSync(path.join(t3, "plan"));
fs.writeFileSync(path.join(t3, "plan", "phase-1-three.md"), "# the plan\n\n- step one\n");

// T4 records the worktree as its tree.
db.setTaskWorktree(db.taskIdOf(t4), { worktreePath: wtA, branch: "wt/004-four" });

// T1's a-check rows: four, newest first, truncated.
const row1 = { command: "zsh scripts/check.sh lib", tree: "a".repeat(40), exit: 0 };
const row2 = { command: "zsh scripts/check.sh rest", tree: "b".repeat(40), exit: 0 };
const row3 = { command: "zsh scripts/check.sh full", tree: "c".repeat(40), exit: 1 };
const longCmd = `zsh scripts/check.sh ${"x".repeat(50)} trailing`;
const row4 = { command: longCmd, tree: "d".repeat(40), exit: 0 };
for (const r of [row1, row2, row3, row4]) {
  db.appendEvent({ kind: "check_run", taskId: db.taskIdOf(t1), detail: JSON.stringify(r) });
}

// Repo C's checkout goes away after its task exists.
fs.rmSync(c, { recursive: true, force: true });

// ---------------------------------------------------------------- running the probe

function probe(dir, ...extra) {
  const r = spawnSync(process.execPath, [PROBE, dir, ...extra], {
    encoding: "utf8", timeout: 60000, cwd: T, env: { ...process.env },
  });
  const facts = {};
  const worktreeLines = [];
  for (const line of (r.stdout || "").split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === "worktree") worktreeLines.push(m[2]);
    else if (!(m[1] in facts)) facts[m[1]] = m[2];
  }
  return { status: r.status, out: r.stdout || "", err: r.stderr || "", facts, worktreeLines };
}

// Repo A, clean tree, with the verb strip.
{
  const p = probe(t1, "--verb", "worktree remove");
  check(p.status === 0, `A1: the probe exits 0 (${p.err.trim().split("\n")[0] || ""})`);
  check(p.facts.origin === originSha, `A2: origin is the origin/main sha (${p.facts.origin} vs ${originSha})`);
  check(p.facts.tree === "clean", `A3: a committed main is tree=clean (${p.facts.tree})`);
  check(p.facts.worktrees === "1", `A4: one worktree beside the main checkout (${p.facts.worktrees})`);
  check(p.worktreeLines.length === 1 && p.worktreeLines[0] === `${wtA}:behind=1`,
    `A5: the worktree line names its path and its behind-main count (${p.worktreeLines.join(" | ")})`);
  const expectedChecks = [
    `${longCmd.slice(0, 40)}:0@${"d".repeat(12)}`,
    `zsh scripts/check.sh full:1@${"c".repeat(12)}`,
    `zsh scripts/check.sh rest:0@${"b".repeat(12)}`,
  ].join(";");
  check(p.facts.checks === expectedChecks,
    `A6: the three newest a-check rows, command truncated to 40 and tree to 12 (${p.facts.checks})`);
  check(!p.facts.checks.includes("lib"), "A7: the fourth-oldest check row is dropped");
  check(p.facts.callers === `${keyB.key}:b1.py:2;${keyB.key}:b2.py:1`,
    `A8: the callers come from the second repo, one entry per line, sorted (${p.facts.callers})`);
  const keys = p.out.split("\n").filter(Boolean).map((l) => l.split("=")[0]);
  check(JSON.stringify(keys) === JSON.stringify(["origin", "tree", "worktrees", "worktree", "advice", "advice_question", "checks", "callers"]),
    `A9: the strip's keys are fixed and in order (${keys.join(",")})`);
}

// A single-word verb.
{
  const p = probe(t1, "--verb", "sweep");
  check(p.facts.callers === `${keyB.key}:b3.py:1`, `B1: a single-word verb finds its textual caller (${p.facts.callers})`);
}

// T2: zero phases — the engine's own question advice.
{
  const p = probe(t2);
  check(p.facts.advice === "phases", `Q1: advice is the engine's move for a phaseless task (${p.facts.advice})`);
  check(p.facts.advice_question === "What phases should task 2 have?", `Q2: advice_question carries the question text (${p.facts.advice_question})`);
}

// T3: a plan file, no decision — the build move, no question.
{
  const p = probe(t3);
  check(p.facts.advice === "check",
    `Q3: advice is the engine's move for a planned, committed phase (${p.facts.advice})`);
  check(p.facts.advice_question === "-", `Q4: advice_question is - when the move asks nothing (${p.facts.advice_question})`);
}

// T4: the task's tree is its recorded worktree, clean and behind main.
{
  const p = probe(t4);
  check(p.facts.tree === "clean", `W1: the task's tree is its recorded worktree, clean (${p.facts.tree})`);
  check(p.facts.origin === originSha, "W2: origin is the repo's, not the worktree's checkout-only view");
}

// A dirty main.
{
  fs.writeFileSync(path.join(a, "second.md"), "second, modified\n");
  const p = probe(t1);
  check(p.facts.tree === "dirty", `D1: an uncommitted modification is tree=dirty (${p.facts.tree})`);
  const p2 = probe(t4);
  check(p2.facts.tree === "clean", "D2: the worktree's tree stays clean");
}

// Repo B: no origin, no worktrees, no checks.
{
  const p = probe(t5);
  check(p.facts.origin === "-", `N1: a repo without origin degrades to origin=- (${p.facts.origin})`);
  check(p.facts.worktrees === "0" && p.worktreeLines.length === 0, "N2: no worktree lines beside worktrees=0");
  check(p.facts.checks === "-", `N3: a task with no a-check rows is checks=- (${p.facts.checks})`);
}

// Repo C: the checkout is gone while its rows stay.
{
  const p = probe(t6);
  check(p.status === 0, `G1: a missing checkout still probes (${p.err.trim().split("\n")[0] || ""})`);
  check(p.facts.origin === "-", `G2: origin degrades to - (${p.facts.origin})`);
  check(p.facts.tree === "missing", `G3: the tree fact names the missing checkout (${p.facts.tree})`);
  check(p.facts.worktrees === "0", `G4: no worktrees are listed (${p.facts.worktrees})`);
  check(p.facts.advice === "plan", `G5: advice still derives from the rows (${p.facts.advice})`);
  const pv = probe(t6, "--verb", "worktree remove");
  check(pv.facts.callers === `${keyB.key}:b1.py:2;${keyB.key}:b2.py:1`,
    `G6: the gone checkout's repo is skipped in the callers search (${pv.facts.callers})`);
}

// A dir with no task row at all.
{
  const d = mk("plain");
  git(d, "init", "-q", "-b", "main");
  const p = probe(d);
  check(p.status === 0 && p.facts.advice === "-" && p.facts.checks === "-",
    `Z1: a row-less dir degrades advice and checks to - (${p.facts.advice}/${p.facts.checks})`);
  check(p.facts.tree === "clean" && p.facts.worktrees === "0", "Z2: the git facts still hold");
}

// Usage refusals.
{
  const none = spawnSync(process.execPath, [PROBE], { encoding: "utf8", cwd: T, env: { ...process.env } });
  check(none.status === 2, "U1: no task dir refuses, exit 2");
  const missing = probe(path.join(root, "no-such-dir"));
  check(missing.status === 2 && /no such/.test(missing.err + missing.out), `U2: a nonexistent dir refuses (${(missing.err || missing.out).trim()})`);
  const bareVerb = spawnSync(process.execPath, [PROBE, t1, "--verb"], { encoding: "utf8", cwd: T, env: { ...process.env } });
  check(bareVerb.status === 2, "U3: --verb without a value refuses");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
