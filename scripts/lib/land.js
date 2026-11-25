"use strict";

/**
 * `a land`: put the task's branch on base. Policy, tree, clean tree, fetch and rebase, the
 * owner's acceptance, the named checks, then push (direct) or push and open a PR (pr — a
 * given `body` becomes the PR's description, titled from the branch's first commit subject;
 * without one, gh --fill derives both).
 * A pr land whose tree sits on base with unpushed work rescues it first: the task's
 * t/<NNN-slug> branch is cut at HEAD, base rewound to origin (rescueTaskBranch).
 * A pr land over 1000 changed lines refuses unless the owner said land anyway.
 * A pr task whose phases carry two or more PR letters lands each group on its own branch
 * <task branch>.<letter> (stack.js), each PR based on the one below and opened once its group
 * is checked; the land event records the layers. Before the rebase, a layer whose PR merged is
 * marked merged (never pushed again, the rebase leaves its commits behind and the PR above is
 * retargeted to base), and a layer GitHub changed since the last push refuses stack_diverged.
 * A stacked task is landed once every layer's PR is merged (derive.js).
 * A `fixup!` commit aimed at a layer's commit folds into that layer on the next land; one that
 * clashes with a layer above refuses rebase_conflict naming the fix; one whose target is in no
 * layer's commits and no merged layer refuses fixup_unplaced before the rebase.
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
const stackLib = require("./stack");
const adapter = require("./adapter").forHarness();

const DEFAULT_CHECKS = ["zsh scripts/check.sh"];
const CHECK_TIMEOUT_MS = 850000;
const PR_LINE_CAP = 1000;
const LOCKFILES = ["package-lock.json","npm-shrinkwrap.json","yarn.lock","pnpm-lock.yaml","Cargo.lock","poetry.lock","uv.lock","Pipfile.lock","Gemfile.lock","composer.lock","go.sum"];
const UNCOUNTED = [
  ":(exclude,attr:linguist-generated)",
  ":(exclude,attr:linguist-generated=true)",
  ...LOCKFILES.map((name) => `:(exclude,glob)**/${name}`),
];

function refusal(code, message, remedy) {
  return fail(2, `${message}\nRemedy: ${remedy}`, code, { remedy });
}

function run(cmd, args, cwd, timeout = 120000, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTS_LAND: "1", ...env },
  });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: ((r.stderr || "") + (r.error ? r.error.message : "")).trim(), status: r.status, raw: `${r.stdout || ""}${r.stderr || ""}` };
}

const git = (tree, args, timeout) => run("git", args, tree, timeout);

/** The PR's own commits: what HEAD holds beyond `from` (origin/<base>, or the layer below). */
const prRange = (from) => `${from}..HEAD`;

/** Added + deleted lines of the PR's diff, lockfiles and linguist-generated files left out
 * (a binary file counts 0). */
function prLines(tree, from) {
  const diff = git(tree, ["diff", "--numstat", prRange(from), "--", ".", ...UNCOUNTED]);
  if (!diff.ok) throw refusal("pr_size_failed", `git diff --numstat failed in ${tree}: ${diff.err}`, "fix git (attr pathspecs need git 2.13+), then land again");
  return diff.out.split("\n").filter(Boolean).reduce((sum, line) => {
    const [added, deleted] = line.split("\t");
    return sum + (Number(added) || 0) + (Number(deleted) || 0);
  }, 0);
}

/** A land_anyway decided since the last land lifts the cap for one land. */
const sizeLifted = (decisions, lastLandAt) =>
  decisions.some((d) => d.choice === "land_anyway" && (!lastLandAt || d.decided_at > lastLandAt));

function checkPrSize(tree, from, decisions, lastLandAt) {
  const lines = prLines(tree, from);
  if (lines > PR_LINE_CAP && !sizeLifted(decisions, lastLandAt)) {
    throw refusal("pr_too_big", `The PR's diff is ${lines} changed lines (added + deleted; lockfiles and linguist-generated files left out), over the ${PR_LINE_CAP} cap.`, "split the group: give the newest phases a new PR letter (`add_phases` with `pr`) so they land as their own PR; mark generated paths `linguist-generated` in .gitattributes; or the owner's `decide land_anyway`, in their words");
  }
  return lines;
}

