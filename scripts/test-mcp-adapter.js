#!/usr/bin/env node
"use strict";
// The state server's eight engine tools, driven over JSON-RPC against the checkout's server file.
// Half one runs the server over a stub engine to pin argument handling, argv and exit mapping; half two
// runs a scripted Conductor against the real engine, making tool calls only.
// Isolation: nothing here may touch the real HOME, config, git config or sessions.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-mcp-adapter-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "tasks", "sessions", "stub"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
    STUB_DIR: path.join(t, "stub"),
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "AGENTS_TEST_SKIP_IDENTITY", "AGENTS_LAND",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_PROJECT_DIR", "ZMX_SESSION", "VIRTUAL_ENV", "POETRY_ACTIVE", "NODE_PATH"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const CHECKOUT = path.join(__dirname, "..");
const SERVER = path.join(__dirname, "state-server.js");
const REAL_A = path.join(__dirname, "bin", "a");

const db = require("./lib/db");
const taskLib = require("./lib/task");
const worktree = require("./lib/worktree");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

const NEW_TOOLS = ["add_phases", "decide", "dispatch", "land", "note", "prime", "resume", "wait"];
const OLD_TOOLS = ["code_index_build", "code_index_status", "memory_seed", "memory_status", "repo_policy", "state_add_phases", "state_clear_flag",
  "state_flag", "state_init", "state_next", "state_prime", "state_read", "state_update", "task_create", "task_set", "tasks_list", "workspace_init"];

// ---------------------------------------------------------------- a JSON-RPC client over the server's stdio

function startServer({ home, cwd, file = SERVER }) {
  const proc = spawn(process.execPath, [file], { cwd, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", id = 0, dead = false;
  const waiting = new Map();
  const toolLog = [];
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const msg = parse(line);
      const w = msg && waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w.resolve(msg); }
    }
  });
  proc.stderr.on("data", (d) => { stderr += d; });
  const closed = new Promise((resolve) => proc.on("close", (code) => {
    dead = true;
    for (const w of waiting.values()) w.reject(new Error(`server exited ${code}: ${stderr.slice(-400)}`));
    waiting.clear();
    resolve(code);
  }));
  const send = (msg) => { if (!dead) proc.stdin.write(JSON.stringify(msg) + "\n"); };
  const rpc = (method, params, ms = 330000) => new Promise((resolve, reject) => {
    const mine = ++id;
    const timer = setTimeout(() => { waiting.delete(mine); reject(new Error(`${method} timed out; stderr: ${stderr.slice(-400)}`)); }, ms);
    waiting.set(mine, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: "2.0", id: mine, method, params });
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adapter-test", version: "1" } }, 30000);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async tools() { return ((await rpc("tools/list", {}, 30000)).result.tools || []).map((t) => t.name).sort(); },
    async call(name, args) {
      toolLog.push(name);
      const msg = await rpc("tools/call", { name, arguments: args });
      if (msg.error) return { isError: true, text: JSON.stringify(msg.error), rpcError: true };
      return { isError: msg.result.isError === true, text: msg.result.content[0].text };
    },
    toolLog,
    stderr: () => stderr,
    async close() { proc.stdin.end(); const timer = setTimeout(() => proc.kill("SIGKILL"), 5000); await closed; clearTimeout(timer); },
  };
}

// ---------------------------------------------------------------- a stub engine, a home to run it from

