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

  return {
    models: { ...userConfig.models },
    defaultTools: JSON.parse(JSON.stringify(userConfig.defaultTools || {})),
    agentTools: JSON.parse(JSON.stringify(userConfig.agentTools || {})),
  };
}

// Model-type registry: how each abstract type renders to a platform model string.
// - family:        display family name (e.g. "Claude Opus", "GPT")
// - versionSep:    string joining family and version (" " for Claude, "-" for GPT)
// - copilotSuffix: appended for Copilot output
// - platforms:     which platforms this type may be emitted to
const MODEL_TYPES = {
  opus:   { family: "Claude Opus",   versionSep: " ", copilotSuffix: " (copilot)", platforms: ["copilot", "cc"] },
  sonnet: { family: "Claude Sonnet", versionSep: " ", copilotSuffix: " (copilot)", platforms: ["copilot", "cc"] },
  haiku:  { family: "Claude Haiku",  versionSep: " ", copilotSuffix: " (copilot)", platforms: ["copilot", "cc"] },
  gpt:    { family: "GPT",           versionSep: "-", copilotSuffix: " (copilot)", platforms: ["copilot"] },
};

/**
 * Resolve model type to platform-specific string.
 * Input: "opus" or "sonnet" or ["opus", "sonnet"]
 * Copilot output: "Claude Opus 4.5 (copilot)" or array of strings
 * CC output: type name unchanged
 */
function resolveModels(modelSpec, config, platform) {
  const versions = config.models || {};

  const resolve = (type) => {
    // Already a full string (e.g., "Claude Opus 4.5 (copilot)"), pass through
    if (type.includes("Claude") || type.includes("(copilot)")) {
      return type;
    }
    const entry = MODEL_TYPES[type];
    const version = versions[type] || "4.5";
    if (platform === "copilot") {
      if (entry) {
        return `${entry.family}${entry.versionSep}${version}${entry.copilotSuffix}`;
      }
      // Unknown type: legacy Claude builder as safety net — must stay format-compatible
      // with the registry's Claude entries (e.g. "Claude Opus 4.6 (copilot)").
      const tierName = type.charAt(0).toUpperCase() + type.slice(1);
      return `Claude ${tierName} ${version} (copilot)`;
    }
    return type; // CC just uses the type name
  };

  if (Array.isArray(modelSpec)) {
    return modelSpec.map(resolve);
  }
  return resolve(modelSpec);
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

// ---------------------------------------------------------------------------
// Platform Formatters
// ---------------------------------------------------------------------------

/**
 * Resolve model tiers in section lines.
 * Transforms lines like 'model: opus' or 'model: ["opus", "sonnet"]'
 * into platform-specific model strings.
 * - Copilot: Always array format ["Claude Opus 4.5 (copilot)"]
 * - CC: Preserves original format (scalar or array)
 */
function resolveSectionModels(lines, config, platform) {
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
    const resolved = resolveModels(modelSpec, config, platform);

    // Format back based on platform
    const formatArray = (arr) =>
      `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
    if (platform === "copilot") {
      // Copilot always uses array format
      if (Array.isArray(resolved)) {
        return `${indent}model: ${formatArray(resolved)}`;
      }
      return `${indent}model: ${formatArray([resolved])}`;
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
 * Appends defaultTools and agentTools entries to the tools: array.
 */
function resolveSectionTools(lines, config, platform, agentName) {
  const platformKey = platform === "cc" ? "cc" : "copilot";
  const defaults = config.defaultTools[platformKey] || [];
  const agentSpecific = (config.agentTools[platformKey] || {})[agentName] || [];
  const extraTools = [...defaults, ...agentSpecific];

  // Warn on duplicates between defaultTools and agentTools
  const defaultSet = new Set(defaults);
  for (const tool of agentSpecific) {
    if (defaultSet.has(tool)) {
      console.warn(
        `Warning: Tool ${JSON.stringify(tool)} appears in both defaultTools and agentTools for ${platformKey}/${agentName}`,
      );
    }
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

  const filteredBody = parseBodyDirectives(body, "copilot");
  return output + cleanWhitespace(filteredBody);
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
  const resolvedLines = resolveSectionModels(ccSection.lines, config, "cc");

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

  const filteredBody = parseBodyDirectives(body, "cc");
  return output + cleanWhitespace(filteredBody);
}

/**
 * Format a Copilot skill file from a parsed template.
 * Copilot skills have only name and description in frontmatter.
 */
function formatCopilotSkill(template) {
  const { rawFrontmatterLines, body } = template;

  const nameLine = extractRawFieldLine(rawFrontmatterLines, "name");
  const descLines = extractRawFieldLines(rawFrontmatterLines, "description");

  if (!nameLine) throw new Error("Missing required field: name");
  if (!descLines) throw new Error("Missing required field: description");

  let output = "---\n";
  output += nameLine + "\n";
  output += descLines.join("\n") + "\n";
  output += "---\n";

  const filteredBody = parseBodyDirectives(body, "copilot");
  return output + cleanWhitespace(filteredBody);
}

/**
 * Format a CC skill file from a parsed template.
 * CC skills may have additional fields (context, allowed-tools) from cc: section.
 */
function formatCCSkill(template) {
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

  const filteredBody = parseBodyDirectives(body, "cc");
  return output + cleanWhitespace(filteredBody);
}

/**
 * Format a Copilot instruction file from a parsed template.
 * Output: applyTo frontmatter + body.
 */
function formatCopilotInstruction(template) {
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

  const filteredBody = parseBodyDirectives(body, "copilot");
  return output + cleanWhitespace(filteredBody);
}

/**
 * Format a CC rule file from a parsed template.
 * - Global (applyTo: "**"): no frontmatter at all
 * - Specific paths: paths: array frontmatter
 */
function formatCCInstruction(template) {
  const { rawFrontmatterLines, body } = template;

  const ccSection = extractRawSection(rawFrontmatterLines, "cc");

  const filteredBody = parseBodyDirectives(body, "cc");
  const cleanedBody = cleanWhitespace(filteredBody);

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
          ? formatCopilotSkill(template)
          : formatCCSkill(template);

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
          ? formatCopilotInstruction(template)
          : formatCCInstruction(template);

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
