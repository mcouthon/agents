#!/usr/bin/env node
// Template generator for Claude Code.
//
// Generates CC output files from templates:
//   templates/agents/*.template.md          -> generated/claude/agents/*.md
//   templates/skills/{name}/SKILL.template.md -> generated/claude/skills/{name}/SKILL.md
//   templates/instructions/*.template.md    -> generated/claude/rules/*.md
//
// Commands:
//   node scripts/generate.js cc      [--config defaults/config.json] [--output-dir generated/] [--source templates/] [--dry-run]
//   node scripts/generate.js all     [--config defaults/config.json] [--output-dir generated/] [--source templates/] [--dry-run]
//
// Exit codes:
//   0 - Success (files generated or already up to date)
//   1 - Dry-run validation failed (committed files are out of date)
//   2 - Error (parse failure, missing template, etc.)

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// User Configuration
// ---------------------------------------------------------------------------

/**
 * Read config from the given path.
 * Fails loudly on missing file or malformed JSON.
 */
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file not found: ${configPath}`);
    process.exit(2);
  }

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    console.error(`Error: Cannot read ${configPath}: ${e.message}`);
    process.exit(2);
  }

  let userConfig;
  try {
    userConfig = JSON.parse(content) || {};
  } catch (e) {
    console.error(`Error: Invalid JSON in ${configPath}:`);
    console.error(`  ${e.message}`);
    process.exit(2);
  }

  if (userConfig.models) {
    const knownTypes = Object.keys(MODEL_TYPES);
    for (const type of Object.keys(userConfig.models)) {
      if (!knownTypes.includes(type)) {
        console.warn(
          `Warning: Unknown model type "${type}" in config (expected: ${knownTypes.join(", ")})`,
        );
      }
    }
  }

  if (userConfig.agents) {
    const knownTypes = Object.keys(MODEL_TYPES);
    for (const [name, spec] of Object.entries(userConfig.agents)) {
      const type = spec && spec.cc;
      if (!type) continue;
      // `inherit` is a recognized value but not a model type, so it is absent from
      // knownTypes by design; typeAllowedOn below is what confines it to cc.
      if (type !== CC_INHERIT && !knownTypes.includes(type)) {
        console.warn(
          `Warning: Unknown model type "${type}" for agent "${name}" in config (expected: ${knownTypes.join(", ")})`,
        );
        continue;
      }
      if (!typeAllowedOn(type)) {
        console.warn(
          `Warning: Model type "${type}" for agent "${name}" is not available on cc — keeping the template's model type`,
        );
        continue;
      }
    }
  }

  const rawMcpServers = JSON.parse(JSON.stringify(userConfig.mcpServers || {}));

  // Credential guard (fatal): scan every mcpServers profile for keys/values
  // shaped like a credential before anything else touches the data. Profile
  // values flow into committed generated files, so this is the one place a
  // leaked secret must be stopped outright.
  for (const [id, profile] of Object.entries(rawMcpServers)) {
    scanMcpProfileForCredentials(id, profile);
  }

  const mcpServers = validateMcpServers(rawMcpServers);

  return {
    models: { ...userConfig.models },
    defaultTools: JSON.parse(JSON.stringify(userConfig.defaultTools || {})),
    agentTools: JSON.parse(JSON.stringify(userConfig.agentTools || {})),
    agents: JSON.parse(JSON.stringify(userConfig.agents || {})),
    mcpServers,
  };
}

// ---------------------------------------------------------------------------
// MCP server profiles
// ---------------------------------------------------------------------------

// Case-insensitive: matches a credential-shaped KEY anywhere in a profile.
const MCP_CREDENTIAL_KEY_RE =
  /(token|secret|password|apikey|api_key|authorization|bearer|credential)/i;
// Anchored, case-sensitive: matches a credential-shaped VALUE. Anchoring means
// a convention that merely mentions "bearer token" in prose does not false-positive.
const MCP_CREDENTIAL_VALUE_RE = /^(Bearer|Basic)\s|^gh[pousr]_|^sk-/;

/**
 * Recursively scan an mcpServers profile for keys or string values that look
 * like an embedded credential. Aborts the whole build (exit 2) on a hit —
 * unlike every other mcpServers validation, this one is fatal because a
 * leaked secret is not recoverable after the fact.
 */
