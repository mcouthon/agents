#!/usr/bin/env node
// AGENTS git-worktree helper -- create/open/merge/remove/list/status/clean worktrees.
//
// One worktree per workstream = one branch = one isolated working tree/index/HEAD.
// The state server auto-resolves .tasks/ to the repo's MAIN checkout, so every
// worktree of a repo shares ONE tasks.json dashboard with no env setup needed.
//
// Usage:
//   npm run worktree -- add <branch> [path]                Create a branch + linked worktree
//   npm run worktree -- add --task <NNN> [path]            Auto-name branch wt/<NNN>-<task-slug>
//   npm run worktree -- add --auto [path]                  Auto-name branch wt/auto-<timestamp>
//   npm run worktree -- open <path>                        Open a worktree in a new VS Code window
//   npm run worktree -- merge <branch> [--into <target>]   Merge a branch into target/main
//   npm run worktree -- remove <path>                      Remove a worktree and prune
//   npm run worktree -- list                               List all worktrees
//   npm run worktree -- status                             Task-aware overview with merge state
//   npm run worktree -- clean [--force]                    Remove worktrees whose branch is merged
//
// add parses flags in any position around the positionals; --task and --auto
// are mutually exclusive and replace the <branch> positional. clean skips
// worktrees with uncommitted changes even under --force.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Run a command with fixed args, inheriting stdio. Never uses a shell. */
function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

