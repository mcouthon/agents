#!/usr/bin/env node
"use strict";
// A hook stub must fail open when the hook entry crashes: any failure of the
// entry (syntax error, missing module, thrown ReferenceError, exit 2) exits 0
// so a broken shared library can never deny a tool call on the machine.

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
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOK", "AGENTS_HOOKS_OFF"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const hooksDir = path.join(__dirname, "..", "hooks");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-stubs-"));
function fakeHook(body) {
  const p = path.join(tmp, "hook-" + Math.random().toString(36).slice(2));
  fs.writeFileSync(p, "#!/bin/sh\n" + body + "\n");
  fs.chmodSync(p, 0o755);
  return p;
}
const crashing = fakeHook('echo "ReferenceError: boom" >&2; exit 1');
const blocking = fakeHook('echo \'{"systemMessage":"no"}\'; exit 2');
const allowing = fakeHook("exit 0");

// The three never-refusing stubs run the hook entry under the recorded node and exit 0 whatever it does.
const three = ["session-register.sh", "session-end.sh", "notification.sh"];
const fakeNode = fakeHook('exec "$1" "$2" "$3"');
for (const stub of three) {
  const run = (HOOK) => spawnSync("sh", [path.join(hooksDir, stub)], { env: { ...process.env, AGENTS_HOOK: HOOK, AGENTS_NODE: fakeNode }, input: "{}", encoding: "utf8" });
  if (run(crashing).status === 0) ok(`${stub}: crash in the entry → exit 0`); else fail_(`${stub}: crash did not exit 0`);
  const b = run(blocking);
  if (b.status === 0 && b.stdout.includes("systemMessage")) ok(`${stub}: exit 2 from the entry becomes exit 0 and its output passes through`); else fail_(`${stub}: exit 2 from the entry gave exit ${b.status}`);
  if (run(allowing).status === 0) ok(`${stub}: allow → exit 0`); else fail_(`${stub}: allow did not exit 0`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
