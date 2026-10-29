#!/usr/bin/env node
"use strict";
// Hook stubs must run the installed snapshot (~/.agents/bin/current), fall back
// to the checkout link with exactly one warning, and never embed a checkout path.

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
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function bad(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { cond ? ok(msg) : bad(msg); }

const repoRoot = path.resolve(__dirname, "..");
const hooksDir = path.join(repoRoot, "hooks");
const stubs = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".sh") && fs.readFileSync(path.join(hooksDir, f), "utf8").includes('"$A"'));
const read = (s) => fs.readFileSync(path.join(hooksDir, s), "utf8");

check(
  stubs.slice().sort().join(",") === "session-end.sh,session-register.sh",
  `exactly the two stubs call "$A" (found ${stubs.join(",")})`,
);

for (const stub of stubs) {
  const text = read(stub);
  check(!text.includes(".local/bin/a") && !text.includes("code/agents") && !text.includes(repoRoot), `${stub}: embeds no shim or checkout path`);
  const primary = text.split('A="${A:-$HOME/.agents/bin/current/scripts/bin/a}"').length - 1;
  const warning = text.split("~/.agents/bin/current is missing; running the checkout").length - 1;
  check(primary === 1 && warning === 1, `${stub}: one primary resolution line and one fallback warning`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "stub-res-"));
const bin = path.join(home, ".agents", "bin");
function installFake(via, label) {
  const p = path.join(bin, via, "scripts", "bin", "a");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\necho ${label}\n`);
  fs.chmodSync(p, 0o755);
}
function run(stub, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  delete env.A;
  return spawnSync("sh", [path.join(hooksDir, stub)], { env, input: "{}", encoding: "utf8" });
}
const lines = (s) => s.split("\n").filter(Boolean);

// The two stubs run `a` under the recorded node; the fake one executes the script it is given.
const two = ["session-register.sh", "session-end.sh"];
const recordedNode = path.join(bin, "node");
function installNode() {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(recordedNode, '#!/bin/sh\nA="$1"; shift; exec "$A" "$@"\n');
  fs.chmodSync(recordedNode, 0o755);
}

installNode();
installFake("current", "from-current");
installFake("checkout", "from-checkout");
for (const stub of stubs) {
  const r = run(stub);
  check(r.stdout.includes("from-current") && r.stderr === "", `${stub}: current present runs current with empty stderr`);
}

fs.rmSync(recordedNode);
for (const stub of two) {
  const r = run(stub);
  check(r.status === 0 && r.stdout === "" && lines(r.stderr).length === 1 && r.stderr.includes("run ./install.sh"), `${stub}: no recorded node exits 0 with one stderr line naming ./install.sh`);
}
installNode();

fs.rmSync(path.join(bin, "current"), { recursive: true, force: true });
for (const stub of stubs) {
  const r = run(stub);
  check(r.stdout.includes("from-checkout") && lines(r.stderr).length === 1, `${stub}: current missing runs checkout with one stderr line`);
}

fs.rmSync(path.join(bin, "checkout"), { recursive: true, force: true });
for (const stub of stubs) {
  const r = run(stub);
  check(r.status === 0 && r.stdout === "" && r.stderr === "", `${stub}: no engine exits 0 silently`);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
