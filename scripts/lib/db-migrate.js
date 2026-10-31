"use strict";

/**
 * The v1 → v2 migration, run on the first allowed open of a schema-1 file:
 * the intent tables (checkmarks, notes, pending_folds) filled from each row's
 * doc, phases and decisions rebuilt, tasks altered in place, runs/reports/
 * checkpoints dropped. Who may migrate: any engine for a database that is not
 * the home default; for ~/.agents/agents.db only the installed engine — a
 * checkout's `a` refuses, naming ./install.sh, leaving the file untouched.
 *
 * Order: the migrate lock (never a throwing wait), a checked backup linked
 * without overwrite, the git pre-pass (every git call, outside the write
 * transaction), then BEGIN IMMEDIATE with foreign_keys off, the conversion,
 * foreign_key_check and the decisions count before COMMIT.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { withNamedLock, isPidAlive } = require("./lock");

/** The statuses v1 stored that count as checked for the landing rules' scope. */
const LANDING_CHECKED = new Set(["committed", "landed", "done", "skipped", "descoped"]);
/** The statuses that become a migration-written skip decision. */
const SKIP_STATUSES = new Set(["skipped", "descoped"]);
/** The statuses that become a migration-written approve decision. */
const APPROVE_STATUSES = new Set(["approved", "in_progress", "implemented"]);
/** The statuses that become a checkmark. */
const CHECK_STATUSES = new Set(["committed", "landed", "done"]);
/** The labelled form a task's own file names a landing commit in (the word, any case, immediately followed by `:`). */
const RECORDED_RE = /\b[Cc][Oo][Mm][Mm][Ii][Tt](?:[Tt][Ee][Dd]|[Ss])?:[ \t`*]*((?:[0-9a-f]{7,40}\b[`*]?(?:[ \t]*(?:,|and)[ \t]*`?)?)+)/;

function engineRoot() {
  return path.resolve(__dirname, "..", "..");
}

/** An absolute path resolved by its parent's realpath, so a missing file never throws; null when the parent is missing. */
function parentResolved(p) {
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return null;
  }
}

/** True when the database this process would open is the home default, ~/.agents/agents.db. */
function isHomeDefault(dbFile) {
  const a = parentResolved(dbFile);
  const b = parentResolved(path.join(os.homedir(), ".agents", "agents.db"));
  if (a === null || b === null) return false;
  return a === b;
}

/** True when this engine is the installed one (~/.agents/bin/current resolves here; missing or dangling counts as not installed). */
function isInstalledEngine() {
  let current;
  let engine;
  try { current = fs.realpathSync(path.join(os.homedir(), ".agents", "bin", "current")); } catch { return false; }
  try { engine = fs.realpathSync(engineRoot()); } catch { return false; }
  return engine === current;
}

/** Who may migrate this file: any engine for a non-home database, the installed one for the home default. */
function mayMigrate(dbFile) {
  if (!isHomeDefault(dbFile)) return { ok: true };
  if (isInstalledEngine()) return { ok: true };
  return { ok: false, engineRoot: engineRoot() };
}

function refusalError(dbFile, root) {
  const err = new Error(
    `agents.db is schema 1 and this engine (${root}) is not the installed one; ` +
    "run ./install.sh to install it, and the first a call migrates"
  );
  err.code = "not_installed_engine";
  err.exitCode = 2;
  return err;
}

/** Refusal with the remedy in the message, built the one way so none ships without one. */
function refusal(code, message, remedy) {
  if (!remedy) throw new Error(`refusal ${code} has no remedy`);
  const err = new Error(`${message}\nRemedy: ${remedy}`);
  err.code = code;
  err.exitCode = 2;
  err.detail = { remedy };
  return err;
}

// ---------------------------------------------------------------------------
// Version reads (read-only, before any pragma or DDL)
// ---------------------------------------------------------------------------

/** `schema_version` through a read-only connection: null when the file or table is missing, the number otherwise. */
function readVersion(p) {
  const { DatabaseSync } = require("node:sqlite");
  let raw;
  try {
    raw = new DatabaseSync(p, { readOnly: true });
  } catch {
    return null;
  }
  try {
    raw.exec("PRAGMA busy_timeout=5000");
    const row = raw.prepare("SELECT version FROM schema_version").get();
    return row ? Number(row.version) : null;
  } catch (err) {
    if (/no such table/i.test(err.message)) return null;
    throw err;
  } finally {
    try { raw.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

function migrate(conn) {
  const lockPath = conn.file + ".migrate";
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  const isDone = () => readVersion(conn.file) === SCHEMA_2;
  const out = withNamedLock(lockPath, holder, () => runMigration(conn), {
    wait: "until-free",
    isDone,
    waitLabel: "v1 → v2 migration",
  });
  return out || {};
}

const SCHEMA_2 = 2;

function barrierDir() {
  return process.env.AGENTS_TEST_SKIP_IDENTITY === "1" ? (process.env.AGENTS_TEST_MIGRATE_BARRIER || null) : null;
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}

function waitFile(p, capMs = 10000) {
  const end = Date.now() + capMs;
  while (!fs.existsSync(p)) {
    if (Date.now() >= end) return false;
    sleepMs(20);
  }
  return true;
}

function removeStaleTempBackups(dbFile) {
  const dir = path.dirname(dbFile);
  const base = path.basename(dbFile);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = name.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.v1\\.bak\\.tmp\\.(\\d+)$`));
    if (!m) continue;
    if (!isPidAlive(Number(m[1]))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another attempt removed it */ }
    }
  }
}

