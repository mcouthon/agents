#!/usr/bin/env node
"use strict";

// Derivation: the landing proofs (push, pr, rebase, squash, unlanded and the
// unresolved reasons), refs and base read from files, the per-fact cache, the
// commits instant, the task status words and the session states. Real git
// fixtures with bare origins; `gh` is a PATH stub; git calls go through a
// counting wrapper. One sandbox holds the tasks root, the sessions root, the
// database, the homes and every fixture repo.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-derive-")));
  for (const d of ["home", "tasks", "sessions", "bin", "nogh", "repos", "origins"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "home", "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
    AGENTS_TEST_SKIP_IDENTITY: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const T = process.env.AGENTS_TEST_TMP;
const db = require("./lib/db");
const taskLib = require("./lib/task");
const derive = require("./lib/derive");
const { repoKey } = require("./lib/repo");
const { POLICIES_PATH } = require("./lib/policy");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const CLI = path.join(__dirname, "bin", "a");
const GIT_LOG = path.join(T, "git.log");
const GH_LOG = path.join(T, "gh.log");
const GH_OUT = path.join(T, "gh.out");

// the counting git wrapper: every call logged with its cwd, then forwarded
fs.writeFileSync(path.join(T, "bin", "git"), `#!/bin/sh\nprintf '%s' "$(pwd)" >> '${GIT_LOG}'\nprintf ' %s' "$@" >> '${GIT_LOG}'\nprintf '\\n' >> '${GIT_LOG}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
fs.copyFileSync(path.join(T, "bin", "git"), path.join(T, "nogh", "git"));
// the gh stub: prints $GH_OUT, logs the argv, sleeps when asked
fs.writeFileSync(path.join(T, "bin", "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${GH_LOG}'\n[ -n "$GH_STUB_SLEEP" ] && sleep 12\ncat '${GH_OUT}'\nexit 0\n`, { mode: 0o755 });
// the stubs shadow the real gh (and count every git call) while the original
// path keeps node reachable for the child `a` runs; the no-gh path drops gh
// entirely but keeps node and git
const ORIG_PATH = process.env.PATH;
const NODE_DIR = path.dirname(process.execPath);
const PATH_GH = `${path.join(T, "bin")}:${ORIG_PATH}`;
const PATH_NOGH = `${path.join(T, "nogh")}:${NODE_DIR}:/usr/bin:/bin`;
process.env.PATH = PATH_GH;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitLines = () => (fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, "utf8").split("\n").filter(Boolean) : []);
const ghLines = () => (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean) : []);
const clearLogs = () => { fs.rmSync(GIT_LOG, { force: true }); fs.rmSync(GH_LOG, { force: true }); };
const setGh = (out) => fs.writeFileSync(GH_OUT, out);

/** List repos in the policy file (each key by realpath). */
function listPolicy(entries) {
  const doc = {};
  for (const [main, value] of entries) doc[fs.realpathSync(main)] = value;
  fs.mkdirSync(path.dirname(POLICIES_PATH), { recursive: true });
  fs.writeFileSync(POLICIES_PATH, JSON.stringify(doc, null, 2));
}

let repoCounter = 0;
/** A bare origin and its clone with one pushed commit: { origin, main, key }. */
function makeRepo({ policy = "direct", initAt } = {}) {
  const n = ++repoCounter;
  const origin = path.join(T, "origins", `o${n}.git`);
  const main = path.join(T, "repos", `r${n}`);
  git(T, "init", "-q", "--bare", "-b", "main", origin);
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "README.md"), "# r\n");
  git(main, "add", ".");
  if (initAt) {
    execFileSync("git", ["-C", main, "commit", "-q", "-m", "init"], { env: { ...process.env, GIT_COMMITTER_DATE: initAt }, encoding: "utf8" });
  } else {
    git(main, "commit", "-q", "-m", "init");
  }
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "-u", "origin", "main");
  const key = repoKey(main);
  if (policy) listPolicy([[main, { push: policy }]]);
  return { origin, main, key };
}

let taskCounter = 0;
/** A task of the repo with one phase, checked when `checked`, plus a worktree on `branch`. */
function mkTask(repo, { branch, checked = false, phases, approvals } = {}) {
  const slug = `d${++taskCounter}`;
  const made = taskLib.createTask({ repo: repo.key, title: slug, slug, session_id: "s", phases: phases || [{ id: 1, name: "One" }] });
  const taskId = db.taskIdOf(made.task_dir);
  if (approvals !== undefined) db.setTaskKnob(taskId, "approvals", approvals);
  let wtPath = null;
  if (branch) {
    wtPath = path.join(T, "repos", `${slug}-wt`);
    git(repo.main, "worktree", "add", "-q", "-b", branch, wtPath, "origin/main");
    db.setTaskWorktree(taskId, { worktreePath: wtPath, branch });
  }
  if (checked) for (const p of (phases || [{ id: 1 }])) taskLib.checkPhase({ taskDir: made.task_dir, phaseId: p.id });
  return { taskDir: made.task_dir, taskId, wtPath, slug };
}

