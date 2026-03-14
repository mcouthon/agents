#!/usr/bin/env node
/**
 * Configure VS Code settings.json for agent/instruction file locations.
 *
 * Usage:
 *   node scripts/configure-vscode-settings.js [settings.json path]
 *
 * Features:
 * - Adds missing settings, corrects wrong values
 * - Preserves comments and formatting
 * - Idempotent (safe to run multiple times)
 * - Creates backup before modifying
 *
 * Exit codes:
 *   0 - Settings updated
 *   1 - Already configured (no changes needed)
 *   2 - Error
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Settings to configure
const SETTINGS = [
  // Object-type settings (add entry to existing object)
  {
    type: "object",
    key: "chat.agentSkillsLocations",
    entry: "~/.copilot/skills",
    value: "true",
  },
  {
    type: "object",
    key: "chat.agentSkillsLocations",
    entry: "~/.claude/skills",
    value: "false",
  },
  {
    type: "object",
    key: "chat.agentFilesLocations",
    entry: "~/.copilot/agents",
    value: "true",
  },
  {
    type: "object",
    key: "chat.agentFilesLocations",
    entry: "~/.claude/agents",
    value: "false",
  },
  {
    type: "object",
    key: "chat.instructionsFilesLocations",
    entry: "~/.copilot/instructions",
    value: "true",
  },
  {
    type: "object",
    key: "chat.instructionsFilesLocations",
    entry: "~/.claude/rules",
    value: "false",
  },
  // Boolean settings
  { type: "boolean", key: "chat.customAgentInSubagent.enabled", value: true },
  {
    type: "boolean",
    key: "chat.experimental.useSkillAdherencePrompt",
    value: true,
  },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add or update an entry in a settings object in JSONC content.
 * Uses string manipulation to preserve comments and formatting.
 */
function addToSetting(content, settingKey, entryKey, entryValue) {
  // Check if entry exists
  if (content.includes(`"${entryKey}"`)) {
    // Check if value is correct
    const re = new RegExp(`("${escapeRegex(entryKey)}"\\s*:\\s*)(true|false)`);
    const match = content.match(re);
    if (match && match[2] !== entryValue) {
      return {
        content: content.replace(re, `$1${entryValue}`),
        changed: true,
        corrected: true,
        oldValue: match[2],
      };
    }
    return { content, changed: false };
  }

  // Setting exists? Insert into it
  const keyPattern = `"${settingKey}"`;
  const keyIndex = content.indexOf(keyPattern);

  if (keyIndex !== -1) {
    // Find the opening { after the key
    const colonIndex = content.indexOf(":", keyIndex);
    if (colonIndex === -1) {
      return { content, changed: false, error: `No colon after ${settingKey}` };
    }

    const braceIndex = content.indexOf("{", colonIndex);
    if (braceIndex === -1) {
      return { content, changed: false, error: `No { after ${settingKey}` };
    }

    // Check if the object is empty (next non-whitespace is })
    const afterBrace = content.slice(braceIndex + 1);
    const isEmpty = /^\s*}/.test(afterBrace);

    // Insert after the opening { (no trailing comma if empty)
    const insert = isEmpty
      ? `\n    "${entryKey}": ${entryValue}\n  `
      : `\n    "${entryKey}": ${entryValue},`;
    const newContent =
      content.slice(0, braceIndex + 1) + insert + content.slice(braceIndex + 1);
    return { content: newContent, changed: true };
  }

  // Setting doesn't exist - add before final }
  const lastBrace = content.lastIndexOf("}");
  if (lastBrace === -1) {
    return { content, changed: false, error: "No closing } found" };
  }

  const before = content.slice(0, lastBrace).trimEnd();

  // Check if we need a comma (ends with a value, not { or ,)
  const needsComma = /[}\]"'\d]$|true$|false$|null$/.test(before);

  const insert =
    (needsComma ? "," : "") +
    `\n  "${settingKey}": {\n    "${entryKey}": ${entryValue}\n  }`;

  const newContent = before + insert + "\n}";
  return { content: newContent, changed: true };
}

/**
 * Add or update a top-level boolean setting in JSONC content.
 */
function addBooleanSetting(content, settingKey, value) {
  // Check if setting exists
  if (content.includes(`"${settingKey}"`)) {
    // Check if value is correct
    const re = new RegExp(
      `("${escapeRegex(settingKey)}"\\s*:\\s*)(true|false)`,
    );
    const match = content.match(re);
    if (match && match[2] !== String(value)) {
      return {
        content: content.replace(re, `$1${value}`),
        changed: true,
        corrected: true,
        oldValue: match[2],
      };
    }
    return { content, changed: false };
  }

  // Add before final }
  const lastBrace = content.lastIndexOf("}");
  if (lastBrace === -1) {
    return { content, changed: false, error: "No closing } found" };
  }

  const before = content.slice(0, lastBrace).trimEnd();
  const needsComma = /[}\]"'\d]$|true$|false$|null$/.test(before);
  const insert = (needsComma ? "," : "") + `\n  "${settingKey}": ${value}`;

  return { content: before + insert + "\n}", changed: true };
}

function main() {
  // Get settings file path
  const defaultPath = path.join(
    os.homedir(),
    "Library/Application Support/Code/User/settings.json",
  );
  const settingsPath = process.argv[2] || defaultPath;

  // Check if file exists
  if (!fs.existsSync(settingsPath)) {
    console.error(`Settings file not found: ${settingsPath}`);
    process.exit(2);
  }

  // Read current content
  let content;
  try {
    content = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    console.error(`Failed to read settings: ${err.message}`);
    process.exit(2);
  }

  // Validate file has JSON/JSONC structure
  if (!content.includes("{") || !content.includes("}")) {
    console.error(
      `Settings file is not valid JSON/JSONC (missing {} structure): ${settingsPath}`,
    );
    process.exit(2);
  }

  // Apply each setting
  let anyChanged = false;
  for (const setting of SETTINGS) {
    let result;
    if (setting.type === "boolean") {
      result = addBooleanSetting(content, setting.key, setting.value);
      if (result.corrected) {
        console.log(
          `Corrected: ${setting.key} = ${setting.value} (was: ${result.oldValue})`,
        );
      } else if (result.changed) {
        console.log(`Added: ${setting.key} = ${setting.value}`);
      } else {
        console.log(`OK: ${setting.key}`);
      }
    } else {
      result = addToSetting(content, setting.key, setting.entry, setting.value);
      if (result.corrected) {
        console.log(
          `Corrected: ${setting.key} → ${setting.entry} (was: ${result.oldValue})`,
        );
      } else if (result.changed) {
        console.log(`Added: ${setting.key} → ${setting.entry}`);
      } else {
        console.log(`OK: ${setting.entry}`);
      }
    }
    if (result.error) {
      console.error(`Warning: ${result.error}`);
    }
    if (result.changed) {
      content = result.content;
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    console.log("No changes needed.");
    process.exit(1);
  }

  // Create backup
  const backupPath = settingsPath + ".backup";
  try {
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  } catch (err) {
    console.error(`Warning: Failed to create backup: ${err.message}`);
  }

  // Write updated content
  try {
    fs.writeFileSync(settingsPath, content);
    console.log("Settings updated successfully.");
    process.exit(0);
  } catch (err) {
    console.error(`Failed to write settings: ${err.message}`);
    process.exit(2);
  }
}

main();