/** Run a command and capture trimmed stdout. */
function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** True if an executable is resolvable on PATH. */
function onPath(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fail(msg) {
  console.error(`worktree: ${msg}`);
  process.exit(1);
}

const USAGE =
  "Usage:\n" +
  "  npm run worktree -- add <branch> [path]\n" +
  "  npm run worktree -- add --task <NNN> [path]      branch wt/<NNN>-<task-slug>\n" +
  "  npm run worktree -- add --auto [path]            branch wt/auto-<timestamp>\n" +
  "  npm run worktree -- open <path>\n" +
  "  npm run worktree -- merge <branch> [--into <target>]\n" +
  "  npm run worktree -- remove <path>\n" +
  "  npm run worktree -- list\n" +
  "  npm run worktree -- status\n" +
  "  npm run worktree -- clean [--force]";

/** Repo main-checkout root (parent of the shared .git dir) for any cwd inside it. */
function mainRoot() {
  try {
    return path.dirname(
      capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    );
  } catch {
    // git < 2.31 lacks --path-format; the bare form may return a relative path
    return path.dirname(path.resolve(capture("git", ["rev-parse", "--git-common-dir"])));
  }
}

/** The repo's primary branch ("main" or "master"), or null if neither exists. */
function baseBranch() {
  for (const b of ["main", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${b}^{commit}`], {
        stdio: "ignore",
      });
      return b;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Parse `git worktree list --porcelain` into [{ path, branch }]. */
function parseWorktrees() {
  const out = capture("git", ["worktree", "list", "--porcelain"]);
  const wts = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      wts.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length);
    } else if (line === "") {
      cur = null;
    }
  }
  return wts;
}

/** refs/heads/wt/x -> wt/x */
function shortBranch(ref) {
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

/** Names of branches whose tip is an ancestor of base (i.e. merged into it). */
function mergedBranches(base) {
  const out = capture("git", ["branch", "--merged", base]);
  const names = new Set();
  for (const line of out.split("\n")) {
    const name = line.replace(/^[*+]\s*/, "").trim();
    if (name && !name.startsWith("(")) names.add(name);
  }
  return names;
}

/** True if a worktree has modified or untracked files. */
function isDirty(wtPath) {
  return capture("git", ["-C", wtPath, "status", "--porcelain"]).length > 0;
}

/** Branch for --task <NNN>: wt/<NNN>-<slug> from .tasks/<NNN>-<slug>; wt/<NNN>-unnamed if absent. */
function taskBranch(task) {
  if (!/^\d+$/.test(task)) fail(`--task expects a numeric task number, got "${task}"`);
  const tasksDir = path.join(mainRoot(), ".tasks");
  let slug = null;
  if (fs.existsSync(tasksDir)) {
    const found = fs.readdirSync(tasksDir).find((d) => d.startsWith(`${task}-`));
    if (found) slug = found.replace(/^\d+-/, "");
  }
  return `wt/${task}-${slug || "unnamed"}`;
}

/** wt/auto-<YYYYMMDD-HHMMSS> */
function autoBranch() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `wt/auto-${ts}`;
}

function cmdAdd(args) {
  // Flag grammar: flags parse in any position around the positionals.
  // --task/--auto are mutually exclusive, replace the <branch> positional,
  // and leave at most one optional [path].
  const printPath = args.includes("--print-path");
  let task = null;
  let auto = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--print-path") continue;
    if (args[i] === "--task") {
      task = args[++i];
      if (!task) fail("--task requires a task number");
    } else if (args[i] === "--auto") {
      auto = true;
    } else {
      positional.push(args[i]);
    }
  }
  if (task && auto) fail("--task and --auto are mutually exclusive");
  const maxPos = task || auto ? 1 : 2;
  if (positional.length > maxPos) {
    fail(`add takes at most ${task || auto ? "[path]" : "<branch> [path]"}\n${USAGE}`);
  }

  const branch = task ? taskBranch(task) : auto ? autoBranch() : positional[0];
  if (!branch) fail(`add requires <branch> (or --task <NNN> / --auto)\n${USAGE}`);
  const pathArg = task || auto ? positional[0] : positional[1];
  const repoRoot = capture("git", ["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoRoot);
  const slug = branch.replace(/\//g, "-");
  const wtPath = pathArg
    ? path.resolve(pathArg)
    : path.resolve(repoRoot, "..", `${repoName}-${slug}`);
  if (printPath) {
    // Redirect git's stdout to stderr so stdout carries only the bare path
    const gitOut = execFileSync("git", ["worktree", "add", "-b", branch, wtPath], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    });
    if (gitOut.trim()) console.error(gitOut.trim());
  } else {
    run("git", ["worktree", "add", "-b", branch, wtPath]);
  }

  const hints = [
    `\nWorktree created at ${wtPath} on branch ${branch}.`,
    ".tasks/ auto-resolves to this repo's main checkout -- no env setup needed.",
    `\nLaunch Claude Code:   cd ${wtPath} && claude`,
  ];
  if (onPath("code")) hints.push(`Open in VS Code:      code ${wtPath}`);

  if (printPath) {
    hints.forEach((h) => console.error(h));
    console.log(wtPath);
  } else {
    hints.forEach((h) => console.log(h));
  }
}

function cmdOpen(args) {
  const wtPath = args[0];
  if (!wtPath) fail(`open requires <path>\n${USAGE}`);
  if (!onPath("code")) fail("`code` is not on PATH; open the worktree folder manually.");
  run("code", [path.resolve(wtPath)]);
}

function cmdMerge(args) {
  const branch = args[0];
  if (!branch) fail(`merge requires <branch>\n${USAGE}`);
  let target = "main";
  const intoIdx = args.indexOf("--into");
  if (intoIdx !== -1) {
    target = args[intoIdx + 1];
    if (!target) fail("--into requires a target branch");
  }
  run("git", ["switch", target]);
  try {
    run("git", ["merge", branch]);
  } catch {
    fail(
      `merge of ${branch} into ${target} hit conflicts. ` +
        "Resolve them manually, then `git commit`; nothing was auto-resolved."
    );
  }
  console.log(`\nMerged ${branch} into ${target}.`);
}

function cmdRemove(args) {
  const wtPath = args[0];
  if (!wtPath) fail(`remove requires <path>\n${USAGE}`);
  run("git", ["worktree", "remove", path.resolve(wtPath)]);
  run("git", ["worktree", "prune"]);
  console.log(`\nRemoved worktree ${wtPath} and pruned.`);
}

function cmdList() {
  run("git", ["worktree", "list"]);
}

/** Task association heuristic: branch wt/X maps to .tasks/X when that dir exists. */
function taskFor(branchShort, taskDirs, isMain) {
  if (isMain) return "(main checkout)";
  const m = /^wt\/(.+)$/.exec(branchShort);
  if (m && taskDirs.includes(m[1])) return m[1];
  return "(no task)";
}

function cmdStatus() {
  const root = mainRoot();
  const wts = parseWorktrees();
  const tasksDir = path.join(root, ".tasks");
  const taskDirs = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((d) => /^\d+-/.test(d))
    : [];
  const base = baseBranch();
  const merged = base ? mergedBranches(base) : new Set();

  const rows = wts.map((wt) => {
    const isMain = path.resolve(wt.path) === path.resolve(root);
    const branch = shortBranch(wt.branch) || "(detached)";
    const task = taskFor(branch, taskDirs, isMain);
    const status = !isMain && base && merged.has(branch) ? "merged (stale)" : isMain ? "-" : "active";
    return { path: wt.path, branch, task, status };
  });

  const wPath = Math.max("WORKTREE".length, ...rows.map((r) => r.path.length));
  const wBranch = Math.max("BRANCH".length, ...rows.map((r) => r.branch.length));
  const wTask = Math.max("TASK".length, ...rows.map((r) => r.task.length));
  console.log(
    "WORKTREE".padEnd(wPath) + "  " +
      "BRANCH".padEnd(wBranch) + "  " +
      "TASK".padEnd(wTask) + "  STATUS"
  );
  for (const r of rows) {
    console.log(
      r.path.padEnd(wPath) + "  " +
        r.branch.padEnd(wBranch) + "  " +
        r.task.padEnd(wTask) + "  " + r.status
    );
  }
}

function cmdClean(args) {
  const force = args.includes("--force");
  const root = mainRoot();
  const base = baseBranch();
  if (!base) fail("clean requires a main or master branch to detect merged worktrees");
  const merged = mergedBranches(base);
  const stale = parseWorktrees().filter((wt) => {
    const short = shortBranch(wt.branch);
    return (
      path.resolve(wt.path) !== path.resolve(root) &&
      short &&
      short !== base &&
      merged.has(short)
    );
  });
  if (stale.length === 0) {
    console.log("No stale worktrees -- nothing merged to remove.");
    return;
  }

  let removed = 0;
  for (const wt of stale) {
    const short = shortBranch(wt.branch);
    if (isDirty(wt.path)) {
      console.error(
        `Skipping ${wt.path} (branch ${short}): uncommitted changes would be lost. ` +
          `Commit them or run: git worktree remove --force ${wt.path}`
      );
      continue;
    }
    if (!force) {
      if (!process.stdin.isTTY) {
        console.error(
          `Skipping ${wt.path} (branch ${short}): confirmation unavailable in ` +
            "non-interactive mode; re-run with --force."
        );
        continue;
      }
      process.stdout.write(
        `Remove worktree ${wt.path} (branch ${short} merged into ${base})? [y/N] `
      );
      const answer = fs.readFileSync(0, "utf8").trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log(`Skipped ${wt.path}.`);
        continue;
      }
    }
    run("git", ["worktree", "remove", wt.path]);
    removed++;
    console.log(`Removed worktree ${wt.path} (branch ${short}).`);
  }
  run("git", ["worktree", "prune"]);
  if (removed > 0) console.log(`\n${removed} worktree(s) removed; pruned.`);
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    switch (sub) {
      case "add": return cmdAdd(rest);
      case "open": return cmdOpen(rest);
      case "merge": return cmdMerge(rest);
      case "remove": return cmdRemove(rest);
      case "list": return cmdList();
      case "status": return cmdStatus();
      case "clean": return cmdClean(rest);
      default:
        console.error(USAGE);
        process.exit(sub ? 1 : 0);
    }
  } catch (err) {
    // git/code already printed details to stderr (inherited stdio); surface a
    // clean one-line failure via fail() instead of an uncaught stack trace.
    fail(err.message || String(err));
  }
}

main();
