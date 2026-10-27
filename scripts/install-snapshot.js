#!/usr/bin/env node
"use strict";
// Freezes the engine (scripts/, hooks/, generated/claude/agents/, the memory seeds and the package
// files) into ~/.agents/bin/<name>/, links the snapshot's node_modules to the shared dependency tree
// for its lockfile and repoints ~/.agents/bin/current at it once that tree is built. Builtins only:
// install.sh runs this before anything else is known to work.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const TREES = ["scripts", "hooks", "generated/claude/agents", "templates/agents/memory"];
const PACKAGE_FILES = ["package.json", "package-lock.json"];
const MARKER = ".snapshot.json";
const SHIM_MARKER = "agents-a-shim";
const HASH_DIR = /^[0-9a-f]{64}$/;
const LINK_TARGET = /^\.\.\/deps\/([0-9a-f]{64})\/node_modules$/;

const SHIM_SOURCE = `#!/usr/bin/env node
// agents-a-shim: written by install.sh; runs the installed snapshot of \`a\`.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const bin = path.join(os.homedir(), ".agents", "bin");
let target = path.join(bin, "current", "scripts", "bin", "a");
if (!fs.existsSync(target)) {
  const fallback = path.join(bin, "checkout", "scripts", "bin", "a");
  if (!fs.existsSync(fallback)) {
    process.stderr.write("a: no installed engine in ~/.agents/bin (run ./install.sh)\\n");
    process.exit(1);
  }
  process.stderr.write("a: ~/.agents/bin/current is missing; running the checkout (re-run ./install.sh)\\n");
  target = fallback;
}
const real = fs.realpathSync(target);
if (process.env.AGENTS_SHIM_REEXEC) {
  delete process.env.AGENTS_SHIM_REEXEC;
} else {
  let recorded = null;
  try {
    recorded = fs.realpathSync(path.join(bin, "node"));
  } catch {}
  if (recorded && recorded !== fs.realpathSync(process.execPath)) {
    const r = require("child_process").spawnSync(recorded, [process.argv[1], ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, AGENTS_SHIM_REEXEC: "1" },
    });
    if (!r.error) {
      if (r.signal) process.kill(process.pid, r.signal);
      process.exit(r.status === null ? 1 : r.status);
    }
  }
}
require(real);
`;

