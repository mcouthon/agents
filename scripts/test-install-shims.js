#!/usr/bin/env node
"use strict";
// The retired-stub trash, the snapshot server and the supervisor shims: the
// shims shard of the former test-install-snapshot (split when the suite
// outgrew every per-suite budget; see test-install-snapshot.js). The real HOME
// is fingerprinted before and after.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const repo = path.resolve(__dirname, "..");
const helper = path.join(repo, "scripts", "install-snapshot.js");
const realHome = os.userInfo().homedir;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-snapshot-"));
let counter = 0;
const mk = (label) => { const d = path.join(tmpRoot, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

function fingerprint() {
  const shim = path.join(realHome, ".local", "bin", "a");
  const binDir = path.join(realHome, ".agents", "bin");
  const stat = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
  const link = (p) => { try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : "file:" + stat(p); } catch { return "absent"; } };
  const listing = fs.existsSync(binDir) ? fs.readdirSync(binDir).sort().join(",") : "absent";
  return JSON.stringify({ shim: link(shim), bin: listing });
}
const before = fingerprint();

function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", ...extra };
  for (const k of ["INSTALL_PREFIX", "GIT_CONFIG_GLOBAL", "AGENTS_CONFIG_PATH", "A"]) delete env[k];
  return env;
}
function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: isolatedEnv(tmpRoot), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(root, rel, body, mode = 0o644) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, { mode });
  fs.chmodSync(p, mode);
}
function makeFixture() {
  const root = mk("fixture");
  write(root, "scripts/bin/a", "#!/bin/sh\necho fixture-a\n", 0o755);
  write(root, "scripts/lib/x.js", "module.exports = 1;\n");
  write(root, "scripts/node_modules/y.js", "ignored\n");
  write(root, "hooks/x.sh", "#!/bin/sh\n", 0o755);
  write(root, "generated/claude/agents/x.md", "agent\n");
  write(root, "README.md", "readme\n");
  write(root, ".gitignore", "node_modules/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}
function runHelper(src, home) {
  const r = spawnSync("node", [helper, "--src", src, "--home", home], { env: isolatedEnv(home), encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const binOf = (home) => path.join(home, ".agents", "bin");
const readlink = (p) => fs.readlinkSync(p);
const listing = (home) => fs.readdirSync(binOf(home)).sort().join(",");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const today = new Date().toISOString().slice(0, 10);
const STRAY = "a".repeat(64);

const LOCK_V1 = "{\"lockfileVersion\":3,\"packages\":{}}\n";
const LOCK_V2 = "{\"lockfileVersion\":3,\"packages\":{\"x\":{}}}\n";
/** The plain fixture plus a package.json, a lockfile and a memory seed, committed. */
function makeDepsFixture() {
  const root = makeFixture();
  write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n");
  write(root, "package-lock.json", LOCK_V1);
  write(root, "templates/agents/memory/x/MEMORY.md", "seed\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "deps");
  return root;
}
/** A built dependency tree for `hash`, as install.sh leaves it. */
function seedTree(home, hash) {
  const nm = path.join(binOf(home), "deps", hash, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  return nm;
}
const REPO_H = sha256(fs.readFileSync(path.join(repo, "package-lock.json")));
/** The checkout's own tree, linked as a built tree for the checkout's lockfile hash. */
function seedDeps(home) {
  const dir = path.join(binOf(home), "deps", REPO_H);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
}

/** `opts.env` is applied after the isolated environment; the fake npm fails `ci` with the code in <home>/npm.exit and, when <home>/npm.race exists, builds the tree itself first. */
function installSh(home, args, cwd, tasksRoot, opts = {}) {
  const fakeBin = mk("fakebin");
  for (const tool of ["claude", "launchctl"]) {
    write(fakeBin, tool, `#!/bin/sh\necho "${tool} $*" >> "${home}/calls.log"\n`, 0o755);
  }
  write(fakeBin, "npm", [
    "#!/bin/sh",
    `echo "npm $* node=$(command -v node)" >> "${home}/calls.log"`,
    "if [ \"$1\" = ci ]; then",
    `  [ -f "${home}/npm.race" ] && mkdir -p "${home}/.agents/bin/deps/${REPO_H}/node_modules"`,
    `  code=0; [ -f "${home}/npm.exit" ] && code=$(cat "${home}/npm.exit")`,
    "  [ \"$code\" = 0 ] && mkdir -p node_modules",
    "  exit \"$code\"",
    "fi",
    "exit 0",
    "",
  ].join("\n"), 0o755);
  for (const [name, body] of Object.entries(opts.tools || {})) write(fakeBin, name, body, 0o755);
  const env = isolatedEnv(home, {
    PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    AGENTS_TASKS_ROOT: tasksRoot,
    AGENTS_SESSIONS_ROOT: mk("sessions"),
    AGENTS_LOGS_ROOT: mk("logs"),
  });
  Object.assign(env, opts.env || {});
  const r = spawnSync("zsh", [path.join(repo, "install.sh"), ...args], { cwd, env, encoding: "utf8", input: "" });
  return { status: r.status, out: r.stdout, err: r.stderr, env };
}
const npmLines = (home) => callsLog(home).split("\n").filter((l) => l.startsWith("npm "));
const miseLines = (home) => callsLog(home).split("\n").filter((l) => l.startsWith("mise "));
const claudeLines = (home) => callsLog(home).split("\n").filter((l) => l.startsWith("claude "));
const SERVER_LINE = (home) => `claude mcp add --scope user state-manager ${home}/.agents/bin/node ${home}/.agents/bin/current/scripts/state-server.js`;

const callsLog = (home) => (fs.existsSync(path.join(home, "calls.log")) ? fs.readFileSync(path.join(home, "calls.log"), "utf8") : "");

// R1: installed copies of the retired stubs move to the trash by exact name; foreign files stay.
const RETIRED = [
  "conductor-stop.sh", "courier-stop.sh", "git-guard.sh", "machine-owned-guard.sh", "manifest-guard.sh",
  "plan-lint.sh", "quality-gate.sh", "report-parser.sh", "session-touch.sh", "session-unregister.sh",
  "spawn-guard.sh", "workspace-init.sh", "worktree-create.sh", "worktree-remove.sh", "write-guard.sh",
  "workspace-init-helper.js", "prime.sh", "report-capture.sh", "checkpoint-capture.sh",
];
{
  const home = mk("home");
  const hooksDir = path.join(home, ".claude", "hooks");
  for (const n of RETIRED) write(hooksDir, n, `retired ${n}\n`, 0o755);
  write(hooksDir, "acme-notify.sh", "foreign script\n", 0o755);
  write(hooksDir, "notes.txt", "foreign notes\n");
  write(home, ".agents/manifest.txt", ["# Installed by AGENTS framework — do not edit", ...RETIRED.map((n) => path.join(hooksDir, n))].join("\n") + "\n");
  const trash = path.join(home, ".agents", "trash", new Date().toISOString().slice(0, 10), "claude-hooks");

  const r = installSh(home, [], repo, mk("tasks"));
  check(r.status === 0, `R1: install exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(RETIRED.every((n) => fs.existsSync(path.join(trash, n)) && fs.readFileSync(path.join(trash, n), "utf8") === `retired ${n}\n`), "R1: all 19 retired files are in the trash with their content");
  check(fs.readdirSync(hooksDir).sort().join() === "acme-notify.sh,notes.txt,notification.sh,prompt-submit.sh,session-end.sh,session-register.sh", `R1: ~/.claude/hooks holds the four and the two foreign files (${fs.readdirSync(hooksDir)})`);
  check(fs.readFileSync(path.join(hooksDir, "acme-notify.sh"), "utf8") === "foreign script\n" && fs.readFileSync(path.join(hooksDir, "notes.txt"), "utf8") === "foreign notes\n", "R1: the foreign files are byte-identical");
  check(r.out.split("\n").filter((l) => l.startsWith("retired ~/.claude/hooks/")).length === 19 && !r.out.includes("Removed: ~/.claude/hooks/"), "R1: 19 'retired' lines and no 'Removed' line");

  const again = installSh(home, [], repo, mk("tasks"));
  check(again.status === 0 && !again.out.includes("retired ~/") && fs.readdirSync(trash).length === 19, "R1: a second install moves nothing");

  write(hooksDir, "quality-gate.sh", "retired again\n", 0o755);
  const third = installSh(home, [], repo, mk("tasks"));
  check(third.status === 0 && fs.readFileSync(path.join(trash, "quality-gate.sh-2"), "utf8") === "retired again\n" && fs.readFileSync(path.join(trash, "quality-gate.sh"), "utf8") === "retired quality-gate.sh\n", "R1: a taken trash name gets the -2 suffix");
}

// R2: a settings.json that still registers a retired stub is warned about, never edited.
{
  const home = mk("home");
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${home}/.claude/hooks/conductor-stop.sh` }] }] } }, null, 2) + "\n";
  write(home, ".claude/hooks/conductor-stop.sh", "retired conductor-stop.sh\n", 0o755);
  write(home, ".claude/settings.json", settings);
  const r = installSh(home, [], repo, mk("tasks"));
  const warnings = r.out.split("\n").filter((l) => l.includes("conductor-stop.sh") && l.includes("./install.sh --hooks"));
  check(r.status === 0 && warnings.length === 1, `R2: one warning names ./install.sh --hooks (${warnings.length})`);
  check(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8") === settings, "R2: settings.json is byte-identical");
}

// ./install.sh --mcp registers the snapshot's server through `claude mcp`
const entryFor = (home) => ({ type: "stdio", command: `${home}/.agents/bin/node`, args: [`${home}/.agents/bin/current/scripts/state-server.js`], env: {} });
const writeClaudeJson = (home, servers) => fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));
const clearCalls = (home) => fs.rmSync(path.join(home, "calls.log"), { force: true });
/** An environment with a fake `claude` that logs to <home>/calls.log first on PATH. */
function withFakeClaude(home) {
  const fakeBin = mk("fakebin");
  write(fakeBin, "claude", `#!/bin/sh\necho "claude $*" >> "${home}/calls.log"\n`, 0o755);
  return isolatedEnv(home, { PATH: `${fakeBin}:${process.env.PATH}` });
}

