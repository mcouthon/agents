#!/usr/bin/env node
"use strict";
// Freezes the engine (scripts/, hooks/, generated/claude/agents/) into
// ~/.agents/bin/<name>/ and repoints ~/.agents/bin/current at it. Builtins
// only: install.sh runs this before anything else is known to work.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const TREES = ["scripts", "hooks", "generated/claude/agents"];
const MARKER = ".snapshot.json";
const SHIM_MARKER = "agents-a-shim";

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
require(fs.realpathSync(target));
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
  if (sha === null) {
    const files = [];
    for (const t of trees) walk(src, t, files);
    return { files: files.sort(), sha: null, dirty: false };
  }
  const listed = git(src, ["ls-files", "-co", "--exclude-standard", "-z", "--", ...trees]);
  if (listed === null) throw new Error(`git ls-files failed in ${src}`);
  const files = listed
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(src, f)))
    .sort();
  const status = git(src, ["status", "--porcelain", "--untracked-files=all", "--", ...trees]);
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

function installSnapshot({ src, home }) {
  src = path.resolve(src);
  if (!fs.existsSync(path.join(src, "scripts", "bin", "a"))) {
    throw new Error(`${src}/scripts/bin/a not found; is --src the checkout root?`);
  }
  const { files, sha, dirty } = listSource(src);
  const name = sha === null ? `nogit-${contentHash(src, files)}` : dirty ? `${sha}-dirty-${contentHash(src, files)}` : sha;
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
  repoint(path.join(bin, "current"), name);
  repoint(path.join(bin, "checkout"), src);
  const shim = writeShim(home);
  return { name, state, dirty, shim, source: src };
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
  if (!home) throw new Error("usage: install-snapshot.js --src <checkout> --home <home> | --resolve --home <home>");
  if (argv.includes("--resolve")) {
    const r = resolveStubA(home);
    process.stdout.write(`${r.path || "(none)"} (via ${r.via})\n`);
    return;
  }
  const src = arg(argv, "--src");
  if (!src) throw new Error("--src is required");
  const r = installSnapshot({ src, home });
  if (r.dirty) process.stderr.write(`warning: installing uncommitted changes from ${r.source}\n`);
  process.stdout.write(`snapshot ${r.name} (${r.state})\n`);
  process.stdout.write(`current -> ${r.name}\n`);
  process.stdout.write(`a -> ${r.shim} (shim)\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`install-snapshot: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { snapshotName, installSnapshot, resolveStubA, SHIM_SOURCE };
