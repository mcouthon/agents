#!/usr/bin/env node
"use strict";
// The five hooks (session-register, session-end, prime, report-capture,
// checkpoint-capture): hook mode never exits non-zero on a crash, handlers
// never refuse, stubs honour the kill switch first.

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
    AGENTS_HOOKS_ADVISE_FLAG: path.join(t, "no-advise"),
    AGENTS_DB: path.join(t, "agents.db"),
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "A", "AGENTS_HOOKS_OFF"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const repo = path.resolve(__dirname, "..");
const A = path.join(repo, "scripts", "bin", "a");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-five-"));
let counter = 0;
const mk = (label) => { const d = path.join(tmpRoot, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
function write(file, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function runNode(node, args, { input = "", env = {}, cwd } = {}) {
  const r = spawnSync(node, args, { input, encoding: "utf8", cwd: cwd || mk("cwd"), env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const runA = (args, opts) => runNode(process.execPath, [A, ...args], opts);
const lines = (s) => s.split("\n").filter(Boolean);

// H1: a node without node:sqlite never costs more than one stderr line while the database is on.
// --no-experimental-sqlite needs node 22.13+ (23.4+); a dev on 22.5-22.12 sees a bad-option failure here.
{
  const wrapper = write(path.join(mk("wrap"), "node-nosqlite"), `#!/bin/sh\nexec "${process.execPath}" --no-experimental-sqlite "$@"\n`, 0o755);
  const db = write(path.join(mk("db"), "agents.db"), "");
  const on = runNode(wrapper, [A, "hook", "prime"], { env: { AGENTS_DB: db }, input: "{}" });
  check(on.status === 0 && on.out === "" && lines(on.err).length === 1 && on.err.includes("node:sqlite"), `H1: database on + node without node:sqlite exits 0 with one stderr line (${on.status}: ${on.err.trim()})`);
  const off = runNode(wrapper, [A, "hook", "prime"], { env: { AGENTS_DB: path.join(mk("nodb"), "agents.db") }, input: "{}" });
  check(off.status === 0 && !off.err.includes("node:sqlite"), `H1: database off runs the hook normally (${off.status}: ${off.err.trim()})`);
}

// H2: a crash while loading the hook library fails open.
{
  const preload = write(path.join(mk("pre"), "preload.js"),
    'const M = require("module"); const orig = M._load;\n' +
    'M._load = function (req, ...rest) { if (/lib[\\/\\\\]hook$/.test(req)) throw new Error("boom-hook"); return orig.call(this, req, ...rest); };\n');
  const r = runA(["hook", "prime"], { env: { NODE_OPTIONS: `--require ${preload}` }, input: "{}" });
  check(r.status === 0 && r.err.includes("agents: hook prime failed:") && r.err.includes("boom-hook"), `H2: crash loading lib/hook exits 0 and names the failure (${r.status}: ${r.err.trim()})`);
}

// H3: a bad session id on a --hook path fails open (the exact path that used to exit 2).
{
  const r = runA(["session", "touch", "--hook"], { env: { AGENTS_SESSION_ID: "bad/id" }, input: "{}" });
  check(r.status === 0 && lines(r.err).length === 1 && r.err.includes("session touch --hook failed"), `H3: bad AGENTS_SESSION_ID on session touch --hook exits 0 with one stderr line (${r.status}: ${r.err.trim()})`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
