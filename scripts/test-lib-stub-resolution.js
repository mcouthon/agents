#!/usr/bin/env node
"use strict";
// Hook stubs must run the installed snapshot (~/.agents/bin/current), fall back
// to the checkout link with exactly one warning, and never embed a checkout path.

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

check(stubs.length >= 17, `at least 17 stubs call "$A" (found ${stubs.length})`);

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
const isWorktree = (s) => s.startsWith("worktree-");

installFake("current", "from-current");
installFake("checkout", "from-checkout");
for (const stub of stubs) {
  const r = run(stub);
  check(r.stdout.includes("from-current") && r.stderr === "", `${stub}: current present runs current with empty stderr`);
}

fs.rmSync(path.join(bin, "current"), { recursive: true, force: true });
for (const stub of stubs) {
  const r = run(stub);
  check(r.stdout.includes("from-checkout") && lines(r.stderr).length === 1, `${stub}: current missing runs checkout with one stderr line`);
}

fs.rmSync(path.join(bin, "checkout"), { recursive: true, force: true });
for (const stub of stubs) {
  const r = run(stub);
  if (isWorktree(stub)) {
    check(r.status === 1 && lines(r.stderr).length === 1, `${stub}: no engine exits 1 with one stderr line`);
  } else {
    check(r.status === 0 && r.stdout === "" && r.stderr === "", `${stub}: no engine exits 0 silently`);
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
