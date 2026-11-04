"use strict";

// Derived facts, read on demand and never stored as a status column: which plan
// file a phase has, the hash of its body, checked and skipped phases, git refs
// read from files, the landing proofs, a task's status word and a session's
// state. The slow half (git and `gh`) is cached per fact beside the database;
// nothing here writes the database, and the only file it writes is the cache.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Plan files (commit 1)
// ---------------------------------------------------------------------------

/**
 * A phase's plan files: the files in a plan/ folder whose name is
 * `phase-<id>` with an optional `-slug` (lowercase letters, digits and dashes)
 * before `.md`. The slug class has no dot, so suffixed siblings such as
 * `phase-32-m1.rewritten-by-builder-1606.md` never match, and `phase-1-x.md`
 * never matches phase 10.
 */
function planFileRe(phaseId) {
  return new RegExp(`^phase-${phaseId}(-[a-z0-9][a-z0-9-]*)?\\.md$`);
}

/**
 * Every matching file in `dirs`, newest first, deduplicated by resolved path
 * (the same folder listed twice counts once).
 * @returns {{file: string, mtimeMs: number}[]}
 */
function planCandidates(dirs, phaseId) {
  const re = planFileRe(phaseId);
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!re.test(name)) continue;
      const file = path.join(dir, name);
      const key = path.resolve(file);
      if (seen.has(key)) continue;
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      seen.add(key);
      out.push({ file, mtimeMs });
    }
  }
  out.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.file < b.file ? -1 : 1));
  return out;
}

/**
 * The plan file of a phase: the newest match when there is one, and how many
 * matched (more than one is a warning for `advise`).
 * @returns {{file: string|null, count: number}}
 */
function planFileFor(dirs, phaseId) {
  const matches = planCandidates(dirs, phaseId);
  if (matches.length === 0) return { file: null, count: 0 };
  const newest = matches[matches.length - 1];
  return { file: newest.file, count: matches.length };
}

/**
 * The plan body: the file's text above its first appended section
 * (`## Verification Evidence`, `## Execution Notes` or `## Plan Review`),
 * with every checkbox read as unchecked and trailing whitespace trimmed, so
 * the evidence a Builder appends and the ticks it sets never change it.
 */
