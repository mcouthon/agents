#!/usr/bin/env node
"use strict";

// a land: policy, the task's own tree, a clean tree, rebase, acceptance, named checks, push or PR.
// Temp bare origin, a clone, a task worktree; `gh` is a PATH stub.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-"));
  for (const d of ["home", "xdg", "tasks", "sessions", "bin"]) fs.mkdirSync(path.join(t, d));
  fs.mkdirSync(path.join(t, "home", ".claude"));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  fs.writeFileSync(path.join(t, "bin", "gh"), '#!/bin/sh\necho "$@" >> "$GH_LOG"\ncase "$2" in view) [ -n "$GH_VIEW" ] && { echo "$GH_VIEW"; exit 0; }; exit 1;; create) echo https://example.test/pr/1;; esac\n', { mode: 0o755 });
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    GH_LOG: path.join(t, "gh.log"),
    PATH: `${path.join(t, "bin")}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  for (const k of ["CLAUDE_CODE_SESSION_ID", "AGENTS_SESSION_DIR"]) delete process.env[k];
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./lib/db");
const taskLib = require("./lib/task");
const { repoKey } = require("./lib/repo");
const { land } = require("./lib/land");
const { POLICIES_PATH } = require("./lib/policy");
const world = require("./fixture-world");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

db.open({ create: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// the fixture repos live inside the sandbox root (dirname of the tasks root),
// so the fetch and the push the land runs stay inside it
const root = path.join(path.dirname(process.env.AGENTS_TASKS_ROOT), "repos");
fs.mkdirSync(root, { recursive: true });
let counter = 0;

/** A bare origin, a clone with one pushed commit, a task with a worktree branch
 * carrying one commit. `taskBranch` checks the worktree out on the task's own
 * wt/<NNN-slug> branch instead of the plain task-branch name. */
function fixture({ approvals, phases, commitInWorktree = true, taskBranch = false } = {}) {
  const n = ++counter;
  const origin = path.join(root, `origin${n}.git`);
  const main = path.join(root, `main${n}`);
  const wt = path.join(root, `wt${n}`);
  world.clonePair(root, "land", origin, main, (dir) => fs.writeFileSync(path.join(dir, "a.txt"), "a\n"));
  const key = repoKey(main);
  const created = taskLib.createTask({ repo: key, title: `T${n}`, slug: `t${n}`, session_id: "s", phases: phases || [{ id: 1, name: "One" }] });
  const taskId = db.taskIdOf(created.task_dir);
  const branch = taskBranch ? `wt/${path.basename(created.task_dir)}` : "task-branch";
  git(main, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
  if (commitInWorktree) {
    fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "feature");
  }
  db.setTaskWorktree(taskId, { worktreePath: wt, branch });
  if (approvals) db.setTaskKnob(taskId, "approvals", approvals);
  return { origin, main, wt, key, taskDir: created.task_dir, branch, other: () => { const o = path.join(root, `other${n}`); git(root, "clone", "-q", origin, o); return o; } };
}

const attempt = (fn) => { try { return { result: fn() }; } catch (err) { return { err }; } };
const originHead = (fx) => git(fx.origin, "rev-parse", "main");
const setPolicy = (value) => { fs.mkdirSync(path.dirname(POLICIES_PATH), { recursive: true }); fs.writeFileSync(POLICIES_PATH, JSON.stringify(value)); };
const policyFor = (fx, value) => setPolicy({ [fx.key.main_root]: value });

// Direct push: the worktree's HEAD lands on origin/main, an events row is appended, phase fields are never read.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const before = originHead(fx);
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result.pushed && r.result.policy === "direct", `direct push succeeds (${r.err && r.err.message})`);
  check(originHead(fx) !== before && git(fx.origin, "show", "main:feature.txt") === "f", "direct push puts the worktree's commit on origin/main");
  const id = db.taskIdOf(fx.taskDir);
  check(db.lastEventAt(id, "land") !== null, "an events row of kind land is appended");
  const task = taskLib.readTaskJson(fx.taskDir);
  const row = db.getTask(id);
  check(task.phases[0].checked === false && db.checkmarksOf(id).size === 0
    && row.branch === "task-branch" && row.worktree_path === fx.wt, "no checkmark is written and the worktree record is kept as it was");
  const landRow = db.lastLandEvent(id);
  check(landRow && landRow.head === git(fx.origin, "rev-parse", "main"), "the land event carries the pushed head");

// Approvals ask: the hold names only the phases checked since the last land event.
{
  const fx = fixture({ approvals: "ask", phases: [
    { id: 1, name: "One" }, { id: 2, name: "Two" }, { id: 3, name: "Three" },
    { id: 4, name: "Four" }, { id: 5, name: "Five" }, { id: 6, name: "Six" },
  ] });
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  const at = new Date(Date.now() - 7200000).toISOString();
  for (const id of [1, 2, 3]) db.insertCheckmark(taskId, id, "migration", at);
  for (const id of [4, 5]) db.insertDecision({ task_id: taskId, phase_id: id, choice: "skip", quote: "stored status skipped, migrated", recorded_by: "migration", decided_at: at });
  const landAt = new Date(Date.now() - 3600000).toISOString();
  db.appendEvent({ kind: "land", taskId, detail: JSON.stringify({ head: git(fx.origin, "rev-parse", "main"), migrated: true }), sessionId: "migration" });
  const conn = db.open();
  conn.run("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'land'", landAt, taskId);
  db.close();
  db.insertCheckmark(taskId, 6, "builder-session", new Date().toISOString());
  const refused = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(refused.err && refused.err.code === "not_accepted" && /Phases 6/.test(refused.err.message)
    && !/Phases 1/.test(refused.err.message) && !/Phases 4/.test(refused.err.message),
    `the hold names only phase 6, the one checked since the land event (${refused.err && refused.err.message.split("\n")[0]})`);
  db.insertDecision({ task_id: taskId, phase_id: 6, choice: "accept", quote: "go" });
  const ok = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!ok.err && ok.result.pushed, `an accept on the post-land phase lifts the hold (${ok.err && ok.err.message})`);
}
  check(git(fx.main, "log", "-1", "--format=%s") === "feature", "the main checkout on base is fast-forwarded to the pushed commit");
}

// A failing check refuses with the command and a remedy; nothing is pushed.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const before = originHead(fx);
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["echo boom-output; exit 3"] }));
  check(r.err && r.err.code === "check_failed" && /exit 3/.test(r.err.message) && /boom-output/.test(r.err.message) && /Remedy: .+/.test(r.err.message), `a failing check refuses with command output and remedy (${r.err && r.err.message.split("\n")[0]})`);
  check(r.err && r.err.exitCode === 2 && r.err.detail && r.err.detail.remedy, "the refusal carries exit code and detail.remedy for --json");
  check(originHead(fx) === before, "nothing was pushed");
}

// Origin moved on with a conflicting change: the rebase conflicts, is aborted, and the refusal names the file.
{
  const fx = fixture({ commitInWorktree: false });
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "task\n");
  git(fx.wt, "commit", "-qam", "task edit");
  const o = fx.other();
  fs.writeFileSync(path.join(o, "a.txt"), "origin\n");
  git(o, "commit", "-qam", "origin edit");
  git(o, "push", "-q", "origin", "main");
  policyFor(fx, "direct");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(r.err && r.err.code === "rebase_conflict" && /a\.txt/.test(r.err.message) && /Remedy: .*git rebase/.test(r.err.message), `a conflicting rebase refuses naming the file (${r.err && r.err.code})`);
  check(git(fx.wt, "status", "--porcelain", "--untracked-files=no") === "" && !fs.existsSync(path.join(fx.wt, ".git", "rebase-merge")), "the rebase was aborted and the tree is clean");
}

// Origin advances while the checks run: the push is rejected as non_fast_forward with a remedy.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const o = fx.other();
  const race = `cd ${o} && echo r > race.txt && git add . && git commit -qm race && git push -q origin main`;
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: [race] }));
  check(r.err && r.err.code === "non_fast_forward" && /Remedy: land again/.test(r.err.message), `a rejected push refuses as non_fast_forward (${r.err && r.err.code}: ${r.err && r.err.message.split("\n")[0]})`);
}

// An uncommitted change in the tree refuses before anything else.
{
  const fx = fixture();
  policyFor(fx, "direct");
  fs.writeFileSync(path.join(fx.wt, "a.txt"), "dirty\n");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(r.err && r.err.code === "dirty_tree" && /Remedy: commit or stash/.test(r.err.message), `a dirty tree refuses (${r.err && r.err.code})`);
}

// An unlisted repo refuses with the --policy remedy; --policy direct records it and proceeds.
{
  const fx = fixture();
  setPolicy({});
  const refused = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(refused.err && refused.err.code === "policy_unlisted" && /--policy pr\|direct/.test(refused.err.message), `an unlisted repo refuses with the --policy remedy (${refused.err && refused.err.code})`);
  const ok = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"], policy: "direct" }));
  const recorded = JSON.parse(fs.readFileSync(POLICIES_PATH, "utf8"));
  check(!ok.err && ok.result.pushed && recorded[fx.key.main_root] === "direct", `--policy direct records the repo and lands (${ok.err && ok.err.message})`);
}

// Approvals ask: a checked phase with no accept refuses; a land_anyway row lifts it.
{
  const fx = fixture({ approvals: "ask" });
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  db.insertCheckmark(taskId, 1, "builder-session", new Date().toISOString());
  const refused = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(refused.err && refused.err.code === "not_accepted" && /decide accept/.test(refused.err.message) && /land_anyway/.test(refused.err.message), `an unaccepted checked phase refuses naming accept and land_anyway (${refused.err && refused.err.code})`);
  db.insertDecision({ task_id: db.taskIdOf(fx.taskDir), phase_id: 1, choice: "land_anyway", quote: "land it anyway" });
  const ok = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!ok.err && ok.result.pushed, `a land_anyway row lifts the hold (${ok.err && ok.err.message})`);
}

// pr mode: the worktree's branch is pushed and gh is called with --head <branch>.
{
  const fx = fixture();
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  const log = fs.readFileSync(process.env.GH_LOG, "utf8");
  check(!r.err && r.result.pr_url === "https://example.test/pr/1" && r.result.branch === "task-branch", `pr mode opens a PR from the worktree branch (${r.err && r.err.message})`);
  check(/--head task-branch/.test(log) && /--base main/.test(log) && !/bogus-branch/.test(log), "gh pr create is called with --head <worktree branch>, not a phase field");
  check(/--fill/.test(log), "gh pr create defaults to --fill without a body");
}

// pr mode with a body: the PR opens with the given description and a title from
// the branch's first commit subject — gh's --fill never runs.
{
  const fx = fixture();
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  const body = "One-line summary.\n\n- what changed\n- 26/48 failed before, 0/48 after";
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"], body }));
  const log = fs.readFileSync(process.env.GH_LOG, "utf8");
  check(!r.err && r.result.pr_url === "https://example.test/pr/1", `pr mode with a body opens the PR (${r.err && r.err.message})`);
  check(/--title feature/.test(log) && log.includes(`--body ${body}`), "gh pr create carries the body and the first commit subject as the title");
  check(!/--fill/.test(log), "gh pr create is not called with --fill when a body is given");
}

// A blank body falls back to gh's --fill.
{
  const fx = fixture();
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"], body: "  " }));
  const log = fs.readFileSync(process.env.GH_LOG, "utf8");
  check(!r.err && r.result.pr_url === "https://example.test/pr/1", `a blank body still opens the PR (${r.err && r.err.message})`);
  check(/--fill/.test(log), "a blank body falls back to gh --fill");
  check(git(fx.origin, "rev-parse", "task-branch") === git(fx.wt, "rev-parse", "HEAD"), "the branch was pushed to origin");
  check(git(fx.origin, "rev-parse", "main") === git(fx.main, "rev-parse", "origin/main"), "base on origin is untouched");
}

// An already-open PR for the branch is reused; a merged one is not.
{
  const open = '{"url":"https://example.test/pr/7","state":"OPEN"}';
  const merged = '{"url":"https://example.test/pr/7","state":"MERGED"}';
  const landWithView = (view) => {
    const fx = fixture();
    policyFor(fx, "pr");
    fs.writeFileSync(process.env.GH_LOG, "");
    process.env.GH_VIEW = view;
    const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
    delete process.env.GH_VIEW;
    return { r, log: fs.readFileSync(process.env.GH_LOG, "utf8") };
  };
  const reused = landWithView(open);
  check(!reused.r.err && reused.r.result.pr_url === "https://example.test/pr/7" && !/pr create/.test(reused.log), `an open PR is reused without creating one (${reused.r.err && reused.r.err.message})`);
  const fresh = landWithView(merged);
  check(!fresh.r.err && fresh.r.result.pr_url === "https://example.test/pr/1" && /pr create/.test(fresh.log), `a merged PR is replaced by a new one (${fresh.r.err && fresh.r.err.message})`);
}

// The size check: a pr land over 1000 changed lines refuses unless the owner said land anyway.
const commitLines = (fx, file, n) => {
  fs.mkdirSync(path.dirname(path.join(fx.wt, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.wt, file), Array.from({ length: n }, (_, i) => `line ${i}\n`).join(""));
  git(fx.wt, "add", ".");
  git(fx.wt, "commit", "-q", "-m", `add ${file}`);
};
const pushedBranches = (fx) => git(fx.origin, "branch", "--list", "task-branch");

{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  commitLines(fx, "big.txt", 1001);
  fs.writeFileSync(process.env.GH_LOG, "");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  const log = fs.readFileSync(process.env.GH_LOG, "utf8");
  check(r.err && r.err.code === "pr_too_big" && /1001/.test(r.err.message) && /1000/.test(r.err.message), `a 1001-line PR refuses pr_too_big naming the count and the cap (${r.err ? r.err.code : "landed"})`);
  check(/add_phases/.test(r.err.message) && /land_anyway/.test(r.err.message), "the refusal names splitting the group and land_anyway");
  check(pushedBranches(fx) === "" && !/pr create/.test(log), "an oversized PR pushes nothing and opens no PR");
}

{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  commitLines(fx, "big.txt", 1001);
  db.insertDecision({ task_id: db.taskIdOf(fx.taskDir), phase_id: 1, choice: "land_anyway", quote: "land it anyway" });
  const lifted = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!lifted.err && lifted.result.pr_url === "https://example.test/pr/1" && lifted.result.pr_lines === 1001, `a land_anyway lets the oversized PR open (${lifted.err && lifted.err.message})`);
  commitLines(fx, "more.txt", 1);
  const again = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(again.err && again.err.code === "pr_too_big", `the lift covered one land: the next land refuses again (${again.err ? again.err.code : "landed"})`);
}

{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  commitLines(fx, "package-lock.json", 1500);
  commitLines(fx, "gen/out.js", 1500);
  fs.writeFileSync(path.join(fx.wt, ".gitattributes"), "gen/** linguist-generated\n");
  fs.writeFileSync(path.join(fx.wt, "feature.txt"), "f\n");
  git(fx.wt, "add", ".");
  git(fx.wt, "commit", "-q", "-m", "attributes and feature");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result.pr_lines === 2, `lockfiles and linguist-generated files are not counted (${r.err ? r.err.message : r.result.pr_lines})`);
}
{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  commitLines(fx, "web/yarn.lock", 1500);
  commitLines(fx, "gen/out.js", 1500);
  fs.writeFileSync(path.join(fx.wt, ".gitattributes"), "gen/** linguist-generated=true\n");
  fs.writeFileSync(path.join(fx.wt, "feature.txt"), "f\n");
  git(fx.wt, "add", ".");
  git(fx.wt, "commit", "-q", "-m", "attributes and feature");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result.pr_lines === 2, `a linguist-generated=true path and a nested lockfile are not counted (${r.err ? r.err.message : r.result.pr_lines})`);
}

{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "direct");
  commitLines(fx, "big.txt", 1001);
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result.pushed && r.result.pr_lines === null && originHead(fx) === git(fx.wt, "rev-parse", "HEAD"), `a direct land of 1001 lines pushes without a size check (${r.err && r.err.message})`);
}

// Stacked groups: a task whose phases carry two or more PR letters lands each group on its own
// branch <task branch>.<letter>; a group's PR opens once every phase of it is checked.
const threePhases = [{ id: 1, name: "One", pr: "A" }, { id: 2, name: "Two", pr: "A" }, { id: 3, name: "Three", pr: "B" }];
const twoGroups = [{ id: 1, name: "One", pr: "A" }, { id: 2, name: "Two", pr: "B" }];
const checkedFile = (fx, id, lines = 1) => {
  commitLines(fx, `p${id}.txt`, lines);
  taskLib.checkPhase({ taskDir: fx.taskDir, phaseId: id });
};
const landNow = (fx) => attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
const landPhase = (fx, id, lines = 1) => { checkedFile(fx, id, lines); return landNow(fx); };
const ghLog = () => fs.readFileSync(process.env.GH_LOG, "utf8");
const originRef = (fx, ref) => { try { return git(fx.origin, "rev-parse", "--verify", "--quiet", ref); } catch { return ""; } };
const originHas = (fx, ancestor, ref) => attempt(() => git(fx.origin, "merge-base", "--is-ancestor", ancestor, ref)).err === undefined;

{
  const fx = fixture({ commitInWorktree: false, phases: threePhases });
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  const first = landPhase(fx, 1);
  check(!first.err && first.result.pr_url === null && originRef(fx, "task-branch.A") === git(fx.wt, "rev-parse", "HEAD") && !/pr create/.test(ghLog()),
    `stacked: a group's first phase pushes its branch and opens no PR yet (${first.err && first.err.message})`);
  const second = landPhase(fx, 2);
  const groupATip = originRef(fx, "task-branch.A");
  check(!second.err && second.result.pr_url === "https://example.test/pr/1" && /pr create --base main --head task-branch\.A /.test(ghLog()),
    `stacked: the group's last phase opens its PR on base (${second.err && second.err.message})`);
  const third = landPhase(fx, 3);
  check(!third.err && /pr create --base task-branch\.A --head task-branch\.B /.test(ghLog()), `stacked: the next group's PR is based on the group below (${third.err && third.err.message})`);
  check(originRef(fx, "task-branch.A") === groupATip && originRef(fx, "task-branch") === "" && originRef(fx, "task-branch.B") === git(fx.wt, "rev-parse", "HEAD"),
    "stacked: the lower layer stays put, the upper one is pushed, the task branch never is");
  check(third.result && third.result.layers && third.result.layers.map((l) => l.group).join() === "A,B" && third.result.layers[1].base === "task-branch.A", "stacked: the result names the layers, A then B");
}

