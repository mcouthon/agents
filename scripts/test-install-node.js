#!/usr/bin/env node
"use strict";
// Dependency trees through install.sh, the recorded node, the mise pin: the
// install shard of the former test-install-snapshot (split when the suite
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

// Dependency trees through install.sh: built once under the recorded node, never into the caller's directory
{
  const home = mk("home");
  const cwd = mk("cwd");
  const r = installSh(home, [], cwd, mk("tasks"));
  const current = path.join(binOf(home), "current");
  const tree = path.join(binOf(home), "deps", REPO_H);
  check(r.status === 0 && npmLines(home).length === 1 && npmLines(home)[0] === `npm ci --omit=dev --loglevel=error --no-audit --no-fund node=${home}/.agents/bin/node`,
    `DP1: an unseeded HOME runs npm ci once under the recorded node (${JSON.stringify(npmLines(home))})`);
  check(fs.readFileSync(path.join(tree, "package.json"), "utf8") === fs.readFileSync(path.join(repo, "package.json"), "utf8") &&
    fs.readFileSync(path.join(tree, "package-lock.json"), "utf8") === fs.readFileSync(path.join(repo, "package-lock.json"), "utf8") &&
    fs.statSync(path.join(tree, "node_modules")).isDirectory() && !fs.readdirSync(path.join(binOf(home), "deps")).some((n) => n.startsWith(".tmp-")),
    "DP1: the tree holds the checkout's package files and a node_modules, with no build dir left");
  check(r.out.includes(`deps      ~/.agents/bin/deps/${REPO_H.slice(0, 12)} (built)`) && fs.readdirSync(cwd).length === 0 && fs.existsSync(path.join(current, "node_modules")),
    "DP1: the summary says built, current resolves its tree and nothing was written to the caller's directory");
}

{
  const prefix = mk("prefix");
  const home = mk("home");
  const r = installSh(home, [], repo, mk("tasks"), { env: { INSTALL_PREFIX: prefix } });
  check(r.status === 0 && npmLines(home).length === 0 && /^ {2}deps {6}not built \(INSTALL_PREFIX is set\)$/m.test(r.out) && !r.out.includes("deps/none") && !r.out.includes("(skipped"),
    `DP3: under INSTALL_PREFIX no npm runs and the summary says so (${r.status})`);
}

{
  const home = mk("home");
  fs.writeFileSync(path.join(home, "npm.exit"), "1");
  const r = installSh(home, [], repo, mk("tasks"));
  const bin = binOf(home);
  const sha = git(repo, "rev-parse", "--short=12", "HEAD");
  const snapshots = fs.readdirSync(bin).filter((n) => n.startsWith(sha));
  check(r.status === 0 && r.out.includes(`deps/${REPO_H.slice(0, 12)} (failed: npm ci exit 1)`), `DP4: a failing npm ci is reported in the summary and install still exits 0 (${r.status})`);
  check(snapshots.length === 1 && !exists(path.join(bin, "current")) && !exists(path.join(bin, "deps", REPO_H)) && !fs.readdirSync(path.join(bin, "deps")).some((n) => n.startsWith(".tmp-")),
    `DP4: current is not repointed at a snapshot whose tree is missing, no tree and no build dir is left (${fs.readdirSync(bin)})`);
  check(/current unchanged/.test(r.out) && !/current -> /.test(r.out), "DP4: the summary says current was left alone");

  fs.rmSync(path.join(home, "npm.exit"));
  const retry = installSh(home, [], repo, mk("tasks"));
  check(retry.status === 0 && readlink(path.join(bin, "current")) === snapshots[0] && fs.statSync(path.join(bin, "deps", REPO_H, "node_modules")).isDirectory() && retry.out.includes("(built)"),
    "DP4: the next install builds the tree and repoints current");
}

{
  const home = mk("home");
  fs.writeFileSync(path.join(home, "npm.race"), "");
  const r = installSh(home, [], repo, mk("tasks"));
  const deps = path.join(binOf(home), "deps");
  check(r.status === 0 && r.out.includes("(present)") && fs.readdirSync(deps).join() === REPO_H && fs.readdirSync(path.join(deps, REPO_H)).sort().join() === "node_modules",
    `DP6: a tree another install built while npm ran is kept and our build dir is dropped (${fs.readdirSync(deps)})`);
}

{
  const home = mk("home");
  seedDeps(home);
  fs.mkdirSync(path.join(binOf(home), "deps", STRAY), { recursive: true });
  fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agents", "trash"), "a file where the trash directory belongs\n");
  const r = installSh(home, [], repo, mk("tasks"));
  check(r.status === 0 && /^ {2}deps {6}.*prune failed/m.test(r.out) && exists(path.join(binOf(home), "deps", STRAY)),
    `DP5: a prune that cannot move a tree is reported in the summary and install exits 0 (${r.status})`);
}

