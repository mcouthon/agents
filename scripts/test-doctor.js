#!/usr/bin/env node
"use strict";

// `a doctor`'s output contract and drift mechanism, through the CLI under a
// fixture HOME that stands in for a fresh install. The default output is the
// verdict, the action rows and one state line; --verbose adds the standing
// facts once; --json serves {ok, actions, info}; the drift check expects what
// a fresh install would write. Isolation: HOME and every root point into temp
// dirs; nothing touches the real HOME, ~/.agents or ~/.claude.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-doctor-")));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_HOOKS_FLAG: path.join(t, "no-flag"),
    AGENTS_TEST_SKIP_IDENTITY: "1",
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_HOOKS_OFF", "CLAUDE_CODE_SESSION_ID", "AGENTS_DB"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { HANG_GUARD_MS, spawnErr } = require("./hang-guard");

const REPO = path.resolve(__dirname, "..");
const A = path.join(__dirname, "bin", "a");
const TMP = process.env.AGENTS_TEST_TMP;

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail_(msg); }

const origEmit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = origEmit;

/** A defaults-config generation, shared by the fixtures (the generator is deterministic). */
const DEFAULTS_GEN = (() => {
  const dir = path.join(TMP, "defaults-gen");
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts/generate.js"), "cc",
    "--config", path.join(REPO, "defaults/config.json"),
    "--source", path.join(REPO, "templates"), "--output-dir", dir],
    { encoding: "utf8", timeout: HANG_GUARD_MS });
  if (r.status !== 0) throw new Error("defaults generation failed: " + r.stderr + r.stdout);
  return dir;
})();

/** A generation under an arbitrary config — what install.sh runs for ~/.claude/agents. */
function generateWith(configPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-doctor-gen-"));
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts/generate.js"), "cc",
    "--config", configPath, "--source", path.join(REPO, "templates"), "--output-dir", dir],
    { encoding: "utf8", timeout: HANG_GUARD_MS });
  if (r.status !== 0) throw new Error("generation failed: " + r.stderr + r.stdout);
  return dir;
}

