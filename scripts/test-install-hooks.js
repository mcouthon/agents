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

// --- CLI prompt path tests (spawn the script with a temp HOME) ---
// These exercise the consent prompt and --force code paths through the
// public CLI, the way a user invokes the installer. They use a temp HOME so
// the real ~/.claude/settings.json is never touched.
const { spawnSync } = require("child_process");

function makeTempHome(settingsObj) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
  const claudeDir = path.join(tmp, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(settingsObj), "utf8");
  return tmp;
}

function runInstaller(tmpHome, args, stdin) {
  return spawnSync(process.execPath, [path.join(__dirname, "install-global-hooks.js")].concat(args), {
    input: stdin || "",
    env: Object.assign({}, process.env, { HOME: tmpHome }),
    encoding: "utf8",
    timeout: 5000,
  });
}

function readWritten(tmpHome) {
  return JSON.parse(fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"));
}

// Settings with a stale _agents key and no hooks -> install() needs confirmation.
const STALE_SETTINGS = { _agents: "4.0" };

// Test 13: consenting "y" writes hooks and strips the stale _agents key
{
  const tmp = makeTempHome(STALE_SETTINGS);
  try {
    const r = runInstaller(tmp, [], "y\n");
    if (r.status === 0) ok("prompt 'y' exits 0");
    else fail_("prompt 'y' should exit 0, got " + r.status + " stderr: " + r.stderr);
    if (r.stdout.includes("Global hooks installed.")) ok("prompt 'y' prints installed message");
    else fail_("prompt 'y' should print 'Global hooks installed.', got: " + r.stdout);
    const written = readWritten(tmp);
    if (written.hooks && written.hooks.SessionStart) ok("prompt 'y' writes hooks into settings.json");
    else fail_("prompt 'y' should write hooks, got: " + JSON.stringify(written));
    if (!("_agents" in written)) ok("prompt 'y' strips stale _agents key");
    else fail_("prompt 'y' should strip _agents key, still present");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Test 14: declining "n" leaves settings.json untouched
{
  const tmp = makeTempHome(STALE_SETTINGS);
  try {
    const r = runInstaller(tmp, [], "n\n");
    if (r.status === 0) ok("prompt 'n' exits 0");
    else fail_("prompt 'n' should exit 0, got " + r.status + " stderr: " + r.stderr);
    if (r.stdout.includes("Skipped.")) ok("prompt 'n' prints skipped message");
    else fail_("prompt 'n' should print 'Skipped.', got: " + r.stdout);
    const written = readWritten(tmp);
    if (!written.hooks) ok("prompt 'n' adds no hooks to settings.json");
    else fail_("prompt 'n' should not add hooks, got: " + JSON.stringify(written.hooks));
    if ("_agents" in written) ok("prompt 'n' leaves stale _agents key untouched");
    else fail_("prompt 'n' should leave _agents key untouched");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Test 15: --force skips the prompt entirely and writes
{
  const tmp = makeTempHome(STALE_SETTINGS);
  try {
    const r = runInstaller(tmp, ["--force"], "");
    if (r.status === 0) ok("--force exits 0 without prompting");
    else fail_("--force should exit 0, got " + r.status + " stderr: " + r.stderr);
    if (r.stdout.includes("Global hooks installed (--force).")) ok("--force prints force-installed message");
    else fail_("--force should print 'Global hooks installed (--force).', got: " + r.stdout);
    if (r.stdout.indexOf("[y/N]") === -1) ok("--force does not show consent prompt");
    else fail_("--force should not show the consent prompt");
    const written = readWritten(tmp);
    if (written.hooks && written.hooks.SessionStart) ok("--force writes hooks into settings.json");
    else fail_("--force should write hooks, got: " + JSON.stringify(written));
    if (!("_agents" in written)) ok("--force strips stale _agents key");
    else fail_("--force should strip _agents key, still present");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const { spawn } = require("child_process");

// Test 16: prompt returns after one line even when stdin stays open (the TTY
// hang regression). The old readFileSync("/dev/stdin") blocked until EOF; with
// an open stdin (as on a TTY) it hung forever. readline.question returns after
// the first newline. We write "y" without ending stdin to simulate an open
// pipe and assert the installer exits promptly instead of hanging.
function testOpenStdinReturns() {
  return new Promise((resolve) => {
    const tmp = makeTempHome(STALE_SETTINGS);
    const child = spawn(process.execPath, [path.join(__dirname, "install-global-hooks.js")], {
      env: Object.assign({}, process.env, { HOME: tmp }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(result);
    };
    const guard = setTimeout(() => { child.kill("SIGKILL"); finish({ timedOut: true, stdout }); }, 5000);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("exit", (code) => finish({ timedOut: false, code, stdout }));
    child.stdin.write("y\n");
  }).then((res) => {
    if (res.timedOut) fail_("open-stdin prompt should not hang (readline returns after one line)");
    else ok("open-stdin prompt returns without EOF (readline reads one line)");
    if (!res.timedOut && res.code === 0) ok("open-stdin prompt exits 0");
    else if (!res.timedOut) fail_("open-stdin prompt should exit 0, got " + res.code);
    if (!res.timedOut && res.stdout.includes("Global hooks installed.")) ok("open-stdin prompt writes on 'y'");
    else if (!res.timedOut) fail_("open-stdin prompt should print installed message, got: " + res.stdout);
  });
}

(async () => {
  await testOpenStdinReturns();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();