{
  const home = mk("home");
  seedDeps(home);
  const first = installSh(home, ["--mcp"], repo, mk("tasks"));
  check(first.status === 0 && claudeLines(home).length === 1 && claudeLines(home)[0] === SERVER_LINE(home) && /^ {2}mcp {7}state-manager: registered$/m.test(first.out),
    `IM1: --mcp on a built HOME adds the snapshot's server at user scope and the summary says registered (${JSON.stringify(claudeLines(home))})`);

  clearCalls(home);
  writeClaudeJson(home, { "state-manager": entryFor(home) });
  const same = installSh(home, ["--mcp"], repo, mk("tasks"));
  check(same.status === 0 && claudeLines(home).length === 0 && /^ {2}mcp {7}state-manager: registered \(unchanged\)$/m.test(same.out),
    `IM2: an entry that already matches is left alone (${JSON.stringify(claudeLines(home))})`);

  clearCalls(home);
  writeClaudeJson(home, { "state-manager": { type: "stdio", command: `${home}/.agents/bin/node`, args: [`${repo}/scripts/state-server.js`], env: {} } });
  const cut = installSh(home, ["--mcp"], repo, mk("tasks"));
  check(cut.status === 0 && JSON.stringify(claudeLines(home)) === JSON.stringify(["claude mcp remove --scope user state-manager", SERVER_LINE(home)]),
    `IM3: an entry naming the checkout is removed and added again for the snapshot (${JSON.stringify(claudeLines(home))})`);

  clearCalls(home);
  fs.writeFileSync(path.join(home, ".claude.json"), "{");
  const broken = spawnSync("node", [path.join(repo, "scripts", "install-mcp.js"), "--home", home], { env: withFakeClaude(home), encoding: "utf8" });
  check(broken.status === 1 && broken.stderr.includes(".claude.json") && claudeLines(home).length === 0,
    `IM6: an unparseable .claude.json is a failure that names the file and calls nothing (${broken.status}: ${broken.stderr.trim()})`);

  // IM4 rides this HOME (the .claude.json state permits it: the prefix
  // refusal happens before any registration read); the per-leg calls log was
  // cleared above.
  clearCalls(home);
  const prefix = mk("prefix");
  const refused = installSh(home, ["--mcp"], repo, mk("tasks"), { env: { INSTALL_PREFIX: prefix } });
  check(refused.status === 0 && claudeLines(home).length === 0 && /^ {2}mcp {7}state-manager: refused \(INSTALL_PREFIX is set\)$/m.test(refused.out),
    `IM4: under INSTALL_PREFIX registration is refused and nothing is called (${refused.status})`);
}

