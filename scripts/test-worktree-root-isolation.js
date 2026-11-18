#!/usr/bin/env node
"use strict";

// The worktree-root isolation regression (ASK-58). A suite that isolates its
// sessions and tasks roots but not its config leaves the CLI's config
// fallback — the real ~/.agents/config.json — in charge of worktrees_root,
// so its `a doctor --clean` runs over the real ~/.agents/worktrees and
// removes every clean, merged worktree there (13 real worktrees were lost
// that way; every receipt said "a doctor --clean"). Three pins:
//   A — the leak, reproduced safely: decoy worktrees under a decoy root a
//       sandbox HOME's config points at. An unisolated doctor --clean (the
//       leaky suite's exact env) removes them and lands its receipts in the
//       decoy root. The decoy root never holds anything real.
//   B — the isolated shape: the same world under a suite-style temp config
//       (worktrees_root under the run's own tmp). The decoys survive, no
//       receipt lands in the decoy root, and the run's own worktree goes
//       with its receipt under the temp root.
//   C — the wiring: test-cli-contract.js, the suite that runs doctor --clean,
//       sets AGENTS_CONFIG_PATH suite-wide ahead of its first test block;
//       every other suite exercising a worktree-removing path isolates the
//       config or the HOME the fallback resolves against.
// No child runs --clean before a probe proves the resolved worktrees root
// sits inside this run's sandbox.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { HANG_GUARD_MS } = require("./hang-guard");

const A_CLI = path.join(__dirname, "bin", "a");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-wt-iso-")));

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${(r.stderr || "").trim()}`);
  return (r.stdout || "").trim();
}
const COMMIT = ["-c", "user.email=t@e", "-c", "user.name=t"];

// A stub zmx on PATH: the doctor's liveness probes never reach the real one.
const zmxBin = path.join(BASE, "zmxbin");
fs.mkdirSync(zmxBin);
fs.writeFileSync(path.join(zmxBin, "zmx"),
  '#!/bin/sh\ncase "$1" in --version) echo "zmx 0.8.1"; exit 0;; list) exit 0;; esac\nexit 0\n', { mode: 0o755 });

/**
 * One sandbox world: a HOME, tasks and sessions roots, a repo with a local
 * origin, and a decoy worktrees root the HOME's config points at, holding
 * clean decoy worktrees on wt/ branches at main's tip — exactly the shape the
 * one removal rule lets go.
 */
function world(tag) {
  const base = path.join(BASE, tag);
  const home = path.join(base, "home");
  const tasks = path.join(base, "tasks");
  const sessions = path.join(base, "sessions");
  const decoyRoot = path.join(base, "decoy-worktrees");
  const repo = path.join(base, "repos", "decoy-main");
  const origin = path.join(base, "repos", "decoy-origin.git");
  for (const d of [path.join(home, ".agents"), tasks, sessions, repo]) {
    fs.mkdirSync(d, { recursive: true });
  }
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "decoy\n");
  git(repo, [...COMMIT, "add", "."]);
  git(repo, [...COMMIT, "commit", "-q", "-m", "init"]);
  git(repo, ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  const decoys = ["900-decoy-a", "901-decoy-b"].map((name) => {
    const dir = path.join(decoyRoot, "decoy-main", name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, ["worktree", "add", "-q", "-b", `wt/${name}`, dir, "main"]);
    return dir;
  });
  fs.writeFileSync(path.join(home, ".agents", "config.json"),
    JSON.stringify({ worktrees_root: decoyRoot }, null, 2) + "\n");
  return { base, home, tasks, sessions, decoyRoot, repo, decoys };
}

/**
 * The suite-shaped env: sessions and tasks roots isolated, HOME the sandbox
 * (whose config points worktrees_root at the decoy root — the stand-in for
 * the owner's real config), and AGENTS_CONFIG_PATH absent unless the caller
 * wires one — the exact combination that produced the leak.
 */
function suiteEnv(w, { configPath } = {}) {
  const env = {
    HOME: w.home,
    PATH: `${zmxBin}:${process.env.PATH}`,
    AGENTS_TASKS_ROOT: w.tasks,
    AGENTS_SESSIONS_ROOT: w.sessions,
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  if (configPath) env.AGENTS_CONFIG_PATH = configPath;
  return env;
}

function doctor(w, env, args) {
  return spawnSync(process.execPath, [A_CLI, "doctor", ...args, "--json"],
    { encoding: "utf8", cwd: w.repo, env, timeout: HANG_GUARD_MS });
}

/** Resolve worktreesRoot() in a child under `env` — the interlock that must
 *  name a root inside this sandbox before any --clean runs. */
function probeRoot(env, cwd) {
  const r = spawnSync(process.execPath, ["-e",
    `console.log(require(${JSON.stringify(path.join(__dirname, "lib", "worktree"))}).worktreesRoot())`],
    { encoding: "utf8", cwd, env, timeout: HANG_GUARD_MS });
  return r.status === 0 ? (r.stdout || "").trim() : `probe failed: ${(r.stderr || "").trim()}`;
}

function surveyRows(w, env) {
  const r = doctor(w, env, []);
  return { exit: r.status, rows: (JSON.parse(r.stdout).info || {}).worktrees || [] };
}

// A. The leak, reproduced safely on decoys — never the real root.
try {
  const w = world("leak");
  const env = suiteEnv(w);
  const resolved = probeRoot(env, w.repo);
  if (resolved !== w.decoyRoot) {
    fail_(`A: the unisolated env resolved worktrees_root at ${resolved}, expected the decoy ${w.decoyRoot} — no --clean was run`);
  } else {
    ok("A: without AGENTS_CONFIG_PATH the fallback resolves worktrees_root at the decoy root");
    const { rows } = surveyRows(w, env);
    const blastKnown = rows.length === 2
      && rows.every((r) => w.decoys.includes(r.path))
      && rows.every((r) => r.removable === true);
    if (!blastKnown) {
      fail_(`A: the survey did not list exactly the decoys as removable: ${JSON.stringify(rows.map((r) => [r.path, r.removable]))} — no --clean was run`);
    } else {
      ok("A: the survey lists the decoy worktrees as removable (the blast radius, read-only)");
      const clean = doctor(w, env, ["--clean"]);
      const removed = (JSON.parse(clean.stdout).clean || {}).removed || [];
      check(w.decoys.every((d) => removed.some((r) => r.path === d) && !fs.existsSync(d)),
        "A: the unisolated doctor --clean removes the decoy worktrees (the leak, safely reproduced)");
      const receiptDir = path.join(w.decoyRoot, "decoy-main", ".removed");
      const receipts = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter((f) => f.endsWith(".json")) : [];
      let receiptOk = receipts.length === 2;
      for (const f of receipts) {
        const doc = JSON.parse(fs.readFileSync(path.join(receiptDir, f), "utf8"));
        if (doc.reason !== "a doctor --clean" || doc.repo !== w.repo) receiptOk = false;
      }
      check(receiptOk, `A: one receipt per decoy lands in the decoy root, reason "a doctor --clean" (${receipts.join(", ")})`);
    }
  }
} catch (e) { fail_("A: " + (e && e.message ? e.message : e)); }

// B. The isolated shape — the fixed suite's env — cannot reach the decoys.
try {
  const w = world("isolated");
  const isoRoot = path.join(w.base, "iso-worktrees");
  const runConfig = path.join(w.base, "run-config.json");
  fs.writeFileSync(runConfig, JSON.stringify({ worktrees_root: isoRoot }, null, 2) + "\n");
  const own = path.join(isoRoot, "decoy-main", "902-own");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  git(w.repo, ["worktree", "add", "-q", "-b", "wt/902-own", own, "main"]);
  const env = suiteEnv(w, { configPath: runConfig });
  const resolved = probeRoot(env, w.repo);
  if (resolved !== isoRoot) {
    fail_(`B: the isolated env resolved worktrees_root at ${resolved}, expected ${isoRoot} — no --clean was run`);
  } else {
    ok("B: the suite-style temp config resolves worktrees_root inside the run's own root");
    const { rows } = surveyRows(w, env);
    const ownOnly = rows.length === 1 && rows[0].path === own && rows[0].removable === true;
    if (!ownOnly) {
      fail_(`B: the survey did not list exactly the run's own worktree: ${JSON.stringify(rows.map((r) => [r.path, r.removable]))} — no --clean was run`);
    } else {
      ok("B: the survey sees the run's own worktree only — no decoy row");
      const clean = doctor(w, env, ["--clean"]);
      const removed = (JSON.parse(clean.stdout).clean || {}).removed || [];
      check(removed.some((r) => r.path === own) && !fs.existsSync(own),
        "B: the run's own worktree is removed under the isolated root");
      const receipt = path.join(isoRoot, "decoy-main", ".removed", "902-own.json");
      const doc = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : null;
      check(doc && doc.reason === "a doctor --clean", "B: the receipt lands under the isolated root");
      check(w.decoys.every((d) => fs.existsSync(d)) && !fs.existsSync(path.join(w.decoyRoot, "decoy-main", ".removed")),
        "B: the decoy worktrees survive and the decoy root gets no receipt");
    }
  }
} catch (e) { fail_("B: " + (e && e.message ? e.message : e)); }

