#!/usr/bin/env node
// AGENTS State Server -- thin MCP surface over scripts/lib/*
//
// Every handler is a zod schema (input validation) + one lib call
// (delegation) + format output. No handler contains transition logic,
// capping, rendering, migration code, or an if on schema version.
//
// Installation (user-scoped, works across all repos):
//   cd /path/to/agents && npm install
//   claude mcp add --scope user state-manager node /path/to/agents/scripts/state-server.js

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

const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const lib = require("./lib");
const { repoKey } = lib.repo;
const { resolveProjectDir, resolveProjectDirChecked } = lib.projectDir;
const { listTasks } = lib.tasksIndex;
const codeIndex = lib.codeIndex;
const memorySeed = lib.memorySeed;
const stateOps = lib.stateOps;
const { resolvePolicy } = lib.policy;
const { createTask } = lib.task;

const PROJECT_DIR_DESC =
  "Absolute path to the workspace root. Optional -- when omitted the server uses " +
  "CLAUDE_PROJECT_DIR, then the process working directory. Pass it only when you know " +
  "the exact path; never guess one.";

const server = new McpServer({
  name: "state-manager",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: state_init
// ---------------------------------------------------------------------------

server.registerTool("state_init", {
  description:
    "Create task.json (v2) in the given task directory with an initial phase list, " +
    "and render state.md. Fails if task.json already exists (idempotency guard). " +
    "All phases start as not_started. Top-level task status is set to planning. " +
    "state.json is never created (D33: task.json is the sole truth; a v1 state.json " +
    "in an existing dir is migrated on first touch).",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe('Absolute path to the task directory, or a slug/number resolvable via `a tasks root`'),
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
}, async ({ project_dir, task_dir, slug, phases }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.initState(projectDir, task_dir, slug, phases);
  return {
    content: [{ type: "text", text: `Created task.json at ${result.taskPath} with ${result.phaseCount} phase(s).` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_update
// ---------------------------------------------------------------------------

server.registerTool("state_update", {
  description:
    "Update phase or task-level fields in state.json. " +
    "Only provided fields are applied -- providing phase_id + owner without " +
    "phase_status is valid and updates only the owner. " +
    "Use started: true or completed: true to auto-set today's date. " +
    "Auto-sets task status to done when all phases reach done status. " +
    "Always idempotent: re-applying the same values is safe.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
    phase_id: z.number().int().positive().optional().describe(
      "Phase to update (omit for task-level-only updates)"
    ),
    phase_status: z.enum([
      "not_started", "planned", "reviewed", "approved", "in_progress",
      "implemented", "committed", "landed", "done", "failed", "skipped",
    ]).optional().describe("New status for the phase (v2 tasks: transition must be legal)"),
    owner: z.string().nullable().optional().describe(
      "Agent type (explorer|builder|reviewer|committer) or null to clear"
    ),
    task_status: z.enum([
      "planning", "in_progress", "done", "blocked", "failed", "needs_human", "review_ready",
    ]).optional().describe("New top-level task status (v2 tasks: blocked/needs_human/review_ready mapped per D29)"),
    started: z.boolean().optional().describe("If true, set phase started date to today"),
    completed: z.boolean().optional().describe("If true, set phase completed date to today"),
    blocked_by: z.array(z.number().int().positive()).optional().describe(
      "Replace the phase's blocked_by array (full replacement, not merge)"
    ),
    parallel_group: z.string().nullable().optional().describe(
      'Set or clear the parallel group identifier (e.g. "A" or null)'
    ),
    commits: z.array(z.string()).optional().describe(
      "D34: record commit SHAs on the phase before the transition runs. " +
      "Each SHA is resolved to full form via git rev-parse --verify; an " +
      "unknown SHA is rejected. The commits_recorded guard then verifies " +
      "them as today."
    ),
    execution_model: z.enum(["sonnet", "opus", "haiku"]).nullable().optional().describe(
      "Deprecated — no longer read by the Conductor. Kept for backward compatibility (sonnet|opus|haiku or null to clear)"
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
}, async ({ project_dir, task_dir, phase_id, phase_status, owner, task_status, started, completed, blocked_by, parallel_group, commits, execution_model, execution_effort, execution_agent_type, execution_estimated_scope }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.updateState(projectDir, task_dir, {
    phase_id, phase_status, owner, task_status, started, completed,
    blocked_by, parallel_group, commits, execution_model, execution_effort,
    execution_agent_type, execution_estimated_scope,
  });
  return {
    content: [{ type: "text", text: `Updated ${result.file}. ${result.summary}` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_add_phases
// ---------------------------------------------------------------------------

server.registerTool("state_add_phases", {
  description:
    "Append one or more new phases to an existing task.json. " +
    "Complements state_init (create-once): use this when a task grows phases " +
    "mid-flight so task.json stays in sync with task.md. New phases start as " +
    "not_started. Re-adding an existing phase id is rejected as a duplicate " +
    "(never silently overwrites an in-progress phase). The whole batch is " +
    "validated before any write -- on any error, task.json is left unchanged.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
    phases: z.array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        blocked_by: z.array(z.number().int().positive()).optional()
          .describe("Phase IDs that must complete before this phase can start"),
        parallel_group: z.string().nullable().optional()
          .describe('Group identifier for concurrent execution eligibility (e.g. "A")'),
      })
    ).min(1).describe(
      "New phases to append. Each has a numeric id, name, and optional dependency data. " +
      "Rejected as a whole if any id duplicates an existing phase or another id in the batch."
    ),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, task_dir, phases }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.addPhases(projectDir, task_dir, phases);
  return {
    content: [{ type: "text", text: `Added ${result.count} phase(s): ${result.summary}. Total phases: ${result.totalPhases}.` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_flag
// ---------------------------------------------------------------------------

server.registerTool("state_flag", {
  description:
    "Add a flag to state.json requiring attention. " +
    "Auto-generates a unique flag ID in the format f-{phase_id}-{timestamp}. " +
    "Returns the generated ID so it can be passed to state_clear_flag later.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
    phase_id: z.number().int().positive().describe("Phase raising the flag"),
    type: z.enum(["needs_human", "blocked", "error", "review_ready"]).describe("Flag type"),
    message: z.string().describe("Human-readable description of the flag"),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, task_dir, phase_id, type, message }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.addFlag(projectDir, task_dir, phase_id, type, message);
  return {
    content: [{ type: "text", text: `Flag added. id=${result.id}, phase=${result.phaseId}, type=${result.type}. Total flags: ${result.flagCount}.` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_clear_flag
// ---------------------------------------------------------------------------

server.registerTool("state_clear_flag", {
  description:
    "Remove a flag from state.json by its ID. " +
    "ID-based removal (not index-based) prevents race conditions in parallel " +
    "execution scenarios. Returns an error if no flag with that ID exists.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
    flag_id: z.string().describe('ID of the flag to remove, e.g. "f-2-1751500000000"'),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, task_dir, flag_id }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.clearFlag(projectDir, task_dir, flag_id);
  return {
    content: [{ type: "text", text: `Flag "${result.flagId}" removed. Remaining flags: ${result.remainingFlags}.` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_read
// ---------------------------------------------------------------------------

server.registerTool("state_read", {
  description:
    "Return the full contents of task.json (v2) as formatted JSON. " +
    "Use this for position determination instead of reading the file directly. " +
    "A v1 state.json in an unmigrated dir is migrated on first touch (D33).",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir, task_dir }) => {
  const projectDir = resolveProjectDir(project_dir);
  const state = stateOps.readStateRaw(projectDir, task_dir);
  return {
    content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_prime
// ---------------------------------------------------------------------------

server.registerTool("state_prime", {
  description:
    "Return a compact summary for fast session resume. " +
    "For migrated tasks (task.json v2), returns the `a next` output " +
    "(step, phase_ids, agent, checkpoint, reason, caps). " +
    "For unmigrated tasks (state.json v1), returns the legacy summary. " +
    "Conductor calls this at session start instead of reading the full " +
    "task.md + all phase plans to reconstruct position.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir, task_dir }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.primeState(projectDir, task_dir);
  const text = result.format === "json"
    ? JSON.stringify(result.data, null, 2)
    : result.data;
  return { content: [{ type: "text", text }] };
});

// ---------------------------------------------------------------------------
// Tool: tasks_list
// ---------------------------------------------------------------------------

server.registerTool("tasks_list", {
  description:
    "Return the aggregated tasks index from the central tasks root. " +
    "If the index file does not exist, scans all task directories and computes it on the fly. " +
    "Use this for a dashboard view of all tasks without reading individual task.json files.",
  inputSchema: z.object({
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
  }),
  annotations: { readOnlyHint: true },
}, async ({ project_dir } = {}) => {
  const { projectDir, warning } = resolveProjectDirChecked(project_dir);
  const index = listTasks(projectDir, warning);
  return {
    content: [{ type: "text", text: JSON.stringify(index, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: task_create
// ---------------------------------------------------------------------------

server.registerTool("task_create", {
  description:
    "Create a new task directory with an atomically-assigned number, " +
    "task.md skeleton, and state.json. The task number (NNN) is max-existing + 1 " +
    "computed under a lock so two concurrent creates never collide. " +
    "Returns the absolute task_dir, slug, and number.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    title: z.string().describe("Human-readable task title"),
    slug: z.string().optional().describe("URL-safe slug (auto-derived from title if omitted)"),
    mode: z.enum(["fast", "plan-only", "full"]).optional().describe("Task mode persisted in state.json"),
    phases: z.array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        blocked_by: z.array(z.number().int().positive()).optional(),
        parallel_group: z.string().nullable().optional(),
      })
    ).optional().describe("Initial phase list (empty if omitted)"),
    description: z.string().optional().describe("Task description for the task.md skeleton"),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, title, slug, mode, phases, description }) => {
  const projectDir = resolveProjectDir(project_dir);
  const key = repoKey(projectDir);
  const sid = stateOps.getMcpSessionId();
  const result = createTask({
    repo: key,
    title,
    slug,
    mode,
    phases: phases || [],
    description: description || "",
    session_id: sid,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: repo_policy
// ---------------------------------------------------------------------------

server.registerTool("repo_policy", {
  description:
    "Resolve the push/worktree/merge policy for a repository. " +
    "Keys by main-root realpath (worktree rollup via git common dir), " +
    "falls back to origin URL alias. Unlisted repos get " +
    "{push: ask, worktree: auto, merge: manual}. " +
    "Accepts the string form (e.g. \"direct\") for backward compatibility.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir } = {}) => {
  const candidate = project_dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const policy = resolvePolicy(candidate);
  return {
    content: [{ type: "text", text: JSON.stringify(policy, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: state_next
// ---------------------------------------------------------------------------

server.registerTool("state_next", {
  description:
    "Compute the next action for a task: {step, phase_ids, agent, checkpoint, " +
    "reason, caps, overrides}. Pure function of task.json + git facts. " +
    "Requires a migrated task (task.json v2). Steps: plan, review_plan, approve, " +
    "build, review_code, fix, commit, land, pr, ci_wait, consolidate, done, blocked.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir, task_dir }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.nextState(projectDir, task_dir);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: task_set
// ---------------------------------------------------------------------------

server.registerTool("task_set", {
  description:
    "Set a task-level knob on a migrated task (task.json v2). " +
    "Knobs: mode (full|fast|plan-only), review_plan (true|false), " +
    "review_code (true|false), approve (ask|auto), commit (per_phase|at_end), " +
    "parallel (integer), enforcement (deny|warn), land (per_phase|at_end). " +
    "Requires a migrated task.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().describe("Absolute path to the task directory, or a slug/number resolvable via `a tasks root`"),
    knob: z.enum(["mode", "review_plan", "review_code", "approve", "commit", "parallel", "enforcement", "land"]).describe("Knob name to set"),
    value: z.string().describe("Knob value (string; booleans as 'true'/'false'; integers as string)"),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, task_dir, knob, value }) => {
  const projectDir = resolveProjectDir(project_dir);
  const result = stateOps.setKnob(projectDir, task_dir, knob, value);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// ---------------------------------------------------------------------------
// Tool: code_index_status
// ---------------------------------------------------------------------------

server.registerTool("code_index_status", {
  description:
    "Return the staleness of the configured code-intelligence index (e.g. Graphify's " +
    "graph.json) as one of: not_configured | missing | stale | fresh, with a one-line " +
    "human-readable reason. Read-only -- never builds. The graph_file location is read " +
    "from the user-global ~/.agents/config.json (or $AGENTS_CONFIG_PATH), never from " +
    "this repo. Returns not_configured (never an error) when no code_index config exists.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir } = {}) => {
  const { projectDir, warning } = resolveProjectDirChecked(project_dir);
  const config = codeIndex.loadCodeIndexConfig();
  if (!codeIndex.codeIndexConfigured(config)) {
    return {
      content: [{ type: "text", text: "not_configured: no code_index.graph_file in ~/.agents/config.json" }],
    };
  }
  const { status, reason } = codeIndex.computeCodeIndexStatus(projectDir, config);
  const text = warning ? `${warning}\n${status}: ${reason}` : `${status}: ${reason}`;
  return { content: [{ type: "text", text }] };
});

// ---------------------------------------------------------------------------
// Tool: code_index_build
// ---------------------------------------------------------------------------

server.registerTool("code_index_build", {
  description:
    "Build (or refresh) the configured code-intelligence index by running the " +
    "user-configured build command, guarded by a staleness check -- when already " +
    "fresh, this is a sub-second no-op (skipped without spawning anything). Pass " +
    "force: true to bypass the guard. Sync: blocks until the build finishes (can take " +
    "seconds to ~90s on large repos). The build command is read ONLY from the trusted " +
    "user-global ~/.agents/config.json (or $AGENTS_CONFIG_PATH), never from this repo, " +
    "so an untrusted repo cannot inject a command. Returns not_configured (never an " +
    "error) when no code_index config exists.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    force: z.boolean().optional().describe(
      "Bypass the staleness guard and run the build command unconditionally (default false)."
    ),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir, force } = {}) => {
  const projectDir = resolveProjectDir(project_dir);
  const text = codeIndex.runCodeIndexBuild(projectDir, project_dir, force);
  return { content: [{ type: "text", text }] };
});

// ---------------------------------------------------------------------------
// Tool: memory_seed
// ---------------------------------------------------------------------------

server.registerTool("memory_seed", {
  description:
    "Seed agent memory files from the AGENTS repo's templates to the " +
    "project's .claude/agent-memory/ directory. Creates files only if they " +
    "don't already exist (preserves agent-curated memory). Returns a summary " +
    "of what was seeded vs what already existed. The seed source is the " +
    "AGENTS repo's templates/agents/memory/ directory (relative to this " +
    "server's own location), NOT the target project's templates.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
    task_dir: z.string().optional().describe(
      "Task directory path (unused -- memory is " +
      "project-scoped, not task-scoped; accepted for API consistency " +
      "with other state-manager tools)"
    ),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir } = {}) => {
  const projectDir = resolveProjectDir(project_dir);
  const text = memorySeed.runMemorySeed(projectDir);
  return { content: [{ type: "text", text }] };
});

// ---------------------------------------------------------------------------
// Tool: memory_status
// ---------------------------------------------------------------------------

server.registerTool("memory_status", {
  description:
    "Check whether agent memory files are seeded for the given project. " +
    "Returns the status of each agent's MEMORY.md file in " +
    ".claude/agent-memory/. Read-only -- never creates or modifies files.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
  },
  annotations: { readOnlyHint: true },
}, async ({ project_dir } = {}) => {
  const projectDir = resolveProjectDir(project_dir);
  const text = memorySeed.runMemoryStatus(projectDir);
  return { content: [{ type: "text", text }] };
});

// ---------------------------------------------------------------------------
// Tool: workspace_init
// ---------------------------------------------------------------------------

server.registerTool("workspace_init", {
  description:
    "Initialize a workspace in one call: refresh the code-intelligence " +
    "index (same logic as code_index_build — staleness-guarded, no-ops if " +
    "not configured or already fresh) and seed agent memory files (same " +
    "logic as memory_seed — create-if-not-exists, preserves curated " +
    "memory). Idempotent: safe to call repeatedly with no side effects when " +
    "everything is already up to date. Returns a combined summary of both " +
    "operations. Memory seeding runs first (never throws) so agent memory " +
    "is seeded even if the code-index build encounters an error.",
  inputSchema: {
    project_dir: z.string().optional().describe(PROJECT_DIR_DESC),
  },
  annotations: { readOnlyHint: false },
}, async ({ project_dir } = {}) => {
  const projectDir = resolveProjectDir(project_dir);
  const memoryText = memorySeed.runMemorySeed(projectDir);
  let buildText;
  try {
    buildText = codeIndex.runCodeIndexBuild(projectDir, project_dir, false);
  } catch (e) {
    buildText = `build failed: ${e.message || e}`;
  }
  return {
    content: [{
      type: "text",
      text: "Workspace initialized.\n" + `Code index: ${buildText}\n` + `Memory: ${memoryText}`,
    }],
  };
});

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
