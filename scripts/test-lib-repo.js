#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { repoKey, urlToSlug } = require("./lib/repo");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-repo-test-")));

function makeRepo(name) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// Test 1: repoKey on main checkout returns its own path as main_root
{
  const repo = makeRepo("main-checkout");
  const key = repoKey(repo);
  if (key.main_root === repo) ok("main checkout: main_root is the repo path");
  else fail_(`main_root should be ${repo}, got ${key.main_root}`);
  if (key.base === "main") ok("main checkout: base is 'main'");
  else fail_(`base should be 'main', got ${key.base}`);
}

// Test 2: repoKey on worktree rolls up to main root
{
  const repo = makeRepo("wt-main");
  const wtPath = path.join(tmpBase, "wt-linked");
  execFileSync("git", ["worktree", "add", "-q", wtPath], { cwd: repo });
  const key = repoKey(wtPath);
  if (key.main_root === repo) ok("worktree: main_root rolls up to main checkout");
  else fail_(`worktree main_root should be ${repo}, got ${key.main_root}`);
}

// Test 3: repoKey no-remote fallback uses path-hash
{
  const repo = makeRepo("no-remote");
  const key = repoKey(repo);
  if (key.origin_slug.startsWith("path-")) ok("no-remote: origin_slug starts with 'path-'");
  else fail_(`no-remote origin_slug should start with 'path-', got ${key.origin_slug}`);
  if (key.key === key.origin_slug) ok("key equals origin_slug");
  else fail_("key should equal origin_slug");
}

// Test 4: repoKey with remote uses URL slug
{
  const repo = makeRepo("with-remote");
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });
  const key = repoKey(path.join(repo));
  if (key.origin_slug === "github.com/owner/repo") ok("with-remote: origin_slug is URL slug");
  else fail_(`origin_slug should be 'github.com/owner/repo', got ${key.origin_slug}`);
}

// Test 5: repoKey on subdir resolves to repo root
{
  const repo = makeRepo("subdir-test");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const key = repoKey(path.join(repo, "src"));
  if (key.main_root === repo) ok("subdir: main_root resolves to repo root");
  else fail_(`subdir main_root should be ${repo}, got ${key.main_root}`);
}

// Test 6: urlToSlug handles all formats
{
  const cases = [
    ["ssh://git@github.com/owner/name.git", "github.com/owner/name"],
    ["git@github.com:owner/name.git", "github.com/owner/name"],
    ["https://github.com/owner/name.git", "github.com/owner/name"],
    ["git://github.com/owner/name.git", "github.com/owner/name"],
  ];
  let allOk = true;
  for (const [input, expected] of cases) {
    if (urlToSlug(input) !== expected) {
      fail_(`urlToSlug(${input}) should be ${expected}, got ${urlToSlug(input)}`);
      allOk = false;
    }
  }
  if (allOk) ok("urlToSlug normalizes all URL formats");
}

// Test 7: repoKey is cached (same path returns same object)
{
  const repo = makeRepo("cache-test");
  const k1 = repoKey(repo);
  const k2 = repoKey(repo);
  if (k1 === k2) ok("repoKey returns cached object for same path");
  else fail_("repoKey should return cached object");
}

// Test 8: detached HEAD still resolves main_root
{
  const repo = makeRepo("detached-test");
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: repo });
  const key = repoKey(repo);
  if (key.main_root === repo) ok("detached HEAD: main_root still resolves");
  else fail_(`detached HEAD main_root should be ${repo}, got ${key.main_root}`);
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
