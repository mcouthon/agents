"use strict";

/**
 * `a land`: put the task's branch on base. Policy, tree, clean tree, fetch and rebase, the
 * owner's acceptance, the named checks, then push (direct) or push and open a PR (pr).
 * It reads no phase `branch` or `commits` and writes no SHA or status; every refusal prints
 * its remedy. AGENTS_LAND=1 is set around git (the git guard honours it).
 */

const { spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy, writePolicy } = require("./policy");
const { fail } = require("./start");
const db = require("./db");
const taskLib = require("./task");

const DEFAULT_CHECKS = ["zsh scripts/check.sh"];
const CHECK_TIMEOUT_MS = 850000;

function refusal(code, message, remedy) {
  return fail(2, `${message}\nRemedy: ${remedy}`, code, { remedy });
}

function run(cmd, args, cwd, timeout = 120000) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTS_LAND: "1" },
  });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: ((r.stderr || "") + (r.error ? r.error.message : "")).trim(), status: r.status, raw: `${r.stdout || ""}${r.stderr || ""}` };
}

const git = (tree, args, timeout) => run("git", args, tree, timeout);

/**
 * The acceptance hold, pure: under approvals `ask`, every checked phase needs the owner's
 * `accept` (or `land_anyway`). Returns `{ phases, remedy }` or null.
 */
function landHold(task, decisions) {
  if (!task.knobs || task.knobs.approvals !== "ask") return null;
  const phases = (task.phases || [])
    .filter((p) => (p.status === "committed" || p.status === "done"))
    .filter((p) => !decisions.some((d) => d.phase_id === p.id && (d.choice === "accept" || d.choice === "land_anyway")))
    .map((p) => p.id);
  if (phases.length === 0) return null;
  return { phases, remedy: "the owner's `decide accept` or `decide land_anyway`, in their words" };
}

function lastLines(text, n) {
  return text.split("\n").slice(-n).join("\n");
}

/**
 * @param {{taskDir: string, projectDir: string, checks?: string[], policy?: string}} opts
 * `policy` ("pr" | "direct") is recorded for an unlisted repo and ignored for a listed one.
 */
function land({ taskDir, projectDir, checks, policy: policyArg }) {
  const key = repoKey(projectDir);
  const task = taskLib.readTaskJson(taskDir);
  if (!task) throw refusal("no_task", `No task.json at ${taskDir}.`, "pass the task dir `a start` printed");

  let kind;
  const listed = resolvePolicy(key.main_root);
  if (listed.source === "unlisted") {
    if (policyArg !== "pr" && policyArg !== "direct") {
      throw refusal("policy_unlisted", `${key.main_root} has no landing policy.`, "land again with policy pr (push the branch and open a PR) or policy direct (push to base): `a land --policy pr|direct`");
    }
    writePolicy(key.main_root, policyArg);
    kind = policyArg;
  } else {
    kind = listed.push === "pr" ? "pr" : "direct";
  }
  const base = listed.base || key.base;

  const tree = require("./worktree").taskWorktreeOf(key, task, taskDir) || key.main_root;
  const branch = git(tree, ["branch", "--show-current"]).out;
  if (kind === "pr" && (!branch || branch === base)) {
    throw refusal("no_branch", `The task's tree ${tree} is on ${branch || "no branch"}, so a PR has no branch to open from.`, "`a start <task> --worktree` gives the task a branch");
  }

  const dirty = git(tree, ["status", "--porcelain", "--untracked-files=no"]).out;
  if (dirty) throw refusal("dirty_tree", `${tree} has uncommitted changes:\n${lastLines(dirty, 20)}`, "commit or stash them, then land again");

  const fetched = git(tree, ["fetch", "origin"], 60000);
  if (!fetched.ok) throw refusal("fetch_failed", `git fetch origin failed in ${tree}: ${fetched.err}`, "fix the remote, then land again");
  const rebased = git(tree, ["rebase", `origin/${base}`]);
  if (!rebased.ok) {
    const files = git(tree, ["diff", "--name-only", "--diff-filter=U"]).out;
    git(tree, ["rebase", "--abort"]);
    throw refusal("rebase_conflict", `Rebasing onto origin/${base} conflicts in:\n${files || "(unknown files)"}`, `rebase in ${tree} by hand (\`git rebase origin/${base}\`), then land again`);
  }

  const taskId = db.enabled() ? db.taskIdOf(taskDir) : null;
  const decisions = taskId === null ? [] : db.listDecisions({ taskId });
  const hold = landHold(task, decisions);
  if (hold) throw refusal("not_accepted", `Phases ${hold.phases.join(", ")} are checked but the owner has not accepted them.`, hold.remedy);

  const ran = [];
  for (const cmd of checks && checks.length > 0 ? checks : DEFAULT_CHECKS) {
    const r = run("zsh", ["-c", cmd], tree, CHECK_TIMEOUT_MS);
    ran.push({ command: cmd, exit: r.status });
    if (!r.ok) {
      throw refusal("check_failed", `Check \`${cmd}\` failed (exit ${r.status}) in ${tree}:\n${lastLines(r.raw.trim(), 60)}`, "fix it, then land again");
    }
  }

  let prUrl = null;
  const rejected = (r) => refusal("non_fast_forward", `Push rejected: ${r.err}`, "land again (it fetches and rebases first)");
  if (kind === "direct") {
    const pushed = git(tree, ["push", "origin", `HEAD:${base}`], 60000);
    if (!pushed.ok) throw rejected(pushed);
    if (tree !== key.main_root) {
      const onBase = git(key.main_root, ["branch", "--show-current"]).out === base;
      const clean = git(key.main_root, ["status", "--porcelain", "--untracked-files=no"]).out === "";
      if (onBase && clean) git(key.main_root, ["merge", "--ff-only", `origin/${base}`]);
    }
  } else {
    const pushed = git(tree, ["push", "--force-with-lease", "-u", "origin", branch], 60000);
    if (!pushed.ok) throw rejected(pushed);
    const view = run("gh", ["pr", "view", branch, "--json", "url,state"], tree, 30000);
    let open = null;
    if (view.ok) {
      try { open = JSON.parse(view.out); } catch { open = null; }
    }
    if (open && open.state === "OPEN") {
      prUrl = open.url;
    } else {
      const made = run("gh", ["pr", "create", "--base", base, "--head", branch, "--fill"], tree, 30000);
      if (!made.ok) throw refusal("pr_failed", `gh pr create failed: ${made.err}`, "create the PR by hand from the pushed branch, or land again");
      prUrl = made.out.split("\n").pop();
    }
  }

  if (taskId !== null) {
    const loc = db.locate(taskDir);
    db.appendEvent({ kind: "land", repoKey: loc && loc.repoKey, taskId, sessionId: process.env.CLAUDE_CODE_SESSION_ID, detail: JSON.stringify({ policy: kind, branch, pushed: true, pr_url: prUrl }) });
  }
  return { landed: true, policy: kind, base, branch, tree, pushed: true, pr_url: prUrl, checks: ran };
}

module.exports = { land, landHold };