// C. The wiring, pinned: the suite that runs doctor --clean sets its config
// suite-wide; every other suite exercising a worktree-removing path isolates
// the config or the HOME the fallback resolves against.
try {
  const contract = fs.readFileSync(path.join(__dirname, "test-cli-contract.js"), "utf8");
  const wired = contract.indexOf("process.env.AGENTS_CONFIG_PATH =");
  const firstBlock = contract.indexOf("try {");
  check(wired !== -1 && firstBlock !== -1 && wired < firstBlock,
    "C: test-cli-contract.js wires AGENTS_CONFIG_PATH suite-wide, ahead of its first test block");
  const remover = /--clean|cleanSurvey|\breap\s*\(|closeTask\s*\(|"task",\s*"close"|tasks-sweep|require\("\.\/lib\/start"\)/;
  const here = path.basename(__filename);
  for (const f of fs.readdirSync(__dirname).filter((x) => /^test-.*\.js$/.test(x) && x !== here && x !== "test-cli-contract.js")) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    if (!remover.test(src)) continue;
    const at = src.indexOf("AGENTS_CONFIG_PATH");
    const cfg = at !== -1 && /^AGENTS_CONFIG_PATH\s*[=:]/.test(src.slice(at));
    const home = /process\.env\.HOME\s*=|HOME:\s*[\w"']/.test(src);
    check(cfg || home, `C: ${f} runs a worktree-removing path and isolates the config or HOME`);
  }
} catch (e) { fail_("C: " + (e && e.message ? e.message : e)); }

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