function planBody(text) {
  const lines = String(text).split("\n");
  const cut = lines.findIndex((l) => /^## (Verification Evidence|Execution Notes|Plan Review)\b/.test(l));
  const body = cut === -1 ? lines : lines.slice(0, cut);
  return body
    .map((l) => l.replace(/^(\s*[-*] )\[([xX])\]/, "$1[ ]").replace(/\s+$/, ""))
    .join("\n");
}

/** The SHA-256 of a plan file's body; the one value an approval is bound to. */
function planHash(text) {
  return crypto.createHash("sha256").update(planBody(text)).digest("hex");
}

// ---------------------------------------------------------------------------
// Checked, skipped, current phase
// ---------------------------------------------------------------------------

/** True when a phase is checked: a checkmark or a skip decision. */
function phaseChecked(p) {
  return Boolean(p && p.checked);
}

/** True when the task has phases and every one of them is checked. */
function allChecked(task) {
  const phases = Array.isArray(task && task.phases) ? task.phases : [];
  return phases.length > 0 && phases.every(phaseChecked);
}

/**
 * The current phase: the first unchecked phase whose `after` phases are all
 * checked (a `blocked_by` naming no phase counts as done). Null when every
 * phase is checked or the task has none.
 */
function currentPhaseOf(task) {
  const phases = Array.isArray(task && task.phases) ? task.phases : [];
  const done = new Set(phases.filter(phaseChecked).map((p) => p.id));
  return phases.find((p) => !phaseChecked(p)
    && (p.blocked_by || []).every((b) => !phases.some((x) => x.id === b) || done.has(b))) || null;
}

// ---------------------------------------------------------------------------
// Refs read from files, never through git
// ---------------------------------------------------------------------------

/** The parsed `packed-refs` of a common directory, memoised per process. */
const packedCache = new Map();
function packedRefsOf(common) {
  if (packedCache.has(common)) return packedCache.get(common);
  const map = new Map();
  try {
    for (const line of fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
      if (m) map.set(m[2], m[1]);
    }
  } catch { /* no packed-refs: loose files only */ }
  packedCache.set(common, map);
  return map;
}

/**
 * The git layout of a tree: its `.git` directory (or the directory a `gitdir:`
 * file names) and, when a `commondir` file is present, the common directory
 * that holds `refs/` and `packed-refs`. Null when the tree is not a checkout.
 */
function gitContextOf(tree) {
  if (!tree || typeof tree !== "string") return null;
  const dot = path.join(tree, ".git");
  let gitDir = null;
  try {
    const st = fs.statSync(dot);
    if (st.isDirectory()) gitDir = dot;
    else {
      const m = /^gitdir:\s*(.+)$/.exec(fs.readFileSync(dot, "utf8").trim());
      if (m) gitDir = m[1].trim();
    }
  } catch { return null; }
  if (!gitDir || !fs.existsSync(gitDir)) return null;
  let common = gitDir;
  try {
    const c = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (c) common = path.resolve(gitDir, c);
  } catch { /* the git dir is the common dir */ }
  return { gitDir, common };
}

/** A ref's raw text: the loose file in the common directory, else packed-refs. */
function readRefRaw(ctx, ref) {
  if (!ctx) return null;
  try {
    return fs.readFileSync(path.join(ctx.common, ref), "utf8").trim();
  } catch { /* fall through to packed-refs */ }
  return packedRefsOf(ctx.common).get(ref) || null;
}

/**
 * A ref's commit SHA read from files, a symbolic ref followed up to five
 * levels. Null when the ref cannot be read that way (reftable, an unusual
 * layout): every fact that needs it then recomputes with git on each read.
 */
function refSha(ctx, ref, depth = 0) {
  if (!ctx || depth > 5) return null;
  const raw = readRefRaw(ctx, ref);
  if (raw === null) return null;
  const sym = /^ref:\s*(\S+)$/.exec(raw);
  if (sym) return refSha(ctx, sym[1], depth + 1);
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

/** A tree's HEAD text: the file its own git dir holds (a worktree's HEAD is not the common one). */
function headRaw(ctx) {
  if (!ctx) return null;
  try {
    return fs.readFileSync(path.join(ctx.gitDir, "HEAD"), "utf8").trim();
  } catch { return null; }
}

/** A tree's HEAD SHA: its own HEAD file, the symbolic target followed in the common store. */
function headSha(ctx) {
  if (!ctx) return null;
  const raw = headRaw(ctx);
  if (raw === null) return null;
  const sym = /^ref:\s*(\S+)$/.exec(raw);
  if (sym) return refSha(ctx, sym[1]);
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

/**
 * The base branch of a tree: the policy's when it names one, else the target
 * of `origin/HEAD`, else `main` or `master` when the head reads, else `main`.
 */
function baseFor(ctx, policyBase) {
  if (policyBase) return policyBase;
  if (ctx) {
    const head = readRefRaw(ctx, "refs/remotes/origin/HEAD");
    const sym = head && /^ref:\s*refs\/remotes\/origin\/(\S+)$/.exec(head);
    if (sym) return sym[1];
    if (refSha(ctx, "refs/heads/main")) return "main";
    if (refSha(ctx, "refs/heads/master")) return "master";
  }
  return "main";
}

// ---------------------------------------------------------------------------
// The per-fact cache: one JSON file beside the database
// ---------------------------------------------------------------------------

function factsPath() {
  const db = require("./db");
  return path.join(path.dirname(db.dbPath()), "agents.facts.json");
}

let cacheFile = null;
let cacheData = null;
let cacheDirty = false;

function loadCache() {
  const p = factsPath();
  if (cacheFile !== p) {
    cacheFile = p;
    cacheData = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") cacheData = parsed;
    } catch { /* missing or broken: every fact recomputes */ }
    cacheDirty = false;
  }
  return cacheData;
}

function cacheGet(key) {
  const k = JSON.stringify(key);
  const data = loadCache();
  return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined;
}

function cachePut(key, value) {
  const k = JSON.stringify(key);
  const data = loadCache();
  if (JSON.stringify(data[k]) === JSON.stringify(value)) return;
  data[k] = value;
  cacheDirty = true;
}

/** Forget the memoised cache, as a fresh process would; the file on disk stands. */
function resetCache() {
  cacheFile = null;
  cacheData = null;
  cacheDirty = false;
}

/** Drop every cache entry whose key mentions a task id (the sweep recomputes what it touches). */
function invalidateTask(taskId) {
  const needle = JSON.stringify(String(taskId));
  const data = loadCache();
  for (const k of Object.keys(data)) {
    if (k.includes(needle)) { delete data[k]; cacheDirty = true; }
  }
}

function flushFacts() {
  if (!cacheDirty) return;
  const target = factsPath();
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(loadCache()));
    fs.renameSync(tmp, target);
    cacheDirty = false;
  } catch { /* an unwritable cache never stops a read */ } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}
