#!/usr/bin/env node
// Code-index refresh helper for the workspace-init SessionStart hook.
//
// Called by hooks/workspace-init.sh with the project directory as argv[1].
// Reads the build command from the user-global config (~/.agents/config.json
// or $AGENTS_CONFIG_PATH), checks staleness (graph_file mtime vs tracked code
// files), and runs the build only when stale or missing.
//
// Mirrors the staleness-guarded logic of the state-manager MCP's
// code_index_build tool (scripts/state-server.js). The build command is read
// ONLY from the trusted user-global config — never from the target repo —
// so an untrusted repo cannot inject a command.
//
// Output goes to stderr (informational). Exit 0 always — a SessionStart hook
// must never block the session, and a build failure is non-fatal.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

// Pragmatic default set of "code" file extensions used for the staleness
// check when the user config omits code_extensions.
const DEFAULT_CODE_EXTENSIONS = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".scala", ".sh",
];

/**
 * Resolve the user-global AGENTS config path.
 * @returns {string}
 */
function agentsConfigPath() {
  return process.env.AGENTS_CONFIG_PATH || path.join(os.homedir(), ".agents", "config.json");
}

/**
 * Load the code_index section of the user-global config.
 * @returns {object|null}
 */
function loadCodeIndexConfig() {
  try {
    const raw = fs.readFileSync(agentsConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.code_index && typeof parsed.code_index === "object") {
      return parsed.code_index;
    }
  } catch {
    // missing file / unreadable / malformed JSON — clean no-op
  }
  return null;
}

/**
 * Compute code-index staleness for a project directory.
 * @param {string} projectDir
 * @param {object} config
 * @returns {{status: string, reason: string}}
 */
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

/**
 * Main: check config, check staleness, run build if needed.
 */
function main() {
  const projectDir = process.argv[2] || process.cwd();
  const config = loadCodeIndexConfig();

  if (!config || typeof config.graph_file !== "string" || !config.graph_file ||
      typeof config.build !== "string" || !config.build) {
    // Not configured — clean no-op
    process.stderr.write("[workspace-init] code_index not configured — skipping\n");
    return;
  }

  const { status, reason } = computeCodeIndexStatus(projectDir, config);
  if (status === "fresh") {
    process.stderr.write(`[workspace-init] code_index fresh — skipping (${reason})\n`);
    return;
  }

  const timeoutMs = Number.isFinite(config.timeout_ms) && config.timeout_ms > 0
    ? config.timeout_ms
    : 180000;
  const start = Date.now();

  try {
    // execSync (not execFileSync) is intentional: `build` is a free-form,
    // user-authored string that needs shell interpretation for &&/quoting.
    // Safe because `build` comes only from the trusted user-global config.
    execSync(config.build, {
      cwd: projectDir,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`[workspace-init] code_index built (${elapsedS}s)\n`);
  } catch (err) {
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    if (err.signal === "SIGTERM" || err.killed) {
      process.stderr.write(
        `[workspace-init] code_index build timed out after ${elapsedS}s ` +
        `(limit ${(timeoutMs / 1000).toFixed(0)}s)\n`
      );
    } else {
      process.stderr.write(
        `[workspace-init] code_index build failed after ${elapsedS}s ` +
        `(exit ${err.status})\n`
      );
    }
    // Non-fatal — don't block the session
  }
}

main();