{
  const fx = fixture({ commitInWorktree: false, phases: twoGroups });
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  checkedFile(fx, 1);
  checkedFile(fx, 2);
  const r = landNow(fx);
  check(r.err && r.err.code === "pr_groups_mixed" && /1, 2/.test(r.err.message) && /A, B/.test(r.err.message) && /add_phases/.test(r.err.message), `a land carrying phases of two groups refuses pr_groups_mixed (${r.err ? r.err.message.split("\n")[0] : "landed"})`);
  check(originRef(fx, "task-branch.A") === "" && originRef(fx, "task-branch.B") === "" && !/pr create/.test(ghLog()), "a mixed land pushes nothing and opens no PR");
}

{
  const fx = fixture({ commitInWorktree: false, phases: twoGroups });
  policyFor(fx, "pr");
  const a = landPhase(fx, 1, 900);
  const b = landPhase(fx, 2, 200);
  check(!a.err && !b.err && b.result.pr_lines === 200, `stacked: the size check counts the layer's own lines, not the task's (${(a.err || b.err) ? (a.err || b.err).message.split("\n")[0] : b.result.pr_lines})`);
}

{
  const fx = fixture({ commitInWorktree: false, phases: twoGroups });
  policyFor(fx, "pr");
  landPhase(fx, 1);
  fs.writeFileSync(process.env.GH_LOG, "");
  process.env.GH_VIEW = '{"url":"https://example.test/pr/1","state":"MERGED"}';
  const b = landPhase(fx, 2);
  delete process.env.GH_VIEW;
  check(!b.err && /pr create --base main --head task-branch\.B /.test(ghLog()), `stacked: a merged lower PR puts the next group's PR on base (${b.err && b.err.message})`);
}

