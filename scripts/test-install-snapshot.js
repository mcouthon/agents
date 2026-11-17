#!/usr/bin/env node
"use strict";
// install-snapshot.js on a fixture repo: snapshot linking and the dependency
// trees — the core shard of the former test-install-snapshot, split (with
// test-install-node and test-install-shims) when the suite outgrew every
// per-suite budget. The real HOME is fingerprinted before and after.

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

// Dependency trees: the snapshot links one tree per lockfile, and a snapshot whose tree is not built never becomes current

{
  const src = makeFixture();
  const home = mk("home");
  const r = runHelper(src, home);
  check(r.status === 0 && /^deps none$/m.test(r.out) && !exists(path.join(binOf(home), git(src, "rev-parse", "--short=12", "HEAD"), "node_modules")), "SD0: a fixture without a lockfile links no tree and prints deps none");
}

{
  const src = makeDepsFixture();
  const home = mk("home");
  const sha = git(src, "rev-parse", "--short=12", "HEAD");
  const H1 = sha256(LOCK_V1);
  seedTree(home, H1);
  const r = runHelper(src, home);
  const snap = path.join(binOf(home), sha);
  check(r.status === 0 && fs.readFileSync(path.join(snap, "package.json"), "utf8") === "{\"name\":\"fixture\",\"private\":true}\n" && fs.readFileSync(path.join(snap, "package-lock.json"), "utf8") === LOCK_V1,
    "SD1: the snapshot holds the package.json and package-lock.json it pairs with");
  check(fs.lstatSync(path.join(snap, "node_modules")).isSymbolicLink() && readlink(path.join(snap, "node_modules")) === `../deps/${H1}/node_modules` && !exists(path.join(snap, "scripts", "node_modules")),
    "SD1: node_modules is a relative symlink to deps/<lockfile hash>/node_modules and no tree is copied into scripts");
  check(r.out.split("\n").includes(`deps ${H1}`) && r.out.indexOf("node -> ") < r.out.indexOf(`deps ${H1}`), "SD1: the output names the hash on a deps line after the node line");
  check(fs.readFileSync(path.join(snap, "templates/agents/memory/x/MEMORY.md"), "utf8") === "seed\n", "SD3: the snapshot carries the memory seeds byte for byte");

  write(src, "package-lock.json", LOCK_V2);
  const dirty = runHelper(src, home);
  const dirtyName = fs.readdirSync(binOf(home)).find((n) => n.startsWith(`${sha}-dirty-`));
  check(Boolean(dirtyName) && dirty.out.split("\n").includes(`deps ${sha256(LOCK_V2)}`) && readlink(path.join(binOf(home), dirtyName, "node_modules")) === `../deps/${sha256(LOCK_V2)}/node_modules`,
    "SD2: an uncommitted lockfile edit gets its own snapshot name and its own deps hash");
}

{
  const src = makeDepsFixture();
  const home = mk("home");
  const sha = git(src, "rev-parse", "--short=12", "HEAD");
  const H1 = sha256(LOCK_V1);
  const snap = path.join(binOf(home), sha);
  for (const f of ["package.json", "package-lock.json", "scripts/bin/a", "scripts/lib/x.js"]) write(snap, f, fs.readFileSync(path.join(src, f), "utf8"));
  write(snap, ".snapshot.json", "{}\n");
  seedTree(home, H1);
  const files = ["package.json", "package-lock.json", "scripts/bin/a", ".snapshot.json"];
  const stamp = (f) => { const s = fs.statSync(path.join(snap, f)); return `${s.ino}:${s.mtimeMs}`; };
  const before = files.map(stamp).join();
  const r = runHelper(src, home);
  check(r.out.includes("(reused)") && readlink(path.join(snap, "node_modules")) === `../deps/${H1}/node_modules` && files.map(stamp).join() === before,
    "SD4: a snapshot an older helper left without its link gains the link and no existing file is touched");
  fs.rmSync(path.join(snap, "node_modules"));
  fs.mkdirSync(path.join(snap, "node_modules"));
  runHelper(src, home);
  check(fs.lstatSync(path.join(snap, "node_modules")).isDirectory() && !fs.lstatSync(path.join(snap, "node_modules")).isSymbolicLink(), "SD4: an existing node_modules entry is never replaced");
}

