"use strict";

/**
 * Hook dispatcher: reads the hook payload, resolves the session binding, and
 * routes to the per-hook handler. Guards fail closed with a reason (or warn
 * under enforcement: warn); injectors fail open; unbound sessions no-op.
 *
 * Each hook is a shell stub `exec a hook <name>`; this module is what `a hook`
 * calls.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { guardsFor, evalCommand, isMachineOwnedBasename, machineOwnedDenyReason, detectMachineOwnedWrite, isHookCodePath, hookCodeDenyReason } = require("./guards");
const { scanCommand, getCoaching } = require("./writeguard");

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bound session from AGENTS_SESSION_DIR/registration.json.
 * Normalises agent_type to lowercase (D13: GUARD_TABLE keys are lowercase;
 * registration may store any case).
 * @returns {{ task_dir: string|null, agent_type: string|null, session_id: string|null, initiator: string|null }}
 */
function resolveSession() {
  const dir = process.env.AGENTS_SESSION_DIR;
  if (!dir) return { task_dir: null, agent_type: null, session_id: null, initiator: null };
  const regPath = path.join(dir, "registration.json");
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
    return {
      task_dir: reg.task_dir || null,
      agent_type: reg.agent ? reg.agent.toLowerCase() : null,
      session_id: reg.session_id || null,
      initiator: reg.initiator || null,
    };
  } catch {
    return { task_dir: null, agent_type: null, session_id: null, initiator: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTaskJson(taskDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  } catch {
    return null;
  }
}

function currentPhase(task) {
  if (!task || !task.phases) return null;
  // The first non-done, non-failed, non-skipped phase.
  return task.phases.find(
    (p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped"
  ) || null;
}

/**
 * Extract the last fenced ```json block from a message.
 * Handles prose around the block, multiple blocks, and invalid JSON.
 */
function extractJsonReport(message) {
  if (!message || typeof message !== "string") {
    return { valid: false, reason: "no message" };
  }
  const blocks = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(message)) !== null) {
    blocks.push(m[1].trim());
  }
  if (blocks.length === 0) {
    return { valid: false, reason: "no JSON code block found in the report" };
  }
  const last = blocks[blocks.length - 1];
  try {
    return { valid: true, report: JSON.parse(last) };
  } catch (err) {
    return { valid: false, reason: `invalid JSON in report block: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Hook output helpers
// ---------------------------------------------------------------------------

function allow() {
  return { exitCode: 0, output: null };
}

function denyPreToolUse(reason) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    },
  };
}

function askPreToolUse(reason) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    },
  };
}

function rewriteInput(toolInput, overrides) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { ...toolInput, ...overrides },
      },
    },
  };
}

function inject(context) {
  return {
    exitCode: 0,
    output: { hookSpecificOutput: { additionalContext: context } },
  };
}

function blockStop(reason) {
  // D13/D43: write the reason to stderr so it is visible in the terminal,
  // not just in the JSON systemMessage (which Claude Code reports as
  // "No stderr output" when stderr is empty).
  try { process.stderr.write(reason + "\n"); } catch {}
  // D47(5): append a one-line entry to the hook log so `a doctor` can
  // count blocks per session.
  appendHookLog(reason);
  return { exitCode: 2, output: { systemMessage: reason } };
}

/**
 * Append a one-line block record to ~/.agents/logs/hooks.log (D47(5)).
 * Format: ISO-timestamp \t session_id \t hook_name \t reason_summary
 */
function appendHookLog(reason) {
  try {
    const logDir = path.join(os.homedir(), ".agents", "logs");
    const logPath = path.join(logDir, "hooks.log");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const sid = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
    // Derive hook name from the call stack (the calling handler).
    const caller = (new Error().stack || "").split("\n")[3] || "";
    const hookName = (caller.match(/handle(\w+)/) || [])[1] || "unknown";
    const reasonSummary = reason.split("\n")[0].slice(0, 200);
    const line = `${new Date().toISOString()}\t${sid}\t${hookName}\t${reasonSummary}\n`;
    fs.appendFileSync(logPath, line);
  } catch {}
}

/**
 * Build a block reason that includes the fill-in JSON skeleton (D47(2)).
 * @param {string} baseReason - the original error reason
 * @param {string} schemaName - the schema name (builder, explorer, reviewer, committer)
 * @returns {string} the enhanced reason with the skeleton
 */
function blockReasonWithSkeleton(baseReason, schemaName) {
  try {
    const { renderSkeleton } = require("./report");
    const skeleton = renderSkeleton(schemaName);
    if (!skeleton) return baseReason;
    return baseReason + "\n\nPaste this block at the end of your message, filled in:\n\n```json\n" + skeleton + "\n```";
  } catch {
    return baseReason;
  }
}

/**
 * Return an allow-with-warning result (D47(2)): the second evaluation of a
 * failing Stop/SubagentStop payload passes and records a warning via
 * additionalContext, instead of blocking again.
 */
function allowWithWarning(hookName, reason) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        additionalContext: `${hookName} (warning, already blocked this turn): ${reason}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * prime: inject `a next --json` as additionalContext (≤ 2 KB) + lease touch.
 * Injector → fail open (never blocks).
 */
function handlePrime(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const task = readTaskJson(ctx.taskDir);
    if (!task) return allow();
    const policy = require("./policy").resolvePolicy(ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)));
    const next = require("./next").computeNext(task, {
      projectDir: ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)),
      policy,
      taskDir: ctx.taskDir,
    });
    const lines = [];
    lines.push(`Step: ${next.step}`);
    if (next.how && next.how.tool) {
      lines.push(`How: ${next.how.tool} — ${next.how.command}`);
    }
    if (next.phase_ids && next.phase_ids.length > 0) {
      lines.push(`Phase: ${next.phase_ids.join(", ")}`);
    }
    if (next.agent) lines.push(`Agent: ${next.agent}`);
    if (next.checkpoint) lines.push(`Checkpoint: ${next.checkpoint}`);
    if (next.reason) lines.push(`Reason: ${next.reason}`);
    if (next.options) lines.push(`Options: ${next.options.join(", ")}`);
    // Surface non-default knobs.
    const knobs = task.knobs || {};
    const defaults = require("./task").DEFAULT_KNOBS;
    const overrides = [];
    for (const [k, v] of Object.entries(defaults)) {
      if (knobs[k] !== undefined && knobs[k] !== v) {
        overrides.push(`${k}=${knobs[k]}`);
      }
    }
    if (overrides.length > 0) lines.push(`Knobs (overridden): ${overrides.join(", ")}`);
    lines.push(`Task dir: ${ctx.taskDir}`);
    let context = lines.join("\n");
    if (context.length > 2048) context = context.slice(0, 2048);
    // Lease touch (best effort).
    try {
      require("./session").touch(ctx.sessionId);
    } catch {}
    return inject(context);
  } catch {
    return allow();
  }
}

