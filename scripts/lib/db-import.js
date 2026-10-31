"use strict";

/**
 * `a task import` — the one-shot file step of the v2 install, run with the
 * owner on install day. Without `--apply` a dry run that writes nothing: the
 * fold of the repo-local leftovers, the loose entries and the worktree links,
 * the task.json and index.json moves, the bad rows, the stored landings, the
 * recorded-commit candidates, the planned-without-plan phases, the sessions and
 * the unresolved list, each group with its count. With `--apply`: the fold, the
 * moves into one trash bundle (manifest.json and undo.sh), the sessions index,
 * the guarded fetch, the optional `--confirm-recorded` (the owner's words as a
 * `finalize` answer on each confirmed task, then its land event), the derive
 * and the unresolved list written to the bundle's unresolved.json.
 *
 * Every path the fold, the moves and the fetch follow obeys the sandbox guard;
 * `--apply` refuses mixed roots before it touches anything.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const GIT_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30000;

function refusal(code, message) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = 2;
  return err;
}

// ---------------------------------------------------------------------------
// Sessions (registration.json under the sessions root)
// ---------------------------------------------------------------------------

function listDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

/** Every `<id>/registration.json` under the sessions root, as text and parsed. */
function scanSessions(root) {
  const entries = [];
  if (fs.existsSync(root)) {
    for (const name of listDirs(root)) {
      const file = path.join(root, name, "registration.json");
      const raw = readIfExists(file);
      if (raw === null) continue;
      const entry = { entryId: name, dir: path.join(root, name), raw, reg: null, error: null };
      try {
        entry.reg = JSON.parse(raw);
        if (entry.reg === null || typeof entry.reg !== "object" || Array.isArray(entry.reg)) {
          throw new Error("not a JSON object");
        }
      } catch (err) {
        entry.error = `${file}: ${err.message}`;
      }
      entries.push(entry);
    }
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// The trash bundle
// ---------------------------------------------------------------------------

function newBundle() {
  const { trashRoot } = require("./trash");
  const now = new Date().toISOString();
  const base = `v2-import-${now.slice(11, 19).replace(/:/g, "")}Z`;
  let dir = path.join(trashRoot(), now.slice(0, 10), base);
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(trashRoot(), now.slice(0, 10), `${base}-${n++}`);
  return { dir, ops: [], created: false };
}

function ensureBundleDir(b) {
  if (!b.created) {
    const { contains } = require("./sandbox");
    if (!contains(b.dir)) {
      throw refusal("mixed_roots", `--apply refuses to write the trash bundle at ${b.dir}: it sits outside the sandbox`);
    }
    fs.mkdirSync(path.join(b.dir, "files"), { recursive: true });
    b.created = true;
  }
}

/** A moved item's place in the bundle: its absolute source path below files/. */
function bundlePathFor(b, from) {
  return path.join(b.dir, "files", ...String(from).split(path.sep).filter((s) => s !== ""));
}

function sha256Of(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch { return null; }
}

/** Move a file, folder or link; a cross-device move copies then removes the source. */
function movePath(from, to) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true });
  require("./trash").removeTree(from);
}

function recordMove(b, from, to, sha) {
  b.ops.push({ op: "move", from, to, sha256: sha === undefined ? null : sha });
  writeBundle(b);
}

/**
 * Move one file, folder or link into the bundle at its absolute source path.
 * Null when the sandbox guard does not contain the source: nothing moves and
 * the caller lists it `outside sandbox`.
 */
function moveToBundle(b, from) {
  const { contains } = require("./sandbox");
  if (!contains(from)) return null;
  const to = bundlePathFor(b, from);
  ensureBundleDir(b);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const sha = sha256Of(from);
  movePath(from, to);
  recordMove(b, from, to, sha);
  return to;
}

function recordFold(b, taskId, folder) {
  b.ops.push({ op: "fold", task_id: taskId, path: folder });
  writeBundle(b);
}

