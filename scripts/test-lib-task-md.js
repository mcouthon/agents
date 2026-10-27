#!/usr/bin/env node
"use strict";
// The phase table the engine renders into task.md between two markers, on every task write.
// Isolation: temp HOME and roots; nothing here may touch the real HOME or tasks root.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-taskmd-")));
  for (const d of ["home", "xdg", "tasks", "sessions"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
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
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_TEST_SKIP_IDENTITY", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const repoDir = path.join(T, "work", "acme");
fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
git(repoDir, "add", ".");
git(repoDir, "commit", "-q", "-m", "init");
const key = repoKey(repoDir);
db.open({ create: true });

const START = "<!-- phases:start -->";
const END = "<!-- phases:end -->";

let counter = 0;
function mkTask(phases = 2) {
  const slug = `t${++counter}`;
  const made = taskLib.createTask({ repo: key, title: slug, slug, mode: "full", tier: "standard", phases: Array.from({ length: phases }, (_, i) => ({ id: i + 1, name: `P${i + 1}` })), description: "" });
  return { dir: made.task_dir, md: path.join(taskLib.filesDir(made.task_dir), "task.md") };
}
const doc = (task) => taskLib.readTaskJson(task.dir);
const write = (task, fn) => { const d = doc(task); if (fn) fn(d); taskLib.writeTaskJson(task.dir, d); };
const mdOf = (task) => fs.readFileSync(task.md, "utf8");
/** For each line, whether it sits in or opens or closes a fenced code block (CommonMark's rule). */
function fenced(lines) {
  let open = null;
  return lines.map((l) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null;
      return true;
    }
    if (m) { open = m[1]; return true; }
    return false;
  });
}
const markerAt = (lines, marker) => { const f = fenced(lines); return lines.map((l, i) => (!f[i] && l.trim() === marker ? i : -1)).filter((i) => i >= 0); };
const count = (md, marker) => markerAt(md.split("\n"), marker).length;
/** The text with the marker block and the one blank line before it removed. */
function withoutBlock(md) {
  const lines = md.split("\n");
  const s = markerAt(lines, START)[0];
  const e = markerAt(lines, END)[0];
  lines.splice(s - 1, e - s + 2);
  return lines.join("\n");
}
/** The `#` and Status cells of every table row between the markers. */
function rows(md) {
  const lines = md.split("\n");
  const s = markerAt(lines, START)[0];
  const e = markerAt(lines, END)[0];
  return lines.slice(s, e).filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.split(/(?<!\\)\|/).map((c) => c.trim())).map((c) => `${c[1]}:${c[3]}`);
}

// ---------------------------------------------------------------- T1
{
  const task = mkTask(2);
  const md = mdOf(task);
  check(count(md, START) === 1 && count(md, END) === 1 && md.includes("## Phases\n\n" + START), "T1: a new task's task.md has one marker pair right under ## Phases");
  check(rows(md).join() === "1:not_started,2:not_started" && !md.includes("| # | Phase | Notes |") && md.includes("## Decision Log"), `T1: the rows are the phases and the empty template table is gone (${rows(md)})`);
}

// ---------------------------------------------------------------- T2, T3
{
  const task = mkTask(2);
  const original = ["---", "task: T", "---", "", "# T", "", "Intro paragraph.", "", "## Phases", "", "| # | Phase | Notes |", "|---|---|---|", "| 1 | One | history |", "", "A paragraph under the table.", "", "## Decision Log", "", "- chose x", ""].join("\n");
  fs.writeFileSync(task.md, original);
  write(task);
  const first = mdOf(task);
  check(count(first, START) === 1 && withoutBlock(first) === original && first.indexOf(START) < first.indexOf("| 1 | One | history |"), "T2: the block sits right after the heading and everything else is byte-equal, the hand table below it");
  write(task, (d) => { d.phases[0].status = "planned"; });
  const second = mdOf(task);
  check(withoutBlock(second) === original && rows(second).join() === "1:planned,2:not_started", `T3: a status change rewrites only the block (${rows(second)})`);
  const before = fs.statSync(task.md).mtimeMs;
  pauseMs(30);
  write(task);
  check(count(second, START) === 1 && mdOf(task) === second && fs.statSync(task.md).mtimeMs === before, "T3: writing the same doc again leaves the bytes and the mtime alone");
}
function pauseMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------------------------------------------------------------- T4
{
  const task = mkTask(1);
  const original = "# No phases heading\n\nJust prose.\n";
  fs.writeFileSync(task.md, original);
  write(task);
  const md = mdOf(task);
  check(md.startsWith(original) && md.includes("\n## Phases\n\n" + START) && rows(md).join() === "1:not_started", "T4: with no Phases heading it is appended after the original text");
}

// ---------------------------------------------------------------- T5
const twoStarts = { task: mkTask(1), original: ["# Two starts", "", "## Phases", "", START, "x", START, "y", END, ""].join("\n") };
{
  fs.writeFileSync(twoStarts.task.md, twoStarts.original);
  write(twoStarts.task);
  check(mdOf(twoStarts.task) === twoStarts.original, "T5: two start markers leave the file untouched");
}

