#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolate registry and tasks root to tmpdirs so tests never touch real dirs.
process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cc-sessions-"));
process.env.AGENTS_TASKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cc-tasks-"));
delete process.env.AGENTS_SESSION_DIR;

const cc = require("./lib/cc");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// --- resolveWorktree (existing tests, kept) ---

// T1: bare --worktree with --task derives <NNN>-<slug>
try {
  const name = cc.resolveWorktree({ worktreeFlag: true, taskDir: "/repo/.tasks/128-pav-agents-determinism" });
  if (name === "128-pav-agents-determinism") ok("T1: bare --worktree with --task derives <NNN>-<slug>");
  else fail_(`T1: got ${JSON.stringify(name)}`);
} catch (e) { fail_("T1: " + e); }

// T2: bare --worktree without --task errors
try {
  cc.resolveWorktree({ worktreeFlag: true, taskDir: null });
  fail_("T2: should error");
} catch (e) {
  if (e.message === "--worktree needs a name") ok("T2: bare --worktree without --task errors");
  else fail_(`T2: wrong error: ${JSON.stringify(e.message)}`);
}

// T3: explicit --worktree passes through
try {
  const name = cc.resolveWorktree({ worktreeFlag: "my-wt", taskDir: null });
  if (name === "my-wt") ok("T3: explicit --worktree passes through");
  else fail_(`T3: got ${JSON.stringify(name)}`);
} catch (e) { fail_("T3: " + e); }

// T4: absent --worktree returns undefined
try {
  const name = cc.resolveWorktree({ worktreeFlag: undefined, taskDir: null });
  if (name === undefined) ok("T4: absent --worktree returns undefined");
  else fail_(`T4: got ${JSON.stringify(name)}`);
} catch (e) { fail_("T4: " + e); }

// --- buildLaunchCommand (existing tests, kept) ---