function scanMcpProfileForCredentials(profileId, value, pathPrefix = "") {
  if (value == null) return;

  if (typeof value === "string") {
    if (MCP_CREDENTIAL_VALUE_RE.test(value)) {
      console.error(
        `Error: mcpServers.${profileId}${pathPrefix} looks like a credential. ` +
          `Do not embed secrets in defaults/config.json — use \${input:...} in mcp.json instead.`,
      );
      process.exit(2);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      scanMcpProfileForCredentials(profileId, v, `${pathPrefix}[${i}]`),
    );
    return;
  }

  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (MCP_CREDENTIAL_KEY_RE.test(key)) {
        console.error(
          `Error: mcpServers.${profileId}${pathPrefix}.${key} looks like a credential key. ` +
            `Do not embed secrets in defaults/config.json — use \${input:...} in mcp.json instead.`,
        );
        process.exit(2);
      }
      scanMcpProfileForCredentials(profileId, v, `${pathPrefix}.${key}`);
    }
  }
}

/**
 * Resolve a value that may be a plain string/array (same on all platforms)
 * or a per-platform object ({ cc: ... }). Returns undefined for
 * anything else. Shared by grant, toolNames and callingConvention.
 */
function resolvePlatformValue(value, platformKey) {
  if (typeof value === "string" || Array.isArray(value)) return value;
  if (value && typeof value === "object") return value[platformKey];
  return undefined;
}

// A field is a valid callingConvention shape if it's a string, or a
// per-platform map keyed only by known platform keys ("cc") with
// string values. An object with no recognised platform key (or a non-string
// value) is not a valid shape — resolvePlatformValue would silently return
// undefined for it, which must be treated as an invalid field (skip the
// whole profile), not as "no clause" (which is reserved for a genuinely
// absent or empty-after-normalisation field).
function isCallingConventionShape(value) {
  if (typeof value === "string") return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    return (
      keys.length > 0 &&
      keys.every((k) => k === "cc") &&
      Object.values(value).every((v) => typeof v === "string")
    );
  }
  return false;
}

/**
 * Guidance-string validation for a single resolved string value: reject
 * embedded newlines (checked BEFORE trimming) and enforce a 120-character
 * cap (checked post-trim). Returns an error string, or null if valid.
 */
function checkGuidanceString(value, maxLength = 120) {
  if (/[\r\n]/.test(value)) {
    return "contains an embedded newline";
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return `is ${trimmed.length} characters (max ${maxLength})`;
  }
  return null;
}

/**
 * Validate and filter the raw mcpServers config into a map of well-formed
 * profiles only. Malformed profiles are warned about and skipped entirely
 * (never partially rendered) — loud-but-non-fatal, exit 0.
 */
function validateMcpServers(rawMcpServers) {
  const result = {};

  for (const [id, profile] of Object.entries(rawMcpServers)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      console.warn(`Warning: mcpServers.${id} is not an object; skipping.`);
      continue;
    }

    if (typeof profile.displayName !== "string" || !profile.toolNames) {
      console.warn(
        `Warning: mcpServers.${id} is missing displayName or toolNames; skipping profile.`,
      );
      continue;
    }

    // Unknown salience: warn and fall back to the quieter, safer default.
    let salience = profile.salience;
    if (salience !== "preferred" && salience !== "on-demand") {
      if (salience !== undefined) {
        console.warn(
          `Warning: mcpServers.${id} has unknown salience ${JSON.stringify(salience)}; treating as "on-demand".`,
        );
      }
      salience = "on-demand";
    }

    // callingConvention, if present, must be a string or a per-platform
    // string map. Rendering the pitch without the mechanics is the exact
    // failure this task exists to fix, so a malformed shape skips the whole
    // profile rather than silently dropping just the field.
    if (
      profile.callingConvention !== undefined &&
      !isCallingConventionShape(profile.callingConvention)
    ) {
      console.warn(
        `Warning: mcpServers.${id}.callingConvention is not a string (or per-platform string map); skipping profile.`,
      );
      continue;
    }

    // Guidance-string validation: displayName, hint, callingConvention — the
    // three fields that reach the agent body. Warn + skip the whole profile.
    let skip = false;
    const guidanceFields = [["displayName", profile.displayName]];
    if (profile.hint !== undefined) guidanceFields.push(["hint", profile.hint]);

    for (const [field, value] of guidanceFields) {
      if (typeof value !== "string") {
        console.warn(
          `Warning: mcpServers.${id}.${field} is not a string; skipping profile.`,
        );
        skip = true;
        break;
      }
      const err = checkGuidanceString(value);
      if (err) {
        console.warn(
          `Warning: mcpServers.${id}.${field} ${err}; skipping profile.`,
        );
        skip = true;
        break;
      }
    }

    if (!skip && profile.callingConvention !== undefined) {
      const ccValues =
        typeof profile.callingConvention === "string"
          ? [profile.callingConvention]
          : Object.values(profile.callingConvention);
      for (const v of ccValues) {
        const err = checkGuidanceString(v);
        if (err) {
          console.warn(
            `Warning: mcpServers.${id}.callingConvention ${err}; skipping profile.`,
          );
          skip = true;
          break;
        }
      }
    }

    if (skip) continue;

    result[id] = { ...profile, salience };
  }

  return result;
}

