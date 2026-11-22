"use strict";

/**
 * `a land`: put the task's branch on base. Policy, tree, clean tree, fetch and rebase, the
 * owner's acceptance, the named checks, then push (direct) or push and open a PR (pr — a
 * given `body` becomes the PR's description, titled from the branch's first commit subject;
 * without one, gh --fill derives both).
 * A pr land whose tree sits on base with unpushed work rescues it first: the task's
 * t/<NNN-slug> branch is cut at HEAD, base rewound to origin (rescueTaskBranch).
 * It reads no phase `branch` or `commits` and writes no SHA or status; every refusal prints
 * its remedy. AGENTS_LAND=1 is set around git (the git guard honours it).
 * Each check run takes one of the machine-wide test slots (test-slot.js); a check skipped
 * for a recorded pass takes none.
 */

const { spawnSync } = require("child_process");
const { repoKey } = require("./repo");
const { resolvePolicy, writePolicy } = require("./policy");
const { fail } = require("./start");
const db = require("./db");
const taskLib = require("./task");
const { withTestSlot } = require("./test-slot");
const adapter = require("./adapter").forHarness();

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

/** The branch's first commit subject (origin/<base>..HEAD's oldest) — the PR
 * title when a body is given; empty when it cannot be derived. */
function firstSubject(tree, base) {
  const subjects = git(tree, ["log", "--pretty=%s", `origin/${base}..HEAD`]).out.trim().split("\n");
  return (subjects[subjects.length - 1] || "").trim();
}

/**
 * The acceptance hold, pure: under approvals `ask`, every phase checked since
 * the last land event needs the owner's `accept` (or `land_anyway`). A skip
 * never holds (it is a decision, not a checkmark), and a checkmark the
 * migration wrote holds nothing. Returns `{ phases, remedy }` or null.
 */
function landHold(task, decisions, lastLandAt) {
  if (!task.knobs || task.knobs.approvals !== "ask") return null;
  const phases = (task.phases || [])
    .filter((p) => p.checked && !p.skipped)
    .filter((p) => p.checked_by !== "migration")
    .filter((p) => !lastLandAt || (p.checked_at && p.checked_at > lastLandAt))
    .filter((p) => !decisions.some((d) => d.phase_id === p.id && (d.choice === "accept" || d.choice === "land_anyway")))
    .map((p) => p.id);
  if (phases.length === 0) return null;
  return { phases, remedy: "the owner's `decide accept` or `decide land_anyway`, in their words" };
}

function lastLines(text, n) {
  return text.split("\n").slice(-n).join("\n");
}

/** Cut the task's main-checkout branch (t/<NNN-slug>, worktree.js) at HEAD for
 *  a pr land that finds its work on base — the start's own cut predates this
 *  or a hand commit landed there. Moves the checkout onto the branch (created
 *  at HEAD, or the existing ref when it already sits there) and rewinds base
 *  to origin's tip: every local-only commit rides the branch, so the rewind
 *  loses nothing, and the checkout is left where a start would have put it.
 *  Returns the branch name. */
