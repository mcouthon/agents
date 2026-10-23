"use strict";

/**
 * `a report` — validates and persists subagent JSON reports to task.json.
 * Schemas are single-sourced in report-schemas.json.
 * On success, the report is stored in the phase's `reports` object and the
 * implied transition is applied (planned, implemented, verdict recorded).
 */

const fs = require("fs");
const path = require("path");
const { writeTaskJson, readTaskJson } = require("./task");
const { applyTransition } = require("./transitions");
const { withLock } = require("./lock");
const { renderStateMd } = require("./render");
const { extractJsonReport, extractJsonCandidates } = require("./report-extract");

const SCHEMAS_PATH = path.join(__dirname, "report-schemas.json");

let _schemas = null;
function loadSchemas() {
  if (_schemas) return _schemas;
  _schemas = JSON.parse(fs.readFileSync(SCHEMAS_PATH, "utf8"));
  return _schemas;
}

/**
 * Normalise a report before validation and storage (F9).
 * Maps severity aliases (blocking→red, warning→yellow), description→text,
 * and defaults summary to "" when missing.
 * Returns a deep copy — the original is not mutated.
 */
function normaliseReport(report) {
  if (!report || typeof report !== "object") return report;
  const normalised = JSON.parse(JSON.stringify(report));
  // F9: normalise severity aliases and description→text in reviewer issues
  if (Array.isArray(normalised.issues)) {
    for (const issue of normalised.issues) {
      if (issue && typeof issue === "object") {
        if (issue.severity === "blocking") issue.severity = "red";
        if (issue.severity === "warning") issue.severity = "yellow";
        if (issue.description && !issue.text) {
          issue.text = issue.description;
          delete issue.description;
        }
      }
    }
  }
  // F9: default summary for reviewer reports (verdict field present)
  if ("verdict" in normalised && !("summary" in normalised)) {
    normalised.summary = "";
  }
  return normalised;
}

/**
 * Validate a report object against the schema for the given agent type.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 * Pre-processes the report to normalise F9 aliases before validation.
 *
 * @param {string} agentType - "explorer" | "reviewer" | "builder" | "committer"
 * @param {object} report - The report object to validate
 * @returns {{ valid: boolean, errors: string[], normalised?: object }}
 */
function validateReport(agentType, report) {
  const schemas = loadSchemas();
  const schema = schemas[agentType];
  if (!schema) {
    return { valid: false, errors: [`unknown agent type: ${agentType}`] };
  }

  const normalised = normaliseReport(report);
  const errors = [];
  validateType(normalised, schema, "", errors);
  return { valid: errors.length === 0, errors, normalised };
}