/**
 * Profiles whose `agents` list includes agentName, in config declaration
 * order (Object.values preserves insertion order for string keys).
 */
function resolveMcpProfilesForAgent(config, agentName) {
  return Object.values(config.mcpServers || {}).filter((profile) =>
    (profile.agents || []).includes(agentName),
  );
}

// Model-type registry: how each abstract type renders to a model string.
// - family:        display family name (e.g. "Claude Opus")
// - versionSep:    string joining family and version (" " for Claude)
const MODEL_TYPES = {
  opus: {
    family: "Claude Opus",
    versionSep: " ",
  },
  sonnet: {
    family: "Claude Sonnet",
    versionSep: " ",
  },
  haiku: {
    family: "Claude Haiku",
    versionSep: " ",
  },
};

// Claude Code's "use the session's model" frontmatter sentinel, valid in the same
// field as the tier aliases (docs/sources/claude-code/sub-agents.md:44). Deliberately
// NOT a MODEL_TYPES entry: it has no family and no version, is never rendered, and
// must not appear in the "expected: ..." lists built from Object.keys(MODEL_TYPES).
const CC_INHERIT = "inherit";

/**
 * May model type `type` be emitted to CC?
 *
 * `inherit` is cc-only.
 *
 * Other unknown types are NOT emittable: the CC branch of resolve() passes the
 * type name through verbatim, so an unknown alias would land in agent frontmatter
 * Claude Code cannot resolve.
 */
function typeAllowedOn(type) {
  if (type === CC_INHERIT) return true;
  return !!MODEL_TYPES[type];
}

/**
 * Resolve model type to CC-specific string.
 * Input: "opus" or "sonnet" or ["opus", "sonnet"]
 * CC output: type name unchanged
 */
function resolveModels(modelSpec, config, agentName) {
  // Per-agent model override: replace the template's declared type(s) with the type
  // configured for cc (agents.<name>.cc). An override naming a type the platform
  // cannot emit is dropped and the template's type stands; readConfig has already
  // warned about it (same predicate, so the two sites cannot drift).
  if (agentName) {
    const override = ((config.agents || {})[agentName] || {}).cc;
    if (override && typeAllowedOn(override)) {
      modelSpec = override; // array fields collapse to a single overridden type
    }
  }

  // CC uses the type name unchanged, so no per-type transformation is needed.
  return modelSpec;
}

// ---------------------------------------------------------------------------
// Template Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a template file into structured data.
 * Returns { rawFrontmatterLines, body }
 * where rawFrontmatterLines are the raw text lines (for format-preserving output),
 * and body is the content after the closing ---.
 */
function parseTemplate(content) {
  const lines = content.split("\n");

  if (lines[0].trim() !== "---") {
    throw new Error("Template must start with frontmatter (---)");
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error("Unclosed frontmatter block (missing closing ---)");
  }

  const rawFrontmatterLines = lines.slice(1, closingIndex);
  // Body starts after the closing --- line
  const body = lines.slice(closingIndex + 1).join("\n");

  return { rawFrontmatterLines, body };
}

/**
 * Extract a single-line field value from raw frontmatter lines.
 * Returns the raw line text (e.g., 'name: Explorer') or null.
 * Only matches top-level (non-indented) fields.
 */
function extractRawFieldLine(rawLines, fieldKey) {
  const prefix = fieldKey + ":";
  for (const line of rawLines) {
    // Must not be indented (top-level field)
    if (
      line.startsWith(prefix) &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      return line;
    }
  }
  return null;
}

/**
 * Extract multi-line field value lines (for description that might wrap).
 * Returns array of raw lines starting at the field key.
 */
