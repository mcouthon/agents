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
const { guardsFor, evalCommand } = require("./guards");
const { scanCommand, getCoaching } = require("./writeguard");

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bound session from AGENTS_SESSION_DIR/registration.json.
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
      agent_type: reg.agent || null,
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
  return { exitCode: 2, output: { systemMessage: reason } };
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
    const message = payload.last_assistant_message || "";
    let agentType = payload.agent_type || ctx.agentType;
    if (!agentType) return allow();
    const extracted = extractJsonReport(message);
    if (!extracted.valid) {
      return blockStop(extracted.reason);
    }
    const { validateReport, persistReport } = require("./report");
    const validation = validateReport(agentType, extracted.report);
    if (!validation.valid) {
      return blockStop("Report schema errors:\n" + validation.errors.map((e) => `- ${e}`).join("\n"));
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
 * checkpoint and `a next`.step ≠ done.
 */
function handleConductorStop(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const task = readTaskJson(ctx.taskDir);
    if (!task) return allow();
    const policy = require("./policy").resolvePolicy(ctx.projectDir || process.cwd());
    const next = require("./next").computeNext(task, {
      projectDir: ctx.projectDir || process.cwd(),
      policy,
      taskDir: ctx.taskDir,
    });
    if (next.step === "done") return allow();
    return blockStop(`No state advance this turn. Next: ${next.step}${next.reason ? " — " + next.reason : ""}`);
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
 * extraction/validation, then `a report` (closes the D15 resumability gap).
 */
function handleCourierStop(payload, ctx) {
  try {
    if (ctx.agentType !== "courier") return allow();
    if (!ctx.taskDir) return allow();
    return handleReportParser(payload, ctx);
  } catch {
    return allow();
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

  const session = ctxOverride || resolveSession();
  const ctx = {
    taskDir: session.task_dir,
    agentType: session.agent_type,
    sessionId: session.session_id,
    initiator: session.initiator,
    projectDir: process.cwd(),
    ...(ctxOverride || {}),
  };

  return handler(payload || {}, ctx);
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
  handleManifestGuard,
  handleQualityGate,
  handleConductorStop,
  handlePlanLint,
  handleCourierStop,
  handleWriteGuard,
  handleGuardException,
};