function validateType(value, schema, pathPrefix, errors) {
  const p = pathPrefix || "root";

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${p}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
      return;
    }
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in value)) {
          errors.push(`${p}.${field}: required field missing`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          validateType(value[key], subSchema, `${p}.${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${p}.${key}: additional property not allowed`);
        }
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${p}: expected string, got ${typeof value}`);
    }
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${p}: expected integer, got ${typeof value}`);
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(`${p}: expected boolean, got ${typeof value}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${p}: expected array, got ${typeof value}`);
      return;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateType(value[i], schema.items, `${p}[${i}]`, errors);
      }
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${p}: expected one of [${schema.enum.join(", ")}], got ${JSON.stringify(value)}`);
  }

  // Union types (e.g. ["string", "null"])
  if (Array.isArray(schema.type)) {
    const typeOk = schema.type.some((t) => {
      if (t === "null") return value === null;
      if (t === "string") return typeof value === "string";
      if (t === "integer") return typeof value === "number" && Number.isInteger(value);
      if (t === "boolean") return typeof value === "boolean";
      if (t === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (t === "array") return Array.isArray(value);
      return false;
    });
    if (!typeOk) {
      errors.push(`${p}: expected type [${schema.type.join("|")}], got ${typeof value}`);
    }
  }
}

/**
 * Persist a validated report to task.json and apply the implied transition.
 *
 * @param {object} opts
 * @param {string} opts.taskDir - Absolute path to the task directory
 * @param {number} opts.phaseId - Phase ID
 * @param {string} opts.agentType - "explorer" | "reviewer" | "builder" | "committer"
 * @param {object} opts.report - The validated report object
 * @param {object} [opts.ctx] - { projectDir, gitFacts }
 * @returns {{ stored: boolean, transition: string|null, phase: object, discrepancies: string[] }}
 */
function persistReport(opts) {
  const { taskDir, phaseId, agentType, report, ctx } = opts;
  const holder = { session_id: process.pid, pid: process.pid };
  const transitionCtx = { ...(ctx || {}), taskDir };

  return withLock(taskDir, holder, () => {
    const task = readTaskJson(taskDir);
    if (!task) throw new Error("task.json not found. Run `a task migrate` first.");

    const phase = (task.phases || []).find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found in task.json`);

    // F9: normalise aliases before storing
    const storedReport = normaliseReport(report);

    // F8: record written_by attribution
    const writerSession = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
    storedReport.written_by = { session_id: writerSession, agent: agentType };

    // Store the report
    if (!phase.reports) phase.reports = {};
    const previous = phase.reports[agentType] || null;
    phase.reports[agentType] = storedReport;

    // Apply the implied transition based on agent type
    let transition = null;
    let discrepancies = [];

    if (agentType === "explorer") {
      if (report.plan_path) phase.plan_path = report.plan_path;
      if (report.manifest) phase.manifest = report.manifest;
      if (phase.status === "not_started") {
        applyTransition(phase, "planned", task, transitionCtx);
        transition = "not_started → planned";
      } else if (phase.status === "planned") {
        // D55: a revised plan voids the previous plan-review verdict.
        phase.reports.reviewer = null;
        transition = "planned (plan revised, review verdict cleared)";
      }
      if (report.open_questions && report.open_questions.length > 0) {
        const counters = phase.counters || (phase.counters = {});
        if ((counters.clarify_rounds || 0) < 1) {
          // Don't transition; let `a next` surface the checkpoint
        }
      }
    } else if (agentType === "builder") {
      if (phase.status === "in_progress") {
        applyTransition(phase, "implemented", task, transitionCtx);
        transition = "in_progress → implemented";
      }
      if (ctx && ctx.projectDir && report.files_touched) {
        discrepancies = checkFileDiscrepancies(report.files_touched, ctx.projectDir);
      }
    } else if (agentType === "reviewer") {
      const passing = report.verdict === "pass" || report.verdict === "pass_with_notes";
      if (phase.status === "planned") {
        if (passing) {
          applyTransition(phase, "reviewed", task, transitionCtx);
          transition = "planned → reviewed";
        } else {
          // D55: a failing plan review is stored, counted, and leaves the
          // phase `planned`; `a next` then asks the Explorer to revise.
          // Attempting planned → reviewed here threw on the verdict guard,
          // which dropped the report and blocked the Reviewer's stop.
          // One failing round per plan version: a re-persist of the same
          // verdict (CLI plus SubagentStop, or a retry) must not burn the cap.
          // The Explorer's revision clears `reports.reviewer`, which re-arms it.
          if (!previous) {
            const counters = phase.counters || (phase.counters = {});
            counters.review_passes = (counters.review_passes || 0) + 1;
          }
          transition = `planned (review ${report.verdict}, revise plan)`;
        }
      } else if (phase.status === "implemented") {
        if (report.verdict === "needs_work") {
          applyTransition(phase, "in_progress", task, transitionCtx);
          transition = "implemented → in_progress (needs_work)";
        }
      }
    } else if (agentType === "committer") {
      // D34: copy SHAs from the committer report into phase.commits when
      // present. The report may carry commits as objects with a .sha field
      // or as plain SHA strings. Resolution to full SHAs and the transition
      // to `committed` happen separately (a state update --commits or a land).
      const reportCommits = report.commits || [];
      const shas = reportCommits
        .map((c) => (typeof c === "string" ? c : (c && c.sha) || null))
        .filter((s) => s && typeof s === "string");
      if (shas.length > 0) {
        phase.commits = shas;
      }
    }

    task.updated = new Date().toISOString();
    writeTaskJson(taskDir, task);

    // Render state.md
    if (ctx && ctx.projectDir) {
      try {
        renderStateMd(taskDir, task, ctx.projectDir);
      } catch {}
    }

    return {
      stored: true,
      transition,
      phase: { id: phase.id, name: phase.name, status: phase.status },
      discrepancies,
    };
  });
}

/**
 * Cross-check reported files_touched vs actual git status.
 * Returns a list of discrepancy strings.
 */