function extractRawFieldLines(rawLines, fieldKey) {
  const prefix = fieldKey + ":";
  let startIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (
      line.startsWith(prefix) &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  const result = [rawLines[startIdx]];
  // Collect continuation lines (indented)
  for (let i = startIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.startsWith("  ") || line.startsWith("\t")) {
      result.push(line);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Extract a known section (e.g., 'cc') from raw frontmatter lines.
 * Returns { lines, hasContent } where lines are de-indented by 2 spaces,
 * and hasContent is true if there are non-comment, non-empty lines.
 * Returns null if section not found.
 */
function extractRawSection(rawLines, sectionKey) {
  const keyLine = sectionKey + ":";
  let sectionStart = -1;

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trimEnd();
    // Section key must be at top level (not indented)
    if (
      trimmed === keyLine &&
      !rawLines[i].startsWith(" ") &&
      !rawLines[i].startsWith("\t")
    ) {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart === -1) return null;

  const lines = [];
  for (let i = sectionStart + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmedEnd = line.trimEnd();

    if (trimmedEnd === "") {
      // Empty line — include it (will be trimmed at end)
      lines.push("");
      continue;
    }

    if (line.startsWith("  ")) {
      // De-indent by 2 spaces
      lines.push(line.slice(2));
    } else {
      // Not indented — left the section
      break;
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trimEnd() === "") {
    lines.pop();
  }

  // Determine if section has real content (non-comment, non-empty)
  const hasContent = lines.some((l) => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("#");
  });

  return { lines, hasContent };
}

// ---------------------------------------------------------------------------
// Body Processing
// ---------------------------------------------------------------------------

/**
 * Normalize whitespace in output body.
 * - Removes trailing whitespace from each line
 * - Collapses 3+ consecutive blank lines to 2
 * - Ensures single trailing newline
 */
function cleanWhitespace(body) {
  // Remove trailing whitespace per line
  let cleaned = body
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // Collapse 3+ consecutive newlines to 2 (single blank line)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Ensure single trailing newline
  cleaned = cleaned.trimEnd() + "\n";

  return cleaned;
}

/**
 * Normalise a raw callingConvention clause: trim, strip one trailing '.',
 * trim again. Returns "" for undefined/null/non-string/whitespace-only/
 * period-only input — the empty result is what makes an absent field and an
 * empty field render byte-identically (§3.3).
 */
function normaliseCallingConvention(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s.trim();
}

/**
 * Render one profile's guidance bullet. The bullet is
 * two composable fragments: a pitch (varies with salience) and a calling
 * convention (does not) — a low-salience server can still carry a mandatory
 * argument, so the mechanics must survive both salience levels identically.
 */
function renderMcpProfileBullet(profile, platformKey) {
  const toolNames = resolvePlatformValue(profile.toolNames, platformKey);
  const displayName = profile.displayName;
  const hint = profile.hint;

  const pitch =
    profile.salience === "preferred"
      ? `- Prefer \`${toolNames}\` (${displayName}) ${hint} — reach for it before grep/glob.`
      : `- \`${toolNames}\` (${displayName}) is available ${hint}; look it up when the task calls for it.`;

  const convention = normaliseCallingConvention(
    resolvePlatformValue(profile.callingConvention, platformKey),
  );

  return convention ? `${pitch} Always ${convention}.` : pitch;
}

/**
 * Substitute the `{{MCP_GUIDANCE}}` placeholder line with one rendered
 * bullet per mcpServers profile whose `agents` list includes agentName, in
 * config declaration order. If no profile applies, the line is removed
 * entirely (cleanWhitespace then collapses the resulting blank run).
 *
 * Every other `{{...}}` token (e.g. host-injected `{{VSCODE_*}}` variables)
 * is left byte-for-byte untouched — only the exact literal
 * `{{MCP_GUIDANCE}}` is matched.
 */
function substituteMcpGuidance(body, config, agentName) {
  const platformKey = "cc";
  const profiles = resolveMcpProfilesForAgent(config, agentName);

  const lines = body.split("\n");
  const output = [];
  for (const line of lines) {
    if (line.trim() === "{{MCP_GUIDANCE}}") {
      for (const profile of profiles) {
        output.push(renderMcpProfileBullet(profile, platformKey));
      }
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

/**
 * Shared body pipeline: MCP guidance substitution, then whitespace
 * normalisation. Substitution runs BEFORE whitespace cleanup (so the rendered
 * text gets the same normalisation as everything else). Used by all three
 * template categories (agents, skills, instructions) — the same pipeline
 * serves all of them, and scoping substitution to agents only would be an
 * arbitrary restriction.
 */
function processBody(body, config, agentName) {
  const substituted = substituteMcpGuidance(body, config, agentName);
  return cleanWhitespace(substituted);
}

// ---------------------------------------------------------------------------
// Platform Formatters
// ---------------------------------------------------------------------------

/**
 * Resolve model tiers in section lines.
 * Transforms lines like 'model: opus' or 'model: ["opus", "sonnet"]'
 * into CC model strings. Preserves original format (scalar or array).
 */
function resolveSectionModels(lines, config, agentName) {
  return lines.map((line) => {
    // Match model: field (may have leading spaces for nested frontmatter)
    const modelMatch = line.match(/^(\s*)model:\s*(.+)$/);
    if (!modelMatch) return line;

    const indent = modelMatch[1];
    const valueStr = modelMatch[2].trim();

    // Parse the value (could be scalar or JSON array)
    let modelSpec;
    if (valueStr.startsWith("[")) {
      // JSON array like ["opus", "sonnet"]
      try {
        modelSpec = JSON.parse(valueStr);
      } catch {
        return line; // Can't parse, leave as-is
      }
    } else {
      // Scalar value like "opus"
      modelSpec = valueStr;
    }

    const resolved = resolveModels(modelSpec, config, agentName);
    const wasArray = Array.isArray(resolved);

    // Format back
    const formatArray = (arr) =>
      `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
    // CC preserves original format (scalar or array)
    if (wasArray) {
      return `${indent}model: ${formatArray(resolved)}`;
    }
    return `${indent}model: ${resolved}`;
  });
}

/**
 * Resolve tool additions from config into section lines.
 * Appends defaultTools, agentTools, and mcpServers profile grants into the
 * tools: array.
 *
 * Merge order and dedupe (normative, §3.2): concatenate defaultTools ->
 * agentTools -> profile grants (profiles in config declaration order; within
 * a profile, resolvePlatformValue(grant, platform) in array order), then a
 * single left-to-right pass, first occurrence wins, exact string equality
 * (no wildcard subsumption). This is deterministic and idempotent.
 */
function resolveSectionTools(lines, config, agentName) {
  const platformKey = "cc";
  const defaults = config.defaultTools[platformKey] || [];
  const agentSpecific = (config.agentTools[platformKey] || {})[agentName] || [];

  const profileGrants = resolveMcpProfilesForAgent(config, agentName).flatMap(
    (profile) =>
      [resolvePlatformValue(profile.grant, platformKey)].flat().filter(Boolean),
  );

  // Warn on duplicates between defaultTools and agentTools — a genuine
  // misconfiguration. Overlaps involving profile grants (source 3) are
  // silent: a profile grant coexisting with a hand-written defaultTools /
  // agentTools entry, or two profiles sharing a grant, is expected during
  // migration and not worth warning on every build.
  const defaultSet = new Set(defaults);
  for (const tool of agentSpecific) {
    if (defaultSet.has(tool)) {
      console.warn(
        `Warning: Tool ${JSON.stringify(tool)} appears in both defaultTools and agentTools for ${platformKey}/${agentName}`,
      );
    }
  }

  // Concatenate in fixed order, then dedupe left-to-right, first occurrence wins.
  const seen = new Set();
  const extraTools = [];
  for (const tool of [...defaults, ...agentSpecific, ...profileGrants]) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    extraTools.push(tool);
  }

  if (extraTools.length === 0) return lines;

  // Find the tools: line
  let toolsLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)tools:\s*(.*)/);
    if (match) {
      toolsLineIdx = i;
      break;
    }
  }

  if (toolsLineIdx === -1) return lines; // No tools field — skip

  const toolsLine = lines[toolsLineIdx];
  const toolsMatch = toolsLine.match(/^(\s*)tools:\s*(.*)/);
  const indent = toolsMatch[1]; // Indentation before "tools:"
  const afterColon = toolsMatch[2].trim();

  const result = [...lines];

  if (afterColon === "" || afterColon === "[") {
    // Format A: multi-line array
    // Find closing ]
    let closingIdx = -1;
    for (let i = toolsLineIdx + 1; i < result.length; i++) {
      if (result[i].trim() === "]") {
        closingIdx = i;
        break;
      }
    }
    if (closingIdx === -1) return lines; // Malformed — don't touch

    // Determine entry indentation from existing entries
    let entryIndent = indent + "    "; // default: 4 spaces deeper than tools:
    for (let i = toolsLineIdx + 1; i < closingIdx; i++) {
      const trimmed = result[i].trim();
      if (trimmed === "" || trimmed === "[") continue; // Skip blank lines and opening bracket
      const entryMatch = result[i].match(/^(\s+)\S/);
      if (entryMatch) {
        entryIndent = entryMatch[1];
        break;
      }
    }

    // Ensure the last existing entry has a trailing comma
    for (let i = closingIdx - 1; i > toolsLineIdx; i--) {
      const trimmed = result[i].trim();
      if (trimmed === "" || trimmed === "[" || trimmed.startsWith("#"))
        continue;
      if (!trimmed.endsWith(",")) {
        result[i] = result[i] + ",";
      }
      break;
    }

    // Insert new tool lines before closing ]
    const newLines = extraTools.map(
      (tool) => `${entryIndent}${JSON.stringify(tool)},`,
    );
    result.splice(closingIdx, 0, ...newLines);
  } else if (afterColon.startsWith("[") && afterColon.endsWith("]")) {
    // Format B: single-line array
    const inner = afterColon.slice(1, -1).trim();
    // For CC, tools may be unquoted bare words — quote others with proper escaping
    const extraEntries = extraTools
      .map((tool) => (/^[A-Za-z]\w*$/.test(tool) ? tool : JSON.stringify(tool)))
      .join(", ");
    const newInner = inner ? `${inner}, ${extraEntries}` : extraEntries;
    result[toolsLineIdx] = `${indent}tools: [${newInner}]`;
  }
  // else: unrecognized format — leave unchanged

  return result;
}

/**
 * Format a CC agent file from a parsed template.
 */
function formatCCAgent(template, config, agentName) {
  const { rawFrontmatterLines, body } = template;

  const nameLine = extractRawFieldLine(rawFrontmatterLines, "name");
  const descLines = extractRawFieldLines(rawFrontmatterLines, "description");
  const ccSection = extractRawSection(rawFrontmatterLines, "cc");

  if (!nameLine) throw new Error("Missing required field: name");
  if (!descLines) throw new Error("Missing required field: description");
  if (!ccSection || !ccSection.hasContent) {
    throw new Error("Missing required cc: section");
  }

  // Resolve model tiers (CC uses tier names directly, but still validate)
  const resolvedLines = resolveSectionModels(
    ccSection.lines,
    config,
    agentName,
  );

  const finalLines = resolveSectionTools(
    resolvedLines,
    config,
    agentName,
  );

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";
  output += finalLines.join("\n") + "\n";
  output += "---\n";

  return output + processBody(body, config, agentName);
}

/**
 * Format a CC skill file from a parsed template.
 * CC skills may have additional fields (context, allowed-tools) from cc: section.
 */
function formatCCSkill(template, config) {
  const { rawFrontmatterLines, body } = template;

  const nameLine = extractRawFieldLine(rawFrontmatterLines, "name");
  const descLines = extractRawFieldLines(rawFrontmatterLines, "description");
  const ccSection = extractRawSection(rawFrontmatterLines, "cc");

  if (!nameLine) throw new Error("Missing required field: name");
  if (!descLines) throw new Error("Missing required field: description");

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";

  // Include CC-specific fields if present
  if (ccSection && ccSection.hasContent) {
    output += ccSection.lines.join("\n") + "\n";
  }

  output += "---\n";

  return output + processBody(body, config, undefined);
}

/**
 * Format a CC rule file from a parsed template.
 * - Global (no paths): no frontmatter at all
 * - Specific paths: paths: array frontmatter
 */
function formatCCInstruction(template, config) {
  const { rawFrontmatterLines, body } = template;

  const ccSection = extractRawSection(rawFrontmatterLines, "cc");

  const cleanedBody = processBody(body, config, undefined);

  // If cc section has real content (paths field), include frontmatter
  if (ccSection && ccSection.hasContent) {
    let output = "---\n";
    output += ccSection.lines.join("\n") + "\n";
    output += "---\n";
    return output + cleanedBody;
  }

  // Global rule — no frontmatter
  return cleanedBody;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a template file.
 * Returns array of error strings.
 */
function validateTemplate(content, category, filePath) {
  const errors = [];

  let parsed;
  try {
    parsed = parseTemplate(content);
  } catch (e) {
    return [`Parse error: ${e.message}`];
  }

  const { rawFrontmatterLines, body } = parsed;

  if (category === "agents" || category === "skills") {
    if (!extractRawFieldLine(rawFrontmatterLines, "name"))
      errors.push("Missing required field: name");
    if (!extractRawFieldLine(rawFrontmatterLines, "description"))
      errors.push("Missing required field: description");
  }

  if (category === "agents") {
    const cc = extractRawSection(rawFrontmatterLines, "cc");
    if (!cc || !cc.hasContent) {
      errors.push("Missing required field: cc section");
    }
  }

  // Typo guard, narrow enough never to touch host-injected {{VSCODE_*}}
  // variables: any {{MCP_*}} placeholder other than the exact literal
  // {{MCP_GUIDANCE}} is almost certainly a typo.
  const mcpPlaceholders = body.match(/\{\{MCP_[A-Z_]+\}\}/g) || [];
  for (const placeholder of mcpPlaceholders) {
    if (placeholder !== "{{MCP_GUIDANCE}}") {
      errors.push(
        `Unknown placeholder '${placeholder}' (only {{MCP_GUIDANCE}} is supported)`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Template Discovery
// ---------------------------------------------------------------------------

function discoverAgentTemplates(sourceDir) {
  const agentsDir = path.join(sourceDir, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".template.md"))
    .map((f) => path.join(agentsDir, f))
    .sort();
}

function discoverSkillTemplates(sourceDir) {
  const skillsDir = path.join(sourceDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const templates = [];
  for (const dir of fs.readdirSync(skillsDir).sort()) {
    const templatePath = path.join(skillsDir, dir, "SKILL.template.md");
    if (fs.existsSync(templatePath)) {
      templates.push(templatePath);
    }
  }
  return templates;
}

function discoverInstructionTemplates(sourceDir) {
  const instructionsDir = path.join(sourceDir, "instructions");
  if (!fs.existsSync(instructionsDir)) return [];

  return fs
    .readdirSync(instructionsDir)
    .filter((f) => f.endsWith(".template.md"))
    .map((f) => path.join(instructionsDir, f))
    .sort();
}

// ---------------------------------------------------------------------------
// Output Path Mapping
// ---------------------------------------------------------------------------

function getCCAgentPath(templateFile, outputDir) {
  const name = path.basename(templateFile).replace(".template.md", "");
  return path.join(outputDir, "claude", "agents", `${name}.md`);
}

function getCCSkillPath(templateFile, outputDir) {
  const skillDir = path.basename(path.dirname(templateFile));
  return path.join(outputDir, "claude", "skills", skillDir, "SKILL.md");
}

function getCCRulePath(templateFile, outputDir) {
  const name = path.basename(templateFile).replace(".template.md", "");
  return path.join(outputDir, "claude", "rules", `${name}.md`);
}

// ---------------------------------------------------------------------------
// Output Writing
// ---------------------------------------------------------------------------

/**
 * Write content to a file idempotently.
 * Returns 'created', 'updated', or 'unchanged'.
 */
function writeOutput(filePath, content, dryRun) {
  const fullPath = path.resolve(filePath);

  if (fs.existsSync(fullPath)) {
    const existing = fs.readFileSync(fullPath, "utf8");
    if (existing === content) return "unchanged";
    if (dryRun) return "updated";
    fs.writeFileSync(fullPath, content, "utf8");
    return "updated";
  }

  if (dryRun) return "created";

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(fullPath, content, "utf8");
  return "created";
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate CC output files.
 * Returns results object with arrays of file paths by status.
 */
function generate(sourceDir, config, outputDir, dryRun) {
  const results = { created: [], updated: [], unchanged: [], errors: [] };

  const agentTemplates = discoverAgentTemplates(sourceDir);
  const skillTemplates = discoverSkillTemplates(sourceDir);
  const instructionTemplates = discoverInstructionTemplates(sourceDir);

  // Validate all templates first
  const allTemplates = [
    ...agentTemplates.map((t) => ({ path: t, category: "agents" })),
    ...skillTemplates.map((t) => ({ path: t, category: "skills" })),
    ...instructionTemplates.map((t) => ({ path: t, category: "instructions" })),
  ];

  for (const { path: templatePath, category } of allTemplates) {
    const content = fs.readFileSync(templatePath, "utf8");
    const errors = validateTemplate(content, category, templatePath);
    if (errors.length > 0) {
      results.errors.push({ file: templatePath, errors });
    }
  }

  if (results.errors.length > 0) return results;

  // Generate agents
  for (const templatePath of agentTemplates) {
    try {
      const content = fs.readFileSync(templatePath, "utf8");
      const template = parseTemplate(content);

      const agentName = path.basename(templatePath).replace(".template.md", "");
      const output = formatCCAgent(template, config, agentName);
      const outputPath = getCCAgentPath(templatePath, outputDir);

      const status = writeOutput(outputPath, output, dryRun);
      results[status].push(outputPath);
    } catch (e) {
      results.errors.push({ file: templatePath, errors: [e.message] });
    }
  }

  // Generate skills
  for (const templatePath of skillTemplates) {
    try {
      const content = fs.readFileSync(templatePath, "utf8");
      const template = parseTemplate(content);

      const output = formatCCSkill(template, config);
      const outputPath = getCCSkillPath(templatePath, outputDir);

      const status = writeOutput(outputPath, output, dryRun);
      results[status].push(outputPath);
    } catch (e) {
      results.errors.push({ file: templatePath, errors: [e.message] });
    }
  }

  // Generate instructions/rules
  for (const templatePath of instructionTemplates) {
    try {
      const content = fs.readFileSync(templatePath, "utf8");
      const template = parseTemplate(content);

      const output = formatCCInstruction(template, config);
      const outputPath = getCCRulePath(templatePath, outputDir);

      const status = writeOutput(outputPath, output, dryRun);
      results[status].push(outputPath);
    } catch (e) {
      results.errors.push({ file: templatePath, errors: [e.message] });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);

  const options = {
    command: null,
    source: "templates/",
    config: null,
    outputDir: null,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "cc" || arg === "all") {
      options.command = arg;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--source" && args[i + 1]) {
      options.source = args[++i];
    } else if (arg.startsWith("--source=")) {
      options.source = arg.split("=")[1];
    } else if (arg === "--config" && args[i + 1]) {
      options.config = args[++i];
    } else if (arg.startsWith("--config=")) {
      options.config = arg.split("=")[1];
    } else if (arg === "--output-dir" && args[i + 1]) {
      options.outputDir = args[++i];
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.split("=")[1];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(
    `
Template generator for Claude Code

Usage:
  node scripts/generate.js <command> [options]

Commands:
  cc        Generate CC files (agents/, skills/, rules/)
  all       Generate CC files (same as cc for now)

Options:
  --config <path>      Config file (default: defaults/config.json)
  --output-dir <dir>   Output directory (default: generated/)
  --source <dir>       Template directory (default: templates/)
  --dry-run            Show what would change without writing files
  --help               Show this help

Exit codes:
  0   Files generated (or would be generated in dry-run)
  1   No changes needed
  2   Error
`.trim(),
  );
}

function printResults(results) {
  const agentPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => p.includes("/agents/"));
  const skillPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => p.includes("/skills/"));
  const otherPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => !p.includes("/agents/") && !p.includes("/skills/"));

  console.log(`\nGenerating CC files...`);

  for (const filePath of [
    ...results.created,
    ...results.updated,
    ...results.unchanged,
  ]) {
    let status;
    if (results.created.includes(filePath)) status = "(created)";
    else if (results.updated.includes(filePath)) status = "(updated)";
    else status = "(unchanged)";
    console.log(`  ${filePath} ✓ ${status}`);
  }

  const agentCount = agentPaths.length;
  const skillCount = skillPaths.length;
  const rulesCount = otherPaths.length;

  console.log(
    `Generated: ${agentCount} agents, ${skillCount} skills, ${rulesCount} rules`,
  );
}

function printDryRunResults(results) {
  console.log(`\nDry run - no CC files written`);

  if (results.created.length > 0) {
    console.log("\nWould create:");
    for (const f of results.created) console.log(`  ${f}`);
  }

  if (results.updated.length > 0) {
    console.log("\nWould update:");
    for (const f of results.updated) console.log(`  ${f}`);
  }

  if (results.unchanged.length > 0) {
    console.log("\nNo changes needed:");
    for (const f of results.unchanged) console.log(`  ${f}`);
  }
}

function main() {
  const options = parseArgs(process.argv);

  if (!options.command) {
    console.error("Error: Command required (cc or all)");
    console.error("Run with --help for usage information");
    process.exit(2);
  }

  const sourceDir = path.resolve(options.source);
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Source directory not found: ${sourceDir}`);
    process.exit(2);
  }

  // Default to repo's defaults/config.json
  const configPath = options.config
    ? path.resolve(options.config)
    : path.resolve(__dirname, "..", "defaults", "config.json");
  const config = readConfig(configPath);
  const outputDir = options.outputDir || "generated";

  const results = generate(sourceDir, config, outputDir, options.dryRun);

  let hasErrors = false;
  let totalChanged = 0;

  if (results.errors.length > 0) {
    hasErrors = true;
    console.error(`\nErrors:`);
    for (const { file, errors } of results.errors) {
      console.error(`  ${file}:`);
      for (const err of errors) {
        console.error(`    - ${err}`);
      }
    }
  } else {
    if (options.dryRun) {
      printDryRunResults(results);
    } else {
      printResults(results);
    }
    totalChanged += results.created.length + results.updated.length;
  }

  if (hasErrors) {
    process.exit(2);
  }

  if (options.dryRun && totalChanged > 0) {
    console.log(
      `\n⚠️  ${totalChanged} file(s) would be updated. Run 'make all' to regenerate.`,
    );
    process.exit(1);
  }
}

main();