function makeRepo(dir) {
  fs.mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  execFileSync("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return dir;
}

/**
 * A fixture HOME that stands in for a fresh install: registered settings,
 * installed agents and hook stubs from a real generation, the `a` shim, the
 * current-snapshot layout, the recorded node, a zmx stub on PATH, a git repo
 * as the central tasks root — every plain `a doctor` check green.
 */
function scenario({ config } = {}) {
  // realpathSync: git reports resolved paths (/private/var on macOS), so every
  // planted path must be canonical or the strict-equality assertions drift.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-doctor-case-")));
  const home = path.join(base, "home");
  const tasks = path.join(base, "tasks");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(tasks, { recursive: true });
  const installer = require("./lib/adapter/claude-code/install");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(installer.computeNewSettings({}), null, 2) + "\n");
  fs.cpSync(path.join(DEFAULTS_GEN, "claude", "agents"), path.join(home, ".claude", "agents"), { recursive: true });
  fs.cpSync(path.join(REPO, "hooks"), path.join(home, ".claude", "hooks"), { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "config.json"), JSON.stringify(config, null, 2) + "\n");
  }
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "bin", "a"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".agents", "bin", "current", "scripts", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agents", "bin", "current", "scripts", "bin", "a"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(home, ".agents", "bin", "node"));
  execFileSync("git", ["-C", tasks, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", tasks, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const zmxbin = path.join(base, "zmxbin");
  fs.mkdirSync(zmxbin);
  fs.writeFileSync(path.join(zmxbin, "zmx"), "#!/bin/sh\ncase \"$1\" in --version) echo \"zmx 0.8.1\"; exit 0;; esac\nexit 0\n", { mode: 0o755 });
  const cwd = path.join(base, "elsewhere");
  fs.mkdirSync(cwd);
  const env = { ...process.env, HOME: home, AGENTS_TASKS_ROOT: tasks,
    AGENTS_SESSIONS_ROOT: path.join(base, "sessions"), PATH: `${zmxbin}:${process.env.PATH}` };
  return { base, home, tasks, cwd, env, dbFile: path.join(tasks, ".agents.db") };
}

function runA(sc, args, cli = A) {
  return spawnSync(process.execPath, [cli, ...args],
    { encoding: "utf8", cwd: sc.cwd, env: sc.env, timeout: HANG_GUARD_MS });
}

/** A read-only query against a scenario's database. */
function readDb(sc, sql, ...params) {
  const d = new DatabaseSync(sc.dbFile, { readOnly: true });
  try { return d.prepare(sql).all(...params); } finally { d.close(); }
}

/** Seed repos rows (and optionally an archived task) through the db library. */
function seed(sc, { repos = [], archivedTaskOf } = {}) {
  const lines = repos.map((r) => `db.upsertRepo(${JSON.stringify(r.key)}, { main_root: ${JSON.stringify(r.main_root)} });`);
  if (archivedTaskOf) {
    lines.push(`db.createTaskRow(${JSON.stringify({
      repoKey: archivedTaskOf, dirName: "001-gone", taskDir: path.join(sc.tasks, archivedTaskOf, "001-gone"),
      slug: "001-gone", number: 1, title: "Gone", tier: "standard", mode: "full", created: "2026-11-01",
      approvals: "none", land: "per_phase", worktreePath: null, branch: null, phases: [{ id: 1, name: "One" }],
    })});`);
    lines.push(`db.setTaskDisposition({ repoKey: ${JSON.stringify(archivedTaskOf)}, dirName: "001-gone", disposition: "archived" });`);
  }
  const code = `const db = require(${JSON.stringify(path.join(REPO, "scripts/lib/db"))}); db.open({ create: true });\n${lines.join("\n")}`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: sc.env, timeout: HANG_GUARD_MS });
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`);
}

/** Harness worktrees inside `repo` (the survey's second loop lists them): a
 *  removable one unless `removable: false`, plus one that stays (unmerged). */
function plantWorktrees(repo, { removable = true } = {}) {
  const root = path.join(repo, ".claude", "worktrees");
  fs.mkdirSync(root, { recursive: true });
  let removableDir = null;
  if (removable) {
    execFileSync("git", ["-C", repo, "branch", "harness-removable"]);
    removableDir = path.join(root, "removable");
    execFileSync("git", ["-C", repo, "worktree", "add", removableDir, "harness-removable"]);
  }
  execFileSync("git", ["-C", repo, "branch", "harness-unmerged"]);
  const unmergedDir = path.join(root, "unmerged");
  execFileSync("git", ["-C", repo, "worktree", "add", unmergedDir, "harness-unmerged"]);
  fs.writeFileSync(path.join(unmergedDir, "extra.txt"), "unmerged\n");
  execFileSync("git", ["-C", unmergedDir, "add", "."]);
  execFileSync("git", ["-C", unmergedDir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "unmerged"]);
  return { removableDir, unmergedDir };
}

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------

// OC1: a fresh-install fixture prints exactly the verdict and the state line, nothing else.
try {
  const sc = scenario();
  const r = runA(sc, ["doctor"]);
  check(r.status === 0 && r.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old\n",
    `OC1: a doctor on a fresh install prints the two default lines and exits 0 (exit ${r.status}, ${JSON.stringify(r.stdout)})`);
  check(r.stderr === "", `OC1: the default output writes nothing to stderr (${JSON.stringify(r.stderr.slice(0, 200))})`);
} catch (e) { fail_("OC1: " + spawnErr(e, "cli")); }

// OC2: a gone repo row is one action row carrying the purge remedy, beside the state line.
try {
  const sc = scenario();
  const goneRoot = path.join(sc.base, "gone-checkout");
  seed(sc, { repos: [{ key: "github.com/acme/gone", main_root: goneRoot }] });
  const r = runA(sc, ["doctor"]);
  const lines = r.stdout.split("\n").filter(Boolean);
  check(r.status === 1 && lines.length === 3
    && lines[0] === "a doctor: 1 item need action"
    && lines[1] === `action: repo github.com/acme/gone (${goneRoot} gone) — purge: a doctor --clean`
    && lines[2].startsWith("state: "),
    `OC2: a gone repo row is one action row with the purge remedy and the state line still prints (exit ${r.status}, ${JSON.stringify(lines)})`);
  check(r.stderr === "", `OC2: the action rows print on stdout only (${JSON.stringify(r.stderr.slice(0, 200))})`);
} catch (e) { fail_("OC2: " + spawnErr(e, "cli")); }

// OC3: --verbose adds the standing facts once, and no line appears in both streams.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  fs.mkdirSync(path.join(liveRepo, ".tasks", "001-stray"), { recursive: true });
  fs.writeFileSync(path.join(liveRepo, ".tasks", "001-stray", "task.md"), "# Stray\n");
  seed(sc, { repos: [
    { key: "github.com/acme/gone", main_root: path.join(sc.base, "gone-checkout") },
    { key: "github.com/acme/live", main_root: liveRepo },
  ] });
  const plain = runA(sc, ["doctor"]);
  const plainLines = plain.stdout.split("\n").filter(Boolean);
  check(plain.status === 1 && plainLines.some((l) => l === "action: task notes outside the central folder: 1 locations — move them into the central root (a doctor --verbose lists each)")
    && plain.stderr === "",
    `OC3: the strays collapse to one count row in the default output (exit ${plain.status}, ${JSON.stringify(plainLines)})`);

  const v = runA(sc, ["doctor", "--verbose"]);
  const errLines = v.stderr.split("\n").filter(Boolean);
  check(v.status === 1 && v.stdout === plain.stdout,
    `OC3: --verbose prints the same verdict block (exit ${v.status})`);
  check(errLines.some((l) => l.startsWith("a (hook stubs): "))
    && errLines.some((l) => l.startsWith("db: "))
    && errLines.some((l) => l.startsWith("node (hook stubs): "))
    && errLines.some((l) => l.startsWith("Hook log: "))
    && errLines.some((l) => l.startsWith("Hook outcomes today: ")),
    `OC3: --verbose prints the a-via, db, node and hook-log facts (${errLines.length} lines)`);
  const strayLine = errLines.filter((l) => l.startsWith("task notes outside the central folder: "));
  check(strayLine.length === 1 && strayLine[0].includes("no verb folds")
    && strayLine[0].includes(path.join(liveRepo, ".tasks", "001-stray"))
    && strayLine[0].includes(path.join(sc.tasks, "github.com/acme/live")),
    `OC3: each stray path prints once under --verbose with its destination (${JSON.stringify(strayLine)})`);
  check(v.stdout.split("\n").filter(Boolean).every((l) => !errLines.includes(l)),
    "OC3: no line appears in both the stdout and the stderr form");
  const alias = runA(sc, ["doctor", "-v"]);
  check(alias.status === v.status && alias.stdout === v.stdout && alias.stderr === v.stderr,
    "OC3: a doctor -v prints what a doctor --verbose prints");
} catch (e) { fail_("OC3: " + spawnErr(e, "cli")); }

// OC4: --json serves the machine shape with the fields the roster and the doctor pin.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  fs.mkdirSync(path.join(liveRepo, ".tasks", "001-stray"), { recursive: true });
  fs.writeFileSync(path.join(liveRepo, ".tasks", "001-stray", "task.md"), "# Stray\n");
  const { removableDir, unmergedDir } = plantWorktrees(liveRepo);
  seed(sc, { repos: [
    { key: "github.com/acme/gone", main_root: path.join(sc.base, "gone-checkout") },
    { key: "github.com/acme/live", main_root: liveRepo },
  ] });
  const bak = `${sc.dbFile}.v1.bak`;
  const stamped = `${sc.dbFile}.v1.bak.20261030T120000Z`;
  fs.writeFileSync(bak, "v1\n");
  fs.writeFileSync(stamped, "v1\n");
  const r = runA(sc, ["doctor", "--json"]);
  const out = JSON.parse(r.stdout);
  const texts = (out.actions || []).map((a) => a.text);
  check(r.status === 1 && out.ok === false && r.stderr === "",
    `OC4: --json serves {ok, actions} and exits 1 with nothing on stderr (exit ${r.status})`);
  check(texts.some((t) => t === `repo github.com/acme/gone (${path.join(sc.base, "gone-checkout")} gone)`),
    `OC4: the gone repo is an action row (${JSON.stringify(texts)})`);
  check(JSON.stringify(out.info.db.v1_backups) === JSON.stringify([bak, stamped]),
    `OC4: info.db.v1_backups lists every .v1.bak (${JSON.stringify(out.info.db.v1_backups)})`);
  const removableRow = (out.info.worktrees || []).find((w) => w.path === removableDir);
  const keptRow = (out.info.worktrees || []).find((w) => w.path === unmergedDir);
  check(removableRow && removableRow.removable === true && keptRow && keptRow.removable === false && keptRow.reason,
    `OC4: info.worktrees keeps the removable/reason fields (${JSON.stringify(out.info.worktrees)})`);
  check(out.info.strays.some((p) => p === path.join(liveRepo, ".tasks", "001-stray")),
    `OC4: info.strays carries the stray paths (${JSON.stringify(out.info.strays)})`);
  check(out.info.hooks === "on" && out.info.hooks_registered === 4 && out.info.a_via === "current",
    `OC4: info carries the hooks state, the registered count and the resolution (${JSON.stringify({ h: out.info.hooks, r: out.info.hooks_registered, v: out.info.a_via })})`);
} catch (e) { fail_("OC4: " + spawnErr(e, "cli")); }

// OC5a: --clean removes the worktree, purges the gone repo rows, keeps history, records repos.write -1.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  const goneA = path.join(sc.base, "gone-a");
  const goneB = path.join(sc.base, "gone-b");
  seed(sc, { repos: [
    { key: "github.com/acme/gone-a", main_root: goneA },
    { key: "github.com/acme/gone-b", main_root: goneB },
    { key: "github.com/acme/live", main_root: liveRepo },
  ], archivedTaskOf: "github.com/acme/gone-a" });
  const r = runA(sc, ["doctor", "--clean", "--json"]);
  const out = JSON.parse(r.stdout);
  check(r.status === 0 && out.ok === true && (out.actions || []).length === 0,
    `OC5a: --clean clears the gone repos and the worktree, leaving no action rows (exit ${r.status}, ${JSON.stringify(out.actions)})`);
  check(out.clean && out.clean.removed.some((w) => w.path === removableDir) && !fs.existsSync(removableDir),
    `OC5a: the removable worktree is removed (${JSON.stringify(out.clean && out.clean.removed)})`);
  check(JSON.stringify(out.clean && out.clean.purged_repos) === JSON.stringify([
    { key: "github.com/acme/gone-a", main_root: goneA },
    { key: "github.com/acme/gone-b", main_root: goneB },
  ]), `OC5a: clean.purged_repos names both rows (${JSON.stringify(out.clean && out.clean.purged_repos)})`);
  check(JSON.stringify(readDb(sc, "SELECT key FROM repos ORDER BY key").map((x) => x.key)) === JSON.stringify(["github.com/acme/live"]),
    "OC5a: the repos rows are gone from the database");
  check(readDb(sc, "SELECT count(*) AS n FROM tasks")[0].n === 1,
    "OC5a: the archived task row of a purged repo stays");
  check(JSON.stringify(readDb(sc, "SELECT detail FROM events WHERE kind = 'repos.write' ORDER BY id DESC LIMIT 1")) === JSON.stringify([{ detail: '{"repos":-1}' }]),
    "OC5a: the purge appends a repos.write event counting -1");
  const after = runA(sc, ["doctor"]);
  check(after.status === 0 && after.stdout === "a doctor: ok\nstate: 1 tasks, 0 sessions, 1 worktrees kept, hooks on, snapshot 0h old\n",
    `OC5a: the doctor reads ok after --clean (${JSON.stringify(after.stdout)})`);
} catch (e) { fail_("OC5a: " + spawnErr(e, "cli")); }

// OC5b: the text mode prints one line per purge beside the worktree lines.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  const goneA = path.join(sc.base, "gone-a");
  seed(sc, { repos: [
    { key: "github.com/acme/gone-a", main_root: goneA },
    { key: "github.com/acme/live", main_root: liveRepo },
  ] });
  const r = runA(sc, ["doctor", "--clean"]);
  check(r.status === 0 && r.stderr.includes(`repo row purged: github.com/acme/gone-a (${goneA} was gone)\n`)
    && r.stderr.includes(`worktree removed: ${removableDir}\n`)
    && r.stdout.split("\n")[0] === "a doctor: ok",
    `OC5b: --clean prints the purge and removal lines on stderr, the verdict on stdout (exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 200))})`);
} catch (e) { fail_("OC5b: " + spawnErr(e, "cli")); }

// OC5c: --clean runs the repo's teardown before removing a worktree; the
// removed row carries the run, and a successful teardown is silent on stderr.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  seed(sc, { repos: [{ key: "github.com/acme/live", main_root: liveRepo }] });
  const liveKey = require(path.join(REPO, "scripts/lib/repo")).repoKey(liveRepo).key;
  const marker = path.join(sc.base, "oc5c-teardown.marker");
  const removableReal = fs.realpathSync(removableDir);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ repos: { [liveKey]: { teardown: `pwd > ${marker}` } } }));
  const r = runA(sc, ["doctor", "--clean", "--json"]);
  const out = JSON.parse(r.stdout);
  check(r.status === 0 && out.clean && out.clean.removed.some((w) => w.path === removableDir && w.teardown && w.teardown.exit_code === 0) && !fs.existsSync(removableDir),
    `OC5c: --clean runs the teardown and the removed row carries the run (exit ${r.status}, ${JSON.stringify(out.clean && out.clean.removed)})`);
  check(fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === removableReal,
    "OC5c: the teardown ran inside the removed worktree");
  check(r.stderr === "", `OC5c: a successful teardown keeps stderr clean (${JSON.stringify(r.stderr.slice(0, 200))})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
} catch (e) { fail_("OC5c: " + spawnErr(e, "cli")); }

