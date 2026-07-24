#!/usr/bin/env node
// AGENTS git-worktree helper -- create/open/merge/remove/list worktrees.
//
// One worktree per workstream = one branch = one isolated working tree/index/HEAD.
// The state server auto-resolves .tasks/ to the repo's MAIN checkout, so every
// worktree of a repo shares ONE tasks.json dashboard with no env setup needed.
//
// Usage:
//   npm run worktree -- add <branch> [path]     Create a branch + linked worktree
//   npm run worktree -- open <path>             Open a worktree in a new VS Code window
//   npm run worktree -- merge <branch> [--into <target>]  Merge a branch into target/main
//   npm run worktree -- remove <path>           Remove a worktree and prune
//   npm run worktree -- list                    List all worktrees

"use strict";

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
  "  npm run worktree -- open <path>\n" +
  "  npm run worktree -- merge <branch> [--into <target>]\n" +
  "  npm run worktree -- remove <path>\n" +
  "  npm run worktree -- list";

function cmdAdd(args) {
  const branch = args[0];
  if (!branch) fail(`add requires <branch>\n${USAGE}`);
  const repoRoot = capture("git", ["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(repoRoot);
  const slug = branch.replace(/\//g, "-");
  const wtPath = args[1]
    ? path.resolve(args[1])
    : path.resolve(repoRoot, "..", `${repoName}-${slug}`);
  run("git", ["worktree", "add", "-b", branch, wtPath]);
  console.log(`\nWorktree created at ${wtPath} on branch ${branch}.`);
  console.log(".tasks/ auto-resolves to this repo's main checkout -- no env setup needed.");
  console.log(`\nLaunch Claude Code:   cd ${wtPath} && claude`);
  if (onPath("code")) console.log(`Open in VS Code:      code ${wtPath}`);
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

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    switch (sub) {
      case "add": return cmdAdd(rest);
      case "open": return cmdOpen(rest);
      case "merge": return cmdMerge(rest);
      case "remove": return cmdRemove(rest);
      case "list": return cmdList();
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
