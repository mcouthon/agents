#!/usr/bin/env node
// AGENTS State Server -- MCP server for state.json management
//
// Exposes 6 tools for deterministic, atomic state.json reads and writes.
// Agents call these tools instead of hand-editing JSON, eliminating malformed
// JSON errors and simplifying template prose.
//
// Installation (user-scoped, works across all repos):
//   cd /path/to/agents && npm install
//   claude mcp add --scope user state-manager node /path/to/agents/scripts/state-server.js
//
// Verify installation:
//   claude mcp list   # should show "state-manager" server
//
// For MCP Inspector testing only (NOT for full Conductor workflow -- see bug #13898):
//   npx @modelcontextprotocol/inspector node scripts/state-server.js
//
// Note on project-scoped .mcp.json (local scope):
//   Local-scope .mcp.json works for MCP Inspector testing only, NOT for full
//   Conductor workflow testing where subagents need MCP access. Project-scoped
//   MCP servers have a known bug (GitHub issue #13898) where custom subagents
//   cannot access them and hallucinate results instead. Use user-scoped
//   installation (--scope user) for any end-to-end workflow testing.
//
// Tools provided:
//   state_init         -- Create state.json with initial phase list
//   state_update       -- Update phase status, owner, timestamps
//   state_flag         -- Add a flag (auto-generates ID)
//   state_clear_flag   -- Remove a flag by ID
//   state_read         -- Return full state.json contents
//   state_prime        -- Return compact summary for fast resume
//
// Path resolution (priority chain per tool call):
//   1. project_dir parameter passed by the calling agent
//   2. CLAUDE_PROJECT_DIR env var (Claude Code sets this automatically)
//   3. process.cwd() (last resort; may be incorrect for user-scoped servers)
//
//   The project_dir parameter is optional on every tool. Include it when
//   CLAUDE_PROJECT_DIR is not set (e.g., VS Code user-scoped MCP config).

// Dependency check — give a clear message instead of a raw stack trace
try {
  require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  require.resolve("zod");
} catch {
  const repoDir = require("path").resolve(__dirname, "..");
  process.stderr.write(
    `[state-server] Missing dependencies. Run: cd ${repoDir} && npm install\n`
  );
  process.exit(1);
}

"use strict";

const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project root directory for a single tool call.
 * Priority: callProjectDir argument > CLAUDE_PROJECT_DIR env var > process.cwd().
 * Logs a warning to stderr when falling back to cwd.
 * @param {string|undefined} callProjectDir - Value of the project_dir tool parameter
 * @returns {string} Absolute project root path
 */
function resolveProjectDir(callProjectDir) {
  if (callProjectDir) return path.resolve(callProjectDir);
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  console.error(
    "AGENTS state-server: CLAUDE_PROJECT_DIR not set and project_dir not provided, " +
    "using cwd -- state.json paths may be incorrect for user-scoped servers."
  );
  return process.cwd();
}

/**
 * Assert that a resolved path is contained within projectDir.
 * Guards against path traversal via malicious task_dir values like "../../../etc".
 * @throws {Error} if resolved escapes projectDir
 */
function assertWithinProject(resolved, taskDir, projectDir) {
  const safeRoot = path.resolve(projectDir);
  if (!resolved.startsWith(safeRoot + path.sep) && resolved !== safeRoot) {
    throw new Error(`task_dir "${taskDir}" resolves outside project directory`);
  }
}

/**
 * Resolve a relative task_dir (e.g. ".tasks/042-add-auth") to an absolute
 * path for state.json. Always resolves against projectDir, not cwd.
 * @throws {Error} if task_dir traverses outside projectDir
 */
function resolveStatePath(taskDir, projectDir) {
  const resolved = path.resolve(projectDir, taskDir, "state.json");
  assertWithinProject(resolved, taskDir, projectDir);
  return resolved;
}

/**
 * Temporary file path used for atomic writes.
 * @throws {Error} if task_dir traverses outside projectDir
 */
