"use strict";

/**
 * task.md's three rendered blocks — phases, decisions, notes — from the task's
 * view (the tables). Every intent write renders them through db-export's
 * exportTask with an mtime-guarded rename; the bytes outside the markers never
 * change. A phase's mark is [x] checked, [-] skipped, [ ] open; a decision line
 * carries its gate, an (agent) waiver or a (migrated) row; every quote and note
 * line is prefixed `  > ` so a fence inside one cannot swallow an end marker.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// The markers and the one-line fields
// ---------------------------------------------------------------------------

const PHASES_START = "<!-- phases:start -->";
const PHASES_END = "<!-- phases:end -->";
const DECISIONS_START = "<!-- decisions:start -->";
const DECISIONS_END = "<!-- decisions:end -->";
const NOTES_START = "<!-- notes:start -->";
const NOTES_END = "<!-- notes:end -->";
/** The empty template table a fresh task.md holds where the phases block goes. */
const TEMPLATE_TABLE = ["| # | Phase | Notes |", "|---|---|---|"];

/** Rendered text: newlines flattened, HTML comment tokens broken with an em dash. */
function neutral(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\r?\n/g, " ")
    .replace(/<!--/g, "<!—")
    .replace(/-->/g, "—>");
}

const utcDate = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "—");
const utcStamp = (iso) => (typeof iso === "string" && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : "—");

const latestOf = (decisions, phaseId, ...choices) => {
  const rows = (decisions || []).filter((d) => d.phase_id === phaseId && choices.includes(d.choice));
  return rows.length > 0 ? rows[rows.length - 1] : null;
};

// ---------------------------------------------------------------------------
// The three blocks (pure)
// ---------------------------------------------------------------------------

/** The phases block: one line per phase with its mark, after list, plan link and verdicts. */
function phasesLines(view, taskDir) {
  const derive = require("./derive");
  const lines = [
    PHASES_START,
    "_Rendered from the agents database; edit outside these markers._",
    "",
  ];
  for (const p of view.phases || []) {
    const name = neutral(p.name || "(unnamed)");
    const after = (Array.isArray(p.blocked_by) ? p.blocked_by : []).join(", ") || "—";
    let plan = "plan —";
    if (p.plan_path) {
      plan = `plan [${neutral(path.basename(p.plan_path))}](${p.plan_path})`;
    }
    const mark = p.skipped ? "[-]" : p.checked ? "[x]" : "[ ]";
    if (p.skipped) {
      const skip = latestOf(view.decisions, p.id, "skip");
      const migrated = skip && skip.recorded_by === "migration" ? " (migrated)" : "";
      lines.push(`- ${mark} **${p.id}** ${name} · after ${after} · ${plan} · skipped ${utcDate(skip && skip.decided_at)}${migrated}`);
      continue;
    }
    let approved = "approved —";
    const verdict = latestOf(view.decisions, p.id, "approve", "reject");
    if (verdict && p.plan_path) {
      let hash = null;
      try {
        const file = path.isAbsolute(p.plan_path) ? p.plan_path : path.join(taskDir, p.plan_path);
        hash = derive.planHash(fs.readFileSync(file, "utf8"));
      } catch { /* unreadable plan: no hash to compare */ }
      approved = verdict.choice === "approve" && hash !== null && verdict.plan_hash === hash
        ? `approved ${utcDate(verdict.decided_at)}`
        : "approved stale";
    }
    const accept = latestOf(view.decisions, p.id, "accept");
    lines.push(`- ${mark} **${p.id}** ${name} · after ${after} · ${plan} · ${approved} · ${accept ? `accepted ${utcDate(accept.decided_at)}` : "accepted —"}`);
  }
  lines.push(PHASES_END);
  return lines;
}

/** The decisions block: one entry per row with its gate and authorship, the quote quoted. */
function decisionsLines(view) {
  const lines = [DECISIONS_START];
  for (const d of view.decisions || []) {
    const who = d.phase_id === null || d.phase_id === undefined ? "task" : `phase ${d.phase_id}`;
    let head = `- **${utcStamp(d.decided_at)}** · ${who} · ${neutral(d.choice)}`;
    if (d.gate) head += ` ${neutral(d.gate)}`;
    if (d.choice === "waived") head += " (agent)";
    else if (d.recorded_by === "migration") head += " (migrated)";
    lines.push(head);
    for (const q of String(d.quote ?? "").split("\n")) lines.push(`  > ${neutral(q)}`);
  }
  lines.push(DECISIONS_END);
  return lines;
}

