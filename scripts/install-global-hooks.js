#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MARKER_KEY = "_agents";
const MARKER_VALUE = "4.0";
const HOOK_TIMEOUT = 10;

const AGENTS_HOOKS = {
  SessionStart: [
    {
      matcher: "startup|resume|clear|fork",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-register.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  SessionEnd: [
    {
      matcher: "*",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-unregister.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  UserPromptSubmit: [
    {
      matcher: "*",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-touch.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
};

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function computeNewSettings(current) {
  const updated = deepClone(current);
  if (!updated.hooks) updated.hooks = {};
  for (const [event, entries] of Object.entries(AGENTS_HOOKS)) {
    if (!Array.isArray(updated.hooks[event])) updated.hooks[event] = [];
    for (const entry of entries) {
      const exists = updated.hooks[event].some(
        (e) => e.matcher === entry.matcher &&
          e.hooks &&
          e.hooks.some((h) => h.command && h.command.includes("session-"))
      );
      if (!exists) updated.hooks[event].push(deepClone(entry));
    }
  }
  updated[MARKER_KEY] = MARKER_VALUE;
  return updated;
}

function formatSettings(obj) {
  return JSON.stringify(obj, null, 2);
}

function diffLines(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const lines = [];
  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i] || "";
    const a = afterLines[i] || "";
    if (b === a) continue;
    if (b && a !== "") {
      lines.push(`- ${b}`);
      lines.push(`+ ${a}`);
    } else if (b) {
      lines.push(`- ${b}`);
    } else {
      lines.push(`+ ${a}`);
    }
  }
  return lines.join("\n");
}

function install(force) {
  const current = readSettings();
  const hasMarker = current[MARKER_KEY] === MARKER_VALUE;

  if (hasMarker && !force) {
    console.log("Global hooks already installed (marker _agents: 4.0 found).");
    return { skipped: true, alreadyInstalled: true };
  }

  const updated = computeNewSettings(current);
  const beforeStr = formatSettings(current);
  const afterStr = formatSettings(updated);
  const diff = diffLines(beforeStr, afterStr);

  if (!diff) {
    console.log("No changes needed — global hooks already present.");
    return { skipped: true, noChange: true };
  }

  console.log("The following changes will be made to ~/.claude/settings.json:\n");
  console.log(diff);
  console.log("");

  if (force) {
    writeSettings(updated, afterStr);
    console.log("Global hooks installed (--force).");
    return { installed: true };
  }

  return { needsConfirmation: true, updated, afterStr };
}

function writeSettings(updated, afterStr) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, afterStr + "\n", "utf8");
}

function manualInstructions() {
  console.log("\nTo add global hooks manually, add the following to ~/.claude/settings.json:\n");
  const sample = {
    _agents: "4.0",
    hooks: {
      SessionStart: AGENTS_HOOKS.SessionStart,
      SessionEnd: AGENTS_HOOKS.SessionEnd,
      UserPromptSubmit: AGENTS_HOOKS.UserPromptSubmit,
    },
  };
  console.log(JSON.stringify(sample, null, 2));
  console.log("\nThese hooks register every Claude Code session in the registry,");
  console.log("claim/release task leases, and extend leases on each prompt.");
}

module.exports = { install, writeSettings, manualInstructions, computeNewSettings, readSettings, SETTINGS_PATH, AGENTS_HOOKS, MARKER_KEY, MARKER_VALUE };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--manual")) {
    manualInstructions();
    process.exit(0);
  }
  const force = args.includes("--force");
  const result = install(force);
  if (result.needsConfirmation) {
    process.stdout.write("Write these changes to ~/.claude/settings.json? [y/N] ");
    let response = "";
    try { response = fs.readFileSync("/dev/stdin", "utf8").trim(); } catch {}
    if (response === "y" || response === "Y") {
      writeSettings(result.updated, result.afterStr);
      console.log("Global hooks installed.");
    } else {
      console.log("Skipped. Run with --force to install without prompting.");
      manualInstructions();
    }
  }
}
