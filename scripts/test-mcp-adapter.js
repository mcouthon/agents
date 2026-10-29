#!/usr/bin/env node
"use strict";
// The state server's engine tools and its two code-index tools, driven over JSON-RPC against the checkout's server file.
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

const STATE_TOOLS = ["add_phases", "check_phase", "decide", "land", "note", "prime", "task_read"];
const CODE_INDEX_TOOLS = ["code_index_build", "code_index_status"];

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
  decide: { task: "/tmp/t/task", phase: 1, choice: "approve", quote: "q" },
  land: { task: "/tmp/t/task" },
  add_phases: { task: "/tmp/t/task", phases: [{ id: 2, name: "Two", after: [] }] },
  note: { task: "/tmp/t/task", phase: 1, text: "t" },
  task_read: { task: "/tmp/t/task" },
  check_phase: { task: "/tmp/t/task", phase: 1 },
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
  check(JSON.stringify(listed) === JSON.stringify([...STATE_TOOLS, ...CODE_INDEX_TOOLS].sort()),
    `AL1: tools/list names the engine tools and the two code-index tools, nothing else (${listed.join(" ")})`);
  const serverSrc = fs.readFileSync(SERVER, "utf8");
  check(!/legacy/.test(serverSrc) && !fs.readdirSync(__dirname).some((n) => /^state-server-.+\.js$/.test(n)), "AS1: no second server module exists and nothing loads one");
  const lib = [...serverSrc.matchAll(/require\(["'](\.\/lib\/[^"']+)["']\)/g)].map((m) => m[1]).sort();
  check(JSON.stringify([...new Set(lib)]) === JSON.stringify(["./lib/code-index", "./lib/project-dir"]) && !serverSrc.includes("node:sqlite"),
    `AS1: the only lib requires are the code-index pair (${lib.join(" ")})`);
  check(/name: "land"[\s\S]*?seconds: 900/.test(serverSrc), "AL3: land carries the 900 s ceiling");

  const noCfg = await server.call("code_index_status", {});
  check(!noCfg.isError && noCfg.text.startsWith("not_configured"), `AC1: code_index_status with no config returns not_configured (${noCfg.text.slice(0, 60)})`);

  // each tool runs exactly its engine command
  resetEngine(E1);
  const calls = {
    prime: VALID.prime,
    task_read: VALID.task_read,
    add_phases: VALID.add_phases,
    check_phase: { task: "/tmp/t/task", phase: 2 },
    decide: { task: "/tmp/t/task", phase: 3, choice: "answer", quote: 'yes, "go"\n— P' },
    note: { task: "/tmp/t/task", phase: 4, text: "a note" },
    land: { task: "/tmp/t/task", check: ["zsh scripts/check.sh", "npm test"], policy: "pr" },
  };
  for (const [name, args] of Object.entries(calls)) await server.call(name, args);
  const argv = argvLog(E1);
  const expected = [
    ["next", "--task-dir=/tmp/t/task", "--json"],
    ["task", "read", "--task-dir=/tmp/t/task", "--json"],
    ["task", "add-phases", "--task-dir=/tmp/t/task", `--phases-json=${JSON.stringify([{ id: 2, name: "Two", after: [] }])}`, "--json"],
    ["task", "check", "--task-dir=/tmp/t/task", "--phase-id=2", "--json"],
    ["decide", "--task-dir=/tmp/t/task", "--phase-id=3", "--choice=answer", '--quote=yes, "go"\n— P', "--json"],
    ["task", "note", "--task-dir=/tmp/t/task", "--phase-id=4", "--text=a note", "--json"],
    ["land", "--task-dir=/tmp/t/task", "--check=zsh scripts/check.sh", "--check=npm test", "--policy=pr", "--json"],
  ];
  check(JSON.stringify(argv) === JSON.stringify(expected), `AT1: each tool's argv is exactly its engine command (${JSON.stringify(argv).slice(0, 200)})`);
  resetEngine(E1);
  await server.call("land", VALID.land);
  check(JSON.stringify(argvLog(E1)) === JSON.stringify([["land", "--task-dir=/tmp/t/task", "--json"]]), "AT1: land with no checks or policy passes neither flag");

  // malformed arguments are input errors and spawn nothing
  resetEngine(E1);
  const bad = [];
  const rows = [
    ["prime without task", "prime", {}],
    ["decide without task", "decide", without("decide", "task")],
    ["decide without phase", "decide", without("decide", "phase")],
    ["decide without choice", "decide", without("decide", "choice")],
    ["decide without quote", "decide", without("decide", "quote")],
    ["note without text", "note", without("note", "text")],
    ["add_phases without phases", "add_phases", without("add_phases", "phases")],
    ["land without task", "land", {}],
    ["decide choice override", "decide", { ...VALID.decide, choice: "override" }],
    ["decide choice abort", "decide", { ...VALID.decide, choice: "abort" }],
    ["decide empty quote", "decide", { ...VALID.decide, quote: "" }],
    ["decide phase 0", "decide", { ...VALID.decide, phase: 0 }],
    ["add_phases blocked_by", "add_phases", { ...VALID.add_phases, phases: [{ id: 2, name: "Two", blocked_by: [] }] }],
    ["add_phases empty", "add_phases", { ...VALID.add_phases, phases: [] }],
    ["land policy other", "land", { ...VALID.land, policy: "ask" }],
    ["land phase", "land", { ...VALID.land, phase: 1 }],
    ["relative task", "prime", { task: "task" }],
    ["task_read without task", "task_read", {}],
    ["check_phase without phase", "check_phase", without("check_phase", "phase")],
    ["check_phase phase 0", "check_phase", { ...VALID.check_phase, phase: 0 }],
    ["check_phase relative task", "check_phase", { task: "task", phase: 1 }],
  ];
  for (const [label, name, args] of rows) {
    const r = await server.call(name, args);
    if (!r.isError) bad.push(`${label} -> ${r.text.slice(0, 50)}`);
  }
  check(bad.length === 0 && argvLog(E1).length === 0, `AV1: ${rows.length} malformed calls are refused and spawn nothing (${bad.join("; ")}; spawns: ${argvLog(E1).length})`);

  // exit mapping
  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), JSON.stringify({ error: "policy_unlisted", message: "no policy", remedy: "a land --policy pr|direct" }));
  fs.writeFileSync(path.join(E1, "stderr"), "no policy\n");
  fs.writeFileSync(path.join(E1, "exit"), "2");
  const refused = await server.call("land", VALID.land);
  const body = parse(refused.text);
  check(refused.isError && body && body.exit === 2 && body.error && body.error.remedy === "a land --policy pr|direct" && body.stderr === "no policy\n", `AE2: a coded refusal comes back isError with exit, the parsed error object and stderr (${refused.text.slice(0, 120)})`);
  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "plain words, not json");
  fs.writeFileSync(path.join(E1, "exit"), "1");
  const raw = await server.call("prime", VALID.prime);
  check(raw.isError && parse(raw.text).error === "plain words, not json", "AE3: a failure with a non-JSON reply carries the raw text");
  resetEngine(E1);
  fs.writeFileSync(path.join(E1, "reply"), "{\"ok\":true}");
  const fine = await server.call("prime", VALID.prime);
  check(!fine.isError && fine.text === "{\"ok\":true}", "AE1: a clean exit returns the engine's stdout as the text");

  // the engine is chosen per call: repointing `current` takes effect without a restart
  resetEngine(E1);
  resetEngine(E2);
  fs.rmSync(path.join(S, ".agents", "bin", "current"));
  fs.symlinkSync(E2, path.join(S, ".agents", "bin", "current"));
  await server.call("prime", VALID.prime);
  check(argvLog(E2).length === 1 && argvLog(E1).length === 0, "AC2: repointing current is seen by the next call");
  await server.close();

  const bare = makeHome("bare-home", null);
  const s2 = startServer({ home: bare, cwd: outside });
  await s2.init();
  const miss = await s2.call("prime", VALID.prime);
  check(miss.isError && /is missing; run \.\/install\.sh/.test(miss.text), `AM1: a missing engine is refused naming ./install.sh (${miss.text.slice(0, 80)})`);
  await s2.close();
}

