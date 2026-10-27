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
 * The text of state.md for a task.json v2 object (pure).
 * @param {object} task - The task.json v2 object
 * @returns {string}
 */
function renderStateMdText(task) {
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

  // Binding
  if (task.binding && task.binding.session_id) {
    lines.push("## Binding");
    lines.push("");
    lines.push(`- session: ${task.binding.session_id}`);
    if (task.binding.workflow_id) lines.push(`- workflow: ${task.binding.workflow_id}`);
    if (task.binding.terminal_id) lines.push(`- terminal: ${task.binding.terminal_id}`);
    lines.push("");
  }

  // Last activity
  if (task.last_writer && task.last_writer.session_id) {
    lines.push(`_Last written by ${task.last_writer.session_id} at ${task.last_writer.timestamp}_`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Render state.md from a task.json v2 object.
 * @param {string} taskDir - Absolute path to the task directory
 * @param {object} task - The task.json v2 object
 * @param {string} _projectDir - Project root (for relative path display)
 */
function renderStateMd(taskDir, task, _projectDir) {
  fs.writeFileSync(path.join(taskDir, "state.md"), renderStateMdText(task), "utf8");
}

/**
 * Rebuild tasks.json index from all task.json files under .tasks/.
 * Falls back to state.json for unmigrated tasks.
 * @param {string} projectDir - Project root containing .tasks/
 * @param {string} [sessionId] - Session ID for atomic temp file naming
 */
function rebuildTasksIndex(projectDir, sessionId) {
  const { repoKey } = require("./repo");
  const { tasksRoot } = require("./tasks-root");
  const key = repoKey(projectDir);
  const tasksDir = tasksRoot(key);
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
      dir: path.basename(dir),
      task_dir_abs: dir,
      status: task.status,
      schema: task.schema,
      tier: task.tier || "standard",
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

  // D20/D36: render INDEX.md at the central root on every index rebuild
  try { renderIndexMd(); } catch {}

  return index;
}

/**
 * The text of INDEX.md for already-collected rows `[{ key, task, liveSessions }]`
 * (pure). Ties on liveness and `updated` keep the order of `rows`, so callers
 * pass repos in index order and dirs in sorted order.
 */
function renderIndexMdText(rows) {
  const { computeNext } = require("./next");
  const taskLib = require("./task");
  const allTasks = rows.slice();
  // Sort: live session first, then last write (most recent first)
  allTasks.sort((a, b) => {
    const aLive = a.liveSessions.length > 0;
    const bLive = b.liveSessions.length > 0;
    if (aLive !== bLive) return aLive ? -1 : 1;
    return new Date(b.task.updated || 0).getTime() - new Date(a.task.updated || 0).getTime();
  });

  const lines = ["# AGENTS Tasks Index", ""];
  const active = allTasks.filter((t) => !taskLib.isTaskDone(t.task));
  const done = allTasks.filter((t) => taskLib.isTaskDone(t.task));

  if (active.length > 0) {
    lines.push("| Repo | Task | Tier | Status | Next | Live | Updated |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const { key, task, liveSessions } of active) {
      const tier = task.tier || "standard";
      const live = liveSessions.length > 0 ? "yes" : "";
      const updated = (task.updated || "").slice(0, 10);
      let nextStep = "";
      try {
        const r = computeNext(task, {});
        nextStep = r.step;
      } catch { nextStep = "?"; }
      const slug = task.slug || path.basename(task.dir || "");
      lines.push(`| ${key} | ${slug} | ${tier} | ${task.status} | ${nextStep} | ${live} | ${updated} |`);
    }
    lines.push("");
  }

  if (done.length > 0) {
    lines.push("<details><summary>Done tasks (" + done.length + ")</summary>");
    lines.push("");
    lines.push("| Repo | Task | Tier | Disposition | Updated |");
    lines.push("|---|---|---|---|---|");
    for (const { key, task } of done) {
      const tier = task.tier || "standard";
      const disp = taskLib.taskDisposition(task);
      const updated = (task.updated || "").slice(0, 10);
      const slug = task.slug || "";
      lines.push(`| ${key} | ${slug} | ${tier} | ${disp.action} | ${updated} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render INDEX.md at the central tasks root — a cross-repo skim view (D20/D36).
 * Table columns: repo, task, tier, disposition, status, next step, attention,
 * live session, last activity, main/worktree. Ordered by activity (live session
 * first, then last write). Done tasks collapsed under a <details> block.
 * Written atomically (tmp + rename) under the root lock.
 */
function renderIndexMd() {
  const { tasksRootBase, rootIndexMdPath, readRootIndex, withRootLock } = require("./tasks-root");
  const sessionLib = require("./session");
  const taskLib = require("./task");

  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  return withRootLock(holder, () => {
    const base = tasksRootBase();
    if (!fs.existsSync(base)) return { rendered: false };

    // Collect all tasks across all repos
    const rootIndex = readRootIndex();
    const allTasks = [];
    for (const [key, entry] of Object.entries(rootIndex)) {
      const repoDir = path.join(base, key);
      if (!fs.existsSync(repoDir)) continue;
      for (const name of fs.readdirSync(repoDir).sort()) {
        if (name.startsWith(".") || name === "archive") continue;
        const dir = path.join(repoDir, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (!taskLib.isMigrated(dir)) continue;
        const task = taskLib.readTaskJson(dir);
        if (!task) continue;
        const liveSessions = sessionLib.findLiveByRepoKey ? (sessionLib.findLiveByRepoKey(key) || []) : [];
        allTasks.push({ key, task, dir, liveSessions });
      }
    }

    const md = renderIndexMdText(allTasks);
    const mdPath = rootIndexMdPath();
    const tmp = mdPath + ".tmp";
    fs.writeFileSync(tmp, md, "utf8");
    fs.renameSync(tmp, mdPath);
    return { rendered: true, count: allTasks.length };
  });
}

// ---------------------------------------------------------------------------
// The phase table inside task.md
// ---------------------------------------------------------------------------

const PHASES_START = "<!-- phases:start -->";
const PHASES_END = "<!-- phases:end -->";
const TEMPLATE_TABLE = ["| # | Phase | Notes |", "|---|---|---|"];

const cell = (value) => {
  const text = value === undefined || value === null ? "" : String(value);
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
};

/** The marker block listing the task's phases (pure). */
function phasesTable(task) {
  const lines = [
    PHASES_START,
    "_Rendered from the agents database on every write; edit outside these markers._",
    "",
    "| # | Phase | Status | Blocked by | Plan | Note |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const p of Array.isArray(task.phases) ? task.phases : []) {
    const blocked = Array.isArray(p.blocked_by) ? p.blocked_by.join(", ") : p.blocked_by;
    lines.push(`| ${[cell(p.id), cell(p.name), cell(p.status), cell(blocked) || "—", cell(p.plan_path) || "—", cell(p.note)].join(" | ")} |`);
  }
  lines.push(PHASES_END);
  return lines;
}

/** For each line, whether it sits in, opens or closes a fenced code block (CommonMark: an unclosed fence runs to the end). */
function fencedLines(lines) {
  let open = null;
  return lines.map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null;
      return true;
    }
    if (m) { open = m[1]; return true; }
    return false;
  });
}

/**
 * `md` with the phase block put in place, or null when the file must be left
 * alone (a marker pair that is not exactly one start before one end). Only the
 * block's own lines, the empty template table it replaces and the lines added
 * around a new block change; every other byte stays.
 */
function withPhasesBlock(md, task) {
  const lines = md.split("\n");
  const fenced = fencedLines(lines);
  const at = (test) => lines.map((l, i) => (!fenced[i] && test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const starts = at((t) => t === PHASES_START);
  const ends = at((t) => t === PHASES_END);
  const block = phasesTable(task);

  if (starts.length + ends.length > 0) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) return null;
    lines.splice(starts[0], ends[0] - starts[0] + 1, ...block);
    return lines.join("\n");
  }

  const heading = at((t) => /^##\s+Phases$/.test(t))[0];
  if (heading === undefined) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("## Phases", "", ...block, "");
    return lines.join("\n");
  }

  let j = heading + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  const isTemplate = lines[j] !== undefined && lines[j].trim() === TEMPLATE_TABLE[0] && lines[j + 1] !== undefined && lines[j + 1].trim() === TEMPLATE_TABLE[1]
    && (lines[j + 2] === undefined || lines[j + 2].trim() === "");
  if (isTemplate) {
    lines.splice(j, 2, ...block);
  } else {
    const after = lines[heading + 1];
    lines.splice(heading + 1, 0, "", ...block, ...(after !== undefined && after.trim() !== "" ? [""] : []));
  }
  return lines.join("\n");
}

/**
 * Put the phase table into the task's task.md. The file is read, the new text
 * written beside it and renamed over it only when the file is byte-for-byte and
 * mtime the same as when it was read, so an editor's concurrent save is not
 * overwritten (the instants between the check and the rename are not covered).
 * Never throws: a broken task.md must not stop a state write.
 */
function renderTaskMdPhases(taskDir, task) {
  let tmp = null;
  try {
    const file = require("./task").taskMdPath(taskDir, task);
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    const original = fs.readFileSync(file, "utf8");
    const text = withPhasesBlock(original, task);
    if (text === null || text === original) return;
    tmp = `${file}.phases-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: stat.mode & 0o777 });
    const now = fs.statSync(file);
    if (now.mtimeMs !== stat.mtimeMs || fs.readFileSync(file, "utf8") !== original) return;
    fs.renameSync(tmp, file);
    tmp = null;
  } catch {
    /* leave the file as it is */
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

module.exports = { renderStateMd, renderStateMdText, renderIndexMdText, rebuildTasksIndex, renderIndexMd, phasesTable, withPhasesBlock, renderTaskMdPhases };