function checkFileDiscrepancies(filesTouched, projectDir) {
  const discrepancies = [];
  let gitStatus = "";
  try {
    const { execFileSync } = require("child_process");
    gitStatus = execFileSync("git", ["-C", projectDir, "status", "--porcelain"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return discrepancies;
  }

  const modifiedFiles = new Set(
    gitStatus.split("\n").filter(Boolean).map((line) => line.slice(3).trim())
  );

  // Files reported but not modified in git
  for (const f of filesTouched) {
    if (!modifiedFiles.has(f)) {
      discrepancies.push(`reported but not in git status: ${f}`);
    }
  }
  // Files modified in git but not reported (only check tracked, non-generated files)
  for (const f of modifiedFiles) {
    if (!filesTouched.includes(f)) {
      discrepancies.push(`modified in git but not reported: ${f}`);
    }
  }

  return discrepancies;
}

/**
 * Render a JSON skeleton string with placeholder values for each required
 * key (D47). The skeleton is valid JSON — per-key explanations are NOT
 * inside the fence; renderSkeletonNotes returns them as a list to place
 * under the fence (D50 item 2), so the agent can paste the fence verbatim
 * and it parses.
 */
function placeholderFor(prop) {
  if (prop.type === "string") {
    if (prop.enum) return `"${prop.enum[0]}"`;
    return '"..."';
  }
  if (prop.type === "integer") return "0";
  if (prop.type === "boolean") return "false";
  if (prop.type === "array") {
    if (!prop.items) return "[]";
    if (prop.items.type === "string") return '["..."]';
    if (prop.items.type === "object") {
      const itemProps = prop.items.properties || {};
      const itemRequired = prop.items.required || [];
      const inner = itemRequired
        .map((k) => `"${k}": ${placeholderFor(itemProps[k])}`)
        .join(", ");
      return `[{ ${inner} }]`;
    }
    return "[]";
  }
  if (Array.isArray(prop.type)) return '"..."';
  return "null";
}

function renderSkeleton(schemaName) {
  const schemas = loadSchemas();
  const schema = schemas[schemaName];
  if (!schema) return null;
  const props = schema.properties || {};
  const required = schema.required || [];
  const lines = ["{"];
  for (let i = 0; i < required.length; i++) {
    const key = required[i];
    const prop = props[key];
    if (!prop) continue;
    const val = placeholderFor(prop);
    const comma = i < required.length - 1 ? "," : "";
    lines.push(`  "${key}": ${val}${comma}`);
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Return the per-key explanation list for a skeleton (D50 item 2). Each entry
 * is a markdown bullet naming the key and its schema description, meant to be
 * placed under the ```json fence — not inside it. Returns null for an unknown
 * schema, [] when no keys have a description.
 */
function renderSkeletonNotes(schemaName) {
  const schemas = loadSchemas();
  const schema = schemas[schemaName];
  if (!schema) return null;
  const props = schema.properties || {};
  const required = schema.required || [];
  const notes = [];
  if (props.phase_id) {
    notes.push("- Add `phase_id`: the integer id of the phase your prompt names; leave it out if none was named.");
  }
  for (const key of required) {
    const prop = props[key];
    if (!prop) continue;
    const desc = prop.description || "";
    notes.push(desc ? `- \`${key}\` — ${desc}` : `- \`${key}\``);
  }
  return notes;
}

/**
 * Validate then persist: the one path `a report` and the report-capture hook
 * share.
 * @returns {{ valid: false, errors: string[] } | { valid: true, result: object }}
 */
function submitReport({ taskDir, phaseId, agentType, report, projectDir }) {
  const validation = validateReport(agentType, report);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  const stated = validation.normalised && validation.normalised.phase_id;
  if (stated && stated !== phaseId) {
    return { valid: false, errors: [`phase_id ${stated} in the report does not match phase ${phaseId}`] };
  }
  const result = persistReport({
    taskDir,
    phaseId,
    agentType,
    report: validation.normalised || report,
    ctx: { projectDir },
  });
  return { valid: true, result };
}

module.exports = {
  validateReport,
  persistReport,
  submitReport,
  loadSchemas,
  checkFileDiscrepancies,
  renderSkeleton,
  renderSkeletonNotes,
  normaliseReport,
  extractJsonReport,
  extractJsonCandidates,
};