/** A scripted Conductor against the real engine: tool calls only. */
async function realHalf() {
  const root = mk("real");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  db.open({ create: true });
  const created = taskLib.createTask({ repo: repoKey(repo), title: "Real", slug: "real", session_id: "s", phases: [{ id: 1, name: "One" }] });
  const home = makeHome("real-home", CHECKOUT);
  const server = startServer({ home, cwd: root });
  await server.init();
  const task = created.task_dir;
  const prime = parse((await server.call("prime", { task })).text);
  check(prime && prime.advice && prime.advice.move === "plan" && prime.advice.phase.id === 1, `AR1: prime on a fresh task says plan (${prime && prime.advice && prime.advice.move})`);
  const added = parse((await server.call("add_phases", { task, phases: [{ id: 2, name: "Two", after: [1] }] })).text);
  check(added && added.phases.length === 2 && added.phases[1].status === "not_started", "AR1: add_phases appends a not_started phase");
  const decided = parse((await server.call("decide", { task, phase: 1, choice: "answer", quote: "keep it small" })).text);
  check(decided && decided.quote === "keep it small" && decided.advice.move === "plan", "AR1: decide records the owner's words and returns the advice");
  const read = parse((await server.call("task_read", { task })).text);
  check(read && read.phases.length === 2 && read.knobs.approvals === "ask", "AR1: task_read returns the task with its phases and the approvals knob");
  const checkedP = parse((await server.call("check_phase", { task, phase: 1 })).text);
  check(checkedP && checkedP.status === "done" && checkedP.checked_at, "AR1: check_phase marks the phase done");
  const afterCheck = parse((await server.call("prime", { task })).text);
  check(afterCheck && afterCheck.advice.phase && afterCheck.advice.phase.id === 2, `AR1: prime after check_phase moves to the next phase (${afterCheck && afterCheck.advice.phase && afterCheck.advice.phase.id})`);
  const unknownPhase = await server.call("check_phase", { task, phase: 9 });
  check(unknownPhase.isError && /Remedy:.*add_phases/.test(unknownPhase.text), `AR1: check_phase on an unknown phase is refused with its remedy (${unknownPhase.text.slice(0, 160)})`);
  const noted = parse((await server.call("note", { task, phase: 1, text: "from the Conductor" })).text);
  check(noted && noted.phase.note === "from the Conductor", "AR1: note sets the phase note");
  const refused = await server.call("land", { task });
  const err = parse(refused.text);
  check(refused.isError && err && err.exit === 2 && err.error.error === "policy_unlisted" && /--policy pr\|direct/.test(err.error.remedy), `AR1: an unlisted repo's land is refused with its remedy over MCP (${refused.text.slice(0, 140)})`);
  await server.close();
}

(async () => {
  await stubHalf();
  await realHalf();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.log("FAIL: " + (err && err.stack || err)); process.exit(1); });
