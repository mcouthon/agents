"use strict";

/**
 * Agent-type guard table (D13) and git-guard policy logic.
 * One table maps each agent_type to which guards are active and how they
 * behave. The hook dispatcher (hook.js) consults this table.
 */

// Guard table: per agent_type, which hooks are active and their behaviour.
// gitGuard values: "deny_all_git" | "write_guard" | "builder_git" | true | false
// manifestGuard: "deny_all" | "task_dir" | "manifest_intersect" | false
// spawnGuard: array of allowed subagent types, or null (none), or true (any)
// stop: name of the stop hook(s) to run
const GUARD_TABLE = {
  conductor: {
    prime: true,
    spawnGuard: true,
    reportParser: true,
    checkpoint: true,
    gitGuard: "deny_all_git",
    manifestGuard: "deny_all",
    qualityGate: false,
    writeGuard: false,
    stop: ["conductor-stop"],
  },
  courier: {
    prime: "policy",
    spawnGuard: ["vision", "oracle"],
    reportParser: false,
    checkpoint: true,
    gitGuard: true,
    manifestGuard: false,
    qualityGate: true,
    writeGuard: false,
    stop: ["quality-gate", "courier-stop"],
  },
  explorer: {
    prime: "ctx",
    spawnGuard: ["researcher", "oracle"],
    reportParser: false,
    checkpoint: false,
    gitGuard: "write_guard",
    manifestGuard: "task_dir",
    qualityGate: false,
    writeGuard: true,
    stop: [],
  },
  builder: {
    prime: "ctx",
    spawnGuard: ["oracle"],
    reportParser: false,
    checkpoint: false,
    gitGuard: "builder_git",
    manifestGuard: "manifest_intersect",
    qualityGate: true,
    writeGuard: false,
    stop: ["quality-gate"],
  },
  reviewer: {
    prime: "ctx",
    spawnGuard: null,
    reportParser: false,
    checkpoint: false,
    gitGuard: "write_guard",
    manifestGuard: "deny_all",
    qualityGate: false,
    writeGuard: true,
    stop: [],
  },
  committer: {
    prime: "ctx",
    spawnGuard: null,
    reportParser: "store_plan",
    checkpoint: false,
    gitGuard: "deny_all_git",
    manifestGuard: "deny_all",
    qualityGate: false,
    writeGuard: true,
    stop: [],
  },
};

// External (unbound) sessions: git-guard policy only.
const EXTERNAL_GUARDS = {
  prime: false,
  spawnGuard: false,
  reportParser: false,
  checkpoint: false,
  gitGuard: true,
  manifestGuard: false,
  qualityGate: false,
  writeGuard: false,
  stop: [],
};

function guardsFor(agentType) {
  if (agentType && GUARD_TABLE[agentType]) return GUARD_TABLE[agentType];
  return EXTERNAL_GUARDS;
}

// git subcommands that write (denied for conductor/committer and read-only agents).
const GIT_WRITE_SUBCOMMANDS = new Set([
  "commit", "push", "merge", "rebase", "reset", "stash", "add", "checkout",
  "branch", "tag", "cherry-pick", "revert", "mv", "rm", "init", "clone",
  "fetch", "pull", "bisect", "worktree",
]);

// Builder may not: commit, push, checkout, stash, rebase, merge.
const BUILDER_DENIED = new Set([
  "commit", "push", "checkout", "stash", "rebase", "merge",
]);

// Operations unlocked by AGENTS_LAND=1 (D30).
const LAND_ALLOWED = new Set([
  "push", "merge", "rebase", "checkout", "branch",
]);

// Operations denied for ALL agents, always.
function alwaysDenied(classified) {
  if (classified.hasNoVerify) return "--no-verify is not allowed";
  if (classified.hasForce && classified.subcommand === "push") return "force push is not allowed";
  if (classified.subcommand === "add" && classified.hasForce) return "git add -A/-u/. is not allowed";
  if (classified.subcommand === "commit" && classified.hasForce) return "git commit -a is not allowed";
  if (classified.hasDashC) return "git -C is not allowed (run from the repo root)";
  return null;
}

/**
 * Evaluate git/gh policy for a single invocation.
 * @param {object} inv - { program, argv, env } from gitcmd.findGitInvocations
 * @param {object} opts - { agentType, policy, initiator, agentsLand (bool), landLockHeld (bool) }
 * @returns {{ decision: "allow"|"deny"|"ask"|"rewrite", reason?: string, rewrite?: object }}
 */