// OC5d: a teardown that did not complete holds the worktree — the kept row
// carries the run and the reason, the directory survives, and the report
// stays honest: an action row with the --clean retry, exit 1.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  seed(sc, { repos: [{ key: "github.com/acme/live", main_root: liveRepo }] });
  const liveKey = require(path.join(REPO, "scripts/lib/repo")).repoKey(liveRepo).key;
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ repos: { [liveKey]: { teardown: "sleep 2" } } }));
  sc.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  const r = runA(sc, ["doctor", "--clean", "--json"]);
  const out = JSON.parse(r.stdout);
  check(r.status === 1 && out.clean && !out.clean.removed.some((w) => w.path === removableDir) && fs.existsSync(removableDir),
    `OC5d: --clean holds the worktree whose teardown did not complete (exit ${r.status}, ${JSON.stringify(out.clean && out.clean.removed)})`);
  check(out.clean && out.clean.kept.some((w) => w.path === removableDir && /did not complete/.test(w.reason || "") && w.teardown && w.teardown.exit_code === null),
    `OC5d: the kept row carries the held reason and the incomplete run (${JSON.stringify(out.clean && out.clean.kept)})`);
  check((out.actions || []).some((a) => a.kind === "worktree" && a.text === `worktree ${removableDir} (stale)`),
    `OC5d: the held worktree is an action row with the --clean retry (${JSON.stringify(out.actions)})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
} catch (e) { fail_("OC5d: " + spawnErr(e, "cli")); }

// OC5e: --clean writes the removal receipt — a worktree_removed event and a
// file in the repo's worktrees root (never inside the removed worktree, even
// for a harness worktree under the checkout) naming path, branch, repo, actor
// and reason, so a removal can be attributed from disk with no database.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  seed(sc, { repos: [{ key: "github.com/acme/live", main_root: liveRepo }] });
  const r = runA(sc, ["doctor", "--clean", "--json"]);
  const receipt = path.join(sc.home, ".agents", "worktrees", "live", ".removed", "removable.json");
  check(r.status === 0 && !fs.existsSync(removableDir) && fs.existsSync(receipt),
    `OC5e: the removal writes a receipt file in the repo's worktrees root (exit ${r.status}, ${receipt})`);
  const rc = JSON.parse(fs.readFileSync(receipt, "utf8"));
  check(rc.kind === "worktree_removed" && rc.path === removableDir && rc.branch === "harness-removable"
    && rc.repo === liveRepo && rc.actor === "unattributed" && rc.reason === "a doctor --clean"
    && Number.isFinite(Date.parse(rc.at)),
    `OC5e: the receipt names path, branch, repo, actor and reason (${JSON.stringify(rc)})`);
  const evts = readDb(sc, "SELECT * FROM events WHERE kind = 'worktree_removed'");
  const liveKey = require(path.join(REPO, "scripts/lib/repo")).repoKey(liveRepo).key;
  check(evts.length === 1 && evts[0].repo_key === liveKey && evts[0].session_id === null
    && JSON.parse(evts[0].detail).reason === "a doctor --clean" && JSON.parse(evts[0].detail).path === removableDir,
    `OC5e: the event row carries the same attribution (${JSON.stringify(evts)})`);
} catch (e) { fail_("OC5e: " + spawnErr(e, "cli")); }