/**
 * Back up the v1 file atomically: VACUUM INTO a temp file, check it is a v1
 * database that passes quick_check, then link it (never over an existing name)
 * as `<db>.v1.bak`, or under a stamped name when one is already there.
 */
function takeBackup(conn, dbFile) {
  const tmp = `${dbFile}.v1.bak.tmp.${process.pid}`;
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    conn.run("VACUUM INTO ?", tmp);
    const { DatabaseSync } = require("node:sqlite");
    let check = null;
    try {
      check = new DatabaseSync(tmp, { readOnly: true });
      const v = check.prepare("SELECT version FROM schema_version").get();
      const q = check.prepare("PRAGMA quick_check").get();
      if (!v || Number(v.version) !== 1 || !q || String(q.quick_check) !== "ok") {
        throw refusal("bad_v1_backup_copy", `the copy at ${tmp} is not a healthy schema-1 database`,
          `remove ${tmp} by hand if it remains; the database is unchanged`);
      }
    } finally {
      try { if (check) check.close(); } catch { /* already closed */ }
    }
    let dest = `${dbFile}.v1.bak`;
    if (fs.existsSync(dest)) {
      dest = `${dbFile}.v1.bak.${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    }
    fs.linkSync(tmp, dest);
    fs.unlinkSync(tmp);
    process.stderr.write(`v1 backup: ${dest}\n`);
    return dest;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    // an inner refusal (the copy's health check) keeps its own code, message and remedy
    const inner = err && err.detail && typeof err.detail.remedy === "string"
      ? { code: err.code, message: err.message.split("\nRemedy: ")[0], remedy: err.detail.remedy }
      : { code: "v1_backup_failed", message: `the v1 backup for ${dbFile} could not be taken: ${err.message}`,
          remedy: "the database is unchanged (still schema 1); free disk space and try the command again" };
    throw refusal(inner.code, inner.message, inner.remedy);
  }
}

function runMigration(conn) {
  const dbFile = conn.file;
  if (readVersion(dbFile) === SCHEMA_2) return { already: true };
  removeStaleTempBackups(dbFile);
  const backup = takeBackup(conn, dbFile);
  if (process.env.AGENTS_TEST_SKIP_IDENTITY === "1" && process.env.AGENTS_TEST_MIGRATE_EXIT_AFTER === "backup") {
    process.exit(9);
  }

  const pre = gitPrePass(conn);

  const bar = barrierDir();
  if (bar && fs.existsSync(path.join(bar, "stop-pre-tx"))) {
    fs.writeFileSync(path.join(bar, "pre-tx"), "");
    waitFile(path.join(bar, "release-pre-tx"));
  }

  conn.raw.exec("PRAGMA foreign_keys=OFF");
  try {
    return conn.tx(() => {
      const v = conn.get("SELECT version FROM schema_version");
      if (v && Number(v.version) === SCHEMA_2) return { already: true };
      const result = convertAll(conn, pre, backup);
      if (bar) {
        fs.writeFileSync(path.join(bar, "in-tx"), "");
        waitFile(path.join(bar, "release"));
      }
      checkBeforeCommit(conn, pre, result);
      return result;
    });
  } finally {
    conn.raw.exec("PRAGMA foreign_keys=ON");
  }
}

/** `PRAGMA foreign_key_check` is empty and the decisions count is the v1 count plus what the migration wrote. */
function checkBeforeCommit(conn, pre, result) {
  const fk = conn.all("PRAGMA foreign_key_check");
  if (fk.length > 0) {
    throw refusal("foreign_key_check_failed",
      `the migration rolled back: foreign_key_check failed on ${fk[0].table} row ${fk[0].rowid}; ` +
      `the v1 backup is at ${result.backup}`,
      "the database still holds schema 1; report the failure with the backup path");
  }
  const n = conn.get("SELECT count(*) AS n FROM decisions").n;
  if (n !== pre.v1DecisionCount + result.decisionsWritten) {
    throw refusal("decision_count_wrong",
      `the migration rolled back: ${n} decisions where ${pre.v1DecisionCount} + ${result.decisionsWritten} were expected; ` +
      `the v1 backup is at ${result.backup}`,
      "the database still holds schema 1; report the failure with the backup path");
  }
}

// ---------------------------------------------------------------------------
// The git pre-pass: every git call happens here, before BEGIN
// ---------------------------------------------------------------------------

function git(cwd, args, timeout = 5000) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (((r.stderr || "") + (r.error ? " " + r.error.message : "")).trim()) };
}

/** {gitDir, commonDir} of a checkout: `.git` a directory, or a `gitdir:` file whose commondir names the common one. */
function gitDirs(tree) {
  const dot = path.join(tree, ".git");
  let st;
  try { st = fs.lstatSync(dot); } catch { return null; }
  if (st.isDirectory()) return { gitDir: dot, commonDir: dot };
  if (st.isFile()) {
    let m;
    try { m = fs.readFileSync(dot, "utf8").trim().match(/^gitdir: (.+)$/); } catch { return null; }
    if (!m) return null;
    const gitDir = path.resolve(tree, m[1]);
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch { /* the main checkout's .git is its own common dir */ }
    return { gitDir, commonDir };
  }
  return null;
}

/** A ref read from loose files then packed-refs; a symbolic ref is followed; null when it cannot be read that way. */
function readRef(dirs, ref, depth = 0) {
  if (depth > 5 || !dirs) return null;
  const loose = path.join(dirs.commonDir, ...ref.split("/"));
  let text;
  try { text = fs.readFileSync(loose, "utf8").trim(); } catch {
    try {
      const packed = fs.readFileSync(path.join(dirs.commonDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
      text = line ? line.slice(0, line.length - ref.length - 1).trim() : null;
    } catch { text = null; }
    if (text === null) return null;
  }
  const sym = text.match(/^ref: (.+)$/);
  if (sym) return readRef(dirs, sym[1], depth + 1);
  return { sha: text };
}

/** The raw text of a loose ref file, or null (packed refs cannot be symbolic). */
function looseRefText(dirs, ref) {
  try { return fs.readFileSync(path.join(dirs.commonDir, ...ref.split("/")), "utf8").trim(); } catch { return null; }
}

/** The base branch from files: the policy's, else origin/HEAD's target, else main, else master, else main. */
function baseFor(mainRoot, repoKey) {
  const pol = require("./policy").lookupEntry(mainRoot, repoKey);
  if (pol && pol.base) return pol.base;
  const dirs = gitDirs(mainRoot);
  if (!dirs) return null;
  const headText = looseRefText(dirs, "refs/remotes/origin/HEAD");
  const target = headText && headText.match(/^ref: refs\/remotes\/origin\/(.+)$/);
  if (target) return target[1];
  if (readRef(dirs, "refs/heads/main") !== null) return "main";
  if (readRef(dirs, "refs/heads/master") !== null) return "master";
  return "main";
}

/** The git context a landing rule needs: a checkout that is a git repository, and the base branch. */
function gitContext(mainRoot, repoKey) {
  if (!mainRoot || !fs.existsSync(mainRoot)) return { ok: false, reason: "no checkout" };
  const base = baseFor(mainRoot, repoKey);
  if (base === null) return { ok: false, reason: "git failed" };
  const probe = git(mainRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!probe.ok) return { ok: false, reason: "git failed" };
  return { ok: true, base };
}

/** The task's own record, in the labelled form only, from the first of its files that names a commit. */
function scanRecordedFiles(entry) {
  const candidates = [];
  const fold = entry.filesDir && entry.filesDir !== entry.taskDir ? entry.filesDir : null;
  candidates.push({ file: "task.md", path: path.join(entry.taskDir, "task.md") });
  if (fold) candidates.push({ file: "task.md", path: path.join(fold, "task.md") });
  candidates.push({ file: "state.md", path: path.join(entry.taskDir, "state.md") });
  if (fold) candidates.push({ file: "state.md", path: path.join(fold, "state.md") });
  for (const c of candidates) {
    let text;
    try { text = fs.readFileSync(c.path, "utf8"); } catch { continue; }
    const lines = [];
    text.split("\n").forEach((line, i) => {
      const m = line.match(RECORDED_RE);
      if (!m) return;
      const tokens = (m[1].match(/[0-9a-f]{7,40}/g) || []);
      if (tokens.length > 0) lines.push({ line: i + 1, text: line, tokens: tokens.map((token) => ({ token })) });
    });
    if (lines.length > 0) return { file: c.file, lines };
  }
  return null;
}

/** The landing rules' scope: active, all checked, on a direct repo (the pure policy-file lookup, no git). */
function inScope(entry) {
  if (entry.disposition !== "active" || !entry.doc || !Array.isArray(entry.doc.phases) || entry.doc.phases.length === 0) return false;
  if (!entry.doc.phases.every((p) => p && typeof p === "object" && LANDING_CHECKED.has(p.status))) return false;
  return require("./policy").kindFromFile(entry.mainRoot, entry.repoKey) === "direct";
}

/** The newest stored landing commit of a doc: that of the phase with the latest completed, else the highest ord. */
function newestStoredLanding(doc) {
  let best = null;
  (doc.phases || []).forEach((p, ord) => {
    if (!p || typeof p.landed_sha !== "string" || !p.landed_sha) return;
    if (!best || String(p.completed || "") > String(best.completed || "") || (String(p.completed || "") === String(best.completed || "") && ord > best.ord)) {
      best = { sha: p.landed_sha, completed: p.completed || null, ord };
    }
  });
  return best;
}

/**
 * The landing facts of one in-scope entry, git only: a stored landing commit on
 * base (a land event), else a recorded-commit candidate, else a reason. Null
 * when the entry is out of scope.
 */
function landingFacts(entry) {
  if (!inScope(entry)) return null;
  const stored = newestStoredLanding(entry.doc);
  if (stored) {
    const ctx = gitContext(entry.mainRoot, entry.repoKey);
    if (!ctx.ok) return { reason: ctx.reason };
    const anc = git(entry.mainRoot, ["merge-base", "--is-ancestor", stored.sha, `origin/${ctx.base}`]);
    if (anc.ok) return { head: stored.sha, at: stored.completed || entry.doc.updated || null };
    return { reason: "not on base" };
  }
  const scan = scanRecordedFiles(entry);
  if (scan === null) return null;
  const ctx = gitContext(entry.mainRoot, entry.repoKey);
  if (!ctx.ok) return { reason: ctx.reason };
  const resolved = [];
  for (const line of scan.lines) {
    for (const t of line.tokens) {
      const r = git(entry.mainRoot, ["rev-parse", "--verify", "--quiet", `${t.token}^{commit}`]);
      t.sha = r.ok ? r.out : null;
      if (t.sha === null) continue;
      const on = git(entry.mainRoot, ["merge-base", "--is-ancestor", t.sha, `origin/${ctx.base}`]);
      t.on_base = on.ok;
      resolved.push(t);
    }
  }
  if (resolved.length === 0) return { noCandidate: true };
  if (resolved.some((t) => !t.on_base)) return { reason: "recorded commit not on base" };
  const log = git(entry.mainRoot, ["log", "--no-walk", "--format=%H %ct", ...resolved.map((t) => t.sha)]);
  let head = null;
  let headTime = -1;
  for (const line of (log.ok ? log.out : "").split("\n")) {
    const m = line.match(/^([0-9a-f]+) (\d+)$/);
    if (m && Number(m[2]) > headTime) { headTime = Number(m[2]); head = m[1]; }
  }
  if (head === null) return { noCandidate: true };
  return { recorded: { file: scan.file, lines: scan.lines, head }, at: entry.doc.updated || null };
}

function mainRootsOf(conn) {
  const out = {};
  for (const r of conn.all("SELECT key, main_root, doc FROM repos")) {
    let main = r.main_root || null;
    if (!main) {
      try { main = (JSON.parse(r.doc) || {}).main_root || null; } catch { main = null; }
    }
    out[r.key] = main;
  }
  return out;
}

/** Central task.json files with no row, adopted through the same conversion. */
function findOrphans(conn, rows) {
  const known = new Set(rows.map((r) => `${r.repo_key}|${r.dir_name}`));
  const { tasksRootBase } = require("./tasks-root");
  const out = [];
  const walk = (dir, relParts, disposition) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      if (relParts.length === 0 && disposition === "active" && (name === "archive" || name === "trash")) continue;
      const full = path.join(dir, name);
      let isDir = false;
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
      if (relParts.length > 0 && fs.existsSync(path.join(full, "task.json"))) {
        const repoKey = relParts.join("/");
        if (known.has(`${repoKey}|${name}`)) continue;
        let doc = null;
        const docText = fs.readFileSync(path.join(full, "task.json"), "utf8");
        try {
          const parsed = JSON.parse(docText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
        } catch { doc = null; }
        out.push({ kind: "orphan", repoKey, dirName: name, disposition, taskDir: full, doc, docText, filesDir: null });
      } else if (isDir) {
        walk(full, [...relParts, name], disposition);
      }
    }
  };
  if (fs.existsSync(path.join(tasksRootBase(), "archive"))) {
    walk(path.join(tasksRootBase(), "archive"), [], "archived");
  }
  walk(tasksRootBase(), [], "active");
  return out;
}

function gitPrePass(conn) {
  const rows = conn.all("SELECT * FROM tasks ORDER BY id");
  const orphans = findOrphans(conn, rows);
  const mainRoots = mainRootsOf(conn);
  const pre = {
    tasks: {},
    orphans: [],
    v1DecisionCount: conn.get("SELECT count(*) AS n FROM decisions").n,
  };
  for (const row of rows) {
    let doc = null;
    try {
      const parsed = JSON.parse(row.doc);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
    } catch { doc = null; }
    const entry = {
      kind: "row", id: row.id, repoKey: row.repo_key, dirName: row.dir_name, disposition: row.disposition,
      taskDir: row.task_dir, filesDir: row.files_dir, doc, docText: row.doc,
      mainRoot: mainRoots[row.repo_key] || null,
    };
    pre.tasks[row.id] = { docText: row.doc, landing: landingFacts(entry) };
  }
  for (const o of orphans) {
    o.mainRoot = mainRoots[o.repoKey] || null;
    o.landing = landingFacts(o);
    pre.orphans.push(o);
  }
  return pre;
}

// ---------------------------------------------------------------------------
// The conversion (inside the transaction)
// ---------------------------------------------------------------------------

function parseDoc(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { doc: parsed, bad: null };
    return { doc: null, bad: "doc is not a JSON object" };
  } catch (err) {
    return { doc: null, bad: `doc does not parse (${err.message})` };
  }
}

const insertEventOn = (conn, { at, kind, repoKey, taskId, sessionId, detail }) => conn.run(
  "INSERT INTO events (at, kind, repo_key, task_id, session_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
  at || new Date().toISOString(), kind, repoKey || null, taskId === undefined ? null : taskId,
  sessionId || null, detail === undefined ? null : JSON.stringify(detail)
);

/**
 * Convert one entry's doc into v2 rows: phases (first id wins), checkmarks,
 * migration-written skips and approves with their plan hashes, notes. Returns
 * the converted pieces; never throws on a bad part.
 */
function convertDoc(entry, ctx) {
  const { conn, now, today } = ctx;
  const out = { phases: [], checkmarks: [], decisions: [], notes: [], skipped: [], planHashes: [] };
  out.at = entry.rowUpdated || now;
  const { doc, bad } = parseDoc(entry.docText);
  if (bad) {
    out.skipped.push(bad);
    return out;
  }
  const derive = require("./derive");
  const planDirs = [...new Set([entry.taskDir, entry.filesDir].filter(Boolean).map((d) => path.join(d, "plan")))];
  const planOf = (phaseId) => derive.planFileFor(planDirs, phaseId);
  const at = doc.updated || out.at;
  out.at = at;
  const v1Decisions = ctx.decisionsByTask.get(entry.id || 0) || [];

  const seen = new Set();
  for (const p of Array.isArray(doc.phases) ? doc.phases : []) {
    if (!p || typeof p !== "object" || !Number.isInteger(p.id)) {
      out.skipped.push("a phase without an integer id");
      continue;
    }
    if (seen.has(p.id)) {
      out.skipped.push(`duplicate phase id ${p.id}: ${p.name || "(unnamed)"} dropped`);
      continue;
    }
    seen.add(p.id);
    const after = Array.isArray(p.after) ? p.after : Array.isArray(p.blocked_by) ? p.blocked_by : [];
    out.phases.push({
      task_id: entry.id, phase_id: p.id, ord: out.phases.length, name: p.name || null,
      after: JSON.stringify(after.filter((n) => Number.isInteger(n))),
    });
    if (CHECK_STATUSES.has(p.status)) {
      out.checkmarks.push({
        task_id: entry.id, phase_id: p.id, session_id: "migration",
        checked_at: p.checked_at || p.completed || at,
      });
    }
    if (SKIP_STATUSES.has(p.status) && !v1Decisions.some((d) => d.phase_id === p.id && d.choice === "skip")) {
      out.decisions.push({
        task_id: entry.id, phase_id: p.id, choice: "skip", quote: `stored status ${p.status}, migrated ${today}`,
        recorded_by: "migration", decided_at: at, plan_hash: null,
      });
    }
    if (APPROVE_STATUSES.has(p.status) && !v1Decisions.some((d) => d.phase_id === p.id && d.choice === "approve")) {
      out.decisions.push({
        task_id: entry.id, phase_id: p.id, choice: "approve", quote: `stored status ${p.status}, migrated ${today}`,
        recorded_by: "migration", decided_at: at, plan_hash: null, // filled from the plan file below
      });
    }
    if (typeof p.note === "string" && p.note !== "") {
      out.notes.push({ task_id: entry.id, phase_id: p.id, text: p.note, session_id: "migration", at });
    }
  }

  // plan hashes: every approve and reject row binds to the plan body when the v1 rule held
  const hashOf = new Map();
  for (const p of Array.isArray(doc.phases) ? doc.phases : []) {
    if (!p || !Number.isInteger(p.id)) continue;
    const found = planOf(p.id);
    if (!found.file) continue;
    try { hashOf.set(p.id, { hash: derive.planHash(fs.readFileSync(found.file, "utf8")), mtimeMs: fs.statSync(found.file).mtimeMs }); } catch { /* unreadable plan: no hash */ }
  }
  for (const d of out.decisions) {
    if (d.choice !== "approve") continue;
    const plan = hashOf.get(d.phase_id);
    if (plan) d.plan_hash = plan.hash;
  }
  out.planHashes = [];
  for (const d of v1Decisions) {
    if (d.choice !== "approve" && d.choice !== "reject") continue;
    const plan = hashOf.get(d.phase_id);
    let hash = null;
    if (plan && d.decided_at && new Date(d.decided_at).getTime() > plan.mtimeMs) hash = plan.hash;
    out.planHashes.push({ decision_id: d.decision_id, plan_hash: hash });
  }

  out.knobs = {
    approvals: doc.knobs && (doc.knobs.approvals === "ask" || doc.knobs.approvals === "none") ? doc.knobs.approvals : null,
    land: doc.knobs && (doc.knobs.land === "per_phase" || doc.knobs.land === "at_end") ? doc.knobs.land : null,
  };
  out.worktreePath = doc.worktree_path && typeof doc.worktree_path === "string" ? doc.worktree_path : null;
  out.branch = null;
  for (const p of Array.isArray(doc.phases) ? doc.phases : []) {
    if (p && typeof p.branch === "string" && p.branch) { out.branch = p.branch; break; }
  }
  out.at = at;
  out.oldStatuses = {};
  for (const p of Array.isArray(doc.phases) ? doc.phases : []) {
    if (p && Number.isInteger(p.id)) out.oldStatuses[p.id] = p.status || null;
  }
  return out;
}

/** The events one converted entry writes: its migrate event, and a land event for a stored landing on base. */
function eventsFor(entry, converted, landing, changed) {
  const detail = {};
  if (converted.oldStatuses) detail.phases = converted.oldStatuses;
  let land = null;
  if (landing && !changed) {
    if (landing.recorded) detail.recorded = landing.recorded;
    else if (landing.head) land = { kind: "land", at: landing.at, head: landing.head };
    else if (landing.reason) detail.landing = landing.reason;
  } else if (landing && changed) {
    detail.landing = "changed during migration";
  }
  if (converted.skipped.length > 0) detail.skipped = converted.skipped;
  const migrate = { kind: "migrate", at: converted.at || null, detail };
  return { migrate, land };
}

function convertAll(conn, pre, backup) {
  const db = require("./db");
  const sandbox = require("./sandbox");
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let decisionsWritten = 0;

  for (const col of ["approvals TEXT", "land TEXT", "worktree_path TEXT", "branch TEXT"]) {
    conn.raw.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
  }

  const rows = conn.all("SELECT * FROM tasks ORDER BY id");
  const v1Decisions = conn.all("SELECT * FROM decisions ORDER BY decision_id");
  const decisionsByTask = new Map();
  for (const d of v1Decisions) {
    if (!decisionsByTask.has(d.task_id)) decisionsByTask.set(d.task_id, []);
    decisionsByTask.get(d.task_id).push(d);
  }
  const ctx = { conn, now, today, decisionsByTask };

  const phasesV2 = [];
  const checkmarks = [];
  const decisionsNew = [];
  const notesRows = [];
  const folds = [];
  const events = [];
  const planHashes = [];

  const convertRow = (entry) => {
    const converted = convertDoc(entry, ctx);
    phasesV2.push(...converted.phases);
    checkmarks.push(...converted.checkmarks);
    decisionsNew.push(...converted.decisions);
    decisionsWritten += converted.decisions.length;
    notesRows.push(...converted.notes);
    planHashes.push(...converted.planHashes);
    conn.run("UPDATE tasks SET approvals = ?, land = ?, worktree_path = ?, branch = ? WHERE id = ?",
      converted.knobs ? converted.knobs.approvals : null, converted.knobs ? converted.knobs.land : null,
      converted.worktreePath || null, converted.branch || null, entry.id);
    if (entry.filesDir && entry.filesDir !== entry.taskDir) {
      folds.push({ task_id: entry.id, path: entry.filesDir });
    }
    const preFacts = pre.tasks[entry.id] || {};
    const changed = preFacts.docText !== undefined && preFacts.docText !== entry.docText;
    const { migrate, land } = eventsFor(entry, converted, preFacts.landing, changed);
    if (land) events.push({ at: land.at, kind: "land", repoKey: entry.repoKey, taskId: entry.id, detail: { head: land.head, migrated: true } });
    events.push({ at: migrate.at || now, kind: "migrate", repoKey: entry.repoKey, taskId: entry.id, detail: migrate.detail });
    return converted;
  };

  for (const row of rows) {
    convertRow({
      kind: "row", id: row.id, repoKey: row.repo_key, dirName: row.dir_name, disposition: row.disposition,
      taskDir: row.task_dir, filesDir: row.files_dir, docText: row.doc, rowUpdated: row.updated, mainRoot: null,
    });
  }

  for (const o of pre.orphans) {
    // adopt: the row, its paths through the sandbox guard
    const doc = o.doc;
    let worktreePath = doc && doc.worktree_path && typeof doc.worktree_path === "string" ? doc.worktree_path : null;
    let filesDir = doc && typeof doc.files_dir === "string" && doc.files_dir && doc.files_dir !== o.taskDir ? doc.files_dir : null;
    const skipped = [];
    if (sandbox.isSandbox()) {
      if (worktreePath !== null && !sandbox.contains(worktreePath)) { skipped.push(`outside sandbox: ${worktreePath}`); worktreePath = null; }
      if (filesDir !== null && !sandbox.contains(filesDir)) { skipped.push(`outside sandbox: ${filesDir}`); filesDir = null; }
    }
    const info = conn.run(
      `INSERT INTO tasks (repo_key, dir_name, disposition, task_dir, files_dir, slug, number, title, status, tier, mode,
         created, updated, doc, approvals, land, worktree_path, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.repoKey, o.dirName, o.disposition === "archived" ? "archived" : "active", o.taskDir, o.taskDir,
      (doc && (doc.slug || o.dirName)) || o.dirName,
      doc && Number.isInteger(doc.number) ? doc.number : null,
      (doc && doc.title) || o.dirName, null, (doc && doc.tier) || null, (doc && doc.mode) || null,
      (doc && doc.created) || null, null, o.docText, null, null, worktreePath, null
    );
    const id = Number(info.lastInsertRowid);
    const converted = convertDoc({ ...o, id, filesDir, docText: o.docText, rowUpdated: null }, ctx);
    phasesV2.push(...converted.phases);
    checkmarks.push(...converted.checkmarks);
    decisionsNew.push(...converted.decisions);
    decisionsWritten += converted.decisions.length;
    notesRows.push(...converted.notes);
    planHashes.push(...converted.planHashes);
    if (filesDir) folds.push({ task_id: id, path: filesDir });
    if (converted.knobs) {
      conn.run("UPDATE tasks SET approvals = ?, land = ?, branch = ? WHERE id = ?",
        converted.knobs.approvals, converted.knobs.land, converted.branch || null, id);
    }
    const { migrate, land } = eventsFor(o, { ...converted, skipped: [...converted.skipped, ...skipped] }, o.landing, false);
    if (land) events.push({ at: land.at, kind: "land", repoKey: o.repoKey, taskId: id, detail: { head: land.head, migrated: true } });
    events.push({ at: migrate.at || now, kind: "migrate", repoKey: o.repoKey, taskId: id, detail: migrate.detail });
  }

  // rebuild phases and decisions by SQLite's documented procedure
  const v2 = (table, name) => db.CREATE_TABLES[table]
    .replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ")
    .replace(` ${table} (`, ` ${name} (`);
  conn.raw.exec(v2("phases", "phases_v2"));
  conn.raw.exec(v2("decisions", "decisions_v2"));
  for (const p of phasesV2) {
    conn.run("INSERT INTO phases_v2 (task_id, phase_id, ord, name, after) VALUES (?, ?, ?, ?, ?)",
      p.task_id, p.phase_id, p.ord, p.name, p.after);
  }
  for (const d of v1Decisions) {
    const hash = (planHashes.find((h) => h.decision_id === d.decision_id) || {}).plan_hash || null;
    conn.run(
      "INSERT INTO decisions_v2 (decision_id, task_id, phase_id, choice, gate, plan_hash, quote, recorded_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.decision_id, d.task_id, d.phase_id, d.choice, d.gate || null, hash, d.quote, d.recorded_by, d.decided_at
    );
  }
  for (const d of decisionsNew) {
    conn.run(
      "INSERT INTO decisions_v2 (task_id, phase_id, choice, gate, plan_hash, quote, recorded_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      d.task_id, d.phase_id, d.choice, d.gate || null, d.plan_hash || null, d.quote, d.recorded_by, d.decided_at
    );
  }
  conn.raw.exec("DROP TABLE phases");
  conn.raw.exec("ALTER TABLE phases_v2 RENAME TO phases");
  conn.raw.exec("DROP TABLE decisions");
  conn.raw.exec("ALTER TABLE decisions_v2 RENAME TO decisions");

  // the new tables
  conn.raw.exec(db.CREATE_TABLES.checkmarks);
  conn.raw.exec(db.CREATE_TABLES.notes);
  conn.raw.exec(db.CREATE_TABLES.pending_folds);
  conn.raw.exec(db.CREATE_INDEXES.join("\n"));
  for (const c of checkmarks) {
    conn.run("INSERT INTO checkmarks (task_id, phase_id, session_id, checked_at) VALUES (?, ?, ?, ?)",
      c.task_id, c.phase_id, c.session_id, c.checked_at);
  }
  for (const n of notesRows) {
    conn.run("INSERT INTO notes (task_id, phase_id, text, session_id, at) VALUES (?, ?, ?, ?, ?)",
      n.task_id, n.phase_id, n.text, n.session_id, n.at);
  }
  for (const f of folds) {
    conn.run("INSERT INTO pending_folds (task_id, path) VALUES (?, ?)", f.task_id, f.path);
  }
  for (const e of events) insertEventOn(conn, e);

  // the v1-only tables and columns go
  conn.raw.exec("DROP TABLE IF EXISTS runs");
  conn.raw.exec("DROP TABLE IF EXISTS reports");
  conn.raw.exec("DROP TABLE IF EXISTS checkpoints");
  for (const col of ["status", "updated", "doc", "next_json", "awaiting", "files_dir"]) {
    conn.raw.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  }

  conn.run("UPDATE schema_version SET version = 2");
  insertEventOn(conn, { kind: "migrate", detail: { backup } });
  return { backup, tasks: rows.length, orphans: pre.orphans.length, decisionsWritten };
}

module.exports = {
  RECORDED_RE, LANDING_CHECKED,
  engineRoot, isHomeDefault, isInstalledEngine, mayMigrate, refusalError, readVersion,
  migrate, takeBackup, gitDirs, readRef, baseFor, landingFacts, inScope, scanRecordedFiles,
};
