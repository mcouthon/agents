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
const { extractJsonReport, extractJsonCandidates } = require("./report");
const { hookLogPath, hooksDisabledPath, hooksDisabled } = require("./hooks/common");

// Default hook event each handler is wired for (install-global-hooks.js).
// Used as the fallback for hookEventName when the stdin payload omits
// hook_event_name (D50): every hookSpecificOutput must carry hookEventName.
const HANDLER_WIRING = {
  prime: "UserPromptSubmit",
  "spawn-guard": "PreToolUse",
  "report-parser": "SubagentStop",
  "checkpoint-capture": "PostToolUse",
  "report-capture": "PreToolUse",
  "session-register": "SessionStart",
  "session-end": "SessionEnd",
  "git-guard": "PreToolUse",
  "machine-owned-guard": "PreToolUse",
  "manifest-guard": "PreToolUse",
  "quality-gate": "PostToolUse",
  "conductor-stop": "Stop",
  "plan-lint": "PostToolUse",
  "courier-stop": "Stop",
  "write-guard": "PreToolUse",
};

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

/**
 * Last assistant text in a Claude Code JSONL transcript (entries with
 * type "assistant"; text parts of message.content joined), or null when the
 * path is missing or unreadable. D57: SubagentStop payloads on Claude Code
 * 2.1.306 arrive without `last_assistant_message`, so the transcript is the
 * durable source for report-parser.
 */
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, "utf8"); } catch { return null; }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "assistant" || !entry.message) continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
        : "";
    if (text.trim()) return text;
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// Hook output helpers
// ---------------------------------------------------------------------------

function allow() {
  return { exitCode: 0, output: null };
}

function denyPreToolUse(reason, eventName) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    },
  };
}

function askPreToolUse(reason, eventName) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    },
  };
}

function rewriteInput(toolInput, overrides, eventName) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: "allow",
        updatedInput: { ...toolInput, ...overrides },
      },
    },
  };
}