// OC5f: --clean's kept lines of closed tasks' held worktrees carry the
// teardown bit — the resources release while the files stay; a failed run
// warns on the line, and every later clean retries it.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const liveKey = require(path.join(REPO, "scripts/lib/repo")).repoKey(liveRepo).key;
  const okMark = path.join(sc.base, "oc5f-ok.marker");
  const failMark = path.join(sc.base, "oc5f-fail.marker");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ repos: { [liveKey]: {
    teardown: `case $PWD in *kept-011*) pwd >> ${failMark}; exit 1;; esac; pwd > ${okMark}`,
  } } }));
  // two held worktrees of closed tasks: one whose teardown succeeds, one whose fails
  const keptDir = path.join(liveRepo, ".claude", "worktrees", "kept-010");
  const failDir = path.join(liveRepo, ".claude", "worktrees", "kept-011");
  fs.mkdirSync(path.dirname(keptDir), { recursive: true });
  for (const [dir, branch] of [[keptDir, "wt/010-kept"], [failDir, "wt/011-keptfail"]]) {
    execFileSync("git", ["-C", liveRepo, "branch", branch]);
    execFileSync("git", ["-C", liveRepo, "worktree", "add", dir, branch]);
    fs.writeFileSync(path.join(dir, "held.txt"), "held\n");
  }
  const seedCode = [];
  for (const [dirName, branch, dir] of [["010-kept", "wt/010-kept", keptDir], ["011-keptfail", "wt/011-keptfail", failDir]]) {
    seedCode.push(`db.createTaskRow(${JSON.stringify({
      repoKey: liveKey, dirName, taskDir: path.join(sc.tasks, liveKey, dirName), slug: dirName,
      number: 10, title: "Kept", tier: "standard", mode: "full", created: "2026-11-01",
      approvals: "none", land: "per_phase", worktreePath: null, branch, phases: [{ id: 1, name: "One" }],
    })});`);
    seedCode.push(`db.setTaskDisposition({ repoKey: ${JSON.stringify(liveKey)}, dirName: ${JSON.stringify(dirName)}, disposition: "archived" });`);
  }
  const seedRun = spawnSync(process.execPath, ["-e", [
    `const db = require(${JSON.stringify(path.join(REPO, "scripts/lib/db"))});`,
    `db.open({ create: true });`,
    `db.upsertRepo(${JSON.stringify(liveKey)}, { main_root: ${JSON.stringify(liveRepo)} });`,
    ...seedCode,
  ].join("\n")], { encoding: "utf8", env: sc.env, timeout: HANG_GUARD_MS });
  if (seedRun.status !== 0) throw new Error("OC5f seed failed: " + seedRun.stderr);

  const r = runA(sc, ["doctor", "--clean"]);
  check(r.stderr.includes(`worktree kept: ${keptDir} (uncommitted changes); teardown ran\n`),
    `OC5f: the kept line carries the ran bit (${JSON.stringify(r.stderr.split("\n").find((l) => l.includes("kept-010")))})`);
  check(r.stderr.includes(`worktree kept: ${failDir} (uncommitted changes); teardown failed (exit 1) — the next clean retries it\n`),
    `OC5f: the kept line carries the failed warn (${JSON.stringify(r.stderr.split("\n").find((l) => l.includes("kept-011")))})`);
  check(fs.existsSync(okMark) && fs.readFileSync(okMark, "utf8").trim() === fs.realpathSync(keptDir),
    "OC5f: the teardown ran inside the kept worktree");
  const j = runA(sc, ["doctor", "--clean", "--json"]);
  const out = JSON.parse(j.stdout);
  check(out.clean && out.clean.kept.some((w) => w.path === keptDir && w.teardown && w.teardown.exit_code === 0),
    `OC5f: the JSON kept row carries the run (${JSON.stringify(out.clean && out.clean.kept)})`);

  // the daily tick again: the exit-0 run never re-runs; the failed one is
  // retried by every visit (the --json clean above was one too)
  const r2 = runA(sc, ["doctor", "--clean"]);
  check(r2.stderr.includes(`worktree kept: ${keptDir} (uncommitted changes); teardown already ran\n`),
    `OC5f: the second clean says already ran (${JSON.stringify(r2.stderr.split("\n").find((l) => l.includes("kept-010")))})`);
  check(fs.readFileSync(okMark, "utf8").split("\n").filter(Boolean).length === 1,
    "OC5f: the exit-0 teardown never re-ran");
  check(fs.readFileSync(failMark, "utf8").split("\n").filter(Boolean).length === 3,
    "OC5f: every clean visit retried the failed teardown");
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
} catch (e) { fail_("OC5f: " + spawnErr(e, "cli")); }