/**
 * spawn-guard: compare subagent_type to `a next`; deny off-sequence spawns;
 * on allow, rewrite the prompt to prepend the canonical context block.
 */
function handleSpawnGuard(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const toolInput = (payload.tool_input) || {};
    const subagentType = toolInput.subagent_type || toolInput.type || "";
    const guards = guardsFor(ctx.agentType);
    if (guards.spawnGuard === false) return allow();
    if (guards.spawnGuard === null) {
      return denyPreToolUse(`agent ${ctx.agentType} may not spawn subagents`);
    }
    if (Array.isArray(guards.spawnGuard) && !guards.spawnGuard.includes(subagentType)) {
      return denyPreToolUse(
        `agent ${ctx.agentType} may only spawn: ${guards.spawnGuard.join(", ")} (got ${subagentType})`
      );
    }
    // Check the phase step: the spawn must match what `a next` says is legal.
    // Only orchestrators (conductor, courier) are gated by the next-agent
    // check; explorer/reviewer spawn research subagents regardless of step.
    const task = readTaskJson(ctx.taskDir);
    if (!task) return allow();
    const isOrchestrator = ctx.agentType === "conductor" || ctx.agentType === "courier";
    if (isOrchestrator) {
      const policy = require("./policy").resolvePolicy(ctx.projectDir || process.cwd());
      const next = require("./next").computeNext(task, {
        projectDir: ctx.projectDir || process.cwd(),
        policy,
        taskDir: ctx.taskDir,
      });
      // If the next agent doesn't match the spawn, deny with the gate reason.
      if (next.agent && next.agent !== subagentType && subagentType !== "oracle") {
        const reason = next.step === "review_plan"
          ? `phase ${next.phase_ids ? next.phase_ids[0] : "?"} has not passed review`
          : next.step === "approve"
            ? `phase ${next.phase_ids ? next.phase_ids[0] : "?"} has not passed approval`
            : `expected agent ${next.agent} for step ${next.step}, got ${subagentType}`;
        return denyPreToolUse(reason);
      }
    }
    // Rewrite the prompt: prepend the canonical context block.
    const phase = currentPhase(task);
    const contextLines = [];
    contextLines.push(`Task dir: ${ctx.taskDir}`);
    if (phase) {
      contextLines.push(`Phase: ${phase.id} (${phase.name})`);
      if (phase.plan_path) contextLines.push(`Plan: ${phase.plan_path}`);
      if (phase.manifest && phase.manifest.length > 0) {
        contextLines.push(`Manifest: ${phase.manifest.join(", ")}`);
      }
    }
    contextLines.push(`Agent: ${subagentType}`);
    contextLines.push("End with the JSON report per your template.");
    const contextBlock = contextLines.join("\n");
    const newPrompt = contextBlock + "\n\n" + (toolInput.prompt || "");
    return rewriteInput(toolInput, { prompt: newPrompt });
  } catch (err) {
    // Injector exception → silent no-op (never block a spawn).
    return allow();
  }
}

