"use strict";

/**
 * Agent memory lifecycle: seed MEMORY.md files from the AGENTS repo's
 * templates to the project's .claude/agent-memory/ directory, and check
 * whether memory is seeded. Create-if-not-exists — preserves curated memory.
 */

const fs = require("fs");
const path = require("path");

function seedSrcDir() {
  return path.resolve(__dirname, "..", "..", "templates", "agents", "memory");
}

function discoverSeedAgents() {
  const srcDir = seedSrcDir();
  if (!fs.existsSync(srcDir)) return [];
  return fs.readdirSync(srcDir)
    .filter(name => fs.existsSync(path.join(srcDir, name, "MEMORY.md")))
    .sort();
}

function runMemorySeed(projectDir) {
  const srcDir = seedSrcDir();
  const destDir = path.resolve(projectDir, ".claude", "agent-memory");

  if (!fs.existsSync(srcDir)) {
    return `No seed files found at ${srcDir}. Ensure the AGENTS repo is installed correctly.`;
  }

  const agents = discoverSeedAgents();
  if (agents.length === 0) {
    return `No MEMORY.md seed files found in ${srcDir}.`;
  }

  const seeded = [];
  const existing = [];

  for (const agent of agents) {
    const srcFile = path.join(srcDir, agent, "MEMORY.md");
    const destFile = path.join(destDir, agent, "MEMORY.md");

    if (fs.existsSync(destFile)) {
      existing.push(agent);
    } else {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(srcFile, destFile);
      seeded.push(agent);
    }
  }

  const lines = [];
  if (seeded.length > 0) {
    lines.push(`Seeded: ${seeded.join(", ")}`);
  }
  if (existing.length > 0) {
    lines.push(`Already existed (preserved): ${existing.join(", ")}`);
  }
  if (seeded.length === 0 && existing.length === 0) {
    lines.push("No memory files seeded or found.");
  }
  lines.push(`Total: ${agents.length} agent(s) checked.`);

  return lines.join("\n");
}

function runMemoryStatus(projectDir) {
  const destDir = path.resolve(projectDir, ".claude", "agent-memory");
  const expectedAgents = discoverSeedAgents();

  if (expectedAgents.length === 0) {
    return "not_configured: no seed files found in the AGENTS repo.";
  }

  const statuses = {};
  for (const agent of expectedAgents) {
    const destFile = path.join(destDir, agent, "MEMORY.md");
    statuses[agent] = fs.existsSync(destFile) ? "seeded" : "not_seeded";
  }

  const seededCount = Object.values(statuses).filter(s => s === "seeded").length;
  const overall = seededCount === expectedAgents.length
    ? "all_seeded"
    : seededCount === 0
      ? "not_seeded"
      : "partial";

  const lines = [overall];
  for (const agent of expectedAgents) {
    lines.push(`  ${agent}: ${statuses[agent]}`);
  }

  return lines.join("\n");
}

module.exports = {
  runMemorySeed,
  runMemoryStatus,
  discoverSeedAgents,
};