/** The range's first commit subject (its oldest) — the PR title when a body
 * is given; empty when it cannot be derived. */
function firstSubject(tree, range) {
  const subjects = git(tree, ["log", "--pretty=%s", range]).out.trim().split("\n");
  return (subjects[subjects.length - 1] || "").trim();
}

/** A stacked rebase moves every layer ref along and folds `fixup!` commits into their layers; once
 * a lower PR merged it takes only the commits after the merged layer (`stack.onto`), which the
 * squash or merge on base replaced. */
function rebaseArgs(base, stack) {
  if (!stack) return ["rebase", `origin/${base}`];
  if (stack.onto) return ["rebase", "--update-refs", "--autosquash", "--onto", `origin/${base}`, stack.onto];
  return ["rebase", "--update-refs", "--autosquash", `origin/${base}`];
}

const PLAIN_COMMIT_WAY = (tree, sha) => `make it a plain commit so it lands on the top PR — \`git commit --amend -m "<a title for the fix>"\` when it is the newest commit, else in ${tree}: \`git rebase --onto ${sha}~1 ${sha}\`, \`git cherry-pick -n ${sha}\`, \`git commit -m "<a title>"\` — then land again`;

/** A fixup! commit names its target by hash: the target must be among the commits being landed
 * or inside a merged layer (the fix then stays a commit on the top PR); a stale hash would
 * otherwise reach a PR as a commit titled "fixup! <hash>". */
function refuseUnplacedFixups(tree, base, stack) {
  const range = `${stack.onto || `origin/${base}`}..HEAD`;
  const landing = new Set(git(tree, ["rev-list", range]).out.split("\n"));
  const mergedTips = stack.layers.filter((l) => l.merged).flatMap((l) => [l.tip, tipOf(tree, `refs/heads/${l.ref}`)]);
  const placed = (sha) => landing.has(sha) || mergedTips.some((tip) => tip && git(tree, ["merge-base", "--is-ancestor", sha, tip]).ok);
  const lines = git(tree, ["log", "--format=%h %s", range]).out.split("\n");
  const unplaced = lines.map((line) => line.match(/^(\S+) (fixup! ([0-9a-f]{40}))$/)).filter((m) => m && !placed(m[3]));
  if (unplaced.length === 0) return;
  const [, short, subject] = unplaced[0];
  throw refusal("fixup_unplaced", `The fix ${short} (${subject}) names a commit that is in none of the PRs being landed (a rewrite changed its hash).`, `re-target it at a commit in the PR's current range (\`git commit --amend -m "fixup! <full sha from git log>"\` when it is the newest commit), or reword it to a plain commit so it lands on the top PR, then land again`);
}

function rebaseOnBase(tree, base, stack) {
  const args = rebaseArgs(base, stack);
  if (run("git", args, tree, undefined, { GIT_EDITOR: "true" }).ok) return;
  const files = git(tree, ["diff", "--name-only", "--diff-filter=U"]).out;
  const [sha = "", subject = ""] = git(tree, ["log", "-1", "--format=%h%x00%s", "REBASE_HEAD"]).out.split("\0");
  git(tree, ["rebase", "--abort"]);
  const message = `Rebasing onto origin/${base} conflicts in:\n${files || "(unknown files)"}`;
  if (subject.startsWith("fixup!")) {
    throw refusal("rebase_conflict", `${message}\nThe fix ${sha} (${subject}) does not fit inside its PR: a PR above changed the same lines.`, PLAIN_COMMIT_WAY(tree, sha));
  }
  throw refusal("rebase_conflict", message, `rebase in ${tree} by hand (\`git ${args.join(" ")}\`), then land again`);
}

function refusePush(r) {
  throw refusal("non_fast_forward", `Push rejected: ${r.err}`, "land again (it fetches and rebases first)");
}

