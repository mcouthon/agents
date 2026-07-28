#!/usr/bin/env node
// Bidirectional template generator.
//
// Generates platform-specific output files from templates:
//   templates/agents/*.template.md          -> generated/copilot/agents/*.agent.md (Copilot)
//                                           -> generated/claude/agents/*.md (CC)
//   templates/skills/{name}/SKILL.template.md -> generated/copilot/skills/{name}/SKILL.md (Copilot)
//                                             -> generated/claude/skills/{name}/SKILL.md (CC)
//   templates/instructions/*.template.md    -> generated/copilot/instructions/*.instructions.md (Copilot)
//                                           -> generated/claude/rules/*.md (CC)
//
// Commands:
//   node scripts/generate.js copilot [--config defaults/config.json] [--output-dir generated/] [--source templates/] [--dry-run]
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
    const modelVersions = userConfig.models || {};
    for (const [name, spec] of Object.entries(userConfig.agents)) {
      const type = spec && spec.copilot;
      if (type && !knownTypes.includes(type)) {
        console.warn(
          `Warning: Unknown model type "${type}" for agent "${name}" in config (expected: ${knownTypes.join(", ")})`,
        );
      }
      if (type && knownTypes.includes(type) && !modelVersions[type]) {
        console.warn(
          `Warning: Model type "${type}" for agent "${name}" has no version entry in models config`,
        );
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
 * Resolve a value that may be a plain string/array (same on both platforms)
 * or a per-platform object ({ copilot: ..., cc: ... }). Returns undefined for
 * anything else. Shared by grant, toolNames and callingConvention.
 */
function resolvePlatformValue(value, platformKey) {
  if (typeof value === "string" || Array.isArray(value)) return value;
  if (value && typeof value === "object") return value[platformKey];
  return undefined;
}

// A field is a valid callingConvention shape if it's a string, or a
// per-platform map keyed only by known platform keys ("copilot"/"cc") with
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
      keys.every((k) => k === "copilot" || k === "cc") &&
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

// Shared shape for GPT-family Copilot SKU variants (e.g. gpt, gpt-terra,
// gpt-sol). Adding a future SKU is one line: "gpt-<name>": gptVariant(),
const gptVariant = () => ({
  family: "GPT",
  versionSep: "-",
  platforms: ["copilot"],
});

// Model-type registry: how each abstract type renders to a platform model string.
// - family:        display family name (e.g. "Claude Opus", "GPT")
// - versionSep:    string joining family and version (" " for Claude, "-" for GPT)
// - platforms:     which platforms this type may be emitted to
const MODEL_TYPES = {
  opus: {
    family: "Claude Opus",
    versionSep: " ",
    platforms: ["copilot", "cc"],
  },
  sonnet: {
    family: "Claude Sonnet",
    versionSep: " ",
    platforms: ["copilot", "cc"],
  },
  haiku: {
    family: "Claude Haiku",
    versionSep: " ",
    platforms: ["copilot", "cc"],
  },
  gpt: gptVariant(),
  "gpt-terra": gptVariant(),
  "gpt-sol": gptVariant(),
};

// Per-tier Copilot fallback lists (bare display names, best/cheap-first).
// VS Code treats a model array as a PRIORITIZED fallback list (first available
// wins) and exhausts it before any external default (picker / internal coding
// default). Listing ONLY same-tier models guarantees a resolution miss lands on
// an acceptable in-tier model. Hidden-but-existing entries are included as LATER
// fallbacks where the ENABLED depth of a tier is thin (they can only add safety):
//   - opus: 3 ENABLED -> enabled-only.
//   - sonnet: 1 ENABLED (Sonnet 5) -> + hidden Sonnet 4.6.
//   - haiku: 0 ENABLED (only hidden Haiku 4.5) -> + ENABLED cross-tier Sonnet 5.
// See .tasks/101-deterministic-model-selection/plan/phase-1-catalog-valid-pins.md.
const COPILOT_TIER_FALLBACKS = {
  opus: ["Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.6"],
  sonnet: ["Claude Sonnet 5", "Claude Sonnet 4.6"],
  haiku: ["Claude Haiku 4.5", "Claude Sonnet 5"],
};

/**
 * Resolve model type to platform-specific string.
 * Input: "opus" or "sonnet" or ["opus", "sonnet"]
 * Copilot output: "Claude Opus 4.5" or array of strings
 * CC output: type name unchanged
 */
function resolveModels(modelSpec, config, platform, agentName) {
  const versions = config.models || {};

  // Per-agent Copilot override: replace the template's declared type(s) with the
  // configured type. CC is Claude-only and never honors a non-Claude override.
  if (platform === "copilot" && agentName) {
    const override = ((config.agents || {})[agentName] || {}).copilot;
    if (override) {
      modelSpec = override; // array fields collapse to a single overridden type
    }
  }

  const resolve = (type) => {
    // Already a full string (e.g., "Claude Opus 4.5", or a legacy "... (copilot)"), pass through
    if (type.includes("Claude") || type.includes("(copilot)")) {
      return type;
    }
    const entry = MODEL_TYPES[type];
    const version = versions[type] || "4.5";
    if (platform === "copilot") {
      if (entry) {
        return `${entry.family}${entry.versionSep}${version}`;
      }
      // Unknown type: legacy Claude builder as safety net — must stay format-compatible
      // with the registry's Claude entries (e.g. "Claude Opus 4.6").
      const tierName = type.charAt(0).toUpperCase() + type.slice(1);
      return `Claude ${tierName} ${version}`;
    }
    return type; // CC just uses the type name
  };

  if (Array.isArray(modelSpec)) {
    return modelSpec.map(resolve);
  }
  return resolve(modelSpec);
}

// Resolve the primary tier NAME for a Copilot agent: apply the per-agent override,
// then take the first element if the template declares a (legacy cross-tier) array.
function copilotPrimaryTier(modelSpec, config, agentName) {
  let spec = ((config.agents || {})[agentName] || {}).copilot || modelSpec;
  if (Array.isArray(spec)) spec = spec[0];
  return spec;
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
 * Extract a known section (e.g., 'copilot' or 'cc') from raw frontmatter lines.
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
// Body Directive Parsing
// ---------------------------------------------------------------------------

const KNOWN_DIRECTIVES = new Set([
  "SHARED",
  "COPILOT-ONLY",
  "/COPILOT-ONLY",
  "CC-ONLY",
  "/CC-ONLY",
]);

/**
 * Parse body directives and filter content for the given platform.
 * Platform is 'copilot' or 'cc'.
 */
function parseBodyDirectives(body, platform) {
  const lines = body.split("\n");
  const output = [];

  let currentSection = "shared"; // Default: shared
  let openedBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^<!--\s*([\w/-]+)\s*-->$/);

    if (match) {
      const directive = match[1];

      if (!KNOWN_DIRECTIVES.has(directive)) {
        throw new Error(`Unknown directive '${directive}' at line ${i + 1}`);
      }

      if (directive === "COPILOT-ONLY" || directive === "CC-ONLY") {
        if (openedBlock) {
          throw new Error(
            `Nested directive '${directive}' inside '${openedBlock}' at line ${i + 1}`,
          );
        }
        openedBlock = directive;
        currentSection = directive === "COPILOT-ONLY" ? "copilot" : "cc";
      } else if (directive === "/COPILOT-ONLY" || directive === "/CC-ONLY") {
        const expectedOpen = directive.slice(1); // Remove leading /
        if (openedBlock !== expectedOpen) {
          throw new Error(`Orphan closing tag '${directive}' at line ${i + 1}`);
        }
        openedBlock = null;
        currentSection = "shared";
      } else if (directive === "SHARED") {
        if (openedBlock) {
          throw new Error(
            `SHARED directive inside '${openedBlock}' block at line ${i + 1}`,
          );
        }
        currentSection = "shared";
      }

      // Don't output the directive line itself
      continue;
    }

    // Include line based on section and target platform
    if (
      currentSection === "shared" ||
      (currentSection === "copilot" && platform === "copilot") ||
      (currentSection === "cc" && platform === "cc")
    ) {
      output.push(line);
    }
  }

  if (openedBlock) {
    throw new Error(`Unclosed '${openedBlock}' block`);
  }

  return output.join("\n");
}

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
 * Render one profile's guidance bullet for a given platform. The bullet is
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
function substituteMcpGuidance(body, config, platform, agentName) {
  const platformKey = platform === "cc" ? "cc" : "copilot";
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
 * Shared body pipeline: platform directive filtering, then MCP guidance
 * substitution, then whitespace normalisation. Substitution must run AFTER
 * directive filtering (so a placeholder inside a CC-ONLY block is correctly
 * absent on the Copilot path) and BEFORE whitespace cleanup (so the rendered
 * text gets the same normalisation as everything else). Used by all three
 * template categories (agents, skills, instructions) — the same pipeline
 * serves all of them, and scoping substitution to agents only would be an
 * arbitrary restriction.
 */
function processBody(body, platform, config, agentName) {
  const filtered = parseBodyDirectives(body, platform);
  const substituted = substituteMcpGuidance(
    filtered,
    config,
    platform,
    agentName,
  );
  return cleanWhitespace(substituted);
}

// ---------------------------------------------------------------------------
// Platform Formatters
// ---------------------------------------------------------------------------

/**
 * Resolve model tiers in section lines.
 * Transforms lines like 'model: opus' or 'model: ["opus", "sonnet"]'
 * into platform-specific model strings.
 * - Copilot: Always array format ["Claude Opus 4.5"]
 * - CC: Preserves original format (scalar or array)
 */
function resolveSectionModels(lines, config, platform, agentName) {
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

    const wasArray = Array.isArray(modelSpec);
    const resolved = resolveModels(modelSpec, config, platform, agentName);

    // Format back based on platform
    const formatArray = (arr) =>
      `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
    if (platform === "copilot") {
      // VS Code Copilot: emit a SAME-TIER fallback array (bare display names).
      // The configured version leads; the rest of the tier follows best-first,
      // deduped. Non-Claude tiers (gpt*) / full-string pins have no tier list and
      // emit a single-element array (preserving GPT-override behavior).
      const tier = copilotPrimaryTier(modelSpec, config, agentName);
      const fallbacks = COPILOT_TIER_FALLBACKS[tier];
      let arr;
      if (fallbacks) {
        const primary = resolveModels(tier, config, "copilot"); // display string, no re-override
        arr = [primary, ...fallbacks.filter((m) => m !== primary)];
      } else {
        arr = Array.isArray(resolved) ? [resolved[0]] : [resolved];
      }
      return `${indent}model: ${formatArray(arr)}`;
    } else {
      // CC preserves original format (scalar or array)
      if (wasArray) {
        return `${indent}model: ${formatArray(resolved)}`;
      }
      return `${indent}model: ${resolved}`;
    }
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
function resolveSectionTools(lines, config, platform, agentName) {
  const platformKey = platform === "cc" ? "cc" : "copilot";
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
 * Format a Copilot agent file from a parsed template.
 */
function formatCopilotAgent(template, config, agentName) {
  const { rawFrontmatterLines, body } = template;

  const nameLine = extractRawFieldLine(rawFrontmatterLines, "name");
  const descLines = extractRawFieldLines(rawFrontmatterLines, "description");
  const copilotSection = extractRawSection(rawFrontmatterLines, "copilot");

  if (!nameLine) throw new Error("Missing required field: name");
  if (!descLines) throw new Error("Missing required field: description");
  if (!copilotSection || !copilotSection.hasContent) {
    throw new Error("Missing required copilot: section");
  }

  // Resolve model tiers to platform-specific strings
  const resolvedLines = resolveSectionModels(
    copilotSection.lines,
    config,
    "copilot",
    agentName,
  );

  const finalLines = resolveSectionTools(
    resolvedLines,
    config,
    "copilot",
    agentName,
  );

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";
  output += finalLines.join("\n") + "\n";
  output += "---\n";

  return output + processBody(body, "copilot", config, agentName);
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
    "cc",
    agentName,
  );

  const finalLines = resolveSectionTools(
    resolvedLines,
    config,
    "cc",
    agentName,
  );

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";
  output += finalLines.join("\n") + "\n";
  output += "---\n";

  return output + processBody(body, "cc", config, agentName);
}

/**
 * Format a Copilot skill file from a parsed template.
 * Copilot skills have only name and description in frontmatter.
 */
function formatCopilotSkill(template, config) {
  const { rawFrontmatterLines, body } = template;

  const nameLine = extractRawFieldLine(rawFrontmatterLines, "name");
  const descLines = extractRawFieldLines(rawFrontmatterLines, "description");

  if (!nameLine) throw new Error("Missing required field: name");
  if (!descLines) throw new Error("Missing required field: description");

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";
  output += "---\n";

  return output + processBody(body, "copilot", config, undefined);
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

  return output + processBody(body, "cc", config, undefined);
}

/**
 * Format a Copilot instruction file from a parsed template.
 * Output: applyTo frontmatter + body.
 */
function formatCopilotInstruction(template, config) {
  const { rawFrontmatterLines, body } = template;

  const copilotSection = extractRawSection(rawFrontmatterLines, "copilot");

  // applyTo can be in copilot section or at top level
  let applyToLine = null;
  if (copilotSection && copilotSection.lines) {
    applyToLine = copilotSection.lines.find((l) =>
      l.trimStart().startsWith("applyTo:"),
    );
  }
  if (!applyToLine) {
    applyToLine = extractRawFieldLine(rawFrontmatterLines, "applyTo");
  }

  if (!applyToLine) {
    throw new Error("Missing required field: applyTo (or copilot.applyTo)");
  }

  let output = "---\n";
  output += applyToLine.trimStart() + "\n";
  output += "---\n";

  return output + processBody(body, "copilot", config, undefined);
}

/**
 * Format a CC rule file from a parsed template.
 * - Global (applyTo: "**"): no frontmatter at all
 * - Specific paths: paths: array frontmatter
 */
function formatCCInstruction(template, config) {
  const { rawFrontmatterLines, body } = template;

  const ccSection = extractRawSection(rawFrontmatterLines, "cc");

  const cleanedBody = processBody(body, "cc", config, undefined);

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
 * Validate directives in body content.
 * Returns array of error strings.
 */
function validateDirectives(body) {
  const errors = [];
  const lines = body.split("\n");
  let openBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^<!--\s*([\w/-]+)\s*-->$/);
    if (!match) continue;

    const directive = match[1];

    if (!KNOWN_DIRECTIVES.has(directive)) {
      errors.push(`Line ${i + 1}: Unknown directive '${directive}'`);
      continue;
    }

    if (
      (directive === "COPILOT-ONLY" || directive === "CC-ONLY") &&
      openBlock
    ) {
      errors.push(
        `Line ${i + 1}: Nested directive '${directive}' inside '${openBlock}'`,
      );
    }

    if (directive === "COPILOT-ONLY" || directive === "CC-ONLY") {
      openBlock = directive;
    } else if (directive.startsWith("/")) {
      const expected = directive.slice(1);
      if (openBlock !== expected) {
        errors.push(`Line ${i + 1}: Orphan closing tag '${directive}'`);
      }
      openBlock = null;
    } else if (directive === "SHARED" && openBlock) {
      errors.push(
        `Line ${i + 1}: SHARED directive inside '${openBlock}' block`,
      );
    }
  }

  if (openBlock) {
    errors.push(`Unclosed '${openBlock}' block`);
  }

  return errors;
}

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
    const copilot = extractRawSection(rawFrontmatterLines, "copilot");
    const cc = extractRawSection(rawFrontmatterLines, "cc");
    if (!copilot || !copilot.hasContent) {
      errors.push("Missing required field: copilot section");
    }
    if (!cc || !cc.hasContent) {
      errors.push("Missing required field: cc section");
    }
  }

  if (category === "instructions") {
    const copilotSection = extractRawSection(rawFrontmatterLines, "copilot");
    let applyToLine = null;
    if (copilotSection && copilotSection.lines) {
      applyToLine = copilotSection.lines.find((l) =>
        l.trimStart().startsWith("applyTo:"),
      );
    }
    if (!applyToLine) {
      applyToLine = extractRawFieldLine(rawFrontmatterLines, "applyTo");
    }
    if (!applyToLine) {
      errors.push("Missing required field: applyTo (or copilot.applyTo)");
    }
  }

  const directiveErrors = validateDirectives(body);
  errors.push(...directiveErrors);

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

function getCopilotAgentPath(templateFile, outputDir) {
  const name = path.basename(templateFile).replace(".template.md", "");
  return path.join(outputDir, "copilot", "agents", `${name}.agent.md`);
}

function getCCAgentPath(templateFile, outputDir) {
  const name = path.basename(templateFile).replace(".template.md", "");
  return path.join(outputDir, "claude", "agents", `${name}.md`);
}

function getCopilotSkillPath(templateFile, outputDir) {
  const skillDir = path.basename(path.dirname(templateFile));
  return path.join(outputDir, "copilot", "skills", skillDir, "SKILL.md");
}

function getCCSkillPath(templateFile, outputDir) {
  const skillDir = path.basename(path.dirname(templateFile));
  return path.join(outputDir, "claude", "skills", skillDir, "SKILL.md");
}

function getCopilotInstructionPath(templateFile, outputDir) {
  const name = path.basename(templateFile).replace(".template.md", "");
  return path.join(
    outputDir,
    "copilot",
    "instructions",
    `${name}.instructions.md`,
  );
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
 * Generate output files for a given platform ('copilot' or 'cc').
 * Returns results object with arrays of file paths by status.
 */
function generatePlatform(platform, sourceDir, config, outputDir, dryRun) {
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
      const output =
        platform === "copilot"
          ? formatCopilotAgent(template, config, agentName)
          : formatCCAgent(template, config, agentName);

      const outputPath =
        platform === "copilot"
          ? getCopilotAgentPath(templatePath, outputDir)
          : getCCAgentPath(templatePath, outputDir);

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

      const output =
        platform === "copilot"
          ? formatCopilotSkill(template, config)
          : formatCCSkill(template, config);

      const outputPath =
        platform === "copilot"
          ? getCopilotSkillPath(templatePath, outputDir)
          : getCCSkillPath(templatePath, outputDir);

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

      const output =
        platform === "copilot"
          ? formatCopilotInstruction(template, config)
          : formatCCInstruction(template, config);

      const outputPath =
        platform === "copilot"
          ? getCopilotInstructionPath(templatePath, outputDir)
          : getCCRulePath(templatePath, outputDir);

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
    if (arg === "copilot" || arg === "cc" || arg === "all") {
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
Bidirectional template generator

Usage:
  node scripts/generate.js <command> [options]

Commands:
  copilot   Generate Copilot files (agents/, skills/, instructions/)
  cc        Generate CC files (agents/, skills/, rules/)
  all       Generate both Copilot and CC files

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

function printResults(platform, results) {
  const agentPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => p.includes("/agents/"));
  const skillPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => p.includes("/skills/"));
  const otherPaths = results.created
    .concat(results.updated, results.unchanged)
    .filter((p) => !p.includes("/agents/") && !p.includes("/skills/"));

  const label = platform === "copilot" ? "Copilot" : "CC";
  console.log(`\nGenerating ${label} files...`);

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

  if (platform === "copilot") {
    console.log(
      `Generated: ${agentCount} agents, ${skillCount} skills, ${rulesCount} instructions`,
    );
  } else {
    console.log(
      `Generated: ${agentCount} agents, ${skillCount} skills, ${rulesCount} rules`,
    );
  }
}

function printDryRunResults(platform, results) {
  const label = platform === "copilot" ? "Copilot" : "CC";
  console.log(`\nDry run - no ${label} files written`);

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
    console.error("Error: Command required (copilot, cc, or all)");
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

  const platforms =
    options.command === "all" ? ["copilot", "cc"] : [options.command];
  const allResults = {};
  let hasErrors = false;
  let totalChanged = 0;

  for (const platform of platforms) {
    const results = generatePlatform(
      platform,
      sourceDir,
      config,
      outputDir,
      options.dryRun,
    );
    allResults[platform] = results;

    if (results.errors.length > 0) {
      hasErrors = true;
      console.error(`\nErrors for ${platform}:`);
      for (const { file, errors } of results.errors) {
        console.error(`  ${file}:`);
        for (const err of errors) {
          console.error(`    - ${err}`);
        }
      }
    } else {
      if (options.dryRun) {
        printDryRunResults(platform, results);
      } else {
        printResults(platform, results);
      }
      totalChanged += results.created.length + results.updated.length;
    }
  }

  if (hasErrors) {
    process.exit(2);
  }

  if (platforms.length > 1 && !options.dryRun) {
    const copilot = allResults.copilot || {
      created: [],
      updated: [],
      unchanged: [],
    };
    const cc = allResults.cc || { created: [], updated: [], unchanged: [] };
    const copilotTotal =
      copilot.created.length +
      copilot.updated.length +
      copilot.unchanged.length;
    const ccTotal = cc.created.length + cc.updated.length + cc.unchanged.length;
    const totalUpdated =
      copilot.created.length +
      copilot.updated.length +
      cc.created.length +
      cc.updated.length;
    const totalUnchanged = copilot.unchanged.length + cc.unchanged.length;
    console.log(
      `\nSummary: ${copilotTotal} Copilot files, ${ccTotal} CC files generated (${totalUpdated} updated, ${totalUnchanged} unchanged)`,
    );
  }

  if (options.dryRun && totalChanged > 0) {
    console.log(
      `\n⚠️  ${totalChanged} file(s) would be updated. Run 'make all' to regenerate.`,
    );
    process.exit(1);
  }
}

main();