const landEvent = (taskId, head, { at } = {}) => {
  const when = at || new Date(Date.now() - 1000).toISOString();
  db.appendEvent({ kind: "land", taskId, detail: JSON.stringify({ head, migrated: true }) });
  const conn = db.open();
  conn.tx(() => {
    conn.run("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'land'", when, taskId);
    // the marks the task already holds predate the land record
    conn.run("UPDATE checkmarks SET checked_at = ? WHERE task_id = ? AND checked_at > ?",
      new Date(Date.parse(when) - 1000).toISOString(), taskId, new Date(Date.parse(when) - 1000).toISOString());
  });
  db.close();
};

const commitIn = (dir, file, text, message) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
};

/** Cherry-pick `sha` onto main with a distinct committer time, so the SHA differs from the original. */
const pickOnto = (main, sha) => {
  const env = { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 5000).toISOString() };
  execFileSync("git", ["-C", main, "cherry-pick", sha], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

const landingOf = (taskDir) => derive.landingOfTask(db.getTask(db.taskIdOf(taskDir)));
const statusOf = (taskDir, opts = {}) => derive.taskStatusOf(db.getTask(db.taskIdOf(taskDir)), taskLib.readTaskJson(taskDir), opts);
const headOf = (dir) => git(dir, "rev-parse", "HEAD");

// ---------------------------------------------------------------- D1 squash / pr
{
  const repo = makeRepo({ policy: "pr" });
  const t = mkTask(repo, { branch: "wt/d1", checked: true });
  commitIn(t.wtPath, "f1.txt", "f1\n", "first half");
  commitIn(t.wtPath, "f2.txt", "f2\n", "second half");
  git(repo.main, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--squash", "wt/d1");
  git(repo.main, "commit", "-q", "-m", "squashed");
  git(repo.main, "push", "-q", "origin", "main");

  setGh(JSON.stringify([{ number: 7, url: "https://example.test/pr/7", mergedAt: "2026-10-01T00:00:00Z", headRefOid: headOf(t.wtPath) }]));
  clearLogs();
  let landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "pr", `D1: a merged PR at the tip is landed/pr (${JSON.stringify(landing)})`);
  check(ghLines().length > 0 && ghLines()[0].includes("pr list"), `D1: gh ran with pr list (${ghLines()[0] || "none"})`);

  derive.resetCache();
  process.env.PATH = PATH_NOGH;
  landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "squash", `D1: with no gh the same patch on base is landed/squash (${JSON.stringify(landing)})`);
  process.env.PATH = PATH_GH;
}

// ---------------------------------------------------------------- D2 the PR head behind the tip
{
  const repo = makeRepo({ policy: "pr" });
  const t = mkTask(repo, { branch: "wt/d2", checked: true });
  commitIn(t.wtPath, "a.txt", "first\n", "first");
  const prHead = headOf(t.wtPath);
  commitIn(t.wtPath, "b.txt", "second\n", "second");
  setGh(JSON.stringify([{ number: 8, url: "https://example.test/pr/8", mergedAt: "2026-10-01T00:00:00Z", headRefOid: prHead }]));
  const landing = landingOf(t.taskDir);
  check(landing.state === "unlanded", `D2: a PR merged behind the tip with new work after it reads unlanded (${JSON.stringify(landing)})`);
}

// ---------------------------------------------------------------- D3 an empty range tries no proof
{
  const repo = makeRepo({ policy: "pr" });
  const t = mkTask(repo, { branch: "wt/d3", checked: true }); // no commit of its own
  setGh(JSON.stringify([{ number: 9, url: "https://example.test/pr/9", mergedAt: "2026-10-01T00:00:00Z", headRefOid: headOf(t.wtPath) }]));
  clearLogs();
  let landing = landingOf(t.taskDir);
  check(landing.state === "unresolved" && landing.reason === "branch on base with no commits of its own",
    `D3: an empty range gives no verdict of its own (${JSON.stringify(landing)})`);
  check(ghLines().length === 0, "D3: gh is not asked for a branch with no commits of its own");

  // a non-empty range whose patches are all upstream: rebase, never pr (no gh)
  const repo2 = makeRepo({ policy: "pr" });
  const t2 = mkTask(repo2, { branch: "wt/d3b", checked: true });
  commitIn(t2.wtPath, "x.txt", "x\n", "x");
  const patch = headOf(t2.wtPath);
  pickOnto(repo2.main, patch);
  git(repo2.main, "push", "-q", "origin", "main");
  clearLogs();
  process.env.PATH = PATH_NOGH;
  landing = landingOf(t2.taskDir);
  check(landing.state === "landed" && landing.proof === "rebase", `D3: the same patches upstream read landed/rebase (${JSON.stringify(landing)})`);
  check(gitLines().every((l) => !l.includes(" pr ")), "D3: no pr list ran with no gh on the path");
  process.env.PATH = PATH_GH;
}

