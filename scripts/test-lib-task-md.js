#!/usr/bin/env node
"use strict";
// The phases block the engine renders into task.md between two markers, from the
// database's view, on every intent write; the sandbox guard on the render.
// Isolation: temp HOME and roots; nothing here may touch the real HOME or tasks root.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-taskmd-")));
  for (const d of ["home", "xdg", "tasks", "sessions"]) fs.mkdirSync(t + "/" + d);
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
const decide = require("./lib/decide");
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
  const made = taskLib.createTask({ repo: key, title: slug, slug, mode: "full", tier: "standard", phases: Array.from({ length: phases }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, blocked_by: i > 0 ? [i] : [] })), description: "" });
  return { dir: made.task_dir, md: path.join(made.task_dir, "task.md"), id: db.taskIdOf(made.task_dir) };
}
const viewOf = (task) => taskLib.readTaskJson(task.dir);
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
  check(rows(md).join() === "1:[ ],2:[ ]" && !md.includes("| # | Phase | Notes |") && md.includes("## Decision Log"), `T1: the rows are the phases and the empty template table is gone (${rows(md)})`);
  check(!fs.existsSync(path.join(task.dir, "task.json")), "T1: no task.json is written");
}

// ---------------------------------------------------------------- T2, T3
{
  const task = mkTask(2);
  const original = ["---", "task: T", "---", "", "# T", "", "Intro paragraph.", "", "## Phases", "", "| # | Phase | Notes |", "|---|---|---|", "| 1 | One | history |", "", "A paragraph under the table.", "", "## Decision Log", "", "- chose x", ""].join("\n");
  fs.writeFileSync(task.md, original);
  decide.note({ taskDir: task.dir, phaseId: 1, text: "note one" });
  const first = mdOf(task);
  check(count(first, START) === 1 && withoutBlock(first) === original && first.indexOf(START) < first.indexOf("| 1 | One | history |"), "T2: the block sits right after the heading and everything else is byte-equal, the hand table below it");
  taskLib.checkPhase({ taskDir: task.dir, phaseId: 1 });
  const second = mdOf(task);
  check(withoutBlock(second) === original && rows(second).join() === "1:[x],2:[ ]", `T3: a checkmark rewrites only the block (${rows(second)})`);
  const before = fs.statSync(task.md).mtimeMs;
  pauseMs(30);
  decide.note({ taskDir: task.dir, phaseId: 1, text: "note two" });
  check(count(mdOf(task), START) === 1 && fs.statSync(task.md).mtimeMs > before, "T3: a second note renders again (append-only notes change the block)");
}
function pauseMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------------------------------------------------------------- T4
{
  const task = mkTask(1);
  const original = "# No phases heading\n\nJust prose.\n";
  fs.writeFileSync(task.md, original);
  taskLib.setKnob({ taskDir: task.dir, knob: "land", value: "at_end" });
  const md = mdOf(task);
  check(md.startsWith(original) && md.includes("\n## Phases\n\n" + START) && rows(md).join() === "1:[ ]", "T4: with no Phases heading it is appended after the original text");
}

// ---------------------------------------------------------------- T5
const twoStarts = { task: mkTask(1), original: ["# Two starts", "", "## Phases", "", START, "x", START, "y", END, ""].join("\n") };
{
  fs.writeFileSync(twoStarts.task.md, twoStarts.original);
  taskLib.setKnob({ taskDir: twoStarts.task.dir, knob: "land", value: "at_end" });
  check(mdOf(twoStarts.task) === twoStarts.original, "T5: two start markers leave the file untouched");
}

// ---------------------------------------------------------------- T8
{
  const task = mkTask(1);
  decide.note({ taskDir: task.dir, phaseId: 1, text: "a | b\nc" });
  check(mdOf(task).includes("a \\| b c"), "T8: a pipe in a note is escaped and a newline becomes a space");
}

