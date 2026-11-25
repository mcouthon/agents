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
 * is checked; the land event records the layers.
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

function run(cmd, args, cwd, timeout = 120000) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTS_LAND: "1" },
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

function rebaseOnBase(tree, base, updateRefs) {
  const rebased = git(tree, ["rebase", ...(updateRefs ? ["--update-refs"] : []), `origin/${base}`]);
  if (rebased.ok) return;
  const files = git(tree, ["diff", "--name-only", "--diff-filter=U"]).out;
  git(tree, ["rebase", "--abort"]);
  throw refusal("rebase_conflict", `Rebasing onto origin/${base} conflicts in:\n${files || "(unknown files)"}`, `rebase in ${tree} by hand (\`git rebase${updateRefs ? " --update-refs" : ""} origin/${base}\`), then land again`);
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
  const view = run("gh", ["pr", "view", head, "--json", "url,state"], tree, 30000);
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

/** The stacked state — `{ groups, layers }` — or null for today's one-branch land: the task
 * has fewer than two PR letters, or its last land already opened one PR from the task branch. */
function stackOf(task, lastLand) {
  const groups = stackLib.groupsOf(task.phases || []);
  if (!groups || (lastLand && !lastLand.layers)) return null;
  return { groups, layers: (lastLand && lastLand.layers) || [] };
}

const isMerged = (pr) => Boolean(pr) && pr.state === "MERGED";

/** The layer this land carries: the recorded one, or a new one cut on the top layer — on base
 * when that layer's PR is merged. */
function landingLayer(tree, stack, task, branch, base, lastLandAt) {
  const landing = stackLib.landingGroup(task.phases || [], stack.groups, stack.layers, lastLandAt);
  if (landing.mixed) {
    throw refusal("pr_groups_mixed", `This land carries phases ${landing.mixed.phases.join(", ")} of groups ${landing.mixed.groups.join(", ")}; one land carries one group's phases.`, "give the phases checked since the last land one PR letter (`add_phases` with `pr`), then land again");
  }
  const recorded = stack.layers.find((l) => l.group === landing.group);
  if (recorded) return recorded;
  const top = stack.layers[stack.layers.length - 1];
  const stackedOnTop = top && !isMerged(prOf(tree, top.ref));
  return { group: landing.group, ref: stackLib.layerRef(branch, landing.group), base: stackedOnTop ? top.ref : base, pr_url: null };
}

/** Where the layer's range starts: base, or the layer below it. */
const layerFrom = (layer, base) => layer.base === base ? `origin/${base}` : `refs/heads/${layer.base}`;

const tipOf = (tree, ref) => git(tree, ["rev-parse", "--verify", "--quiet", ref]).out;

/** Cut the layer at HEAD, push it and every layer the rebase moved, then open the PR of each
 * complete group that has none. Returns the landed layer's PR url and the recorded layers. */
function landStack(tree, stack, layer, task, base, body) {
  git(tree, ["branch", "-f", layer.ref, "HEAD"]);
  const layers = stack.layers.some((l) => l.group === layer.group)
    ? stack.layers.map((l) => l.group === layer.group ? layer : l)
    : [...stack.layers, layer];
  const moved = layers.filter((l) => tipOf(tree, `refs/heads/${l.ref}`) !== tipOf(tree, `refs/remotes/origin/${l.ref}`));
  if (moved.length > 0) pushBranch(tree, ...moved.map((l) => l.ref));
  const recorded = layers.map((l) => {
    if (l.pr_url || !stackLib.groupComplete(task.phases || [], stack.groups, l.group)) return l;
    const range = `${layerFrom(l, base)}..refs/heads/${l.ref}`;
    return { ...l, pr_url: ensurePr(tree, { base: l.base, head: l.ref, body: l === layer ? body : undefined, range }) };
  });
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
  const stack = kind === "pr" ? stackOf(task, lastLand) : null;
  rebaseOnBase(tree, base, Boolean(stack));

  const decisions = taskId === null ? [] : db.listDecisions({ taskId });
  const lastLandAt = taskId === null ? null : db.lastEventAt(taskId, "land");
  const hold = landHold(task, decisions, lastLandAt);
  if (hold) throw refusal("not_accepted", `Phases ${hold.phases.join(", ")} are checked but the owner has not accepted them.`, hold.remedy);

  const layer = stack ? landingLayer(tree, stack, task, branch, base, lastLandAt) : null;
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