/** A stub `a`: logs its argv, prints `reply`, writes `stderr` to stderr and exits with `exit`; the control files sit beside scripts/. */
function stubEngine(label, reply) {
  const dir = mk(label);
  fs.mkdirSync(path.join(dir, "scripts", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "bin", "a"), [
    "#!/usr/bin/env node",
    "const fs = require(\"fs\"), path = require(\"path\");",
    "const d = path.join(__dirname, \"..\", \"..\");",
    "fs.appendFileSync(path.join(d, \"argv.log\"), JSON.stringify(process.argv.slice(2)) + \"\\n\");",
    "const f = (n) => { try { return fs.readFileSync(path.join(d, n), \"utf8\"); } catch { return null; } };",
    "const reply = f(\"reply\");",
    "process.stdout.write(reply === null ? \"{}\" : reply);",
    "const err = f(\"stderr\");",
    "if (err !== null) process.stderr.write(err);",
    "const code = f(\"exit\");",
    "process.exit(code === null ? 0 : Number(code));",
    "",
  ].join("\n"), { mode: 0o755 });
  if (reply !== undefined) fs.writeFileSync(path.join(dir, "reply"), reply);
  return dir;
}
const argvLog = (dir) => { try { return fs.readFileSync(path.join(dir, "argv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function resetEngine(dir) { for (const f of ["argv.log", "reply", "stderr", "exit"]) fs.rmSync(path.join(dir, f), { force: true }); }

/** A home whose ~/.agents/bin has the recorded node and, when `current` is given, a `current` symlink to it. */
function makeHome(label, current) {
  const home = mk(label);
  fs.mkdirSync(path.join(home, ".agents", "bin"), { recursive: true });
  if (current !== null) fs.symlinkSync(process.execPath, path.join(home, ".agents", "bin", "node"));
  if (current) fs.symlinkSync(current, path.join(home, ".agents", "bin", "current"));
  return home;
}

const VALID = {
  prime: { task: "/tmp/t/task" },
  dispatch: { task: "/tmp/t/task", phase: 1, agent: "explorer", brief: "b", model: "agent" },
  wait: { task: "/tmp/t/task", run_id: 1, seconds: 1 },
  resume: { task: "/tmp/t/task", run_id: 1, brief: "b" },
  decide: { task: "/tmp/t/task", phase: 1, choice: "approve", quote: "q" },
  land: { task: "/tmp/t/task", phase: 1 },
  add_phases: { task: "/tmp/t/task", phases: [{ id: 2, name: "Two", blocked_by: [], parallel_group: null }] },
  note: { task: "/tmp/t/task", phase: 1, text: "t" },
};
const without = (tool, key) => { const a = { ...VALID[tool] }; delete a[key]; return a; };

async function stubHalf() {
  const outside = mk("outside");
  const E1 = stubEngine("engine-one");
  const E2 = stubEngine("engine-two");
  const S = makeHome("stub-home", E1);
  const server = startServer({ home: S, cwd: outside });
  await server.init();

  const listed = await server.tools();
  check(JSON.stringify(listed) === JSON.stringify([...NEW_TOOLS, ...OLD_TOOLS].sort()) && listed.length === 25,
    `AL1: tools/list names the eight engine tools and the seventeen older ones (${listed.length}: ${listed.join(" ")})`);

  const serverSrc = fs.readFileSync(SERVER, "utf8");
  const legacySrc = fs.existsSync(path.join(__dirname, "state-server-legacy.js")) ? fs.readFileSync(path.join(__dirname, "state-server-legacy.js"), "utf8") : "";
  check(!/require\(["']\.\/lib/.test(serverSrc) && !/require\(["']\.\.\/lib/.test(serverSrc) && !serverSrc.includes("node:sqlite") &&
    /require\(["']\.\/state-server-legacy["']\)/.test(serverSrc) && /require\(["']\.\/lib/.test(legacySrc),
    "AS1: the server file requires nothing under lib and loads the older tools from the legacy module, the only server file that requires lib");

  // the older tools failing to load leaves the eight up
  const broken = mk("broken-legacy");
  fs.mkdirSync(path.join(broken, "scripts"));
  fs.symlinkSync(path.join(CHECKOUT, "node_modules"), path.join(broken, "node_modules"));
  fs.copyFileSync(SERVER, path.join(broken, "scripts", "state-server.js"));
  fs.writeFileSync(path.join(broken, "scripts", "state-server-legacy.js"), "throw new Error(\"legacy boom\");\n");
  const bserver = startServer({ home: S, cwd: outside, file: path.join(broken, "scripts", "state-server.js") });
  await bserver.init();
  const blisted = await bserver.tools();
  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "{\"stub\":true}");
  const bprime = await bserver.call("prime", VALID.prime);
  const blegacy = await bserver.call("tasks_list", {});
  check(blisted.length === 25 && bprime.text === "{\"stub\":true}" && !bprime.isError && blegacy.isError && blegacy.text.includes("legacy boom"),
    `AL2: a throw loading the older tools leaves all 25 names listed, prime answering and tasks_list refusing with the load error (${blisted.length} tools; tasks_list: ${blegacy.text.slice(0, 80)})`);
  await bserver.close();

  // a server file with no node_modules reachable names the module and the file
  const bare = mk("no-modules");
  fs.mkdirSync(path.join(bare, "scripts"));
  fs.copyFileSync(SERVER, path.join(bare, "scripts", "state-server.js"));
  const bareRun = spawnSync(process.execPath, [path.join(bare, "scripts", "state-server.js")], { env: { ...process.env, HOME: S }, encoding: "utf8", input: "", timeout: 30000 });
  check(bareRun.status === 1 && bareRun.stderr.includes("cannot load @modelcontextprotocol/sdk/server/mcp.js") && bareRun.stderr.includes(path.join(bare, "scripts", "state-server.js")) && bareRun.stderr.includes("run ./install.sh"),
    `AD1: with no node_modules reachable the server exits 1 naming the missing module, its own path and ./install.sh (${bareRun.status}: ${bareRun.stderr.trim().slice(0, 200)})`);

  // every argument is required and checked before any spawn
  resetEngine(E1);
  const cases = [];
  for (const tool of Object.keys(VALID)) for (const key of Object.keys(VALID[tool])) cases.push([`${tool} without ${key}`, tool, without(tool, key)]);
  cases.push(
    ["prime with a relative task", "prime", { task: "relative/dir" }],
    ["prime with an extra project_dir", "prime", { ...VALID.prime, project_dir: "/x" }],
    ["dispatch phase 0", "dispatch", { ...VALID.dispatch, phase: 0 }],
    ["dispatch phase 1.5", "dispatch", { ...VALID.dispatch, phase: 1.5 }],
    ["dispatch agent oracle", "dispatch", { ...VALID.dispatch, agent: "oracle" }],
    ["dispatch model opus", "dispatch", { ...VALID.dispatch, model: "opus" }],
    ["dispatch empty brief", "dispatch", { ...VALID.dispatch, brief: "" }],
    ["wait seconds 0", "wait", { ...VALID.wait, seconds: 0 }],
    ["wait seconds 241", "wait", { ...VALID.wait, seconds: 241 }],
    ["wait run_id 0", "wait", { ...VALID.wait, run_id: 0 }],
    ["decide choice maybe", "decide", { ...VALID.decide, choice: "maybe" }],
    ["decide empty quote", "decide", { ...VALID.decide, quote: "" }],
    ["add_phases empty list", "add_phases", { ...VALID.add_phases, phases: [] }],
    ["add_phases phase without name", "add_phases", { ...VALID.add_phases, phases: [{ id: 2, blocked_by: [], parallel_group: null }] }],
    ["add_phases phase without blocked_by", "add_phases", { ...VALID.add_phases, phases: [{ id: 2, name: "Two", parallel_group: null }] }],
    ["add_phases phase without parallel_group", "add_phases", { ...VALID.add_phases, phases: [{ id: 2, name: "Two", blocked_by: [] }] }],
  );
  const refused = [];
  for (const [label, tool, args] of cases) {
    const r = await server.call(tool, args);
    if (!(r.isError && r.text.includes("Input validation error"))) refused.push(`${label} -> ${r.isError} ${r.text.slice(0, 60)}`);
  }
  check(refused.length === 0 && argvLog(E1).length === 0,
    `AV1: ${cases.length} calls with a missing or malformed argument are each refused as input validation errors and spawn nothing (unrefused: ${refused.join("; ") || "none"}; spawns: ${argvLog(E1).length})`);

  // values that would break naive parsing reach the engine as one word each
  resetEngine(E1);
  await server.call("prime", { task: "/tmp/t/task" });
  await server.call("dispatch", { task: "/tmp/t/task", phase: 2, agent: "builder", brief: "--help me", model: "haiku" });
  await server.call("wait", { task: "/tmp/t/task", run_id: 7, seconds: 240 });
  await server.call("resume", { task: "/tmp/t/task", run_id: 7, brief: "-h" });
  await server.call("decide", { task: "/tmp/t/task", phase: 3, choice: "answer", quote: "yes, \"go\"\n— P" });
  await server.call("land", { task: "/tmp/t/task", phase: 3 });
  await server.call("add_phases", { task: "/tmp/t/task", phases: [{ id: 5, name: "Five", blocked_by: [4], parallel_group: "A" }, { id: 6, name: "--", blocked_by: [], parallel_group: null }] });
  await server.call("note", { task: "/tmp/t/task", phase: 4, text: "--" });
  const expected = [
    ["next", "--task-dir=/tmp/t/task", "--phases", "--json"],
    ["run", "start", "--task-dir=/tmp/t/task", "--phase-id=2", "--agent=builder", "--brief=--help me", "--model=haiku", "--json"],
    ["run", "wait", "--task-dir=/tmp/t/task", "--run-id=7", "--seconds=240", "--json"],
    ["run", "resume", "--task-dir=/tmp/t/task", "--run-id=7", "--brief=-h", "--json"],
    ["decide", "--task-dir=/tmp/t/task", "--phase-id=3", "--choice=answer", "--quote=yes, \"go\"\n— P", "--json"],
    ["land", "--task-dir=/tmp/t/task", "--phase-id=3", "--json"],
    ["state", "add-phases", "--task-dir=/tmp/t/task", "--phases-json=[{\"id\":5,\"name\":\"Five\",\"blocked_by\":[4],\"parallel_group\":\"A\"},{\"id\":6,\"name\":\"--\",\"blocked_by\":[],\"parallel_group\":null}]", "--json"],
    ["note", "--task-dir=/tmp/t/task", "--phase-id=4", "--text=--", "--json"],
  ];
  check(JSON.stringify(argvLog(E1)) === JSON.stringify(expected), `AT1: each tool's argv is exactly its engine command, every value one --flag=value word (${JSON.stringify(argvLog(E1)).slice(0, 200)}...)`);

  // each call follows `current` at call time
  resetEngine(E1);
  resetEngine(E2);
  fs.writeFileSync(path.join(E1, "reply"), "{\"from\":\"E1\"}");
  fs.writeFileSync(path.join(E2, "reply"), "{\"from\":\"E2\"}");
  const first = await server.call("prime", VALID.prime);
  fs.rmSync(path.join(S, ".agents", "bin", "current"));
  fs.symlinkSync(E2, path.join(S, ".agents", "bin", "current"));
  const second = await server.call("prime", VALID.prime);
  check(first.text === "{\"from\":\"E1\"}" && second.text === "{\"from\":\"E2\"}", `AC1: the same server's next call runs the engine current now names (${first.text} then ${second.text})`);
  fs.rmSync(path.join(S, ".agents", "bin", "current"));
  fs.symlinkSync(E1, path.join(S, ".agents", "bin", "current"));

  // exit mapping
  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "{\"ok\": true}\n");
  const ok = await server.call("prime", VALID.prime);
  check(ok.text === "{\"ok\": true}\n" && !ok.isError, `AE1: exit 0 returns the engine's stdout byte for byte (${JSON.stringify(ok.text)})`);

  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "{\"error\":\"step_check\",\"message\":\"m\"}");
  fs.writeFileSync(path.join(E1, "stderr"), "m");
  fs.writeFileSync(path.join(E1, "exit"), "2");
  const refusal = await server.call("dispatch", VALID.dispatch);
  const rbody = parse(refusal.text);
  check(refusal.isError && rbody && rbody.exit === 2 && rbody.error && rbody.error.error === "step_check" && rbody.error.message === "m" && rbody.stderr === "m",
    `AE2: a coded refusal comes back isError with exit, the parsed error object and stderr (${refusal.text})`);

  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "not json at all");
  fs.writeFileSync(path.join(E1, "exit"), "1");
  const raw = await server.call("land", VALID.land);
  const rawBody = parse(raw.text);
  check(raw.isError && rawBody && rawBody.exit === 1 && rawBody.error === "not json at all", `AE3: a failure with a non-JSON reply carries the raw text (${raw.text})`);
  await server.close();

  // a home with no engine
  const M = makeHome("no-engine-home", undefined);
  const mserver = startServer({ home: M, cwd: outside });
  await mserver.init();
  const noEngine = await mserver.call("prime", VALID.prime);
  check(noEngine.isError && noEngine.text.includes(path.join(M, ".agents", "bin", "current", "scripts", "bin", "a")) && noEngine.text.includes("./install.sh"),
    `AM1: with no current the call is refused naming the engine path and ./install.sh (${noEngine.text})`);
  await mserver.close();
  const N = makeHome("no-node-home", null);
  const nserver = startServer({ home: N, cwd: outside });
  await nserver.init();
  const noNode = await nserver.call("prime", VALID.prime);
  check(noNode.isError && noNode.text.includes(path.join(N, ".agents", "bin", "node")) && noNode.text.includes("./install.sh"),
    `AM2: with no recorded node the call is refused naming the node path and ./install.sh (${noNode.text})`);
  await nserver.close();
}

// ---------------------------------------------------------------- half two: a scripted Conductor on the real engine

async function engineHalf() {
  const outside = mk("outside-engine");
  fs.writeFileSync(path.join(T, "stubbin", "claude"), [
    "#!/bin/sh",
    "echo \"$*\" >> \"$STUB_DIR/claude.log\"",
    "[ -f \"$STUB_DIR/stream\" ] && cat \"$(cat \"$STUB_DIR/stream\")\"",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = `${path.join(T, "stubbin")}:${process.env.PATH}`;
  const claudeLog = () => { try { return fs.readFileSync(path.join(process.env.STUB_DIR, "claude.log"), "utf8"); } catch { return ""; } };

  db.open({ create: true });
  const origin = path.join(T, "origin.git");
  git(T, "init", "-q", "--bare", "-b", "main", origin);
  const repoDir = path.join(T, "work", "acme");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
  git(repoDir, "remote", "add", "origin", origin);
  git(repoDir, "push", "-q", "-u", "origin", "main");
  git(repoDir, "remote", "set-head", "origin", "main");
  const key = repoKey(repoDir);
  fs.writeFileSync(path.join(process.env.HOME, ".claude", "repo-policies.json"), JSON.stringify({ [key.main_root]: "direct" }));

  const made = taskLib.createTask({ repo: key, title: "adapter", slug: "adapter", mode: "full", tier: "standard", phases: [{ id: 1, name: "One" }], description: "" });
  const task = made.task_dir;
  let wt = null;
  const filesDir = taskLib.filesDir(task);
  fs.mkdirSync(path.join(filesDir, "plan"), { recursive: true });

  // current is a recording wrapper around the checkout's engine: the argv log is what the server really ran
  const engineArgv = path.join(T, "engine-argv.log");
  const wrapper = mk("wrapper");
  fs.mkdirSync(path.join(wrapper, "scripts", "bin"), { recursive: true });
  fs.writeFileSync(path.join(wrapper, "scripts", "bin", "a"), [
    "#!/usr/bin/env node",
    "const fs = require(\"fs\");",
    "const { spawnSync } = require(\"child_process\");",
    `fs.appendFileSync(${JSON.stringify(engineArgv)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `const r = spawnSync(process.execPath, [${JSON.stringify(REAL_A)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
    "process.exit(r.status === null ? 1 : r.status);",
    "",
  ].join("\n"), { mode: 0o755 });
  const R = process.env.HOME;
  fs.mkdirSync(path.join(R, ".agents", "bin"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(R, ".agents", "bin", "node"));
  fs.symlinkSync(wrapper, path.join(R, ".agents", "bin", "current"));

  const server = startServer({ home: R, cwd: outside });
  await server.init();

  const streamFile = (out) => {
    const file = path.join(mk("stream"), "stream.jsonl");
    const lines = [{ type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/x", session_id: "s" },
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 10, num_turns: 1, permission_denials: [], modelUsage: { "claude-sonnet-5-5": {} }, terminal_reason: "completed", result: "done", structured_output: out }];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(path.join(process.env.STUB_DIR, "stream"), file);
  };
  const reportFor = (agent, phaseId) => {
    if (agent === "explorer") return { phase_id: phaseId, plan_path: `plan/phase-${phaseId}.md`, manifest: [`feature-${phaseId}.txt`], open_questions: [], summary: "planned" };
    if (agent === "reviewer") return { phase_id: phaseId, verdict: "pass", issues: [], summary: "looks right" };
    if (agent === "builder") return { phase_id: phaseId, files_touched: [`feature-${phaseId}.txt`], verification: [{ cmd: `test -f feature-${phaseId}.txt`, exit: 0, summary: "present" }], deviations: [], summary: "built" };
    fs.writeFileSync(path.join(wt.path, `feature-${phaseId}.txt`), `phase ${phaseId}\n`);
    git(wt.path, "add", `feature-${phaseId}.txt`);
    git(wt.path, "commit", "-q", "-m", `feat: phase ${phaseId}`);
    return { phase_id: phaseId, commits: [{ sha: git(wt.path, "rev-parse", "HEAD").slice(0, 10), files: [`feature-${phaseId}.txt`], message: `feat: phase ${phaseId}` }], pushed: false };
  };

  const expectedReport = new Map();
  const waits = [];
  const lands = [];
  const quotes = { 1: "--help", 2: "Go ahead with phase 2 — \"carefully\"" };
  const prime = async () => parse((await server.call("prime", { task })).text);
  const waitFor = async (runId) => {
    for (let i = 0; i < 6; i++) {
      const r = parse((await server.call("wait", { task, run_id: runId, seconds: 60 })).text);
      if (r && r.finished) { waits.push(r); return r; }
    }
    return null;
  };

  const added = await server.call("add_phases", { task, phases: [{ id: 2, name: "Two", blocked_by: [1], parallel_group: null }] });
  // the worktree comes after the second phase exists, so both phases run on its branch
  wt = worktree.add({ projectDir: repoDir, taskDir: task, force: true });
  let last = null, noEmptyPhases = true, noted = false, firstExplorer = true;
  for (let turn = 0; turn < 50; turn++) {
    const p = await prime();
    last = p;
    if (!p) break;
    if (!p.phases || !p.phases.some((x) => x.id === 1) || !p.phases.some((x) => x.id === 2)) noEmptyPhases = false;
    if (!noted && p.phases && p.phases.some((x) => x.id === 1 && x.status === "landed")) {
      noted = true;
      await server.call("note", { task, phase: 1, text: "landed through the adapter" });
    }
    if (p.step === "consolidate" || !p.call) break;
    const c = p.call;
    if (c.verb === "run start") {
      if (c.agent === "explorer") fs.writeFileSync(path.join(filesDir, "plan", `phase-${c.phase_id}.md`), `# plan ${c.phase_id}\n`);
      let out = reportFor(c.agent, c.phase_id);
      if (c.agent === "explorer" && firstExplorer) { firstExplorer = false; out = undefined; }
      streamFile(out);
      const started = parse((await server.call("dispatch", { task, phase: c.phase_id, agent: c.agent, brief: `Brief for ${c.agent} on phase ${c.phase_id}`, model: "agent" })).text);
      if (!started) break;
      expectedReport.set(started.run_id, out === undefined ? null : JSON.stringify(out));
      await waitFor(started.run_id);
    } else if (c.verb === "run resume") {
      const out = reportFor(c.agent, c.phase_id);
      streamFile(out);
      const resumed = parse((await server.call("resume", { task, run_id: c.run_id, brief: "Resume and finish the plan" })).text);
      if (!resumed) break;
      expectedReport.set(resumed.run_id, JSON.stringify(out));
      await waitFor(resumed.run_id);
    } else if (c.verb === "decide") {
      await server.call("decide", { task, phase: c.phase_id, choice: c.choices[0], quote: quotes[c.phase_id] });
    } else if (c.verb === "land") {
      lands.push(parse((await server.call("land", { task, phase: c.phase_id })).text));
    } else {
      break;
    }
  }
  await server.close();

  const ro = db.open({ readonly: true });
  const doc = JSON.parse(fs.readFileSync(path.join(task, "task.json"), "utf8"));
  const runs = ro.all("SELECT agent, status FROM runs ORDER BY run_id");
  const decisions = ro.all("SELECT choice, quote FROM decisions ORDER BY decision_id");
  const onOrigin = git(origin, "log", "main", "--format=%s");
  const ran = engineArgvVerbs(engineArgv);

  check(doc.phases.length === 2 && doc.phases.every((p) => p.status === "landed") && last && last.step === "consolidate" && last.call && last.call.agent === "consolidator",
    `AR1: both phases landed and the last step is consolidate with the consolidator call (${doc.phases.map((p) => p.status)}; ${last && last.step})`);
  check(runs.length === 11 && runs[0].agent === "explorer" && runs[0].status === "no_report" && runs.slice(1).every((r) => r.status === "succeeded"),
    `AR1: eleven runs, the first explorer no_report and ten succeeded (${runs.map((r) => r.agent + ":" + r.status).join(" ")})`);
  check(decisions.length === 2 && decisions.every((d) => d.choice === "approve") && decisions[0].quote === "--help" && decisions[1].quote === "Go ahead with phase 2 — \"carefully\"",
    `AR1: two approvals stored with the owner's words byte for byte (${JSON.stringify(decisions.map((d) => d.quote))})`);
  check(doc.phases[0].note === "landed through the adapter", `AR1: phase 1's note is the text the note tool was given (${JSON.stringify(doc.phases[0].note)})`);
  check(onOrigin.includes("feat: phase 1") && onOrigin.includes("feat: phase 2"), `AR1: origin's main has both commits (${onOrigin.split("\n").join(" / ")})`);
  check(lands.length === 2 && lands.every((l, i) => l && l.landed === true && l.reverified.some((r) => r.cmd === `test -f feature-${i + 1}.txt` && r.exit === 0)),
    `AR1: each land result holds its recorded check re-run with exit 0 (${lands.map((l) => JSON.stringify(l && l.reverified && l.reverified.map((r) => r.cmd))).join(" ")})`);
  const succeeded = waits.filter((w) => w.run.status === "succeeded");
  check(succeeded.length === 10 && succeeded.every((w) => JSON.stringify(w.report) === expectedReport.get(w.run.run_id)),
    `AR1: every wait that finished a succeeded run returned the agent's report as stored (${succeeded.length} of them)`);
  check(added.isError === false && noEmptyPhases, "AR1: every prime after add_phases carried phases with both ids");
  check(JSON.stringify([...new Set(server.toolLog)].sort()) === JSON.stringify(NEW_TOOLS) && ran.length > 0 &&
    JSON.stringify([...new Set(ran)].sort()) === JSON.stringify(["decide", "land", "next", "note", "run resume", "run start", "run wait", "state add-phases"]),
    `AR1: only the eight tools were called, and the engine ran only their eight commands (tools: ${[...new Set(server.toolLog)].sort().join(",")}; verbs: ${[...new Set(ran)].sort().join(", ")})`);

  // a run of another task is refused
  const second = taskLib.createTask({ repo: key, title: "other", slug: "other", mode: "full", tier: "standard", phases: [{ id: 1, name: "One" }], description: "" }).task_dir;
  const before = JSON.stringify(ro.all("SELECT * FROM runs WHERE run_id = 1"));
  const server2 = startServer({ home: R, cwd: outside });
  await server2.init();
  const launchedBefore = claudeLog();
  const wrong = await server2.call("wait", { task: second, run_id: 1, seconds: 1 });
  const wrongResume = await server2.call("resume", { task: second, run_id: 1, brief: "b" });
  const wbody = parse(wrong.text), rbody = parse(wrongResume.text);
  check(wrong.isError && wbody && wbody.error && wbody.error.error === "wrong_task" && wrongResume.isError && rbody && rbody.error && rbody.error.error === "wrong_task" &&
    JSON.stringify(ro.all("SELECT * FROM runs WHERE run_id = 1")) === before && ro.all("SELECT run_id FROM runs").length === 11 && claudeLog() === launchedBefore,
    `AR2: waiting on or resuming another task's run is refused wrong_task, the run is untouched and no agent starts (${wrong.text.slice(0, 160)})`);

  // a task the index cannot place is refused, and the server's home is never used as a checkout
  const homeBefore = JSON.stringify(listTree(R));
  const copy = path.join(mk("elsewhere"), path.basename(task));
  fs.cpSync(task, copy, { recursive: true });
  const logBefore = claudeLog();
  const primeCopy = await server2.call("prime", { task: copy });
  const dispatchCopy = await server2.call("dispatch", { task: copy, phase: 1, agent: "explorer", brief: "b", model: "agent" });
  const pbody = parse(primeCopy.text), dbody = parse(dispatchCopy.text);
  check(primeCopy.isError && pbody && pbody.error && pbody.error.error === "not_indexed" && dispatchCopy.isError && dbody && dbody.error && dbody.error.error === "not_indexed" &&
    claudeLog() === logBefore && JSON.stringify(listTree(R)) === homeBefore,
    `AN1: a task outside the tasks root's index is refused not_indexed by prime and dispatch, no agent starts and the server's home gains no file (${primeCopy.text.slice(0, 120)})`);
  await server2.close();
}

function engineArgvVerbs(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  return lines.map((a) => (a[0] === "run" || a[0] === "state" ? `${a[0]} ${a[1]}` : a[0]));
}

/** Every path under `dir`, sorted, symlinks not followed. */
function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

(async () => {
  try {
    await stubHalf();
    await engineHalf();
  } catch (err) {
    fail++;
    console.log("FAIL: the adapter suite threw: " + (err && err.stack || err));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
