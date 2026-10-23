#!/usr/bin/env node
"use strict";
// install-snapshot.js on a fixture repo, then install.sh end to end in a
// temporary HOME. The real HOME is fingerprinted before and after.

const fs = require("fs");
const path = require("path");
const os = require("os");
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
  const settings = path.join(realHome, ".claude", "settings.json");
  const shim = path.join(realHome, ".local", "bin", "a");
  const binDir = path.join(realHome, ".agents", "bin");
  const stat = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
  const link = (p) => { try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : "file:" + stat(p); } catch { return "absent"; } };
  const listing = fs.existsSync(binDir) ? fs.readdirSync(binDir).sort().join(",") : "absent";
  return JSON.stringify({ settings: stat(settings), shim: link(shim), bin: listing });
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

// Helper on a fixture repo

{
  const src = makeFixture();
  const home = mk("home");
  const sha = git(src, "rev-parse", "--short=12", "HEAD");
  const r = runHelper(src, home);
  const snap = path.join(binOf(home), sha);
  check(r.status === 0 && r.out.includes(`snapshot ${sha} (new)`), "clean fixture installs as a new snapshot named by the 12-char sha");
  check(fs.existsSync(path.join(snap, "scripts/lib/x.js")) && fs.existsSync(path.join(snap, "hooks/x.sh")) && fs.existsSync(path.join(snap, "generated/claude/agents/x.md")), "snapshot holds the three trees");
  check(!fs.existsSync(path.join(snap, "scripts/node_modules")), "ignored node_modules is not copied");
  check((fs.statSync(path.join(snap, "scripts/bin/a")).mode & 0o111) !== 0, "scripts/bin/a stays executable");
  check(fs.existsSync(path.join(snap, ".snapshot.json")), "snapshot carries its marker");
  check(readlink(path.join(binOf(home), "current")) === sha, "current is a relative symlink to the snapshot name");
  check(readlink(path.join(binOf(home), "checkout")) === src, "checkout links to the source path");
  check(fs.readFileSync(path.join(home, ".local/bin/a"), "utf8").includes("agents-a-shim"), "~/.local/bin/a is the shim");

  const marker = path.join(snap, ".snapshot.json");
  const first = fs.statSync(marker);
  const listed = listing(home);
  const again = runHelper(src, home);
  const second = fs.statSync(marker);
  check(again.out.includes("(reused)") && first.ino === second.ino && first.mtimeMs === second.mtimeMs && listing(home) === listed, "second install reuses the snapshot untouched");

  write(src, "scripts/lib/x.js", "module.exports = 2;\n");
  const dirty = runHelper(src, home);
  const dirtyName = readlink(path.join(binOf(home), "current"));
  check(/^[0-9a-f]{12}-dirty-[0-9a-f]{8}$/.test(dirtyName) && dirtyName.startsWith(sha), "uncommitted edit yields a content-addressed dirty name");
  check(dirty.out.includes("uncommitted changes"), "dirty install prints a warning");
  check(fs.readFileSync(path.join(snap, "scripts/lib/x.js"), "utf8") === "module.exports = 1;\n", "the clean snapshot is untouched by the dirty install");
  const dirtyAgain = runHelper(src, home);
  check(dirtyAgain.out.includes("(reused)"), "same dirty content is reused");
  write(src, "scripts/lib/x.js", "module.exports = 3;\n");
  runHelper(src, home);
  check(readlink(path.join(binOf(home), "current")) !== dirtyName, "different dirty content gets a different name");
}

{
  const src = makeFixture();
  const home = mk("home");
  write(src, "README.md", "edited\n");
  runHelper(src, home);
  check(/^[0-9a-f]{12}$/.test(readlink(path.join(binOf(home), "current"))), "edits outside the three trees keep the clean name");
}

{
  const src = makeFixture();
  const home = mk("home");
  write(home, ".local/bin/a", "#!/bin/sh\necho user-own\n", 0o755);
  runHelper(src, home);
  check(fs.readFileSync(path.join(home, ".local/bin/a.backup"), "utf8").includes("user-own") && fs.readFileSync(path.join(home, ".local/bin/a"), "utf8").includes("agents-a-shim"), "a foreign regular file at ~/.local/bin/a is backed up before the shim is written");

  const home2 = mk("home");
  fs.mkdirSync(path.join(home2, ".local/bin"), { recursive: true });
  fs.symlinkSync(path.join(src, "scripts/bin/a"), path.join(home2, ".local/bin/a"));
  runHelper(src, home2);
  const st = fs.lstatSync(path.join(home2, ".local/bin/a"));
  check(!st.isSymbolicLink() && fs.readFileSync(path.join(home2, ".local/bin/a"), "utf8").includes("agents-a-shim") && fs.readFileSync(path.join(src, "scripts/bin/a"), "utf8").includes("fixture-a"), "a symlink at ~/.local/bin/a is replaced without touching its target");
}

{
  const src = makeFixture();
  const home = mk("home");
  const sha = git(src, "rev-parse", "--short=12", "HEAD");
  write(binOf(home), `${sha}/half-copied.txt`, "partial\n");
  const r = runHelper(src, home);
  const names = listing(home).split(",");
  check(r.status === 0 && names.some((n) => n.startsWith(`.incomplete-${sha}-`)) && fs.existsSync(path.join(binOf(home), sha, ".snapshot.json")), "a marker-less snapshot directory is set aside and replaced by a complete one");
}

