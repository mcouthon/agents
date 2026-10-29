#!/usr/bin/env node
"use strict";

// Repo-held Markdown: in database mode a new task keeps task.md and plan/ in
// <repo>/.tasks/<NNN-slug>/, hidden through info/exclude. Every scenario runs
// in its own temp HOME and roots; the real ~/.agents is never touched.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

const SCRIPTS = __dirname;
const CLI = path.join(SCRIPTS, "bin", "a");
const LIB = path.join(SCRIPTS, "lib");
const created = [];

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-repofiles-")));
  created.push(base);
  const env = {
    ...process.env,
    HOME: path.join(base, "home"),
    AGENTS_TASKS_ROOT: path.join(base, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(base, "sessions"),
    AGENTS_DB: path.join(base, "agents.db"),
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com",
  };
  delete env.AGENTS_SESSION_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.AGENTS_TASKS_ROOT, { recursive: true });
  const repo = path.join(base, "acme");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "acme\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env });
  const sb = { base, env, repo };
  sb.cli = (args, { json = true, input } = {}) => {
    const full = [CLI, ...args, "--repo", repo];
    if (json) full.push("--json");
    const r = spawnSync("node", full, { env, encoding: "utf8", input, timeout: 30000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  sb.createDb = () => execFileSync("node", ["-e", `require(${JSON.stringify(path.join(LIB, "db"))}).open({create:true})`], { env });
  sb.readDb = (sql, ...params) => {
    const d = new DatabaseSync(env.AGENTS_DB, { readOnly: true });
    try { return d.prepare(sql).all(...params); } finally { d.close(); }
  };
  sb.probe = (source, ...args) => {
    const file = path.join(base, "probe.js");
    fs.writeFileSync(file, source);
    const r = spawnSync("node", [file, ...args], { env, encoding: "utf8", timeout: 30000 });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  };
  sb.exclude = () => fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  sb.git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
  return sb;
}

function create(sb, slug, { phases = 0 } = {}) {
  const args = ["task", "create", "--title", slug, "--slug", slug];
  if (phases > 0) args.push("--phases-json", JSON.stringify(Array.from({ length: phases }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }))));
  const r = sb.cli(args);
  if (r.status !== 0) throw new Error(`task create failed: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const readTask = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));

// C1: with a database a new task keeps its Markdown in the repo, hidden from git
{
  const sb = sandbox();
  sb.createDb();
  const t1 = create(sb, "t");
  const t2 = create(sb, "u");
  const filesDir = path.join(sb.repo, ".tasks", "001-t");
  check(fs.existsSync(path.join(filesDir, "task.md")), "C1: task.md is in <repo>/.tasks/001-t");
  check(fs.existsSync(path.join(t1.task_dir, "task.json")) && !fs.existsSync(path.join(t1.task_dir, "state.md")), "C1: central dir keeps task.json");
  check(!fs.existsSync(path.join(t1.task_dir, "task.md")), "C1: central dir has no task.md");
  check(t1.files_dir === filesDir && readTask(t1.task_dir).files_dir === filesDir, "C1: CLI JSON and task.json carry files_dir");
  check(sb.readDb("SELECT files_dir FROM tasks WHERE dir_name = '001-t'")[0].files_dir === filesDir, "C1: DB files_dir column matches");
  check(sb.exclude().split("\n").filter((l) => l === "/.tasks").length === 1, "C1: /.tasks is listed once in info/exclude");
  check(sb.git("status", "--porcelain") === "", "C1: git status is clean");
  check(t2.number === 2, "C1: second task is numbered 2");
  const show = sb.cli(["ls", "t"]);
  check(show.status === 0, `C1: ls <task> exits 0 (${show.status} ${show.stderr})`);
  check(fs.existsSync(path.join(sb.repo, ".tasks", "001-t")) && fs.existsSync(path.join(sb.repo, ".tasks", "002-u")), "C1: both repo dirs remain after a task read");
}

// C2: without a database nothing changes
{
  const sb = sandbox();
  const before = fs.existsSync(path.join(sb.repo, ".git", "info", "exclude")) ? sb.exclude() : "";
  const t = create(sb, "t");
  check(fs.existsSync(path.join(t.task_dir, "task.md")), "C2: task.md is in the central dir");
  check(!("files_dir" in readTask(t.task_dir)), "C2: task.json has no files_dir key");
  check(!fs.existsSync(path.join(sb.repo, ".tasks")), "C2: no repo .tasks directory appears");
  const after = fs.existsSync(path.join(sb.repo, ".git", "info", "exclude")) ? sb.exclude() : "";
  check(before === after, "C2: info/exclude is unchanged");
}

// C3: legacy dirs still move, Markdown-only repo dirs are kept only when protected
{
  const sb = sandbox();
  const old = path.join(sb.repo, ".tasks", "042-old");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "state.json"), JSON.stringify({ phases: [], flags: [] }));
  const t = create(sb, "t");
  check(fs.existsSync(path.join(path.dirname(t.task_dir), "042-old")), "C3a: legacy dir moved to the central root");
  check(!fs.existsSync(path.join(sb.repo, ".tasks")), "C3a: repo .tasks is gone");
  check(t.number === 43, `C3a: new task is 043 (${t.number})`);
}
{
  const sb = sandbox();
  sb.createDb();
  const legacy = path.join(sb.repo, ".tasks", "042-old");
  const md = path.join(sb.repo, ".tasks", "050-expl");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify({ phases: [], flags: [] }));
  fs.writeFileSync(path.join(md, "task.md"), "# expl\n");
  const r = sb.cli(["tasks", "root"]);
  const resolve = sb.cli(["task", "read", "042-old"]);
  check(r.status === 0 && resolve.status === 0, `C3b: commands that resolve a task succeed (${resolve.status} ${resolve.stderr})`);
  const central = JSON.parse(sb.cli(["tasks", "root"]).stdout);
  const centralDir = central.root || central.tasks_root || central.path;
  check(fs.existsSync(path.join(centralDir, "042-old")), `C3b: legacy dir is central (${centralDir})`);
  check(fs.existsSync(path.join(md, "task.md")), "C3b: Markdown-only dir stays in the repo with the DB on");
  check(!fs.existsSync(path.join(sb.repo, ".tasks", "042-old")), "C3b: legacy dir left the repo");
}
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t");
  fs.rmSync(sb.env.AGENTS_DB);
  const show = sb.cli(["ls", "t"]);
  check(show.status === 0, `C3c: ls <task> works with the database moved aside (${show.status} ${show.stderr})`);
  check(fs.existsSync(path.join(sb.repo, ".tasks", "001-t", "task.md")), "C3c: repo task.md survives without a database");
  check(t.files_dir.endsWith("001-t"), "C3c: the task was a repo-files task");
}
{
  const sb = sandbox();
  const expl = path.join(sb.repo, ".tasks", "050-expl");
  fs.mkdirSync(expl, { recursive: true });
  fs.writeFileSync(path.join(expl, "task.md"), "# expl\n");
  const t = create(sb, "t");
  check(fs.existsSync(path.join(path.dirname(t.task_dir), "050-expl", "task.md")), "C3d: no-DB Markdown-only dir is swept into the central root");
  check(!fs.existsSync(path.join(sb.repo, ".tasks")), "C3d: repo .tasks is gone, as before");
}
{
  const sb = sandbox();
  sb.createDb();
  const expl = path.join(sb.repo, ".tasks", "050-expl");
  fs.mkdirSync(expl, { recursive: true });
  fs.writeFileSync(path.join(expl, "task.md"), "# expl\n");
  create(sb, "t");
  check(fs.existsSync(path.join(expl, "task.md")), "C3d: the same dir stays in place with the DB on");
}

// C4: numbering spans the central root and the repo .tasks
{
  const sb = sandbox();
  sb.createDb();
  fs.mkdirSync(path.join(sb.repo, ".tasks", "007-manual"), { recursive: true });
  const t = create(sb, "t");
  check(t.number === 8 && path.basename(t.task_dir) === "008-t", `C4: new task is numbered 8 (${t.number})`);
}

// C5: plan files are found under files_dir or the central dir
function setPlan(dir, planPath) {
  const file = path.join(dir, "task.json");
  const task = readTask(dir);
  task.phases[0].plan_path = planPath;
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
}
function writePlan(root, body = "# plan\n") {
  fs.mkdirSync(path.join(root, "plan"), { recursive: true });
  fs.writeFileSync(path.join(root, "plan", "phase-1-x.md"), body);
}
const advice = (sb, dir) => JSON.parse(sb.cli(["next", "--task-dir", dir]).stdout).advice;
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  writePlan(t.files_dir);
  setPlan(t.task_dir, "plan/phase-1-x.md");
  const a = advice(sb, t.task_dir);
  check(a.phase.plan === true && a.move !== "plan", `C5: a plan under files_dir is found (${a.move})`);
}
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  writePlan(t.task_dir);
  setPlan(t.task_dir, "plan/phase-1-x.md");
  check(advice(sb, t.task_dir).phase.plan === true, "C5: plan only in the central dir is also found");
}
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  setPlan(t.task_dir, "plan/phase-1-x.md");
  const a = advice(sb, t.task_dir);
  check(a.phase.plan === false && a.move === "plan", `C5: a plan found nowhere leaves the move at plan (${a.move})`);
}
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  writePlan(t.files_dir);
  const repoRelative = path.relative(sb.repo, path.join(t.files_dir, "plan", "phase-1-x.md"));
  setPlan(t.task_dir, repoRelative);
  check(advice(sb, t.task_dir).phase.plan === true, `C5: a plan path relative to the repo root is found (${repoRelative})`);
}
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  writePlan(t.files_dir);
  setPlan(t.task_dir, path.join(t.files_dir, "plan", "phase-1-x.md"));
  check(advice(sb, t.task_dir).phase.plan === true, "C5: an absolute plan path is found");
}

// C6: readers go through the locator
{
  const sb = sandbox();
  sb.createDb();
  const t = create(sb, "t", { phases: 1 });
  const bad = path.join(t.files_dir, "task.md");
  fs.writeFileSync(bad, "---\ntask: t\n---\n\n## Phases\n\n| # | Phase | Status |\n|---|---|---|\n| 1 | P1 | done |\n");
  const lintMd = sb.cli(["plan", "lint", "--file", bad]);
  check(lintMd.status === 2, `C6: a status column in the repo task.md is linted (${lintMd.status})`);
}

// C8: worktrees get a working .tasks link
{
  const sb = sandbox();
  sb.createDb();
  create(sb, "t");
  const add = sb.cli(["worktree", "add", "--name", "x"]);
  const res = JSON.parse(add.stdout);
  check(res.tasks_link === "created", `C8: tasks_link is created (${res.tasks_link})`);
  const link = path.join(res.path, ".tasks");
  check(fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === path.join(sb.repo, ".tasks"), "C8: .tasks is a symlink to the main .tasks");
  fs.mkdirSync(path.join(link, "001-t", "plan"), { recursive: true });
  fs.writeFileSync(path.join(link, "001-t", "plan", "p.md"), "# p\n");
  check(fs.existsSync(path.join(sb.repo, ".tasks", "001-t", "plan", "p.md")), "C8: a file written through the link lands in the main .tasks");
  check(execFileSync("git", ["-C", res.path, "status", "--porcelain"], { encoding: "utf8" }) === "", "C8: the worktree is clean");
  const rm = sb.cli(["worktree", "remove", res.path], { json: false });
  check(rm.status === 0, `C8: remove without --force exits 0 (${rm.status} ${rm.stderr})`);
  check(fs.existsSync(path.join(sb.repo, ".tasks", "001-t", "plan", "p.md")), "C8: the main .tasks content survives removal");
}
{
  const sb = sandbox();
  const res = JSON.parse(sb.cli(["worktree", "add", "--name", "x"]).stdout);
  check(res.tasks_link.startsWith("skipped") && !fs.existsSync(path.join(res.path, ".tasks")), `C8: no database, no link (${res.tasks_link})`);
}

// C9: exports of old tasks stay unchanged; new tasks carry files_dir
{
  const sb = sandbox();
  const old = create(sb, "old");
  sb.createDb();
  const imp = sb.cli(["task", "import", "--apply"]);
  check(imp.status === 0, `C9: sandbox import succeeds (${imp.status} ${imp.stderr.slice(0, 200)})`);
  const n1 = create(sb, "t");
  const n2 = create(sb, "u");
  const chk = sb.cli(["export", "--check"]);
  check(chk.status === 0, `C9: export --check exits 0 (${chk.status} ${chk.stdout.slice(0, 200)})`);
  check(!("files_dir" in readTask(old.task_dir)), "C9: the old task.json has no files_dir key");
  check(readTask(n1.task_dir).files_dir === n1.files_dir && readTask(n2.task_dir).files_dir === n2.files_dir, "C9: new task.json files carry files_dir");
}

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