/** undo.sh, from the manifest in reverse: every move back, one block per move. */
function undoScript(ops) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const moves = ops.filter((o) => o.op === "move");
  const lines = [
    "#!/bin/sh",
    "# Generated by `a task import --apply`: every recorded move back, newest first.",
    "# Row changes are not undone here; the database rollback restores them.",
    "restored=0; skipped=0",
  ];
  for (const m of moves.slice().reverse()) {
    lines.push(`if [ -e ${q(m.from)} ] || [ -L ${q(m.from)} ]; then`);
    lines.push(`  echo "skipped, exists: ${m.from}"; skipped=$((skipped+1))`);
    lines.push("else");
    lines.push(`  mkdir -p ${q(path.dirname(m.from))} && mv ${q(m.to)} ${q(m.from)}; restored=$((restored+1))`);
    lines.push("fi");
  }
  lines.push('echo "restored $restored, skipped $skipped"');
  lines.push('[ "$skipped" -eq 0 ]');
  return lines.join("\n") + "\n";
}

function writeBundle(b) {
  if (!b.created) return;
  fs.writeFileSync(path.join(b.dir, "manifest.json"), JSON.stringify({ ops: b.ops }, null, 2) + "\n");
  fs.writeFileSync(path.join(b.dir, "undo.sh"), undoScript(b.ops), { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// The fold: repo-local leftovers into the central folder
// ---------------------------------------------------------------------------

/** Every file and link under `folder` with its relative path; a top-level `.lock` (a stale withLock dir) is not content. */
function walkFiles(folder) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (rel === "" && e.name === ".lock" && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push({ rel: r, abs: path.join(dir, e.name) });
    }
  };
  walk(folder, "");
  return out;
}

function sameEntry(a, b) {
  try {
    const sa = fs.lstatSync(a);
    const sb = fs.lstatSync(b);
    if (sa.isSymbolicLink() && sb.isSymbolicLink()) return fs.readlinkSync(a) === fs.readlinkSync(b);
    if (!sa.isFile() || !sb.isFile()) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

/** `<stem>.repo-local<ext>`, then `.repo-local-2`, …: the first free name. */
function suffixed(to) {
  const dir = path.dirname(to);
  const ext = path.extname(to);
  const stem = path.basename(to, ext);
  let candidate = path.join(dir, `${stem}.repo-local${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}.repo-local-${n++}${ext}`);
  return candidate;
}

/** What happens to each file of a leftover folder (pure). */
function planRow(task, folder) {
  const files = [];
  for (const f of walkFiles(folder)) {
    const central = path.join(task.task_dir, f.rel);
    if (!fs.existsSync(central)) files.push({ rel: f.rel, from: f.abs, action: "move", to: central });
    else if (sameEntry(f.abs, central)) files.push({ rel: f.rel, from: f.abs, action: "same", to: null });
    else files.push({ rel: f.rel, from: f.abs, action: "suffix", to: suffixed(central) });
  }
  return files;
}

/** True when a live session is bound to the task, or the folder's lock holder is alive. */
function folderInUse(task, folder) {
  const session = require("./session");
  try {
    const here = path.resolve(task.task_dir);
    if (session.list().some((r) => !r.ended_at && r.task_dir && path.resolve(r.task_dir) === here && session.isLive(r))) return true;
  } catch { /* no registry */ }
  const lockDir = path.join(folder, ".lock");
  if (fs.existsSync(path.join(lockDir, "holder"))) return !require("./lock").canReclaim(lockDir);
  return false;
}

/** Fold one pending row (apply moves, dry lists). The row keeps while in use or outside. */
function foldRow(b, pending, task, apply) {
  const db = require("./db");
  const { contains } = require("./sandbox");
  const folder = pending.path;
  if (!contains(folder) || !contains(task.task_dir)) return { dir: task.dir_name, folder, state: "outside sandbox" };
  if (folderInUse(task, folder)) return { dir: task.dir_name, folder, state: "in use" };
  if (!fs.existsSync(folder)) {
    if (apply) { db.open({ create: true }).run("DELETE FROM pending_folds WHERE task_id = ?", task.id); recordFold(b, task.id, folder); }
    return { dir: task.dir_name, folder, state: "missing" };
  }
  if (task.disposition === "deleted") {
    if (apply) { moveToBundle(b, folder); db.open({ create: true }).run("DELETE FROM pending_folds WHERE task_id = ?", task.id); recordFold(b, task.id, folder); }
    return { dir: task.dir_name, folder, state: "deleted → trash" };
  }
  const centralMissing = !fs.existsSync(task.task_dir);
  const files = planRow(task, folder);
  if (apply) {
    if (centralMissing) fs.mkdirSync(task.task_dir, { recursive: true });
    for (const f of files) {
      if (f.action === "same") continue;
      fs.mkdirSync(path.dirname(f.to), { recursive: true });
      const sha = sha256Of(f.from);
      movePath(f.from, f.to);
      recordMove(b, f.from, f.to, sha);
    }
    moveToBundle(b, folder);
    db.open({ create: true }).run("DELETE FROM pending_folds WHERE task_id = ?", task.id);
    recordFold(b, task.id, folder);
  }
  return { dir: task.dir_name, folder, state: centralMissing ? "create central" : "fold", files };
}

/** Every remaining entry of a checkout's .tasks moves into the bundle; the emptied .tasks goes. */
function looseScan(b, tasksDir, { apply }) {
  const entries = [];
  let names;
  try { names = fs.readdirSync(tasksDir, { withFileTypes: true }); } catch { return { entries, removed: false }; }
  for (const e of names.sort((a, c) => (a.name < c.name ? -1 : 1))) {
    const p = path.join(tasksDir, e.name);
    if (apply) moveToBundle(b, p);
    entries.push({ path: p, kind: e.isDirectory() ? "folder" : "file" });
  }
  let removed = false;
  if (apply) {
    try { fs.rmdirSync(tasksDir); removed = true; } catch { /* something remains inside */ }
  }
  return { entries, removed: apply ? removed : true };
}

/** The worktree .tasks links to a moved checkout folder (a real .tasks in a worktree is not touched). */
function worktreeLinks(b, mainRoot, tasksDir, { apply }) {
  const { contains } = require("./sandbox");
  if (!contains(mainRoot)) return [];
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: mainRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return [];
  const links = [];
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const w = line.slice("worktree ".length);
    if (path.resolve(w) === path.resolve(mainRoot)) continue;
    const link = path.join(w, ".tasks");
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) continue;
      if (path.resolve(w, fs.readlinkSync(link)) !== path.resolve(tasksDir)) continue;
    } catch { continue; }
    if (apply) moveToBundle(b, link);
    links.push({ path: link, target: tasksDir });
  }
  return links;
}

