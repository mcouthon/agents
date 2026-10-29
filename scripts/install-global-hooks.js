#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_TIMEOUT = 10;

// Where install()/writeSettings() read and write; --home repoints it.
let settingsPath = SETTINGS_PATH;

function setHome(home) {
  settingsPath = path.join(home, ".claude", "settings.json");
}

const cmd = (script) => ({ type: "command", command: `$HOME/.claude/hooks/${script}.sh`, timeout: HOOK_TIMEOUT });

// The two hooks AGENTS registers: one entry each.
const AGENTS_HOOKS = {
  SessionStart: [{ matcher: "startup|resume|clear|fork", hooks: [cmd("session-register")] }],
  SessionEnd: [{ hooks: [cmd("session-end")] }],
};

// Names of earlier stubs, no longer shipped: `install --hooks` removes their
// settings entries, and install.sh moves installed copies to the trash.
const RETIRED_SCRIPTS = [
  "conductor-stop", "courier-stop", "git-guard", "machine-owned-guard", "manifest-guard",
  "plan-lint", "quality-gate", "session-touch", "spawn-guard", "workspace-init",
  "worktree-create", "worktree-remove", "write-guard", "report-parser", "session-unregister",
  "prime", "report-capture", "checkpoint-capture",
];
const RETIRED_FILES = [...RETIRED_SCRIPTS.map((n) => `${n}.sh`), "workspace-init-helper.js"];

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function entryScript(entry) {
  return entry.hooks[0].command.split("/").pop();
}

const OURS = new Set([
  ...Object.values(AGENTS_HOOKS).flat().map(entryScript),
  ...RETIRED_SCRIPTS.map((n) => `${n}.sh`),
]);

// A command is ours when it ends with /.claude/hooks/<one of our scripts>.
function oursScript(command) {
  if (typeof command !== "string") return null;
  const m = command.match(/\/\.claude\/hooks\/([^/]+\.sh)$/);
  return m && OURS.has(m[1]) ? m[1] : null;
}

const wantedKey = (event, script) => `${event}\0${script}`;
const WANTED = new Set(
  Object.entries(AGENTS_HOOKS).flatMap(([event, entries]) => entries.map((e) => wantedKey(event, entryScript(e)))),
);

function isStale(event, h) {
  const script = oursScript(h && h.command);
  return script !== null && !WANTED.has(wantedKey(event, script));
}

function isPresent(event, script, settings) {
  const entries = (settings.hooks && settings.hooks[event]) || [];
  return entries.some((e) => Array.isArray(e.hooks) && e.hooks.some((h) => oursScript(h.command) === script));
}

const ADDITIONAL_DIRS = ["~/.agents/tasks"];

function isAdditionalDirPresent(settings) {
  const dirs = (settings.permissions && settings.permissions.additionalDirectories) || [];
  return ADDITIONAL_DIRS.every((d) => dirs.includes(d));
}

function removeStale(updated) {
  for (const event of Object.keys(updated.hooks)) {
    const entries = updated.hooks[event];
    if (!Array.isArray(entries)) continue;
    let touched = false;
    const kept = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
      const hooks = entry.hooks.filter((h) => !isStale(event, h));
      if (hooks.length === entry.hooks.length) { kept.push(entry); continue; }
      touched = true;
      if (hooks.length > 0) kept.push({ ...entry, hooks });
    }
    if (!touched) continue;
    if (kept.length > 0) updated.hooks[event] = kept;
    else delete updated.hooks[event];
  }
}

function computeNewSettings(current) {
  const updated = deepClone(current);
  delete updated._agents;
  if (!updated.hooks) updated.hooks = {};
  removeStale(updated);
  for (const [event, entries] of Object.entries(AGENTS_HOOKS)) {
    for (const entry of entries) {
      const script = entryScript(entry);
      if (!isPresent(event, script, updated)) {
        if (!Array.isArray(updated.hooks[event])) updated.hooks[event] = [];
        updated.hooks[event].push(deepClone(entry));
      }
    }
  }
  // D25: add ~/.agents/tasks to additionalDirectories so sessions can read/write
  // the central tasks root. Matched by value for idempotency.
  if (!isAdditionalDirPresent(updated)) {
    if (!updated.permissions) updated.permissions = {};
    if (!Array.isArray(updated.permissions.additionalDirectories)) {
      updated.permissions.additionalDirectories = [];
    }
    for (const d of ADDITIONAL_DIRS) {
      if (!updated.permissions.additionalDirectories.includes(d)) {
        updated.permissions.additionalDirectories.push(d);
      }
    }
  }
  return updated;
}