// ---------------------------------------------------------------- D4 rebase: same patches, new SHAs
{
  const repo = makeRepo({ policy: "direct" });
  const t = mkTask(repo, { branch: "wt/d4", checked: true });
  commitIn(t.wtPath, "y.txt", "y\n", "y");
  const sha = headOf(t.wtPath);
  // main moves with the same change, the branch keeps its own SHA
  pickOnto(repo.main, sha);
  git(repo.main, "push", "-q", "origin", "main");
  const landing = landingOf(t.taskDir);
}

// ---------------------------------------------------------------- D5 ancestry alone is never a proof
{
  const repo = makeRepo();
  const t = mkTask(repo, { branch: "wt/d5", checked: true }); // the branch sits on origin/main
  process.env.PATH = PATH_NOGH;
  const landing = landingOf(t.taskDir);
  check(landing.state === "unresolved" && landing.reason === "branch on base with no commits of its own",
    `D5: a branch that is an ancestor of base with no commits of its own reads unresolved (${JSON.stringify(landing)})`);
  process.env.PATH = PATH_GH;

  // a main checkout whose origin/main..main is empty, no land event, direct repo
  const t2 = mkTask(repo, { checked: true });
  const landing2 = landingOf(t2.taskDir);
  check(landing2.state === "unresolved" && landing2.reason === "no land record",
    `D5: an empty main range on a direct repo with no land record reads no land record (${JSON.stringify(landing2)})`);
}

// ---------------------------------------------------------------- D6 the push proof
{
  const repo = makeRepo();
  const t = mkTask(repo, { checked: true });
  const head = headOf(repo.main);
  landEvent(t.taskId, head);
  let landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "push", `D6: a land event's head on base is landed/push (${JSON.stringify(landing)})`);

  // a checkmark newer than the land event breaks the proof
  taskLib.addPhases({ taskDir: t.taskDir, phases: [{ id: 2, name: "Two", after: [1] }] });
  taskLib.checkPhase({ taskDir: t.taskDir, phaseId: 2 });
  landing = landingOf(t.taskDir);
  check(landing.state === "unresolved" && landing.reason === "checked since the last land",
    `D6: a checkmark after the land reads checked since the last land (${JSON.stringify(landing)})`);

  // an unpushed commit in the tree, no new checkmark: the proof holds (round 5)
  const t2 = mkTask(repo, { checked: true });
  landEvent(t2.taskId, headOf(repo.main));
  commitIn(repo.main, "later.txt", "l\n", "later"); // unpushed
  landing = landingOf(t2.taskDir);
  check(landing.state === "landed" && landing.proof === "push", `D6: an unpushed commit after the land keeps landed/push (${JSON.stringify(landing)})`);
  const ctx = derive.contextOf(db.getTask(t2.taskId), taskLib.readTaskJson(t2.taskDir));
  const tip = derive.headSha(ctx.gitCtx);
  check(derive.unlandedOf(ctx.tree, tip, ctx.originBase) === 1, "D6: the unlanded fact counts the unpushed commit");
}

// ---------------------------------------------------------------- D7 the push failure over an empty range (E8)
{
  const repo = makeRepo();
  const t = mkTask(repo, { branch: "wt/d7", checked: true }); // no commit of its own
  landEvent(t.taskId, headOf(repo.main));
  taskLib.addPhases({ taskDir: t.taskDir, phases: [{ id: 2, name: "Two", after: [1] }] });
  taskLib.checkPhase({ taskDir: t.taskDir, phaseId: 2 });
  const landing = landingOf(t.taskDir);
  check(landing.state === "unresolved" && landing.reason === "checked since the last land",
    `D7: the push failure is the reason shown over an empty range (${JSON.stringify(landing)})`);

  const t2 = mkTask(repo, { branch: "wt/d7b", checked: true });
  const landing2 = landingOf(t2.taskDir);
  check(landing2.state === "unresolved" && landing2.reason === "branch on base with no commits of its own",
    `D7: the same branch with no land event says so (${JSON.stringify(landing2)})`);
}