/**
 * The fold over every pending_folds row, then the loose entries and the
 * worktree links of each checkout no row is left for.
 */
function runFold(b, { apply }) {
  const db = require("./db");
  const pendings = db.listPendingFolds();
  const rows = [];
  const keepsByTasksDir = new Map();
  for (const p of pendings) {
    const task = db.getTask(p.task_id);
    if (!task) continue;
    const r = foldRow(b, p, task, apply);
    rows.push(r);
    const tasksDir = path.dirname(p.path);
    if (r.state === "in use" || r.state === "outside sandbox") {
      keepsByTasksDir.set(tasksDir, (keepsByTasksDir.get(tasksDir) || 0) + 1);
    } else if (!keepsByTasksDir.has(tasksDir)) {
      keepsByTasksDir.set(tasksDir, 0);
    }
  }
  rows.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const loose = [];
  const links = [];
  for (const [tasksDir, keeps] of [...keepsByTasksDir].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (keeps > 0) continue; // a checkout with an in-use or outside row keeps its .tasks
    // the real path before the .tasks goes, so a link through an alias still matches
    let tasksReal = path.resolve(tasksDir);
    try { tasksReal = fs.realpathSync(tasksDir); } catch { /* already gone: the resolved name stands */ }
    const scan = looseScan(b, tasksDir, { apply });
    loose.push(...scan.entries);
    if (scan.removed) links.push(...worktreeLinks(b, path.dirname(tasksDir), tasksReal, { apply }));
  }
  return { rows, loose, links };
}