function evalGitPolicy(inv, opts) {
  const { agentType, policy, initiator, agentsLand, landLockHeld } = opts;
  const { classifyGit } = require("./gitcmd");
  const classified = classifyGit(inv);

  // Rules that apply to ALL agents, always.
  const denied = alwaysDenied(classified);
  if (denied) return { decision: "deny", reason: denied };

  const pushMode = (policy && policy.push) || "ask";
  const base = (policy && policy.base) || "main";

  // gh commands
  if (inv.program === "gh") {
    const sub = classified.subcommand;
    // gh pr create under direct → deny
    if (sub === "pr" && inv.argv[1] === "create") {
      if (pushMode === "direct") {
        return { decision: "deny", reason: "gh pr create is not allowed in a direct-push repo" };
      }
      // draft-only when initiator is mission/intake
      if (initiator === "mission" || initiator === "intake") {
        return { decision: "rewrite", reason: "adding --draft (unattended)", rewrite: { addArgs: ["--draft"] } };
      }
      return { decision: "allow" };
    }
    // gh pr ready / gh pr merge denied for mission/intake
    if ((sub === "pr" && (inv.argv[1] === "ready" || inv.argv[1] === "merge")) &&
        (initiator === "mission" || initiator === "intake")) {
      return { decision: "deny", reason: `gh pr ${inv.argv[1]} is not allowed for unattended sessions` };
    }
    return { decision: "allow" };
  }

  // git commands
  const sub = classified.subcommand;

  // D30: AGENTS_LAND allow-list — checked before agent-specific denies so that
  // `a land` (which sets AGENTS_LAND=1 in its own process env + holds the land
  // lock) can push-to-base/merge/rebase/checkout/branch-delete despite the
  // agent's normal git deny. Every other rule still applies (checked above).
  if (agentsLand && landLockHeld && LAND_ALLOWED.has(sub)) {
    return { decision: "allow" };
  }

  // Agent-specific git policy.
  const gitGuard = guardsFor(agentType).gitGuard;

  if (gitGuard === "deny_all_git" && GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return { decision: "deny", reason: `agent ${agentType} may not run git ${sub}` };
  }
  if (gitGuard === "write_guard" && GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return { decision: "deny", reason: `agent ${agentType} has read-only git access (git ${sub} denied)` };
  }
  if (gitGuard === "builder_git" && BUILDER_DENIED.has(sub)) {
    return { decision: "deny", reason: `builder may not run git ${sub}` };
  }

  // push to base under push: pr → deny
  if (sub === "push") {
    const refSpec = classified.pushRefSpec.join(" ");
    const remote = classified.pushRemote;
    const pushesToBase = refSpec === base || refSpec === `refs/heads/${base}` ||
      refSpec.includes(`:${base}`) || refSpec === base ||
      (remote && refSpec === `${base}:${base}`);
    if (pushesToBase && pushMode === "pr") {
      // AGENTS_LAND allow-list: push-to-base unlocked only with process env + land lock.
      if (agentsLand && landLockHeld) {
        return { decision: "allow" };
      }
      return { decision: "deny", reason: `push to base (${base}) is not allowed in a pr-push repo` };
    }
    if (pushesToBase && pushMode === "direct") {
      if (agentsLand && landLockHeld) {
        return { decision: "allow" };
      }
      return { decision: "allow" };
    }
    if (pushMode === "ask" && !agentsLand) {
      return { decision: "ask", reason: "push policy is 'ask' — confirm with the user" };
    }
  }

  // gh pr create under direct already handled. For git push of a branch (not base)
  // under pr mode, allow (it's pushing a feature branch).
  if (sub === "push" && pushMode === "direct" && !agentsLand) {
    // direct repos: pushing a non-base branch is allowed; base push handled above.
    return { decision: "allow" };
  }

  return { decision: "allow" };
}

/**
 * Evaluate all git/gh invocations in a command string.
 * Returns the most restrictive decision (deny > ask > rewrite > allow).
 * @param {string} command
 * @param {object} opts - { agentType, policy, initiator, agentsLand, landLockHeld }
 * @returns {{ decision: string, reason?: string, invocations?: object[] }}
 */
function evalCommand(command, opts) {
  const { findGitInvocations } = require("./gitcmd");
  const invs = findGitInvocations(command);
  if (invs.length === 0) return { decision: "allow" };

  let worstDecision = "allow";
  let worstReason = "";
  for (const inv of invs) {
    // Env-prefix assignments in the command string never grant (D30).
    // The guard reads its own process env (opts.agentsLand), not the command.
    const result = evalGitPolicy(inv, opts);
    if (result.decision === "deny") {
      return { decision: "deny", reason: result.reason, invocations: invs };
    }
    if (result.decision === "ask" && worstDecision === "allow") {
      worstDecision = "ask";
      worstReason = result.reason;
    }
    if (result.decision === "rewrite" && worstDecision === "allow") {
      worstDecision = "rewrite";
      worstReason = result.reason;
    }
  }
  return { decision: worstDecision, reason: worstReason, invocations: invs };
}

module.exports = {
  GUARD_TABLE,
  EXTERNAL_GUARDS,
  guardsFor,
  evalGitPolicy,
  evalCommand,
  alwaysDenied,
  GIT_WRITE_SUBCOMMANDS,
  BUILDER_DENIED,
  LAND_ALLOWED,
};