/**
 * report-parser: extract the last JSON block, validate per agent_type, exit 2
 * on invalid; on valid, `a report` persists it.
 * Fallback: if the payload lacks agent_type, resolve from the session.
 */
function handleReportParser(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    let agentType = payload.agent_type || ctx.agentType;
    if (!agentType) return allow();
    if (payload.stop_hook_active === true) {
      return allowWithWarning("report-parser", "report validation skipped (already blocked this turn)");
    }
    const message = payload.last_assistant_message || "";
    const extracted = extractJsonReport(message);
    if (!extracted.valid) {
      return blockStop(blockReasonWithSkeleton(extracted.reason, agentType));
    }
    const { validateReport, persistReport } = require("./report");
    const validation = validateReport(agentType, extracted.report);
    if (!validation.valid) {
      const errs = "Report schema errors:\n" + validation.errors.map((e) => `- ${e}`).join("\n");
      return blockStop(blockReasonWithSkeleton(errs, agentType));
    }
    const task = readTaskJson(ctx.taskDir);
    const phase = currentPhase(task);
    if (!phase) return allow();
    const result = persistReport({
      taskDir: ctx.taskDir,
      phaseId: phase.id,
      agentType,
      report: extracted.report,
      ctx: { projectDir: ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)) },
    });
    // Return the result as additionalContext so the parent sees what happened.
    return {
      exitCode: 0,
      output: {
        hookSpecificOutput: {
          additionalContext: `Report persisted: ${result.transition || "stored"} (phase ${result.phase.id} → ${result.phase.status})`,
        },
      },
    };
  } catch (err) {
    return blockStop(`report-parser error: ${err.message}`);
  }
}

/**
 * checkpoint-capture: open with question/options, resolve with the answer;
 * when the resolution satisfies a review/approval gate, record via `a report`
 * with attributed_to: "user" (D31).
 *
 * Headless sessions (D18): AskUserQuestion cannot interact with a user in `-p`
 * mode. The PreToolUse handler opens the checkpoint, then denies the tool call
 * with the question as the deny reason, so the headless run stops cleanly and
 * `a run` / PAV inbox can surface the question. This is the fallback for when
 * PreToolUse `continue:false`/`stopReason` is unavailable on the running CC
 * version (unverified on 2.1.302 at design time).
 */
function isHeadless() {
  return process.env.CLAUDE_CODE_NON_INTERACTIVE === "1" ||
    process.env.CLAUDE_CODE_NON_INTERACTIVE === "true";
}

function handleCheckpointCapture(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    // PreToolUse AskUserQuestion: open the checkpoint.
    if (payload.hook_event_name === "PreToolUse") {
      const toolInput = payload.tool_input || {};
      const question = toolInput.question || "";
      const options = toolInput.options || [];
      const task = readTaskJson(ctx.taskDir);
      const phase = currentPhase(task);
      if (!phase) return allow();
      const cpLib = require("./checkpoint");
      const type = (task.knobs && task.knobs.approve === "ask") ? "approve_plan" : "custom";
      const cp = cpLib.openCheckpoint({
        taskDir: ctx.taskDir,
        phaseId: phase.id,
        type,
        question,
        options: options.map((o) => (typeof o === "string" ? o : o.label || o.text || "")),
      });
      // Headless fallback (D18): deny with the question as the reason so the
      // headless run stops cleanly and `a run` / PAV inbox surfaces it.
      if (isHeadless()) {
        const reason = question || `checkpoint ${cp.id}: headless session cannot ask a question`;
        return denyPreToolUse(reason);
      }
      return allow();
    }
    // PostToolUse AskUserQuestion: resolve the checkpoint with the answer.
    if (payload.hook_event_name === "PostToolUse") {
      const toolResponse = payload.tool_response || {};
      const answer = toolResponse.answer || toolResponse.text || "";
      const task = readTaskJson(ctx.taskDir);
      const openCps = (task.checkpoints || []).filter((cp) => cp.chosen === null);
      if (openCps.length === 0) return allow();
      const cp = openCps[openCps.length - 1];
      const cpLib = require("./checkpoint");
      cpLib.resolveCheckpoint({
        taskDir: ctx.taskDir,
        checkpointId: cp.id,
        chosen: answer,
        ctx: { projectDir: ctx.projectDir },
      });
      // If the resolution satisfies a review/approval gate, record a user-attributed pass (D31).
      if (cp.type === "approve_plan") {
        const phase = (task.phases || []).find((p) => p.id === cp.phase);
        if (phase && phase.status === "planned") {
          const { persistReport } = require("./report");
          persistReport({
            taskDir: ctx.taskDir,
            phaseId: phase.id,
            agentType: "reviewer",
            report: {
              verdict: "pass",
              attributed_to: "user",
              issues: [],
              summary: `User resolved the plan review at checkpoint ${cp.id}`,
            },
            ctx: { projectDir: ctx.projectDir },
          });
        }
      }
      return allow();
    }
    return allow();
  } catch {
    return allow();
  }
}