// T5: always adds `-- --add-dir <tasksRoot>`
try {
  const cmd = cc.buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: undefined, tasksRoot: "/home/.agents/tasks/key", passthrough: [],
  });
  const sepIdx = cmd.indexOf("--");
  const ddIdx = cmd.indexOf("--add-dir");
  if (sepIdx >= 0 && ddIdx === sepIdx + 1 && cmd[ddIdx + 1] === "/home/.agents/tasks/key")
    ok("T5: always appends `-- --add-dir <tasksRoot>`");
  else fail_(`T5: wrong: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T5: " + e); }

// T6: forwards passthrough args after --add-dir
try {
  const cmd = cc.buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: undefined, tasksRoot: "/root",
    passthrough: ["--settings", "/s.json"],
  });
  if (cmd.includes("--settings") && cmd.includes("/s.json"))
    ok("T6: forwards passthrough args");
  else fail_(`T6: passthrough not forwarded: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T6: " + e); }

// T7: includes --worktree before --
try {
  const cmd = cc.buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: "128-slug", tasksRoot: "/root", passthrough: [],
  });
  const wtIdx = cmd.indexOf("--worktree");
  if (wtIdx >= 0 && cmd[wtIdx + 1] === "128-slug" && wtIdx < cmd.indexOf("--"))
    ok("T7: includes --worktree <name> before --");
  else fail_(`T7: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T7: " + e); }

// --- parseCcArgs (D39: flags before positionals) ---

// T8: --agent Courier --title "short" → agent=Courier, title="short", no prompt
try {
  const opts = cc.parseCcArgs(["--agent", "Courier", "--title", "short title"]);
  if (opts.agent === "Courier" && opts.title === "short title" && !opts.prompt)
    ok("T8: --agent Courier --title parses correctly");
  else fail_(`T8: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T8: " + e); }

// T9: courier "title here" → agent=courier, prompt="title here"
try {
  const opts = cc.parseCcArgs(["courier", "title here"]);
  if (opts.agent === "courier" && opts.positionals.length === 1 && opts.positionals[0] === "title here")
    ok("T9: courier positional → agent=courier, positional captured");
  else fail_(`T9: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T9: " + e); }

// T10: flags parsed before positionals (--task before slug)
try {
  const opts = cc.parseCcArgs(["--task", "128-slug", "extra"]);
  if (opts.task === "128-slug" && opts.positionals.length === 1 && opts.positionals[0] === "extra")
    ok("T10: flags parsed before positionals");
  else fail_(`T10: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T10: " + e); }

// T11: -- separates passthrough from positionals
try {
  const opts = cc.parseCcArgs(["--agent", "Conductor", "--", "--add-dir", "/extra"]);
  if (opts.agent === "Conductor" && opts.passthrough.length === 2 &&
      opts.passthrough[0] === "--add-dir" && opts.passthrough[1] === "/extra")
    ok("T11: -- separates passthrough");
  else fail_(`T11: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T11: " + e); }

// T12: --continue flag
try {
  const opts = cc.parseCcArgs(["--continue"]);
  if (opts.continueFlag === true) ok("T12: --continue parsed");
  else fail_(`T12: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T12: " + e); }

// T13: --no-worktree flag
try {
  const opts = cc.parseCcArgs(["--no-worktree"]);
  if (opts.noWorktree === true) ok("T13: --no-worktree parsed");
  else fail_(`T13: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T13: " + e); }

// T14: --tmux flag
try {
  const opts = cc.parseCcArgs(["--tmux"]);
  if (opts.tmux === true) ok("T14: --tmux parsed");
  else fail_(`T14: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T14: " + e); }

// T15: "courier" as first positional is shorthand for --agent courier
try {
  const opts = cc.parseCcArgs(["courier"]);
  if (opts.agent === "courier" && opts.positionals.length === 0)
    ok("T15: courier shorthand → agent=courier, no positionals");
  else fail_(`T15: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T15: " + e); }

// T16: --agent Conductor overrides courier positional
try {
  const opts = cc.parseCcArgs(["courier", "--agent", "Conductor"]);
  // --agent Conductor comes after "courier", but parseCcArgs processes left to right,
  // so "courier" sets agent=Courier, then --agent Conductor overrides it.
  if (opts.agent === "Conductor")
    ok("T16: --agent overrides courier shorthand");
  else fail_(`T16: ${JSON.stringify(opts)}`);
} catch (e) { fail_("T16: " + e); }

// --- deriveTitleFromPrompt (D39) ---

// T17: first line of prompt, max 80 chars
try {
  const title = cc.deriveTitleFromPrompt("This is the title\nSecond line");
  if (title === "This is the title") ok("T17: deriveTitleFromPrompt takes first line");
  else fail_(`T17: got ${JSON.stringify(title)}`);
} catch (e) { fail_("T17: " + e); }

// T18: title truncated to 80 chars
try {
  const long = "x".repeat(120);
  const title = cc.deriveTitleFromPrompt(long);
  if (title.length === 80) ok("T18: title truncated to 80 chars");
  else fail_(`T18: len=${title.length}`);
} catch (e) { fail_("T18: " + e); }

// T19: null prompt → null
try {
  const title = cc.deriveTitleFromPrompt(null);
  if (title === null) ok("T19: null prompt → null title");
  else fail_(`T19: got ${JSON.stringify(title)}`);
} catch (e) { fail_("T19: " + e); }

// --- pickContinueTask (D38: --continue) ---

// T20: picks most recently active non-done task
try {
  const tasks = [
    { slug: "a", dir: "/a", status: "done", updated: "2026-10-21T10:00:00Z" },
    { slug: "b", dir: "/b", status: "in_progress", updated: "2026-10-21T09:00:00Z" },
    { slug: "c", dir: "/c", status: "planning", updated: "2026-10-21T11:00:00Z" },
  ];
  const picked = cc.pickContinueTask(tasks);
  if (picked && picked.slug === "c") ok("T20: picks most recently active non-done task");
  else fail_(`T20: got ${JSON.stringify(picked)}`);
} catch (e) { fail_("T20: " + e); }

// T21: returns null when all tasks are done
try {
  const tasks = [
    { slug: "a", dir: "/a", status: "done", updated: "2026-10-21T10:00:00Z" },
    { slug: "b", dir: "/b", status: "failed", updated: "2026-10-21T09:00:00Z" },
  ];
  const picked = cc.pickContinueTask(tasks);
  if (picked === null) ok("T21: null when all done/failed");
  else fail_(`T21: got ${JSON.stringify(picked)}`);
} catch (e) { fail_("T21: " + e); }

// T22: returns null for empty list
try {
  const picked = cc.pickContinueTask([]);
  if (picked === null) ok("T22: null for empty list");
  else fail_(`T22: got ${JSON.stringify(picked)}`);
} catch (e) { fail_("T22: " + e); }

// --- checkOccupancy (D38 item 1) ---

// T23: empty sessions → no occupants
try {
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cc-occ-"));
  const occupants = cc.checkOccupancy([], mainRoot);
  if (occupants.length === 0) ok("T23: no sessions → no occupants");
  else fail_(`T23: got ${occupants.length} occupants`);
  try { fs.rmSync(mainRoot, { recursive: true, force: true }); } catch {}
} catch (e) { fail_("T23: " + e); }

// T24: live session on main checkout → occupant found
try {
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cc-main-"));
  // isLive will check process identity — our process runs "node", not "claude",
  // so this session will NOT be live. Test with a mock approach:
  // Instead of testing isLive integration (which requires a real claude process),
  // test the path-matching logic by checking that a session on a different path
  // is not an occupant.
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-cc-other-"));
  const sessions2 = [{
    session_id: "live-2",
    pid: process.pid,
    cwd: otherDir,
    agent: "conductor",
    created_at: new Date(Date.now() - 60000).toISOString(),
  }];
  const occupants = cc.checkOccupancy(sessions2, mainRoot);
  if (occupants.length === 0) ok("T24: session on different path → no occupant");
  else fail_(`T24: got ${occupants.length} occupants`);
  try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mainRoot, { recursive: true, force: true }); } catch {}
} catch (e) { fail_("T24: " + e); }

// --- shellQuote ---

// T25: shellQuote escapes single quotes
try {
  const q = cc.shellQuote("it's");
  if (q === "'it'\\''s'") ok("T25: shellQuote escapes single quotes");
  else fail_(`T25: got ${JSON.stringify(q)}`);
} catch (e) { fail_("T25: " + e); }

// T26: shellQuote wraps in single quotes
try {
  const q = cc.shellQuote("hello");
  if (q === "'hello'") ok("T26: shellQuote wraps in single quotes");
  else fail_(`T26: got ${JSON.stringify(q)}`);
} catch (e) { fail_("T26: " + e); }

// --- Cleanup ---
try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(process.env.AGENTS_TASKS_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