{
  const fx = fixture({ commitInWorktree: false, phases: twoGroups });
  policyFor(fx, "pr");
  landPhase(fx, 1);
  const o = fx.other();
  fs.writeFileSync(path.join(o, "moved.txt"), "m\n");
  git(o, "add", ".");
  git(o, "commit", "-q", "-m", "base moved");
  git(o, "push", "-q", "origin", "main");
  const b = landPhase(fx, 2);
  check(!b.err && originRef(fx, "task-branch.B") === git(fx.wt, "rev-parse", "HEAD") && originHas(fx, "main", "task-branch.A"),
    `stacked: when base moved, the rebased lower layer is pushed too (${b.err && b.err.message})`);
}

{
  const fx = fixture({ commitInWorktree: false, phases: [{ id: 1, name: "One", pr: "A" }, { id: 2, name: "Two", pr: "A" }] });
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  checkedFile(fx, 1);
  checkedFile(fx, 2);
  const r = landNow(fx);
  check(!r.err && r.result.layers === null && originRef(fx, "task-branch") !== "" && originRef(fx, "task-branch.A") === "" && /pr create --base main --head task-branch /.test(ghLog()),
    `one PR letter lands as an ungrouped task: the task branch and one PR (${r.err && r.err.message})`);
}

// pr mode without a branch refuses with the worktree remedy.
{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  db.setTaskWorktree(db.taskIdOf(fx.taskDir), { worktreePath: null, branch: null });
  git(fx.main, "worktree", "remove", "--force", fx.wt);
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(r.err && r.err.code === "no_branch" && /a start <task> --worktree/.test(r.err.message), `a PR from the base branch refuses with the worktree remedy (${r.err && r.err.code})`);
}