function formatSettings(obj) {
  return JSON.stringify(obj, null, 2);
}

function semanticDiff(current) {
  const lines = [];
  let adding = 0;
  let removing = 0;
  for (const [event, entries] of Object.entries(current.hooks || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of (entry && entry.hooks) || []) {
        if (!isStale(event, h)) continue;
        removing++;
        lines.push(`${event}: -1 entry (${oursScript(h.command)}) — removing`);
      }
    }
  }
  for (const [event, entries] of Object.entries(AGENTS_HOOKS)) {
    for (const entry of entries) {
      const script = entryScript(entry);
      if (isPresent(event, script, current)) {
        lines.push(`${event}: +1 entry (${script}) — already present`);
      } else {
        adding++;
        lines.push(`${event}: +1 entry (${script}) — adding`);
      }
    }
  }
  if (isAdditionalDirPresent(current)) {
    lines.push("permissions.additionalDirectories: ~/.agents/tasks — already present");
  } else {
    adding++;
    lines.push("permissions.additionalDirectories: +~/.agents/tasks — adding");
  }
  return { lines, adding, removing };
}

function install(force) {
  const current = readSettings();
  const diff = semanticDiff(current);
  const hasStaleAgents = current._agents !== undefined;

  if (diff.adding === 0 && diff.removing === 0 && !hasStaleAgents) {
    console.log("No changes needed — global hooks already present.");
    return { skipped: true, noChange: true };
  }

  console.log("The following changes will be made to ~/.claude/settings.json:\n");
  for (const line of diff.lines) console.log(line);
  if (hasStaleAgents) console.log("_agents: remove stale key");
  console.log("");

  const updated = computeNewSettings(current);
  const afterStr = formatSettings(updated);

  if (force) {
    writeSettings(updated, afterStr);
    console.log("Global hooks installed (--force).");
    return { installed: true };
  }

  return { needsConfirmation: true, updated, afterStr };
}

function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `${file}.agents-backup-${stamp}`;
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    if (!fs.existsSync(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function writeSettings(updated, afterStr) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(settingsPath)) {
    const backup = backupPath(settingsPath);
    fs.copyFileSync(settingsPath, backup);
    console.log(`Backup: ${backup}`);
  }
  fs.writeFileSync(settingsPath, afterStr + "\n", "utf8");
}

function manualInstructions() {
  console.log("\nTo add global hooks manually, add the following to ~/.claude/settings.json:\n");
  console.log(JSON.stringify({ hooks: AGENTS_HOOKS }, null, 2));
  console.log("\nThese hooks register each session, inject the next step on every prompt,");
  console.log("record sub-agent reports and checkpoint answers, and never block a tool call.");
}

module.exports = { install, writeSettings, manualInstructions, computeNewSettings, readSettings, setHome, SETTINGS_PATH, AGENTS_HOOKS, RETIRED_SCRIPTS, RETIRED_FILES, semanticDiff, isAdditionalDirPresent, ADDITIONAL_DIRS };

function promptConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

if (require.main === module) {
  const run = async () => {
    const args = process.argv.slice(2);
    const homeIdx = args.indexOf("--home");
    if (homeIdx >= 0) {
      if (!args[homeIdx + 1]) throw new Error("--home needs a directory");
      setHome(args[homeIdx + 1]);
    }
    if (args.includes("--manual")) {
      manualInstructions();
      return;
    }
    const force = args.includes("--force");
    const result = install(force);
    if (result.needsConfirmation) {
      const response = await promptConfirm("Write these changes to ~/.claude/settings.json? [y/N] ");
      if (response === "y" || response === "Y") {
        writeSettings(result.updated, result.afterStr);
        console.log("Global hooks installed.");
      } else {
        console.log("Skipped. Run with --force to install without prompting.");
        manualInstructions();
      }
    }
  };
  // Explicit exit: readline leaves the stdin handle open, which would keep the
  // process alive after the prompt is answered (on a TTY or an open pipe).
  // This is a one-shot CLI, so exit as soon as the work is done.
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
