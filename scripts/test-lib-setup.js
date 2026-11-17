#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/setup.js's runner: the tracked files a setup command
// itself dirtied are restored, so a worktree is born clean. The incident this
// locks: `npm ci` in a bootstrap rewrote the tracked package-lock.json at
// creation; the close-time reap keeps a dirty worktree, so the teardown (the
// worktree's database drop) never ran and the worktree was held forever with
// its resource leaked.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// One throwaway base per run (the same isolation shape as test-lib-worktree.js):
// nothing here may touch the real HOME, config or database.
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-setup-lib-")));
process.env.AGENTS_SESSIONS_ROOT = path.join(BASE, "sessions");
process.env.AGENTS_TASKS_ROOT = path.join(BASE, "tasks");
process.env.AGENTS_DB = path.join(BASE, "agents.db");
fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT);
fs.mkdirSync(process.env.AGENTS_TASKS_ROOT);
process.env.HOME = path.join(BASE, "home");
fs.mkdirSync(process.env.HOME);
const WT_ROOT = path.join(BASE, "worktrees");
fs.mkdirSync(WT_ROOT);
const CFG = path.join(BASE, "config.json");
process.env.AGENTS_CONFIG_PATH = CFG;

const setupLib = require("./lib/setup");
const taskLib = require("./lib/task");
const wt = require("./lib/worktree");

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("OK: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout || "").trim();
}

function setRepos(key, entry) {
  fs.writeFileSync(CFG, JSON.stringify({ worktrees_root: WT_ROOT, repos: { [key]: entry } }));
}

function gitdirOf(w) {
  return git(w, ["rev-parse", "--absolute-git-dir"]);
}

function recordOf(w) {
  return JSON.parse(fs.readFileSync(path.join(gitdirOf(w), "setup.json"), "utf8"));
}

