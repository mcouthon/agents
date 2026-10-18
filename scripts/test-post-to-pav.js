#!/usr/bin/env node
"use strict";

// Regression test for the postToPav fix: `a session register --hook` calls
// process.exit(0) immediately after postToPav, so an async http.request never
// leaves the process. postToPav must post synchronously (curl) so PAV's bind
// endpoint is actually hit before the process dies.
//
// A local HTTP listener stands in for PAV. The hook is spawned asynchronously
// (not execSync) so the parent's event loop stays free to answer the POST while
// the child is alive. Exactly one POST must arrive at the bind path.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

process.env.AGENTS_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agents-pav-sessions-"));

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const A_PATH = path.join(__dirname, "bin", "a");

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill("SIGKILL"); resolve(null); }
    }, timeoutMs);
    child.on("exit", (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve(code); }
    });
  });
}

(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-pav-cfg-"));
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ pav: { port } }));

  const sid = `pav-${Date.now()}`;
  const hookInput = {
    session_id: sid,
    cwd: "/tmp",
    source: "startup",
    agent_type: "conductor",
  };

  const cleanEnv = { ...process.env };
  delete cleanEnv.AGENTS_SESSION_DIR;
  delete cleanEnv.AGENTS_SESSION_ID;
  const child = spawn("node", [A_PATH, "session", "register", "--hook"], {
    env: {
      ...cleanEnv,
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDECODE: "1",
      AGENTS_CONFIG_PATH: configPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(JSON.stringify(hookInput));
  child.stdin.end();
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  const exitCode = await waitForExit(child, 10000);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const expectedPath = `/api/coding/terminals/${sid}/bind`;
  const binds = requests.filter((r) => r.method === "POST" && r.url === expectedPath);

  if (binds.length === 1)
    ok("exactly one POST arrives at /api/coding/terminals/<id>/bind before process exits");
  else
    fail_(`expected exactly one bind POST at ${expectedPath}, got ${binds.length}: ` + JSON.stringify(requests));

  if (binds.length === 1) {
    const payload = JSON.parse(binds[0].body);
    if (payload.session_id === sid) ok("bind POST body carries the registration (session_id matches)");
    else fail_("bind POST body should carry the registration with matching session_id, got session_id=" + payload.session_id);
    if (payload.origin === "external") ok("bind POST body has origin=external (no launcher pointer)");
    else fail_("bind POST body should have origin=external, got " + payload.origin);
  }

  if (exitCode === 0) ok("hook process exits 0");
  else fail_(`hook process should exit 0, got ${exitCode}`);

  // No-op when pav.port is unset: spawn again with a config that omits pav and
  // assert no POST arrives.
  const noPortConfig = path.join(configDir, "noport.json");
  fs.writeFileSync(noPortConfig, JSON.stringify({ lease: { ttl_ms: 60000 } }));
  requests.length = 0;
  const child2 = spawn("node", [A_PATH, "session", "register", "--hook"], {
    env: { ...cleanEnv, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", AGENTS_CONFIG_PATH: noPortConfig },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child2.stdin.write(JSON.stringify({ session_id: `pav-noport-${Date.now()}`, cwd: "/tmp", source: "startup" }));
  child2.stdin.end();
  child2.stdout.on("data", () => {});
  child2.stderr.on("data", () => {});
  await waitForExit(child2, 10000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (requests.length === 0) ok("no POST when pav.port is unset (no-op)");
  else fail_(`expected no POST when pav.port unset, got ${requests.length}: ` + JSON.stringify(requests));

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(configDir, { recursive: true, force: true });
  try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