// ---------------------------------------------------------------------------
// task.json, state.json-only dirs and index.json under the tasks root
// ---------------------------------------------------------------------------

function scanTasksRoot() {
  const root = require("./tasks-root").tasksRootBase();
  const taskJson = [];
  const stateOnly = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let hasTaskJson = false;
    let hasStateJson = false;
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "task.json") { hasTaskJson = true; taskJson.push(p); }
      else if (e.name === "state.json") hasStateJson = true;
    }
    if (hasStateJson && !hasTaskJson) stateOnly.push(dir);
  };
  walk(root);
  taskJson.sort();
  stateOnly.sort();
  return { taskJson, stateOnly };
}

function readIndexJson() {
  const file = path.join(require("./tasks-root").tasksRootBase(), "index.json");
  if (!fs.existsSync(file)) return null;
  let keys = [];
  try { keys = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(); } catch { /* unreadable: no keys */ }
  return { file, keys };
}

function indexJsonMissingKeys(index) {
  if (!index) return [];
  const db = require("./db");
  return index.keys.filter((k) => !db.repoOf(db.storedKey(k)));
}

// ---------------------------------------------------------------------------
// The recorded-commit candidates
// ---------------------------------------------------------------------------

/** Every migrate event that holds a recorded-commit candidate, with its task row. */
function candidateRows() {
  const db = require("./db");
  const out = [];
  for (const row of db.open({ create: true }).all("SELECT * FROM events WHERE kind = 'migrate' ORDER BY id")) {
    let detail = {};
    try { detail = JSON.parse(row.detail || "{}"); } catch { /* no candidate */ }
    if (!detail || !detail.recorded || !detail.recorded.head) continue;
    const task = db.getTask(row.task_id);
    if (!task) continue;
    out.push({ event: row, task, recorded: detail.recorded, at: row.at });
  }
  return out;
}

function landEventWithSource(taskId) {
  const db = require("./db");
  return db.open({ create: true }).get(
    "SELECT id FROM events WHERE task_id = ? AND kind = 'land' AND detail LIKE '%\"source\"%' LIMIT 1", taskId
  ) || null;
}

function newestIntentId(taskId) {
  const db = require("./db");
  const kinds = db.INTENT_KINDS.map(() => "?").join(", ");
  const row = db.open({ create: true }).get(`SELECT max(id) AS n FROM events WHERE task_id = ? AND kind IN (${kinds})`, taskId, ...db.INTENT_KINDS);
  return row && row.n ? Number(row.n) : null;
}

/** The base branch from the policy file and the checkout's ref files; null with no checkout. */
function baseForRepo(task) {
  const db = require("./db");
  const repo = db.repoOf(task.repo_key);
  const mainRoot = repo && repo.main_root;
  if (!mainRoot || !fs.existsSync(mainRoot)) return null;
  const base = require("./db-migrate").baseFor(mainRoot, task.repo_key);
  return { mainRoot, base };
}

