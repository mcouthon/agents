"use strict";

/**
 * Code-index lifecycle: staleness checking and build execution.
 * The build command is read ONLY from the trusted user-global config
 * (~/.agents/config.json or $AGENTS_CONFIG_PATH), never from the target repo,
 * so an untrusted repo cannot inject a command.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { gitRepoState, sameDirectory, assertBuildableRoot } = require("./project-dir");

const DEFAULT_CODE_EXTENSIONS = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".scala", ".sh",
];

let _codeIndexConfigCache;

function agentsConfigPath() {
  return process.env.AGENTS_CONFIG_PATH || path.join(os.homedir(), ".agents", "config.json");
}

function loadCodeIndexConfig() {
  if (_codeIndexConfigCache !== undefined) return _codeIndexConfigCache;
  let result = null;
  try {
    const raw = fs.readFileSync(agentsConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.code_index && typeof parsed.code_index === "object") {
      result = parsed.code_index;
    }
  } catch {
    result = null;
  }
  _codeIndexConfigCache = result;
  return result;
}

function codeIndexConfigured(config, { requireBuild = false } = {}) {
  if (!config) return false;
  if (typeof config.graph_file !== "string" || !config.graph_file) return false;
  if (requireBuild && (typeof config.build !== "string" || !config.build)) return false;
  return true;
}

function computeCodeIndexStatus(projectDir, config) {
  const graphFile = path.resolve(projectDir, config.graph_file);
  if (!fs.existsSync(graphFile)) {
    return { status: "missing", reason: `${config.graph_file} not found` };
  }
  const graphMtimeMs = fs.statSync(graphFile).mtimeMs;

  const extensions = Array.isArray(config.code_extensions) && config.code_extensions.length > 0
    ? config.code_extensions
    : DEFAULT_CODE_EXTENSIONS;

  let trackedFiles;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("git", ["-C", projectDir, "ls-files"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackedFiles = out.split("\n").filter(Boolean);
  } catch {
    return { status: "fresh", reason: "no git repository found; nothing to compare" };
  }

  const graphFileRel = path.relative(projectDir, graphFile);
  const graphDirRel = path.dirname(graphFileRel);

  for (const rel of trackedFiles) {
    if (rel === graphFileRel) continue;
    if (graphDirRel !== "." && (rel === graphDirRel || rel.startsWith(graphDirRel + "/"))) continue;
    if (!extensions.some((ext) => rel.endsWith(ext))) continue;

    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.resolve(projectDir, rel)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > graphMtimeMs) {
      return { status: "stale", reason: `${rel} newer than ${config.graph_file}` };
    }
  }
  return { status: "fresh", reason: `no tracked code file newer than ${config.graph_file}` };
}

function runCodeIndexBuild(projectDir, callProjectDir, force) {
  const config = loadCodeIndexConfig();
  if (!codeIndexConfigured(config, { requireBuild: true })) {
    return "not_configured: no code_index.build / code_index.graph_file in ~/.agents/config.json";
  }

  assertBuildableRoot(projectDir, callProjectDir);

  if (!force) {
    const { status, reason } = computeCodeIndexStatus(projectDir, config);
    if (status === "fresh") {
      return `skipped (fresh): ${reason}`;
    }
  }

  const timeoutMs = Number.isFinite(config.timeout_ms) && config.timeout_ms > 0
    ? config.timeout_ms
    : 180000;
  const start = Date.now();
  let output;
  try {
    output = execSync(config.build, {
      cwd: projectDir,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    const stderrTail = (typeof err.stderr === "string" ? err.stderr : (err.stderr || "").toString())
      .split("\n").filter(Boolean).slice(-10).join("\n");
    if (err.signal === "SIGTERM" || err.killed) {
      throw new Error(
        `code_index_build: build command timed out after ${elapsedS}s ` +
        `(limit ${(timeoutMs / 1000).toFixed(0)}s). build="${config.build}"`
      );
    }
    throw new Error(
      `code_index_build: build command exited with status ${err.status} after ${elapsedS}s. ` +
      `build="${config.build}"${stderrTail ? `\nstderr tail:\n${stderrTail}` : ""}`
    );
  }
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
  const tail = output.split("\n").filter(Boolean).slice(-10).join("\n");
  return `built (${elapsedS}s)${tail ? `:\n${tail}` : ""}`;
}

module.exports = {
  DEFAULT_CODE_EXTENSIONS,
  agentsConfigPath,
  loadCodeIndexConfig,
  codeIndexConfigured,
  computeCodeIndexStatus,
  runCodeIndexBuild,
};