// ---------------------------------------------------------------- T8
{
  const task = mkTask(1);
  write(task, (d) => { d.phases[0].note = "a | b\nc"; });
  check(mdOf(task).includes("a \\| b c"), "T8: a pipe in a note is escaped and a newline becomes a space");
}

// ---------------------------------------------------------------- T9
{
  const task = mkTask(1);
  const original = ["# Fences", "", "```", "## Phases", START, "```", "", "text", "", "## Phases", "", "## Decision Log", ""].join("\n");
  fs.writeFileSync(task.md, original);
  write(task);
  const md = mdOf(task);
  const lines = md.split("\n");
  check(lines.slice(0, 6).join("\n") === original.split("\n").slice(0, 6).join("\n") && md.indexOf(START, md.indexOf("text")) > md.indexOf("text") && count(md, END) === 1,
    "T9: a heading and a marker inside a backtick fence are left alone and the block goes under the real heading");
  const tilde = mkTask(1);
  const tildeOriginal = ["# Tilde", "", "~~~", "## Phases", "~~~", "", "text", ""].join("\n");
  fs.writeFileSync(tilde.md, tildeOriginal);
  write(tilde);
  const tmd = mdOf(tilde);
  check(tmd.startsWith(tildeOriginal) && tmd.endsWith(END + "\n") && tmd.indexOf("## Phases", tildeOriginal.length) > 0, "T9: a heading only inside a ~~~ fence counts as no heading, so the section is appended");
}

// ---------------------------------------------------------------- T6
{
  const central = mkTask(2);
  write(central, (d) => { delete d.files_dir; });
  fs.writeFileSync(path.join(central.dir, "task.md"), "# Central\n\n## Phases\n\n## Decision Log\n");
  write(central);
  const noFiles = path.join(central.dir, "task.md");
  const recorded = new Map();
  for (const row of db.listTasks()) {
    const d = taskLib.readTaskJson(row.task_dir);
    const md = path.join(taskLib.filesDir(row.task_dir, d), "task.md");
    if (fs.existsSync(md) && row.task_dir !== twoStarts.task.dir && count(fs.readFileSync(md, "utf8"), START) === 1) recorded.set(row.task_dir, withoutBlock(fs.readFileSync(md, "utf8")));
  }
  for (const row of db.listTasks()) {
    const d = taskLib.readTaskJson(row.task_dir);
    d.phases.forEach((p) => { p.status = "planned"; });
    taskLib.writeTaskJson(row.task_dir, d);
  }
  let checked = 0, bad = [];
  for (const row of db.listTasks()) {
    const d = taskLib.readTaskJson(row.task_dir);
    const md = taskLib.taskMdPath(row.task_dir, d);
    if (!fs.existsSync(md)) continue;
    const text = fs.readFileSync(md, "utf8");
    if (row.task_dir === twoStarts.task.dir) {
      if (text !== twoStarts.original) bad.push(`${row.dir_name}: the two-start file changed`);
      continue;
    }
    if (count(text, START) !== 1) { bad.push(`${row.dir_name}: ${count(text, START)} start markers`); continue; }
    checked++;
    const expected = d.phases.map((p) => `${p.id}:planned`).join();
    if (count(text, END) !== 1 || rows(text).join() !== expected) bad.push(`${row.dir_name}: rows ${rows(text)} vs ${expected}`);
    if (recorded.has(row.task_dir) && withoutBlock(text) !== recorded.get(row.task_dir)) bad.push(`${row.dir_name}: text outside the block changed`);
  }
  check(checked >= 7 && fs.readFileSync(noFiles, "utf8").includes(START), `T6: every task row in the database renders one block matching its phases and leaves the rest alone (${checked} checked)`);
  check(bad.length === 0, `T6: no task's table or outside text is off (${bad.join("; ")})`);
}

// ---------------------------------------------------------------- T7
{
  const base = path.join(T, "t7");
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, "task.md");
  fs.writeFileSync(file, "# Plain\n\n## Phases\n\n");
  const child = require("child_process").spawnSync(process.execPath, ["-e", `
    process.env.AGENTS_DB = ${JSON.stringify(path.join(base, "none.db"))};
    process.env.AGENTS_TASKS_ROOT = ${JSON.stringify(path.join(base, "tasks"))};
    const t = require(${JSON.stringify(path.join(__dirname, "lib", "task"))});
    const dir = ${JSON.stringify(base)};
    t.writeTaskJson(dir, { schema: 2, slug: "x", phases: [{ id: 1, name: "One", status: "not_started" }] });
  `], { encoding: "utf8" });
  check(child.status === 0 && fs.readFileSync(file, "utf8") === "# Plain\n\n## Phases\n\n", `T7: without a database a write leaves task.md alone (${child.status}: ${child.stderr.trim()})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