{
  const src = makeFixture();
  const home = mk("home");
  runHelper(src, home);
  write(path.join(binOf(home), "current"), "scripts/state-server.js", "// stands in for the server\n");
  const r = spawnSync("node", [path.join(repo, "scripts", "install-mcp.js"), "--home", home], { env: withFakeClaude(home), encoding: "utf8" });
  check(r.status === 1 && r.stderr.includes("@modelcontextprotocol/sdk") && r.stderr.includes("./install.sh") && claudeLines(home).length === 0,
    `IM5: a snapshot without its dependency tree is refused naming the module and ./install.sh, and calls nothing (${r.status}: ${r.stderr.trim()})`);
}

{
  const home = mk("home");
  const r = installSh(home, ["--mcp"], repo, mk("tasks"));
  check(r.status === 0 && /^ {2}mcp {7}state-manager: failed \(install-mcp\.js exit 1\)$/m.test(r.out) && r.out.includes("Hook stubs resolve a to:") && claudeLines(home).length === 0,
    `IM7: a registration that fails is reported in the summary, install exits 0 and the summary still prints (${r.status})`);
}

// The snapshot's server starts on its linked tree, lists the tools and seeds memory from the snapshot's templates
function serverSession(home, extraEnv = {}) {
  const env = isolatedEnv(home, extraEnv);
  delete env.NODE_PATH;
  const proc = require("child_process").spawn(path.join(binOf(home), "node"), [path.join(binOf(home), "current", "scripts", "state-server.js")], { cwd: mk("cwd"), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", id = 0;
  const waiting = new Map();
  proc.stdout.on("data", (c) => {
    buf += c;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) { try { const m = JSON.parse(l); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } catch { /* not JSON */ } }
  });
  proc.stderr.on("data", (d) => { stderr += d; });
  const closed = new Promise((resolve) => proc.on("close", (code) => { for (const w of waiting.values()) w(null); resolve(code); }));
  const rpc = (method, params) => new Promise((resolve) => {
    const mine = ++id;
    const timer = setTimeout(() => { waiting.delete(mine); resolve(null); }, 30000);
    waiting.set(mine, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
  });
  return { rpc, stderr: () => stderr, closed, end: () => proc.stdin.end() };
}

// SH1-SH4: pane-send and task-probe install as snapshot-running shims
function makeHelperFixture() {
  const root = makeFixture();
  write(root, "scripts/bin/pane-send", "#!/usr/bin/env node\nconsole.log('pane-send from checkout');\n", 0o755);
  write(root, "scripts/bin/task-probe", "#!/usr/bin/env node\nconsole.log('task-probe from checkout');\n", 0o755);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "helpers");
  return root;
}

// SH1: after runHelper, both ~/.local/bin/ entries exist, are not symlinks, and contain the helper-shim marker.
{
  const src = makeHelperFixture();
  const home = mk("home");
  runHelper(src, home);
  for (const name of ["pane-send", "task-probe"]) {
    const dest = path.join(home, ".local/bin", name);
    const st = exists(dest) ? fs.lstatSync(dest) : null;
    check(st !== null && !st.isSymbolicLink() && st.isFile(), `SH1: ~/.local/bin/${name} exists as a regular file (not a symlink)`);
    check(st !== null && fs.readFileSync(dest, "utf8").includes("agents-helper-shim"), `SH1: ~/.local/bin/${name} contains the helper-shim marker`);
  }

  // SH2 rides SH1's one install (the helper family's shared world): edit the
  // checkout's pane-send after install → output still comes from the
  // snapshot's copy.
  write(src, "scripts/bin/pane-send", "#!/usr/bin/env node\nconsole.log('CHECKOUT EDITED');\n", 0o755);
  const r = spawnSync("node", [path.join(home, ".local/bin/pane-send")], { env: isolatedEnv(home), encoding: "utf8" });
  check(r.status === 0 && r.stdout.includes("pane-send from checkout") && !r.stdout.includes("CHECKOUT EDITED"),
    `SH2: the installed shim runs the snapshot's copy, not the checkout's (${r.stdout.trim()})`);
}

// SH3: pre-create ~/.local/bin/pane-send as a symlink into the checkout → replaced by the shim, target untouched.
{
  const src = makeHelperFixture();
  const home = mk("home");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  const target = path.join(src, "scripts/bin/pane-send");
  fs.symlinkSync(target, path.join(home, ".local/bin/pane-send"));
  runHelper(src, home);
  const dest = path.join(home, ".local/bin/pane-send");
  const st = exists(dest) ? fs.lstatSync(dest) : null;
  check(st !== null && !st.isSymbolicLink() && fs.readFileSync(dest, "utf8").includes("agents-helper-shim"),
    "SH3: a symlink at ~/.local/bin/pane-send is replaced by the shim");
  check(fs.readFileSync(target, "utf8").includes("pane-send from checkout"),
    "SH3: the symlink's target (the checkout's file) is untouched");
}

// SH4: end-to-end installSh on the real repo → both helpers are marker shims, not symlinks.
{
  const home = mk("home");
  const tasks = mk("tasks");
  seedDeps(home);
  const r = installSh(home, [], repo, tasks);
  check(r.status === 0, `SH4: install.sh on the real repo exits 0 (${r.status})`);
  for (const name of ["pane-send", "task-probe"]) {
    const dest = path.join(home, ".local/bin", name);
    const st = exists(dest) ? fs.lstatSync(dest) : null;
    check(st !== null && !st.isSymbolicLink() && st.isFile() && fs.readFileSync(dest, "utf8").includes("agents-helper-shim"),
      `SH4: ~/.local/bin/${name} is a marker shim (not a symlink)`);
  }
  // The checkout's files are unchanged (still the real scripts).
  check(fs.readFileSync(path.join(repo, "scripts/bin/pane-send"), "utf8").includes("require.main === module"),
    "SH4: the checkout's scripts/bin/pane-send is unchanged");
  check(fs.readFileSync(path.join(repo, "scripts/bin/task-probe"), "utf8").includes("require.main === module"),
    "SH4: the checkout's scripts/bin/task-probe is unchanged");
}

// SH5: the helper shim is a watching supervisor — when the shim's parent dies,
// the shim TERMs its child and both are gone shortly after (a spawnSync shim
// would survive at ppid 1, holding its child forever). The observation windows
// are 8s: a 0.5s watch tick, a 2s belt and process teardown all stretch under
// a loaded battery, and the storm must not read as a survived orphan.
const nap = (s) => spawnSync("/bin/sleep", [String(s)]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const goneWithin = (pid, secs) => {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end && alive(pid)) nap(0.05);
  return !alive(pid);
};
{
  const src = makeHelperFixture();
  // The planted engine-wait: records its pid, sleeps long, records a TERM.
  write(src, "scripts/bin/engine-wait", [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const f = process.argv[2];",
    "fs.writeFileSync(f, `boot pid=${process.pid}\\n`);",
    "process.on('SIGTERM', () => { fs.appendFileSync(f, 'term\\n'); process.exit(0); });",
    "setInterval(() => {}, 60000);",
    "",
  ].join("\n"), 0o755);
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "engine-wait");
  const home = mk("home");
  runHelper(src, home);
  const shim = path.join(home, ".local/bin/engine-wait");
  const run = mk("sh5");
  const record = path.join(run, "record");
  const pidFile = path.join(run, "shim.pid");
  // The intermediate dies only after the shim is provably booted (its child
  // wrote the record), never the boot-orphan edge, and takes no longer than
  // the belt if the record never appears.
  const script = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    `const child = spawn(${JSON.stringify(shim)}, [${JSON.stringify(record)}], { env: { ...process.env, HOME: ${JSON.stringify(home)} }, stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    `const boot = setInterval(() => { try { if (fs.readFileSync(${JSON.stringify(record)}, 'utf8').length > 0) { clearInterval(boot); process.exit(0); } } catch { /* not yet */ } }, 20);`,
    "setTimeout(() => process.exit(0), 3000);",
  ].join("\n");
  spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
  const shimPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
  let childPid = 0;
  const foundBy = Date.now() + 5000;
  while (Date.now() < foundBy) {
    const m = /boot pid=(\d+)/.exec(fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "");
    if (m) { childPid = Number(m[1]); break; }
    nap(0.05);
  }
  try {
    check(shimPid > 0 && childPid > 0, `SH5: the shim is spawned and its child is discovered (${shimPid}, ${childPid})`);
    check(goneWithin(shimPid, 8), "SH5: the shim exits after its parent dies");
    check(goneWithin(childPid, 8), "SH5: the shim takes its child down with it");
    check(fs.existsSync(record) && fs.readFileSync(record, "utf8").includes("term"), "SH5: the child saw the TERM before dying");
  } finally {
    for (const pid of [shimPid, childPid]) {
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  }
}

// SH6: the supervisor's SIGKILL belt is live — a child that TRAPS SIGTERM
// (records it, keeps running) must be KILLed by the 2 s belt once the shim's
// parent dies. A shim that exits before its child closes orphans the trapper
// at ppid 1 — the exact leak shape this phase closes.
{
  const src = makeHelperFixture();
  // The planted engine-wait: records its pid, sleeps long, traps TERM —
  // records receiving it and does NOT exit.
  write(src, "scripts/bin/engine-wait", [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const f = process.argv[2];",
    "fs.writeFileSync(f, `boot pid=${process.pid}\\n`);",
    "process.on('SIGTERM', () => fs.appendFileSync(f, 'term\\n'));",
    "setInterval(() => {}, 60000);",
    "",
  ].join("\n"), 0o755);
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "engine-wait-trapper");
  const home = mk("home");
  runHelper(src, home);
  const shim = path.join(home, ".local/bin/engine-wait");
  const run = mk("sh6");
  const record = path.join(run, "record");
  const pidFile = path.join(run, "shim.pid");
  // The intermediate dies only after the trapped child is provably booted (its
  // record), never the boot-orphan edge, and takes no longer than the belt if
  // the record never appears (SH5's shape).
  const script = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    `const child = spawn(${JSON.stringify(shim)}, [${JSON.stringify(record)}], { env: { ...process.env, HOME: ${JSON.stringify(home)} }, stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    `const boot = setInterval(() => { try { if (fs.readFileSync(${JSON.stringify(record)}, 'utf8').length > 0) { clearInterval(boot); process.exit(0); } } catch { /* not yet */ } }, 20);`,
    "setTimeout(() => process.exit(0), 3000);",
  ].join("\n");
  spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
  const shimPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
  let childPid = 0;
  const foundBy = Date.now() + 5000;
  while (Date.now() < foundBy) {
    const m = /boot pid=(\d+)/.exec(fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "");
    if (m) { childPid = Number(m[1]); break; }
    nap(0.05);
  }
  try {
    check(shimPid > 0 && childPid > 0, `SH6: the shim is spawned and its trapped child is discovered (${shimPid}, ${childPid})`);
    const termBy = Date.now() + 5000;
    let termSeen = false;
    while (Date.now() < termBy) {
      if ((fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "").includes("term")) { termSeen = true; break; }
      nap(0.05);
    }
    check(termSeen, "SH6: the shim TERMs its child when the parent dies");
    check(termSeen && alive(childPid), "SH6: the trapped child survives the TERM — only the belt can take it down");
    check(goneWithin(shimPid, 6), "SH6: the shim exits after its parent dies");
    check(goneWithin(childPid, 6), "SH6: the belt SIGKILLs the trapped child — no ppid-1 orphan");
    check(fs.existsSync(record) && /boot pid=\d+\nterm/.test(fs.readFileSync(record, "utf8")), "SH6: the record shows TERM arrived before the KILL");
  } finally {
    for (const pid of [shimPid, childPid]) {
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  }
}

let seededHome = null;
// The server session's HOME: the seeded tree and the real repo's snapshot —
// the shape the former suite's end-to-end install block produced.
{
  const home = mk("home");
  const tasks = mk("tasks");
  fs.mkdirSync(home, { recursive: true });
  seedDeps(home);
  const setup = installSh(home, [], repo, tasks);
  if (setup.status !== 0) throw new Error("the server-session setup install failed: " + setup.out + setup.err);
  seededHome = home;
}

(async () => {
  const home = seededHome;
  const EXPECTED = ["add_phases", "check_phase", "code_index_build", "code_index_status", "decide", "land", "note", "prime", "task_read"];
  const s = serverSession(home);
  await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  const listed = await s.rpc("tools/list", {});
  const names = listed ? listed.result.tools.map((t) => t.name).sort() : [];
  const status = await s.rpc("tools/call", { name: "code_index_status", arguments: {} });
  const statusText = status && status.result ? status.result.content[0].text : "";
  s.end();
  await s.closed;
  check(names.join() === EXPECTED.join() && statusText.startsWith("not_configured"),
    `SV1: the installed snapshot's server starts on its linked tree, lists exactly its tools and answers code_index_status (${names.join()}; ${statusText.split("\n")[0]}; ${s.stderr().trim().slice(0, 120)})`);

  const aside = path.join(binOf(home), "current", "node_modules.aside");
  const link = path.join(binOf(home), "current", "node_modules");
  fs.renameSync(link, aside);
  const nolink = spawnSync(path.join(binOf(home), "node"), [path.join(binOf(home), "current", "scripts", "state-server.js")], { cwd: mk("cwd"), env: (() => { const e = isolatedEnv(home); delete e.NODE_PATH; return e; })(), encoding: "utf8", input: "", timeout: 30000 });
  fs.renameSync(aside, link);
  check(nolink.status !== 0 && nolink.stderr.includes("@modelcontextprotocol/sdk"), `SV2 (guard): a snapshot without its link exits non-zero naming the module (${nolink.status}: ${nolink.stderr.trim().slice(0, 140)})`);

  check(fingerprint() === before, "the real HOME is untouched");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