function git(src, args) {
  try {
    return execFileSync("git", ["-C", src, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch {
    return null;
  }
}

function walk(root, rel, out) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

// Returns { files, sha, dirty }; sha is null outside a git repository.
function listSource(src) {
  const sha = (git(src, ["rev-parse", "--short=12", "HEAD"]) || "").trim() || null;
  const trees = TREES.filter((t) => fs.existsSync(path.join(src, t)));
  const packageFiles = PACKAGE_FILES.filter((f) => fs.existsSync(path.join(src, f)));
  if (sha === null) {
    const files = [];
    for (const t of trees) walk(src, t, files);
    return { files: [...files, ...packageFiles].sort(), sha: null, dirty: false };
  }
  const paths = [...trees, ...packageFiles];
  const listed = git(src, ["ls-files", "-co", "--exclude-standard", "-z", "--", ...paths]);
  if (listed === null) throw new Error(`git ls-files failed in ${src}`);
  const files = listed
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(src, f)))
    .sort();
  const status = git(src, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  return { files, sha, dirty: Boolean(status && status.trim()) };
}

function contentHash(src, files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const mode = fs.statSync(path.join(src, f)).mode & 0o777;
    h.update(`${f}\0${mode}\0`);
    h.update(fs.readFileSync(path.join(src, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

function snapshotName(src) {
  const { files, sha, dirty } = listSource(src);
  if (sha === null) return `nogit-${contentHash(src, files)}`;
  return dirty ? `${sha}-dirty-${contentHash(src, files)}` : sha;
}

/** sha256 hex of the checkout's package-lock.json, or null without one: the name of its dependency tree. */
function depsHash(src) {
  const lock = path.join(src, "package-lock.json");
  if (!fs.existsSync(lock)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(lock)).digest("hex");
}

const linkTarget = (hash) => path.join("..", "deps", hash, "node_modules");

function repoint(link, target) {
  let st = null;
  try {
    st = fs.lstatSync(link);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && !st.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink; move it aside and re-run`);
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

function writeShim(home) {
  const dir = path.join(home, ".local", "bin");
  const dest = path.join(dir, "a");
  fs.mkdirSync(dir, { recursive: true });
  let st = null;
  try {
    st = fs.lstatSync(dest);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && !st.isSymbolicLink() && st.isFile() && !fs.readFileSync(dest, "utf8").includes(SHIM_MARKER)) {
    fs.renameSync(dest, `${dest}.backup`);
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, SHIM_SOURCE, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  return dest;
}

function copyFiles(src, files, destRoot) {
  for (const f of files) {
    const to = path.join(destRoot, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
    fs.chmodSync(to, fs.statSync(path.join(src, f)).mode & 0o777);
  }
}

/** Link `<dir>/node_modules` to the shared tree when nothing is there; an existing entry stays. */
function linkDeps(dir, hash) {
  const link = path.join(dir, "node_modules");
  try {
    fs.lstatSync(link);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(linkTarget(hash), tmp);
  fs.renameSync(tmp, link);
}

/** The hashes of the dependency trees the kept snapshots link to. */
function linkedHashes(bin) {
  const hashes = new Set();
  for (const entry of fs.readdirSync(bin)) {
    if (!fs.existsSync(path.join(bin, entry, MARKER))) continue;
    try {
      const m = LINK_TARGET.exec(fs.readlinkSync(path.join(bin, entry, "node_modules")));
      if (m) hashes.add(m[1]);
    } catch {
      /* no link in this snapshot */
    }
  }
  return hashes;
}

/** Move every dependency tree no kept snapshot links to the trash; returns the moves. */
function pruneDeps(home, bin) {
  const depsRoot = path.join(bin, "deps");
  if (!fs.existsSync(depsRoot)) return [];
  const linked = linkedHashes(bin);
  const moves = [];
  for (const name of fs.readdirSync(depsRoot).sort()) {
    if (!HASH_DIR.test(name) || linked.has(name)) continue;
    if (!fs.statSync(path.join(depsRoot, name)).isDirectory()) continue;
    const day = new Date().toISOString().slice(0, 10);
    const base = path.join(home, ".agents", "trash", day, "deps");
    fs.mkdirSync(base, { recursive: true });
    let dest = path.join(base, name);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(base, `${name}-${n}`);
    fs.renameSync(path.join(depsRoot, name), dest);
    moves.push({ hash: name, dest });
  }
  return moves;
}

function installSnapshot({ src, home, requireDeps = true }) {
  src = path.resolve(src);
  if (!fs.existsSync(path.join(src, "scripts", "bin", "a"))) {
    throw new Error(`${src}/scripts/bin/a not found; is --src the checkout root?`);
  }
  const { files, sha, dirty } = listSource(src);
  const name = sha === null ? `nogit-${contentHash(src, files)}` : dirty ? `${sha}-dirty-${contentHash(src, files)}` : sha;
  const hash = depsHash(src);
  const bin = path.join(home, ".agents", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const final = path.join(bin, name);
  let state = "reused";
  if (!fs.existsSync(path.join(final, MARKER))) {
    if (fs.existsSync(final)) fs.renameSync(final, path.join(bin, `.incomplete-${name}-${Math.floor(Date.now() / 1000)}`));
    const tmp = path.join(bin, `.tmp-${name}-${process.pid}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    copyFiles(src, files, tmp);
    if (hash) linkDeps(tmp, hash);
    const meta = { name, source: src, git_sha: sha, dirty, created_at: new Date().toISOString() };
    fs.writeFileSync(path.join(tmp, MARKER), JSON.stringify(meta, null, 2) + "\n");
    try {
      fs.renameSync(tmp, final);
      state = "new";
    } catch (e) {
      if (!fs.existsSync(path.join(final, MARKER))) throw e;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (hash) linkDeps(final, hash);
  const built = hash === null || fs.existsSync(path.join(bin, "deps", hash, "node_modules"));
  const activated = built || !requireDeps;
  if (activated) repoint(path.join(bin, "current"), name);
  repoint(path.join(bin, "checkout"), src);
  const node = path.join(bin, "node");
  repoint(node, process.execPath);
  const shim = writeShim(home);
  let pruned = [];
  let pruneError = null;
  try {
    pruned = pruneDeps(home, bin);
  } catch (e) {
    pruneError = e.message;
  }
  return { name, state, dirty, shim, source: src, node, deps: hash, activated, pruned, pruneError };
}

function resolveStubA(home) {
  const bin = path.join(home, ".agents", "bin");
  for (const via of ["current", "checkout"]) {
    const p = path.join(bin, via, "scripts", "bin", "a");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return { path: fs.realpathSync(p), via };
    } catch {}
  }
  return { path: null, via: "none" };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const home = arg(argv, "--home");
  if (!home) throw new Error("usage: install-snapshot.js --src <checkout> --home <home> [--no-deps-check] | --resolve --home <home>");
  if (argv.includes("--resolve")) {
    const r = resolveStubA(home);
    process.stdout.write(`${r.path || "(none)"} (via ${r.via})\n`);
    return;
  }
  const src = arg(argv, "--src");
  if (!src) throw new Error("--src is required");
  const r = installSnapshot({ src, home, requireDeps: !argv.includes("--no-deps-check") });
  if (r.dirty) process.stderr.write(`warning: installing uncommitted changes from ${r.source}\n`);
  process.stdout.write(`snapshot ${r.name} (${r.state})\n`);
  process.stdout.write(r.activated ? `current -> ${r.name}\n` : `current kept (the dependency tree ${String(r.deps).slice(0, 12)} is not built)\n`);
  process.stdout.write(`a -> ${r.shim} (shim)\n`);
  process.stdout.write(`node -> ${process.execPath} (${process.version})\n`);
  process.stdout.write(`deps ${r.deps || "none"}\n`);
  for (const m of r.pruned) process.stdout.write(`pruned deps ${m.hash} -> ${m.dest}\n`);
  if (r.pruneError) process.stdout.write(`prune failed ${r.pruneError}\n`);
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    require("node:sqlite");
  } catch {
    process.stderr.write(`warning: ${process.execPath} (${process.version}) has no node:sqlite; hooks skip while the database is on\n`);
  } finally {
    process.emitWarning = emitWarning;
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`install-snapshot: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { snapshotName, installSnapshot, resolveStubA, depsHash, SHIM_SOURCE };