function resolveTmpPath(taskDir, projectDir) {
  const resolved = path.resolve(projectDir, taskDir, ".state.json.tmp");
  assertWithinProject(resolved, taskDir, projectDir);
  return resolved;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns today's date as YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Atomic file I/O
// ---------------------------------------------------------------------------

/** Read and parse state.json. Throws a user-friendly error on failure. */
function readState(taskDir, projectDir) {
  const statePath = resolveStatePath(taskDir, projectDir);
  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}. Run state_init first.`);
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse state.json at ${statePath}: ${e.message}`);
  }
}

/** Write state atomically: write to .tmp, then rename. */
function writeState(taskDir, state, projectDir) {
  const statePath = resolveStatePath(taskDir, projectDir);
  const tmpPath = resolveTmpPath(taskDir, projectDir);
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, statePath);
}

// ---------------------------------------------------------------------------
// Tasks index
// ---------------------------------------------------------------------------

/** Path to the aggregated tasks.json index. */
function tasksIndexPath(projectDir) {
  return path.resolve(projectDir, ".tasks", "tasks.json");
}

/** Tmp path for atomic write of tasks.json. */
function tasksIndexTmpPath(projectDir) {
  return path.resolve(projectDir, ".tasks", ".tasks.json.tmp");
}

/**
 * Scan all state.json files under .tasks/ and build a summary entry for each.
 * Returns the array of task entries.
 */
function buildTasksIndex(projectDir) {
  const tasksRoot = path.resolve(projectDir, ".tasks");
  if (!fs.existsSync(tasksRoot)) return [];

  const entries = [];
  for (const name of fs.readdirSync(tasksRoot)) {
    const dir = path.join(tasksRoot, name);
    const stateFile = path.join(dir, "state.json");
    if (!fs.existsSync(stateFile)) continue;

    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (_) {
      continue; // skip malformed files
    }

    const totalPhases = state.phases.length;
    const completedPhases = state.phases.filter((p) => p.status === "done").length;
    const currentPhaseObj = state.phases.find((p) => p.status !== "done");
    const currentPhase = currentPhaseObj
      ? {
          id: currentPhaseObj.id,
          name: currentPhaseObj.name,
          status: currentPhaseObj.status,
          owner: currentPhaseObj.owner,
        }
      : null;

    entries.push({
      slug: state.task,
      dir: path.relative(projectDir, dir),
      status: state.status,
      total_phases: totalPhases,
      completed_phases: completedPhases,
      current_phase: currentPhase,
      flags: state.flags.length,
      updated: state.updated,
    });
  }

  return entries;
}

/**
 * Rebuild .tasks/tasks.json as a side-effect of any write operation.
 * Uses the same tmp+rename atomic pattern as writeState().
 */
function updateTasksIndex(projectDir) {
  const entries = buildTasksIndex(projectDir);
  const index = { updated: today(), tasks: entries };
  const json = JSON.stringify(index, null, 2);
  fs.writeFileSync(tasksIndexTmpPath(projectDir), json, "utf8");
  fs.renameSync(tasksIndexTmpPath(projectDir), tasksIndexPath(projectDir));
}

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

// OWNER_VALUES is used at runtime to validate the `owner` field in state_update.
// Phase statuses, task statuses, and flag types are declared inline in each
// tool's Zod schema below, which serves as the single source of truth.
const OWNER_VALUES = ["explorer", "builder", "reviewer", "committer", null];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "state-manager",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: state_init
// ---------------------------------------------------------------------------