// OC6: a removable worktree is one action row with the --clean remedy, excluded
// from the kept count; with only a staying worktree, the doctor reads ok.
try {
  const sc = scenario();
  const liveRepo = makeRepo(path.join(sc.base, "live"));
  const { removableDir } = plantWorktrees(liveRepo);
  seed(sc, { repos: [{ key: "github.com/acme/live", main_root: liveRepo }] });
  const r = runA(sc, ["doctor"]);
  const lines = r.stdout.split("\n").filter(Boolean);
  check(r.status === 1 && lines.length === 3
    && lines[0] === "a doctor: 1 item need action"
    && lines[1] === `action: worktree ${removableDir} (stale) — a doctor --clean`
    && lines[2] === "state: 0 tasks, 0 sessions, 1 worktrees kept, hooks on, snapshot 0h old",
    `OC6: a removable worktree is one action row with the --clean remedy, excluded from the kept count (exit ${r.status}, ${JSON.stringify(lines)})`);
  check(r.stderr === "", `OC6: the action row prints on stdout only (${JSON.stringify(r.stderr.slice(0, 200))})`);
  const j = runA(sc, ["doctor", "--json"]);
  const out = JSON.parse(j.stdout);
  check(j.status === 1 && JSON.stringify(out.actions) === JSON.stringify([
    { kind: "worktree", text: `worktree ${removableDir} (stale)`, remedy: "a doctor --clean" },
  ]), `OC6: --json serves the row as {kind, text, remedy} and nothing else (${JSON.stringify(out.actions)})`);
  const quiet = scenario();
  const quietRepo = makeRepo(path.join(quiet.base, "live"));
  plantWorktrees(quietRepo, { removable: false });
  seed(quiet, { repos: [{ key: "github.com/acme/live", main_root: quietRepo }] });
  const q = runA(quiet, ["doctor"]);
  check(q.status === 0 && q.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 1 worktrees kept, hooks on, snapshot 0h old\n",
    `OC6: with nothing removable the doctor reads ok and the staying worktree counts as kept (exit ${q.status}, ${JSON.stringify(q.stdout)})`);
} catch (e) { fail_("OC6: " + spawnErr(e, "cli")); }

// ---------------------------------------------------------------------------
// The drift mechanism
// ---------------------------------------------------------------------------

/** The config shape whose install-generated bytes differ from defaults stock: a
 *  per-agent model string, an extra tool grant and a dropped MCP hint agent. */
function testConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "defaults/config.json"), "utf8"));
  return {
    ...cfg,
    agents: { ...(cfg.agents || {}), builder: { cc: "test-model-x" } },
    agentTools: { cc: { ...(cfg.agentTools.cc || {}), builder: [...((cfg.agentTools.cc || {}).builder || []), "mcp__test__probe"] } },
    mcpServers: { ...cfg.mcpServers, graphify: { ...cfg.mcpServers.graphify, agents: cfg.mcpServers.graphify.agents.filter((a) => a !== "courier") } },
  };
}

// DR1: an install generated from the local config prints ok — the standing-false-row class is dead.
try {
  const sc = scenario({ config: testConfig() });
  fs.cpSync(path.join(generateWith(path.join(sc.home, ".agents", "config.json")), "claude", "agents"),
    path.join(sc.home, ".claude", "agents"), { recursive: true });
  const installed = fs.readFileSync(path.join(sc.home, ".claude", "agents", "builder.md"), "utf8");
  const stock = fs.readFileSync(path.join(DEFAULTS_GEN, "claude", "agents", "builder.md"), "utf8");
  check(installed !== stock, "DR1 setup: the config changes builder.md (the fixture is not defaults stock)");
  const r = runA(sc, ["doctor"]);
  check(r.status === 0 && r.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old\n",
    `DR1: a config-driven install matches the config-derived expectation — no drift rows (exit ${r.status}, ${JSON.stringify(r.stdout)})`);
} catch (e) { fail_("DR1: " + spawnErr(e, "cli")); }

