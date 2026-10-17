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
          "AGENTS: git worktree .tasks/ rollup unavailable " +
          "(old git or unexpected output) -- install git >= 2.31 for shared " +
          ".tasks/ across worktrees. Continuing with this directory as-is.\n"
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
  } catch {
    const hash = crypto.createHash("sha1").update(mainRoot).digest("hex").slice(0, 12);
    return `path-${hash}`;
  }
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
