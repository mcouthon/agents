#!/usr/bin/env node
"use strict";

// The PAV-hosted bootstrap rung: a start whose repo has a configured worktree
// setup and whose config names pav.port creates the pane through PAV's
// terminal API (POST /api/coding/terminals), injects `a setup run` into its
// shell by raw chunked zmx send, and confirms the launch with the belt — the
// record's pid landing. The CLI children are spawned ASYNCHRONOUSLY: a sync
// spawn blocks the parent's event loop, so the HTTP server could never answer
// the child's own curl (test-post-to-pav.js's lesson). A temp http server
// stands in for the daemon; zmx and claude are stubs in the ST suite's style.
// Isolation: nothing here touches the real HOME, config, git config, zmx or a
// live PAV.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-setup-pav-")));
  for (const d of ["home", "xdg", "logs", "stubbin", "claudebin", "xdg-data"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"), { recursive: true });
  fs.mkdirSync(path.join(t, "home", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(t, "home", ".agents", "repo-policies.json"), "{}");
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    XDG_DATA_HOME: path.join(t, "xdg-data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "ZMX_SESSION",
    "ZMX_PATCH_RECORD", "ZMX_PATCH_PID", "AGENTS_SETUP_TIMEOUT_MS", "AGENTS_SETUP_LAUNCH_BELT_MS",
    "VIRTUAL_ENV", "POETRY_ACTIVE", "STUB_ZMX_EXIT"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { HANG_GUARD_MS } = require("./hang-guard");

const T = process.env.AGENTS_TEST_TMP;
const A = path.join(__dirname, "bin", "a");
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// Stub zmx: `list` answers from $ZMX_LIST_FILE; `send` logs the pane name plus
// its stdin (the injected chunks) and, knob-gated, simulates the runner's
// first act by patching a live pid into the record; everything else logs argv.
const stubBin = path.join(T, "stubbin");
fs.writeFileSync(path.join(stubBin, "zmx"), [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "zmx 0.8.1"; exit 0 ;;',
  '  list) [ -f "$ZMX_LIST_FILE" ] && cat "$ZMX_LIST_FILE"; exit 0 ;;',
  '  send)',
  '    printf \'send\\n%s\\n\' "$2" >> "$ZMX_LOG"',
  '    cat >> "$ZMX_SEND_LOG"',
  '    echo "cwd $PWD" >> "$ZMX_LOG"',
  '    if [ -n "$ZMX_PATCH_RECORD" ] && [ -n "$ZMX_PATCH_PID" ]; then',
  '      node -e \'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j.pid=Number(process.argv[2]);fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\\n")}catch(e){}\' "$ZMX_PATCH_RECORD" "$ZMX_PATCH_PID"',
  '    fi',
  '    exit 0 ;;',
  "esac",
  'printf \'%s\\n\' "$@" >> "$ZMX_LOG"',
  'echo "cwd $PWD" >> "$ZMX_LOG"',
  'exit "${STUB_ZMX_EXIT:-0}"',
  "",
].join("\n"), { mode: 0o755 });
fs.writeFileSync(path.join(stubBin, "claude"), '#!/bin/sh\necho "claude $*" >> "$CLAUDE_LOG"\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:${process.env.PATH}`;

// The fixture: repo acme with a local bare origin and two open tasks, fresh roots and logs.
let counter = 0;
let cur;
function fixture(label, { pavPort, setup = "sleep 5", envrc = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(T, `${label}-${++counter}-`)));
  for (const d of ["tasks", "sessions"]) fs.mkdirSync(path.join(root, d));
  Object.assign(process.env, {
    AGENTS_TASKS_ROOT: path.join(root, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(root, "sessions"),
    AGENTS_DB: path.join(root, "agents.db"),
    ZMX_LOG: path.join(root, "zmx.log"),
    ZMX_SEND_LOG: path.join(root, "zmx-send.log"),
    CLAUDE_LOG: path.join(root, "claude.log"),
    ZMX_LIST_FILE: path.join(root, "zmx-list.txt"),
  });
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repoDir = path.join(root, "work", "acme");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# acme\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
  git(repoDir, "remote", "add", "origin", origin);
  git(repoDir, "push", "-q", "-u", "origin", "main");
  git(repoDir, "remote", "set-head", "origin", "main");
  if (envrc) {
    fs.writeFileSync(path.join(repoDir, ".envrc"), envrc);
    execFileSync("direnv", ["allow"], { cwd: repoDir, stdio: ["pipe", "pipe", "pipe"], timeout: HANG_GUARD_MS });
  }
  const key = repoKey(repoDir);
  const cfg = { worktrees_root: path.join(root, "worktrees"), repos: { [key.key]: { setup, teardown: "true" } } };
  if (pavPort) cfg.pav = { port: pavPort };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  db.open({ create: true });
  const mkTask = (slug, title) => taskLib.createTask({ repo: key, title, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  const tasks = { 1: mkTask("one", "One"), 2: mkTask("two", "Two") };
  cur = { root, repoDir, key, tasks, wtRoot: path.join(root, "worktrees") };
  return cur;
}

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
function zmxArgvs() {
  const calls = [];
  let words = [];
  for (const l of readLog(process.env.ZMX_LOG)) {
    if (l.startsWith("cwd ")) { calls.push(words); words = []; } else words.push(l);
  }
  return calls;
}
const wtPath = (name) => path.join(cur.wtRoot, "acme", name);
const gitdirOf = (wt) => execFileSync("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const readRecord = (wt) => JSON.parse(fs.readFileSync(path.join(gitdirOf(wt), "setup.json"), "utf8"));
// The record path a start's own launch will write, before the worktree exists:
// git's per-worktree dir under the main checkout's .git.
const predictableRecord = (name) => path.join(cur.repoDir, ".git", "worktrees", name, "setup.json");

function spawnCli(args, { env = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [A, ...args], { env: { ...process.env, ...env }, cwd: cur.repoDir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ status: code, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: -1, out, err: err + e.message }); });
  });
}

const sleepPids = [];
function livePid() {
  const c = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  sleepPids.push(c.pid);
  return c.pid;
}

(async () => {
  const requests = [];
  let mode = "ok";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === "POST" && req.url === "/api/coding/terminals") {
        if (mode === "refuse") { res.statusCode = 503; res.end("coding disabled"); return; }
        res.statusCode = 201;
        res.end(JSON.stringify({ id: "term-9", session_name: "pav-t-5x1a2b3c" }));
        return;
      }
      if (req.method === "DELETE" && mode === "delete_refuse") { res.statusCode = 500; res.end("delete failed"); return; }
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // A dead port for the connection-refused leg: bind, note the number, close.
  const deadHolder = http.createServer(() => {});
  await new Promise((resolve) => deadHolder.listen(0, "127.0.0.1", resolve));
  const deadPort = deadHolder.address().port;
  await new Promise((resolve) => deadHolder.close(resolve));

  // PAV1: the rung-1 happy path — one POST, one chunked inject into the PAV
  // pane, the belt confirmed by the patched pid, no DELETE, no rung-2 session.
  {
    fixture("pav1", { pavPort: port });
    const pid = livePid();
    const wt = wtPath("001-one");
    const r = await spawnCli(["start", "001", "--worktree", "--no-attach", "--json"],
      { env: { ZMX_PATCH_RECORD: predictableRecord("001-one"), ZMX_PATCH_PID: String(pid) } });
    let data = null;
    try { data = JSON.parse(r.out); } catch {}
    const posts = requests.filter((q) => q.method === "POST" && q.url === "/api/coding/terminals");
    check(r.status === 0, `PAV1: the rung-1 start succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
    check(posts.length === 1 && posts[0].body === JSON.stringify({ agent: "shell", cwd: wt }),
      `PAV1: exactly one POST carries {agent: shell, cwd} (${posts.length}: ${posts.map((p) => p.body).join(" | ")})`);
    const sends = zmxArgvs().filter((w) => w[0] === "send");
    const sent = readLog(process.env.ZMX_SEND_LOG).join("");
    check(sends.length >= 1 && sends.every((w) => w[1] === "pav-t-5x1a2b3c") && sent === `exec ${A} setup run ${wt}\r`,
      `PAV1: the runner is injected into the pane's shell (${JSON.stringify(sends)}: ${JSON.stringify(sent)})`);
    const rec = fs.existsSync(predictableRecord("001-one")) ? readRecord(wt) : null;
    check(rec && rec.state === "pending" && rec.pane_kind === "pav" && rec.pane === "pav-t-5x1a2b3c" && rec.pav_terminal_id === "term-9" && rec.pid === pid,
      `PAV1: the record is pending in the PAV pane with the patched pid (${JSON.stringify(rec)})`);
    check(!requests.some((q) => q.method === "DELETE"), "PAV1: no DELETE arrives on a confirmed launch");
    check(!zmxArgvs().some((w) => w[0] === "run" && String(w[1] || "").startsWith("Setup-")), "PAV1: no rung-2 session appears");
    check(data && data.setup && data.setup.state === "pending" && data.setup.pane_kind === "pav" && data.setup.pane === "pav-t-5x1a2b3c" && data.setup.pav_terminal_id === "term-9",
      `PAV1: the JSON carries the PAV pane identity (${JSON.stringify(data && data.setup)})`);
    requests.length = 0;
  }

  // PAV2: rung selection, port unset — zero requests, the own-zmx rung.
  {
    fixture("pav2");
    const r = await spawnCli(["start", "001", "--worktree", "--no-attach", "--json"]);
    check(r.status === 0, `PAV2: a start without pav.port succeeds (${r.status}: ${r.err.trim().slice(-200)})`);
    check(requests.length === 0, `PAV2: no request arrives when the port is unset (${requests.length}: ${requests.map((q) => q.method + " " + q.url).join(" | ")})`);
    check(zmxArgvs().some((w) => w[0] === "run" && String(w[1] || "").startsWith("Setup-")), "PAV2: the own-zmx rung launches instead");
    requests.length = 0;
  }

  // PAV3: rung selection, daemon refuses — a 503 and, in a second leg, a dead
  // port — both drop to rung 2 without a send and never fail the start.
  {
    mode = "refuse";
    fixture("pav3", { pavPort: port });
    const r = await spawnCli(["start", "001", "--worktree", "--no-attach", "--json"]);
    check(r.status === 0, `PAV3: a refused POST never fails the start (${r.status}: ${r.err.trim().slice(-200)})`);
    check(requests.filter((q) => q.method === "POST").length === 1, "PAV3: one POST was attempted");
    check(!zmxArgvs().some((w) => w[0] === "send"), "PAV3: no zmx send ran (nothing to inject into)");
    check(zmxArgvs().some((w) => w[0] === "run" && String(w[1] || "").startsWith("Setup-")), "PAV3: the ladder drops to the own-zmx rung");
    requests.length = 0;
    mode = "ok";

    fixture("pav3b", { pavPort: deadPort });
    const r2 = await spawnCli(["start", "001", "--worktree", "--no-attach", "--json"]);
    check(r2.status === 0, `PAV3b: a dead pav port never fails the start (${r2.status}: ${r2.err.trim().slice(-200)})`);
    check(requests.length === 0, `PAV3b: nothing arrives at the live server (the POST went to the dead port)`);
    check(!zmxArgvs().some((w) => w[0] === "send") && zmxArgvs().some((w) => w[0] === "run" && String(w[1] || "").startsWith("Setup-")),
      "PAV3b: a dead port drops to the own-zmx rung with no send");
    requests.length = 0;
  }

  // PAV4: the rollback DELETE — a bootstrap that can never satisfy the .envrc
  // (the main checkout has the venv the worktree's copy needs; the configured
  // bootstrap never creates the worktree's) holds the start to the wait cap,
  // refuses setup_failed, and the rollback DELETEs the PAV terminal before the
  // child exits, with the task and worktree rolled back.
  {
    fixture("pav4", { pavPort: port, envrc: "source .venv/bin/activate || exit 1\n" });
    fs.mkdirSync(path.join(cur.repoDir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cur.repoDir, ".venv", "bin", "activate"), "");
    const pid = livePid();
    const name = "003-rollback";
    const r = await spawnCli(["start", "--title", "Rollback", "--worktree", "--no-attach", "--json"],
      { env: { AGENTS_SETUP_TIMEOUT_MS: "300", ZMX_PATCH_RECORD: predictableRecord(name), ZMX_PATCH_PID: String(pid) } });
    let body = null;
    try { body = JSON.parse(r.out); } catch {}
    check(r.status === 2 && body && body.error === "setup_failed",
      `PAV4: the never-green env refuses setup_failed (${r.status}: ${JSON.stringify(body && body.error)})`);
    const dels = requests.filter((q) => q.method === "DELETE" && q.url === "/api/coding/terminals/term-9");
    check(dels.length === 1, `PAV4: the rollback DELETEs the PAV terminal (${dels.length}: ${requests.map((q) => q.method + " " + q.url).join(" | ")})`);
    check(!fs.existsSync(wtPath(name)), "PAV4: the rolled-back worktree is gone");
    check(!db.listTasks({ disposition: "active" }).some((t) => t.dir_name === name), "PAV4: the rolled-back task is gone from the active list");
    requests.length = 0;
  }

  // PAV5: the launch belt — the send stub does not patch the pid, the belt
  // expires, the pane is DELETEd and the ladder drops to rung 2.
  {
    fixture("pav5", { pavPort: port });
    const r = await spawnCli(["start", "001", "--worktree", "--no-attach", "--json"], { env: { AGENTS_SETUP_LAUNCH_BELT_MS: "500" } });
    let data = null;
    try { data = JSON.parse(r.out); } catch {}
    check(r.status === 0, `PAV5: a lost injection drops a rung without failing the start (${r.status}: ${r.err.trim().slice(-200)})`);
    const seq = requests.filter((q) => q.url.startsWith("/api/coding/terminals")).map((q) => q.method);
    check(JSON.stringify(seq) === JSON.stringify(["POST", "DELETE"]), `PAV5: the POST is followed by the DELETE (${seq.join(" ")})`);
    check(zmxArgvs().some((w) => w[0] === "run" && String(w[1] || "").startsWith("Setup-")), "PAV5: the rung-2 session launches after the belt expiry");
    const rec = fs.existsSync(predictableRecord("001-one")) ? readRecord(wtPath("001-one")) : null;
    check(rec.pane_kind === "zmx" && /^Setup-/.test(rec.pane) && rec.pav_terminal_id === null,
      `PAV5: the record is rewritten for the rung-2 pane (${JSON.stringify(rec)})`);
    check(data && data.setup && data.setup.pane_kind === "zmx" && /^Setup-/.test(data.setup.pane),
      `PAV5: the JSON carries the rung-2 pane (${JSON.stringify(data && data.setup)})`);
    requests.length = 0;
  }

  // PAV6: a DELETE that fails still kills the pane's zmx session — the pane
  // is a zmx session the kill can reach, so the force-remove never proceeds
  // with the bootstrap still writing into the removed tree.
  {
    mode = "delete_refuse";
    fixture("pav6", { pavPort: port, envrc: "source .venv/bin/activate || exit 1\n" });
    fs.mkdirSync(path.join(cur.repoDir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(cur.repoDir, ".venv", "bin", "activate"), "");
    const pid = livePid();
    const name = "003-delete-fail";
    const r = await spawnCli(["start", "--title", "Delete fail", "--worktree", "--no-attach", "--json"],
      { env: { AGENTS_SETUP_TIMEOUT_MS: "300", ZMX_PATCH_RECORD: predictableRecord(name), ZMX_PATCH_PID: String(pid) } });
    let body = null;
    try { body = JSON.parse(r.out); } catch {}
    check(r.status === 2 && body && body.error === "setup_failed",
      `PAV6: the never-green env refuses setup_failed (${r.status}: ${JSON.stringify(body && body.error)})`);
    const dels = requests.filter((q) => q.method === "DELETE" && q.url === "/api/coding/terminals/term-9");
    check(dels.length === 1, `PAV6: the rollback attempts the PAV DELETE (${dels.length})`);
    check(zmxArgvs().some((w) => w[0] === "kill" && w[1] === "pav-t-5x1a2b3c"),
      `PAV6: the failed DELETE still kills the pane's zmx session (${JSON.stringify(zmxArgvs().filter((w) => w[0] === "kill"))})`);
    check(!fs.existsSync(wtPath(name)), "PAV6: the rolled-back worktree is gone");
    requests.length = 0;
    mode = "ok";
  }

  for (const p of sleepPids) { try { process.kill(p, "SIGKILL"); } catch {} }
  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