/**
 * git-guard: tokenise the command, evaluate git/gh policy per the guard table.
 * Reads AGENTS_LAND from its own process env (D30); a command-string prefix
 * never grants.
 */
function handleGitGuard(payload, ctx) {
  try {
    const command = (payload.tool_input && payload.tool_input.command) || "";
    if (!command) return allow();
    const policy = ctx.policy || require("./policy").resolvePolicy(ctx.projectDir || process.cwd());
    const agentsLand = process.env.AGENTS_LAND === "1";
    const landLockHeld = ctx.landLockHeld !== undefined ? ctx.landLockHeld : checkLandLock(ctx.projectDir || process.cwd());
    const result = evalCommand(command, {
      agentType: ctx.agentType,
      policy,
      initiator: ctx.initiator,
      agentsLand,
      landLockHeld,
    });
    if (result.decision === "deny") return denyPreToolUse(result.reason);
    if (result.decision === "ask") return askPreToolUse(result.reason);
    return allow();
  } catch (err) {
    return handleGuardException(err, ctx, "git-guard");
  }
}

/**
 * write-guard: deny shell file-write primitives (redirection, tee, sed -i,
 * touch, dd of=, editors, curl/wget download-to-file, python -c / node -e
 * writes) for agents whose guard table entry has writeGuard: true (explorer,
 * reviewer, committer per D13). The detection logic lives in
 * scripts/lib/writeguard.js (ported from the original Python hook, ADR-015).
 */
function handleWriteGuard(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const guards = guardsFor(ctx.agentType);
    if (!guards.writeGuard) return allow();
    const command = (payload.tool_input && payload.tool_input.command) || "";
    if (!command) return allow();
    if (scanCommand(command)) {
      return denyPreToolUse(getCoaching(ctx.agentType));
    }
    return allow();
  } catch (err) {
    return handleGuardException(err, ctx, "write-guard");
  }
}

function checkLandLock(projectDir) {
  try {
    const { repoKey } = require("./repo");
    const key = repoKey(projectDir);
    const os = require("os");
    const lockPath = path.join(os.homedir(), ".agents", "locks", `${key.repo_key}.land.lock`);
    return fs.existsSync(lockPath);
  } catch {
    return false;
  }
}

/**
 * Handle a guard exception per the D13 failure policy + D32 enforcement knob.
 * - Unbound session (no taskDir) → silent no-op (allow).
 * - Bound session, enforcement: warn → allow + append warning to phase.warnings.
 * - Bound session, enforcement: deny (default) → deny with reason.
 * @param {Error} err - the exception
 * @param {object} ctx - session context (taskDir, agentType, sessionId, projectDir)
 * @param {string} guard - guard name for the warning entry
 * @returns {{ exitCode: number, output: object|null }}
 */
function handleGuardException(err, ctx, guard) {
  if (!ctx.taskDir) return allow();
  const enforcement = readEnforcementKnob(ctx.taskDir);
  if (enforcement === "warn") {
    appendWarning(ctx.taskDir, {
      guard,
      reason: err.message,
      at: new Date().toISOString(),
      session_id: ctx.sessionId || `pid-${process.pid}`,
    });
    return allow();
  }
  return denyPreToolUse(`enforcement unavailable: ${err.message}`);
}

function readEnforcementKnob(taskDir) {
  try {
    const task = readTaskJson(taskDir);
    return (task && task.knobs && task.knobs.enforcement) || "deny";
  } catch {
    return "deny";
  }
}

function appendWarning(taskDir, entry) {
  try {
    const { withLock } = require("./lock");
    const taskLib = require("./task");
    const lockHolder = { session_id: entry.session_id, pid: process.pid };
    withLock(taskDir, lockHolder, () => {
      const task = taskLib.readTaskJson(taskDir);
      if (!task) return;
      const phase = currentPhase(task);
      if (!phase) return;
      phase.warnings = phase.warnings || [];
      phase.warnings.push(entry);
      taskLib.writeTaskJson(taskDir, task);
      require("./render").renderStateMd(taskDir, task, path.dirname(path.dirname(taskDir)));
    });
  } catch {
    // Best-effort: a warning-append failure must never block the tool call.
  }
}

/**
 * D47(4): detect whether a Bash command writes to hook code paths
 * (hooks/ or scripts/lib/hook.js|guards.js). Simple heuristic: the command
 * mentions a hook code path AND contains a write primitive.
 */
function commandWritesHookCode(command, projectDir) {
  const lowerCmd = command.toLowerCase();
  // Write primitives that modify files in place or copy to a target.
  const writePrimitives = ["sed -i", "perl -i", "cp ", "mv ", "tee ", "install ", "dd of=", " >>", " >"];
  const hasWrite = writePrimitives.some((p) => lowerCmd.includes(p));
  if (!hasWrite) return false;
  // Check for hook code paths in the command.
  const hookPaths = ["hooks/", "scripts/lib/hook.js", "scripts/lib/guards.js"];
  return hookPaths.some((p) => lowerCmd.includes(p));
}