server.registerTool(
  "state_init",
  {
    description:
      "Create state.json in the given task directory with an initial phase list. " +
      "Fails if state.json already exists (idempotency guard). " +
      "All phases start as not_started. Top-level task status is set to planning.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe(
        'Relative path to the task directory, e.g. ".tasks/042-add-auth"'
      ),
      slug: z.string().describe('Task slug, e.g. "add-auth"'),
      phases: z.array(
        z.object({
          id: z.number().int().positive(),
          name: z.string(),
          blocked_by: z.array(z.number().int().positive()).optional()
            .describe("Phase IDs that must complete before this phase can start"),
          parallel_group: z.string().nullable().optional()
            .describe('Group identifier for concurrent execution eligibility (e.g. "A")'),
        })
      ).describe("Phase list with numeric id, name, and optional dependency data"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ project_dir, task_dir, slug, phases }) => {
    const projectDir = resolveProjectDir(project_dir);
    const statePath = resolveStatePath(task_dir, projectDir);
    if (fs.existsSync(statePath)) {
      throw new Error(
        `state.json already exists at ${statePath}. ` +
        "Use state_update to modify existing state."
      );
    }

    const state = {
      task: slug,
      status: "planning",
      updated: today(),
      phases: phases.map(({ id, name, blocked_by, parallel_group }) => ({
        id,
        name,
        status: "not_started",
        owner: null,
        started: null,
        completed: null,
        blocked_by: blocked_by || [],
        parallel_group: parallel_group ?? null,
        execution: { model: null, effort: null, agent_type: null, estimated_scope: null },
      })),
      flags: [],
    };

    // Validate blocked_by references
    const phaseIds = new Set(state.phases.map((p) => p.id));
    for (const phase of state.phases) {
      for (const depId of phase.blocked_by) {
        if (!phaseIds.has(depId)) {
          throw new Error(
            `Phase ${phase.id} has blocked_by reference to non-existent phase ${depId}. ` +
            `Available phase IDs: ${[...phaseIds].join(", ")}`
          );
        }
      }
    }

    writeState(task_dir, state, projectDir);
    updateTasksIndex(projectDir);
    return {
      content: [
        {
          type: "text",
          text: `Created state.json at ${statePath} with ${phases.length} phase(s).`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: state_update
// ---------------------------------------------------------------------------

server.registerTool(
  "state_update",
  {
    description:
      "Update phase or task-level fields in state.json. " +
      "Only provided fields are applied -- providing phase_id + owner without " +
      "phase_status is valid and updates only the owner. " +
      "Use started: true or completed: true to auto-set today's date. " +
      "Auto-sets task status to done when all phases reach done status. " +
      "Always idempotent: re-applying the same values is safe.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
      phase_id: z.number().int().positive().optional().describe(
        "Phase to update (omit for task-level-only updates)"
      ),
      phase_status: z.enum(["not_started", "planned", "reviewed", "in_progress", "done"]).optional().describe(
        "New status for the phase"
      ),
      owner: z.string().nullable().optional().describe(
        "Agent type (explorer|builder|reviewer|committer) or null to clear"
      ),
      task_status: z.enum(["planning", "in_progress", "done", "blocked"]).optional().describe(
        "New top-level task status (always accepted; idempotent)"
      ),
      started: z.boolean().optional().describe(
        "If true, set phase started date to today"
      ),
      completed: z.boolean().optional().describe(
        "If true, set phase completed date to today"
      ),
      blocked_by: z.array(z.number().int().positive()).optional().describe(
        "Replace the phase's blocked_by array (full replacement, not merge)"
      ),
      parallel_group: z.string().nullable().optional().describe(
        'Set or clear the parallel group identifier (e.g. "A" or null)'
      ),
      execution_model: z.enum(["sonnet", "opus", "haiku"]).nullable().optional().describe(
        "Advisory model for this phase (sonnet|opus|haiku or null to clear)"
      ),
      execution_effort: z.enum(["low", "medium", "high"]).nullable().optional().describe(
        "Advisory effort level for this phase (low|medium|high or null to clear)"
      ),
      execution_agent_type: z.enum(["explorer", "builder", "reviewer"]).nullable().optional().describe(
        "Which agent role should execute this phase (or null to clear)"
      ),
      execution_estimated_scope: z.enum(["small", "medium", "large"]).nullable().optional().describe(
        "Advisory scope hint for time/cost estimation (or null to clear)"
      ),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ project_dir, task_dir, phase_id, phase_status, owner: rawOwner, task_status, started, completed, blocked_by, parallel_group, execution_model, execution_effort, execution_agent_type, execution_estimated_scope }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir);

    // Normalize empty string to null so agents can clear owner with owner: ""
    const owner = rawOwner === "" ? null : rawOwner;

    // Validate owner value
    if (owner !== undefined && owner !== null && !OWNER_VALUES.includes(owner)) {
      throw new Error(
        `Invalid owner "${owner}". Must be one of: ${OWNER_VALUES.filter(v => v !== null).join(", ")}, or null.`
      );
    }

    // Apply task-level status
    if (task_status !== undefined) {
      state.status = task_status;
    }

    // Apply phase-level changes
    if (phase_id !== undefined) {
      const phase = state.phases.find((p) => p.id === phase_id);
      if (!phase) {
        throw new Error(
          `Phase ${phase_id} not found. Available phases: ${state.phases.map((p) => p.id).join(", ")}`
        );
      }

      if (phase_status !== undefined) phase.status = phase_status;
      if (owner !== undefined) phase.owner = owner;
      if (started === true) phase.started = today();
      if (completed === true) phase.completed = today();

      if (blocked_by !== undefined) {
        // Validate references
        const phaseIds = new Set(state.phases.map((p) => p.id));
        for (const depId of blocked_by) {
          if (!phaseIds.has(depId)) {
            throw new Error(
              `blocked_by reference to non-existent phase ${depId}. ` +
              `Available phase IDs: ${[...phaseIds].join(", ")}`
            );
          }
        }
        phase.blocked_by = blocked_by;
      }
      if (parallel_group !== undefined) phase.parallel_group = parallel_group;
      if (execution_model !== undefined) phase.execution.model = execution_model;
      if (execution_effort !== undefined) phase.execution.effort = execution_effort;
      if (execution_agent_type !== undefined) phase.execution.agent_type = execution_agent_type;
      if (execution_estimated_scope !== undefined) phase.execution.estimated_scope = execution_estimated_scope;
    }

    // Auto-complete task when all phases are done
    const allDone = state.phases.every((p) => p.status === "done");
    if (allDone && state.status !== "done") {
      state.status = "done";
    }

    state.updated = today();
    writeState(task_dir, state, projectDir);
    updateTasksIndex(projectDir);

    const updatedPhase = phase_id !== undefined
      ? state.phases.find((p) => p.id === phase_id)
      : null;

    const summary = updatedPhase
      ? `Phase ${updatedPhase.id} (${updatedPhase.name}): status=${updatedPhase.status}, owner=${updatedPhase.owner}`
      : `Task status: ${state.status}`;

    return {
      content: [{ type: "text", text: `Updated state.json. ${summary}` }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: state_flag
// ---------------------------------------------------------------------------

server.registerTool(
  "state_flag",
  {
    description:
      "Add a flag to state.json requiring attention. " +
      "Auto-generates a unique flag ID in the format f-{phase_id}-{timestamp}. " +
      "Returns the generated ID so it can be passed to state_clear_flag later.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
      phase_id: z.number().int().positive().describe("Phase raising the flag"),
      type: z.enum(["needs_human", "blocked", "error", "review_ready"]).describe(
        "Flag type"
      ),
      message: z.string().describe("Human-readable description of the flag"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ project_dir, task_dir, phase_id, type, message }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir);

    const phase = state.phases.find((p) => p.id === phase_id);
    if (!phase) {
      throw new Error(
        `Phase ${phase_id} not found. Available phases: ${state.phases.map((p) => p.id).join(", ")}`
      );
    }

    const id = `f-${phase_id}-${Date.now()}`;
    const flag = {
      id,
      phase: phase_id,
      type,
      message,
      raised: today(),
    };

    state.flags.push(flag);
    state.updated = today();
    writeState(task_dir, state, projectDir);
    updateTasksIndex(projectDir);

    return {
      content: [
        {
          type: "text",
          text:
            `Flag added. id=${id}, phase=${phase_id}, type=${type}. ` +
            `Total flags: ${state.flags.length}.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: state_clear_flag
// ---------------------------------------------------------------------------

server.registerTool(
  "state_clear_flag",
  {
    description:
      "Remove a flag from state.json by its ID. " +
      "ID-based removal (not index-based) prevents race conditions in parallel " +
      "execution scenarios. Returns an error if no flag with that ID exists.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
      flag_id: z.string().describe(
        'ID of the flag to remove, e.g. "f-2-1751500000000"'
      ),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ project_dir, task_dir, flag_id }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir);

    const idx = state.flags.findIndex((f) => f.id === flag_id);
    if (idx === -1) {
      throw new Error(
        `No flag with id "${flag_id}". ` +
        `Current flag ids: ${state.flags.map((f) => f.id).join(", ") || "(none)"}`
      );
    }

    state.flags.splice(idx, 1);
    state.updated = today();
    writeState(task_dir, state, projectDir);
    updateTasksIndex(projectDir);

    return {
      content: [
        {
          type: "text",
          text: `Flag "${flag_id}" removed. Remaining flags: ${state.flags.length}.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: state_read
// ---------------------------------------------------------------------------

server.registerTool(
  "state_read",
  {
    description:
      "Return the full contents of state.json as formatted JSON. " +
      "Use this for position determination instead of reading the file directly.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project_dir, task_dir }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir);
    return {
      content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: state_prime
// ---------------------------------------------------------------------------

server.registerTool(
  "state_prime",
  {
    description:
      "Return a compact (~50-100 token) summary of state.json for fast session " +
      "resume. Conductor calls this at session start instead of reading the full " +
      "task.md + all phase plans to reconstruct position.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project_dir, task_dir }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir);

    const doneCount = state.phases.filter((p) => p.status === "done").length;
    const total = state.phases.length;

    // Find current phase: first non-done phase
    const current = state.phases.find((p) => p.status !== "done");
    const currentStr = current
      ? `Phase ${current.id} (${current.name}) -- ${current.status}, ${current.owner || "unowned"}`
      : "All phases complete";

    // Find blocked phases (non-done phases with unsatisfied blocked_by)
    const blocked = state.phases.filter(
      (p) => p.status !== "done" && p.blocked_by && p.blocked_by.length > 0 &&
        p.blocked_by.some((depId) => {
          const dep = state.phases.find((d) => d.id === depId);
          return dep && dep.status !== "done";
        })
    );
    const blockerStr = blocked.length > 0
      ? blocked.map((p) => `Phase ${p.id} (blocked by ${p.blocked_by.join(",")})`).join("; ")
      : "None";

    const flagCount = state.flags.length;
    const flagStr = flagCount > 0
      ? `${flagCount} active (${state.flags.map((f) => `${f.type}:phase${f.phase}`).join(", ")})`
      : "None";

    // Find phases that come after current (for "Next" line)
    const currentIdx = current ? state.phases.indexOf(current) : -1;
    const upcoming = currentIdx >= 0
      ? state.phases.slice(currentIdx + 1).filter((p) => p.status !== "done")
      : [];

    // Check for parallel groups in upcoming phases
    const nextGroup = upcoming.length > 0 && upcoming[0].parallel_group
      ? upcoming.filter((p) => p.parallel_group === upcoming[0].parallel_group)
      : [];

    const nextStr = nextGroup.length > 1
      ? `Phases ${nextGroup.map((p) => p.id).join("+")} (${nextGroup.map((p) => p.name).join(", ")}) in parallel group ${nextGroup[0].parallel_group}`
      : upcoming.length > 0
        ? `Phase ${upcoming[0].id} (${upcoming[0].name})`
        : "None";

    const prime = [
      `Task: ${state.task} (${state.status})`,
      `Phases: ${doneCount}/${total} complete`,
      `Current: ${currentStr}`,
      `Blockers: ${blockerStr}`,
      `Flags: ${flagStr}`,
      `Next: ${nextStr}`,
    ].join("\n");

    return {
      content: [{ type: "text", text: prime }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: tasks_list
// ---------------------------------------------------------------------------

server.registerTool(
  "tasks_list",
  {
    description:
      "Return the aggregated tasks index from .tasks/tasks.json. " +
      "If the index file does not exist, scans all task directories and computes it on the fly. " +
      "Use this for a dashboard view of all tasks without reading individual state.json files.",
    inputSchema: z.object({
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project_dir } = {}) => {
    const projectDir = resolveProjectDir(project_dir);
    const indexPath = tasksIndexPath(projectDir);
    let index;
    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch (_) {
        // Fall through to compute on the fly if file is malformed
        index = null;
      }
    }
    if (!index) {
      index = { updated: today(), tasks: buildTasksIndex(projectDir) };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(index, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AGENTS state-server running on stdio.");
}

main().catch((err) => {
  console.error("AGENTS state-server fatal error:", err);
  process.exit(1);
});