// ---------------------------------------------------------------- D8 a land from the worktree lands push first (D5)
{
  const repo = makeRepo();
  const t = mkTask(repo, { branch: "wt/d8", checked: true });
  commitIn(t.wtPath, "w.txt", "w\n", "w");
  const r = (() => { try { return { result: require("./lib/land").land({ taskDir: t.taskDir, projectDir: repo.main, checks: ["true"] }) }; } catch (err) { return { err }; } })();
  check(!r.err && r.result.pushed, `D8: a land rebases and pushes the worktree branch (${r.err && r.err.message})`);
  const landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "push",
    `D8: the branch range is empty yet the landing is landed/push, not the empty-range reason (${JSON.stringify(landing)})`);
}

// ---------------------------------------------------------------- D9 a dead branch
{
  const repo = makeRepo();
  const t = mkTask(repo, { checked: true });
  db.setTaskWorktree(t.taskId, { worktreePath: null, branch: "wt/gone" });
  landEvent(t.taskId, headOf(repo.main));
  clearLogs();
  const landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "push", `D9: a dead branch with a land head on base reads landed/push (${JSON.stringify(landing)})`);
  check(gitLines().every((l) => !/wt\/gone/.test(l) || !/merge-base|cherry|patch-id/.test(l)),
    "D9: no branch-proof git call names the dead branch");

  const t2 = mkTask(repo, { checked: true });
  db.setTaskWorktree(t2.taskId, { worktreePath: null, branch: "wt/gone2" });
  const landing2 = landingOf(t2.taskDir);
  check(landing2.state === "unresolved" && landing2.reason === "no land record",
    `D9: the same dead branch with no land record reads no land record (${JSON.stringify(landing2)})`);
}

// ---------------------------------------------------------------- D10 unpushed
{
  const repo = makeRepo();
  const t = mkTask(repo, { branch: "wt/d10", checked: true });
  commitIn(t.wtPath, "u.txt", "u\n", "u");
  const landing = landingOf(t.taskDir);
  check(landing.state === "unlanded", `D10: a commit missing upstream reads unlanded (${JSON.stringify(landing)})`);
}

// ---------------------------------------------------------------- D11 the branch from the worktree
{
  const repo = makeRepo();
  const t = mkTask(repo, { branch: "feature/x", checked: true });
  db.setTaskWorktree(t.taskId, { worktreePath: t.wtPath, branch: null }); // the row names no branch
  commitIn(t.wtPath, "v.txt", "v\n", "v");
  pickOnto(repo.main, headOf(t.wtPath));
  git(repo.main, "push", "-q", "origin", "main");
  const landing = landingOf(t.taskDir);
  check(landing.state === "landed" && landing.proof === "rebase", `D11: the landing is computed for the worktree's branch (${JSON.stringify(landing)})`);
}