{
  const home = mk("home");
  const tasks = mk("tasks");
  const cwd = mk("cwd");
  const r = installSh(home, ["--hooks", "--force"], cwd, tasks);
  const settingsPath = path.join(home, ".claude", "settings.json");
  check(r.status === 0, `install.sh --hooks --force exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(fs.existsSync(settingsPath) && fs.readFileSync(settingsPath, "utf8").includes("$HOME/.claude/hooks/session-register.sh"), "--hooks registers session-register.sh in the temporary HOME's settings.json");
  check(r.out.includes("settings  ~/.claude/settings.json: hooks registered"), "summary says hooks registered");
  check(!/^claude/m.test(callsLog(home)), "--hooks never calls claude");
  check(fs.readdirSync(tasks).length === 0, "--hooks ran no task migration");
}

// Recorded node: install records it, the summary and doctor name it, the shim re-executes under it.
{
  const src = makeFixture();
  const home = mk("home");
  const h = runHelper(src, home);
  const nodeLink = path.join(binOf(home), "node");
  const nodeLine = h.out.match(/^node -> (.+) \(v[\d.]+\)$/m);
  check(fs.realpathSync(nodeLink) === fs.realpathSync(process.execPath), "N1: ~/.agents/bin/node resolves to the node install ran with");
  check(Boolean(nodeLine) && nodeLine[1] === process.execPath && h.out.indexOf("snapshot ") < h.out.indexOf("node -> "), "N1: output has the node line after the snapshot line");
  check(!h.out.includes("ExperimentalWarning"), "N1: probing node:sqlite prints no experimental warning");
}

{
  const home = mk("home");
  const r = installSh(home, [], repo, mk("tasks"));
  const nodeLink = path.join(binOf(home), "node");
  const shim = path.join(home, ".local/bin/a");
  const doctor = () => spawnSync("node", [shim, "doctor", "--json"], { env: r.env, encoding: "utf8", cwd: mk("cwd") });
  check(r.out.includes(`  node      ${process.execPath}`), "N2: install summary names the recorded node");
  check(JSON.parse(doctor().stdout).info.node.sqlite === true, "N2: doctor reports node:sqlite loadable");

  const wrapper = path.join(mk("wrap"), "node-nosqlite");
  write(path.dirname(wrapper), path.basename(wrapper), `#!/bin/sh\nexec "${process.execPath}" --no-experimental-sqlite "$@"\n`, 0o755);
  fs.rmSync(nodeLink);
  fs.symlinkSync(wrapper, nodeLink);
  const bad = JSON.parse(doctor().stdout);
  check(bad.ok === false && bad.actions.some((a) => a.text.includes("node:sqlite")), "N2: doctor lists an action row when the recorded node lacks node:sqlite");

  const log = path.join(mk("log"), "calls");
  const logging = path.join(mk("wrap"), "node-logging");
  write(path.dirname(logging), path.basename(logging), `#!/bin/sh\necho x >> "${log}"\nexec "${process.execPath}" "$@"\n`, 0o755);
  fs.rmSync(nodeLink);
  fs.symlinkSync(logging, nodeLink);
  const run = spawnSync("node", [shim, "--help"], { env: r.env, encoding: "utf8", cwd: mk("cwd") });
  check(run.status === 0 && fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length === 1, "N3: the shim re-executes under the recorded node exactly once");

  fs.rmSync(nodeLink);
  fs.symlinkSync(path.join(home, "gone", "node"), nodeLink);
  const dangling = spawnSync("node", [shim, "--help"], { env: r.env, encoding: "utf8", cwd: mk("cwd") });
  check(dangling.status === 0 && dangling.stderr === "", "N4: a dangling recorded node falls back to the running node silently");
}

// P1: the snapshot step routes through the repo's mise pin (mise.toml). Run from
// outside the repo so -C is load-bearing; a seeded tree means exactly one
// run_snapshot call, so the two mise lines are the probe and the snapshot.
{
  const home = mk("home");
  const cwd = mk("cwd");
  seedDeps(home);
  const fakeMise = [
    "#!/bin/sh",
    `echo "mise $*" >> "${home}/calls.log"`,
    `[ "$1" = x ] && [ "$2" = -C ] && [ "$3" = "${repo}" ] && [ "$4" = -- ] || exit 1`,
    "shift 4",
    `[ "$1" = node ] || exit 1`,
    "shift",
    `exec "${process.execPath}" "$@"`,
  ].join("\n");
  const r = installSh(home, [], cwd, mk("tasks"), { tools: { mise: fakeMise } });
  const expected = [
    `mise x -C ${repo} -- node --version`,
    `mise x -C ${repo} -- node ${repo}/scripts/install-snapshot.js --src ${repo} --home ${home}`,
    `mise x -C ${repo} -- node ${repo}/scripts/bin/watcher --install-plist --home ${home}`,
    `mise x -C ${repo} -- node ${repo}/scripts/install-maintenance.js --home ${home}`,
  ];
  check(r.status === 0, `P1: install with a mise that honors the pin exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(JSON.stringify(miseLines(home)) === JSON.stringify(expected), `P1: mise is probed once, then runs the snapshot step against the repo (${JSON.stringify(miseLines(home))})`);
  check(fs.realpathSync(path.join(binOf(home), "node")) === fs.realpathSync(process.execPath), "P1: the recorded node is the node mise exec'd");
  check(r.out.includes(`  node      ${process.execPath}`), "P1: the summary's node line names it");
}

// P2: a mise that cannot honor the pin (untrusted config, offline) falls back
// visibly — the install completes on the ambient node.
{
  const home = mk("home");
  const cwd = mk("cwd");
  seedDeps(home);
  const r = installSh(home, [], cwd, mk("tasks"), { tools: { mise: "#!/bin/sh\nexit 97\n" } });
  check(r.status === 0, `P2: install with a failing mise exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(r.out.includes("mise cannot honor"), "P2: the fallback is warned about");
  check(r.out.includes(`  node      ${process.execPath}`) && fs.realpathSync(path.join(binOf(home), "node")) === fs.realpathSync(process.execPath), "P2: the summary's node line and the recorded node name the ambient node");
  check(/^ {2}deps {6}~\/\.agents\/bin\/deps\/[0-9a-f]{12} \(present\)$/m.test(r.out), "P2: the deps line still reports the seeded tree");
}

// --hooks over a settings.json that still lists retired entries; plain install never touches it.
{
  const home = mk("home");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const retired = (name) => ({ hooks: [{ type: "command", command: `$HOME/.claude/hooks/${name}.sh`, timeout: 10 }] });
  const original = JSON.stringify({
    hooks: {
      SessionEnd: [retired("session-unregister")],
      Stop: [retired("conductor-stop"), { hooks: [{ type: "command", command: "/usr/local/bin/acme-notify" }] }],
    },
  }, null, 2) + "\n";
  write(home, ".claude/settings.json", original);

  const plain = installSh(home, [], repo, mk("tasks"));
  check(plain.status === 0 && fs.readFileSync(settingsPath, "utf8") === original, "I4: plain install.sh leaves settings.json byte-identical");

  // The doctor's ok branch needs the tasks root to hold a git repo (an empty
  // init is enough: no commit means no snapshot age, so no action row).
  const d4Tasks = mk("tasks");
  git(d4Tasks, "init", "-q", "-b", "main");
  const withHooks = installSh(home, ["--hooks", "--force"], repo, d4Tasks);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = Object.values(after.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  const agentsCommands = commands.filter((c) => c.startsWith("$HOME/.claude/hooks/")).map((c) => c.split("/").pop()).sort();
  check(withHooks.status === 0 && agentsCommands.join() === "notification.sh,prompt-submit.sh,session-end.sh,session-register.sh", `I4: --hooks --force leaves exactly the four AGENTS commands (${agentsCommands})`);
  check(commands.includes("/usr/local/bin/acme-notify"), "I4: the foreign hook survives");
  const backups = fs.readdirSync(path.join(home, ".claude")).filter((f) => f.startsWith("settings.json.agents-backup-"));
  check(backups.length === 1 && fs.readFileSync(path.join(home, ".claude", backups[0]), "utf8") === original, "I4: the original settings.json is kept as a backup");
  check(withHooks.out.includes("Backup: ") && withHooks.out.includes("settings  ~/.claude/settings.json: hooks registered"), "I4: the summary and output name the backup and the registration");

  // D4: doctor reports the node, the registered count and the outcome counts in both branches.
  const zmxBin = mk("zmxbin");
  write(zmxBin, "zmx", "#!/bin/sh\necho zmx 0.9.0\n", 0o755);
  const env = { ...withHooks.env, PATH: `${zmxBin}:${withHooks.env.PATH}` };
  const logs = withHooks.env.AGENTS_LOGS_ROOT;
  const stamp = new Date().toISOString();
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "hooks.log"), `${stamp}\tsess-1\treport-capture\trecorded\tagent=builder phase=1 result=stored\n${stamp}\tsess-1\treport-capture\tnot_recorded\treason=no_message\n${stamp}\tsess-2\tConductorStop\told block reason\n`);
  const shim = path.join(home, ".local/bin/a");
  const doctor = () => JSON.parse(spawnSync("node", [shim, "doctor", "--json"], { env, encoding: "utf8", cwd: mk("cwd") }).stdout);
  const ok = doctor();
  check(ok.ok === true && ok.info.node.sqlite === true && ok.info.hooks_registered === 4, `D4: doctor ok branch reports node.sqlite and hooks_registered 4 (${JSON.stringify(ok.actions)})`);
  check(JSON.stringify(ok.info.hook_outcomes) === JSON.stringify({ recorded: 1, not_recorded: 1, error: 0 }) && !("hook_blocks" in ok) && ok.info.hooks === "on", "D4: the five-field outcome lines are counted, the four-field line is ignored, no hook_blocks key");
  fs.rmSync(path.join(binOf(home), "node"));
  const bad = doctor();
  check(bad.ok === false && bad.info.node.path === null && bad.info.hooks_registered === 4 && bad.info.hook_outcomes.recorded === 1, "D4: the actions branch carries node, hooks_registered and hook_outcomes too");
}

// The shard's real-HOME guard — every install shard exits on it.
if (fingerprint() !== before) { fail++; console.log("FAIL: the real HOME is untouched"); }

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