// DR2: a one-byte hand-edit of an installed file is one differs row with the config-named remedy.
try {
  const sc = scenario({ config: testConfig() });
  fs.cpSync(path.join(generateWith(path.join(sc.home, ".agents", "config.json")), "claude", "agents"),
    path.join(sc.home, ".claude", "agents"), { recursive: true });
  const edited = path.join(sc.home, ".claude", "agents", "builder.md");
  fs.writeFileSync(edited, fs.readFileSync(edited, "utf8") + "x");
  const r = runA(sc, ["doctor"]);
  const rows = r.stdout.split("\n").filter((l) => l.startsWith("action: agent file"));
  check(r.status === 1 && rows.length === 1
    && rows[0] === "action: agent file builder.md: differs from the config-derived expected — ./install.sh; hand-tuning belongs in ~/.agents/config.json",
    `DR2: a hand-edited installed file is one differs row with the config remedy (exit ${r.status}, ${JSON.stringify(rows)})`);
} catch (e) { fail_("DR2: " + spawnErr(e, "cli")); }

// DR3: a missing installed agent file is one missing row (the stale-install class).
try {
  const sc = scenario({ config: testConfig() });
  fs.cpSync(path.join(generateWith(path.join(sc.home, ".agents", "config.json")), "claude", "agents"),
    path.join(sc.home, ".claude", "agents"), { recursive: true });
  fs.rmSync(path.join(sc.home, ".claude", "agents", "explorer.md"));
  const r = runA(sc, ["doctor"]);
  const rows = r.stdout.split("\n").filter((l) => l.startsWith("action: agent file"));
  check(r.status === 1 && rows.length === 1
    && rows[0] === "action: agent file explorer.md: missing in the agents directory — ./install.sh; hand-tuning belongs in ~/.agents/config.json",
    `DR3: a missing installed file is one missing row (exit ${r.status}, ${JSON.stringify(rows)})`);
} catch (e) { fail_("DR3: " + spawnErr(e, "cli")); }

// DR4: an unparseable local config is one cannot-derive row, never a pile, never a crash.
try {
  const sc = scenario();
  fs.mkdirSync(path.join(sc.home, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(sc.home, ".agents", "config.json"), "{ not json\n");
  const r = runA(sc, ["doctor"]);
  const rows = r.stdout.split("\n").filter((l) => l.startsWith("action:"));
  check(r.status === 1 && rows.length === 1
    && rows[0].startsWith("action: cannot derive the expected agents: ")
    && rows[0].endsWith(" — fix ~/.agents/config.json or run ./install.sh"),
    `DR4: a broken config is one cannot-derive action row with the remedy (exit ${r.status}, ${JSON.stringify(rows)})`);
} catch (e) { fail_("DR4: " + spawnErr(e, "cli")); }

// DR5: an engine copy without templates/agents (a snapshot predating the change) skips the leg.
try {
  const sc = scenario();
  const mini = path.join(TMP, "old-snapshot");
  for (const tree of ["scripts", "hooks", "generated/claude/agents", "templates/agents/memory"]) {
    fs.cpSync(path.join(REPO, tree), path.join(mini, tree), { recursive: true });
  }
  const miniA = path.join(mini, "scripts", "bin", "a");
  const jr = runA(sc, ["doctor", "--json"], miniA);
  const out = JSON.parse(jr.stdout);
  check(jr.status === 0 && out.ok === true && (out.actions || []).length === 0,
    `DR5: the drift leg skips with no action row (exit ${jr.status}, ${JSON.stringify(out.actions)})`);
  const vr = runA(sc, ["doctor", "--verbose"], miniA);
  check(vr.status === 0 && vr.stderr.includes("agent drift skipped: "),
    `DR5: --verbose notes the skip (${JSON.stringify(vr.stderr.split("\n").find((l) => l.includes("agent drift skipped")))})`);
} catch (e) { fail_("DR5: " + spawnErr(e, "cli")); }

// ---------------------------------------------------------------------------
// The away watcher's heartbeat row
// ---------------------------------------------------------------------------

/** A coordinator home in a scenario's database: one registration row bound to `taskDir`. */
function seedCoordinatorHome(sc, taskDir) {
  fs.mkdirSync(taskDir, { recursive: true });
  const code = [
    `const db = require(${JSON.stringify(path.join(REPO, "scripts/lib/db"))});`,
    `const session = require(${JSON.stringify(path.join(REPO, "scripts/lib/session"))});`,
    `db.open({ create: true });`,
    `session.register({ origin: "cli", initiator: "user", agent: "coordinator",`,
    `  session_id: "cccc0001-0000-4000-8000-000000000001", terminal_id: "dw", cwd: "/tmp",`,
    `  task_dir: ${JSON.stringify(taskDir)}, repo_key: "github.com/acme/live",`,
    `  session_dir: ${JSON.stringify(path.join(sc.base, "sessions", "dw"))} });`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: sc.env, timeout: HANG_GUARD_MS });
  if (r.status !== 0) throw new Error("coordinator seed failed: " + r.stderr);
}

