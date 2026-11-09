"use strict";

const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const _cache = new Map();
let _gitHintLogged = false;

/**
 * Compute a stable repo identity from a filesystem path.
 * @param {string} inputPath - Any path inside the repo (worktree, main checkout, subdir)
 * @returns {{main_root: string, origin_slug: string, base: string, key: string}}
 */
function repoKey(inputPath) {
  const resolved = path.resolve(inputPath);
  if (_cache.has(resolved)) return _cache.get(resolved);

  const mainRoot = deriveMainRoot(resolved);
  const originSlug = deriveOriginSlug(mainRoot);
  const base = deriveBase(mainRoot);
  const result = { main_root: mainRoot, origin_slug: originSlug, base, key: originSlug };

  _cache.set(resolved, result);
  if (mainRoot !== resolved) _cache.set(mainRoot, result);
  return result;
}

function deriveMainRoot(candidate) {
  try {
    const out = execFileSync(
      "git",
      ["-C", candidate, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }
    );
    const commonDir = out.trim().split("\n").pop().trim();
    if (commonDir && path.isAbsolute(commonDir) && path.basename(commonDir) === ".git") {
      return path.dirname(commonDir);
    }
  } catch (err) {
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    if (err.code === "ENOENT" || !/not a git repository/i.test(stderr)) {
      if (!_gitHintLogged) {
        _gitHintLogged = true;
        process.stderr.write(
          "AGENTS: git worktree main-root resolution unavailable " +
          "(old git or unexpected output) -- install git >= 2.31 for correct " +
          "repo identity. Continuing with this directory as-is.\n"
        );
      }
    }
  }
  return candidate;
}

function deriveOriginSlug(mainRoot) {
  try {
    const url = execFileSync("git", ["-C", mainRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    return urlToSlug(url);
  } catch (err) {
    // A killed probe answered nothing — it is not evidence the repo has no origin. The
    // recorded repos row is the identity of record; only with none does the path hash
    // key the repo (a local repo's own row carries that same hash).
    if (err && (err.killed || err.code === "ETIMEDOUT" || err.signal === "SIGTERM")) {
      const recorded = recordedSlugOf(mainRoot);
      if (recorded) return recorded;
    }
    const hash = crypto.createHash("sha1").update(mainRoot).digest("hex").slice(0, 12);
    return `path-${hash}`;
  }
}

/** The recorded repos row's key for `mainRoot`, or null when none matches or nothing is readable. */
function recordedSlugOf(mainRoot) {
  const fs = require("fs");
  let real;
  try { real = fs.realpathSync(mainRoot); } catch { return null; }
  try {
    for (const r of require("./db").listRepos()) {
      if (!r.main_root) continue;
      try { if (fs.realpathSync(r.main_root) === real) return r.key; } catch { /* a row whose root is gone */ }
    }
  } catch { /* no readable database: nothing recorded */ }
  return null;
}

function urlToSlug(url) {
  let s = url.replace(/^(https?|git|ssh):\/\//, "");
  s = s.replace(/^git@/, "");
  s = s.replace(/^([^:/]+):/, "$1/");
  s = s.replace(/\.git$/, "");
  s = s.replace(/\/$/, "");
  return s;
}

function deriveBase(mainRoot) {
  try {
    const out = execFileSync("git", ["-C", mainRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const branch = out.replace("refs/remotes/origin/", "");
    if (branch) return branch;
  } catch {}

  for (const candidate of ["main", "master"]) {
    try {
      execFileSync("git", ["-C", mainRoot, "rev-parse", "--verify", `refs/heads/${candidate}`], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return candidate;
    } catch {}
  }
  return "main";
}

module.exports = { repoKey, urlToSlug };
