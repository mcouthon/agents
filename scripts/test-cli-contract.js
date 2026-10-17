#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const CLI = path.join(__dirname, "bin", "a");
const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-cli-contract-")));

// Isolate the session registry to a tmpdir so this test never writes to the
// real ~/.agents/sessions. runCli inherits this via process.env.
process.env.AGENTS_SESSIONS_ROOT = path.join(tmpBase, "sessions");
fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true });

function makeRepo(name) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function runCli(repoPath, args) {
  const fullArgs = [...args, "--repo", repoPath, "--json"];
  const out = execFileSync("node", [CLI, ...fullArgs], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function matchShape(actual, golden, p = "root") {
  if (golden === "<string>") {
    if (typeof actual !== "string") throw `${p}: expected string, got ${typeof actual}`;
  } else if (golden === "<number>") {
    if (typeof actual !== "number") throw `${p}: expected number, got ${typeof actual}`;
  } else if (golden === "<boolean>") {
    if (typeof actual !== "boolean") throw `${p}: expected boolean, got ${typeof actual}`;
  } else if (golden === "<any>") {
    if (actual === undefined) throw `${p}: expected any value, got undefined`;
  } else if (Array.isArray(golden)) {
    if (!Array.isArray(actual)) throw `${p}: expected array`;
    if (golden.length > 0 && actual.length > 0) matchShape(actual[0], golden[0], `${p}[]`);
  } else if (typeof golden === "object" && golden !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual))
      throw `${p}: expected object, got ${actual === null ? "null" : typeof actual}`;
    const gk = new Set(Object.keys(golden));
    const ak = new Set(Object.keys(actual));
    for (const k of gk) {
      if (!ak.has(k)) throw `${p}: missing key "${k}"`;
      matchShape(actual[k], golden[k], `${p}.${k}`);
    }
    for (const k of ak) {
      if (!gk.has(k)) throw `${p}: unexpected key "${k}"`;
    }
  } else {
    if (actual !== golden) throw `${p}: expected ${JSON.stringify(golden)}, got ${JSON.stringify(actual)}`;
  }
}

const repo = makeRepo("contract-repo");

// 1. repo key
try {
  const out = runCli(repo, ["repo", "key"]);
  matchShape(out, {
    main_root: "<string>",
    origin_slug: "<string>",
    base: "<string>",
    key: "<string>",
  });
  ok("repo key --json shape matches golden");
} catch (e) { fail_("repo key: " + e); }

// 2. tasks root
try {
  const out = runCli(repo, ["tasks", "root"]);
  matchShape(out, { root: "<string>" });
  ok("tasks root --json shape matches golden");
} catch (e) { fail_("tasks root: " + e); }

// 3. task create
let createdTask;
try {
  createdTask = runCli(repo, ["task", "create", "--title", "Contract Test", "--slug", "contract-test", "--phases-json", '[{"id":1,"name":"Phase 1"}]']);
  matchShape(createdTask, {
    task_dir: "<string>",
    slug: "<string>",
    number: "<number>",
  });
  if (createdTask.number === 1) ok("task create --json shape matches golden (number=1)");
  else fail_("task create number should be 1");
} catch (e) { fail_("task create: " + e); }

// 4. task list
try {
  const out = runCli(repo, ["task", "list"]);
  matchShape(out, {
    updated: "<string>",
    tasks: [{
      slug: "<string>",
      dir: "<string>",
      status: "<string>",
      total_phases: "<number>",
      completed_phases: "<number>",
      current_phase: "<any>",
      flags: "<number>",
      updated: "<string>",
    }],
  });
  ok("task list --json shape matches golden");
} catch (e) { fail_("task list: " + e); }

// 5. task read
try {
  const out = runCli(repo, ["task", "read", "--task-dir", createdTask.slug]);
  matchShape(out, {
    schema_version: "<number>",
    task: "<string>",
    status: "<string>",
    updated: "<string>",
    phases: [],
    flags: [],
  });
  ok("task read --json shape matches golden");
} catch (e) { fail_("task read: " + e); }

// 6. state update
try {
  const out = runCli(repo, ["state", "update", "--task-dir", createdTask.slug, "--task-status", "in_progress"]);
  matchShape(out, { updated: "<string>" });
  ok("state update --json shape matches golden");
} catch (e) { fail_("state update: " + e); }

// 7. state flag
let flagId;
try {
  const out = runCli(repo, ["state", "flag", "--task-dir", createdTask.slug, "--phase-id", "1", "--type", "blocked", "--message", "test"]);
  matchShape(out, {
    id: "<string>",
    phase: "<number>",
    type: "<string>",
    total_flags: "<number>",
  });
  flagId = out.id;
  ok("state flag --json shape matches golden");
} catch (e) { fail_("state flag: " + e); }

// 8. state clear-flag
try {
  const out = runCli(repo, ["state", "clear-flag", "--task-dir", createdTask.slug, "--flag-id", flagId]);
  matchShape(out, {
    removed: "<string>",
    remaining: "<number>",
  });
  ok("state clear-flag --json shape matches golden");
} catch (e) { fail_("state clear-flag: " + e); }