/**
 * machine-owned-guard (D37): deny Edit/Write and Bash writes targeting
 * task.json, state.md, state.json*, tasks.json, index.json for every agent
 * type and unbound sessions. Active before any task-dir or manifest check.
 */
function handleMachineOwnedGuard(payload, ctx) {
  try {
    const guards = guardsFor(ctx.agentType);
    if (!guards.machineOwned) return allow();
    // Edit/Write: check file_path basename.
    const filePath = (payload.tool_input &&
      (payload.tool_input.file_path || payload.tool_input.path)) || "";
    if (filePath) {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.projectDir || process.cwd(), filePath);
      const base = path.basename(resolved);
      if (isMachineOwnedBasename(base)) {
        return denyPreToolUse(machineOwnedDenyReason(base));
      }
      // D47(4): hook code guard — deny edits to hooks/ and scripts/lib/{hook,guards}.js
      // when the bound task is not about hooks. Sessions without a bound task are unaffected.
      if (ctx.taskDir && isHookCodePath(resolved, ctx.projectDir || process.cwd())) {
        if (!taskMentionsHooks(ctx.taskDir)) {
          return denyPreToolUse(hookCodeDenyReason());
        }
      }
      return allow();
    }
    // Bash: detect writes to machine-owned files via the gitcmd tokenizer.
    const command = (payload.tool_input && payload.tool_input.command) || "";
    if (command) {
      const target = detectMachineOwnedWrite(command);
      if (target) {
        return denyPreToolUse(machineOwnedDenyReason(target));
      }
      // D47(4): Bash writes to hook code paths — simple string check for
      // paths under hooks/ or scripts/lib/hook.js|guards.js in write
      // commands (sed -i, cp, mv, tee, etc.).
      if (ctx.taskDir && commandWritesHookCode(command, ctx.projectDir || process.cwd())) {
        if (!taskMentionsHooks(ctx.taskDir)) {
          return denyPreToolUse(hookCodeDenyReason());
        }
      }
    }
    return allow();
  } catch (err) {
    // Fail closed only for Bash ambiguity; an exception in the Edit/Write path
    // is a guard failure, not a file the user is trying to protect.
    return allow();
  }
}

/**
 * D47(4): check whether the bound task's title and task.md mention "hook".
 * Used by the machine-owned guard to allow hook code edits only for tasks
 * about hooks.
 */