process.on("exit", flushFacts);

// ---------------------------------------------------------------------------
// Slow git facts (the half of today's advice that needs git)
// ---------------------------------------------------------------------------

// 15 s, not 5: check.sh runs every suite in parallel and the machine's
// background load can queue-stall a trivial `git rev-list` past 5 s — the
// landing then read "no branch" (a timeout is not a git answer). Same
// precedent as the zmx list budget's 2000→5000 raise under the same pool.
const GIT_TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 10000;

function gitOnce(cwd, args, timeout = GIT_TIMEOUT_MS) {
  const r = require("child_process").spawnSync("git", args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout || "";
}

function ghOnce(cwd, args) {
  const r = require("child_process").spawnSync("gh", args, {
    cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (r.error && r.error.code === "ETIMEDOUT") return { timeout: true };
  if (r.error && r.error.code === "ENOENT") return { missing: true };
  if (r.error || r.status !== 0) return { unavailable: true };
  return { out: r.stdout || "" };
}

/**
 * How many commits the tree gained since an instant. One `git log` per tree
 * covers every instant asked of it; the entry stores the oldest instant it was
 * computed with, and an older instant is a miss that recomputes the entry.
 */
function commitsSince(tree, head, instant, ignoreCache) {
  const key = ["commits", head];
  let entry = ignoreCache ? undefined : cacheGet(key);
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return 0;
  if (!entry || !(entry.since <= at)) {
    const since = Math.min(entry ? entry.since : at, at) - 1000;
    const log = gitOnce(tree, ["log", "--format=%H %ct", head, `--since=${new Date(since).toISOString()}`]);
    if (log === null) return 0;
    entry = {
      since,
      commits: log.split("\n").filter(Boolean).map((l) => {
        const [sha, ct] = l.split(" ");
        return [sha, Number(ct)];
      }),
    };
    cachePut(key, entry);
  }
  const floor = Math.floor(at / 1000);
  return entry.commits.filter(([, ct]) => ct >= floor).length;
}

/** How many commits the tip holds that `origin/<base>` does not; null when uncomputable. */
function unlandedOf(tree, tip, originBase, ignoreCache) {
  if (!tip || !originBase) return null;
  const key = ["unlanded", tip, originBase];
  const hit = ignoreCache ? undefined : cacheGet(key);
  if (hit !== undefined) return hit;
  const n = gitOnce(tree, ["rev-list", "--count", `${originBase}..${tip}`]);
  const value = n === null ? null : Number(n.trim());
  cachePut(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// The landing proofs
// ---------------------------------------------------------------------------

const MIGRATION_SESSION = "migration";

function checkmarksOfTask(taskId) {
  return require("./db").checkmarksOf(taskId);
}

/** The newest land event's `head` is on base and nothing was checked after it (the migration's marks aside). */
function pushProof(row, landEvent, originBase, tree) {
  if (!landEvent || !landEvent.head) return { holds: false, reason: landEvent ? "no land record" : null };
  if (!originBase) return { holds: false, reason: "no branch" };
  const onBase = gitOnce(tree, ["merge-base", "--is-ancestor", landEvent.head, originBase]);
  if (onBase === null) return { holds: false, reason: "land head not on base" };
  for (const m of checkmarksOfTask(row.id).values()) {
    if (m.session_id === MIGRATION_SESSION) continue;
    if (landEvent.at && m.checked_at && m.checked_at > landEvent.at) {
      return { holds: false, reason: "checked since the last land" };
    }
  }
  return { holds: true };
}

/**
 * The branch a task's landing is computed for: `tasks.branch` when its ref
 * reads (locally or at origin; a named branch that reads neither counts as no
 * branch), else the worktree's checked-out branch, else `wt/<dir_name>` when
 * that ref reads. The ref it reads and its tip come back with it.
 */
function branchOf(row, ctx) {
  const named = (ref) => {
    const local = refSha(ctx.gitCtx, `refs/heads/${ref}`);
    if (local) return { branch: ref, ref: `refs/heads/${ref}`, tip: local };
    const remote = refSha(ctx.gitCtx, `refs/remotes/origin/${ref}`);
    if (remote) return { branch: ref, ref: `refs/remotes/origin/${ref}`, tip: remote };
    return null;
  };
  if (row.branch) {
    const found = named(row.branch);
    if (found) return found;
  }
  if (ctx.worktreePath) {
    const wctx = gitContextOf(ctx.worktreePath);
    const raw = wctx && headRaw(wctx);
    const sym = raw && /^ref:\s*refs\/heads\/(\S+)$/.exec(raw);
    if (sym) {
      const tip = refSha(wctx, `refs/heads/${sym[1]}`);
      if (tip) return { branch: sym[1], ref: `refs/heads/${sym[1]}`, tip };
    }
  }
  return named(`wt/${row.dir_name}`);
}

/** Every commit in the branch's range, upstream by patch. */
function cherryMarks(tree, originBase, tip) {
  const out = gitOnce(tree, ["cherry", originBase, tip]);
  if (out === null) return null;
  const marks = {};
  for (const line of out.split("\n")) {
    const m = /^([-+]) ([0-9a-f]{40})/.exec(line.trim());
    if (m) marks[m[2]] = m[1];
  }
  return marks;
}

/** The stable patch-id of a diff (`git diff <a>..<b>`) or one commit (`git diff-tree -p <sha>`). */
function patchIdOf(tree, args) {
  const r = require("child_process").spawnSync("git", args, {
    cwd: tree, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (r.error || r.status !== 0) return null;
  const p = require("child_process").spawnSync("git", ["patch-id", "--stable"], {
    cwd: tree, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    input: r.stdout || "", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (p.error || p.status !== 0) return null;
  return (p.stdout || "").trim().split(/\s+/)[0] || null;
}

/**
 * The landing of an all-checked task, shown or unresolved. Evaluated in order:
 * the push proof alone first, then the branch (a ref that reads), then the
 * branch proofs (pr, rebase, squash) over a non-empty range, else unresolved
 * with its reason. Never called for a task with an unchecked phase.
 */
function computeLanding(row, ctx, { landEvent, originBase, branchInfo }) {
  const tree = ctx.tree;
  const push = pushProof(row, landEvent, originBase, tree);
  if (push.holds) return { state: "landed", proof: "push" };
  const pushReason = push.reason;

  const branch = branchInfo || branchOf(row, ctx);
  if (branch && originBase) {
    const count = gitOnce(tree, ["rev-list", "--count", `${originBase}..${branch.tip}`]);
    if (count !== null && Number(count.trim()) > 0) {
      const range = `${originBase}..${branch.tip}`;
      // pr: a merged PR whose head is the tip, or whose later commits are upstream by patch
      if (ctx.policy !== "direct") {
        const gh = ghOnce(tree, ["pr", "list", "--head", branch.branch, "--state", "merged", "--limit", "20",
          "--json", "number,url,mergedAt,headRefOid"]);
        if (gh.timeout) return { state: "unresolved", reason: "timeout" };
        if (gh.unavailable) return { state: "unresolved", reason: "gh unavailable" };
        if (!gh.missing && gh.out) {
          let merged = null;
          try { merged = JSON.parse(gh.out); } catch { merged = null; }
          const newest = Array.isArray(merged) && merged.length > 0
            ? merged.reduce((a, b) => (String(b.mergedAt || "") > String(a.mergedAt || "") ? b : a))
            : null;
          if (newest && newest.headRefOid) {
            if (newest.headRefOid === branch.tip) return { state: "landed", proof: "pr" };
            const after = gitOnce(tree, ["rev-list", `${newest.headRefOid}..${branch.tip}`]);
            const marks = cherryMarks(tree, originBase, branch.tip);
            if (after !== null && marks) {
              const own = after.split("\n").filter(Boolean);
              if (own.length > 0 && own.every((sha) => marks[sha] === "-")) {
                return { state: "landed", proof: "pr" };
              }
            }
          }
        }
      }
      // rebase: the same patches, new SHAs
      const marks = cherryMarks(tree, originBase, branch.tip);
      if (marks) {
        const own = gitOnce(tree, ["rev-list", range]);
        if (own !== null) {
          const shas = own.split("\n").filter(Boolean);
          if (shas.length > 0 && shas.every((sha) => marks[sha] === "-")) {
            return { state: "landed", proof: "rebase" };
          }
        }
      }
      // squash: the range's combined diff equals one base commit's patch
      const mb = gitOnce(tree, ["merge-base", originBase, branch.tip]);
      if (mb !== null) {
        const combined = patchIdOf(tree, ["diff", `${mb.trim()}..${branch.tip}`]);
        if (combined) {
          const baseCommits = gitOnce(tree, ["rev-list", `${mb.trim()}..${originBase}`]);
          if (baseCommits !== null) {
            for (const sha of baseCommits.split("\n").filter(Boolean).slice(0, 500)) {
              if (patchIdOf(tree, ["diff-tree", "-p", sha]) === combined) {
                return { state: "landed", proof: "squash" };
              }
            }
          }
        }
      }
      return { state: "unlanded", proof: null, reason: null };
    }
    if (count !== null && Number(count.trim()) === 0) {
      if (landEvent) return { state: "unresolved", proof: null, reason: pushReason || "checked since the last land" };
      return { state: "unresolved", proof: null, reason: "branch on base with no commits of its own" };
    }
  }
  if (landEvent) return { state: "unresolved", proof: null, reason: pushReason || "checked since the last land" };
  if (ctx.policy === "direct") return { state: "unresolved", proof: null, reason: "no land record" };
  return { state: "unresolved", proof: null, reason: "no branch" };
}

/**
 * The landing of a task's row, through the cache: keyed, once landed, by the
 * newest intent event id and the branch tip (a landed proof keeps holding as
 * base moves forward); otherwise by those, the newest land event id, the
 * branch tip and `origin/<base>` (a force-pushed base is the one miss, and
 * the sweep recomputes what it touches).
 * @returns {{state: string, proof: string|null, reason: string|null}|null} null when a phase is unchecked
 */
function landingOfTask(row, task, { ignoreCache } = {}) {
  const db = require("./db");
  const view = task || require("./task").readTaskJson(row.task_dir);
  if (!allChecked(view)) return null;
  const ctx = contextOf(row, view);
  if (!ctx) return { state: "unresolved", proof: null, reason: "no branch" };
  const recency = db.intentRecency(row.id);
  const branchInfo = branchOf(row, ctx);
  const landedKey = ["landing-landed", row.id, recency.id, branchInfo ? branchInfo.tip : null];
  const hit = ignoreCache ? undefined : cacheGet(landedKey);
  if (hit !== undefined) return hit;
  const landEvent = db.lastLandEvent(row.id);
  const elseKey = ["landing", row.id, recency.id, landEvent ? landEvent.id : null,
    branchInfo ? branchInfo.tip : null, ctx.originBase];
  if (!ignoreCache) {
    const hit2 = cacheGet(elseKey);
    if (hit2 !== undefined) return hit2;
  }
  const result = computeLanding(row, ctx, { landEvent, originBase: ctx.originBase, branchInfo });
  if (result.state === "landed") cachePut(landedKey, result);
  cachePut(elseKey, result);
  return result;
}

/**
 * The git and policy context of a task's row: its tree (the worktree when one
 * is recorded, else the main checkout), the refs read from files, the base
 * branch and the repo's landing policy. main_root comes from the repos row,
 * repo_key from the task row; no git runs here. Null when no checkout exists.
 */
function contextOf(row, view, opts = {}) {
  const db = require("./db");
  const tasksRoot = require("./tasks-root");
  let mainRoot = null;
  try { mainRoot = (db.repoOf(row.repo_key) || {}).main_root || null; } catch { /* no row */ }
  if (!mainRoot && opts.mainRoot) mainRoot = opts.mainRoot;
  if (!mainRoot) mainRoot = tasksRoot.mainRootOf(row.task_dir);
  if (!mainRoot || !fs.existsSync(mainRoot)) return null;
  const worktreePath = (view && view.worktree_path) || row.worktree_path || null;
  const tree = worktreePath && fs.existsSync(worktreePath) ? worktreePath : mainRoot;
  const policyEntry = require("./policy").lookupEntry(mainRoot, row.repo_key);
  const policy = policyEntry ? (policyEntry.push === "pr" ? "pr" : "direct") : "unlisted";
  const gitCtx = gitContextOf(tree);
  const base = baseFor(gitCtx, policyEntry ? policyEntry.base : null);
  const originBase = gitCtx ? refSha(gitCtx, `refs/remotes/origin/${base}`) : null;
  return { mainRoot, key: { key: row.repo_key, main_root: mainRoot }, tree, worktreePath, policy, gitCtx, base, originBase };
}

/**
 * A task's status word: `done` when every phase is checked and the landing is
 * landed, `in_progress` when a live session is bound, else `open`.
 */
function taskStatusOf(row, task, { boundLive, ignoreCache } = {}) {
  const view = task || require("./task").readTaskJson(row.task_dir);
  const landing = landingOfTask(row, view, { ignoreCache });
  if (allChecked(view) && landing && landing.state === "landed") return "done";
  return boundLive ? "in_progress" : "open";
}

/**
 * A session's state word: `gone` when it ended, or when its pid is dead (or
 * fails the identity check) and no zmx session matches; else `live`.
 */
function sessionState(reg, { alive, zmxLive }) {
  if (reg && reg.ended_at) return "gone";
  if (!alive && !zmxLive) return "gone";
  if (reg && reg.needs_input) return "needs_input";
  return "live";
}

// ---------------------------------------------------------------------------
// The commits instant (which commits count for check versus build)
// ---------------------------------------------------------------------------

/**
 * The instant a phase's commits count from: under `approvals: ask` the phase's
 * latest `accept`; otherwise the latest of the phase's latest approve (or
 * waived phase-plan) decision, the task's newest checkmark of another phase,
 * its newest land event, and, as the floor, `tasks.created`. A plan file's
 * mtime never enters it.
 */
function commitsInstantFor(row, view, phaseId, decisions) {
  const db = require("./db");
  const knob = (view && view.knobs && view.knobs.approvals) || null;
  const approvals = knob === "ask" ? "ask" : "none";
  const rowsOf = (id, ...choices) => decisions.filter((d) => d.phase_id === id && choices.includes(d.choice));
  const latest = (rows) => (rows.length > 0 ? rows[rows.length - 1] : null);
  if (approvals === "ask") {
    const accept = latest(rowsOf(phaseId, "accept", "land_anyway"));
    return accept ? accept.decided_at : (row.created || null);
  }
  const candidates = [];
  const verdict = latest(rowsOf(phaseId, "approve", "waived"));
  if (verdict && verdict.decided_at) candidates.push(verdict.decided_at);
  const marks = checkmarksOfTask(row.id);
  for (const [id, m] of marks) {
    if (id !== phaseId && m.checked_at) candidates.push(m.checked_at);
  }
  const landAt = db.lastEventAt(row.id, "land");
  if (landAt) candidates.push(landAt);
  if (row.created) candidates.push(row.created);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

module.exports = {
  planFileRe, planCandidates, planFileFor, planBody, planHash,
  gitContextOf, readRefRaw, refSha, headRaw, headSha, packedRefsOf, baseFor,
  phaseChecked, allChecked, currentPhaseOf,
  commitsSince, unlandedOf, branchOf, landingOfTask, contextOf,
  taskStatusOf, sessionState, commitsInstantFor,
  factsPath, invalidateTask, flushFacts, resetCache,
};
