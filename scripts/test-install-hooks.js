#!/usr/bin/env node
"use strict";
// install-global-hooks.js: registers exactly the five hooks, removes the
// retired AGENTS entries, backs settings.json up before writing, and never
// touches foreign hooks. Every settings file here lives in a temporary HOME.

// Isolation: nothing here may touch the real HOME, config, git config or live PAV.
(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-iso-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_HOOKS_FLAG: path.join(t, "no-flag"),
    AGENTS_DB: path.join(t, "agents.db"),
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "A", "AGENTS_HOOKS_OFF"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const installer = require("./install-global-hooks");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ours = (cmd) => `$HOME/.claude/hooks/${cmd}.sh`;
const hook = (command) => ({ type: "command", command, timeout: 10 });
const oursEntry = (name, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [hook(ours(name))] });
const foreign = (command, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
const METRICS = "/usr/local/bin/acme-metrics emit";
const ATTENTION = "python3 -c \"print('acme attention')\"";
const LINT = "/usr/local/bin/acme-lint";
const NOTIFY = "/usr/local/bin/acme-notify";
const MIXED = "/usr/local/bin/acme-mixed";
const SESSION_MATCHER = "startup|resume|clear|fork";

// Settings shaped like a machine that ran the earlier hook set, with foreign hooks on the same events.
function retiredSettings() {
  return {
    model: "acme-model",
    hooks: {
      SessionStart: [oursEntry("session-register", SESSION_MATCHER), oursEntry("prime", SESSION_MATCHER), foreign(METRICS)],
      SessionEnd: [oursEntry("session-unregister")],
      UserPromptSubmit: [oursEntry("session-touch"), oursEntry("prime"), foreign(ATTENTION)],
      PreToolUse: [
        oursEntry("spawn-guard", "Agent|Task"), oursEntry("git-guard", "Bash"),
        oursEntry("checkpoint-capture", "AskUserQuestion"), foreign(LINT, "Bash"),
      ],
      PostToolUse: [
        oursEntry("quality-gate", "Bash"), oursEntry("checkpoint-capture", "AskUserQuestion"),
        { matcher: "Bash", hooks: [hook(ours("write-guard")), { type: "command", command: MIXED }] },
      ],
      SubagentStop: [oursEntry("report-parser")],
      Stop: [oursEntry("quality-gate"), foreign(NOTIFY), oursEntry("conductor-stop"), oursEntry("courier-stop")],
      WorktreeCreate: [oursEntry("worktree-create")],
    },
    permissions: { additionalDirectories: ["~/.agents/tasks"] },
  };
}

function makeHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
  return home;
}
const settingsOf = (home) => path.join(home, ".claude", "settings.json");
const readWritten = (home) => JSON.parse(fs.readFileSync(settingsOf(home), "utf8"));
const backupsOf = (home) => fs.readdirSync(path.join(home, ".claude")).filter((f) => f.startsWith("settings.json.agents-backup-"));

function runInstaller(args, { home, stdin = "", env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, "install-global-hooks.js"), ...args], {
    input: stdin,
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
    timeout: 10000,
    cwd: os.tmpdir(),
  });
}

// Five hooks, nothing else.
{
  const result = installer.computeNewSettings({});
  check(Object.keys(result.hooks).sort().join() === "PostToolUse,PreToolUse,SessionEnd,SessionStart,UserPromptSubmit", "empty settings get entries on exactly the five events");
  check(result.hooks.PreToolUse[0].matcher === "SubagentHandback" && result.hooks.PostToolUse[0].matcher === "AskUserQuestion", "report-capture matches SubagentHandback and checkpoint-capture matches AskUserQuestion");
  check(!("_agents" in result), "no _agents key is written");
  check(same(installer.computeNewSettings(result), result), "computeNewSettings is idempotent");
}

// I1: retired AGENTS entries go, foreign entries stay in order, the mixed entry keeps its foreign command.
{
  const result = installer.computeNewSettings(retiredSettings());
  const h = result.hooks;
  check(same(h.SessionStart, [oursEntry("session-register", SESSION_MATCHER), foreign(METRICS)]), "I1: SessionStart keeps session-register and the foreign entry, loses prime");
  check(same(h.SessionEnd, [oursEntry("session-end")]), "I1: SessionEnd holds only session-end");
  check(same(h.UserPromptSubmit, [oursEntry("prime"), foreign(ATTENTION)]), "I1: UserPromptSubmit keeps prime and the foreign entry, loses session-touch");
  check(same(h.PreToolUse, [foreign(LINT, "Bash"), { matcher: "SubagentHandback", hooks: [hook(ours("report-capture"))] }]), "I1: PreToolUse loses the guards and checkpoint-capture, gains report-capture");
  check(same(h.PostToolUse, [oursEntry("checkpoint-capture", "AskUserQuestion"), { matcher: "Bash", hooks: [{ type: "command", command: MIXED }] }]), "I1: PostToolUse keeps checkpoint-capture and the mixed entry's foreign command only");
  check(same(h.Stop, [foreign(NOTIFY)]), "I1: Stop keeps only the foreign entry");
  check(h.SubagentStop === undefined && h.WorktreeCreate === undefined, "I1: events emptied by the removal are dropped");
  const all = Object.values(h).flat();
  check(all.every((e) => e.hooks.length > 0) && Object.values(h).every((a) => a.length > 0), "I1: no empty entry or event array remains");
  const oursCount = all.flatMap((e) => e.hooks).filter((x) => /\/\.claude\/hooks\/[^/]+\.sh$/.test(x.command)).length;
  check(oursCount === 5, "I1: exactly five AGENTS commands remain");
  check(result.model === "acme-model", "I1: unrelated settings are untouched");
}