function taskMentionsHooks(taskDir) {
  try {
    const task = readTaskJson(taskDir);
    if (!task) return false;
    const title = (task.title || "").toLowerCase();
    if (title.includes("hook")) return true;
    // Check task.md for the word "hook".
    const taskMdPath = path.join(taskDir, "task.md");
    if (fs.existsSync(taskMdPath)) {
      const md = fs.readFileSync(taskMdPath, "utf8").toLowerCase();
      if (md.includes("hook")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * manifest-guard: path rules per the guard table.
 * Builder may write outside manifest only if the phase has scope_change flag;
 * never another task's dir; never task.json/state.md by hand.
 */
function handleManifestGuard(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const guards = guardsFor(ctx.agentType);
    if (!guards.manifestGuard) return allow();
    const filePath = (payload.tool_input && (payload.tool_input.file_path || payload.tool_input.path)) || "";
    if (!filePath) return allow();
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.projectDir || process.cwd(), filePath);
    const taskDirAbs = path.resolve(ctx.taskDir);

    // Never write task.json or state.md by hand.
    if (resolved === path.join(taskDirAbs, "task.json") || resolved === path.join(taskDirAbs, "state.md")) {
      return denyPreToolUse("do not edit task.json or state.md by hand — use `a` commands");
    }
    // Never another task's dir.
    const tasksDir = path.dirname(taskDirAbs);
    if (resolved.startsWith(tasksDir + path.sep) && !resolved.startsWith(taskDirAbs + path.sep) && resolved !== taskDirAbs) {
      return denyPreToolUse("do not edit files in another task's directory");
    }

    if (guards.manifestGuard === "deny_all" && !resolved.startsWith(taskDirAbs)) {
      return denyPreToolUse(`agent ${ctx.agentType} may only write within the task dir`);
    }
    if (guards.manifestGuard === "task_dir") {
      if (!resolved.startsWith(taskDirAbs)) {
        return denyPreToolUse(`agent ${ctx.agentType} may only write within the task dir (${taskDirAbs})`);
      }
      return allow();
    }
    if (guards.manifestGuard === "manifest_intersect") {
      const task = readTaskJson(ctx.taskDir);
      const phase = currentPhase(task);
      const manifest = (phase && phase.manifest) || [];
      const hasScopeChange = task.flags && task.flags.some((f) => f.type === "scope_change" && f.phase === (phase && phase.id));
      if (manifest.length === 0 || hasScopeChange) return allow();
      const rel = path.relative(ctx.projectDir || process.cwd(), resolved);
      const inManifest = manifest.some((m) => rel === m || rel.startsWith(m + "/") || rel === m.replace(/^\.\//, ""));
      if (!inManifest) {
        return denyPreToolUse(`file ${rel} is not in the phase manifest (${manifest.join(", ")})`);
      }
      return allow();
    }
    return allow();
  } catch (err) {
    return handleGuardException(err, ctx, "manifest-guard");
  }
}

/**
 * quality-gate: record exit codes of validation commands; block Stop if an
 * edit happened after the last green run. Replaces the keyword regex.
 */
function handleQualityGate(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    // PostToolUse Bash: record the exit code if the command matches the validation set.
    if (payload.hook_event_name === "PostToolUse") {
      const command = (payload.tool_input && payload.tool_input.command) || "";
      const exitCode = payload.tool_response && payload.tool_response.exit_code;
      const task = readTaskJson(ctx.taskDir);
      const phase = currentPhase(task);
      if (!phase) return allow();
      const validateSet = resolveValidateSet(ctx.projectDir);
      if (validateSet.length === 0) return allow();
      const matches = validateSet.some((re) => re.test(command));
      if (!matches) return allow();
      phase.validation = phase.validation || [];
      phase.validation.push({
        cmd: command,
        exit: exitCode,
        at: new Date().toISOString(),
      });
      const { writeTaskJson } = require("./task");
      writeTaskJson(ctx.taskDir, task);
      require("./render").renderStateMd(ctx.taskDir, task, ctx.projectDir);
      return allow();
    }
    // Stop: block if an edit happened after the last green run.
    if (payload.hook_event_name === "Stop" || !payload.hook_event_name) {
      if (payload.stop_hook_active === true) {
        return allowWithWarning("quality-gate", "validation gate skipped (already blocked this turn)");
      }
      const task = readTaskJson(ctx.taskDir);
      const phase = currentPhase(task);
      if (!phase) return allow();
      const lastEdit = phase.last_edit_at;
      const validation = phase.validation || [];
      const lastGreen = [...validation].reverse().find((v) => v.exit === 0);
      if (lastEdit && (!lastGreen || lastGreen.at < lastEdit)) {
        return blockStop("Files were edited after the last green validation run. Run your validation commands (tests/lint/types) and show the output before stopping.");
      }
      return allow();
    }
    return allow();
  } catch {
    return allow();
  }
}

function resolveValidateSet(projectDir) {
  try {
    const config = require("./config").loadConfig();
    const list = (config.validate || []);
    return list.map((s) => new RegExp(s));
  } catch {
    return [];
  }
}

/**
 * conductor-stop: block when the turn produced no state write, report, or
 * checkpoint and `a next`.step ≠ done. Uses guardsFor(ctx.agentType).stop
 * (D13) instead of an ad-hoc string check. Blocks at most once per turn:
 * when stop_hook_active is true (second evaluation), passes with the reason
 * as a warning (D43).
 */
function handleConductorStop(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const guards = guardsFor(ctx.agentType);
    if (!guards.stop || !guards.stop.includes("conductor-stop")) return allow();
    const task = readTaskJson(ctx.taskDir);
    if (!task) return allow();
    const policy = require("./policy").resolvePolicy(ctx.projectDir || process.cwd());
    const next = require("./next").computeNext(task, {
      projectDir: ctx.projectDir || process.cwd(),
      policy,
      taskDir: ctx.taskDir,
    });
    if (next.step === "done") return allow();
    const reason = `No state advance this turn. Next: ${next.step}${next.reason ? " — " + next.reason : ""}`;
    if (payload.stop_hook_active === true) {
      return allowWithWarning("conductor-stop", reason);
    }
    return blockStop(reason);
  } catch {
    return allow();
  }
}

/**
 * plan-lint: run `a plan lint` on Write of a plan file or task.md; block with findings.
 */
function handlePlanLint(payload, ctx) {
  try {
    const filePath = (payload.tool_input && (payload.tool_input.file_path || payload.tool_input.path)) || "";
    if (!filePath) return allow();
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.projectDir || process.cwd(), filePath);
    const base = path.basename(resolved);
    if (base !== "task.md" && !resolved.includes(path.sep + "plan" + path.sep)) {
      return allow();
    }
    const lint = require("./lint");
    let result;
    if (base === "task.md") {
      result = lint.lintTaskMd(resolved);
    } else {
      result = lint.lintPlan(resolved);
    }
    if (result.ok) return allow();
    const findings = (result.errors || []).concat(result.warnings || []);
    return blockStop("Plan lint findings:\n" + findings.map((f) => `- ${f}`).join("\n"));
  } catch (err) {
    return allow();
  }
}

/**
 * courier-stop: for sessions the registry marks as courier, run report-parser's
 * extraction/validation (the Courier acts as its own builder), then `a report`
 * (closes the D15 resumability gap). Uses guardsFor(ctx.agentType).stop (D13).
 *
 * D38 item 4: when the bound phase is committed and the session cwd is a
 * worktree, run `a land`, then `a worktree remove` when no phases remain,
 * then `a task close` by tier. On conflict, leave the worktree and write
 * a needs_human flag with the file list.
 *
 * D34/D15: for a Courier on the base branch (no worktree), advance phase 1
 * through implemented → committed → landed → done, then `a task close` by
 * tier (minor → trash D40). Until the phase is landed, skip the close and
 * say so.
 */
function handleCourierStop(payload, ctx) {
  try {
    const guards = guardsFor(ctx.agentType);
    if (!guards.stop || !guards.stop.includes("courier-stop")) return allow();
    if (!ctx.taskDir) return allow();
    let result;
    if (payload.stop_hook_active !== true) {
      // First evaluation: the Courier acts as its own builder; validate its report.
      const reportPayload = { ...payload, agent_type: "builder" };
      result = handleReportParser(reportPayload, ctx);
    } else {
      // Second evaluation: allow with warning (D47(2) block-once-per-turn).
      result = allowWithWarning("courier-stop", "report validation skipped (already blocked this turn)");
    }
    // After the report is persisted, attempt landing (worktree) or base-branch advancement.
    try {
      courierStopLand(ctx);
      courierStopAdvance(ctx);
    } catch {}
    return result;
  } catch {
    return allow();
  }
}

/**
 * Landing logic for courier-stop (D38 item 4).
 * Runs `a land` when the bound phase is implemented/committed and the
 * session is in a worktree. On success with no remaining phases, removes
 * the worktree and closes the task. On conflict, leaves the worktree and
 * writes a needs_human flag.
 */
function courierStopLand(ctx) {
  const task = readTaskJson(ctx.taskDir);
  if (!task) return;
  // Find the current phase (first non-terminal).
  const phase = (task.phases || []).find(
    (p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped" && p.status !== "landed"
  );
  if (!phase) return;
  // Only land implemented or committed phases.
  if (phase.status !== "implemented" && phase.status !== "committed") return;
  // Only land if the phase has a branch recorded (worktree session).
  if (!phase.branch) return;

  const { repoKey } = require("./repo");
  const key = repoKey(ctx.projectDir || process.cwd());
  const { land } = require("./land");

  let landResult;
  try {
    landResult = land({
      taskDir: ctx.taskDir,
      projectDir: key.main_root,
      phaseIds: [phase.id],
    });
  } catch (err) {
    // On conflict (exit 20) or needs_human, leave the worktree.
    // Write a needs_human flag with the file list if available.
    if (err.code === "VALIDATION_FAILED" || err.code === "BRANCH_NOT_FOUND") {
      addCourierStopFlag(ctx.taskDir, phase.id, err.message, key.main_root);
    }
    return;
  }

  // If landing succeeded and no phases remain, remove worktree and close task.
  if (landResult && (landResult.landed || landResult.pr_created)) {
    const remaining = countRemainingPhases(ctx.taskDir);
    if (remaining === 0) {
      // Remove the worktree.
      if (landResult.worktree_removed === false && phase.branch) {
        try {
          const { parseWorktrees, shortBranch } = require("./worktree");
          const wts = parseWorktrees(key.main_root);
          const found = wts.find((wt) => shortBranch(wt.branch) === phase.branch);
          if (found) {
            require("./worktree").remove({
              projectDir: key.main_root, path: found.path, force: false,
            });
          }
        } catch {}
      }
      // Close the task by tier rule.
      try {
        require("./task").closeTask({ taskDir: ctx.taskDir, repoKeyObj: key });
      } catch {}
    }
  }

  // On conflict, leave the worktree and write needs_human.
  if (landResult && landResult.conflict) {
    addCourierStopFlag(
      ctx.taskDir, phase.id,
      `Landing conflict; files: ${(landResult.files || []).join(", ")}`,
      key.main_root
    );
  }
}

function addCourierStopFlag(taskDir, phaseId, message, projectDir) {
  try {
    const { withLock } = require("./lock");
    const taskLib = require("./task");
    const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
    withLock(taskDir, holder, () => {
      const task = taskLib.readTaskJson(taskDir);
      if (!task) return;
      task.flags = task.flags || [];
      task.flags.push({
        id: `f-courier-stop-${Date.now()}`,
        phase: phaseId,
        type: "needs_human",
        message,
        raised: new Date().toISOString(),
      });
      taskLib.writeTaskJson(taskDir, task);
      require("./render").renderStateMd(taskDir, task, projectDir);
    });
  } catch {}
}

function countRemainingPhases(taskDir) {
  const task = readTaskJson(taskDir);
  if (!task) return 0;
  return (task.phases || []).filter(
    (p) => !["done", "failed", "skipped", "landed"].includes(p.status)
  ).length;
}

/**
 * Base-branch advancement for courier-stop (D34/D15). When the Courier ran
 * on the base branch (no worktree/branch), advance the phase through
 * implemented → committed → landed → done using the Courier's own commits.
 * Then close the task by tier (minor → trash D40).
 */
function courierStopAdvance(ctx) {
  const task = readTaskJson(ctx.taskDir);
  if (!task) return;
  const phase = (task.phases || []).find(
    (p) => p.status !== "done" && p.status !== "failed" && p.status !== "skipped" && p.status !== "landed"
  );
  if (!phase) return;
  // Only advance phases that are implemented or committed (report persisted).
  if (phase.status !== "implemented" && phase.status !== "committed") return;
  // Only for base-branch sessions (no worktree branch).
  if (phase.branch) return;

  const { execFileSync } = require("child_process");
  const { repoKey } = require("./repo");
  const key = repoKey(ctx.projectDir || process.cwd());
  const base = key.base || "main";
  const cwd = ctx.projectDir || process.cwd();

  // Check we're on the base branch.
  let currentBranch = "";
  try {
    currentBranch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { return; }
  if (currentBranch !== base) return;

  // Find the Courier's commits: HEAD and any commits not yet recorded.
  // D34: record HEAD as the commit SHA (the Courier committed on base).
  let headSha = "";
  try {
    headSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { return; }
  if (!headSha) return;

  // Already recorded → skip.
  if (phase.commits && phase.commits.includes(headSha)) return;

  const { withLock } = require("./lock");
  const taskLib = require("./task");
  const { applyTransition } = require("./transitions");
  const holder = { session_id: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };

  withLock(ctx.taskDir, holder, () => {
    const t = taskLib.readTaskJson(ctx.taskDir);
    if (!t) return;
    const p = (t.phases || []).find((ph) => ph.id === phase.id);
    if (!p) return;

    // Record the commit and advance implemented → committed.
    if (p.status === "implemented") {
      p.commits = [headSha];
      const transitionCtx = { projectDir: cwd, gitFacts: { shaExists: () => true, isAncestor: () => true, base } };
      applyTransition(p, "committed", t, transitionCtx);
    }

    // Advance committed → landed (on base branch, HEAD is an ancestor of base).
    if (p.status === "committed") {
      p.landed_sha = headSha;
      const transitionCtx = { projectDir: cwd, gitFacts: { shaExists: () => true, isAncestor: () => true, base } };
      applyTransition(p, "landed", t, transitionCtx);
    }

    // Advance landed → done.
    if (p.status === "landed") {
      applyTransition(p, "done", t, {});
    }

    taskLib.writeTaskJson(ctx.taskDir, t);
    try { require("./render").renderStateMd(ctx.taskDir, t, cwd); } catch {}
  });

  // Close the task by tier if all phases are done.
  const updated = readTaskJson(ctx.taskDir);
  if (updated && require("./task").isTaskDone(updated)) {
    try {
      require("./task").closeTask({ taskDir: ctx.taskDir, repoKeyObj: key });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const HANDLERS = {
  prime: handlePrime,
  "spawn-guard": handleSpawnGuard,
  "report-parser": handleReportParser,
  "checkpoint-capture": handleCheckpointCapture,
  "git-guard": handleGitGuard,
  "machine-owned-guard": handleMachineOwnedGuard,
  "manifest-guard": handleManifestGuard,
  "quality-gate": handleQualityGate,
  "conductor-stop": handleConductorStop,
  "plan-lint": handlePlanLint,
  "courier-stop": handleCourierStop,
  "write-guard": handleWriteGuard,
};

/**
 * Run a hook by name. Reads stdin if no payload is given.
 * @param {string} name - hook name
 * @param {object} [payload] - parsed hook payload (stdin JSON)
 * @param {object} [ctxOverride] - override the resolved session context
 * @returns {{ exitCode: number, output: object|null }}
 */
function runHook(name, payload, ctxOverride) {
  const handler = HANDLERS[name];
  if (!handler) return { exitCode: 0, output: null };

  const p = payload || {};
  const session = ctxOverride || resolveSession();
  // D13: read agent_type from registration first, hook input second.
  // Normalise to lowercase so GUARD_TABLE keys match.
  const payloadAgent = p.agent_type ? String(p.agent_type).toLowerCase() : null;
  const ctx = {
    taskDir: session.task_dir,
    agentType: session.agent_type || payloadAgent,
    sessionId: session.session_id,
    initiator: session.initiator,
    projectDir: process.cwd(),
    ...(ctxOverride || {}),
  };

  return handler(p, ctx);
}

module.exports = {
  resolveSession,
  extractJsonReport,
  runHook,
  HANDLERS,
  handlePrime,
  handleSpawnGuard,
  handleReportParser,
  handleCheckpointCapture,
  handleGitGuard,
  handleMachineOwnedGuard,
  handleManifestGuard,
  handleQualityGate,
  handleConductorStop,
  handlePlanLint,
  handleCourierStop,
  handleWriteGuard,
  handleGuardException,
  courierStopAdvance,
  allowWithWarning,
  blockReasonWithSkeleton,
  taskMentionsHooks,
};
