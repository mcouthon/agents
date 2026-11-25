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
const STACK_GH_TIMEOUT_MS = 5000;

function gitOnce(cwd, args, timeout = GIT_TIMEOUT_MS) {
  const r = require("child_process").spawnSync("git", args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTS_LAND: "1" },
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout || "";
}

function ghOnce(cwd, args, timeout = GH_TIMEOUT_MS) {
  const r = require("child_process").spawnSync("gh", args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
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

/** A phase was checked after the land event (the migration's marks aside). */
function checkedSince(row, landEvent) {
  return [...checkmarksOfTask(row.id).values()].some((m) =>
    m.session_id !== MIGRATION_SESSION && landEvent.at && m.checked_at && m.checked_at > landEvent.at);
}

/** The newest land event's `head` is on base and nothing was checked after it (the migration's marks aside). */
function pushProof(row, landEvent, originBase, tree) {
  if (!landEvent || !landEvent.head) return { holds: false, reason: landEvent ? "no land record" : null };
  if (!originBase) return { holds: false, reason: "no branch" };
  const onBase = gitOnce(tree, ["merge-base", "--is-ancestor", landEvent.head, originBase]);
  if (onBase === null) return { holds: false, reason: "land head not on base" };
  if (checkedSince(row, landEvent)) return { holds: false, reason: "checked since the last land" };
  return { holds: true };
}

/** Whether a stacked layer's PR is merged: the land event's record, else (only when `askGh`)
 * GitHub's answer, which is recorded as a `layer_merged` event so later offline reads see it. A layer with no PR is open; a gh failure reads as not known merged. */
function layerMerged(tree, layer, askGh, recorded) {
  if (layer.merged || recorded.includes(layer.ref)) return { merged: true };
  if (!askGh || !layer.pr_url) return { merged: false };
  const gh = ghOnce(tree, ["pr", "view", layer.ref, "--json", "state"], STACK_GH_TIMEOUT_MS);
  if (gh.timeout) return { merged: false, ghFailed: "timeout" };
  if (gh.unavailable || gh.missing) return { merged: false, ghFailed: "gh unavailable" };
  try { return { merged: JSON.parse(gh.out).state === "MERGED" }; } catch { return { merged: false, ghFailed: "gh unreadable" }; }
}

/**
 * The landing of a stacked task: landed once every layer's PR is merged, unlanded while one is
 * open or a phase was checked after the land. `merged` lists the merged layers' refs; `ghFailed`
 * names a failed gh answer (that result is not cached).
 */
function stackLanding(row, tree, landEvent, askGh) {
  const db = require("./db");
  const recorded = db.mergedLayerRefs(row.id, landEvent.id);
  const merged = [];
  let ghFailed = null;
  for (const layer of landEvent.layers) {
    const answer = ghFailed ? { merged: false } : layerMerged(tree, layer, askGh, recorded);
    ghFailed = ghFailed || answer.ghFailed || null;
    if (answer.merged) merged.push(layer.ref);
    if (answer.merged && !layer.merged && !recorded.includes(layer.ref)) {
      db.appendEventIfFree({ kind: "layer_merged", repoKey: row.repo_key, taskId: row.id, detail: JSON.stringify({ ref: layer.ref }) });
    }
  }
  const open = landEvent.layers.filter((l) => !merged.includes(l.ref)).map((l) => l.ref);
  const base = { merged, ...(ghFailed ? { ghFailed } : {}) };
  if (checkedSince(row, landEvent)) return { state: "unlanded", proof: null, reason: "checked since the last land", checkedSince: true, ...base };
  if (open.length > 0) return { state: "unlanded", proof: null, reason: `open PRs: ${open.join(", ")}`, ...base };
  return { state: "landed", proof: "stack", ...base };
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
 * The landing of an all-checked task, shown or unresolved. A task whose last land
 * recorded stacked layers is decided by the stack alone (proof `stack`). Otherwise, in order:
 * the push proof alone first, then the branch (a ref that reads), then the
 * branch proofs (pr, rebase, squash) over a non-empty range, else unresolved
 * with its reason. Never called for a task with an unchecked phase.
 */
function computeLanding(row, ctx, { landEvent, originBase, branchInfo, askGh }) {
  const tree = ctx.tree;
  if (landEvent && Array.isArray(landEvent.layers) && landEvent.layers.length > 0) return stackLanding(row, tree, landEvent, askGh);
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
 * the sweep recomputes what it touches). Only `askGh` lets a stacked task's landing ask GitHub
 * whether its PRs merged — the one-task callers (`a next`, a task read) pass it; listings read
 * the land event's record, offline — and its answers cache apart from the offline ones.
 * @returns {{state: string, proof: string|null, reason: string|null, merged?: string[]}|null} null when a phase is unchecked
 */
function landingOfTask(row, task, { ignoreCache, askGh } = {}) {
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
    branchInfo ? branchInfo.tip : null, ctx.originBase, Boolean(askGh)];
  if (!ignoreCache) {
    const hit2 = cacheGet(elseKey);
    if (hit2 !== undefined) return hit2;
  }
  const result = computeLanding(row, ctx, { landEvent, originBase: ctx.originBase, branchInfo, askGh });
  if (result.state === "landed") cachePut(landedKey, result);
  const askedStack = askGh && result.merged && result.state !== "landed";
  if (!result.ghFailed && !askedStack) cachePut(elseKey, result);
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
function taskStatusOf(row, task, { boundLive, ignoreCache, askGh } = {}) {
  const view = task || require("./task").readTaskJson(row.task_dir);
  const landing = landingOfTask(row, view, { ignoreCache, askGh });
  if (allChecked(view) && landing && landing.state === "landed") return "done";
  return boundLive ? "in_progress" : "open";
}

/**
 * A session's state word: `gone` when it ended, or when its pid is dead (or
 * fails the identity check) and no zmx session matches; `needs_input` when a
 * lit row is still fresh — or, signal lit or not, when the bounded transcript
 * tail holds a completed turn (turn-end markers newer than every turn's
 * evidence) with nothing running since, which is how a signal-less seat waits
 * (the harness's idle notification does not always fire); else `live`: a turn
 * is running. A stale lit row (the session worked after the signal — the
 * owner's own keystroke fires no hook) reads by the same tail: live while the
 * turn runs, waiting once it ends.
 */
function sessionState(reg, { alive, zmxLive }) {
  if (reg && reg.ended_at) return "gone";
  if (!alive && !zmxLive) return "gone";
  if (reg && reg.needs_input && needsInputFresh(reg)) return "needs_input";
  if (reg && reg.transcript_path) {
    const facts = transcriptTailFacts(reg.transcript_path);
    if (facts && facts.newestMarkerMs !== null &&
        (facts.newestEvidenceMs === null || facts.newestEvidenceMs <= facts.newestMarkerMs)) {
      return "needs_input";
    }
  }
  return "live";
}

// The transcript-tail bound for needs-input freshness: the last 256 KiB —
// two orders of magnitude past the largest observed trailing bookkeeping run.
const NEEDS_INPUT_TAIL_BYTES = 256 * 1024;

/**
 * Whether an entry proves a turn ran — a typed prompt (a user row the
 * harness did not write), a tool-result user row, an assistant row. Harness
 * bookkeeping is never a turn: compact summaries (`isCompactSummary` — the
 * harness compacts idle sessions to preserve the prompt cache), machine
 * messages (`isMeta`), task-notification echoes (string content under the
 * `<task-notification>` prefix; no flag covers them). Sidechain is not
 * filtered: any turn means the session worked. Rows of other types are the
 * type filter's business, not this classifier's.
 */
function isTurnEvidence(entry) {
  if (entry.type === "assistant") return true;
  if (entry.type !== "user") return false;
  if (entry.isCompactSummary || entry.isMeta) return false;
  const c = entry.message && entry.message.content;
  if (typeof c === "string") return !c.startsWith("<task-notification>");
  return true; // tool-result content, and any unmodeled shape — the safe direction
}

/** Whether a transcript row is a main-thread answer that names the model that gave it. */
function answeredModel(entry) {
  return entry.type === "assistant" && !entry.isSidechain && !!entry.message
    && typeof entry.message.model === "string" && entry.message.model !== "<synthetic>";
}

/**
 * The facts the state words and the renewal's verify key on, from one
 * backward pass over the bounded tail: the newest turn evidence, the newest
 * turn-end marker — the `turn_duration`/`stop_hook_summary` system-row pair
 * the harness writes at every clean turn end — and the newest assistant row,
 * the model's own output and the one token-shaped fact a transcript holds —
 * and the newest main-thread assistant row's model (`newestModel`, never a
 * sidechain's or the harness's `<synthetic>`).
 * Null when the transcript cannot be read; null fields when the window holds
 * none of a kind.
 */
function transcriptTailFacts(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - NEEDS_INPUT_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the window's torn first line
    let newestEvidenceMs = null;
    let newestMarkerMs = null;
    let newestAssistantMs = null;
    let newestModel = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // a torn write, mid-line
      if (!entry) continue;
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts)) continue; // untimestamped rows of any kind
      if (isTurnEvidence(entry) && (newestEvidenceMs === null || ts > newestEvidenceMs)) newestEvidenceMs = ts;
      if (entry.type === "system" && (entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary")
          && (newestMarkerMs === null || ts > newestMarkerMs)) newestMarkerMs = ts;
      if (entry.type === "assistant" && (newestAssistantMs === null || ts > newestAssistantMs)) newestAssistantMs = ts;
      if (answeredModel(entry) && (newestModel === null || ts > newestModel.ms)) newestModel = { model: entry.message.model, ms: ts };
    }
    return { newestEvidenceMs, newestMarkerMs, newestAssistantMs, newestModel };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The model a live session's main thread runs: the newest main-thread answer
 * in the transcript tail written at or after this process's SessionStart
 * (`pid_at`) — it also follows an in-session /model switch — else the stored
 * model. Null when neither names one.
 */
function liveModelOf(reg) {
  const facts = reg.transcript_path ? transcriptTailFacts(reg.transcript_path) : null;
  const newest = facts && facts.newestModel;
  const sinceMs = Date.parse(reg.pid_at);
  if (newest && (!Number.isFinite(sinceMs) || newest.ms >= sinceMs)) return newest.model;
  return reg.model || null;
}

/**
 * Whether a registration's needs_input is still fresh. Fresh when the
 * registration names no transcript, the file cannot be opened, or no turn
 * ran after the signal's `at` — the newest turn evidence in the bounded tail
 * is not newer than `at`; ties and evidence-free windows read fresh. A turn
 * is user-prompt-to-completion: a typed prompt, a tool result, an assistant
 * row. Harness bookkeeping (compact summaries, machine messages,
 * task-notification echoes, and the away summaries and untimestamped rows
 * the row types already exclude) never unlights the signal; file times carry
 * no waiting/working signal — only a turn's rows do.
 */
function needsInputFresh(reg) {
  if (!reg || !reg.needs_input) return false;
  const atMs = Date.parse(reg.needs_input.at);
  if (!Number.isFinite(atMs)) return true; // an unreadable stamp cannot prove staleness
  const p = reg.transcript_path;
  if (!p) return true;
  const facts = transcriptTailFacts(p);
  if (!facts) return true;
  return facts.newestEvidenceMs === null || facts.newestEvidenceMs <= atMs;
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
  taskStatusOf, sessionState, needsInputFresh, liveModelOf, transcriptTailFacts, commitsInstantFor,
  factsPath, invalidateTask, flushFacts, resetCache,
};
