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
  fs.writeFileSync(path.join(t, "bin", "gh"), '#!/bin/sh\necho "$@" >> "$GH_LOG"\ncase "$2" in view) exit 1;; create) echo https://example.test/pr/1;; esac\n', { mode: 0o755 });
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

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

db.open({ create: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-land-repos-"));
let counter = 0;

/** A bare origin, a clone with one pushed commit, a task with a worktree branch carrying one commit. */
function fixture({ approvals, phases, commitInWorktree = true } = {}) {
  const n = ++counter;
  const origin = path.join(root, `origin${n}.git`);
  const main = path.join(root, `main${n}`);
  const wt = path.join(root, `wt${n}`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  fs.writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "task-branch", wt, "origin/main");
  if (commitInWorktree) {
    fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "feature");
  }
  const key = repoKey(main);
  const created = taskLib.createTask({ repo: key, title: `T${n}`, slug: `t${n}`, session_id: "s", phases: phases || [{ id: 1, name: "One" }] });
  const task = taskLib.readTaskJson(created.task_dir);
  task.worktree_path = wt;
  task.phases.forEach((p) => { p.branch = "bogus-branch"; p.commits = ["deadbeef"]; });
  if (approvals) task.knobs = { ...task.knobs, approvals };
  taskLib.writeTaskJson(created.task_dir, task);
  return { origin, main, wt, key, taskDir: created.task_dir, other: () => { const o = path.join(root, `other${n}`); git(root, "clone", "-q", origin, o); return o; } };
}

const attempt = (fn) => { try { return { result: fn() }; } catch (err) { return { err }; } };
const originHead = (fx) => git(fx.origin, "rev-parse", "main");
const setPolicy = (value) => fs.writeFileSync(POLICIES_PATH, JSON.stringify(value));
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
  check(task.phases[0].branch === "bogus-branch" && task.phases[0].status === "not_started" && !task.phases[0].landed_sha, "no phase status, SHA or branch is written, and the bogus phase fields changed nothing");
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
  const task = taskLib.readTaskJson(fx.taskDir);
  task.phases[0].status = "done";
  taskLib.writeTaskJson(fx.taskDir, task);
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
  check(git(fx.origin, "rev-parse", "task-branch") === git(fx.wt, "rev-parse", "HEAD"), "the branch was pushed to origin");
  check(git(fx.origin, "rev-parse", "main") === git(fx.main, "rev-parse", "origin/main"), "base on origin is untouched");
}

// pr mode without a branch refuses with the worktree remedy.
{
  const fx = fixture({ commitInWorktree: false });
  policyFor(fx, "pr");
  const task = taskLib.readTaskJson(fx.taskDir);
  task.worktree_path = "";
  taskLib.writeTaskJson(fx.taskDir, task);
  git(fx.main, "worktree", "remove", "--force", fx.wt);
  const r = attempt(() => land({ taskDir: fx.taskDir, projectDir: fx.main, checks: ["true"] }));
  check(r.err && r.err.code === "no_branch" && /a start <task> --worktree/.test(r.err.message), `a PR from the base branch refuses with the worktree remedy (${r.err && r.err.code})`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
