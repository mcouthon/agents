#!/usr/bin/env node
"use strict";

// Tests for scripts/lib/commits.js: reading a phase's commits from git, on throwaway repos with a bare origin.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const commits = require("./lib/commits");

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("OK: " + msg); } else { failed++; console.error("FAIL: " + msg); }
}

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-commits-")));

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, "-c", "user.email=t@e", "-c", "user.name=t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout || "").trim();
}

function commitFile(repo, file, body) {
  fs.writeFileSync(path.join(repo, file), body);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", `add ${file}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A work clone and a second clone of one bare origin, both on main with the initial commit S pushed. */
function makeWorld(name) {
  const origin = path.join(ROOT, `${name}-origin.git`);
  const work = path.join(ROOT, `${name}-work`);
  const other = path.join(ROOT, `${name}-other`);
  git(ROOT, ["init", "--bare", "-b", "main", origin]);
  git(ROOT, ["clone", origin, work]);
  git(work, ["checkout", "-B", "main"]);
  const start = commitFile(work, "s.txt", "s\n");
  git(work, ["push", "-u", "origin", "main"]);
  git(ROOT, ["clone", origin, other]);
  return { origin, work, other, start };
}

// GC1: local commits since start are returned, commits that arrived from origin are not.
{
  const w = makeWorld("gc1");
  const a = commitFile(w.work, "a.txt", "a\n");
  const b = commitFile(w.work, "b.txt", "b\n");
  commitFile(w.other, "x.txt", "x\n");
  git(w.other, ["push", "origin", "main"]);
  const got = commits.sinceStart({ repo: w.work, startSha: w.start, tip: "refs/heads/main", base: "main" });
  check(JSON.stringify(got) === JSON.stringify([a, b]), "GC1: sinceStart returns the two local commits in order, not origin's X");
}

// GC2: commits already pushed leave nothing since start, and are on base.
{
  const w = makeWorld("gc2");
  const a = commitFile(w.work, "a.txt", "a\n");
  const b = commitFile(w.work, "b.txt", "b\n");
  git(w.work, ["push", "origin", "main"]);
  const got = commits.sinceStart({ repo: w.work, startSha: w.start, tip: "refs/heads/main", base: "main" });
  check(got.length === 0, "GC2: sinceStart is empty once the commits are on origin");
  check(commits.onBase(w.work, "main", [a, b]) === true, "GC2: onBase is true for pushed commits");
  check(commits.onBase(w.work, "main", []) === true, "GC2: onBase of nothing is true");
}

// GC3: recorded commits rebased onto new origin commits are matched by patch.
{
  const w = makeWorld("gc3");
  git(w.work, ["checkout", "-b", "feat"]);
  const a = commitFile(w.work, "a.txt", "a\n");
  const b = commitFile(w.work, "b.txt", "b\n");
  commitFile(w.other, "x.txt", "x\n");
  git(w.other, ["pull", "--rebase", "origin", "main"]);
  git(w.other, ["fetch", w.work, "feat"]);
  git(w.other, ["cherry-pick", a, b]);
  git(w.other, ["push", "origin", "main"]);
  const a2 = git(w.other, ["rev-parse", "HEAD~1"]);
  const b2 = git(w.other, ["rev-parse", "HEAD"]);
  git(w.work, ["fetch", "origin"]);
  check(commits.onBase(w.work, "main", [a, b]) === false, "GC3: onBase is false for commits only on a branch");
  const got = commits.reresolve({ repo: w.work, base: "main", shas: [a, b] });
  check(got.ok === true && JSON.stringify(got.shas) === JSON.stringify([a2, b2]), "GC3: reresolve maps rebased commits to their origin counterparts");

  const lone = commitFile(w.work, "c.txt", "c\n");
  const miss = commits.reresolve({ repo: w.work, base: "main", shas: [a, lone] });
  check(miss.ok === false && JSON.stringify(miss.missing) === JSON.stringify([lone]), "GC3: a commit with no patch match is named");

  const kept = commits.reresolve({ repo: w.work, base: "main", shas: [a2] });
  check(kept.ok === true && JSON.stringify(kept.shas) === JSON.stringify([a2]), "GC3: a commit already on base is kept as is");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
