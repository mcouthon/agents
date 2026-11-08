"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { HANG_GUARD_MS } = require("../hang-guard");

/**
 * The config an install from `repoRoot` would generate with: the user's local
 * config when one exists, else the repo's defaults — install.sh's own
 * resolution, copied exactly. The engine's env-overridable config path is a
 * different rule; unifying the two is a separate decision.
 */
function resolveInstallConfig(repoRoot) {
  const local = path.join(os.homedir(), ".agents", "config.json");
  if (fs.existsSync(local)) return local;
  return path.join(repoRoot, "defaults", "config.json");
}

/**
 * What a fresh install would write into the installed agents directory: the
 * engine's own templates rendered by the generator under the install's config.
 * The temp dir is agents-prefixed directly under the OS temp dir (the
 * trash.removeTempDir contract); the caller owns removing it.
 * @returns {{dir: string, config: string, error: string|null}}
 */
function expectedAgents(repoRoot) {
  const config = resolveInstallConfig(repoRoot);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  const r = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "generate.js"), "cc",
    "--config", config, "--source", path.join(repoRoot, "templates"),
    "--output-dir", dir,
  ], { encoding: "utf8", timeout: HANG_GUARD_MS, stdio: ["ignore", "pipe", "pipe"] });
  const error = r.status === 0 ? null
    : ((r.stderr || r.stdout || "").trim().split("\n")[0] || `generate.js exited ${r.status}`);
  return { dir, config, error };
}

/**
 * Drift rows between the installed agents directory and a fresh generation of
 * the same set — a plain file compare over the expected set. The model lines
 * come from the config, so they match by construction and nothing is stripped.
 * @param {string} installedAgentsDir
 * @param {string} expectedAgentsDir
 * @returns {{name: string, problem: "missing"|"differs"}[]}
 */
function agentDriftRows(installedAgentsDir, expectedAgentsDir) {
  const rows = [];
  if (!fs.existsSync(expectedAgentsDir)) return rows;
  for (const name of fs.readdirSync(expectedAgentsDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const installed = path.join(installedAgentsDir, name);
    if (!fs.existsSync(installed)) {
      rows.push({ name, problem: "missing" });
      continue;
    }
    if (fs.readFileSync(installed, "utf8") !== fs.readFileSync(path.join(expectedAgentsDir, name), "utf8")) {
      rows.push({ name, problem: "differs" });
    }
  }
  return rows;
}

module.exports = { resolveInstallConfig, expectedAgents, agentDriftRows };
