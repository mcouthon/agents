#!/usr/bin/env node
"use strict";

// Regression test for the postToPav fix: the session-register hook calls
// process.exit(0) immediately after postToPav, so an async http.request never
// leaves the process. postToPav must post synchronously (curl) so PAV's bind
// endpoint is actually hit before the process dies. Both entry points run the
// same code: `a session register --hook` and `a hook session-register`.
//
// A local HTTP listener stands in for PAV. The hook is spawned asynchronously
// (not execSync) so the parent's event loop stays free to answer the POST while
// the child is alive. Exactly one POST must arrive at the bind path.

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

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const A_PATH = path.join(__dirname, "bin", "a");
const FORMS = [
  ["session", "register", "--hook"],
  ["hook", "session-register"],
];

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

function spawnHook(form, configPath, hookInput) {
  const env = { ...process.env, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", AGENTS_CONFIG_PATH: configPath };
  const child = spawn("node", [A_PATH, ...form], { env, stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
  child.stdin.write(JSON.stringify(hookInput));
  child.stdin.end();
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
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
  const noPortConfig = path.join(configDir, "noport.json");
  fs.writeFileSync(noPortConfig, JSON.stringify({ lease: { ttl_ms: 60000 } }));

  for (const form of FORMS) {
    const label = form.join(" ");
    requests.length = 0;
    const sid = `pav-${Date.now()}-${form[0]}`;
    const exitCode = await waitForExit(
      spawnHook(form, configPath, { session_id: sid, cwd: "/tmp", source: "startup", agent_type: "conductor" }),
      10000,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expectedPath = `/api/coding/terminals/${sid}/bind`;
    const binds = requests.filter((r) => r.method === "POST" && r.url === expectedPath);

    if (binds.length === 1)
      ok(`${label}: exactly one POST arrives at /api/coding/terminals/<id>/bind before process exits`);
    else
      fail_(`${label}: expected exactly one bind POST at ${expectedPath}, got ${binds.length}: ` + JSON.stringify(requests));

    if (binds.length === 1) {
      const payload = JSON.parse(binds[0].body);
      if (payload.session_id === sid) ok(`${label}: bind POST body carries the registration (session_id matches)`);
      else fail_(`${label}: bind POST body should carry the registration with matching session_id, got session_id=` + payload.session_id);
      if (payload.origin === "external") ok(`${label}: bind POST body has origin=external (no launcher pointer)`);
      else fail_(`${label}: bind POST body should have origin=external, got ` + payload.origin);
    }

    if (exitCode === 0) ok(`${label}: process exits 0`);
    else fail_(`${label}: process should exit 0, got ${exitCode}`);

    requests.length = 0;
    await waitForExit(spawnHook(form, noPortConfig, { session_id: `pav-noport-${Date.now()}-${form[0]}`, cwd: "/tmp", source: "startup" }), 10000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (requests.length === 0) ok(`${label}: no POST when pav.port is unset (no-op)`);
    else fail_(`${label}: expected no POST when pav.port unset, got ${requests.length}: ` + JSON.stringify(requests));
  }

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(configDir, { recursive: true, force: true });
  try { fs.rmSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