// ---------------------------------------------------------------- D12 refs and base from files
{
  const repo = makeRepo();
  // origin/HEAD names trunk; trunk lives in packed-refs only
  git(repo.main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  git(repo.main, "push", "-q", "origin", `HEAD:refs/heads/trunk`);
  git(repo.main, "pack-refs", "--all");
  const wt = mkTask(repo, { branch: "wt/d12", checked: true });
  commitIn(wt.wtPath, "z.txt", "z\n", "z");
  const ctx = derive.contextOf(db.getTask(wt.taskId), taskLib.readTaskJson(wt.taskDir));
  check(ctx.base === "trunk", `D12: the base reads trunk from origin/HEAD (${ctx.base})`);
  const landing = landingOf(wt.taskDir);
  check(landing.state === "unlanded", `D12: the worktree's own commit reads unlanded on trunk (${JSON.stringify(landing)})`);

  // warm cache: no git runs
  clearLogs();
  landingOf(wt.taskDir);
  check(gitLines().length === 0, `D12: a warm cache spawns no git (${gitLines().length} lines)`);

  // a worktree's .git is a gitdir file and the refs read through it
  check(derive.gitContextOf(wt.wtPath).gitDir !== derive.gitContextOf(repo.main).gitDir,
    "D12: the worktree's git dir differs from the main checkout's");

  // no origin/HEAD: master in heads (packed) wins the base
  const repo2 = makeRepo();
  git(repo2.main, "branch", "-m", "main", "master");
  git(repo2.main, "push", "-q", "origin", "master");
  git(repo2.main, "remote", "set-head", "origin", "-d");
  git(repo2.main, "pack-refs", "--all");
  fs.rmSync(path.join(repo2.main, ".git", "refs", "remotes", "origin", "HEAD"), { force: true });
  const ctx2 = derive.contextOf(db.getTask(db.taskIdOf(mkTask(repo2, { checked: true }).taskDir)), null);
  check(ctx2.base === "master", `D12: with no origin/HEAD and only master, the base is master (${ctx2.base})`);
}

// ---------------------------------------------------------------- D13 per-fact cache keys
{
  const A = makeRepo();
  const B = makeRepo();
  const ta = mkTask(A, { checked: true });
  landEvent(ta.taskId, headOf(A.main));
  const tb = mkTask(B, { branch: "wt/d13b", checked: true }); // not landed: an open branch
  commitIn(tb.wtPath, "b.txt", "b\n", "b");
  landingOf(ta.taskDir);
  landingOf(tb.taskDir); // warm both

  clearLogs();
  commitIn(A.main, "a2.txt", "a2\n", "a2"); // a new commit in A only
  landingOf(ta.taskDir);
  landingOf(tb.taskDir);
  const inA = gitLines().filter((l) => l.startsWith(A.main));
  const inB = gitLines().filter((l) => l.startsWith(B.main));
  check(gitLines().length > 0 && inA.length === gitLines().length,
    `D13: after a commit in A only A's tree runs git (${gitLines().length} lines, ${inA.length} in A, ${inB.length} in B)`);

  clearLogs();
  landingOf(ta.taskDir);
  landingOf(tb.taskDir);
  check(gitLines().length === 0, `D13: the next read runs no git (${gitLines().length} lines)`);

  // a moved origin/main in B recomputes only B's not-landed landing
  clearLogs();
  execFileSync("git", ["-C", B.main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qam", "origin moves"]);
  git(B.main, "push", "-q", "origin", "main");
  derive.flushFacts();
  derive.resetCache();
  landingOf(ta.taskDir);
  landingOf(tb.taskDir);
  check(gitLines().every((l) => !l.startsWith(A.main)) && gitLines().some((l) => l.startsWith(B.main) || l.startsWith(tb.wtPath)),
    `D13: a moved origin/main in B recomputes only B's landing (${gitLines().length} lines)`);
}

// ---------------------------------------------------------------- D14 an unrelated commit on a shared main checkout
{
  const repo = makeRepo();
  const t1 = mkTask(repo, { checked: true });
  const t2 = mkTask(repo, { checked: true });
  landEvent(t1.taskId, headOf(repo.main));
  landEvent(t2.taskId, headOf(repo.main));
  check(landingOf(t1.taskDir).state === "landed" && landingOf(t2.taskDir).state === "landed", "D14: both tasks read landed on the shared checkout");

  commitIn(repo.main, "shared.txt", "s\n", "shared"); // unpushed
  clearLogs();
  const l1 = landingOf(t1.taskDir);
  const l2 = landingOf(t2.taskDir);
  check(l1.state === "landed" && l1.proof === "push" && l2.state === "landed" && l2.proof === "push",
    `D14: both still read landed/push with an unpushed commit on the checkout (${JSON.stringify(l1)} ${JSON.stringify(l2)})`);
  check(gitLines().every((l) => !/merge-base/.test(l) || !l.includes(repo.main)),
    `D14: no landing git call ran for either landing (${gitLines().length} lines)`);

  // after the cache file is deleted, with that commit still unpushed, both still read landed
  fs.rmSync(derive.factsPath(), { force: true });
  derive.resetCache();
  const l1b = landingOf(t1.taskDir);
  const l2b = landingOf(t2.taskDir);
  check(l1b.state === "landed" && l1b.proof === "push" && l2b.state === "landed" && l2b.proof === "push",
    `D14: with the cache gone both still read landed/push (${JSON.stringify(l1b)} ${JSON.stringify(l2b)})`);
}

// ---------------------------------------------------------------- D15 the commits instant older than the entry
{
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const repo = makeRepo({ initAt: at(180) });
  const t1 = mkTask(repo, { checked: true });
  const row = db.getTask(t1.taskId);
  // one commit 90 minutes back, its committer date fixed
  fs.writeFileSync(path.join(repo.main, "c1.txt"), "c\n");
  git(repo.main, "add", "c1.txt");
  execFileSync("git", ["-C", repo.main, "commit", "-q", "-m", "c1"], { env: { ...process.env, GIT_COMMITTER_DATE: at(90) }, encoding: "utf8" });
  const ctx = derive.contextOf(row, taskLib.readTaskJson(t1.taskDir));
  const head = derive.headSha(ctx.gitCtx);
  derive.commitsSince(ctx.tree, head, at(30)); // the entry warms with a recent instant
  clearLogs();
  const n = derive.commitsSince(ctx.tree, head, at(120)); // an older instant is a miss
  check(n === 1, `D15: the older instant recomputes and counts the commit between (${n})`);
  check(gitLines().some((l) => l.includes("--since=")), `D15: one new git log ran for the older instant (${gitLines().length} lines)`);
}

// ---------------------------------------------------------------- D16 the cache
{
  const repo = makeRepo({ policy: "pr" });
  const t = mkTask(repo, { branch: "wt/d16", checked: true });
  commitIn(t.wtPath, "q.txt", "q\n", "q");
  setGh("[]"); // no merged PR
  const first = landingOf(t.taskDir);
  check(first.state === "unlanded", `D16: the first read derives (${JSON.stringify(first)})`);
  clearLogs();
  const second = landingOf(t.taskDir);
  check(second.state === "unlanded" && gitLines().length === 0 && ghLines().length === 0,
    `D16: a second read with unchanged inputs runs zero git and zero gh (${gitLines().length} git, ${ghLines().length} gh)`);

  // a new checkmark recomputes that task
  taskLib.addPhases({ taskDir: t.taskDir, phases: [{ id: 2, name: "Two", after: [1] }] });
  taskLib.checkPhase({ taskDir: t.taskDir, phaseId: 2 });
  clearLogs();
  const third = landingOf(t.taskDir);
  check(gitLines().length > 0 || ghLines().length > 0, `D16: a new checkmark recomputes the landing (${gitLines().length} git, ${ghLines().length} gh)`);

  // a gh timeout stores unresolved (timeout) and is not retried on the next read
  const repo2 = makeRepo({ policy: "pr" });
  const t2 = mkTask(repo2, { branch: "wt/d16b", checked: true });
  commitIn(t2.wtPath, "r.txt", "r\n", "r");
  process.env.GH_STUB_SLEEP = "1";
  const t0 = Date.now();
  const timedOut = landingOf(t2.taskDir);
  const took = Date.now() - t0;
  check(timedOut.state === "unresolved" && timedOut.reason === "timeout" && took < 11000 && took >= 9000,
    `D16: a gh stub past the timeout yields unresolved (timeout) within 11 s (${JSON.stringify(timedOut)}, ${took} ms)`);
  delete process.env.GH_STUB_SLEEP;
  clearLogs();
  const again = landingOf(t2.taskDir);
  check(again.state === "unresolved" && again.reason === "timeout" && ghLines().length === 0,
    `D16: the stored timeout is not retried on the next read (${JSON.stringify(again)}, ${ghLines().length} gh)`);

  // deleting the cache file recomputes everything the same, apart from the stored timeout
  const before = { a: landingOf(t.taskDir), b: landingOf(t2.taskDir), s: statusOf(t.taskDir) };
  fs.rmSync(derive.factsPath(), { force: true });
  derive.resetCache();
  process.env.GH_STUB_SLEEP = "1";
  const retried = landingOf(t2.taskDir);
  delete process.env.GH_STUB_SLEEP;
  const after = { a: landingOf(t.taskDir), s: statusOf(t.taskDir) };
  check(after.a.state === before.a.state && after.s === before.s,
    `D16: the cache deleted, the landings and status derive the same (${JSON.stringify(before.a)} → ${JSON.stringify(after.a)})`);
  check(retried.state === "unresolved" && retried.reason === "timeout", `D16: the stored timeout is retried once its inputs are asked again (${JSON.stringify(retried)})`);
}

// ---------------------------------------------------------------- D17 no network on routine verbs
{
  const repo = makeRepo({ policy: "pr" });
  const t = mkTask(repo, { branch: "wt/d17" }); // not all checked: no gh
  commitIn(t.wtPath, "n.txt", "n\n", "n");
  clearLogs();
  const env = { ...process.env };
  const aNext = spawnSync("node", [CLI, "next", "--task-dir", t.taskDir, "--repo", repo.main, "--json"], { encoding: "utf8", env, cwd: T });
  const aRead = spawnSync("node", [CLI, "task", "read", "--task-dir", t.taskDir, "--repo", repo.main, "--json"], { encoding: "utf8", env, cwd: T });
  check(aNext.status === 0 && aRead.status === 0, `D17: a next and a task read run on a stale cache (${aNext.status}, ${aRead.status})`);
  check(gitLines().every((l) => !l.includes(" fetch ")), "D17: no routine verb runs git fetch");
  check(ghLines().every((l) => !l.includes("pr list")), "D17: a not-all-checked task asks no gh");

  clearLogs();
  const aCheck = spawnSync("node", [CLI, "task", "check", "--task-dir", t.taskDir, "--phase-id", "1", "--repo", repo.main, "--json"], { encoding: "utf8", env, cwd: T });
  const slowLines = gitLines().filter((l) => /merge-base|cherry|patch-id|rev-list|--format=%H %ct/.test(l));
  check(aCheck.status === 0 && slowLines.length === 0,
    `D17: check_phase derives no slow facts (${aCheck.status}: ${JSON.stringify(slowLines)})`);
}

// ---------------------------------------------------------------- D18 the status words
{
  const repo = makeRepo();
  const t = mkTask(repo, { checked: true });
  const session = require("./lib/session");
  session.register({ session_id: "derive-live", pid: process.pid, cwd: repo.main, agent: "builder", repo_key: repo.key.key, task_dir: t.taskDir });
  const bound = session.list().find((r) => r.session_id === "derive-live");
  check(bound && session.isLive(bound), "D18: the registered session reads live");
  check(derive.taskStatusOf(db.getTask(t.taskId), taskLib.readTaskJson(t.taskDir), { boundLive: true }) === "in_progress",
    "D18: a live bound session and a checked-but-unlanded task read in_progress");
  session.unregister("derive-live");
  check(statusOf(t.taskDir) === "open", `D18: unbound and unlanded reads open (${statusOf(t.taskDir)})`);

  landEvent(t.taskId, headOf(repo.main));
  session.register({ session_id: "derive-live2", pid: process.pid, cwd: repo.main, agent: "builder", repo_key: repo.key.key, task_dir: t.taskDir });
  check(statusOf(t.taskDir, { boundLive: true }) === "done", `D18: all checked and landed with the session live reads done (${statusOf(t.taskDir, { boundLive: true })})`);
  const ls = spawnSync("node", [CLI, "ls", "--json", "--repo", repo.main], { encoding: "utf8", cwd: T });
  const out = JSON.parse(ls.stdout);
  const mine = out.tasks.find((x) => path.basename(x.dir) === path.basename(t.taskDir));
  check(ls.status === 0 && mine && mine.task_status === "done" && mine.live && mine.live.session_id === "derive-live2",
    `D18: the done task reads done with its live session while it stays bound (${JSON.stringify(mine && { status: mine.task_status, live: mine.live })})`);
  session.unregister("derive-live2");

  const empty = mkTask(repo, { phases: [] });
  check(statusOf(empty.taskDir) === "open", `D18: zero phases reads open (${statusOf(empty.taskDir)})`);
}

// ---------------------------------------------------------------- D19 rework after a land
{
  const repo = makeRepo();
  const t = mkTask(repo, { checked: true });
  landEvent(t.taskId, headOf(repo.main));
  check(statusOf(t.taskDir) === "done", "D19: the task starts done");
  taskLib.addPhases({ taskDir: t.taskDir, phases: [{ id: 2, name: "Rework", after: [1] }] });
  check(statusOf(t.taskDir) !== "done", "D19: a rework phase after the land makes it not done");
  const view = taskLib.readTaskJson(t.taskDir);
  const current = derive.currentPhaseOf(view);
  check(current && current.id === 2, `D19: the current phase is the rework (${current && current.id})`);
  taskLib.checkPhase({ taskDir: t.taskDir, phaseId: 2 });
  const head2 = headOf(repo.main);
  commitIn(repo.main, "rw.txt", "rw\n", "rework");
  git(repo.main, "push", "-q", "origin", "main");
  landEvent(t.taskId, git(repo.main, "rev-parse", "origin/main"));
  check(statusOf(t.taskDir) === "done", `D19: after the rework's checkmark and land it reads done again (${statusOf(t.taskDir)})`);
}

// ---------------------------------------------------------------- D20 the session states
{
  const derive2 = derive;
  check(derive2.sessionState({ ended_at: null, pid: process.pid }, { alive: true, zmxLive: false }) === "live", "D20: a live pid reads live");
  check(derive2.sessionState({ ended_at: "2026-10-01T00:00:00Z", pid: process.pid }, { alive: true, zmxLive: true }) === "gone", "D20: an ended_at row reads gone");
  check(derive2.sessionState({ pid: 999999999 }, { alive: false, zmxLive: false }) === "gone", "D20: a dead pid with no zmx reads gone");
  check(derive2.sessionState({ pid: 999999999 }, { alive: false, zmxLive: true }) === "live", "D20: a zmx match keeps it live");
}

// ---------------------------------------------------------------- D22 needs_input freshness
{
  // Fixture shapes from the live tails: turn rows carry top-level timestamps;
  // bookkeeping rows (last-prompt, cost-state) carry none; away summaries are
  // timestamped system rows written during genuine waits.
  const d22 = path.join(T, "d22");
  fs.mkdirSync(d22, { recursive: true });
  const tr = path.join(d22, "t.jsonl");
  const at = "2026-11-07T12:14:10.510Z";
  const atMs = Date.parse(at);
  const lit = { needs_input: { message: "waiting", at }, transcript_path: tr };
  const writeTr = (...entries) => fs.writeFileSync(tr, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  const user = (ts, extra = {}) => ({ type: "user", timestamp: ts, message: { role: "user", content: "x" }, ...extra });

  check(derive.needsInputFresh({ needs_input: { at } }) === true, "D22: a registration with no transcript_path reads fresh");
  check(derive.needsInputFresh({ needs_input: { at }, transcript_path: path.join(d22, "missing.jsonl") }) === true,
    "D22: a transcript that fails to stat reads fresh");

  writeTr(user("2026-11-07T12:13:10.446Z"), { type: "last-prompt" }, { type: "cost-state" });
  fs.utimesSync(tr, new Date(atMs + 3600000), new Date(atMs + 3600000));
  check(derive.needsInputFresh(lit) === true,
    "D22: the pav#307 shape — turns before at, an untimestamped bookkeeping tail, mtime an hour newer — reads fresh");
  check(derive.sessionState(lit, { alive: true, zmxLive: false }) === "needs_input",
    "D22: that waiting row keeps the needs_input state");

  writeTr(user("2026-11-07T12:13:10.446Z"), user(at));
  check(derive.needsInputFresh(lit) === true, "D22: a user row at exactly at (the tie) reads fresh");

  writeTr(user("2026-11-07T12:13:10.446Z"), user("2026-11-07T12:15:10.000Z"));
  check(derive.needsInputFresh(lit) === false, "D22: a user row newer than at flips the row stale");
  check(derive.sessionState(lit, { alive: true, zmxLive: false }) === "live",
    "D22: the stale row falls through sessionState to live");

  writeTr(user("2026-11-07T12:13:10.446Z"),
    { type: "system", timestamp: "2026-11-07T12:16:00.000Z", subtype: "away_summary" });
  check(derive.needsInputFresh(lit) === true,
    "D22: a timestamped away-summary written during the wait reads fresh — only user/assistant rows count");

  writeTr(user("2026-11-07T12:13:10.446Z"), user("2026-11-07T12:15:10.000Z", { isSidechain: true }));
  check(derive.needsInputFresh(lit) === false,
    "D22: a sidechain user row after at still flips the row stale — sidechain is not filtered here");

  writeTr({ type: "last-prompt" }, { type: "cost-state" }, { type: "user", message: { role: "user", content: "no timestamp" } });
  check(derive.needsInputFresh(lit) === true,
    "D22: untimestamped rows of any kind are ignored — no timestamped turn in the file reads fresh");

  const pad = "k".repeat(1100);
  writeTr(user("2026-11-07T12:13:10.446Z"), user("2026-11-07T12:15:10.000Z"),
    ...Array.from({ length: 300 }, () => ({ type: "cost-state", pad })));
  check(derive.needsInputFresh(lit) === true,
    "D22: a bookkeeping run past the 256 KiB bound buries the newer turn — the window reads fresh (the documented miss)");

  writeTr(user("2026-11-07T12:13:10.446Z"));
  fs.appendFileSync(tr, '{"type":"user","timestamp":"2026-11-07T12:15');
  check(derive.needsInputFresh(lit) === true, "D22: a torn trailing line is skipped, never misread");
}

// ---------------------------------------------------------------- D21 reads write nothing
{
  const repo = makeRepo();
  mkTask(repo, {});
  const counts1 = db.counts();
  const max1 = db.maxEventId();
  const ls1 = spawnSync("node", [CLI, "ls", "--json", "--repo", repo.main], { encoding: "utf8", cwd: T });
  const ls2 = spawnSync("node", [CLI, "ls", "--json", "--repo", repo.main], { encoding: "utf8", cwd: T });
  const counts2 = db.counts();
  const max2 = db.maxEventId();
  check(ls1.status === 0 && ls2.status === 0 && JSON.stringify(counts1) === JSON.stringify(counts2) && max1 === max2,
    `D21: two a ls runs leave every table unchanged (${max1} → ${max2})`);
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
