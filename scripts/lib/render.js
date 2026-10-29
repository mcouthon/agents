"use strict";

/** The phases block inside task.md, rendered from task.json on every write. */

const fs = require("fs");

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

module.exports = { phasesTable, withPhasesBlock, renderTaskMdPhases };