// ---------------------------------------------------------------- T9
{
  const task = mkTask(1);
  const original = ["# Fences", "", "```", "## Phases", START, "```", "", "text", "", "## Phases", "", "## Decision Log", ""].join("\n");
  fs.writeFileSync(task.md, original);
  decide.note({ taskDir: task.dir, phaseId: 1, text: "fenced" });
  const md = mdOf(task);
  const lines = md.split("\n");
  check(lines.slice(0, 6).join("\n") === original.split("\n").slice(0, 6).join("\n") && md.indexOf(START, md.indexOf("text")) > md.indexOf("text") && count(md, END) === 1,
    "T9: a heading and a marker inside a backtick fence are left alone and the block goes under the real heading");
  const tilde = mkTask(1);
  const tildeOriginal = ["# Tilde", "", "~~~", "## Phases", "~~~", "", "text", ""].join("\n");
  fs.writeFileSync(tilde.md, tildeOriginal);
  decide.note({ taskDir: tilde.dir, phaseId: 1, text: "tilded" });
  const tmd = mdOf(tilde);
  check(tmd.startsWith(tildeOriginal) && tmd.endsWith(END + "\n") && tmd.indexOf("## Phases", tildeOriginal.length) > 0, "T9: a heading only inside a ~~~ fence counts as no heading, so the section is appended");
}

// ---------------------------------------------------------------- T6: every row renders one block matching its phases
{
  const made = [mkTask(2), mkTask(2), mkTask(1)];
  for (const task of made) taskLib.checkPhase({ taskDir: task.dir, phaseId: 1 });
  const recorded = new Map();
  for (const row of db.listTasks()) {
    if (!fs.existsSync(path.join(row.task_dir, "task.md"))) continue;
    const text = fs.readFileSync(path.join(row.task_dir, "task.md"), "utf8");
    if (row.task_dir !== twoStarts.task.dir && count(text, START) === 1) recorded.set(row.task_dir, withoutBlock(text));
  }
  const exportOut = require("./lib/db-export").exportInPlace();
  check(exportOut.rendered >= recorded.size, `T6: exportInPlace re-renders every home task (${exportOut.rendered} rendered, ${exportOut.skipped.length} skipped)`);
  let checked = 0, bad = [];
  for (const row of db.listTasks()) {
    const md = path.join(row.task_dir, "task.md");
    if (!fs.existsSync(md)) continue;
    const text = fs.readFileSync(md, "utf8");
    if (row.task_dir === twoStarts.task.dir) {
      if (text !== twoStarts.original) bad.push(`${row.dir_name}: the two-start file changed`);
      continue;
    }
    if (count(text, START) !== 1) { bad.push(`${row.dir_name}: ${count(text, START)} start markers`); continue; }
    checked++;
    const view = taskLib.readTaskJson(row.task_dir);
    const expected = view.phases.map((p) => `${p.id}:${p.checked ? (p.skipped ? "[-]" : "[x]") : "[ ]"}`).join();
    if (count(text, END) !== 1 || rows(text).join() !== expected) bad.push(`${row.dir_name}: rows ${rows(text)} vs ${expected}`);
    if (recorded.has(row.task_dir) && withoutBlock(text) !== recorded.get(row.task_dir)) bad.push(`${row.dir_name}: text outside the block changed`);
  }
  check(checked >= 7, `T6: every task row in the database renders one block matching its phases (${checked} checked)`);
  check(bad.length === 0, `T6: no task's table or outside text is off (${bad.join("; ")})`);
}