/** True when the head is an ancestor of the local origin/<base>. */
function headOnBase(task, head) {
  const ctx = baseForRepo(task);
  if (!ctx || !ctx.base) return false;
  const r = spawnSync("git", ["merge-base", "--is-ancestor", head, `origin/${ctx.base}`], {
    cwd: ctx.mainRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0;
}

const candidateKey = (c) => `${c.task.repo_key}/${c.task.dir_name}`;
const byKey = (a, b) => {
  const ka = candidateKey(a);
  const kb = candidateKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** The candidates with their current standing (already recorded, changed, on base). */
function candidateEntries() {
  return candidateRows().sort(byKey).map((c) => {
    const onBase = headOnBase(c.task, c.recorded.head);
    const status = landEventWithSource(c.task.id) ? "already recorded"
      : newestIntentId(c.task.id) !== Number(c.event.id) ? "changed since the migration"
      : onBase ? "candidate" : "no longer on base";
    return {
      key: candidateKey(c), task_id: c.task.id, repo_key: c.task.repo_key, dir: c.task.dir_name,
      file: c.recorded.file, lines: c.recorded.lines, head: c.recorded.head, at: c.at,
      on_base: onBase, status,
    };
  });
}

/** One `git fetch origin <base>` per candidate repo the sandbox guard contains. */
function fetchCandidateRepos(candidates) {
  const db = require("./db");
  const { contains } = require("./sandbox");
  const byRoot = new Map();
  for (const c of candidates) {
    const repoKey = c.task ? c.task.repo_key : c.repo_key;
    const repo = db.repoOf(repoKey);
    if (repo && repo.main_root) byRoot.set(repo.main_root, repoKey);
  }
  const out = [];
  for (const [mainRoot, repo] of byRoot) {
    if (!contains(mainRoot)) { out.push({ repo, main_root: mainRoot, ok: false, reason: "outside sandbox" }); continue; }
    const base = require("./db-migrate").baseFor(mainRoot, repo);
    if (!base) { out.push({ repo, main_root: mainRoot, ok: false, reason: "no base branch" }); continue; }
    const r = spawnSync("git", ["fetch", "origin", base], {
      cwd: mainRoot, encoding: "utf8", timeout: FETCH_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
    });
    out.push(r.status === 0
      ? { repo, main_root: mainRoot, ok: true }
      : { repo, main_root: mainRoot, ok: false, reason: `git fetch origin ${base} failed` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The confirmation: the owner's words on each confirmed task, then the land event
// ---------------------------------------------------------------------------

function recordConfirmation(c, words) {
  const db = require("./db");
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
  const now = new Date().toISOString();
  const source = `${c.recorded.file}:${c.recorded.lines.map((l) => l.line).join(",")}`;
  const conn = db.open({ create: true });
  const decisionId = conn.tx(() => {
    const info = conn.run(
      "INSERT INTO decisions (task_id, phase_id, choice, gate, plan_hash, quote, recorded_by, decided_at) VALUES (?, NULL, 'answer', 'finalize', NULL, ?, ?, ?)",
      c.task.id, words, sessionId, now
    );
    const id = Number(info.lastInsertRowid);
    conn.run("INSERT INTO events (at, kind, repo_key, task_id, session_id, detail) VALUES (?, 'decide', ?, ?, ?, ?)",
      now, c.task.repo_key, c.task.id, sessionId,
      JSON.stringify({ decision_id: id, phase_id: null, choice: "answer", gate: "finalize" }));
    conn.run("INSERT INTO events (at, kind, repo_key, task_id, session_id, detail) VALUES (?, 'land', ?, ?, ?, ?)",
      c.at || now, c.task.repo_key, c.task.id, sessionId,
      JSON.stringify({ head: c.recorded.head, migrated: true, source, decision_id: id }));
    return id;
  });
  require("./db-export").exportTask(c.task.id);
  return decisionId;
}

/** Per candidate, in repo_key/dir order: excepted, already recorded, changed, off base, or recorded. */
function confirmAll({ words, exceptKeys, candidates }) {
  const results = [];
  for (const c of candidates) {
    const base = { key: candidateKey(c), dir: c.task.dir_name };
    if (exceptKeys.has(base.key)) { results.push({ ...base, action: "excepted" }); continue; }
    if (landEventWithSource(c.task.id)) { results.push({ ...base, action: "already recorded" }); continue; }
    if (newestIntentId(c.task.id) !== Number(c.event.id)) {
      results.push({ ...base, action: "changed since the migration, not recorded" });
      continue;
    }
    if (!headOnBase(c.task, c.recorded.head)) { results.push({ ...base, action: "no longer on base" }); continue; }
    results.push({ ...base, action: "recorded", decision_id: recordConfirmation(c, words) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The unresolved list and the would-read counts
// ---------------------------------------------------------------------------

function directOf(row) {
  const db = require("./db");
  const repo = db.repoOf(row.repo_key);
  return require("./policy").kindFromFile(repo && repo.main_root, row.repo_key) === "direct";
}

/**
 * The landing of every all-checked active task. In the dry run a candidate
 * still recordable reads landed (it will, after the confirmation); on --apply
 * the landings derive from what the run actually wrote.
 */
function landingSnapshot(candidates, { ignoreCache, wouldConfirm }) {
  const db = require("./db");
  const taskLib = require("./task");
  const derive = require("./derive");
  const byTask = new Map(candidates.map((c) => [c.task_id || c.task.id, c]));
  const snap = [];
  for (const row of db.listTasks({ disposition: "active" })) {
    let view;
    try { view = taskLib.readTaskJson(row.task_dir); } catch { continue; }
    if (!derive.allChecked(view)) continue;
    const cand = byTask.get(row.id);
    let landing = null;
    if (wouldConfirm && cand && cand.status === "candidate") landing = { state: "landed", proof: "push", reason: null };
    else {
      try { landing = derive.landingOfTask(row, view, { ignoreCache }); } catch { landing = { state: "unresolved", reason: "no branch" }; }
    }
    snap.push({ row, landing });
  }
  return snap;
}

function unresolvedList(snap, db) {
  return snap.filter((x) => x.landing && x.landing.state === "unresolved").map((x) => ({
    task_id: x.row.id, repo_key: x.row.repo_key, dir: x.row.dir_name, task_dir: x.row.task_dir,
    reason: (x.landing && x.landing.reason) || "unresolved",
    newest_intent_event_id: db.intentRecency(x.row.id).id,
  }));
}

// ---------------------------------------------------------------------------
// The dry-run groups read from the migrate events
// ---------------------------------------------------------------------------

function migrateReports() {
  const db = require("./db");
  const derive = require("./derive");
  const taskLib = require("./task");
  const out = { bad_rows: [], stored_landings: { recorded: [], not_recorded: [] }, planned_without_plan: [] };
  for (const row of db.open({ create: true }).all("SELECT * FROM events WHERE kind = 'migrate' ORDER BY id")) {
    let detail = {};
    try { detail = JSON.parse(row.detail || "{}"); } catch { detail = {}; }
    const task = db.getTask(row.task_id);
    if (!task) continue;
    const key = `${task.repo_key}/${task.dir_name}`;
    if (Array.isArray(detail.skipped) && detail.skipped.length > 0) out.bad_rows.push({ task: key, skipped: detail.skipped });
    if (typeof detail.landing === "string") out.stored_landings.not_recorded.push({ task: key, reason: detail.landing });
    const statuses = detail.phases && typeof detail.phases === "object" ? detail.phases : {};
    const planned = Object.entries(statuses)
      .filter(([, s]) => ["planned", "reviewed", "in_progress", "implemented"].includes(s))
      .map(([id]) => Number(id));
    if (planned.length > 0 && task.disposition === "active") {
      const dirs = taskLib.planDirsFor(task, db.pendingFoldOf(task.id));
      const noPlan = planned.filter((id) => !derive.planFileFor(dirs, id).file);
      if (noPlan.length > 0) out.planned_without_plan.push({ task: key, phases: noPlan });
    }
  }
  for (const row of db.open({ create: true }).all("SELECT * FROM events WHERE kind = 'land' ORDER BY id")) {
    let d = {};
    try { d = JSON.parse(row.detail || "{}"); } catch { d = {}; }
    if (!d.migrated || d.source) continue;
    const task = db.getTask(row.task_id);
    if (task) out.stored_landings.recorded.push({ task: `${task.repo_key}/${task.dir_name}`, head: d.head || null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// importAll
// ---------------------------------------------------------------------------

function parseExcept(except) {
  const out = new Set();
  if (except === undefined || except === null || except === true) return out;
  for (const raw of String(except).split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!raw.includes("/")) {
      throw refusal("bad_except", `--except takes <repo_key>/<dir>, got "${raw}"`);
    }
    out.add(raw);
  }
  return out;
}

/**
 * --apply refuses mixed roots: the tasks root, the database, the sessions root
 * and the trash bundle all under one sandbox root. A sandbox that names no
 * tasks root refuses too — with AGENTS_DB alone the file step would move the
 * real home's task.json files into the real home's trash.
 */
function checkMixedRoots() {
  const db = require("./db");
  const sandbox = require("./sandbox");
  const { tasksRootBase } = require("./tasks-root");
  const { trashRoot } = require("./trash");
  if (!sandbox.isSandbox()) return;
  const root = sandbox.root();
  if (root === null) {
    const tasksRoot = tasksRootBase();
    throw refusal("mixed_roots",
      `--apply refuses mixed roots: AGENTS_TASKS_ROOT is unset, so the file step would move everything under the tasks root at ${tasksRoot} into the trash at ${trashRoot()}, while the database is ${db.dbPath()}`);
  }
  const bad = [];
  if (!sandbox.contains(db.dbPath())) bad.push(`AGENTS_DB=${db.dbPath()}`);
  if (process.env.AGENTS_SESSIONS_ROOT && !sandbox.contains(process.env.AGENTS_SESSIONS_ROOT)) {
    bad.push(`AGENTS_SESSIONS_ROOT=${process.env.AGENTS_SESSIONS_ROOT}`);
  }
  if (!sandbox.contains(trashRoot())) bad.push(`the trash root at ${trashRoot()}`);
  if (bad.length > 0) {
    throw refusal("mixed_roots", `--apply refuses mixed roots: ${bad.join(", ")} sit outside ${root}`);
  }
}

/**
 * `a task import`: the dry run or the file step.
 * @param {object} [opts]
 * @param {boolean} [opts.apply] - fold, move, index and confirm instead of listing
 * @param {string} [opts.confirmRecorded] - the owner's words on the recorded-commit candidates
 * @param {string} [opts.except] - `<repo_key>/<dir>,…` candidates to leave out
 */
function importAll({ apply = false, confirmRecorded, except } = {}) {
  const db = require("./db");
  const sandbox = require("./sandbox");
  const { sessionsRoot } = require("./session");
  const dbFile = db.dbPath();
  const useDb = fs.existsSync(dbFile);

  const exceptKeys = parseExcept(except);
  if (apply) checkMixedRoots();

  // the candidates, read from the migrate events; --except names one of them or the run refuses
  let candidates = [];
  {
    const all = useDb ? candidateEntries() : [];
    for (const key of exceptKeys) {
      if (!all.some((c) => c.key === key)) {
        throw refusal("unknown_except", `--except ${key} names no recorded-commit candidate`);
      }
    }
    if (confirmRecorded !== undefined && all.length === 0) {
      throw refusal("no_recorded_candidates", "no recorded candidates: no migrate event holds a recorded-commit candidate to confirm");
    }
    candidates = all.filter((c) => !exceptKeys.has(c.key));
  }

  const b = newBundle();

  // step 1: the fold
  const fold = useDb ? runFold(b, { apply }) : { rows: [], loose: [], links: [] };

  // step 2: the task.json and index.json moves, every path through the sandbox guard
  const rootScan = scanTasksRoot();
  const index = readIndexJson();
  const indexMissing = useDb ? indexJsonMissingKeys(index) : [];
  const indexOutside = index ? !sandbox.contains(index.file) : false;
  const indexJson = index
    ? { path: index.file, moved: apply && indexMissing.length === 0 && !indexOutside, missing_keys: indexMissing, outside_sandbox: indexOutside }
    : null;
  const taskJson = rootScan.taskJson.map((p) => ({
    path: p,
    state: !sandbox.contains(p) ? "outside sandbox" : apply ? "moved" : "would move",
  }));

  // step 3: the sessions
  const scan = scanSessions(sessionsRoot());
  const sessionsGroup = {
    count: scan.entries.filter((s) => !s.error).length,
    skipped: scan.entries.filter((s) => s.error).map((s) => ({ path: s.dir, reason: s.error })),
  };

  let fetches = [];
  let confirm = null;
  let unresolved = [];
  let unresolvedJson = null;
  let reports = { bad_rows: [], stored_landings: { recorded: [], not_recorded: [] }, planned_without_plan: [] };
  let wouldRead = { done: 0, of_direct: 0, unresolved: 0, direct: 0, other: 0 };

  if (apply) {
    for (const m of taskJson) {
      if (m.state === "outside sandbox") continue;
      if (moveToBundle(b, m.path) === null) m.state = "outside sandbox";
    }
    if (index && indexMissing.length === 0 && !indexOutside) {
      if (moveToBundle(b, index.file) === null) {
        indexJson.moved = false;
        indexJson.outside_sandbox = true;
      }
    }
    for (const s of scan.entries.filter((e) => !e.error)) db.upsertSession(s.entryId, s.raw);
  }

  if (useDb) {
    if (apply) {
      // steps 4 and 5: the fetch, then the confirmation
      fetches = fetchCandidateRepos(candidates);
      if (confirmRecorded !== undefined) {
        confirm = { words: confirmRecorded, except: [...exceptKeys], results: confirmAll({ words: confirmRecorded, exceptKeys, candidates: candidateRows().sort(byKey) }) };
      }
    }
    // steps 6 and 7: the derive and the unresolved list
    reports = migrateReports();
    const snap = landingSnapshot(candidates, { ignoreCache: apply, wouldConfirm: !apply });
    unresolved = unresolvedList(snap, db);
    const inScope = snap.filter((x) => directOf(x.row));
    const unresolvedRows = snap.filter((x) => x.landing && x.landing.state === "unresolved");
    const direct = unresolvedRows.filter((x) => directOf(x.row)).length;
    wouldRead = {
      done: inScope.filter((x) => x.landing && x.landing.state === "landed").length,
      of_direct: inScope.length,
      unresolved: unresolvedRows.length,
      direct,
      other: unresolvedRows.length - direct,
    };
    if (apply && unresolved.length > 0) {
      ensureBundleDir(b);
      unresolvedJson = path.join(b.dir, "unresolved.json");
      if (!sandbox.contains(unresolvedJson)) {
        throw refusal("mixed_roots", `--apply refuses to write ${unresolvedJson}: it sits outside the sandbox`);
      }
      fs.writeFileSync(unresolvedJson, JSON.stringify(unresolved, null, 2) + "\n");
    }
  }

  // the one batch-close line to run on the owner's word (printed from this commit on)
  let closeLine = null;
  if (apply && unresolvedJson) {
    closeLine = `a task close --batch ${unresolvedJson} --quote "<owner's words>"`;
  }

  // step 8: the manifest and undo
  let bundle = null;
  if (apply && b.ops.length > 0) {
    ensureBundleDir(b);
    writeBundle(b);
  }
  if (apply && b.created) bundle = b.dir;

  const lastLine = `would read done ${wouldRead.done} of ${wouldRead.of_direct} direct, `
    + `unresolved ${wouldRead.unresolved} (${wouldRead.direct} direct, ${wouldRead.other} other)`;

  return {
    apply,
    db: dbFile,
    bundle,
    fold: { rows: fold.rows, count: fold.rows.length },
    loose: fold.loose,
    links: fold.links,
    task_json: taskJson,
    index_json: indexJson,
    state_json_only: rootScan.stateOnly.map((d) => ({ dir: d })),
    ...reports,
    candidates,
    sessions: sessionsGroup,
    fetch: fetches,
    confirm,
    unresolved,
    unresolved_json: unresolvedJson,
    close_line: closeLine,
    would_read: wouldRead,
    last_line: lastLine,
  };
}

/** Append moves to a bundle's manifest and regenerate undo.sh (the batch close's archive moves). */
function appendMoves(bundleDir, moves) {
  const manifest = path.join(bundleDir, "manifest.json");
  let ops = [];
  try { ops = JSON.parse(fs.readFileSync(manifest, "utf8")).ops || []; } catch { /* a bundle with no manifest yet */ }
  ops.push(...moves);
  fs.mkdirSync(path.join(bundleDir, "files"), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ ops }, null, 2) + "\n");
  fs.writeFileSync(path.join(bundleDir, "undo.sh"), undoScript(ops), { mode: 0o755 });
}

module.exports = { scanSessions, importAll, bundlePathFor, undoScript, appendMoves };
