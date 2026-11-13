"use strict";

// The session launch environment builder: computes E1 — exactly what a fresh
// terminal in the session's folder would have. The launcher's environment is
// cleaned of Python activation and venv-bin PATH entries (the clean base),
// the folder's own .envrc is evaluated by the engine through real direnv, and
// every failure mode refuses with a named code before anything is registered.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

function fail(exitCode, message, code, detail) {
  const err = new Error(message);
  err.exitCode = exitCode;
  if (code) err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// --------------------------------------------------------------------------- constants

const DIRENV_EVAL_TIMEOUT_MS = 30000;
const ENV_FILE_TIMEOUT_MS = 10000;
const DIRENV_UNDO_TIMEOUT_MS = 30000;
const DIRENV_PROBE_TIMEOUT_MS = 2000;
// 5x the first budget: the version probe exceeded 2000 ms and even 5000 ms under
// check.sh's 32-suite parallel load, so scheduling contention alone breaches both.
// 10000 ms gives a real `direnv version` (process spawn) headroom under extreme load.
const DIRENV_PROBE_RETRY_TIMEOUT_MS = 10000;

// Variables dropped from the launcher env (the scrub). The harness names come
// from the adapter at call time so this module never names the harness.
const SCRUB_NAMES = [
  "VIRTUAL_ENV", "VIRTUAL_ENV_PROMPT", "POETRY_ACTIVE", "UV_PROJECT_ENVIRONMENT",
  "PYENV_VIRTUAL_ENV", "PIPENV_ACTIVE", "PYTHONHOME", "PYTHONPATH",
  "NODE_PATH", "GIT_DIR", "GIT_WORK_TREE",
  "AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_LAND",
  "PAV_TERMINAL_ID", "PAV_TERMINAL_DIR",
  "ZMX_SESSION", "ZMX_DIR",
];

const SCRUB_PREFIXES = ["CONDA_", "DIRENV_"];

// Engine pointers dropped after the direnv evaluation so an .envrc cannot
// inject them. Venv/python vars are NOT here — the folder's .envrc may set them.
const ENGINE_SCRUB_NAMES = [
  "AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_LAND",
  "PAV_TERMINAL_ID", "PAV_TERMINAL_DIR",
  "ZMX_SESSION", "ZMX_DIR",
];

// Shell noise added by every spawn (stripped from every merge result).
const SHELL_NOISE = ["_", "SHLVL", "OLDPWD", "PWD"];

// Passthrough variables read from the pane at script-run time.
const PASSTHROUGH = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "ZMX_SESSION", "ZMX_DIR"];

// --------------------------------------------------------------------------- helpers

function adapterDroppedNames() {
  try { return require("./adapter").forHarness().droppedEnvNames(); } catch { return []; }
}

function adapterDroppedPrefixes() {
  try { return require("./adapter").forHarness().droppedEnvPrefixes(); } catch { return []; }
}

function direnvProbe(env, timeoutMs) {
  execFileSync("direnv", ["version"], {
    env: env || process.env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

// A timeout is neither "direnv missing" nor "direnv ok": the binary is there but
// slow (the machine is loaded). Retried once at a larger budget, and if it still
// times out, throws `direnv_timeout` — never collapses into `false` (which every
// caller reads as `direnv_missing`). Genuinely absent (ENOENT) stays `false`.
function direnvAvailable(env) {
  try {
    direnvProbe(env, DIRENV_PROBE_TIMEOUT_MS);
    return true;
  } catch (err) {
    if (err.code !== "ETIMEDOUT") return false;
  }
  try {
    direnvProbe(env, DIRENV_PROBE_RETRY_TIMEOUT_MS);
    return true;
  } catch (retryErr) {
    if (retryErr.code !== "ETIMEDOUT") return false;
    throw fail(2,
      "direnv is slow (timed out twice); the machine may be loaded — retry in a moment",
      "direnv_timeout",
      { remedy: "wait for the load to ease and retry; if direnv still won't answer, run `direnv version` by hand" });
  }
}

function direnvStoreDir(type) {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "direnv", type);
}

function storeContains(type, envrcRealPath) {
  const dir = direnvStoreDir(type);
  if (!fs.existsSync(dir)) return false;
  const expected = `${envrcRealPath}\n`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (fs.readFileSync(path.join(dir, name), "utf8") === expected) return true;
    }
  } catch {}
  return false;
}

function isDenied(envrcPath) {
  return storeContains("deny", realpath(envrcPath));
}

function isAllowed(envrcPath) {
  return storeContains("allow", realpath(envrcPath));
}

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