// 9. state add-phases
try {
  const phasesJson = JSON.stringify([{ id: 2, name: "Phase 2" }]);
  const out = runCli(repo, ["state", "add-phases", "--task-dir", createdTask.slug, "--phases-json", phasesJson]);
  matchShape(out, {
    added: "<number>",
    summary: "<string>",
    total: "<number>",
  });
  ok("state add-phases --json shape matches golden");
} catch (e) { fail_("state add-phases: " + e); }

// 10. state prime
try {
  const out = runCli(repo, ["state", "prime", "--task-dir", createdTask.slug]);
  matchShape(out, {
    task: "<string>",
    status: "<string>",
    phases_done: "<number>",
    phases_total: "<number>",
    current: "<string>",
    flags: "<number>",
  });
  ok("state prime --json shape matches golden");
} catch (e) { fail_("state prime: " + e); }

// 11. policy
try {
  const out = runCli(repo, ["policy"]);
  matchShape(out, {
    push: "<string>",
    worktree: "<string>",
    merge: "<string>",
    base: "<string>",
    source: "<string>",
  });
  ok("policy --json shape matches golden");
} catch (e) { fail_("policy: " + e); }

// 12. session register
const testSid = `contract-${Date.now()}`;
try {
  const out = runCli(repo, ["session", "register", "--session-id", testSid, "--agent", "conductor"]);
  matchShape(out, {
    registration: {
      schema: "<number>",
      origin: "<string>",
      session_id: "<string>",
      terminal_id: "<any>",
      workflow_id: "<any>",
      task_dir: "<any>",
      commitment_id: "<any>",
      project_id: "<any>",
      initiator: "<any>",
      agent: "<string>",
      repo_key: "<any>",
      cwd: "<string>",
      pid: "<any>",
      transcript_path: "<any>",
      tmux: "<any>",
      created_at: "<string>",
      updated_at: "<string>",
    },
    lease: "<any>",
    session_dir: "<string>",
  });
  ok("session register --json shape matches golden");
} catch (e) { fail_("session register: " + e); }

// 13. session ls
try {
  const out = runCli(repo, ["session", "ls"]);
  matchShape(out, [{
    schema: "<number>",
    origin: "<string>",
    session_id: "<string>",
    terminal_id: "<any>",
    workflow_id: "<any>",
    task_dir: "<any>",
    commitment_id: "<any>",
    project_id: "<any>",
    initiator: "<any>",
    agent: "<any>",
    repo_key: "<any>",
    cwd: "<any>",
    pid: "<any>",
    transcript_path: "<any>",
    tmux: "<any>",
    created_at: "<string>",
    updated_at: "<string>",
  }]);
  ok("session ls --json shape matches golden");
} catch (e) { fail_("session ls: " + e); }

// 13a. session touch --json
try {
  const out = runCli(repo, ["session", "touch", "--session-id", testSid]);
  matchShape(out, { touched: "<boolean>" });
  ok("session touch --json shape matches golden");
} catch (e) { fail_("session touch: " + e); }

// 13b. cc ls --json (tmux-absent path: tmux_sessions is empty when no pav
// tmux server is running; the golden tolerates a running server too)
try {
  const out = runCli(repo, ["cc", "ls"]);
  matchShape(out, { sessions: [], tmux_sessions: ["<string>"] });
  const found = out.sessions.some((s) => s && s.session_id === testSid);
  if (!found) throw `sessions should include registered testSid ${testSid}`;
  ok("cc ls --json shape matches golden (sessions + tmux_sessions arrays)");
} catch (e) { fail_("cc ls: " + e); }

// 14. session unregister
try {
  const out = runCli(repo, ["session", "unregister", "--session-id", testSid]);
  matchShape(out, { unregistered: "<boolean>" });
  ok("session unregister --json shape matches golden");
} catch (e) { fail_("session unregister: " + e); }

// 15. Deliberately-broken golden — proves the guard can fail
try {
  const out = runCli(repo, ["repo", "key"]);
  matchShape(out, {
    main_root: "<string>",
    origin_slug: "<string>",
    base: "<string>",
    key: "<string>",
    extra_key_that_does_not_exist: "<string>",
  });
  fail_("deliberately-broken golden should have failed but passed");
} catch (e) {
  ok("deliberately-broken golden correctly fails: " + e);
}

// 16. launch with flags does not exit 2 (usage error)
// `a launch --agent test --cwd /tmp` should parse correctly and attempt
// to launch (failing with exit 1 because `claude` is not on PATH), NOT
// exit 2 with a usage message.
try {
  let exitCode = null;
  try {
    execFileSync("node", [CLI, "launch", "--agent", "test", "--cwd", tmpBase], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode !== 2) ok(`launch with flags exits ${exitCode} (not 2/usage)`);
  else fail_("launch with flags should not exit 2 (usage error)");
} catch (e) { fail_("launch test: " + e); }

// Cleanup
try { require("./lib/session").unregister(testSid); } catch {}
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
