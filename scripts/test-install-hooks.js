#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const installer = require("./install-global-hooks");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Test 1: computeNewSettings adds hooks to empty settings, no _agents key
{
  const result = installer.computeNewSettings({});
  if (result.hooks && result.hooks.SessionStart) ok("computeNewSettings adds SessionStart hooks");
  else fail_("computeNewSettings should add SessionStart hooks");
  if (result.hooks && result.hooks.SessionEnd) ok("computeNewSettings adds SessionEnd hooks");
  else fail_("computeNewSettings should add SessionEnd hooks");
  if (result.hooks && result.hooks.UserPromptSubmit) ok("computeNewSettings adds UserPromptSubmit hooks");
  else fail_("computeNewSettings should add UserPromptSubmit hooks");
  if (!("_agents" in result)) ok("computeNewSettings does not set _agents key");
  else fail_("computeNewSettings should not set _agents key");
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

// Test 5: no _agents key is ever present in computeNewSettings output
{
  const result = installer.computeNewSettings({});
  if (!("_agents" in result)) ok("no _agents key in output from empty settings");
  else fail_("output should not contain _agents key");
  const withMarker = installer.computeNewSettings({ _agents: "4.0" });
  if (!("_agents" in withMarker)) ok("computeNewSettings drops pre-existing _agents key");
  else fail_("computeNewSettings should drop pre-existing _agents key");
}

// Test 6: SessionEnd and UserPromptSubmit have no matcher (default is *)
{
  const hooks = installer.AGENTS_HOOKS;
  if (hooks.SessionStart[0].matcher === "startup|resume|clear|fork") ok("SessionStart keeps non-default matcher");
  else fail_("SessionStart should keep matcher startup|resume|clear|fork");
  if (hooks.SessionEnd[0].matcher === undefined) ok("SessionEnd has no matcher");
  else fail_("SessionEnd should have no matcher, got: " + hooks.SessionEnd[0].matcher);
  if (hooks.UserPromptSubmit[0].matcher === undefined) ok("UserPromptSubmit has no matcher");
  else fail_("UserPromptSubmit should have no matcher, got: " + hooks.UserPromptSubmit[0].matcher);
  if (hooks.SessionStart[0].hooks[0].timeout === 10) ok("SessionStart hook has timeout");
  else fail_("SessionStart hook should have timeout");
}

// Test 7: re-running computeNewSettings is idempotent (no duplicate hooks, no _agents key)
{
  const first = installer.computeNewSettings({});
  const second = installer.computeNewSettings(first);
  if (second.hooks.SessionStart.length === 1) ok("re-running computeNewSettings does not duplicate SessionStart hooks");
  else fail_("re-running should not duplicate SessionStart hooks, got " + second.hooks.SessionStart.length);
  if (second.hooks.SessionEnd.length === 1) ok("re-running computeNewSettings does not duplicate SessionEnd hooks");
  else fail_("re-running should not duplicate SessionEnd hooks, got " + second.hooks.SessionEnd.length);
  if (second.hooks.UserPromptSubmit.length === 1) ok("re-running computeNewSettings does not duplicate UserPromptSubmit hooks");
  else fail_("re-running should not duplicate UserPromptSubmit hooks, got " + second.hooks.UserPromptSubmit.length);
  if (deepEqual(first, second)) ok("computeNewSettings twice produces identical output");
  else fail_("computeNewSettings twice should produce identical output");
  if (!("_agents" in second)) ok("no _agents key after double computeNewSettings");
  else fail_("no _agents key should exist after double computeNewSettings");
}

// Test 8: semantic diff lists only AGENTS hook entries — all adding on empty settings
{
  const diff = installer.semanticDiff({});
  if (diff.lines.length === 3) ok("semantic diff produces exactly 3 lines for 3 AGENTS hooks");
  else fail_("semantic diff should produce 3 lines, got " + diff.lines.length);
  if (diff.adding === 3) ok("semantic diff reports 3 entries adding on empty settings");
  else fail_("semantic diff should report 3 adding on empty settings, got " + diff.adding);
  if (diff.lines[0] === "SessionStart: +1 entry (session-register.sh) — adding") ok("line 0 is SessionStart adding");
  else fail_("line 0 should be SessionStart adding, got: " + diff.lines[0]);
  if (diff.lines[1] === "SessionEnd: +1 entry (session-unregister.sh) — adding") ok("line 1 is SessionEnd adding");
  else fail_("line 1 should be SessionEnd adding, got: " + diff.lines[1]);
  if (diff.lines[2] === "UserPromptSubmit: +1 entry (session-touch.sh) — adding") ok("line 2 is UserPromptSubmit adding");
  else fail_("line 2 should be UserPromptSubmit adding, got: " + diff.lines[2]);
}

// Test 9: semantic diff lists entries as already present when hooks exist
{
  const populated = installer.computeNewSettings({});
  const diff = installer.semanticDiff(populated);
  if (diff.adding === 0) ok("semantic diff reports 0 adding when all hooks present");
  else fail_("semantic diff should report 0 adding when all hooks present, got " + diff.adding);
  if (diff.lines[0] === "SessionStart: +1 entry (session-register.sh) — already present") ok("line 0 is SessionStart already present");
  else fail_("line 0 should be SessionStart already present, got: " + diff.lines[0]);
  if (diff.lines[1] === "SessionEnd: +1 entry (session-unregister.sh) — already present") ok("line 1 is SessionEnd already present");
  else fail_("line 1 should be SessionEnd already present, got: " + diff.lines[1]);
  if (diff.lines[2] === "UserPromptSubmit: +1 entry (session-touch.sh) — already present") ok("line 2 is UserPromptSubmit already present");
  else fail_("line 2 should be UserPromptSubmit already present, got: " + diff.lines[2]);
}

// Test 10: no matcher:"*" on UserPromptSubmit or SessionEnd entries in computed output
{
  const result = installer.computeNewSettings({});
  if (result.hooks.SessionEnd[0].matcher === undefined) ok("SessionEnd entry has no matcher in output");
  else fail_("SessionEnd entry should have no matcher in output, got: " + result.hooks.SessionEnd[0].matcher);
  if (result.hooks.UserPromptSubmit[0].matcher === undefined) ok("UserPromptSubmit entry has no matcher in output");
  else fail_("UserPromptSubmit entry should have no matcher in output, got: " + result.hooks.UserPromptSubmit[0].matcher);
}

// Test 11: detection by command path works even with a different matcher
{
  const existing = {
    hooks: {
      SessionStart: [
        { matcher: "*", hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-register.sh", timeout: 10 }] },
      ],
    },
  };
  const result = installer.computeNewSettings(existing);
  if (result.hooks.SessionStart.length === 1) ok("existing session-register.sh detected by command path despite different matcher");
  else fail_("should detect existing session-register.sh by command path, got " + result.hooks.SessionStart.length + " entries");
}

// Test 12: install() strips a stale _agents key on the idempotent path (all hooks already present)
{
  const fakeSettings = {
    _agents: "4.0",
    hooks: {
      SessionStart: installer.AGENTS_HOOKS.SessionStart,
      SessionEnd: installer.AGENTS_HOOKS.SessionEnd,
      UserPromptSubmit: installer.AGENTS_HOOKS.UserPromptSubmit,
    },
  };
  const origRead = fs.readFileSync;
  const origWrite = fs.writeFileSync;
  let writtenContent = null;
  fs.readFileSync = function (p, enc) {
    if (p === installer.SETTINGS_PATH) return JSON.stringify(fakeSettings);
    return origRead.call(fs, p, enc);
  };
  fs.writeFileSync = function (p, content, enc) {
    if (p === installer.SETTINGS_PATH) { writtenContent = content; return; }
    return origWrite.call(fs, p, content, enc);
  };
  try {
    const result = installer.install(true);
    if (result.installed === true) ok("install(--force) writes when stale _agents key present with all hooks already present");
    else fail_("install(--force) should write to strip stale _agents, got: " + JSON.stringify(result));
    if (writtenContent != null) {
      const parsed = JSON.parse(writtenContent);
      if (!("_agents" in parsed)) ok("install() removes stale _agents key from written settings");
      else fail_("install() should remove stale _agents key, still present: " + JSON.stringify(parsed._agents));
    } else {
      fail_("install() should have written settings to strip stale _agents key");
    }
  } finally {
    fs.readFileSync = origRead;
    fs.writeFileSync = origWrite;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