// The pr rescue: the work sits on base in the main checkout (a pre-branch
// start) — land cuts the task's t/<NNN-slug> at HEAD, moves the checkout onto
// it, rewinds base to origin (the commits live on the branch, nothing lost)
// and opens the PR from the branch.
{
  const fx = fixture({ commitInWorktree: false });
  db.setTaskWorktree(db.taskIdOf(fx.taskDir), { worktreePath: null, branch: null });
  git(fx.main, "worktree", "remove", "--force", fx.wt);
  fs.writeFileSync(path.join(fx.main, "feature.txt"), "f\n");
  git(fx.main, "add", "feature.txt");
  git(fx.main, "commit", "-q", "-m", "feature on base");
  policyFor(fx, "pr");
  fs.writeFileSync(process.env.GH_LOG, "");
  const tb = `t/${path.basename(fx.taskDir)}`;
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result.branch === tb && r.result.pr_url === "https://example.test/pr/1",
    `the rescue cuts the task branch and opens the PR (${r.err && r.err.message})`);
  check(git(fx.main, "branch", "--show-current") === tb, "the checkout moved onto the task's branch");
  check(git(fx.main, "rev-parse", "main") === git(fx.main, "rev-parse", "origin/main"),
    "base is rewound to origin — the commits live on the branch");
  check(git(fx.origin, "show", `${tb}:feature.txt`) === "f", "the branch carries the work to origin");
  check(/--head t\//.test(fs.readFileSync(process.env.GH_LOG, "utf8")), "gh pr create is called with --head t/<NNN-slug>");
}

