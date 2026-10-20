#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_TIMEOUT = 10;

const AGENTS_HOOKS = {
  SessionStart: [
    {
      matcher: "startup|resume|clear|fork",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-register.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "startup|resume|clear|fork",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/prime.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  SessionEnd: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-unregister.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-touch.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/prime.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  PreToolUse: [
    {
      matcher: "Agent|Task",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/spawn-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/git-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/write-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/machine-owned-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/machine-owned-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/manifest-guard.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/checkpoint-capture.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  PostToolUse: [
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/quality-gate.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "Write",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/plan-lint.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/checkpoint-capture.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  SubagentStop: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/report-parser.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  Stop: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/quality-gate.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/conductor-stop.sh", timeout: HOOK_TIMEOUT }],
    },
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/courier-stop.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  WorktreeCreate: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/worktree-create.sh", timeout: HOOK_TIMEOUT }],
    },
  ],
  WorktreeRemove: [
    {
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/worktree-remove.sh", timeout: HOOK_TIMEOUT }],
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

function entryScript(entry) {
  return entry.hooks[0].command.split("/").pop();
}

function isPresent(event, script, settings) {
  const entries = (settings.hooks && settings.hooks[event]) || [];
  return entries.some(
    (e) => e.hooks && e.hooks.some((h) => h.command && h.command.includes(script))
  );
}

const ADDITIONAL_DIRS = ["~/.agents/tasks"];

function isAdditionalDirPresent(settings) {
  const dirs = (settings.permissions && settings.permissions.additionalDirectories) || [];
  return ADDITIONAL_DIRS.every((d) => dirs.includes(d));
}

function computeNewSettings(current) {
  const updated = deepClone(current);
  delete updated._agents;
  if (!updated.hooks) updated.hooks = {};
  for (const [event, entries] of Object.entries(AGENTS_HOOKS)) {
    if (!Array.isArray(updated.hooks[event])) updated.hooks[event] = [];
    for (const entry of entries) {
      const script = entryScript(entry);
      if (!isPresent(event, script, updated)) {
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
  return { lines, adding };
}

function install(force) {
  const current = readSettings();
  const diff = semanticDiff(current);
  const hasStaleAgents = current._agents !== undefined;

  if (diff.adding === 0 && !hasStaleAgents) {
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

function writeSettings(updated, afterStr) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, afterStr + "\n", "utf8");
}

function manualInstructions() {
  console.log("\nTo add global hooks manually, add the following to ~/.claude/settings.json:\n");
  const sample = {
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

module.exports = { install, writeSettings, manualInstructions, computeNewSettings, readSettings, SETTINGS_PATH, AGENTS_HOOKS, semanticDiff };

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
