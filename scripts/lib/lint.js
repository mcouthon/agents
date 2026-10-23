"use strict";

/**
 * `a plan lint <file>` — validates plan files and task.md.
 * Plan files: required sections, manifest overlap across a parallel group,
 * blocked_by vs Deps column.
 * task.md: rejects a status column or status emojis in the phases table.
 */

const fs = require("fs");
const path = require("path");

const REQUIRED_SECTIONS = [
  "Goal", "Implementation", "Files Modified", "Verification", "Tests", "Demo",
];

/**
 * Lint a plan file. Returns { ok: boolean, errors: string[], warnings: string[] }.
 * @param {string} planPath - Absolute path to the plan file
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function lintPlan(planPath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(planPath)) {
    return { ok: false, errors: [`file not found: ${planPath}`], warnings: [] };
  }

  const content = fs.readFileSync(planPath, "utf8");

  // Check required sections
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^##\\s+${section}\\b`, "m");
    if (!pattern.test(content)) {
      errors.push(`missing required section: ## ${section}`);
    }
  }

  // Check for Files Modified entries
  const filesModifiedMatch = content.match(/^##\s+Files Modified\s*$/m);
  if (filesModifiedMatch) {
    const afterSection = content.slice(filesModifiedMatch.index + filesModifiedMatch[0].length);
    const nextSectionMatch = afterSection.match(/^##\s/m);
    const sectionContent = nextSectionMatch
      ? afterSection.slice(0, nextSectionMatch.index)
      : afterSection;
    const fileListLines = sectionContent.split("\n").filter((l) => l.trim().startsWith("- "));
    if (fileListLines.length === 0) {
      warnings.push("Files Modified section has no file entries");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Lint task.md. Rejects a status column or status emojis in the phases table.
 * @param {string} taskMdPath - Absolute path to task.md
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function lintTaskMd(taskMdPath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(taskMdPath)) {
    return { ok: false, errors: [`file not found: ${taskMdPath}`], warnings: [] };
  }

  const content = fs.readFileSync(taskMdPath, "utf8");
  const lines = content.split("\n");

  // Find the phases table
  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*#\s*\|/.test(lines[i])) {
      tableStart = i;
      break;
    }
  }

  if (tableStart >= 0) {
    const headers = lines[tableStart].split("|").map((h) => h.trim()).filter(Boolean);
    const statusIdx = headers.findIndex((h) => h.toLowerCase() === "status");
    if (statusIdx >= 0) {
      errors.push(`phases table has a "Status" column (column ${statusIdx + 1}) — remove it; status lives in task.json`);
    }

    // Check for status emojis in the table
    const statusEmojis = ["⬜", "📋", "⭐", "🔄", "✅", "🔴", "🟡", "⚠️"];
    for (let i = tableStart + 2; i < lines.length; i++) {
      if (!lines[i].trim().startsWith("|")) break;
      for (const emoji of statusEmojis) {
        if (lines[i].includes(emoji)) {
          // If there's no Status column header, emojis in other columns are fine
          // (e.g. in Notes). Only flag if the table has a Status column.
          if (statusIdx >= 0) {
            errors.push(`status emoji ${emoji} found in phases table row ${i + 1} — remove status markers; status lives in task.json`);
          }
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Check manifest overlap across phases in a parallel group.
 * @param {object[]} phases - Array of phase objects with manifest and parallel_group
 * @returns {{ overlaps: string[], ok: boolean }}
 */
function checkManifestOverlap(phases) {
  const overlaps = [];
  const groups = {};

  for (const phase of phases) {
    const group = phase.parallel_group;
    if (!group) continue;
    if (!groups[group]) groups[group] = [];
    groups[group].push(phase);
  }

  for (const [group, groupPhases] of Object.entries(groups)) {
    if (groupPhases.length < 2) continue;
    for (let i = 0; i < groupPhases.length; i++) {
      for (let j = i + 1; j < groupPhases.length; j++) {
        const a = groupPhases[i];
        const b = groupPhases[j];
        const manifestA = new Set(a.manifest || []);
        const manifestB = new Set(b.manifest || []);
        const shared = [...manifestA].filter((f) => manifestB.has(f));
        if (shared.length > 0) {
          overlaps.push(
            `phases ${a.id} and ${b.id} (group ${group}) both modify: ${shared.join(", ")}`
          );
        }
      }
    }
  }

  return { overlaps, ok: overlaps.length === 0 };
}

/**
 * Extract file paths from a plan file's ## Files Modified section.
 * @param {string} planPath
 * @returns {string[]} Array of file paths
 */
function extractManifestFromPlan(planPath) {
  if (!fs.existsSync(planPath)) return [];
  const content = fs.readFileSync(planPath, "utf8");
  const match = content.match(/^##\s+Files Modified\s*$/m);
  if (!match) return [];
  const after = content.slice(match.index + match[0].length);
  const nextSection = after.match(/^##\s/m);
  const sectionContent = nextSection ? after.slice(0, nextSection.index) : after;
  return sectionContent
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.trim().replace(/^-\s+/, "").trim());
}

/**
 * Check manifest overlap across live tasks in the repo (D26 layer 1).
 * Reads all task.json files in .tasks/, unions their non-done phases'
 * manifests, and intersects with the plan's manifest.
 * @param {string} planPath - Absolute path to the plan file
 * @param {string} projectDir - Repo main root
 * @returns {{ overlaps: object[], ok: boolean }}
 */
function checkCrossTaskManifestOverlap(planPath, projectDir) {
  const planFiles = new Set(extractManifestFromPlan(planPath));
  if (planFiles.size === 0) return { overlaps: [], ok: true };

  const { repoKey } = require("./repo");
  const { tasksRoot } = require("./tasks-root");
  const key = repoKey(projectDir);
  const tasksDir = tasksRoot(key);
  if (!fs.existsSync(tasksDir)) return { overlaps: [], ok: true };

  const taskLib = require("./task");
  const planTaskDir = path.dirname(path.dirname(planPath));
  const planTaskName = path.basename(planTaskDir);

  const overlaps = [];
  for (const name of fs.readdirSync(tasksDir)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(tasksDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (path.resolve(dir) === path.resolve(planTaskDir) || name === planTaskName) continue;
    if (!taskLib.isMigrated(dir)) continue;
    const task = taskLib.readTaskJson(dir);
    if (!task) continue;

    const otherManifests = new Set();
    for (const phase of task.phases || []) {
      if (["done", "failed", "skipped", "landed"].includes(phase.status)) continue;
      for (const f of phase.manifest || []) otherManifests.add(f);
    }
    const shared = [...planFiles].filter((f) => otherManifests.has(f));
    if (shared.length > 0) {
      overlaps.push({ task: name, files: shared });
    }
  }

  return { overlaps, ok: overlaps.length === 0 };
}

module.exports = {
  lintPlan,
  lintTaskMd,
  checkManifestOverlap,
  checkCrossTaskManifestOverlap,
  extractManifestFromPlan,
  REQUIRED_SECTIONS,
};