function inject(context, eventName) {
  return {
    exitCode: 0,
    output: { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } },
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
 * Append a one-line block record to the hook log (D47(5)).
 * Format: ISO-timestamp \t session_id \t hook_name \t reason_summary
 */
function appendHookLog(reason) {
  try {
    const logPath = hookLogPath();
    const logDir = path.dirname(logPath);
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
 * The skeleton is valid JSON (placeholder values only); the per-key
 * explanations are rendered as a list under the fence, not inside it (D50
 * item 2), so the agent can paste the fence verbatim and it parses.
 * @param {string} baseReason - the original error reason
 * @param {string} schemaName - the schema name (builder, explorer, reviewer, committer)
 * @returns {string} the enhanced reason with the skeleton
 */
function blockReasonWithSkeleton(baseReason, schemaName) {
  try {
    const { renderSkeleton, renderSkeletonNotes } = require("./report");
    const skeleton = renderSkeleton(schemaName);
    if (!skeleton) return baseReason;
    let out = baseReason + "\n\nPaste this block at the end of your message, filled in:\n\n```json\n" + skeleton + "\n```";
    const notes = renderSkeletonNotes(schemaName);
    if (notes && notes.length > 0) {
      out += "\n\n" + notes.join("\n");
    }
    return out;
  } catch {
    return baseReason;
  }
}

/**
 * Return an allow-with-warning result (D47(2)): the second evaluation of a
 * failing Stop/SubagentStop payload passes and records a warning via
 * additionalContext, instead of blocking again.
 */
function allowWithWarning(hookName, reason, eventName) {
  // D51: on Stop/SubagentStop, `additionalContext` means "the conversation
  // continues so the model can act on it" — a warning emitted that way kept
  // sessions alive until Claude Code's nine-block cap (seen live 2026-10-21
  // in a Courier and a Conductor). The second pass therefore emits nothing;
  // the warning goes to the hook log only, where `a doctor` counts it.
  appendHookLog(`${hookName} warning (already blocked this turn${eventName ? ", " + eventName : ""}): ${reason}`);
  return { exitCode: 0, output: null };
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
    // F16/F17: apply pending transitions (non-blocking lock, never push).
    // prime applies the advance but never runs git push — a 60s network
    // operation on UserPromptSubmit would stall prompt submission.
    if (next.pending_transitions && next.phase_ids && next.phase_ids.length > 0) {
      try {
        require("./next").applyPendingTransitions(ctx.taskDir, next.pending_transitions, {
          projectDir: ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)),
          taskDir: ctx.taskDir,
          phaseId: next.phase_ids[0],
          policy,
        });
      } catch {}
    }
    // F17: prime advance for fast-mode not_started
    try {
      fastModeTouch(ctx);
    } catch {}
    return inject(context, ctx.eventName);
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
    const subagentType = String(toolInput.subagent_type || toolInput.type || "").toLowerCase();
    const guards = guardsFor(ctx.agentType);
    if (guards.spawnGuard === false) return allow();
    if (guards.spawnGuard === null) {
      return denyPreToolUse(`agent ${ctx.agentType} may not spawn subagents`, ctx.eventName);
    }
    if (Array.isArray(guards.spawnGuard) && !guards.spawnGuard.includes(subagentType)) {
      return denyPreToolUse(
        `agent ${ctx.agentType} may only spawn: ${guards.spawnGuard.join(", ")} (got ${subagentType})`,
        ctx.eventName
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
      if (next.agent && next.agent !== subagentType && subagentType !== "oracle" && subagentType !== "vision") {
        const reason = next.step === "review_plan"
          ? `phase ${next.phase_ids ? next.phase_ids[0] : "?"} has not passed review`
          : next.step === "approve"
            ? `phase ${next.phase_ids ? next.phase_ids[0] : "?"} has not passed approval`
            : `expected agent ${next.agent} for step ${next.step}, got ${subagentType}`;
        return denyPreToolUse(reason, ctx.eventName);
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
    // F23: record the spawned subagent_type for report-parser resolution
    recordSubagentType(ctx.sessionId, subagentType, toolInput);
    const newPrompt = contextBlock + "\n\n" + (toolInput.prompt || "");
    return rewriteInput(toolInput, { prompt: newPrompt }, ctx.eventName);
  } catch (err) {
    // Injector exception → silent no-op (never block a spawn).
    return allow();
  }
}

/**
 * F23: agents whose SubagentStop must be validated (carry JSON reports).
 * Every other subagent type is allowed without reading its transcript.
 */
const REPORTING_AGENTS = new Set([
  "explorer", "builder", "reviewer", "committer", "consolidator",
]);

/**
 * F23: record the spawned subagent_type keyed by the subagent's description
 * in the session dir, so report-parser can resolve the stopped agent's type
 * when the SubagentStop payload carries no agent_type (CC 2.1.306).
 */
function subagentTypesPath(sessionId) {
  const session = require("./session");
  const dir = session.resolveSessionDir(sessionId || process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`);
  return path.join(dir, "subagent-types.json");
}

function recordSubagentType(sessionId, subagentType, toolInput) {
  try {
    const filePath = subagentTypesPath(sessionId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let map = {};
    if (fs.existsSync(filePath)) {
      try { map = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
    }
    const key = (toolInput && toolInput.description) || `spawn-${Date.now()}`;
    map[key] = { type: subagentType, at: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2) + "\n");
  } catch {}
}

function resolveSubagentType(sessionId, payload) {
  if (!sessionId) return null;
  try {
    const filePath = subagentTypesPath(sessionId);
    if (!fs.existsSync(filePath)) return null;
    const map = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Try to match by the payload's transcript path or session id
    const keys = Object.keys(map);
    if (keys.length === 0) return null;
    // If only one subagent was spawned, use it
    if (keys.length === 1) return map[keys[0]].type;
    // Try matching by description in the payload
    const desc = payload.description || payload.tool_input?.description;
    if (desc && map[desc]) return map[desc].type;
    // Fall back to most recent
    let latest = null;
    let latestTime = 0;
    for (const [k, v] of Object.entries(map)) {
      const t = new Date(v.at).getTime();
      if (t > latestTime) { latestTime = t; latest = v.type; }
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * F17/D60 requirement 4: PostToolUse-touch fallback for fast-mode not_started.
 * If the bound phase is not_started on a fast-mode task, advance it to
 * in_progress under the task lock (best-effort). This is the advance that
 * does not depend on the fail-open prime injector.
 */
function fastModeTouch(ctx) {
  const task = readTaskJson(ctx.taskDir);
  if (!task) return;
  if (task.mode !== "fast") return;
  const phase = currentPhase(task);
  if (!phase || phase.status !== "not_started") return;
  const { withLock } = require("./lock");
  const taskLib = require("./task");
  const { applyTransition } = require("./transitions");
  const holder = { session_id: ctx.sessionId || process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`, pid: process.pid };
  try {
    withLock(ctx.taskDir, holder, () => {
      const t = taskLib.readTaskJson(ctx.taskDir);
      if (!t || t.mode !== "fast") return;
      const p = currentPhase(t);
      if (!p || p.status !== "not_started") return;
      applyTransition(p, "in_progress", t, { taskDir: ctx.taskDir });
      taskLib.writeTaskJson(ctx.taskDir, t);
      try { require("./render").renderStateMd(ctx.taskDir, t, ctx.projectDir); } catch {}
    });
  } catch {}
}

/**
 * F11: check whether the session has a live subagent.
 * Scans the registry for entries with parent_session_id matching the session.
 */
function hasLiveSubagent(sessionId) {
  if (!sessionId) return false;
  try {
    const sessions = require("./session").list();
    for (const s of sessions) {
      if (s.parent_session_id === sessionId && !s.ended_at) {
        if (require("./session").isLive(s)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * report-parser: extract the last JSON block, validate per agent_type, exit 2
 * on invalid; on valid, `a report` persists it.
 * F23: resolves the stopped agent from the payload's agent_type, else from the
 * per-subagent record; validates only reporting agents, allows the rest.
 */
function handleReportParser(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    // F23: resolve the stopped agent from the payload's agent_type, else from
    // the per-subagent record, else from the parent registration.
    let agentType = payload.agent_type
      || resolveSubagentType(ctx.sessionId, payload)
      || ctx.agentType;
    if (!agentType) return allow();
    // F23: validate only reporting agents; allow every other subagent type
    // (oracle, vision, general-purpose, ...) without reading its transcript.
    if (!REPORTING_AGENTS.has(agentType)) return allow();
    if (payload.stop_hook_active === true) {
      return allowWithWarning("report-parser", "report validation skipped (already blocked this turn)", ctx.eventName);
    }
    const message = payload.last_assistant_message
      || lastAssistantText(payload.agent_transcript_path || payload.transcript_path)
      || "";
    const candidates = extractJsonCandidates(message);
    if (candidates.length === 0 || !candidates.some((c) => c.valid)) {
      const reason = candidates.length > 0 ? candidates[candidates.length - 1].reason : "no JSON code block found in the report";
      return blockStop(blockReasonWithSkeleton(reason, agentType));
    }
    const { validateReport, persistReport } = require("./report");
    // D50 item 2: try candidates in reverse (last fence first, then earlier
    // ones) so a Courier emitting builder + committer blocks has the builder
    // block selected when the committer block fails the builder schema.
    let chosen = null;
    let lastErrors = null;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (!c.valid) continue;
      const validation = validateReport(agentType, c.report);
      if (validation.valid) {
        chosen = c;
        break;
      }
      lastErrors = validation.errors;
    }
    if (!chosen) {
      const errs = lastErrors
        ? "Report schema errors:\n" + lastErrors.map((e) => `- ${e}`).join("\n")
        : "no valid JSON report found";
      return blockStop(blockReasonWithSkeleton(errs, agentType));
    }
    const task = readTaskJson(ctx.taskDir);
    const phase = currentPhase(task);
    if (!phase) return allow();
    const result = persistReport({
      taskDir: ctx.taskDir,
      phaseId: phase.id,
      agentType,
      report: chosen.report,
      ctx: { projectDir: ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)) },
    });
    // Return the result as additionalContext so the parent sees what happened.
    return {
      exitCode: 0,
      output: {
        hookSpecificOutput: {
          hookEventName: ctx.eventName,
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
 * Never refuses: PreToolUse opens the checkpoint and allows (a headless
 * session simply has no answer to record). PostToolUse alone is enough: when
 * no checkpoint is open it opens one from the question, then resolves it. When
 * no answer can be extracted from the response, the checkpoint stays open.
 */
function checkpointQuestion(toolInput) {
  const q0 = Array.isArray(toolInput.questions) ? toolInput.questions[0] : null;
  const question = (q0 && q0.question) || toolInput.question || "";
  const raw = (q0 && q0.options) || toolInput.options || [];
  const options = raw.map((o) => (typeof o === "string" ? o : (o && (o.label || o.text)) || ""));
  return { question, options };
}

function answerText(v) {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(", ").trim();
  return "";
}

function checkpointAnswer(payload, question) {
  const input = payload.tool_input || {};
  const resp = payload.tool_response;
  const byQuestion = (answers) => (answers && typeof answers === "object" && !Array.isArray(answers) ? answerText(answers[question]) : "");
  const respAnswers = resp && typeof resp === "object" ? resp.answers : null;
  const firstOf = (answers) => {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return "";
    for (const v of Object.values(answers)) {
      const t = answerText(v);
      if (t) return t;
    }
    return "";
  };
  return byQuestion(respAnswers)
    || firstOf(respAnswers)
    || byQuestion(input.answers)
    || (resp && typeof resp === "object" ? answerText(resp.answer) || answerText(resp.text) : "")
    || (typeof resp === "string" ? resp.trim() : "");
}

function openCheckpointFor(ctx, task, question, options) {
  const phase = currentPhase(task);
  if (!phase) return null;
  const type = (task.knobs && task.knobs.approve === "ask") ? "approve_plan" : "custom";
  return require("./checkpoint").openCheckpoint({ taskDir: ctx.taskDir, phaseId: phase.id, type, question, options }).checkpoint;
}

function handleCheckpointCapture(payload, ctx) {
  try {
    if (!ctx.taskDir) return allow();
    const { question, options } = checkpointQuestion(payload.tool_input || {});
    // PreToolUse AskUserQuestion: open the checkpoint.
    if (payload.hook_event_name === "PreToolUse") {
      const task = readTaskJson(ctx.taskDir);
      if (task) openCheckpointFor(ctx, task, question, options);
      return allow();
    }
    // PostToolUse AskUserQuestion: resolve the checkpoint with the answer.
    if (payload.hook_event_name === "PostToolUse") {
      const answer = checkpointAnswer(payload, question);
      if (!answer) {
        logHook("checkpoint-capture", "not_recorded", "reason=no_answer");
        return allow();
      }
      const task = readTaskJson(ctx.taskDir);
      if (!task) return allow();
      const openCps = (task.checkpoints || []).filter((cp) => cp.chosen === null);
      const cp = openCps.length > 0 ? openCps[openCps.length - 1] : openCheckpointFor(ctx, task, question, options);
      if (!cp) return allow();
      const cpLib = require("./checkpoint");
      // F10: for approve_plan on a planned phase, persist the user-attributed
      // pass FIRST (advancing planned -> reviewed), then resolve the checkpoint
      // (advancing reviewed -> approved). The old order tried reviewed -> approved
      // while the phase was still planned, which failed silently.
      if (cp.type === "approve_plan" && (answer === "approve" || answer === "approved")) {
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
      cpLib.resolveCheckpoint({
        taskDir: ctx.taskDir,
        checkpointId: cp.id,
        chosen: answer,
        ctx: { projectDir: ctx.projectDir },
      });
      // F17/D60: PostToolUse-touch fallback — if the bound phase is not_started
      // on a fast-mode task, advance it to in_progress (D60 requirement 4).
      try {
        fastModeTouch(ctx);
      } catch {}
      return allow();
    }
    return allow();
  } catch (err) {
    logHook("checkpoint-capture", "error", `reason=exception: ${err.message}`);
    return allow();
  }
}

/**
 * Append a five-field outcome line to the hook log:
 * ISO \t session \t hook \t recorded|not_recorded|error \t detail.
 * Block lines have four fields, which is how `a doctor` tells them apart.
 */
function logHook(hook, outcome, detail) {
  try {
    const logPath = hookLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const sid = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
    const clean = String(detail || "").replace(/[\t\r\n]+/g, " ").slice(0, 200);
    fs.appendFileSync(logPath, `${new Date().toISOString()}\t${sid}\t${hook}\t${outcome}\t${clean}\n`);
  } catch {}
}

/**
 * report-capture: persist the report a reporting subagent hands back via
 * SubagentHandback (PreToolUse, `tool_input.message`). Identity is the
 * payload's agent_type and nothing else; persistence is the same function
 * `a report` uses, never forced, so the verdict attribution check applies.
 * Never refuses; every invocation writes exactly one hook-log line. Known
 * limit: a nested reporting subagent's hand-back is captured as the current
 * phase's report; the parent hands back last, so the parent's wins.
 */
function handleReportCapture(payload, ctx) {
  const finish = (outcome, detail, context) => {
    logHook("report-capture", outcome, detail);
    return context ? inject(context, ctx.eventName) : allow();
  };
  try {
    const identity = String((payload && payload.agent_type) || "").toLowerCase();
    if (!identity) return finish("not_recorded", "reason=no_agent_type");
    if (!REPORTING_AGENTS.has(identity)) return finish("not_recorded", "reason=not_reporting_agent");
    if (!ctx.taskDir) return finish("not_recorded", "reason=no_task_bound");
    const task = readTaskJson(ctx.taskDir);
    if (!task) return finish("not_recorded", "reason=task_unreadable");
    const phase = currentPhase(task);
    if (!phase) return finish("not_recorded", "reason=no_current_phase");
    const message = payload.tool_input && payload.tool_input.message;
    if (typeof message !== "string") {
      return finish("not_recorded", "reason=no_message", "Report not recorded: no report in the hand-back");
    }
    const { validateReport, submitReport } = require("./report");
    const candidates = extractJsonCandidates(message);
    let chosen = null;
    let firstError = null;
    for (let i = candidates.length - 1; i >= 0 && !chosen; i--) {
      if (!candidates[i].valid) continue;
      const validation = validateReport(identity, candidates[i].report);
      if (validation.valid) chosen = candidates[i];
      else if (!firstError) firstError = validation.errors[0];
    }
    if (!chosen) {
      if (firstError) return finish("not_recorded", `reason=schema_error: ${firstError}`, `Report not recorded: ${firstError}`);
      const reason = candidates.length > 0 ? candidates[candidates.length - 1].reason : "no JSON code block found in the report";
      return finish("not_recorded", `reason=parse_failure`, `Report not recorded: ${reason}`);
    }
    let result;
    try {
      const submitted = submitReport({
        taskDir: ctx.taskDir,
        phaseId: phase.id,
        agentType: identity,
        report: chosen.report,
        projectDir: ctx.projectDir || path.dirname(path.dirname(ctx.taskDir)),
      });
      if (!submitted.valid) return finish("not_recorded", `reason=schema_error: ${submitted.errors[0]}`, `Report not recorded: ${submitted.errors[0]}`);
      result = submitted.result;
    } catch (err) {
      const code = err.message.startsWith("verdict from session") ? "attribution_rejected" : "persist_error";
      return finish("not_recorded", `reason=${code}: ${err.message}`, `Report not recorded: ${err.message}`);
    }
    const what = result.transition || "stored";
    return finish("recorded", `agent=${identity} phase=${phase.id} result=${what}`, `Report recorded: ${what} (phase ${result.phase.id} → ${result.phase.status})`);
  } catch (err) {
    return finish("error", `reason=exception: ${err.message}`);
  }
}

// The SessionStart pid must be the long-lived claude process: the hook runs in
// a transient shell whose ppid exits before the session ends, so a lease keyed
// on it always looks dead and a second session steals it. CLAUDE_PID is that
// process; fall back to ppid for a manual, non-Claude invocation.
function resolveHookPid() {
  const envPid = process.env.CLAUDE_PID ? parseInt(process.env.CLAUDE_PID, 10) : NaN;
  return Number.isInteger(envPid) ? envPid : process.ppid;
}

/**
 * SessionStart: register the session, bind it to the task the launcher chose
 * (via AGENTS_SESSION_DIR's pointer) and tell PAV. Returns the context line
 * to inject and a warning for stderr; both may be null.
 */
function registerFromPayload(payload) {
  const none = { line: null, warn: null };
  const hookInput = payload || {};
  if (hookInput.agent_id) return none;

  const sid = hookInput.session_id || process.env.AGENTS_SESSION_ID;
  if (!sid) return none;

  const sessionLib = require("./session");
  const cwd = hookInput.cwd || process.cwd();
  let repoKey;
  try { repoKey = require("./repo").repoKey(cwd); } catch { repoKey = null; }

  let taskDir = null;
  let projectDir = null;
  if (process.env.AGENTS_SESSION_DIR) {
    const existing = sessionLib.readRegistration(process.env.AGENTS_SESSION_DIR);
    if (existing && existing.task_dir) {
      taskDir = existing.task_dir;
      projectDir = repoKey ? repoKey.main_root : (existing.cwd || cwd);
    }
  }

  let hookConfig = {};
  try { hookConfig = require("./config").loadConfig(); } catch {}
  const leaseTtl = hookConfig.lease && hookConfig.lease.ttl_ms;

  const result = sessionLib.register({
    session_id: sid,
    pid: resolveHookPid(),
    cwd,
    agent: hookInput.agent_type || hookInput.agent || null,
    repo_key: repoKey ? repoKey.key : null,
    task_dir: taskDir,
    project_dir: projectDir,
    transcript_path: hookInput.transcript_path || null,
    source: hookInput.source || null,
    origin: process.env.AGENTS_SESSION_DIR ? null : "external",
    lease_ttl_ms: leaseTtl,
  });

  const port = hookConfig.pav && hookConfig.pav.port;
  if (port) sessionLib.postToPav(result.registration, port);

  if (result.registration.parent_session_id) {
    // Nested process (D28): registered under its own id, parent keeps the
    // registration and the task lease. No task priming.
    return { line: `Nested session under ${result.registration.parent_session_id}; parent retains the task lease.`, warn: null };
  }
  if (result.lease && result.lease.claimed === false && result.lease.reason === "held") {
    const h = result.lease.holder;
    const slug = taskDir ? path.basename(taskDir) : "unknown";
    return {
      warn: `Task leased by ${h.session_id} (${h.agent || "unknown"})`,
      line: `Task ${slug} is leased by session ${h.session_id} (${h.agent || "unknown"}, since ${h.acquired_at || "unknown"}). Do not write state for it.`,
    };
  }
  if (taskDir) {
    const slug = path.basename(taskDir);
    let phaseInfo = "";
    if (projectDir) {
      try {
        const state = require("./store").readState(taskDir, projectDir);
        const current = state.phases.find((p) => p.status !== "done");
        if (current) phaseInfo = `phase ${current.id} ${current.status}`;
      } catch {}
    }
    return { warn: null, line: `Bound task: ${taskDir} (${slug}${phaseInfo ? ", " + phaseInfo : ""}). Call \`state_prime\` on it first.` };
  }
  return none;
}

/**
 * SessionEnd: mark the caller's own session ended and release its lease. With
 * no id the caller cannot be identified, so the registry is left untouched
 * rather than risk unregistering a parent session via the pointer (D28).
 */
function unregisterFromPayload(payload) {
  const hookInput = payload || {};
  if (hookInput.agent_id) return;
  const sid = hookInput.session_id || process.env.AGENTS_SESSION_ID;
  if (sid) require("./session").unregister(sid);
}

function handleSessionRegister(payload, ctx) {
  try {
    const { line, warn } = registerFromPayload(payload);
    if (warn) process.stderr.write(warn + "\n");
    return line ? inject(line, ctx.eventName) : allow();
  } catch (err) {
    logHook("session-register", "error", `reason=exception: ${err.message}`);
    return allow();
  }
}

function handleSessionEnd(payload) {
  try {
    unregisterFromPayload(payload);
  } catch (err) {
    logHook("session-end", "error", `reason=exception: ${err.message}`);
  }
  return allow();
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
    if (result.decision === "deny") return denyPreToolUse(result.reason, ctx.eventName);
    if (result.decision === "ask") return askPreToolUse(result.reason, ctx.eventName);
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
      return denyPreToolUse(getCoaching(ctx.agentType), ctx.eventName);
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
        return denyPreToolUse(machineOwnedDenyReason(base), ctx.eventName);
      }
      // D47(4): hook code guard — deny edits to hooks/ and scripts/lib/{hook,guards}.js
      // when the bound task is not about hooks. Sessions without a bound task are unaffected.
      if (ctx.taskDir && isHookCodePath(resolved, ctx.projectDir || process.cwd())) {
        if (!taskMentionsHooks(ctx.taskDir)) {
          return denyPreToolUse(hookCodeDenyReason(), ctx.eventName);
        }
      }
      return allow();
    }
    // Bash: detect writes to machine-owned files via the gitcmd tokenizer.
    const command = (payload.tool_input && payload.tool_input.command) || "";
    if (command) {
      const target = detectMachineOwnedWrite(command);
      if (target) {
        return denyPreToolUse(machineOwnedDenyReason(target), ctx.eventName);
      }
      // D47(4): Bash writes to hook code paths — simple string check for
      // paths under hooks/ or scripts/lib/hook.js|guards.js in write
      // commands (sed -i, cp, mv, tee, etc.).
      if (ctx.taskDir && commandWritesHookCode(command, ctx.projectDir || process.cwd())) {
        if (!taskMentionsHooks(ctx.taskDir)) {
          return denyPreToolUse(hookCodeDenyReason(), ctx.eventName);
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
    const mdPath = require("./task").taskMdPath(taskDir, task);
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, "utf8").toLowerCase();
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
      return denyPreToolUse("do not edit task.json or state.md by hand — use `a` commands", ctx.eventName);
    }
    // Never another task's dir.
    const tasksDir = path.dirname(taskDirAbs);
    if (resolved.startsWith(tasksDir + path.sep) && !resolved.startsWith(taskDirAbs + path.sep) && resolved !== taskDirAbs) {
      return denyPreToolUse("do not edit files in another task's directory", ctx.eventName);
    }

    if (guards.manifestGuard === "deny_all" && !resolved.startsWith(taskDirAbs)) {
      return denyPreToolUse(`agent ${ctx.agentType} may only write within the task dir`, ctx.eventName);
    }
    if (guards.manifestGuard === "task_dir") {
      if (!resolved.startsWith(taskDirAbs)) {
        return denyPreToolUse(`agent ${ctx.agentType} may only write within the task dir (${taskDirAbs})`, ctx.eventName);
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
        return denyPreToolUse(`file ${rel} is not in the phase manifest (${manifest.join(", ")})`, ctx.eventName);
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
      const stopGuards = guardsFor(ctx.agentType);
      if (!stopGuards.qualityGate) return allow();
      if (payload.stop_hook_active === true) {
        return allowWithWarning("quality-gate", "validation gate skipped (already blocked this turn)", ctx.eventName);
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
    // F11: allow the Stop when a subagent is still running
    if (hasLiveSubagent(ctx.sessionId)) return allow();
    const reason = `No state advance this turn. Next: ${next.step}${next.reason ? " — " + next.reason : ""}`;
    if (payload.stop_hook_active === true) {
      return allowWithWarning("conductor-stop", reason, ctx.eventName);
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
    const isMd = require("./task").isTaskMd(resolved);
    if (!isMd && !resolved.includes(path.sep + "plan" + path.sep)) {
      return allow();
    }
    const lint = require("./lint");
    let result;
    if (isMd) {
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
    // F11: allow the Stop when a subagent is still running
    if (hasLiveSubagent(ctx.sessionId)) return allow();
    let result;
    if (payload.stop_hook_active !== true) {
      // First evaluation: the Courier acts as its own builder; validate its report.
      const reportPayload = { ...payload, agent_type: "builder" };
      result = handleReportParser(reportPayload, ctx);
    } else {
      // Second evaluation: allow with warning (D47(2) block-once-per-turn).
      result = allowWithWarning("courier-stop", "report validation skipped (already blocked this turn)", ctx.eventName);
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
  "report-capture": handleReportCapture,
  "session-register": handleSessionRegister,
  "session-end": handleSessionEnd,
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
/**
 * D57 advisory mode: `a hooks advise` creates this file; while it exists,
 * every deny/block becomes an allow that carries the reason as a
 * `systemMessage` (shown to the human, never fed back to the model, never
 * keeps a Stop alive) and a hook-log line. Injectors and persistence are
 * untouched. The framework informs; it does not block. `AGENTS_HOOKS_ADVISE_FLAG`
 * relocates the file for tests.
 */
function hooksAdvisePath() {
  return process.env.AGENTS_HOOKS_ADVISE_FLAG || path.join(os.homedir(), ".agents", "hooks.advise");
}

function hooksAdvisory() {
  if (process.env.AGENTS_HOOKS_ADVISE === "1") return true;
  try { return fs.existsSync(hooksAdvisePath()); } catch { return false; }
}

function adviseInsteadOfBlock(name, result) {
  if (!result) return result;
  const hso = result.output && result.output.hookSpecificOutput;
  const denied = hso && (hso.permissionDecision === "deny" || hso.permissionDecision === "ask");
  const blocked = result.exitCode === 2;
  if (!denied && !blocked) return result;
  const reason = blocked
    ? (result.output && result.output.systemMessage) || "blocked"
    : hso.permissionDecisionReason || "denied";
  appendHookLog(`${name} advisory (would have ${blocked ? "blocked" : hso.permissionDecision}): ${reason}`);
  return { exitCode: 0, output: { systemMessage: `[advisory] ${name}: ${reason}` } };
}

function runHook(name, payload, ctxOverride) {
  const handler = HANDLERS[name];
  if (!handler) return { exitCode: 0, output: null };
  if (hooksDisabled()) return { exitCode: 0, output: null };
  if (hooksAdvisory()) return adviseInsteadOfBlock(name, runHookStrict(name, payload, ctxOverride));
  return runHookStrict(name, payload, ctxOverride);
}

function runHookStrict(name, payload, ctxOverride) {
  const handler = HANDLERS[name];

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
    // D50: every hookSpecificOutput carries hookEventName from the stdin
    // payload's hook_event_name, falling back to the event the handler is
    // wired for.
    eventName: (p && p.hook_event_name) || HANDLER_WIRING[name] || null,
    ...(ctxOverride || {}),
  };

  return handler(p, ctx);
}

module.exports = {
  resolveSession,
  extractJsonReport,
  extractJsonCandidates,
  lastAssistantText,
  runHook,
  HANDLERS,
  HANDLER_WIRING,
  hookLogPath,
  hooksDisabled,
  hooksDisabledPath,
  hooksAdvisory,
  hooksAdvisePath,
  adviseInsteadOfBlock,
  handlePrime,
  handleSpawnGuard,
  handleReportParser,
  handleCheckpointCapture,
  handleReportCapture,
  handleSessionRegister,
  handleSessionEnd,
  registerFromPayload,
  unregisterFromPayload,
  resolveHookPid,
  logHook,
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
  denyPreToolUse,
  askPreToolUse,
  rewriteInput,
  inject,
  blockStop,
  allowWithWarning,
  blockReasonWithSkeleton,
  taskMentionsHooks,
  REPORTING_AGENTS,
  recordSubagentType,
  resolveSubagentType,
  hasLiveSubagent,
  fastModeTouch,
};