/** The notes block: one entry per note, the text quoted. */
function notesLines(view) {
  const lines = [NOTES_START];
  for (const n of view.notes || []) {
    const who = n.phase_id === null || n.phase_id === undefined ? "task" : `phase ${n.phase_id}`;
    lines.push(`- **${utcStamp(n.at)}** · ${who}`);
    for (const q of String(n.text ?? "").split("\n")) lines.push(`  > ${neutral(q)}`);
  }
  lines.push(NOTES_END);
  return lines;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** For each line, whether it sits in, opens or closes a fenced code block (an unclosed fence runs to the end). */
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

/** The one non-fenced occurrence of a marker line, or -1. */
function markerAt(lines, fenced, marker) {
  let found = -1;
  lines.forEach((l, i) => { if (found === -1 && !fenced[i] && l.trim() === marker) found = i; });
  return found;
}

/** The one non-fenced line matching `re`, or -1. */
function headingAt(lines, fenced, re) {
  let found = -1;
  lines.forEach((l, i) => { if (found === -1 && !fenced[i] && re.test(l.trim())) found = i; });
  return found;
}

/** The marker pair's span, `absent`, or `broken` (two pairs, a lone marker, or a crossed pair). */
function blockAt(lines, fenced, startMark, endMark) {
  const starts = [];
  const ends = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (fenced[i]) return;
    if (t === startMark) starts.push(i);
    else if (t === endMark) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) return { kind: "absent" };
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) return { kind: "pair", start: starts[0], end: ends[0] };
  return { kind: "broken" };
}

/** Put the phases block where it belongs; returns the line array or null when the file must be left alone. */
function placePhases(lines, view, taskDir) {
  const block = phasesLines(view, taskDir);
  const fenced = fencedLines(lines);
  const at = blockAt(lines, fenced, PHASES_START, PHASES_END);
  if (at.kind === "pair") {
    lines.splice(at.start, at.end - at.start + 1, ...block);
    return lines;
  }
  if (at.kind === "broken") return null;
  const heading = headingAt(lines, fenced, /^##\s+Phases$/);
  if (heading === -1) {
    if (lines.length === 0 || lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("## Phases", "", ...block, "");
    return lines;
  }
  let j = heading + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  const isTemplate = lines[j] !== undefined && lines[j].trim() === TEMPLATE_TABLE[0]
    && lines[j + 1] !== undefined && lines[j + 1].trim() === TEMPLATE_TABLE[1]
    && (lines[j + 2] === undefined || lines[j + 2].trim() === "");
  if (isTemplate) {
    lines.splice(j, 2, ...block);
  } else {
    const after = lines[heading + 1];
    lines.splice(heading + 1, 0, "", ...block, ...(after !== undefined && after.trim() !== "" ? [""] : []));
  }
  return lines;
}

/** Replace one block's content, or insert it (blank-separated) at `insertAt` when it has no markers yet. */
function placeBlock(lines, startMark, endMark, content, insertAt) {
  const fenced = fencedLines(lines);
  const at = blockAt(lines, fenced, startMark, endMark);
  if (at.kind === "broken") return null;
  if (at.kind === "pair") {
    lines.splice(at.start, at.end - at.start + 1, ...content);
    return lines;
  }
  lines.splice(insertAt, 0, "", ...content);
  return lines;
}

/**
 * The rendered text of a task.md: the phases block in place, the decisions
 * block under a `## Decision Log` heading when one exists (else right after the
 * phases block), the notes block right after the phases block. Null when a
 * marker pair is not exactly one start before one end — the file is left alone.
 */
function renderTaskMdText(md, view, taskDir) {
  const lines = placePhases(md.split("\n"), view, taskDir);
  if (lines === null) return null;
  const notes = placeBlock(lines, NOTES_START, NOTES_END, notesLines(view), markerAt(lines, fencedLines(lines), PHASES_END) + 1);
  if (notes === null) return null;
  const fenced = fencedLines(notes);
  const log = headingAt(notes, fenced, /^##\s+Decision Log\b/);
  const decisionsAt = log === -1 ? markerAt(notes, fenced, PHASES_END) + 1 : log + 1;
  return placeBlock(notes, DECISIONS_START, DECISIONS_END, decisionsLines(view), decisionsAt);
}

/**
 * Write the three blocks into the task's task.md. The file is read, the new
 * text written beside it and renamed over it only when the file is
 * byte-for-byte and mtime the same as when it was read, so an editor's
 * concurrent save is not overwritten. A task.md that does not exist yet (a v1
 * folder of state files, a row whose folder was never written) is created in
 * the fresh shape first. Never throws: a broken task.md must not stop a task
 * write.
 */
function renderTaskMd(taskDir, view) {
  let tmp = null;
  try {
    const taskLib = require("./task");
    const file = taskLib.taskMdPath(taskDir);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, taskLib.renderTaskMd({
        number: view.number, slug: view.slug, title: view.title, description: "",
      }) + "\n", { mode: 0o644 });
    }
    const stat = fs.statSync(file);
    const original = fs.readFileSync(file, "utf8");
    const lines = renderTaskMdText(original, view, taskDir);
    if (lines === null) return;
    const text = lines.join("\n");
    if (text === original) return;
    tmp = `${file}.render-${process.pid}.tmp`;
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

module.exports = {
  PHASES_START, PHASES_END, DECISIONS_START, DECISIONS_END, NOTES_START, NOTES_END,
  neutral, utcDate, utcStamp,
  phasesLines, decisionsLines, notesLines,
  fencedLines, renderTaskMdText, renderTaskMd,
};