{
  const src = makeDepsFixture();
  const home = mk("home");
  const H1 = sha256(LOCK_V1);
  seedTree(home, H1);
  fs.mkdirSync(path.join(binOf(home), "deps", STRAY, "node_modules"), { recursive: true });
  write(path.join(binOf(home), "deps", STRAY), "node_modules/marker.txt", "kept\n");
  fs.mkdirSync(path.join(binOf(home), "deps", `.tmp-${H1}-99`), { recursive: true });
  fs.mkdirSync(path.join(binOf(home), "deps", "notes"), { recursive: true });
  const r = runHelper(src, home);
  const dest = path.join(home, ".agents", "trash", today, "deps", STRAY);
  check(exists(path.join(binOf(home), "deps", H1)) && !exists(path.join(binOf(home), "deps", STRAY)) && fs.readFileSync(path.join(dest, "node_modules", "marker.txt"), "utf8") === "kept\n" && r.out.includes(`pruned deps ${STRAY} -> ${dest}`),
    "PR1: a tree no snapshot links moves to the trash with its files, the linked one stays, and the output names the move");
  check(exists(path.join(binOf(home), "deps", `.tmp-${H1}-99`)) && exists(path.join(binOf(home), "deps", "notes")), "PR1: a build dir and a foreign directory under deps are left alone");

  fs.mkdirSync(path.join(binOf(home), "deps", STRAY, "node_modules"), { recursive: true });
  runHelper(src, home);
  check(exists(path.join(home, ".agents", "trash", today, "deps", `${STRAY}-2`)), "PR1: a taken trash name gets the -2 suffix");

  fs.mkdirSync(path.join(binOf(home), "deps", STRAY, "node_modules"), { recursive: true });
  fs.rmSync(path.join(home, ".agents", "trash"), { recursive: true, force: true });
  fs.writeFileSync(path.join(home, ".agents", "trash"), "a file where the trash directory belongs\n");
  const blocked = runHelper(src, home);
  check(blocked.status === 0 && /^prune failed /m.test(blocked.out) && exists(path.join(binOf(home), "deps", STRAY)) && fs.readlinkSync(path.join(binOf(home), "current")).length > 0,
    `PR1: a prune that cannot move a tree is reported on a prune failed line and the install still completes (${blocked.status})`);
}

{
  const src = makeDepsFixture();
  const home = mk("home");
  const sha = git(src, "rev-parse", "--short=12", "HEAD");
  const H1 = sha256(LOCK_V1);
  seedTree(home, H1);
  runHelper(src, home);
  write(src, "package-lock.json", LOCK_V2);
  const kept = runHelper(src, home);
  check(kept.status === 0 && readlink(path.join(binOf(home), "current")) === sha && /^current kept /m.test(kept.out) && !/^current -> /m.test(kept.out),
    `HD1: a snapshot whose dependency tree is not built is made but current keeps its snapshot (${readlink(path.join(binOf(home), "current"))})`);
  seedTree(home, sha256(LOCK_V2));
  const moved = runHelper(src, home);
  check(moved.out.includes("(reused)") && /^current -> /m.test(moved.out) && readlink(path.join(binOf(home), "current")) !== sha, "HD1: once the tree is built the next run repoints current");

  const home2 = mk("home");
  const forced = spawnSync("node", [helper, "--src", src, "--home", home2, "--no-deps-check"], { env: isolatedEnv(home2), encoding: "utf8" });
  check(forced.status === 0 && /^current -> /m.test(forced.stdout) && fs.readlinkSync(path.join(binOf(home2), "current")).length > 0, "HD1: --no-deps-check repoints current without a built tree");
}

// install.sh end to end in a temporary HOME

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

{
  const home = mk("home");
  const tasks = mk("tasks");
  fs.mkdirSync(home, { recursive: true });
  seedDeps(home);
  const sha = git(repo, "rev-parse", "--short=12", "HEAD");
  const r = installSh(home, [], repo, tasks);
  const current = path.join(binOf(home), "current");
  check(r.status === 0, `install.sh without flags exits 0 (${r.status}) ${r.status === 0 ? "" : r.out + r.err}`);
  check(!/^(claude|launchctl)/m.test(callsLog(home)), "no flag install never calls claude or launchctl");
  check(!fs.existsSync(path.join(home, ".claude", "settings.json")), "no flag install writes no settings.json");
  check(readlink(current).startsWith(sha), "current names the checkout's HEAD sha");
  check(fs.existsSync(path.join(current, "scripts/bin/a")) && fs.existsSync(path.join(current, "hooks/session-register.sh")) && fs.existsSync(path.join(current, "generated/claude/agents/conductor.md")), "snapshot has engine, stubs and generated agents");
  check(fs.lstatSync(path.join(current, "node_modules")).isSymbolicLink() && readlink(path.join(current, "node_modules")) === `../deps/${REPO_H}/node_modules` &&
    fs.existsSync(path.join(current, "templates/agents/memory/conductor/MEMORY.md")), "SD5: the snapshot links its dependency tree and carries the memory seeds");
  check(npmLines(home).length === 0 && /^ {2}deps {6}~\/\.agents\/bin\/deps\/[0-9a-f]{12} \(present\)$/m.test(r.out) && r.out.includes(`deps/${REPO_H.slice(0, 12)} (present)`),
    "DP2: a HOME that already has the tree runs no npm and the summary says present");
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
  check(parsed.info.a_resolves_to === resolved && parsed.info.a_via === "current", "doctor reports the same resolved path via current");

  const marker = path.join(current, ".snapshot.json");
  const first = fs.statSync(marker);
  const again = installSh(home, [], repo, tasks);
  const second = fs.statSync(marker);
  check(again.status === 0 && again.out.includes("(reused)") && readlink(current).startsWith(sha) && first.ino === second.ino && first.mtimeMs === second.mtimeMs, "re-install reuses the snapshot byte for byte");
  check(npmLines(home).length === 0 && again.out.includes("(present)"), "DP2: a re-install runs no npm and says present");
  check(fs.readdirSync(tasks).length === 0, "install ran no task migration");
}

// The shard's real-HOME guard — every install shard exits on it.
if (fingerprint() !== before) { fail++; console.log("FAIL: the real HOME is untouched"); }

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