// The rescue refuses when the task's t/ branch already exists at another
// commit — the owner sorts the ref by hand, the remedy says how.
{
  const fx = fixture({ commitInWorktree: false });
  db.setTaskWorktree(db.taskIdOf(fx.taskDir), { worktreePath: null, branch: null });
  git(fx.main, "worktree", "remove", "--force", fx.wt);
  const tb = `t/${path.basename(fx.taskDir)}`;
  git(fx.main, "checkout", "-q", "-b", tb);
  git(fx.main, "commit", "-q", "--allow-empty", "-m", "old work");
  git(fx.main, "checkout", "-q", "main");
  fs.writeFileSync(path.join(fx.main, "feature.txt"), "f\n");
  git(fx.main, "add", "feature.txt");
  git(fx.main, "commit", "-q", "-m", "feature on base");
  policyFor(fx, "pr");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(r.err && r.err.code === "branch_exists" && /already exists at another commit/.test(r.err.message)
    && /Remedy: .*git branch -D/.test(r.err.message), `a t/ branch at another commit refuses the rescue (${r.err && r.err.code})`);
  let pushedRef = null;
  try { pushedRef = git(fx.origin, "rev-parse", "--verify", "--quiet", tb); } catch {}
  check(git(fx.main, "branch", "--show-current") === "main" && pushedRef === null,
    "nothing moved and nothing was pushed");
}