function rescueTaskBranch(base, taskDir, tree) {
  const branch = require("./worktree").mainTaskBranch(taskDir);
  const head = git(tree, ["rev-parse", "HEAD"]).out;
  const exists = git(tree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
  if (exists && git(tree, ["rev-parse", branch]).out !== head) {
    throw refusal("branch_exists", `The task's branch ${branch} already exists at another commit in ${tree}.`, `move or delete it by hand (git branch -D ${branch}), then land again`);
  }
  const cut = git(tree, ["checkout", ...(exists ? [branch] : ["-b", branch])]);
  if (!cut.ok) throw refusal("branch_cut_failed", `could not ${exists ? "check out" : "cut"} ${branch} in ${tree}: ${cut.err}`, `cut it by hand (git checkout -b ${branch}), then land again`);
  const rewound = git(tree, ["branch", "-f", base, `origin/${base}`]);
  if (!rewound.ok) {
    process.stderr.write(`warning: could not rewind ${base} to origin/${base} (${rewound.err.trim().split("\n").join(" ")}); the branch holds the work\n`);
  }
  return branch;
}

/**
 * @param {{taskDir: string, projectDir: string, checks?: string[], policy?: string}} opts
 * `policy` ("pr" | "direct") is recorded for an unlisted repo and ignored for a listed one.
 */
function land({ taskDir, projectDir, checks, policy: policyArg, body }) {
  const key = repoKey(projectDir);
  const task = taskLib.readTaskJson(taskDir);

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
  let branch = git(tree, ["branch", "--show-current"]).out;

  const dirty = git(tree, ["status", "--porcelain", "--untracked-files=no"]).out;
  if (dirty) throw refusal("dirty_tree", `${tree} has uncommitted changes:\n${lastLines(dirty, 20)}`, "commit or stash them, then land again");

  const { contains } = require("./sandbox");
  if (!contains(tree)) {
    throw refusal("outside_sandbox", `The task's tree ${tree} lies outside the sandbox root, so the fetch and the push would touch a real checkout.`, "run land outside a sandbox, or set the sandbox roots around the tree");
  }
  const fetched = git(tree, ["fetch", "origin"], 60000);
  if (!fetched.ok) throw refusal("fetch_failed", `git fetch origin failed in ${tree}: ${fetched.err}`, "fix the remote, then land again");

  if (kind === "pr" && (!branch || branch === base)) {
    const ahead = Number(git(tree, ["rev-list", "--count", `origin/${base}..HEAD`]).out.trim() || "0");
    if (tree !== key.main_root || ahead === 0) {
      throw refusal("no_branch", `The task's tree ${tree} is on ${branch || "no branch"}, so a PR has no branch to open from.`, "`a start <task> --worktree` gives the task a branch");
    }
    branch = rescueTaskBranch(base, taskDir, tree);
  }
  const rebased = git(tree, ["rebase", `origin/${base}`]);
  if (!rebased.ok) {
    const files = git(tree, ["diff", "--name-only", "--diff-filter=U"]).out;
    git(tree, ["rebase", "--abort"]);
    throw refusal("rebase_conflict", `Rebasing onto origin/${base} conflicts in:\n${files || "(unknown files)"}`, `rebase in ${tree} by hand (\`git rebase origin/${base}\`), then land again`);
  }

  const taskId = db.taskIdOf(taskDir);
  const decisions = taskId === null ? [] : db.listDecisions({ taskId });
  const lastLandAt = taskId === null ? null : db.lastEventAt(taskId, "land");
  const hold = landHold(task, decisions, lastLandAt);
  if (hold) throw refusal("not_accepted", `Phases ${hold.phases.join(", ")} are checked but the owner has not accepted them.`, hold.remedy);

  const tree2 = git(tree, ["rev-parse", "HEAD^{tree}"]).out;
  const checkRuns = taskId !== null ? db.listCheckRuns(taskId) : [];
  const ran = [];
  for (const cmd of checks && checks.length > 0 ? checks : DEFAULT_CHECKS) {
    const pass = checkRuns.find((r) => r.command === cmd && r.tree === tree2 && r.exit === 0);
    if (pass) {
      ran.push({ command: cmd, exit: 0, skipped: true, passed_at: pass.at, tree: tree2 });
      continue;
    }
    const { value: r, slot_wait } = withTestSlot({ verb: "land", taskDir }, () => run("zsh", ["-c", cmd], tree, CHECK_TIMEOUT_MS));
    ran.push({ command: cmd, exit: r.status, ...(slot_wait && { slot_wait }) });
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
      const subject = body && body.trim() ? firstSubject(tree, base) : "";
      const made = subject
        ? run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", subject, "--body", body], tree, 30000)
        : run("gh", ["pr", "create", "--base", base, "--head", branch, "--fill"], tree, 30000);
      if (!made.ok) throw refusal("pr_failed", `gh pr create failed: ${made.err}`, "create the PR by hand from the pushed branch, or land again");
      prUrl = made.out.split("\n").pop();
    }
  }

  if (taskId !== null) {
    const loc = db.locate(taskDir);
    const head = git(tree, ["rev-parse", "HEAD"]).out || null;
    db.appendEvent({ kind: "land", repoKey: loc && loc.repoKey, taskId, sessionId: adapter.ownSessionId(), detail: JSON.stringify({ policy: kind, branch, head, pushed: true, pr_url: prUrl }) });
    require("./derive").invalidateTask(taskId);
    require("./db-export").exportTask(taskId);
  }

  let worktreeResult = null;
  if (taskId !== null) {
    try {
      const row = db.getTask(taskId);
      const task = taskLib.readTaskJson(taskDir);
      if (require("./derive").taskStatusOf(row, task) === "done") {
        worktreeResult = taskLib.reapClosedTaskWorktree(key, task, taskDir, "a land's reap");
      }
    } catch {}
  }

  return { landed: true, policy: kind, base, branch, tree, pushed: true, pr_url: prUrl, checks: ran, worktree: worktreeResult };
}

module.exports = { land, landHold };