// ---------------------------------------------------------------- T10: the sandbox guard on the render
{
  // a task row whose task_dir lies in a sibling of the sandbox root: the note
  // row is written, its task.md bytes are unchanged and stderr says why
  const orig = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = require("node:sqlite");
  process.emitWarning = orig;
  const R = fs.mkdtempSync(path.join(require("os").tmpdir(), "agents-mdguard-"));
  const home = path.join(R, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(R, "sessions"), { recursive: true });
  const outsideDir = path.join(`${R}-other`, "guard-task");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "task.md"), "# Outside\n\n## Phases\n\n## Decision Log\n");
  const before = fs.readFileSync(path.join(outsideDir, "task.md"), "utf8");
  const child = (args, extra = {}) => require("child_process").spawnSync(process.execPath, [path.join(__dirname, "bin", "a"), ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AGENTS_TASKS_ROOT: path.join(R, "tasks"), AGENTS_SESSIONS_ROOT: path.join(R, "sessions"), AGENTS_DB: path.join(R, "agents.db"), ...extra },
    timeout: 30000,
  });
  const make = child(["task", "new", "--title", "Guard", "--slug", "guard", "--repo", repoDir, "--phases-json", JSON.stringify([{ id: 1, name: "One" }])]);
  const guardDir = make.stdout ? JSON.parse(make.stdout).task_dir : null;
  check(guardDir && guardDir.startsWith(R), `T10: the guard task sits under the sandbox root (${guardDir})`);

  const readNotes = () => {
    const d = new DatabaseSync(path.join(R, "agents.db"), { readOnly: true });
    try { return d.prepare("SELECT n.text, n.phase_id FROM notes n JOIN tasks t ON t.id = n.task_id WHERE t.dir_name = '001-guard'").all(); }
    finally { d.close(); }
  };
  const pointRowOutside = () => {
    const d = new DatabaseSync(path.join(R, "agents.db"));
    d.prepare("UPDATE tasks SET task_dir = ? WHERE dir_name = '001-guard'").run(outsideDir);
    d.close();
  };
  const restoreRow = () => {
    const d = new DatabaseSync(path.join(R, "agents.db"));
    d.prepare("UPDATE tasks SET task_dir = ? WHERE dir_name = '001-guard'").run(guardDir);
    d.close();
  };

  pointRowOutside();
  const note = child(["task", "note", "--task-dir", guardDir, "--phase-id", "1", "--text", "outside note"]);
  check(note.status === 0, `T10: the note on an outside task_dir exits 0 (${note.status}: ${note.stderr.trim().slice(0, 80)})`);
  check(readNotes().some((n) => n.text === "outside note"), "T10: the note row is written to the database");
  check(fs.readFileSync(path.join(outsideDir, "task.md"), "utf8") === before, "T10: the outside task.md bytes are unchanged");
  check(note.stderr.includes("outside sandbox"), `T10: stderr names the sandbox guard (${note.stderr.trim().split("\n")[0]})`);

  // a row under the root reached through a symlinked alias of the root renders
  restoreRow();
  const alias = path.join(R, "alias");
  fs.symlinkSync(R, alias);
  const aliasDir = guardDir.split(R).join(alias);
  const aliasNote = child(["task", "note", "--task-dir", aliasDir, "--phase-id", "1", "--text", "via alias"],
    { AGENTS_TASKS_ROOT: path.join(alias, "tasks"), AGENTS_DB: path.join(alias, "agents.db") });
  check(readNotes().some((n) => n.text === "via alias"), `T10: the aliased note landed (${aliasNote.stderr.trim().split("\n")[0]})`);
  check(fs.existsSync(path.join(guardDir, "task.md")) && fs.readFileSync(path.join(guardDir, "task.md"), "utf8").includes("via alias"),
    "T10: a task_dir under the root through the alias is rendered");
}

// ---------------------------------------------------------------- T11: a pending fold keeps the render off
{
  const task = mkTask(1);
  const conn = db.open();
  conn.run("INSERT INTO pending_folds (task_id, path) VALUES (?, ?)", task.id, path.join(T, "pending-fold"));
  db.close();
  const before = fs.existsSync(task.md) ? fs.readFileSync(task.md, "utf8") : null;
  decide.note({ taskDir: task.dir, phaseId: 1, text: "folded" });
  const after = fs.existsSync(task.md) ? fs.readFileSync(task.md, "utf8") : null;
  check(before === null || after === before, "T11: an intent write does not create or change a folded task's task.md");
  check(db.listNotes(task.id).some((n) => n.text === "folded"), "T11: the note row itself is written");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