/** The watcher's installed-plist marker under a scenario home. */
function plantWatcherPlist(sc) {
  const dir = path.join(sc.home, "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "com.mcouthon.agents.watcher.plist"), "<plist/>\n");
}

// DW1: a stale beat under an installed plist is one action row with the install remedy.
try {
  const sc = scenario();
  const home = path.join(sc.tasks, "github.com/acme/live", "001-home");
  seedCoordinatorHome(sc, home);
  plantWatcherPlist(sc);
  fs.writeFileSync(path.join(home, "watcher.json"), JSON.stringify({
    heartbeat: new Date(Date.now() - 30 * 60000).toISOString(), ticks: 5,
  }) + "\n");
  const r = runA(sc, ["doctor"]);
  check(r.status === 1
    && r.stdout.split("\n").includes("action: the away watcher's last beat was 30m ago (001-home) — ./install.sh"),
    `DW1: a stale heartbeat under the installed plist is one action row (exit ${r.status}, ${JSON.stringify(r.stdout.split("\n").filter((l) => l.startsWith("action:")))})`);
} catch (e) { fail_("DW1: " + spawnErr(e, "cli")); }

// DW2: no installed plist — no row (a not-installed optional component never flags).
try {
  const sc = scenario();
  const home = path.join(sc.tasks, "github.com/acme/live", "001-home");
  seedCoordinatorHome(sc, home);
  fs.writeFileSync(path.join(home, "watcher.json"), JSON.stringify({
    heartbeat: new Date(Date.now() - 30 * 60000).toISOString(), ticks: 5,
  }) + "\n");
  const r = runA(sc, ["doctor"]);
  check(!r.stdout.includes("watcher_heartbeat") && !r.stdout.includes("away watcher"),
    `DW2: with no plist installed the heartbeat never flags (${JSON.stringify(r.stdout.split("\n").filter((l) => l.includes("watcher")))})`);
} catch (e) { fail_("DW2: " + spawnErr(e, "cli")); }

// DW3: a fresh beat — no row (the doctor reports only actionable state: a
// healthy beat is present, not stale, and never a signal).
try {
  const sc = scenario();
  const home = path.join(sc.tasks, "github.com/acme/live", "001-home");
  seedCoordinatorHome(sc, home);
  plantWatcherPlist(sc);
  fs.writeFileSync(path.join(home, "watcher.json"), JSON.stringify({
    heartbeat: new Date().toISOString(), ticks: 5,
  }) + "\n");
  const r = runA(sc, ["doctor"]);
  check(!r.stdout.includes("away watcher"),
    `DW3: a fresh heartbeat under the installed plist flags nothing (${JSON.stringify(r.stdout.split("\n").filter((l) => l.includes("watcher")))})`);
} catch (e) { fail_("DW3: " + spawnErr(e, "cli")); }

// ---------------------------------------------------------------------------
// The month's spend against the configured cap
// ---------------------------------------------------------------------------

/** The month key of a moment, UTC ("YYYY-MM"). */
const monthKeyOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const utcMonthStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

// The DS fixtures' spend config: a synthetic model at invented rates (a few
// thousand tokens price to cents), a small cap.
const DS_SPEND = {
  cap_usd: 10, warn_pct: 80,
  prices_per_mtok: { "model-a": { input: 1, cache_read: 0.1, cache_write_5m: 1.5, cache_write_1h: 2, output: 5 } },
};

/** A planted spend ledger beside a scenario's database (the DW planted-file idiom). */
function plantSpendLedger(sc, month, fileModels) {
  const files = {};
  let i = 0;
  for (const models of fileModels) {
    files[`fixture-${++i}.jsonl`] = { mtimeMs: 1, size: 1, skipped: 0, models };
  }
  fs.writeFileSync(path.join(sc.tasks, "spend-ledger.json"), JSON.stringify({
    month,
    refreshedAt: new Date(Date.now() - 5 * 60000).toISOString(),
    files,
  }) + "\n");
}

const modelTokens = (n) => ({ in: n, cr: 0, c5: 0, c1: 0, out: 0 });

// DSa: the clause — a cap and a planted ledger price to the state line's
// spend clause with the exact numbers; --json serves info.spend; --verbose
// prints the fact once, never in both streams.
try {
  const sc = scenario();
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    plantSpendLedger(sc, monthKeyOf(Date.now()), [{"model-a": modelTokens(500000)}]); // $0.50 of $10, 5%
    const r = runA(sc, ["doctor"]);
    check(r.status === 0 && r.stdout === "a doctor: ok\n"
      + "state: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old"
      + ", spend $0.50 of $10 this month (5%)\n",
      `DSa: the state line ends with the spend clause with the exact numbers (exit ${r.status}, ${JSON.stringify(r.stdout)})`);
    const j = JSON.parse(runA(sc, ["doctor", "--json"]).stdout);
    check(j.info.spend && j.info.spend.month === monthKeyOf(Date.now()) && j.info.spend.usd === 0.5
      && j.info.spend.cap === 10 && j.info.spend.pct === 5 && j.info.spend.coming === false
      && JSON.stringify(j.info.spend.unpricedModels) === JSON.stringify([]),
      `DSa: --json serves info.spend with the month's fact (${JSON.stringify(j.info.spend)})`);
    const v = runA(sc, ["doctor", "--verbose"]);
    const spendLine = v.stderr.split("\n").find((l) => l.startsWith("Month spend: "));
    check(v.status === 0 && Boolean(spendLine)
      && spendLine.startsWith("Month spend: $0.50 of $10 (5%)")
      && spendLine.includes("ledger refreshed 5m ago")
      && !v.stdout.split("\n").includes(spendLine),
      `DSa: --verbose prints the spend fact once, never in both streams (${JSON.stringify(spendLine)})`);
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSa: " + spawnErr(e, "cli")); }

// DSb: the warn row — the planted ledger over the threshold: exactly one
// action row carrying the trip estimate and the config-key remedy.
try {
  const sc = scenario();
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    plantSpendLedger(sc, monthKeyOf(Date.now()), [{"model-a": modelTokens(9000000)}]); // $9 of $10, 90%
    const r = runA(sc, ["doctor"]);
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("action:"));
    check(r.status === 1 && rows.length === 1
      && /^action: monthly spend \$9 of \$10 \(90%\) — (the cap trips in ~\d+d at this pace|past the warn threshold) — curb the spend or raise spend\.cap_usd in ~\/\.agents\/config\.json$/.test(rows[0]),
      `DSb: over the threshold the spend warn is exactly one action row with the trip estimate and the config-key remedy (exit ${r.status}, ${JSON.stringify(rows)})`);
    const f = JSON.parse(runA(sc, ["doctor", "--json"]).stdout).info.spend;
    check(f && f.coming === true && f.because === "pct" && f.usd === 9,
      `DSb: the fact reads coming by the pct threshold (${JSON.stringify(f && [f.coming, f.because, f.usd])})`);
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSb: " + spawnErr(e, "cli")); }

// DSc: the pace warn — a spend under the pct threshold whose rate trips
// before month end. The fixture is date-derived (the real month clock): a
// $7-of-$10 month trips while 3 ≤ elapsed ≤ 70% of the month; earlier the
// day guard holds it, later the runway outlasts the month — each run date
// asserts the honest outcome for that date.
try {
  const sc = scenario();
  const monthStart = utcMonthStart(Date.now());
  const d = new Date(monthStart);
  const monthLen = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - monthStart) / 86400000;
  const elapsed = (Date.now() - monthStart) / 86400000;
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    plantSpendLedger(sc, monthKeyOf(Date.now()), [{"model-a": modelTokens(7000000)}]); // $7 of $10, 70%
    const r = runA(sc, ["doctor"]);
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("action: monthly spend"));
    if (elapsed >= 3 && elapsed <= 0.7 * monthLen) {
      const f = JSON.parse(runA(sc, ["doctor", "--json"]).stdout).info.spend;
      check(r.status === 1 && rows.length === 1
        && /^action: monthly spend \$7 of \$10 \(70%\) — the cap trips in ~\d+d at this pace — curb the spend or raise spend\.cap_usd in ~\/\.agents\/config\.json$/.test(rows[0])
        && f && f.coming === true && f.because === "pace" && f.pct === 70,
        `DSc: under the pct threshold but tripping before month end, the row fires with the pace wording (E=${elapsed.toFixed(1)}d of L=${monthLen}d, ${JSON.stringify(rows)})`);
    } else {
      check(r.status === 0 && rows.length === 0,
        `DSc: outside the pace window (E=${elapsed.toFixed(1)}d of L=${monthLen}d) an under-threshold month stays silent — no pace row`);
    }
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSc: " + spawnErr(e, "cli")); }

// DSd: the silent shapes — no spend block (even with a planted ledger), a cap
// with no ledger, a ledger keyed to the prior month: no clause, no row, no
// info.spend — and a fresh install's output stays byte-identical (OC1's pin).
try {
  const sc = scenario();
  plantSpendLedger(sc, monthKeyOf(Date.now()), [{"model-a": modelTokens(9000000)}]);
  const r = runA(sc, ["doctor"]);
  check(r.status === 0 && r.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old\n"
    && !JSON.parse(runA(sc, ["doctor", "--json"]).stdout).info.spend,
    `DSd: no spend block in the config → silence even with a planted ledger (exit ${r.status}, ${JSON.stringify(r.stdout)})`);
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    const sc2 = scenario();
    const r2 = runA(sc2, ["doctor"]);
    check(r2.status === 0 && r2.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old\n"
      && !JSON.parse(runA(sc2, ["doctor", "--json"]).stdout).info.spend,
      `DSd: a cap but no ledger file → silence (the doctor never scans transcripts) (exit ${r2.status}, ${JSON.stringify(r2.stdout)})`);
    const sc3 = scenario();
    plantSpendLedger(sc3, monthKeyOf(utcMonthStart(Date.now()) - 1), [{"model-a": modelTokens(9000000)}]);
    const r3 = runA(sc3, ["doctor"]);
    check(r3.status === 0 && r3.stdout === "a doctor: ok\nstate: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old\n"
      && !JSON.parse(runA(sc3, ["doctor", "--json"]).stdout).info.spend,
      `DSd: a ledger keyed to the prior month is silent for the current one (exit ${r3.status})`);
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSd: " + spawnErr(e, "cli")); }

// DSe: over the cap — the row words it as over, not tripping.
try {
  const sc = scenario();
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    plantSpendLedger(sc, monthKeyOf(Date.now()), [{"model-a": modelTokens(11000000)}]); // $11 of $10, 110%
    const r = runA(sc, ["doctor"]);
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("action:"));
    check(r.status === 1 && rows.length === 1
      && rows[0] === "action: monthly spend $11 of $10 (110%) — over the cap — curb the spend or raise spend.cap_usd in ~/.agents/config.json",
      `DSe: usd over the cap words the row as over, not tripping (exit ${r.status}, ${JSON.stringify(rows)})`);
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSe: " + spawnErr(e, "cli")); }

// DSf: unpriced models — the ledger holds tokens for a model the prices table
// does not name: info.spend names it, the usd counts only the priced.
try {
  const sc = scenario();
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ spend: DS_SPEND }));
  try {
    plantSpendLedger(sc, monthKeyOf(Date.now()), [
      { "model-a": modelTokens(1000000), "model-x": modelTokens(5000000) },
    ]);
    const r = runA(sc, ["doctor"]);
    check(r.status === 0
      && r.stdout === "a doctor: ok\n"
      + "state: 0 tasks, 0 sessions, 0 worktrees kept, hooks on, snapshot 0h old"
      + ", spend $1 of $10 this month (10%)\n",
      `DSf: the clause prices only the priced model (exit ${r.status}, ${JSON.stringify(r.stdout)})`);
    const f = JSON.parse(runA(sc, ["doctor", "--json"]).stdout).info.spend;
    check(f && f.usd === 1 && JSON.stringify(f.unpricedModels) === JSON.stringify(["model-x"]),
      `DSf: info.spend names the unpriced model (${JSON.stringify(f && [f.usd, f.unpricedModels])})`);
  } finally {
    fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, "{}");
  }
} catch (e) { fail_("DSf: " + spawnErr(e, "cli")); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