function pushBranch(tree, ...branches) {
  const pushed = git(tree, ["push", "--force-with-lease", "-u", "origin", ...branches], 60000);
  if (!pushed.ok) refusePush(pushed);
}

/** The branch's PR as `{ url, state }`, or null when gh has none. */
function prOf(tree, head) {
  const view = run("gh", ["pr", "view", head, "--json", "url,state,baseRefName"], tree, 30000);
  if (!view.ok) return null;
  try { return JSON.parse(view.out); } catch { return null; }
}

/** The URL of head's open PR — reused when one exists, else created. */
function ensurePr(tree, { base, head, body, range = prRange(`origin/${base}`) }) {
  const open = prOf(tree, head);
  if (open && open.state === "OPEN") return open.url;
  const subject = body && body.trim() ? firstSubject(tree, range) : "";
  const made = subject
    ? run("gh", ["pr", "create", "--base", base, "--head", head, "--title", subject, "--body", body], tree, 30000)
    : run("gh", ["pr", "create", "--base", base, "--head", head, "--fill"], tree, 30000);
  if (!made.ok) throw refusal("pr_failed", `gh pr create failed: ${made.err}`, "create the PR by hand from the pushed branch, or land again");
  return made.out.split("\n").pop();
}

/**
 * The acceptance hold, pure: under approvals `ask`, every phase checked since
 * the last land event needs the owner's `accept` (or `land_anyway`). A skip
 * never holds (it is a decision, not a checkmark), and a checkmark the
 * migration wrote holds nothing. Returns `{ phases, remedy }` or null.
 */
function landHold(task, decisions, lastLandAt) {
  if (!task.knobs || task.knobs.approvals !== "ask") return null;
  const phases = stackLib.landedPhases(task.phases || [], lastLandAt)
    .filter((p) => !decisions.some((d) => d.phase_id === p.id && (d.choice === "accept" || d.choice === "land_anyway")))
    .map((p) => p.id);
  if (phases.length === 0) return null;
  return { phases, remedy: "the owner's `decide accept` or `decide land_anyway`, in their words" };
}

const tipOf = (tree, ref) => git(tree, ["rev-parse", "--verify", "--quiet", ref]).out;

const isAncestor = (tree, commit, of) => commit !== "" && git(tree, ["merge-base", "--is-ancestor", commit, of]).ok;

/** Refs of the recorded layers whose PR GitHub reports merged; a PR gh cannot read refuses. */
function mergedRefsOf(tree, layers) {
  const asked = layers.filter((l) => l.pr_url && !l.merged);
  const merged = asked.filter((l) => {
    const pr = prOf(tree, l.ref);
    if (!pr) throw refusal("pr_failed", `could not read the state of ${l.ref}'s PR (${l.pr_url})`, "check `gh auth status`, then land again");
    return pr.state === "MERGED";
  });
  return new Set(merged.map((l) => l.ref));
}

/** The topmost merged layer's commit still in the task branch, the rebase's upstream; null when
 * nothing merged or an earlier land already restacked. */
function ontoOf(tree, topMerged) {
  if (!topMerged) return null;
  const candidates = [tipOf(tree, `refs/heads/${topMerged.ref}`), topMerged.tip];
  return candidates.find((c) => c && isAncestor(tree, c, "HEAD")) || null;
}

/** An open layer GitHub changed since this tool last pushed it, or whose commits a rewrite moved
 * out from under it, refuses: pushing would overwrite theirs or cut the layer at the wrong commit. */