{
  const src = makeFixture();
  const home = mk("home");
  fs.mkdirSync(path.join(binOf(home), "current"), { recursive: true });
  const r = runHelper(src, home);
  check(r.status !== 0 && r.out.includes(path.join(binOf(home), "current")) && r.out.includes("not a symlink"), "a real directory named current fails with one message naming it");
}

// install.sh end to end in a temporary HOME

function installSh(home, args, cwd, tasksRoot) {
  const fakeBin = mk("fakebin");
  for (const tool of ["claude", "launchctl", "npm"]) {
    write(fakeBin, tool, `#!/bin/sh\necho "${tool} $*" >> "${home}/calls.log"\n`, 0o755);
  }
  const env = isolatedEnv(home, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    AGENTS_TASKS_ROOT: tasksRoot,
    AGENTS_SESSIONS_ROOT: mk("sessions"),
    AGENTS_LOGS_ROOT: mk("logs"),
  });
  const r = spawnSync("zsh", [path.join(repo, "install.sh"), ...args], { cwd, env, encoding: "utf8", input: "" });
  return { status: r.status, out: r.stdout, err: r.stderr, env };
}
const callsLog = (home) => (fs.existsSync(path.join(home, "calls.log")) ? fs.readFileSync(path.join(home, "calls.log"), "utf8") : "");

{
  const home = mk("home");
  const tasks = mk("tasks");
  fs.mkdirSync(home, { recursive: true });
  const sha = git(repo, "rev-parse", "--short=12", "HEAD");
  const r = installSh(home, [], repo, tasks);
  const current = path.join(binOf(home), "current");
  check(r.status === 0, `install.sh without flags exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(!/^(claude|launchctl)/m.test(callsLog(home)), "no flag install never calls claude or launchctl");
  check(!fs.existsSync(path.join(home, ".claude", "settings.json")), "no flag install writes no settings.json");
  check(readlink(current).startsWith(sha), "current names the checkout's HEAD sha");
  check(fs.existsSync(path.join(current, "scripts/bin/a")) && fs.existsSync(path.join(current, "hooks/prime.sh")) && fs.existsSync(path.join(current, "generated/claude/agents/conductor.md")), "snapshot has engine, stubs and generated agents");
  check(!fs.existsSync(path.join(current, "node_modules")), "snapshot has no node_modules");
  const stubsMatch = fs.readdirSync(path.join(current, "hooks")).filter((f) => f.endsWith(".sh")).every((f) => fs.readFileSync(path.join(home, ".claude/hooks", f), "utf8") === fs.readFileSync(path.join(current, "hooks", f), "utf8"));
  check(stubsMatch, "installed stubs equal the snapshot's stubs");
  const resolved = fs.realpathSync(path.join(current, "scripts/bin/a"));
  check(r.out.includes(`Hook stubs resolve a to: ${resolved} (via current)`), "summary names the resolved a");
  check(r.out.includes("settings  ~/.claude/settings.json untouched (pass --hooks"), "summary says settings were left alone");

  const shim = path.join(home, ".local/bin/a");
  const viaNode = spawnSync("node", [shim, "--help"], { env: r.env, encoding: "utf8" });
  const direct = spawnSync(shim, ["--help"], { env: r.env, encoding: "utf8" });
  check(viaNode.status === 0 && direct.status === 0, `the shim runs both as node <shim> and directly (${viaNode.status}, ${direct.status})`);
  const doc = spawnSync("node", [shim, "doctor", "--json"], { env: r.env, encoding: "utf8" });
  const parsed = JSON.parse(doc.stdout);
  check(parsed.a_resolves_to === resolved && parsed.a_via === "current", "doctor reports the same resolved path via current");

  const marker = path.join(current, ".snapshot.json");
  const first = fs.statSync(marker);
  const again = installSh(home, [], repo, tasks);
  const second = fs.statSync(marker);
  check(again.status === 0 && again.out.includes("(reused)") && readlink(current).startsWith(sha) && first.ino === second.ino && first.mtimeMs === second.mtimeMs, "re-install reuses the snapshot byte for byte");
  check(fs.readdirSync(tasks).length === 0, "install ran no task migration");
}

{
  const home = mk("home");
  const tasks = mk("tasks");
  const cwd = mk("cwd");
  const r = installSh(home, ["--hooks", "--force"], cwd, tasks);
  const settingsPath = path.join(home, ".claude", "settings.json");
  check(r.status === 0, `install.sh --hooks --force exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(fs.existsSync(settingsPath) && fs.readFileSync(settingsPath, "utf8").includes("$HOME/.claude/hooks/prime.sh"), "--hooks registers prime.sh in the temporary HOME's settings.json");
  check(r.out.includes("settings  ~/.claude/settings.json: hooks registered"), "summary says hooks registered");
  check(!/^claude/m.test(callsLog(home)), "--hooks never calls claude");
  check(fs.readdirSync(tasks).length === 0, "--hooks ran no task migration");
}

check(fingerprint() === before, "the real HOME is untouched");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
