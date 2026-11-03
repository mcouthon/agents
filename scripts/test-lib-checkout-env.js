#!/usr/bin/env node
"use strict";
// Unit tests for scripts/lib/checkout-env.js — the session launch environment builder.
// Isolation: nothing here may touch the real HOME, direnv allow/deny stores, or config.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-coe-")));
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(t, d), { recursive: true });
  fs.mkdirSync(path.join(t, "home", ".local", "share", "direnv", "allow"), { recursive: true });
  fs.mkdirSync(path.join(t, "home", ".local", "share", "direnv", "deny"), { recursive: true });
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
  });
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  delete process.env.XDG_DATA_HOME;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DIRENV_")) delete process.env[k];
  }
  for (const k of ["VIRTUAL_ENV", "POETRY_ACTIVE", "UV_PROJECT_ENVIRONMENT", "CLAUDE_ENV_FILE"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const coe = require("./lib/checkout-env");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coe-")));
let counter = 0;
const mk = (label) => fs.realpathSync(fs.mkdtempSync(path.join(T, `${label}-${++counter}-`)));

function parseEnvNul(output) {
  const env = {};
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function direnvAllow(dir) {
  execFileSync("direnv", ["allow"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
}
function direnvDeny(dir) {
  execFileSync("direnv", ["deny"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
}
function writeEnvrc(dir, content) {
  fs.writeFileSync(path.join(dir, ".envrc"), content);
}
function allowWith(dir, content) {
  writeEnvrc(dir, content);
  direnvAllow(dir);
}

const DIRENV_DIR = (() => {
  try {
    return path.dirname(execFileSync("which", ["direnv"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 }).trim());
  } catch { return null; }
})();
const PATH_NO_DIRENV = (process.env.PATH || "").split(":").filter((d) => {
  try { return fs.realpathSync(d) !== fs.realpathSync(DIRENV_DIR); } catch { return true; }
}).join(":");

// --------------------------------------------------------------------------- CE1: scrub
{
  const env = {
    VIRTUAL_ENV: "/fake/venv", VIRTUAL_ENV_PROMPT: "fake", POETRY_ACTIVE: "1",
    UV_PROJECT_ENVIRONMENT: "/fake/uv", PYENV_VIRTUAL_ENV: "/fake/pyenv",
    PIPENV_ACTIVE: "1", PYTHONHOME: "/fake/pyhome", PYTHONPATH: "/fake/pypath",
    NODE_PATH: "/fake/nodepath", GIT_DIR: "/fake/gitdir", GIT_WORK_TREE: "/fake/gitwt",
    CONDA_DEFAULT_ENV: "fake", CONDA_CHANGEPS1: "1",
    ZMX_SESSION: "fake", ZMX_DIR: "/fake/zmx",
    POETRY_VIRTUALENVS_CREATE: "1", UV_CACHE_DIR: "/fake/uvcache",
    AWS_PROFILE: "fake", ANTHROPIC_API_KEY: "fake-key",
    PATH: "/usr/bin:/bin", HOME: process.env.HOME,
  };
  const result = coe.scrubbedBase(env);
  const dropped = ["VIRTUAL_ENV", "VIRTUAL_ENV_PROMPT", "POETRY_ACTIVE", "UV_PROJECT_ENVIRONMENT",
    "PYENV_VIRTUAL_ENV", "PIPENV_ACTIVE", "PYTHONHOME", "PYTHONPATH", "NODE_PATH",
    "GIT_DIR", "GIT_WORK_TREE", "CONDA_DEFAULT_ENV", "CONDA_CHANGEPS1", "ZMX_SESSION", "ZMX_DIR"];
  for (const name of dropped) check(!(name in result), `CE1: ${name} is dropped`);
  const kept = ["POETRY_VIRTUALENVS_CREATE", "UV_CACHE_DIR", "AWS_PROFILE", "ANTHROPIC_API_KEY"];
  for (const name of kept) check(result[name] === env[name], `CE1: ${name} survives`);
}

// --------------------------------------------------------------------------- CE2: PATH strip
{
  const venvA = mk("va"), venvB = mk("vb");
  fs.mkdirSync(path.join(venvA, "bin"), { recursive: true });
  fs.writeFileSync(path.join(venvA, "pyvenv.cfg"), "home = /usr/bin\n");
  fs.mkdirSync(path.join(venvB, "conda-meta"), { recursive: true });
  const miseBin = mk("mise");
  const p = `${path.join(venvA, "bin")}:/usr/bin:/bin:${path.join(venvB, "bin")}:/opt/homebrew/bin:${miseBin}`;
  const result = coe.scrubbedBase({ PATH: p, HOME: process.env.HOME });
  const entries = result.PATH.split(":");
  check(!entries.includes(path.join(venvA, "bin")), "CE2: venvA bin is stripped");
  check(!entries.includes(path.join(venvB, "bin")), "CE2: venvB bin is stripped");
  check(entries.includes("/usr/bin") && entries.includes("/bin") && entries.includes("/opt/homebrew/bin") && entries.includes(miseBin),
    `CE2: surviving entries kept (${result.PATH})`);
  check(entries.indexOf("/usr/bin") < entries.indexOf("/bin") && entries.indexOf("/bin") < entries.indexOf("/opt/homebrew/bin") && entries.indexOf("/opt/homebrew/bin") < entries.indexOf(miseBin),
    "CE2: surviving entries in order");

  // Trailing slash variant
  const p2 = `${path.join(venvA, "bin")}/:/usr/bin:/bin`;
  const r2 = coe.scrubbedBase({ PATH: p2, HOME: process.env.HOME });
  check(!r2.PATH.split(":").includes(`${path.join(venvA, "bin")}/`), "CE2: trailing-slash venv bin is stripped");
  check(r2.PATH.split(":").includes("/usr/bin"), "CE2: trailing-slash variant keeps /usr/bin");
}

// --------------------------------------------------------------------------- CE3: direnv undo
{
  const repoA = mk("ra"), repoB = mk("rb");
  allowWith(repoA, "export A_VAR=hello\n");
  // Produce a genuine DIRENV_DIFF by loading repoA's .envrc
  const loaded = spawnSync("sh", ["-c", `cd ${repoA} && eval "$(direnv export bash)" && exec /usr/bin/env -0`], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
  });
  check(loaded.status === 0, `CE3: direnv export bash succeeded (${loaded.status}: ${loaded.stderr.slice(-200)})`);
  const launcherEnv = parseEnvNul(loaded.stdout);
  check("A_VAR" in launcherEnv && "DIRENV_DIFF" in launcherEnv, "CE3: the launcher env carries A_VAR and DIRENV_DIFF");

  const result = coe.sessionEnv({ cwd: repoB, launcherEnv });
  check(!("A_VAR" in result), "CE3: A_VAR is dropped (the launcher's direnv load was undone)");
  check(!Object.keys(result).some((k) => k.startsWith("DIRENV_")), "CE3: no DIRENV_* in the result");
}

// --------------------------------------------------------------------------- CE4: env file
{
  const repo = mk("re");
  const envFile = path.join(repo, "test.env");
  fs.writeFileSync(envFile, "FKEY=fval\n");
  const result = coe.withEnvFile({ PATH: "/usr/bin:/bin", HOME: process.env.HOME }, envFile);
  check(result.FKEY === "fval", `CE4: FKEY is applied after the scrub (${result.FKEY})`);
  check(!("_" in result) && !("SHLVL" in result) && !("OLDPWD" in result), "CE4: shell noise keys absent");

  // PATH= in the file wins unfiltered
  fs.writeFileSync(envFile, "PATH=/custom/bin\n");
  const r2 = coe.withEnvFile({ PATH: "/usr/bin:/bin", HOME: process.env.HOME }, envFile);
  check(r2.PATH === "/custom/bin", `CE4: a PATH= line in the file wins unfiltered (${r2.PATH})`);
}

// --------------------------------------------------------------------------- CE5: direnv states
{
  // Allowed
  const dirAllowed = mk("ea");
  allowWith(dirAllowed, "export T_V=x\n");
  const r1 = coe.withDirenv({ PATH: process.env.PATH, HOME: process.env.HOME }, dirAllowed);
  check(r1.T_V === "x", "CE5: allowed .envrc exports T_V");
  check(!Object.keys(r1).some((k) => k.startsWith("DIRENV_")), "CE5: no DIRENV_* in allowed result");
  check(!("_" in r1) && !("SHLVL" in r1) && !("OLDPWD" in r1), "CE5: no evaluation noise in allowed result");

  // Not allowed (blocked)
  const dirBlocked = mk("eb");
  writeEnvrc(dirBlocked, "export T_V=x\n");
  let err1 = null;
  try { coe.withDirenv({ PATH: process.env.PATH, HOME: process.env.HOME }, dirBlocked); } catch (e) { err1 = e; }
  check(err1 && err1.code === "envrc_blocked", `CE5: not-allowed .envrc throws envrc_blocked (${err1 && err1.code})`);

  // Denied
  const dirDenied = mk("ed");
  allowWith(dirDenied, "export T_V=x\n");
  direnvDeny(dirDenied);
  let err2 = null;
  try { coe.withDirenv({ PATH: process.env.PATH, HOME: process.env.HOME }, dirDenied); } catch (e) { err2 = e; }
  check(err2 && err2.code === "envrc_denied", `CE5: denied .envrc throws envrc_denied (${err2 && err2.code})`);

  // Failing (.envrc exits non-zero)
  const dirFailed = mk("ef");
  allowWith(dirFailed, "exit 7\n");
  let err3 = null;
  try { coe.withDirenv({ PATH: process.env.PATH, HOME: process.env.HOME }, dirFailed); } catch (e) { err3 = e; }
  check(err3 && err3.code === "envrc_failed", `CE5: failing .envrc throws envrc_failed (${err3 && err3.code})`);
  check(err3 && err3.detail && JSON.stringify(err3.detail).includes("exit status 7"), `CE5: envrc_failed detail carries the exit status (${JSON.stringify(err3 && err3.detail)})`);

  // No .envrc → base unchanged
  const dirNone = mk("en");
  const baseNoEnvrc = { PATH: "/usr/bin:/bin", HOME: process.env.HOME, CUSTOM: "c" };
  const r5 = coe.withDirenv(baseNoEnvrc, dirNone);
  check(r5.CUSTOM === "c" && r5.PATH === "/usr/bin:/bin", "CE5: no .envrc returns base unchanged");

  // PATH without direnv + .envrc present → direnv_missing
  const dirNoDirenv = mk("em");
  allowWith(dirNoDirenv, "export T_V=x\n");
  let err4 = null;
  try { coe.withDirenv({ PATH: PATH_NO_DIRENV, HOME: process.env.HOME }, dirNoDirenv); } catch (e) { err4 = e; }
  check(err4 && err4.code === "direnv_missing", `CE5: no direnv on PATH + .envrc present throws direnv_missing (${err4 && err4.code})`);

  // DIRENV_DIFF set, no .envrc, no direnv → direnv_missing (step 0 refusal)
  const dirNoDirenvNoEnvrc = mk("em2");
  let err5 = null;
  try { coe.sessionEnv({ cwd: dirNoDirenvNoEnvrc, launcherEnv: { PATH: PATH_NO_DIRENV, HOME: process.env.HOME, DIRENV_DIFF: "fake" } }); } catch (e) { err5 = e; }
  check(err5 && err5.code === "direnv_missing", `CE5: DIRENV_DIFF set, no direnv, no .envrc throws direnv_missing (${err5 && err5.code})`);
}

// --------------------------------------------------------------------------- CE6: realpath
{
  const dir = mk("rp");
  allowWith(dir, "export T_V=x\n");
  // On macOS, /tmp is a symlink to /private/tmp.  Allow via the realpath,
  // call sessionEnv with the /tmp-prefixed form.
  const realDir = fs.realpathSync(dir);
  const symlinkedForm = realDir.replace(/^\/private\//, "/");
  if (symlinkedForm !== realDir) {
    const r = coe.sessionEnv({ cwd: symlinkedForm, launcherEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    check(r.T_V === "x", `CE6: sessionEnv with the /tmp form works (the builder realpath'd internally)`);
  } else {
    check(true, "CE6: skipped — /tmp is not a symlink on this system");
  }
}

// --------------------------------------------------------------------------- CE7: AGENTS re-assert
{
  const dir = mk("ag");
  allowWith(dir, "export AGENTS_SESSION_DIR=evil\nexport AGENTS_LAND=evil\n");
  const result = coe.sessionEnv({ cwd: dir, launcherEnv: { PATH: process.env.PATH, HOME: process.env.HOME, AGENTS_SESSION_DIR: "should-be-dropped", AGENTS_LAND: "should-be-dropped" } });
  check(result.AGENTS_SESSION_DIR !== "evil", "CE7: .envrc's AGENTS_SESSION_DIR=evil does not survive (dropped in scrub, not re-asserted)");
  check(result.AGENTS_LAND !== "evil", "CE7: .envrc's AGENTS_LAND=evil does not survive (dropped in scrub, not re-asserted)");
  check(!("AGENTS_LAND" in result), "CE7: AGENTS_LAND is absent (dropped in scrub, must never come back)");
  // writeLaunchScript appends AGENTS_SESSION_DIR as the last K=V word
  const sessionDir = mk("sd");
  const { scriptPath, line } = coe.writeLaunchScript(sessionDir, result, ["claude", "--session-id", "sid"]);
  const script = fs.readFileSync(scriptPath, "utf8");
  const lastAssignment = script.match(/AGENTS_SESSION_DIR='([^']+)'/);
  check(lastAssignment && lastAssignment[1] === sessionDir, `CE7: AGENTS_SESSION_DIR is the last assignment in the script, set to the real session dir (${lastAssignment && lastAssignment[1]})`);
}

// --------------------------------------------------------------------------- CE8: launch script
{
  const dir = mk("ls");
  const env = { T_V: "x", PATH: "/usr/bin:/bin", HOME: process.env.HOME, TERM: "xterm-256color", ZMX_SESSION: "s1", ZMX_DIR: "/zmx" };
  const argv = ["claude", "--session-id", "abc123", "--agent", "Conductor"];
  const { scriptPath, line } = coe.writeLaunchScript(dir, env, argv);
  check(line === `exec sh '${scriptPath}'`, `CE8: the line is exec sh '<scriptPath>' (${line})`);

  const script = fs.readFileSync(scriptPath, "utf8");
  check(script.includes('rm -f "$0"'), "CE8: the script self-removes before the exec");
  // The rm line comes before the exec env -i line
  const rmIdx = script.indexOf('rm -f "$0"');
  const execIdx = script.indexOf("exec env -i");
  check(rmIdx >= 0 && execIdx >= 0 && rmIdx < execIdx, "CE8: rm runs before the exec env -i");

  // TERM/ZMX_SESSION passthrough words present
  check(/TERM="\$TERM"/.test(script) || /\$\{TERM:\+TERM="\$TERM"\}/.test(script), "CE8: TERM passthrough word present");
  check(/ZMX_SESSION="\$ZMX_SESSION"/.test(script) || /\$\{ZMX_SESSION:\+ZMX_SESSION="\$ZMX_SESSION"\}/.test(script), "CE8: ZMX_SESSION passthrough word present");

  // AGENTS_SESSION_DIR is the last assignment (after all other K=V words, before the argv)
  const lines = script.split("\n");
  const execLine = lines.find((l) => l.startsWith("exec env -i"));
  // Find AGENTS_SESSION_DIR in the exec line — it should be after all other K=V words
  const asdIdx = execLine.indexOf("AGENTS_SESSION_DIR=");
  const claudeIdx = execLine.indexOf("'claude'");
  check(asdIdx >= 0 && claudeIdx >= 0 && asdIdx < claudeIdx, "CE8: AGENTS_SESSION_DIR comes before claude in the exec line (last K=V word)");

  // Mode 0600
  const st = fs.statSync(scriptPath);
  check((st.mode & 0o777) === 0o600, `CE8: launch.sh is mode 0600 (${(st.mode & 0o777).toString(8)})`);

  // Names-only copy
  const namesPath = path.join(dir, "launch.env-names");
  check(fs.existsSync(namesPath), "CE8: launch.env-names is written beside launch.sh");
  const names = fs.readFileSync(namesPath, "utf8").split("\n").filter(Boolean);
  for (const name of names) check(!name.includes("="), `CE8: launch.env-names has no values (name-only): ${name}`);
  check(names.includes("T_V") && names.includes("PATH") && names.includes("HOME"), "CE8: launch.env-names has E1's keys");
  check(names.includes("AGENTS_SESSION_DIR"), "CE8: launch.env-names includes AGENTS_SESSION_DIR");
}

// --------------------------------------------------------------------------- CE9: direnv undo refusal
{
  const stubDir = mk("stub");
  fs.mkdirSync(path.join(stubDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(stubDir, "bin", "direnv"), [
    "#!/bin/sh",
    'if [ "$1" = "export" ] && [ "$2" = "bash" ]; then echo "direnv: undo failed" >&2; exit 1; fi',
    'if [ "$1" = "version" ]; then echo "2.37.1"; exit 0; fi',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const stubPath = `${path.join(stubDir, "bin")}:${PATH_NO_DIRENV}`;
  const dir = mk("eu");
  let err = null;
  try {
    coe.sessionEnv({ cwd: dir, launcherEnv: { PATH: stubPath, HOME: process.env.HOME, DIRENV_DIFF: "fake" } });
  } catch (e) { err = e; }
  check(err && err.code === "direnv_undo_failed", `CE9: stubbed direnv export bash exit 1 throws direnv_undo_failed (${err && err.code})`);
  check(err && err.detail && typeof err.detail.remedy === "string", `CE9: the refusal carries a remedy (${JSON.stringify(err && err.detail && Object.keys(err.detail))})`);
}

// --------------------------------------------------------------------------- CE10: evaluation timeout
{
  const dir = mk("to");
  allowWith(dir, "sleep 5\nexport T_V=x\n");
  let err = null;
  try {
    process.env.AGENTS_DIRENV_TIMEOUT_MS = "2000";
    coe.withDirenv({ PATH: process.env.PATH, HOME: process.env.HOME }, dir);
  } catch (e) { err = e; }
  delete process.env.AGENTS_DIRENV_TIMEOUT_MS;
  check(err && err.code === "envrc_timeout", `CE10: a sleeping .envrc throws envrc_timeout (${err && err.code})`);
  check(err && err.detail && typeof err.detail.remedy === "string", "CE10: the refusal carries a remedy");
}

// --------------------------------------------------------------------------- CE11: venv-location guard
{
  const wt = mk("wt");
  const outside = mk("outside");
  fs.mkdirSync(path.join(outside, ".venv"), { recursive: true });
  // VIRTUAL_ENV outside → refuse
  let err1 = null;
  try { coe.assertWorktreeVenv({ VIRTUAL_ENV: outside }, wt); } catch (e) { err1 = e; }
  check(err1 && err1.code === "worktree_venv_outside", `CE11: VIRTUAL_ENV outside the worktree throws worktree_venv_outside (${err1 && err1.code})`);
  check(err1 && err1.detail && typeof err1.detail.remedy === "string" && JSON.stringify(err1.detail).includes("VIRTUAL_ENV"), `CE11: the refusal names the variable and a remedy`);

  // UV_PROJECT_ENVIRONMENT outside → refuse
  let err2 = null;
  try { coe.assertWorktreeVenv({ UV_PROJECT_ENVIRONMENT: outside }, wt); } catch (e) { err2 = e; }
  check(err2 && err2.code === "worktree_venv_outside", `CE11: UV_PROJECT_ENVIRONMENT outside throws worktree_venv_outside (${err2 && err2.code})`);

  // VIRTUAL_ENV inside → passes
  let err3 = null;
  try { coe.assertWorktreeVenv({ VIRTUAL_ENV: path.join(wt, ".venv") }, wt); } catch (e) { err3 = e; }
  check(!err3, `CE11: VIRTUAL_ENV inside the worktree passes (${err3 && err3.message})`);

  // Both unset → passes
  let err4 = null;
  try { coe.assertWorktreeVenv({}, wt); } catch (e) { err4 = e; }
  check(!err4, "CE11: both unset passes");

  // Unresolvable path → counts as outside
  let err5 = null;
  try { coe.assertWorktreeVenv({ VIRTUAL_ENV: "/nonexistent/path/that/does/not/exist" }, wt); } catch (e) { err5 = e; }
  check(err5 && err5.code === "worktree_venv_outside", `CE11: an unresolvable VIRTUAL_ENV counts as outside (${err5 && err5.code})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
