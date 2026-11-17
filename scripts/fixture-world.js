"use strict";

// The suites' shared acme template world: one commit per distinct repo shape,
// built once inside the calling suite's temp root, that every fixture clones
// instead of re-initializing the same repository. A local clone shares the
// object store (hardlinked) and gives each fixture its own working tree,
// refs and remotes inside the fixture's own root — the per-fixture isolation
// is unchanged; only the build cost is shared. The hang-guard precedent: a
// module in scripts/ shared by test files, required like any lib, never a
// suite itself (check.sh globs scripts/test-*.js as suites — do not rename
// this file with a test- prefix).

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

// key → the template repo's dir; built lazily on first use per key.
const templates = new Map();

function defaultSeed(dir, key) {
  fs.writeFileSync(path.join(dir, "README.md"), `# ${key}\n`);
}

/**
 * The template repo for `key`, built once per process under `<suiteTmp>/
 * fixture-template/<key>/`: one commit on main whose files `seed(dir, key)`
 * writes. Every later clone of the same key shares this commit.
 */
function template(suiteTmp, key, seed = defaultSeed) {
  let dir = templates.get(key);
  if (dir) return dir;
  dir = path.join(suiteTmp, "fixture-template", key);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  seed(dir, key);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  templates.set(key, dir);
  return dir;
}

/**
 * A plain repo at caller-created `dir`, cloned from the `key` template, with
 * `origin` repointed at `remoteUrl` — the makeRepo shape (roster,
 * engine-wait): refs/remotes/origin/main arrives set by the clone, the same
 * refs the explicit update-ref used to plant.
 */
function cloneRepo(suiteTmp, key, dir, remoteUrl, seed) {
  const tmpl = template(suiteTmp, key, seed);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(path.dirname(dir), "clone", "-q", tmpl, dir);
  git(dir, "remote", "set-url", "origin", remoteUrl);
  return dir;
}

/**
 * The start-family fixture pair: a bare `origin` plus its clone `repo` —
 * the same refs/remotes shape fixture() always built (remote origin at the
 * bare path, main checked out, origin/HEAD on main), minus the per-fixture
 * init/add/commit/push.
 */
function clonePair(suiteTmp, key, origin, repo, seed) {
  const tmpl = template(suiteTmp, key, seed);
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(path.dirname(origin), "clone", "-q", "--bare", tmpl, origin);
  git(path.dirname(repo), "clone", "-q", origin, repo);
  git(repo, "remote", "set-head", "origin", "main");
  return { origin, repo };
}

module.exports = { cloneRepo, clonePair };
