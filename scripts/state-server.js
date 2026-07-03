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
// Path resolution:
//   Uses CLAUDE_PROJECT_DIR env var (available since CC v2.1.139).
//   Falls back to process.cwd() with a stderr warning if not set.

"use strict";

const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const projectDir = process.env.CLAUDE_PROJECT_DIR || (() => {
  console.error(
    "AGENTS state-server: CLAUDE_PROJECT_DIR not set, using cwd -- " +
    "state.json paths may be incorrect for user-scoped servers."
  );
  return process.cwd();
})();

/**
 * Assert that a resolved path is contained within projectDir.
 * Guards against path traversal via malicious task_dir values like "../../../etc".
 * @throws {Error} if resolved escapes projectDir
 */
function assertWithinProject(resolved, taskDir) {
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
function resolveStatePath(taskDir) {
  const resolved = path.resolve(projectDir, taskDir, "state.json");
  assertWithinProject(resolved, taskDir);
  return resolved;
}

/**
 * Temporary file path used for atomic writes.
 * @throws {Error} if task_dir traverses outside projectDir
 */
function resolveTmpPath(taskDir) {
  const resolved = path.resolve(projectDir, taskDir, ".state.json.tmp");
  assertWithinProject(resolved, taskDir);
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
function readState(taskDir) {
  const statePath = resolveStatePath(taskDir);
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
function writeState(taskDir, state) {
  const statePath = resolveStatePath(taskDir);
  const tmpPath = resolveTmpPath(taskDir);
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, statePath);
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
      task_dir: z.string().describe(
        'Relative path to the task directory, e.g. ".tasks/042-add-auth"'
      ),
      slug: z.string().describe('Task slug, e.g. "add-auth"'),
      phases: z.array(
        z.object({
          id: z.number().int().positive(),
          name: z.string(),
        })
      ).describe("Phase list with numeric id and name for each phase"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ task_dir, slug, phases }) => {
    const statePath = resolveStatePath(task_dir);
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
      phases: phases.map(({ id, name }) => ({
        id,
        name,
        status: "not_started",
        owner: null,
        started: null,
        completed: null,
        blocked_by: [],
        parallel_group: null,
        execution: { model: null, effort: null, agent_type: null },
      })),
      flags: [],
    };

    writeState(task_dir, state);
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
    },
    annotations: { readOnlyHint: false },
  },
  async ({ task_dir, phase_id, phase_status, owner, task_status, started, completed }) => {
    const state = readState(task_dir);

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
    }

    // Auto-complete task when all phases are done
    const allDone = state.phases.every((p) => p.status === "done");
    if (allDone && state.status !== "done") {
      state.status = "done";
    }

    state.updated = today();
    writeState(task_dir, state);

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
      task_dir: z.string().describe("Relative path to the task directory"),
      phase_id: z.number().int().positive().describe("Phase raising the flag"),
      type: z.enum(["needs_human", "blocked", "error", "review_ready"]).describe(
        "Flag type"
      ),
      message: z.string().describe("Human-readable description of the flag"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ task_dir, phase_id, type, message }) => {
    const state = readState(task_dir);

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
    writeState(task_dir, state);

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
      task_dir: z.string().describe("Relative path to the task directory"),
      flag_id: z.string().describe(
        'ID of the flag to remove, e.g. "f-2-1751500000000"'
      ),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ task_dir, flag_id }) => {
    const state = readState(task_dir);

    const idx = state.flags.findIndex((f) => f.id === flag_id);
    if (idx === -1) {
      throw new Error(
        `No flag with id "${flag_id}". ` +
        `Current flag ids: ${state.flags.map((f) => f.id).join(", ") || "(none)"}`
      );
    }

    state.flags.splice(idx, 1);
    state.updated = today();
    writeState(task_dir, state);

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
      task_dir: z.string().describe("Relative path to the task directory"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_dir }) => {
    const state = readState(task_dir);
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
      "resume. Replaces reading the full task.md + all phase plans to reconstruct " +
      "position. Phase 4 preview -- templates will reference this tool in Phase 4.",
    inputSchema: {
      task_dir: z.string().describe("Relative path to the task directory"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_dir }) => {
    const state = readState(task_dir);

    const doneCount = state.phases.filter((p) => p.status === "done").length;
    const total = state.phases.length;

    // Find current phase: first non-done phase
    const current = state.phases.find((p) => p.status !== "done");
    const currentStr = current
      ? `Phase ${current.id} (${current.name}) -- ${current.status}, ${current.owner || "unowned"}`
      : "All phases complete";

    const flagCount = state.flags.length;
    const flagStr = flagCount > 0
      ? `${flagCount} active (${state.flags.map((f) => `${f.type}:phase${f.phase}`).join(", ")})`
      : "None";

    const prime = [
      `Task: ${state.task} (${state.status})`,
      `Phases: ${doneCount}/${total} complete`,
      `Current: ${currentStr}`,
      `Flags: ${flagStr}`,
    ].join("\n");

    return {
      content: [{ type: "text", text: prime }],
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