function stripNames(env, names) {
  for (const name of names) delete env[name];
  return env;
}

function stripPrefixes(env, prefixes) {
  for (const key of Object.keys(env)) {
    for (const p of prefixes) {
      if (key.startsWith(p)) { delete env[key]; break; }
    }
  }
  return env;
}

function stripShellNoise(env) {
  for (const name of SHELL_NOISE) delete env[name];
  return env;
}

// --------------------------------------------------------------------------- scrubbedBase

function scrubbedBase(launcherEnv) {
  let env = { ...launcherEnv };

  // Undo the launcher's direnv load.
  if ("DIRENV_DIFF" in env) {
    if (!direnvAvailable(env)) {
      throw fail(2, "direnv is not available but DIRENV_DIFF is set in the launcher env; cannot undo the launcher's direnv load",
        "direnv_missing",
        { remedy: "install direnv (brew install direnv) or unset DIRENV_DIFF in the launcher" });
    }
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "direnv-undo-"));
    try {
      const r = spawnSync("/bin/sh", ["-c", `cd ${shellQuote(fresh)} && _out=$(direnv export bash) && eval "$_out" && exec /usr/bin/env -0`], {
        env,
        encoding: "utf8",
        timeout: DIRENV_UNDO_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (r.error || r.status !== 0) {
        const stderrTail = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
        throw fail(2, "the launcher's direnv load could not be undone",
          "direnv_undo_failed",
          { remedy: "run `eval \"$(direnv export bash)\"` in a plain directory by hand", stderr_tail: stderrTail });
      }
      env = parseEnvNul(r.stdout);
    } finally {
      try { execFileSync("rm", ["-r", "-f", fresh]); } catch {}
    }
  }

  // Drop by name.
  stripNames(env, [...SCRUB_NAMES, ...adapterDroppedNames()]);
  stripPrefixes(env, [...SCRUB_PREFIXES, ...adapterDroppedPrefixes()]);

  // PATH structural strip: remove venv and conda bin entries.
  if (env.PATH) {
    const entries = env.PATH.split(":").filter(Boolean);
    const surviving = [];
    for (let entry of entries) {
      if (entry.endsWith("/")) entry = entry.replace(/\/+$/, "");
      const parent = path.dirname(entry);
      if (fs.existsSync(path.join(parent, "pyvenv.cfg")) || fs.existsSync(path.join(parent, "conda-meta"))) continue;
      surviving.push(entry);
    }
    env.PATH = surviving.join(":");
  }

  return env;
}

// --------------------------------------------------------------------------- withEnvFile