// LC9: a recorded check_run pass for the same command on the same tree is skipped.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const marker = path.join(fx.wt, ".lc9-marker");
  const cmd = `touch ${marker}`;
  try { fs.unlinkSync(marker); } catch {}
  db.appendEvent({ kind: "check_run", taskId, detail: JSON.stringify({ command: cmd, tree: treeHash, exit: 0 }) });
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: [cmd] }));
  check(!r.err && r.result.pushed, `LC9: land succeeds with a recorded pass (${r.err && r.err.message})`);
  check(!fs.existsSync(marker), `LC9: the marker is absent (check was skipped)`);
  const row = r.result && r.result.checks.find((c) => c.command === cmd);
  check(row && row.skipped === true && row.exit === 0 && typeof row.passed_at === "string" && row.tree === treeHash,
    `LC9: the result row is {command, exit: 0, skipped: true, passed_at, tree}`);
}

// LC10: a different tree (one commit added after the a check) re-runs the check.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const marker = path.join(fx.wt, ".lc10-marker");
  const cmd = `touch ${marker}`;
  try { fs.unlinkSync(marker); } catch {}
  db.appendEvent({ kind: "check_run", taskId, detail: JSON.stringify({ command: cmd, tree: treeHash, exit: 0 }) });
  fs.writeFileSync(path.join(fx.wt, "extra.txt"), "e\n");
  git(fx.wt, "add", ".");
  git(fx.wt, "commit", "-qm", "extra");
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: [cmd] }));
  check(!r.err && r.result.pushed, `LC10: land succeeds with a new commit (${r.err && r.err.message})`);
  check(fs.existsSync(marker), `LC10: the marker exists (check ran on the new tree)`);
}

// LC11: a recorded fail does not skip — the check runs.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  const marker = path.join(fx.wt, ".lc11-marker");
  const cmd = `touch ${marker}`;
  try { fs.unlinkSync(marker); } catch {}
  db.appendEvent({ kind: "check_run", taskId, detail: JSON.stringify({ command: cmd, tree: treeHash, exit: 1 }) });
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: [cmd] }));
  check(!r.err && r.result.pushed, `LC11: land runs the check and proceeds (${r.err && r.err.message})`);
  check(fs.existsSync(marker), `LC11: the marker exists (check ran despite the recorded fail)`);
}

