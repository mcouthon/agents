#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const installer = require("./install-global-hooks");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// Test 1: computeNewSettings adds hooks to empty settings
{
  const result = installer.computeNewSettings({});
  if (result.hooks && result.hooks.SessionStart) ok("computeNewSettings adds SessionStart hooks");
  else fail_("computeNewSettings should add SessionStart hooks");
  if (result.hooks && result.hooks.SessionEnd) ok("computeNewSettings adds SessionEnd hooks");
  else fail_("computeNewSettings should add SessionEnd hooks");
  if (result.hooks && result.hooks.UserPromptSubmit) ok("computeNewSettings adds UserPromptSubmit hooks");
  else fail_("computeNewSettings should add UserPromptSubmit hooks");
  if (result[installer.MARKER_KEY] === installer.MARKER_VALUE) ok("computeNewSettings sets marker key");
  else fail_("computeNewSettings should set marker key");
}

// Test 2: SessionStart matcher is startup|resume|clear|fork
{
  const result = installer.computeNewSettings({});
  const ss = result.hooks.SessionStart[0];
  if (ss.matcher === "startup|resume|clear|fork") ok("SessionStart matcher is startup|resume|clear|fork");
  else fail_("SessionStart matcher should be startup|resume|clear|fork, got: " + ss.matcher);
}

// Test 3: hooks point to session-*.sh scripts
{
  const result = installer.computeNewSettings({});
  const ssCmd = result.hooks.SessionStart[0].hooks[0].command;
  if (ssCmd.includes("session-register.sh")) ok("SessionStart hook calls session-register.sh");
  else fail_("SessionStart hook should call session-register.sh");
  const seCmd = result.hooks.SessionEnd[0].hooks[0].command;
  if (seCmd.includes("session-unregister.sh")) ok("SessionEnd hook calls session-unregister.sh");
  else fail_("SessionEnd hook should call session-unregister.sh");
  const upsCmd = result.hooks.UserPromptSubmit[0].hooks[0].command;
  if (upsCmd.includes("session-touch.sh")) ok("UserPromptSubmit hook calls session-touch.sh");
  else fail_("UserPromptSubmit hook should call session-touch.sh");
}

// Test 4: existing hooks are preserved
{
  const existing = {
    hooks: {
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ type: "command", command: "$HOME/.claude/hooks/workspace-init.sh", timeout: 180 }] },
      ],
    },
    someOtherKey: true,
  };
  const result = installer.computeNewSettings(existing);
  const ss = result.hooks.SessionStart;
  if (ss.length === 2) ok("existing SessionStart hooks preserved alongside new hooks");
  else fail_("existing hooks should be preserved, got " + ss.length + " entries");
  if (ss[0].hooks[0].command.includes("workspace-init.sh")) ok("existing workspace-init hook preserved");
  else fail_("existing workspace-init hook should be preserved");
  if (result.someOtherKey === true) ok("other settings keys preserved");
  else fail_("other settings keys should be preserved");
}

// Test 5: marker value is 4.0
{
  if (installer.MARKER_KEY === "_agents") ok("marker key is _agents");
  else fail_("marker key should be _agents");
  if (installer.MARKER_VALUE === "4.0") ok("marker value is 4.0");
  else fail_("marker value should be 4.0");
}

// Test 6: AGENTS_HOOKS shape matches ADR-018 hook contract
{
  const hooks = installer.AGENTS_HOOKS;
  if (hooks.SessionStart[0].hooks[0].timeout === 10) ok("SessionStart hook has timeout");
  else fail_("SessionStart hook should have timeout");
  if (hooks.SessionEnd[0].matcher === "*") ok("SessionEnd matcher is *");
  else fail_("SessionEnd matcher should be *");
  if (hooks.UserPromptSubmit[0].matcher === "*") ok("UserPromptSubmit matcher is *");
  else fail_("UserPromptSubmit matcher should be *");
}

// Test 7: re-running computeNewSettings is idempotent (no duplicate hooks)
{
  const first = installer.computeNewSettings({});
  const second = installer.computeNewSettings(first);
  if (second.hooks.SessionStart.length === 1) ok("re-running computeNewSettings does not duplicate hooks");
  else fail_("re-running should not duplicate hooks, got " + second.hooks.SessionStart.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
