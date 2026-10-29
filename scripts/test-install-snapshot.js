#!/usr/bin/env node
"use strict";
// install-snapshot.js on a fixture repo, then install.sh end to end in a
// temporary HOME. The real HOME is fingerprinted before and after.

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
  const env = isolatedEnv(home, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    AGENTS_TASKS_ROOT: tasksRoot,
    AGENTS_SESSIONS_ROOT: mk("sessions"),
    AGENTS_LOGS_ROOT: mk("logs"),
  });
  Object.assign(env, opts.env || {});
  const r = spawnSync("zsh", [path.join(repo, "install.sh"), ...args], { cwd, env, encoding: "utf8", input: "" });
  return { status: r.status, out: r.stdout, err: r.stderr, env };
}
const npmLines = (home) => callsLog(home).split("\n").filter((l) => l.startsWith("npm "));
const claudeLines = (home) => callsLog(home).split("\n").filter((l) => l.startsWith("claude "));
const SERVER_LINE = (home) => `claude mcp add --scope user state-manager ${home}/.agents/bin/node ${home}/.agents/bin/current/scripts/state-server.js`;
let seededHome = null;
const callsLog = (home) => (fs.existsSync(path.join(home, "calls.log")) ? fs.readFileSync(path.join(home, "calls.log"), "utf8") : "");

{
  const home = mk("home");
  const tasks = mk("tasks");
  fs.mkdirSync(home, { recursive: true });
  seedDeps(home);
  seededHome = home;
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
  check(parsed.a_resolves_to === resolved && parsed.a_via === "current", "doctor reports the same resolved path via current");

  const marker = path.join(current, ".snapshot.json");
  const first = fs.statSync(marker);
  const again = installSh(home, [], repo, tasks);
  const second = fs.statSync(marker);
  check(again.status === 0 && again.out.includes("(reused)") && readlink(current).startsWith(sha) && first.ino === second.ino && first.mtimeMs === second.mtimeMs, "re-install reuses the snapshot byte for byte");
  check(npmLines(home).length === 0 && again.out.includes("(present)"), "DP2: a re-install runs no npm and says present");
  check(fs.readdirSync(tasks).length === 0, "install ran no task migration");
}

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
  check(JSON.parse(doctor().stdout).node.sqlite === true, "N2: doctor reports node:sqlite loadable");

  const wrapper = path.join(mk("wrap"), "node-nosqlite");
  write(path.dirname(wrapper), path.basename(wrapper), `#!/bin/sh\nexec "${process.execPath}" --no-experimental-sqlite "$@"\n`, 0o755);
  fs.rmSync(nodeLink);
  fs.symlinkSync(wrapper, nodeLink);
  const bad = JSON.parse(doctor().stdout);
  check(bad.ok === false && bad.issues.some((i) => i.includes("node:sqlite")), "N2: doctor lists an issue when the recorded node lacks node:sqlite");

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

  const withHooks = installSh(home, ["--hooks", "--force"], repo, mk("tasks"));
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = Object.values(after.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  const agentsCommands = commands.filter((c) => c.startsWith("$HOME/.claude/hooks/")).map((c) => c.split("/").pop()).sort();
  check(withHooks.status === 0 && agentsCommands.join() === "session-end.sh,session-register.sh", `I4: --hooks --force leaves exactly the two AGENTS commands (${agentsCommands})`);
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
  check(ok.ok === true && ok.node.sqlite === true && ok.hooks_registered === 2, `D4: doctor ok branch reports node.sqlite and hooks_registered 2 (${JSON.stringify(ok.issues || ok.message)})`);
  check(JSON.stringify(ok.hook_outcomes) === JSON.stringify({ recorded: 1, not_recorded: 1, error: 0 }) && !("hook_blocks" in ok) && ok.hooks === "on", "D4: the five-field outcome lines are counted, the four-field line is ignored, no hook_blocks key");
  fs.rmSync(path.join(binOf(home), "node"));
  const bad = doctor();
  check(bad.ok === false && bad.node.path === null && bad.hooks_registered === 2 && bad.hook_outcomes.recorded === 1, "D4: the issues branch carries node, hooks_registered and hook_outcomes too");
}

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
  check(fs.readdirSync(hooksDir).sort().join() === "acme-notify.sh,notes.txt,session-end.sh,session-register.sh", `R1: ~/.claude/hooks holds the two and the two foreign files (${fs.readdirSync(hooksDir)})`);
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
}

{
  const prefix = mk("prefix");
  const home = mk("home");
  const r = installSh(home, ["--mcp"], repo, mk("tasks"), { env: { INSTALL_PREFIX: prefix } });
  check(r.status === 0 && claudeLines(home).length === 0 && /^ {2}mcp {7}state-manager: refused \(INSTALL_PREFIX is set\)$/m.test(r.out),
    `IM4: under INSTALL_PREFIX registration is refused and nothing is called (${r.status})`);
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

(async () => {
  const home = seededHome;
  const EXPECTED = ["add_phases", "code_index_build", "code_index_status", "decide", "land", "note", "prime"];
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