function refuseDiverged(tree, layer) {
  const origin = tipOf(tree, `refs/remotes/origin/${layer.ref}`);
  const local = tipOf(tree, `refs/heads/${layer.ref}`);
  const short = (sha) => sha.slice(0, 7);
  if (origin && origin !== local && origin !== layer.tip) {
    throw refusal("stack_diverged", `${layer.ref} on origin (${short(origin)}) holds commits this land did not push (the local branch is at ${short(local) || "nothing"}).`, `keep their commits under the layers above: in ${tree} run \`git rebase --update-refs --onto origin/${layer.ref} ${layer.ref}\` then \`git branch -f ${layer.ref} origin/${layer.ref}\`, then land again`);
  }
  if (!isAncestor(tree, local, "HEAD")) {
    throw refusal("stack_diverged", `${layer.ref} is not part of the task branch any more: ${local ? "a rewrite moved its commits" : "the branch is missing"}.`, `point it at its last commit in the task branch (\`git branch -f ${layer.ref} <commit>\`; origin has it at ${short(origin) || "nothing"}), then land again`);
  }
}

/** The stack after a lower PR merged: merged layers marked, the lowest open one on base, the
 * rebase's upstream. Refuses a layer that changed on GitHub or a merge out of order. */
function restack(tree, stack, base) {
  const restacked = stackLib.restacked(stack.layers, mergedRefsOf(tree, stack.layers), base);
  if (restacked.outOfOrder) {
    const { upper, lower } = restacked.outOfOrder;
    throw refusal("stack_diverged", `The PR of ${upper} merged before ${lower} below it; ${lower}'s branch on GitHub now holds both.`, `merge ${lower}'s PR on GitHub, then land again`);
  }
  restacked.layers.filter((l) => !l.merged).forEach((l) => refuseDiverged(tree, l));
  return { ...stack, layers: restacked.layers, retarget: restacked.retarget, onto: ontoOf(tree, restacked.topMerged) };
}

function refuseMixed({ reason, phases, groups, unchecked }) {
  const regroup = "give the phases checked since the last land one PR letter (`add_phases` with `pr`)";
  if (reason === "merged" && phases.length === 0) {
    throw refusal("pr_groups_mixed", `Every group's PR is merged; there is nothing left to land.`, "the stack is fully merged; to land more, add phases with a new PR letter (`add_phases` with `pr`), check them, then land");
  }
  if (reason === "merged") {
    throw refusal("pr_groups_mixed", `Group ${groups[0]}'s PR is merged; it takes no more commits.`, `${regroup} that no merged group holds, then land again`);
  }
  if (reason === "incomplete") {
    throw refusal("pr_groups_mixed", `Group ${groups[0]} is not complete (phases ${unchecked.join(", ")} unchecked); group ${groups[1]} is cut only on a complete group.`, `${regroup}, or check phases ${unchecked.join(", ")} and land them first, then land again`);
  }
  throw refusal("pr_groups_mixed", `This land carries phases ${phases.join(", ")} of groups ${groups.join(", ")}; one land carries one group's phases.`, `${regroup}, then land again`);
}

/** The layer this land carries; a land that cannot go on one refuses. */
function landingLayer(stack, task, branch, base, lastLandAt) {
  const next = stackLib.nextLayer(task.phases || [], stack.groups, stack.layers, branch, base, lastLandAt);
  if (next.mixed) refuseMixed(next.mixed);
  return next.layer;
}

/** Where the layer's range starts: base, or the layer below it. */
const layerFrom = (layer, base) => layer.base === base ? `origin/${base}` : `refs/heads/${layer.base}`;

/** GitHub usually moves the PR above a deleted merged branch onto base itself: an edit is made
 * only when the PR is still on another base, and a closed PR cannot be edited. */
function retargetPr(tree, ref, base) {
  const pr = prOf(tree, ref);
  if (pr && pr.baseRefName === base) return;
  if (pr && pr.state === "CLOSED") throw refusal("pr_closed", `${ref}'s PR (${pr.url}) is closed, so it cannot move onto ${base}.`, `reopen the PR on GitHub, then land again`);
  const edited = run("gh", ["pr", "edit", ref, "--base", base], tree, 30000);
  if (!edited.ok) throw refusal("pr_failed", `gh pr edit ${ref} --base ${base} failed: ${edited.err}`, `run \`gh pr edit ${ref} --base ${base}\` by hand, then land again`);
}