// LC12 (guard): checks: [] with a recorded pass for the default check skips it.
{
  const fx = fixture();
  policyFor(fx, "direct");
  const taskId = db.taskIdOf(fx.taskDir);
  const treeHash = git(fx.wt, "rev-parse", "HEAD^{tree}");
  db.appendEvent({ kind: "check_run", taskId, detail: JSON.stringify({ command: "zsh scripts/check.sh", tree: treeHash, exit: 0 }) });
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main }));
  check(!r.err && r.result.pushed, `LC12: land succeeds with a recorded default pass (${r.err && r.err.message})`);
  const row = r.result && r.result.checks.find((c) => c.command === "zsh scripts/check.sh");
  check(row && row.skipped === true && row.exit === 0, `LC12: the default check was skipped (${row ? JSON.stringify(row) : "no row"})`);
}

// LC13: a direct land reaps the task's worktree when the task reads done, and
// the reap runs the repo's teardown, reported in the worktree field.
{
  const fx = fixture({ phases: [{ id: 1, name: "One" }] });
  policyFor(fx, "direct");
  taskLib.checkPhase({ taskDir: fx.taskDir, phaseId: 1 });
  const wtReal = fs.realpathSync(fx.wt);
  const marker = path.join(path.dirname(root), "lc13-teardown.marker");
  const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
  cfg.repos = { [fx.key.key]: { teardown: `pwd > ${marker}` } };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err, `LC13: land succeeds (${r.err && r.err.message})`);
  check(r.result && r.result.worktree, `LC13: the result carries a worktree field (${JSON.stringify(r.result && r.result.worktree)})`);
  check(r.result && r.result.worktree && r.result.worktree.removed === true, `LC13: the worktree is reaped (${JSON.stringify(r.result && r.result.worktree)})`);
  check(!fs.existsSync(fx.wt), "LC13: the worktree directory is gone after the reap");
  check(r.result && r.result.worktree && r.result.worktree.teardown && r.result.worktree.teardown.exit_code === 0, `LC13: the reaped worktree field carries the teardown run (${JSON.stringify(r.result && r.result.worktree)})`);
  check(fs.readFileSync(marker, "utf8").trim() === wtReal, "LC13: the reap runs the teardown inside the worktree");
  const lc13Receipt = path.join(process.env.HOME, ".agents", "worktrees", path.basename(fx.main), ".removed", `${path.basename(fx.wt)}.json`);
  check(fs.existsSync(lc13Receipt), `LC13: the land's reap writes a receipt (${lc13Receipt})`);
  const lc13Rc = JSON.parse(fs.readFileSync(lc13Receipt, "utf8"));
  check(lc13Rc.kind === "worktree_removed" && lc13Rc.reason === "a land's reap" && lc13Rc.path === wtReal
    && lc13Rc.branch === fx.branch && lc13Rc.repo === fs.realpathSync(fx.main) && lc13Rc.actor === "unattributed",
    `LC13: the receipt names the land's reap (${JSON.stringify(lc13Rc)})`);
}

// LC13b: a teardown that did not complete holds the reaped worktree — the land itself still succeeds.
{
  const fx = fixture({ phases: [{ id: 1, name: "One" }] });
  policyFor(fx, "direct");
  taskLib.checkPhase({ taskDir: fx.taskDir, phaseId: 1 });
  const cfg = JSON.parse(fs.readFileSync(process.env.AGENTS_CONFIG_PATH, "utf8"));
  cfg.repos = { [fx.key.key]: { teardown: "sleep 2" } };
  fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify(cfg));
  const savedKnob = process.env.AGENTS_TEARDOWN_TIMEOUT_MS;
  process.env.AGENTS_TEARDOWN_TIMEOUT_MS = "300";
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  if (savedKnob === undefined) delete process.env.AGENTS_TEARDOWN_TIMEOUT_MS; else process.env.AGENTS_TEARDOWN_TIMEOUT_MS = savedKnob;
  check(!r.err && r.result && r.result.landed === true, `LC13b: the land succeeds past the held reap (${r.err && r.err.message})`);
  check(r.result && r.result.worktree && r.result.worktree.removed === false && /did not complete/.test(r.result.worktree.reason || ""), `LC13b: the reap is held with the teardown reason (${JSON.stringify(r.result && r.result.worktree)})`);
  check(r.result && r.result.worktree && r.result.worktree.teardown && r.result.worktree.teardown.exit_code === null, `LC13b: the held reap carries the incomplete run (${JSON.stringify(r.result && r.result.worktree)})`);
  // No survival row: worktree T22's held-reap leg owns the outcome; this
  // door's delta is the land result's report of it above.
}

