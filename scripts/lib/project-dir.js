"use strict";

/**
 * Project-directory resolution and path safety for the MCP server.
 * Resolves project_dir from the call arg, CLAUDE_PROJECT_DIR, or cwd,
 * rolls linked worktrees up to the main checkout, and guards against
 * path traversal.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { repoKey } = require("./repo");

const _mainRootCache = new Map();
let _oldGitHintLogged = false;
const _repoStateCache = new Map();

function _warnOldGitOnce() {
  if (_oldGitHintLogged) return;
  _oldGitHintLogged = true;
  console.error(
    "AGENTS state-server: git worktree .tasks/ rollup unavailable " +
    "(old git or unexpected git output) -- install git >= 2.31 for shared " +
    ".tasks/ across worktrees. Continuing with this directory as-is."
  );
}

function deriveMainWorktreeRoot(candidate) {
  const resolved = path.resolve(candidate);
  if (_mainRootCache.has(resolved)) return _mainRootCache.get(resolved);
  let result = resolved;
  let repoState = "unknown";
  try {
    const out = execFileSync(
      "git",
      ["-C", resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }
    );
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const commonDir = lines[lines.length - 1];
    if (commonDir && path.isAbsolute(commonDir) && path.basename(commonDir) === ".git") {
      result = path.dirname(commonDir);
      repoState = "in";
    } else {
      _warnOldGitOnce();
      repoState = "unknown";
    }
  } catch (err) {
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    if (err.code === "ENOENT" || !/not a git repository/i.test(stderr)) {
      _warnOldGitOnce();
      repoState = "unknown";
    } else {
      repoState = "out";
    }
  }
  _mainRootCache.set(resolved, result);
  _repoStateCache.set(resolved, repoState);
  if (result !== resolved) _repoStateCache.set(result, repoState);
  return result;
}

function gitRepoState(candidate) {
  const resolved = path.resolve(candidate);
  if (!_repoStateCache.has(resolved)) deriveMainWorktreeRoot(resolved);
  return _repoStateCache.get(resolved) || "unknown";
}

function resolveProjectDir(callProjectDir) {
  if (callProjectDir) return repoKey(callProjectDir).main_root;
  if (process.env.CLAUDE_PROJECT_DIR) return repoKey(process.env.CLAUDE_PROJECT_DIR).main_root;
  console.error(
    "AGENTS state-server: CLAUDE_PROJECT_DIR not set and project_dir not provided, " +
    "using cwd -- state.json paths may be incorrect for user-scoped servers."
  );
  return repoKey(process.cwd()).main_root;
}

function implausibleProjectDirWarning(callProjectDir) {
  if (!callProjectDir) return null;
  if (!process.env.CLAUDE_PROJECT_DIR) return null;
  const argResolved = deriveMainWorktreeRoot(callProjectDir);
  if (gitRepoState(argResolved) !== "out") return null;
  const envResolved = deriveMainWorktreeRoot(process.env.CLAUDE_PROJECT_DIR);
  if (gitRepoState(envResolved) !== "in") return null;
  return (
    `warning: project_dir "${argResolved}" is not inside a git repository, but ` +
    `CLAUDE_PROJECT_DIR ("${envResolved}") is. The result below is for the path you passed, ` +
    "not for CLAUDE_PROJECT_DIR. If that was not intended, omit project_dir and call again -- " +
    "do not guess a workspace root."
  );
}

function resolveProjectDirChecked(callProjectDir) {
  return {
    projectDir: resolveProjectDir(callProjectDir),
    warning: implausibleProjectDirWarning(callProjectDir),
  };
}

function assertWithinProject(resolved, taskDir, projectDir) {
  const safeRoot = path.resolve(projectDir);
  if (!resolved.startsWith(safeRoot + path.sep) && resolved !== safeRoot) {
    throw new Error(`task_dir "${taskDir}" resolves outside project directory`);
  }
}

function resolveStatePath(taskDir, projectDir) {
  const resolved = path.resolve(projectDir, taskDir, "state.json");
  assertWithinProject(resolved, taskDir, projectDir);
  return resolved;
}

function resolveTmpPath(taskDir, projectDir) {
  const resolved = path.resolve(projectDir, taskDir, ".state.json.tmp");
  assertWithinProject(resolved, taskDir, projectDir);
  return resolved;
}

function sameDirectory(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function assertBuildableRoot(projectDir, callProjectDir) {
  const source = callProjectDir
    ? "project_dir argument"
    : process.env.CLAUDE_PROJECT_DIR
      ? "CLAUDE_PROJECT_DIR"
      : "process.cwd()";
  const remedy = process.env.CLAUDE_PROJECT_DIR
    ? `CLAUDE_PROJECT_DIR is "${process.env.CLAUDE_PROJECT_DIR}" -- omit project_dir to target it.`
    : "Pass project_dir set to the repository root, or set CLAUDE_PROJECT_DIR.";

  const refuse = (reason) => {
    throw new Error(
      `code_index_build: refusing to run the build command in ${projectDir} (${reason}). ` +
      `Source: ${source}. ${remedy}`
    );
  };

  if (sameDirectory(projectDir, os.homedir())) {
    refuse("it is the home directory");
  }
  if (sameDirectory(projectDir, path.parse(projectDir).root)) {
    refuse("it is a filesystem root");
  }
  if (gitRepoState(projectDir) === "out") {
    refuse("it is not inside a git repository");
  }
}

module.exports = {
  deriveMainWorktreeRoot,
  gitRepoState,
  resolveProjectDir,
  resolveProjectDirChecked,
  implausibleProjectDirWarning,
  assertWithinProject,
  resolveStatePath,
  resolveTmpPath,
  sameDirectory,
  assertBuildableRoot,
};