/** Cut the layer at HEAD, push it and every open layer the rebase moved (a merged one is never
 * pushed), move the PR above a merged layer onto base, then open the PR of each complete group
 * that has none. Returns the landed layer's PR url and the recorded layers, each open one with
 * the `tip` this land left it at. */
function landStack(tree, stack, layer, task, base, body) {
  git(tree, ["branch", "-f", layer.ref, "HEAD"]);
  const layers = stack.layers.some((l) => l.group === layer.group)
    ? stack.layers.map((l) => l.group === layer.group ? layer : l)
    : [...stack.layers, layer];
  const moved = layers.filter((l) => !l.merged && tipOf(tree, `refs/heads/${l.ref}`) !== tipOf(tree, `refs/remotes/origin/${l.ref}`));
  if (moved.length > 0) pushBranch(tree, ...moved.map((l) => l.ref));
  const retargeted = layers.find((l) => l.ref === stack.retarget);
  if (retargeted && retargeted.pr_url) retargetPr(tree, retargeted.ref, base);
  const withPr = (l) => {
    if (l.pr_url || !stackLib.groupComplete(task.phases || [], stack.groups, l.group)) return l;
    const range = `${layerFrom(l, base)}..refs/heads/${l.ref}`;
    return { ...l, pr_url: ensurePr(tree, { base: l.base, head: l.ref, body: l === layer ? body : undefined, range }) };
  };
  const recorded = layers.map((l) => (l.merged ? l : { ...withPr(l), tip: tipOf(tree, `refs/heads/${l.ref}`) }));
  return { prUrl: recorded.find((l) => l.group === layer.group).pr_url, layers: recorded };
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
  const taskId = db.taskIdOf(taskDir);
  const lastLand = taskId === null ? null : db.lastLandEvent(taskId);
  const decisions = taskId === null ? [] : db.listDecisions({ taskId });
  const lastLandAt = taskId === null ? null : db.lastEventAt(taskId, "land");
  const recordedStack = kind === "pr" ? stackLib.stackOf(task.phases || [], lastLand) : null;
  const stack = recordedStack && restack(tree, recordedStack, base);
  const layer = stack ? landingLayer(stack, task, branch, base, lastLandAt) : null;
  if (stack) refuseUnplacedFixups(tree, base, stack);
  rebaseOnBase(tree, base, stack);

  const hold = landHold(task, decisions, lastLandAt);
  if (hold) throw refusal("not_accepted", `Phases ${hold.phases.join(", ")} are checked but the owner has not accepted them.`, hold.remedy);

  const sizeFrom = layer ? layerFrom(layer, base) : `origin/${base}`;
  const prLineCount = kind === "pr" ? checkPrSize(tree, sizeFrom, decisions, lastLandAt) : null;

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
  let layers = null;
  if (kind === "direct") {
    const pushed = git(tree, ["push", "origin", `HEAD:${base}`], 60000);
    if (!pushed.ok) refusePush(pushed);
    if (tree !== key.main_root) {
      const onBase = git(key.main_root, ["branch", "--show-current"]).out === base;
      const clean = git(key.main_root, ["status", "--porcelain", "--untracked-files=no"]).out === "";
      if (onBase && clean) git(key.main_root, ["merge", "--ff-only", `origin/${base}`]);
    }
  } else if (stack) {
    ({ prUrl, layers } = landStack(tree, stack, layer, task, base, body));
  } else {
    pushBranch(tree, branch);
    prUrl = ensurePr(tree, { base, head: branch, body });
  }

  if (taskId !== null) {
    const loc = db.locate(taskDir);
    const head = git(tree, ["rev-parse", "HEAD"]).out || null;
    db.appendEvent({ kind: "land", repoKey: loc && loc.repoKey, taskId, sessionId: adapter.ownSessionId(), detail: JSON.stringify({ policy: kind, branch, head, pushed: true, pr_url: prUrl, layers }) });
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

  return { landed: true, policy: kind, base, branch, tree, pushed: true, pr_url: prUrl, layers, pr_lines: prLineCount, checks: ran, worktree: worktreeResult };
}

module.exports = { land, landHold };
