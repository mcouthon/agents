#!/usr/bin/env node
"use strict";
// D57: a hook stub must fail open when `a` itself crashes. Only the
// deliberate exit 2 (a reasoned block) propagates; any other failure of the
// library (syntax error, missing module, thrown ReferenceError) exits 0 so a
// broken shared library can never deny every tool call on the machine.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const hooksDir = path.join(__dirname, "..", "hooks");
const stubs = fs.readdirSync(hooksDir).filter((f) => {
  if (!f.endsWith(".sh")) return false;
  return /"\$A" hook [a-z-]+; rc=\$\?/.test(fs.readFileSync(path.join(hooksDir, f), "utf8"));
});
if (stubs.length >= 10) ok(`${stubs.length} enforcement stubs use the fail-open form`);
else fail_(`expected at least 10 fail-open stubs, found ${stubs.length}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-stubs-"));
function fakeA(body) {
  const p = path.join(tmp, "a-" + Math.random().toString(36).slice(2));
  fs.writeFileSync(p, "#!/bin/sh\n" + body + "\n");
  fs.chmodSync(p, 0o755);
  return p;
}
const crashing = fakeA('echo "ReferenceError: boom" >&2; exit 1');
const blocking = fakeA('echo \'{"systemMessage":"no"}\'; exit 2');
const allowing = fakeA("exit 0");

for (const stub of stubs) {
  const run = (A) => spawnSync("sh", [path.join(hooksDir, stub)], { env: { ...process.env, A }, input: "{}", encoding: "utf8" });
  const c = run(crashing);
  if (c.status === 0) ok(`${stub}: crash in a → exit 0 (fail open)`); else fail_(`${stub}: crash gave exit ${c.status}`);
  const b = run(blocking);
  if (b.status === 2 && b.stdout.includes("systemMessage")) ok(`${stub}: exit 2 propagates with its output`); else fail_(`${stub}: block gave exit ${b.status}`);
  const a = run(allowing);
  if (a.status === 0) ok(`${stub}: allow → exit 0`); else fail_(`${stub}: allow gave exit ${a.status}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