// The fixture repo: two tracked files, an origin the worktree cut needs.
const repo = fs.realpathSync(fs.mkdtempSync(path.join(BASE, "repo-")));
git(repo, ["init"]);
fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
fs.writeFileSync(path.join(repo, "pre.txt"), "clean\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);
git(repo, ["branch", "-M", "main"]);
const originDir = fs.realpathSync(fs.mkdtempSync(path.join(BASE, "origin-")));
git(repo, ["init", "-q", "--bare", "-b", "main", originDir]);
git(repo, ["remote", "add", "origin", originDir]);
git(repo, ["push", "-q", "origin", "main"]);
git(repo, ["remote", "set-head", "origin", "main"]);
const key = require("./lib/repo").repoKey(repo);

function freshWorktree(label) {
  const made = taskLib.createTask({ repo: key, title: label, slug: label, session_id: "s", phases: [{ id: 1, name: "P1" }] });
  return { taskDir: made.task_dir, wtPath: wt.add({ projectDir: repo, taskDir: made.task_dir, force: true }).path };
}

try {
  // --- SU1: the runner restores the tracked files the command itself dirtied ---
  {
    setRepos(key.key, { setup: "printf 'dirt\\n' >> f.txt" });
    const { wtPath } = freshWorktree("su1");
    const r = setupLib.run(wtPath);
    const rec = recordOf(wtPath);
    check(r.state === "complete" && r.exit_code === 0, `SU1: the dirtying setup completes (${JSON.stringify(r)})`);
    check(fs.readFileSync(path.join(wtPath, "f.txt"), "utf8") === "hi\n", "SU1: f.txt is back to its HEAD content");
    check(git(wtPath, ["status", "--porcelain"]) === "", `SU1: the worktree is born clean (${git(wtPath, ["status", "--porcelain"])})`);
    check(Array.isArray(rec.restored) && JSON.stringify(rec.restored) === JSON.stringify(["f.txt"]),
      `SU1: the record names the restored file (${JSON.stringify(rec.restored)})`);
    check(JSON.stringify(r.restored) === JSON.stringify(["f.txt"]),
      `SU1: the runner's return carries the restore too (${JSON.stringify(r.restored)})`);
    check(fs.readFileSync(path.join(gitdirOf(wtPath), "setup.log"), "utf8").includes("restored f.txt"),
      "SU1: the setup log notes the restore");
  }

  // --- SU2: dirt that predates the run is never touched ---
  {
    setRepos(key.key, { setup: "printf 'dirt\\n' >> f.txt" });
    const { wtPath } = freshWorktree("su2");
    fs.appendFileSync(path.join(wtPath, "pre.txt"), "owner dirt\n");
    setupLib.run(wtPath);
    const rec = recordOf(wtPath);
    check(fs.readFileSync(path.join(wtPath, "f.txt"), "utf8") === "hi\n", "SU2: the run's own dirt was restored");
    check(fs.readFileSync(path.join(wtPath, "pre.txt"), "utf8") === "clean\nowner dirt\n", "SU2: pre-existing dirt survives untouched");
    check(JSON.stringify(rec.restored) === JSON.stringify(["f.txt"]), `SU2: only the run's file is in restored (${JSON.stringify(rec.restored)})`);
    check(git(wtPath, ["status", "--porcelain"]) === "M pre.txt", `SU2: the tree carries only the owner's dirt (${git(wtPath, ["status", "--porcelain"])})`);
  }

  // --- SU3: a completed failure restores too ---
  {
    setRepos(key.key, { setup: "printf 'dirt\\n' >> f.txt; exit 3" });
    const { wtPath } = freshWorktree("su3");
    const r = setupLib.run(wtPath);
    const rec = recordOf(wtPath);
    check(r.state === "failed" && r.exit_code === 3, `SU3: the failing run reports its exit (${JSON.stringify(r)})`);
    check(fs.readFileSync(path.join(wtPath, "f.txt"), "utf8") === "hi\n", "SU3: the failed run's dirt was still restored");
    check(JSON.stringify(rec.restored) === JSON.stringify(["f.txt"]), "SU3: the failed record names the restore");
  }

  // --- SU4: untracked files the command leaves behind are not deleted ---
  {
    setRepos(key.key, { setup: "touch new.txt" });
    const { wtPath } = freshWorktree("su4");
    setupLib.run(wtPath);
    const rec = recordOf(wtPath);
    check(fs.existsSync(path.join(wtPath, "new.txt")), "SU4: the untracked file the command created stays");
    check(!rec.restored, `SU4: nothing was restored (${JSON.stringify(rec.restored)})`);
  }

  // --- SU5: the incident end-to-end — a born-clean worktree's close runs the teardown ---
  {
    const teardownMarker = path.join(BASE, "su5-teardown-ran");
    setRepos(key.key, { setup: "printf 'dirt\\n' >> f.txt", teardown: `touch ${JSON.stringify(teardownMarker)}` });
    const { taskDir, wtPath } = freshWorktree("su5");
    setupLib.run(wtPath);
    const result = taskLib.closeTask({ taskDir, repoKeyObj: { key: key.key, main_root: repo } });
    check(result.action === "archive", `SU5: the task archives (${JSON.stringify({ action: result.action })})`);
    check(result.worktree && result.worktree.removed === true,
      `SU5: the close-time reap removes the worktree, so the teardown runs (${JSON.stringify(result.worktree && { removed: result.worktree.removed, reason: result.worktree.reason })})`);
    check(result.worktree && result.worktree.teardown && result.worktree.teardown.exit_code === 0,
      `SU5: the teardown ran and completed (${JSON.stringify(result.worktree && result.worktree.teardown)})`);
    check(fs.existsSync(teardownMarker), "SU5: the teardown command really executed");
    check(!fs.existsSync(wtPath), "SU5: the worktree directory is gone");
    check(!git(repo, ["branch", "--list", "wt/*"]).includes("su5"), `SU5: the closed task's branch went with it (${git(repo, ["branch", "--list", "wt/*"])})`);
  }

  // --- SU6: the incident's held half — a close that keeps the worktree still runs the teardown ---
  {
    const teardownMarker = path.join(BASE, "su6-teardown-ran");
    setRepos(key.key, { teardown: `touch ${JSON.stringify(teardownMarker)}` });
    const { taskDir, wtPath } = freshWorktree("su6");
    fs.appendFileSync(path.join(wtPath, "pre.txt"), "owner dirt\n"); // the owner's dirt holds the tree
    const result = taskLib.closeTask({ taskDir, repoKeyObj: { key: key.key, main_root: repo } });
    const w = result.worktree;
    check(result.action === "archive", `SU6: the task archives (${result.action})`);
    check(w && w.removed === false && w.reason === "uncommitted changes",
      `SU6: the close keeps the held worktree (${JSON.stringify(w && { removed: w.removed, reason: w.reason })})`);
    check(w && w.teardown && w.teardown.exit_code === 0,
      `SU6: the kept close still runs the teardown (${JSON.stringify(w && w.teardown)})`);
    check(fs.existsSync(teardownMarker), "SU6: the teardown command really executed");
    check(fs.existsSync(wtPath) && fs.readFileSync(path.join(wtPath, "pre.txt"), "utf8") === "clean\nowner dirt\n",
      "SU6: the worktree and its owner dirt stay");
    const again = wt.reap({ projectDir: repo, path: wtPath });
    check(again.removed === false && again.teardown && again.teardown.already_ran === true,
      `SU6: a later visit runs nothing again (${JSON.stringify(again.teardown)})`);
  }

  // --- SU7: a re-run setup voids the teardown record — the resources came
  // back, so the next visit tears down again ---
  {
    const teardownMarker = path.join(BASE, "su7-teardown-ran");
    setRepos(key.key, { setup: "true", teardown: `touch ${JSON.stringify(teardownMarker)}` });
    const { taskDir, wtPath } = freshWorktree("su7");
    setupLib.run(wtPath); // the first bootstrap completes; its marker stands
    fs.appendFileSync(path.join(wtPath, "pre.txt"), "owner dirt\n"); // the tree is held
    const first = taskLib.closeTask({ taskDir, repoKeyObj: { key: key.key, main_root: repo } });
    check(first.worktree && first.worktree.teardown && first.worktree.teardown.exit_code === 0 && fs.existsSync(teardownMarker),
      `SU7: the first kept close tears down (${JSON.stringify(first.worktree && first.worktree.teardown)})`);
    check(fs.existsSync(path.join(gitdirOf(wtPath), "teardown.json")), "SU7: the record is written");
    // the re-run gesture: delete the completion marker and run the bootstrap again
    fs.rmSync(path.join(gitdirOf(wtPath), "setup-complete"));
    setupLib.run(wtPath);
    check(!fs.existsSync(path.join(gitdirOf(wtPath), "teardown.json")), "SU7: the re-run setup voids the teardown record");
    fs.rmSync(teardownMarker);
    const second = wt.reap({ projectDir: repo, path: wtPath });
    check(second.teardown && second.teardown.exit_code === 0 && !second.teardown.already_ran && fs.existsSync(teardownMarker),
      `SU7: the next visit tears down again (${JSON.stringify(second.teardown)})`);
  }

  // --- SU8: the awareness line — pending names the pane and the wait verb ---
  {
    setRepos(key.key, { setup: "true" });
    const { wtPath } = freshWorktree("su8");
    fs.writeFileSync(path.join(gitdirOf(wtPath), "setup.json"), JSON.stringify({
      v: 1, state: "pending", command: "true", pane: "Setup-su8", pane_kind: "zmx",
      pid: process.pid, started_at: new Date().toISOString(),
    }));
    const line = setupLib.awareness(wtPath);
    check(line === `Worktree setup: a bootstrap is running in Setup-su8 (zmx attach Setup-su8) — wait for it (\`a setup wait\`) before touching the worktree's setup-built resources.`,
      `SU8: a pending bootstrap names its pane and the wait verb (${JSON.stringify(line)})`);
  }

  // --- SU9: the awareness line — failed names the exit (or the error), the tail and the re-run verb ---
  {
    setRepos(key.key, { setup: "true" });
    const { wtPath } = freshWorktree("su9");
    fs.writeFileSync(path.join(gitdirOf(wtPath), "setup.json"), JSON.stringify({
      v: 1, state: "failed", command: "true", pane: "Setup-su9", pane_kind: "zmx",
      exit_code: 3, tail: "boom\nlines",
    }));
    const line = setupLib.awareness(wtPath);
    check(line === `Worktree setup: the bootstrap died (exit 3) — last lines:\nboom\nlines\nFix it by hand, then re-run it: \`a setup run\`.`,
      `SU9: a dead bootstrap carries its exit, tail and the re-run verb (${JSON.stringify(line)})`);
    fs.writeFileSync(path.join(gitdirOf(wtPath), "setup.json"), JSON.stringify({
      v: 1, state: "failed", command: "true", pane: "Setup-su9", pane_kind: "zmx",
      error: "killed by SIGTERM", tail: "boom\nlines",
    }));
    const errLine = setupLib.awareness(wtPath);
    check(errLine === `Worktree setup: the bootstrap died (killed by SIGTERM) — last lines:\nboom\nlines\nFix it by hand, then re-run it: \`a setup run\`.`,
      `SU9: a null-exit death names the record's error, never a false exit (${JSON.stringify(errLine)})`);
  }

  // --- SU10: the awareness line stays silent — complete, absent, main checkout ---
  {
    setRepos(key.key, { setup: "true" });
    const done = freshWorktree("su10a");
    fs.writeFileSync(path.join(gitdirOf(done.wtPath), "setup.json"), JSON.stringify({
      v: 1, state: "complete", command: "true", exit_code: 0,
    }));
    fs.writeFileSync(path.join(gitdirOf(done.wtPath), "setup-complete"), "");
    check(setupLib.awareness(done.wtPath) === null, "SU10: a complete setup stays silent");
    const bare = freshWorktree("su10b");
    check(setupLib.awareness(bare.wtPath) === null, "SU10: no record at all stays silent");
    check(setupLib.awareness(repo) === null, "SU10: the main checkout stays silent");
  }
} catch (err) {
  failed++;
  console.error("FAIL: suite crashed: " + (err && err.stack || err));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