// LC13c: with the task's own wt/<NNN-slug> branch the land's reap reports the
// keep — the task is done, not closed — and the land still succeeds.
{
  const fx = fixture({ phases: [{ id: 1, name: "One" }], taskBranch: true });
  policyFor(fx, "direct");
  taskLib.checkPhase({ taskDir: fx.taskDir, phaseId: 1 });
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err && r.result && r.result.landed === true, `LC13c: the land succeeds past the kept reap (${r.err && r.err.message})`);
  check(r.result && r.result.worktree && r.result.worktree.removed === false
    && r.result.worktree.reason === `task ${path.basename(fx.taskDir)} is done, not closed`,
    `LC13c: the reap reports the keep with the reason (${JSON.stringify(r.result && r.result.worktree)})`);
  check(r.result && r.result.worktree && r.result.worktree.branch_deleted === false, `LC13c: the branch is not deleted (${JSON.stringify(r.result && r.result.worktree)})`);
  // No survival row: worktree T22's kept-close legs own the outcome.
}

// LC14: a direct land does not reap the worktree when the task is not done.
{
  const fx = fixture({ phases: [{ id: 1, name: "One" }] });
  policyFor(fx, "direct");
  // Do not check the phase — the task is not done
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(!r.err, `LC14: land succeeds (${r.err && r.err.message})`);
  check(r.result && r.result.worktree === null, `LC14: the result carries no worktree reap (${JSON.stringify(r.result && r.result.worktree)})`);
  check(fs.existsSync(fx.wt), "LC14: the worktree directory stays");
}

// LC15: a land's test run takes a machine-wide test slot; a recorded pass takes none.
{
  const { spawn } = require("child_process");
  const pool = path.join(os.homedir(), ".agents", "test-slots");
  const oneSlot = () => fs.writeFileSync(process.env.AGENTS_CONFIG_PATH, JSON.stringify({ tests: { slots: 1 } }));
  const holdTheSlot = () => {
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    fs.mkdirSync(path.join(pool, "0.lock"), { recursive: true });
    fs.writeFileSync(path.join(pool, "0.lock", "holder"), JSON.stringify({ session_id: "s", pid: sleeper.pid, task: "other/held-task", verb: "check", since: new Date().toISOString() }));
    return sleeper;
  };
  const release = (sleeper) => { sleeper.kill(); fs.rmSync(pool, { recursive: true, force: true }); };
  oneSlot();

  const busy = holdTheSlot();
  process.env.AGENTS_SLOT_WAIT_MS = "300";
  const fx = fixture();
  policyFor(fx, "direct");
  const before = originHead(fx);
  const ranMarker = path.join(fx.wt, ".lc15-ran");
  const refused = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: [`touch ${ranMarker}`] }));
  check(refused.err && refused.err.code === "test_slot_busy" && refused.err.exitCode === 2 && /Remedy: .*tests\.slots/.test(refused.err.message) && /held-task/.test(refused.err.message),
    `LC15: a land whose check cannot get a slot refuses test_slot_busy naming the holder (${refused.err && refused.err.message.split("\n")[0]})`);
  check(!fs.existsSync(ranMarker) && originHead(fx) === before, "LC15: the check never ran and nothing was pushed");

  const fx2 = fixture();
  policyFor(fx2, "direct");
  const cmd = `touch ${path.join(fx2.wt, ".lc15-skip")}`;
  db.appendEvent({ kind: "check_run", taskId: db.taskIdOf(fx2.taskDir), detail: JSON.stringify({ command: cmd, tree: git(fx2.wt, "rev-parse", "HEAD^{tree}"), exit: 0 }) });
  const skipped = attempt(() => land({ taskDir: fx2.taskDir, projectDir: fx2.main, checks: [cmd] }));
  check(!skipped.err && skipped.result.checks[0].skipped === true && !("slot_wait" in skipped.result.checks[0]),
    `LC15: a matching recorded pass lands past a full pool without taking a slot (${skipped.err && skipped.err.message})`);
  release(busy);

  const fx3 = fixture();
  policyFor(fx3, "direct");
  const waitingFor = holdTheSlot();
  const freer = spawn("sh", ["-c", `sleep 1; rm -rf '${path.join(pool, "0.lock")}'`], { stdio: "ignore" });
  process.env.AGENTS_SLOT_WAIT_MS = "20000";
  const waited = attempt(() => land({ taskDir: fx3.taskDir, projectDir: fx3.main, checks: ["true"] }));
  check(!waited.err && /^waited .* for a slot held by task other\/held-task$/.test(waited.result.checks[0].slot_wait || ""),
    `LC15: a check that waited reports slot_wait in its result row (${waited.err ? waited.err.message : JSON.stringify(waited.result.checks[0])})`);
  freer.kill();
  release(waitingFor);
  delete process.env.AGENTS_SLOT_WAIT_MS;
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