function withEnvFile(base, envFile) {
  if (!envFile) return base;
  const cwd = path.dirname(envFile);
  const r = spawnSync("/bin/sh", ["-c", `set -a; . ${shellQuote(envFile)}; set +a; exec /usr/bin/env -0`], {
    env: base,
    cwd,
    encoding: "utf8",
    timeout: ENV_FILE_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) {
    const stderrTail = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
    throw fail(2, `the launch env file could not be sourced: ${envFile}`,
      "env_file_failed",
      { remedy: `check the file \`${envFile}\` for syntax errors`, stderr_tail: stderrTail });
  }
  const merged = { ...base, ...parseEnvNul(r.stdout) };
  stripShellNoise(merged);
  return merged;
}

// --------------------------------------------------------------------------- withDirenv

function withDirenv(base, dir) {
  const realDir = realpath(dir);
  const envrc = path.join(realDir, ".envrc");
  if (!fs.existsSync(envrc)) return base;

  if (!direnvAvailable(base)) {
    throw fail(2, `direnv is not available but ${envrc} exists; cannot evaluate the folder's environment`,
      "direnv_missing",
      { remedy: "install direnv (brew install direnv) or remove the .envrc" });
  }

  // Deny pre-check.
  if (isDenied(envrc)) {
    throw fail(2, `${envrc} is denied by direnv`,
      "envrc_denied",
      { remedy: `cd ${realDir} && direnv allow (if the deny was not intended)` });
  }

  const timeoutMs = parseInt(process.env.AGENTS_DIRENV_TIMEOUT_MS, 10) || DIRENV_EVAL_TIMEOUT_MS;
  const r = spawnSync("direnv", ["exec", realDir, "/usr/bin/env", "-0"], {
    env: base,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (r.error || (r.status === null && r.signal === "SIGTERM" && r.stderr === "")) {
    throw fail(2, `evaluation of ${envrc} timed out after ${timeoutMs / 1000}s`,
      "envrc_timeout",
      { remedy: `run \`direnv exec ${realDir} /usr/bin/env\` by hand to see what is slow` });
  }

  if (r.status !== 0) {
    const stderr = (r.stderr || "").trim();
    if (/is blocked/.test(stderr)) {
      throw fail(2, `${envrc} is blocked. Run 'direnv allow' to approve its content`,
        "envrc_blocked",
        { remedy: `cd ${realDir} && direnv allow` });
    }
    const stderrTail = stderr.split("\n").slice(-5).join("\n");
    throw fail(2, `evaluation of ${envrc} failed`,
      "envrc_failed",
      { remedy: `run \`cd ${realDir} && direnv allow\` and the .envrc by hand to see the error`, stderr_tail: stderrTail });
  }

  const result = { ...base, ...parseEnvNul(r.stdout) };
  stripPrefixes(result, ["DIRENV_"]);
  stripShellNoise(result);
  return result;
}

// --------------------------------------------------------------------------- sessionEnv

function sessionEnv({ cwd, launcherEnv, envFile }) {
  const realCwd = realpath(cwd);
  const source = launcherEnv || process.env;

  const base = scrubbedBase(source);
  const withFile = envFile ? withEnvFile(base, envFile) : base;

  // Capture AGENTS_* for re-assert: the values before the direnv evaluation.
  const agentsSnapshot = {};
  for (const key of Object.keys(withFile)) {
    if (key.startsWith("AGENTS_")) agentsSnapshot[key] = withFile[key];
  }

  const result = withDirenv(withFile, realCwd);

  // Engine drop: names an .envrc must not inject.
  stripNames(result, [...ENGINE_SCRUB_NAMES, ...adapterDroppedNames()]);
  stripPrefixes(result, adapterDroppedPrefixes());

  // Re-assert AGENTS_* that survived the scrub.
  for (const [key, value] of Object.entries(agentsSnapshot)) {
    result[key] = value;
  }

  result.PWD = realCwd;
  return result;
}

// --------------------------------------------------------------------------- assertWorktreeVenv

function assertWorktreeVenv(env, wtRealPath) {
  const wtReal = realpath(wtRealPath);
  for (const name of ["VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"]) {
    if (!(name in env) || !env[name]) continue;
    let valueReal;
    try { valueReal = fs.realpathSync(env[name]); } catch { valueReal = path.resolve(env[name]); }
    const inside = valueReal === wtReal || valueReal.startsWith(wtReal + path.sep);
    if (!inside) {
      throw fail(2,
        `${name}=${env[name]} resolves outside the worktree (${wtReal}); the .envrc must be checkout-relative`,
        "worktree_venv_outside",
        {
          remedy: "make the .envrc checkout-relative — activate .venv paths relative to the RC dir, never an absolute ~/.virtualenvs/<name>",
          variable: name,
          value: env[name],
          session_cwd: wtReal,
        });
    }
  }
}

// --------------------------------------------------------------------------- ensureWorktreeEnvrc

function ensureWorktreeEnvrc(mainRoot, wtPath) {
  const mainReal = realpath(mainRoot);
  const wtReal = realpath(wtPath);
  const mainEnvrc = path.join(mainReal, ".envrc");
  const wtEnvrc = path.join(wtReal, ".envrc");

  if (!fs.existsSync(mainEnvrc) && !fs.existsSync(wtEnvrc)) return [];

  if (!fs.existsSync(mainEnvrc)) {
    throw fail(2, `the worktree's .envrc exists but the main checkout's does not (a stale copy)`,
      "worktree_envrc_untrusted",
      { remedy: `restore the main checkout's .envrc, then copy it into the worktree again: \`cp ${mainEnvrc} ${wtEnvrc}\``, reason: "main_missing" });
  }

  let mainBytes, wtBytes;
  try { mainBytes = fs.readFileSync(mainEnvrc); } catch {
    throw fail(2, "could not read the main checkout's .envrc",
      "worktree_envrc_untrusted",
      { remedy: "ensure the main checkout's .envrc is readable", reason: "main_missing" });
  }
  try { wtBytes = fs.readFileSync(wtEnvrc); } catch { wtBytes = null; }
  if (!wtBytes || !mainBytes.equals(wtBytes)) {
    throw fail(2, "the worktree's .envrc differs from the main checkout's",
      "worktree_envrc_untrusted",
      { remedy: `copy the main checkout's .envrc into the worktree (\`cp ${mainEnvrc} ${wtEnvrc}\`) and \`direnv allow\` in the main checkout`, reason: "bytes_differ" });
  }

  // Confirm direnv is available before evaluating through it.
  const base = scrubbedBase(process.env);
  if (!direnvAvailable(base)) {
    throw fail(2, `direnv is not available; cannot evaluate the worktree's .envrc`,
      "direnv_missing",
      { remedy: "install direnv (brew install direnv) or remove the .envrc" });
  }

  // Prove main's .envrc is allowed and evaluates.
  const r = spawnSync("direnv", ["exec", mainReal, "/usr/bin/env", "-0"], {
    env: base, encoding: "utf8", timeout: DIRENV_EVAL_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw fail(2, "the main checkout's .envrc is not in a working allow state",
      "worktree_envrc_untrusted",
      { remedy: `run \`cd ${mainReal} && direnv allow\` in the main checkout`, reason: "main_not_allowed" });
  }
  // The venv fingerprint: which venv variables the main checkout's .envrc
  // yields — the names the worktree's identical copy must eventually yield
  // too, once the bootstrap has created its venv. A bare `source <venv>
  // /activate` evaluates green without them, so the names (not the eval) are
  // what the env probe waits on. An .envrc that yields none fingerprints
  // empty: no check, no wait.
  const mainEval = parseEnvNul(r.stdout);
  const fingerprint = ["VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"].filter((name) => mainEval[name]);

  // A deny recorded at the worktree's .envrc path is respected: refuse before auto-allow.
  if (isDenied(wtEnvrc)) {
    throw fail(2, `${wtEnvrc} is denied by direnv`,
      "envrc_denied",
      { remedy: `cd ${wtReal} && direnv allow (if the deny was not intended)` });
  }

  // Auto-allow at the worktree: run `direnv allow` with cwd=worktree, no argument.
  execFileSync("direnv", ["allow"], {
    cwd: wtReal, stdio: ["pipe", "pipe", "pipe"], timeout: DIRENV_EVAL_TIMEOUT_MS,
  });
  return fingerprint;
}

// --------------------------------------------------------------------------- setupEnv

function setupEnv() {
  return scrubbedBase(process.env);
}

// --------------------------------------------------------------------------- writeLaunchScript

function writeLaunchScript(sessionDir, env, argv) {
  const scriptPath = path.join(sessionDir, "launch.sh");
  const namesPath = path.join(sessionDir, "launch.env-names");

  // K=V words: E1 minus passthrough variables, with AGENTS_SESSION_DIR appended last.
  const passthroughSet = new Set(PASSTHROUGH);
  const kvKeys = Object.keys(env).filter((k) => !passthroughSet.has(k));
  const kvWords = kvKeys.map((k) => `${shellQuote(k)}=${shellQuote(env[k])}`);
  kvWords.push(`AGENTS_SESSION_DIR=${shellQuote(sessionDir)}`);

  // Passthrough expansions: read the pane's values at script-run time.
  const passthroughWords = PASSTHROUGH.map((v) => `\${${v}:+${v}="$${v}"}`);

  const argvWords = argv.map(shellQuote);
  const allWords = [...passthroughWords, ...kvWords, ...argvWords];

  const script = [
    "#!/bin/sh",
    "# Generated by a start / a resume for this session; the session's launch environment.",
    '# Self-removes before the exec below — by then the environment is already in memory;',
    "# the names-only launch.env-names beside it is the debugging copy (names, never values).",
    'rm -f "$0"',
    `exec env -i ${allWords.join(" ")}`,
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, script, { mode: 0o600 });

  // Names-only copy: one variable name per line, no values. If this write
  // fails after launch.sh was already written, unlink launch.sh so no
  // 0600 script holding the full environment is left at rest.
  const allNames = [...kvKeys, "AGENTS_SESSION_DIR"];
  try {
    fs.writeFileSync(namesPath, allNames.join("\n") + "\n", { mode: 0o600 });
  } catch (namesErr) {
    try { fs.unlinkSync(scriptPath); } catch {}
    throw namesErr;
  }

  const line = `exec sh ${shellQuote(scriptPath)}`;
  return { scriptPath, line };
}

// --------------------------------------------------------------------------- exports

module.exports = {
  scrubbedBase,
  withEnvFile,
  withDirenv,
  sessionEnv,
  ensureWorktreeEnvrc,
  assertWorktreeVenv,
  setupEnv,
  writeLaunchScript,
  direnvAvailable,
  isDenied,
  isAllowed,
  fail,
  DIRENV_EVAL_TIMEOUT_MS,
};