// A foreign command that merely contains one of our script names is not ours.
{
  const settings = { hooks: { Stop: [foreign("/opt/acme/bin/git-guard.sh")] } };
  check(same(installer.computeNewSettings(settings).hooks.Stop, [foreign("/opt/acme/bin/git-guard.sh")]), "a foreign path ending in a retired script name is kept");
}

// I2: backup of the original bytes, a second run changes nothing.
{
  const home = makeHome(retiredSettings());
  const original = fs.readFileSync(settingsOf(home), "utf8");
  const first = runInstaller(["--force"], { home });
  const backups = backupsOf(home);
  check(first.status === 0 && backups.length === 1 && fs.readFileSync(path.join(home, ".claude", backups[0]), "utf8") === original, "I2: --force leaves a backup with the original bytes");
  check(first.stdout.includes(`Backup: ${path.join(home, ".claude", backups[0])}`), "I2: stdout names the backup");
  check(/-1 entry \(session-unregister\.sh\) — removing/.test(first.stdout), "I2: the diff lists removals");
  const second = runInstaller(["--force"], { home });
  check(second.stdout.includes("No changes needed") && backupsOf(home).length === 1, "I2: a second run reports no changes and makes no second backup");
  fs.rmSync(home, { recursive: true, force: true });
}

// I3: --home decides the file; HOME does not.
{
  const target = makeHome({});
  const other = makeHome(retiredSettings());
  const otherBytes = fs.readFileSync(settingsOf(other), "utf8");
  const r = runInstaller(["--force", "--home", target], { home: other });
  check(r.status === 0 && readWritten(target).hooks.SessionEnd !== undefined && fs.readFileSync(settingsOf(other), "utf8") === otherBytes && backupsOf(other).length === 0, "I3: --home changes only that home's settings.json");
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
}

// No settings file yet: written without a backup.
{
  const home = makeHome();
  const r = runInstaller(["--force"], { home });
  check(r.status === 0 && !r.stdout.includes("Backup:") && backupsOf(home).length === 0 && readWritten(home).hooks.SessionStart.length === 1, "a missing settings.json is created without a backup");
  fs.rmSync(home, { recursive: true, force: true });
}

// Stale _agents key with every hook already present still writes (and backs up).
{
  const home = makeHome({ ...installer.computeNewSettings({}), _agents: "4.0" });
  const r = runInstaller(["--force"], { home });
  check(r.status === 0 && !("_agents" in readWritten(home)) && backupsOf(home).length === 1, "a stale _agents key is stripped even when every hook is present");
  fs.rmSync(home, { recursive: true, force: true });
}

// Consent prompt.
const STALE_SETTINGS = { _agents: "4.0" };
{
  const home = makeHome(STALE_SETTINGS);
  const r = runInstaller([], { home, stdin: "y\n" });
  const written = readWritten(home);
  check(r.status === 0 && r.stdout.includes("Global hooks installed.") && written.hooks.SessionStart && !("_agents" in written), "prompt 'y' writes the hooks and strips the stale key");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = makeHome(STALE_SETTINGS);
  const r = runInstaller([], { home, stdin: "n\n" });
  const written = readWritten(home);
  check(r.status === 0 && r.stdout.includes("Skipped.") && !written.hooks && "_agents" in written && backupsOf(home).length === 0, "prompt 'n' leaves settings.json untouched and makes no backup");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = makeHome(STALE_SETTINGS);
  const r = runInstaller(["--force"], { home });
  check(r.status === 0 && r.stdout.includes("Global hooks installed (--force).") && !r.stdout.includes("[y/N]") && readWritten(home).hooks.SessionStart, "--force writes without prompting");
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const r = runInstaller(["--manual"], { home: makeHome({}) });
  check(r.status === 0 && r.stdout.includes("report-capture.sh") && r.stdout.includes("session-end.sh") && !r.stdout.includes("lease"), "--manual prints the five and no lease prose");
}

// additionalDirectories is added by value.
{
  const first = installer.computeNewSettings({});
  check(first.permissions.additionalDirectories.includes("~/.agents/tasks"), "computeNewSettings adds ~/.agents/tasks to additionalDirectories");
  const second = installer.computeNewSettings(first);
  check(second.permissions.additionalDirectories.filter((d) => d === "~/.agents/tasks").length === 1, "re-running does not duplicate additionalDirectories");
  check(!installer.isAdditionalDirPresent({}) && !installer.isAdditionalDirPresent({ permissions: { additionalDirectories: [] } }), "isAdditionalDirPresent is false when missing");
  check(installer.isAdditionalDirPresent({ permissions: { additionalDirectories: ["~/other", "~/.agents/tasks"] } }), "isAdditionalDirPresent is true alongside other entries");
}

// The prompt returns after one line even when stdin stays open (the old TTY hang).
function testOpenStdinReturns() {
  return new Promise((resolve) => {
    const home = makeHome(STALE_SETTINGS);
    const child = spawn(process.execPath, [path.join(__dirname, "install-global-hooks.js")], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: os.tmpdir(),
    });
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fs.rmSync(home, { recursive: true, force: true });
      resolve(result);
    };
    const guard = setTimeout(() => { child.kill("SIGKILL"); finish({ timedOut: true, stdout }); }, 5000);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("exit", (code) => finish({ timedOut: false, code, stdout }));
    child.stdin.write("y\n");
  }).then((res) => {
    check(!res.timedOut && res.code === 0 && res.stdout.includes("Global hooks installed."), "open-stdin prompt returns after one line, exits 0 and writes on 'y'");
  });
}

(async () => {
  await testOpenStdinReturns();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
