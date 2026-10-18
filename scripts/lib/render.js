"use strict";

/**
 * Rendering: `state.md` from task.json, and `tasks.json` derived index.
 * state.md is written on every task.json write; tasks.json is rebuilt from
 * all task.json files on every write (never cached).
 */

const fs = require("fs");
const path = require("path");
const { readTaskJson, isMigrated, migrateTask } = require("./task");

/**
 * Render state.md from a task.json v2 object.
 * @param {string} taskDir - Absolute path to the task directory
 * @param {object} task - The task.json v2 object
 * @param {string} _projectDir - Project root (for relative path display)
 */
function renderStateMd(taskDir, task, _projectDir) {
  const lines = [];

  // Frontmatter
  lines.push("---");
  lines.push(`title: ${task.title || task.slug}`);
  lines.push(`slug: ${task.slug}`);
  lines.push(`number: ${task.number}`);
  lines.push(`status: ${task.status}`);
  lines.push(`mode: ${task.mode || "full"}`);
  if (task.created) lines.push(`created: ${task.created.slice(0, 10)}`);
  lines.push(`updated: ${task.updated || new Date().toISOString()}`);
  lines.push("---");
  lines.push("");

  // Phase table with a dedicated Status column (not folded into the Phase cell).
  lines.push("## Phases");
  lines.push("");
  lines.push("| # | Phase | Status | Notes |");
  lines.push("|---|---|---|---|");
  for (const p of task.phases || []) {
    const note = p.note || "";
    lines.push(`| ${p.id} | ${p.name} | ${p.status} | ${note} |`);
  }
  lines.push("");

  // Open checkpoints
  const openCps = (task.checkpoints || []).filter((cp) => cp.chosen === null);
  if (openCps.length > 0) {
    lines.push("## Open Checkpoints");
    lines.push("");
    for (const cp of openCps) {
      lines.push(`- **[${cp.type}] Phase ${cp.phase}:** ${cp.question}`);
      if (cp.options && cp.options.length > 0) {
        lines.push(`  Options: ${cp.options.join(", ")}`);
      }
    }
    lines.push("");
  }

  // Flags
  if ((task.flags || []).length > 0) {
    lines.push("## Flags");
    lines.push("");
    for (const f of task.flags) {
      lines.push(`- **[${f.type}] Phase ${f.phase}:** ${f.message}`);
    }
    lines.push("");
  }

  // Counters (per phase, non-zero only)
  const phasesWithCounters = (task.phases || []).filter(
    (p) => p.counters && Object.values(p.counters).some((v) => v)
  );
  if (phasesWithCounters.length > 0) {
    lines.push("## Counters");
    lines.push("");
    lines.push("| Phase | review_passes | fix_attempts | autofix | ci_attempts | clarify_rounds |");
    lines.push("|---|---|---|---|---|---|");
    for (const p of phasesWithCounters) {
      const c = p.counters;
      lines.push(
        `| ${p.id} | ${c.review_passes || 0} | ${c.fix_attempts || 0} | ${c.autofix_ran ? "yes" : "no"} | ${c.ci_attempts || 0} | ${c.clarify_rounds || 0} |`
      );
    }
    lines.push("");
  }

  // Warnings (D32: evidence guard failures under enforcement: warn)
  const phasesWithWarnings = (task.phases || []).filter(
    (p) => p.warnings && p.warnings.length > 0
  );
  if (phasesWithWarnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const p of phasesWithWarnings) {
      for (const w of p.warnings) {
        lines.push(`- **Phase ${p.id} [${w.guard}]:** ${w.reason} _(at ${w.at}, session ${w.session_id})_`);
      }
    }
    lines.push("");
  }

  // Lease/binding
  if (task.binding && task.binding.session_id) {
    lines.push("## Binding");
    lines.push("");
    lines.push(`- session: ${task.binding.session_id}`);
    if (task.binding.workflow_id) lines.push(`- workflow: ${task.binding.workflow_id}`);
    if (task.binding.terminal_id) lines.push(`- terminal: ${task.binding.terminal_id}`);
    lines.push("");
  }

  if (task.lease && task.lease.session_id) {
    lines.push("## Lease");
    lines.push("");
    lines.push(`- held by: ${task.lease.session_id}`);
    if (task.lease.acquired_at) lines.push(`- acquired: ${task.lease.acquired_at}`);
    if (task.lease.expires_at) lines.push(`- expires: ${task.lease.expires_at}`);
    lines.push("");
  }

  // Last activity
  if (task.last_writer && task.last_writer.session_id) {
    lines.push(`_Last written by ${task.last_writer.session_id} at ${task.last_writer.timestamp}_`);
  }

  const stateMdPath = path.join(taskDir, "state.md");
  fs.writeFileSync(stateMdPath, lines.join("\n") + "\n", "utf8");
}

/**
 * Rebuild tasks.json index from all task.json files under .tasks/.
 * Falls back to state.json for unmigrated tasks.
 * @param {string} projectDir - Project root containing .tasks/
 * @param {string} [sessionId] - Session ID for atomic temp file naming
 */
function rebuildTasksIndex(projectDir, sessionId) {
  const tasksDir = path.resolve(projectDir, ".tasks");
  if (!fs.existsSync(tasksDir)) return { updated: new Date().toISOString(), tasks: [] };

  const entries = [];
  for (const name of fs.readdirSync(tasksDir)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(tasksDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    let task = null;

    // D33: prefer task.json v2; migrate-on-touch for unmigrated v1 dirs.
    // Malformed v1 state.json dirs (missing phases/flags) are skipped by
    // migrateTask, so they never appear in the index.
    if (isMigrated(dir)) {
      task = readTaskJson(dir);
    } else if (fs.existsSync(path.join(dir, "state.json"))) {
      try {
        const r = migrateTask(dir, { dryRun: false });
        if (r.migrated || (r.skipped && r.reason === "already-migrated")) {
          task = readTaskJson(dir);
        }
      } catch {
        // skip unreadable
      }
    }

    if (!task) continue;

    const totalPhases = (task.phases || []).length;
    const completedPhases = (task.phases || []).filter((p) => p.status === "done").length;
    const currentPhaseObj = (task.phases || []).find((p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped");
    entries.push({
      slug: task.slug,
      dir: path.relative(projectDir, dir),
      task_dir_abs: dir,
      status: task.status,
      schema: task.schema,
      total_phases: totalPhases,
      completed_phases: completedPhases,
      current_phase: currentPhaseObj
        ? { id: currentPhaseObj.id, name: currentPhaseObj.name, status: currentPhaseObj.status, owner: currentPhaseObj.owner }
        : null,
      flags: (task.flags || []).length,
      updated: task.updated,
    });
  }

  const index = { updated: new Date().toISOString(), tasks: entries };
  const tmpPath = path.join(tasksDir, `.tasks.json.${sessionId || process.pid}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmpPath, path.join(tasksDir, "tasks.json"));
  return index;
}

module.exports = { renderStateMd, rebuildTasksIndex };
