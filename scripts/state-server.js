#!/usr/bin/env node
// AGENTS State Server -- MCP server for state.json management
//
// Exposes 8 tools for deterministic, atomic state.json reads and writes,
// plus 2 code-index lifecycle tools (code_index_status, code_index_build)
// that keep a repo's code-intelligence index (e.g. Graphify's graph.json)
// current without hand-run extraction commands.
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
//   state_add_phases   -- Append new phases to an existing state.json
//   state_flag         -- Add a flag (auto-generates ID)
//   state_clear_flag   -- Remove a flag by ID
//   state_read         -- Return full state.json contents
//   state_prime        -- Return compact summary for fast resume
//   tasks_list         -- List all tasks from .tasks/tasks.json index
//   code_index_status  -- Read-only: missing/stale/fresh/not_configured
//   code_index_build   -- Run the configured build command (staleness-guarded)
//
// Code-index lifecycle config (user-global, trusted; see loadCodeIndexConfig):
//   Read from $AGENTS_CONFIG_PATH if set, else ~/.agents/config.json. Shape:
//     { "code_index": { "build": "...", "graph_file": "...", "code_extensions": [...] } }
//   The `build` command is read ONLY from this user-global file -- never from
//   the target repo -- so an untrusted repo cannot inject a command. Absent
//   file/section = both tools return "not_configured" and no-op cleanly.
//
// Path resolution (priority chain per tool call):
//   1. project_dir parameter passed by the calling agent (git-derived)
//   2. CLAUDE_PROJECT_DIR env var (Claude Code sets this automatically; git-derived)
//   3. process.cwd() (last resort; may be incorrect for user-scoped servers; git-derived)
//
//   The selected candidate is rolled up to the MAIN worktree root
//   of the git repo it belongs to (deriveMainWorktreeRoot). This keeps ONE
//   shared .tasks/ dashboard across every `git worktree` of a repo: a linked
//   worktree rolls up to its primary checkout, while a primary/non-worktree
//   candidate is returned unchanged (byte-for-byte backward compatible).
//   Derivation never throws -- on no-git / old-git / bare-repo / parse failure
//   it falls back to the candidate directory (with a one-time stderr hint for
//   the old-git/no-git/parse-failure cases; silent for plain "not a git repo").
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
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const _mainRootCache = new Map(); // memoization, keyed by resolved candidate path
let _oldGitHintLogged = false; // module-level, one-time stderr hint guard (NOT per-candidate)

/** Emit the old-git/no-git/parse-failure hint at most once per process (stderr only). */
function _warnOldGitOnce() {
  if (_oldGitHintLogged) return;
  _oldGitHintLogged = true;
  console.error(
    "AGENTS state-server: git worktree .tasks/ rollup unavailable " +
    "(old git or unexpected git output) -- install git >= 2.31 for shared " +
    ".tasks/ across worktrees. Continuing with this directory as-is."
  );
}

/**
 * Roll a candidate directory up to the main worktree root of the git repo it
 * belongs to. No-op for a primary worktree; rolls a linked worktree up to its
 * primary. Falls back to `candidate` on any failure (not a repo, no git, bare
 * repo, unusual layout, timeout). Never throws. At most one git invocation.
 * Emits a one-time stderr hint (never stdout) for old-git/parse-failure/no-git
 * cases; stays silent for the common "not a git repository" case.
 *
 * LC_ALL/LANG are forced to "C" so the "not a git repository" stderr
 * classification is locale-independent.
 * @param {string} candidate - Candidate project directory
 * @returns {string} Absolute main worktree root, or the resolved candidate on failure
 */
function deriveMainWorktreeRoot(candidate) {
  const resolved = path.resolve(candidate);
  if (_mainRootCache.has(resolved)) return _mainRootCache.get(resolved);
  let result = resolved;
  try {
    const out = execFileSync(
      "git",
      ["-C", resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }
    );
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const commonDir = lines[lines.length - 1];
    if (commonDir && path.isAbsolute(commonDir) && path.basename(commonDir) === ".git") {
      result = path.dirname(commonDir);
    } else {
      _warnOldGitOnce(); // ran, but output didn't parse as an absolute .git path
    }
  } catch (err) {
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    if (err.code === "ENOENT" || !/not a git repository/i.test(stderr)) {
      _warnOldGitOnce(); // git missing, or a failure that isn't the expected "no repo" case
    }
    // else: candidate simply isn't inside a git repo -- expected, silent fallback
  }
  _mainRootCache.set(resolved, result);
  return result;
}

/**
 * Resolve the project root directory for a single tool call.
 * Priority: callProjectDir arg (git-derived) > CLAUDE_PROJECT_DIR env var
 * (git-derived) > process.cwd() (git-derived).
 * Logs a warning to stderr when falling back to cwd.
 * @param {string|undefined} callProjectDir - Value of the project_dir tool parameter
 * @returns {string} Absolute project root path
 */
function resolveProjectDir(callProjectDir) {
  if (callProjectDir) return deriveMainWorktreeRoot(callProjectDir);
  if (process.env.CLAUDE_PROJECT_DIR) return deriveMainWorktreeRoot(process.env.CLAUDE_PROJECT_DIR);
  console.error(
    "AGENTS state-server: CLAUDE_PROJECT_DIR not set and project_dir not provided, " +
    "using cwd -- state.json paths may be incorrect for user-scoped servers."
  );
  return deriveMainWorktreeRoot(process.cwd());
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

/** Returns the current timestamp as a full ISO 8601 string. */
function now() {
  return new Date().toISOString();
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
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse state.json at ${statePath}: ${e.message}`);
  }
  // Guard non-object JSON (null, array, primitive).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid state.json at ${statePath}: expected a plain object, got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      }`
    );
  }
  // Guard missing required array fields.
  if (!Array.isArray(parsed.phases) || !Array.isArray(parsed.flags)) {
    const missing = [
      !Array.isArray(parsed.phases) && "phases",
      !Array.isArray(parsed.flags) && "flags",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Invalid state.json at ${statePath}: missing ${missing} array`
    );
  }
  return parsed;
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

    // Guard: skip files that parse as valid JSON but are not a well-formed
    // state object (null, array, primitive, or missing phases/flags arrays).
    // Log to stderr so the operator can identify the bad file.
    if (
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !Array.isArray(state.phases) ||
      !Array.isArray(state.flags)
    ) {
      process.stderr.write(
        `[state-server] buildTasksIndex: skipping malformed state.json at ${stateFile} (missing phases/flags arrays)\n`
      );
      continue;
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
  const index = { updated: now(), tasks: entries };
  const json = JSON.stringify(index, null, 2);
  fs.writeFileSync(tasksIndexTmpPath(projectDir), json, "utf8");
  fs.renameSync(tasksIndexTmpPath(projectDir), tasksIndexPath(projectDir));
}

// ---------------------------------------------------------------------------
// Code-index lifecycle (code_index_status / code_index_build)
// ---------------------------------------------------------------------------

// Pragmatic default set of "code" file extensions used for the staleness
// check when the user config omits `code_extensions`. Keeps docs/config/log
// edits from triggering rebuilds. Configurable per-user via
// ~/.agents/config.json code_index.code_extensions.
const DEFAULT_CODE_EXTENSIONS = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".scala", ".sh",
];

let _codeIndexConfigCache; // undefined = not yet loaded; null = no config found

/**
 * Resolve the user-global AGENTS config path: $AGENTS_CONFIG_PATH override,
 * else ~/.agents/config.json. Mirrors the CLAUDE_PROJECT_DIR / resolveProjectDir
 * precedent (call-arg override > env var > default). The env var is set by
 * whoever controls the *process* (developer/CI), never by the target repo, so
 * it does not weaken the config's trust boundary (see loadCodeIndexConfig).
 * @returns {string} Absolute path to the AGENTS config file
 */
function agentsConfigPath() {
  return process.env.AGENTS_CONFIG_PATH || path.join(os.homedir(), ".agents", "config.json");
}

/**
 * Load and cache the `code_index` section of the user-global AGENTS config
 * (read once per server process). Returns null when the file is missing,
 * unreadable, malformed JSON, or has no `code_index` object -- callers treat
 * this as "not configured" and no-op cleanly; this function never throws.
 *
 * SECURITY (Decision 4): the build command is read ONLY from this
 * user-global, trusted file -- NEVER from the target repo -- so an untrusted
 * repo cannot inject a command merely by being opened.
 * @returns {object|null} The `code_index` config object, or null
 */
function loadCodeIndexConfig() {
  if (_codeIndexConfigCache !== undefined) return _codeIndexConfigCache;
  let result = null;
  try {
    const raw = fs.readFileSync(agentsConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.code_index && typeof parsed.code_index === "object") {
      result = parsed.code_index;
    }
  } catch {
    result = null; // missing file / unreadable / malformed JSON -- clean no-op
  }
  _codeIndexConfigCache = result;
  return result;
}

/**
 * True when `config` has enough fields to act on. `graph_file` alone is
 * enough for the read-only status check; `requireBuild` additionally
 * requires a non-empty `build` string (needed to actually run a build).
 */
function codeIndexConfigured(config, { requireBuild = false } = {}) {
  if (!config) return false;
  if (typeof config.graph_file !== "string" || !config.graph_file) return false;
  if (requireBuild && (typeof config.build !== "string" || !config.build)) return false;
  return true;
}

/**
 * Compute code-index staleness for a project directory (Decision 3).
 * - `graph_file` missing -> "missing"
 * - else: newest mtime among tracked *code* files (via `git ls-files`,
 *   gitignore-respected, filtered to `code_extensions`, excluding the index
 *   file/dir itself) vs `graph_file`'s mtime -> "stale" if newer, else "fresh"
 * - not a git repo (or git unavailable) -> "fresh" (nothing to compare against)
 * Cheap: single `git ls-files` + stats, short-circuits on the first newer file.
 * Never throws.
 * @param {string} projectDir - Resolved project root
 * @param {object} config - The `code_index` config (graph_file required)
 * @returns {{status: "missing"|"stale"|"fresh", reason: string}}
 */
function computeCodeIndexStatus(projectDir, config) {
  const graphFile = path.resolve(projectDir, config.graph_file);
  if (!fs.existsSync(graphFile)) {
    return { status: "missing", reason: `${config.graph_file} not found` };
  }
  const graphMtimeMs = fs.statSync(graphFile).mtimeMs;

  const extensions = Array.isArray(config.code_extensions) && config.code_extensions.length > 0
    ? config.code_extensions
    : DEFAULT_CODE_EXTENSIONS;

  let trackedFiles;
  try {
    const out = execFileSync("git", ["-C", projectDir, "ls-files"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackedFiles = out.split("\n").filter(Boolean);
  } catch {
    // Not a git repo (or git unavailable) -- nothing to compare against.
    return { status: "fresh", reason: "no git repository found; nothing to compare" };
  }

  const graphFileRel = path.relative(projectDir, graphFile);
  const graphDirRel = path.dirname(graphFileRel);

  for (const rel of trackedFiles) {
    if (rel === graphFileRel) continue;
    if (graphDirRel !== "." && (rel === graphDirRel || rel.startsWith(graphDirRel + "/"))) continue;
    if (!extensions.some((ext) => rel.endsWith(ext))) continue;

    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.resolve(projectDir, rel)).mtimeMs;
    } catch {
      continue; // listed by git but missing on disk (rare race) -- skip
    }
    if (mtimeMs > graphMtimeMs) {
      return { status: "stale", reason: `${rel} newer than ${config.graph_file}` };
    }
  }
  return { status: "fresh", reason: `no tracked code file newer than ${config.graph_file}` };
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
      schema_version: 1,
      task: slug,
      status: "planning",
      updated: now(),
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
      phase_status: z.enum(["not_started", "planned", "reviewed", "in_progress", "done", "failed"]).optional().describe(
        "New status for the phase"
      ),
      owner: z.string().nullable().optional().describe(
        "Agent type (explorer|builder|reviewer|committer) or null to clear"
      ),
      task_status: z.enum(["planning", "in_progress", "done", "blocked", "failed", "needs_human", "review_ready"]).optional().describe(
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
      if (started === true) phase.started = now();
      if (completed === true) phase.completed = now();

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

    // Auto-complete task when all phases are done (only when task_status not explicitly set)
    if (task_status === undefined) {
      const allDone = state.phases.every((p) => p.status === "done");
      if (allDone && state.status !== "done") {
        state.status = "done";
      }
    }

    state.updated = now();
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
// Tool: state_add_phases
// ---------------------------------------------------------------------------

server.registerTool(
  "state_add_phases",
  {
    description:
      "Append one or more new phases to an existing state.json. " +
      "Complements state_init (create-once): use this when a task grows phases " +
      "mid-flight so state.json stays in sync with task.md. New phases start as " +
      "not_started. Re-adding an existing phase id is rejected as a duplicate " +
      "(never silently overwrites an in-progress phase). The whole batch is " +
      "validated before any write -- on any error, state.json is left unchanged.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      task_dir: z.string().describe("Relative path to the task directory"),
      // Note: .min(1) is intentionally NOT applied to state_init's phases schema
      // (state_init allows an empty phase list for edge cases). Here we enforce
      // non-empty at the schema layer since appending zero phases is always a
      // caller error. A belt-and-suspenders runtime check below handles any SDK
      // version that might not enforce .min(1).
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
  },
  async ({ project_dir, task_dir, phases }) => {
    const projectDir = resolveProjectDir(project_dir);
    const state = readState(task_dir, projectDir); // throws if state.json missing

    // Check 0: non-empty batch (belt-and-suspenders beyond .min(1))
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error("phases must contain at least one phase.");
    }

    const existingIds = new Set(state.phases.map((p) => p.id));

    // Check 1: no incoming id duplicates an existing phase id.
    // Check 2: no duplicate ids within the incoming batch.
    const seenInBatch = new Set();
    for (const p of phases) {
      if (existingIds.has(p.id)) {
        throw new Error(
          `Phase ${p.id} already exists. Existing phase IDs: ${[...existingIds].join(", ")}. ` +
          "Use state_update to modify it."
        );
      }
      if (seenInBatch.has(p.id)) {
        throw new Error(`Duplicate phase id ${p.id} in the request.`);
      }
      seenInBatch.add(p.id);
    }

    // Build the new phase objects (identical defaults to state_init).
    const newPhases = phases.map(({ id, name, blocked_by, parallel_group }) => ({
      id,
      name,
      status: "not_started",
      owner: null,
      started: null,
      completed: null,
      blocked_by: blocked_by || [],
      parallel_group: parallel_group ?? null,
      execution: { model: null, effort: null, agent_type: null, estimated_scope: null },
    }));

    // Check 3: validate every blocked_by against the UNION of existing + new ids,
    // so a new phase may depend on an existing phase OR a sibling new phase.
    const allIds = new Set([...existingIds, ...newPhases.map((p) => p.id)]);
    for (const phase of newPhases) {
      for (const depId of phase.blocked_by) {
        if (!allIds.has(depId)) {
          throw new Error(
            `Phase ${phase.id} has blocked_by reference to non-existent phase ${depId}. ` +
            `Available phase IDs: ${[...allIds].join(", ")}`
          );
        }
      }
    }

    // All checks passed -- mutate, write, reindex (no partial writes possible
    // because all validation happens before the first mutation of `state`).
    state.phases.push(...newPhases);
    state.updated = now();
    writeState(task_dir, state, projectDir);
    updateTasksIndex(projectDir);

    const summary = newPhases.map((p) => `${p.id} (${p.name})`).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `Added ${newPhases.length} phase(s): ${summary}. Total phases: ${state.phases.length}.`,
        },
      ],
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
      raised: now(),
    };

    state.flags.push(flag);
    state.updated = now();
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
    state.updated = now();
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
      index = { updated: now(), tasks: buildTasksIndex(projectDir) };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(index, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: code_index_status
// ---------------------------------------------------------------------------

server.registerTool(
  "code_index_status",
  {
    description:
      "Return the staleness of the configured code-intelligence index (e.g. Graphify's " +
      "graph.json) as one of: not_configured | missing | stale | fresh, with a one-line " +
      "human-readable reason. Read-only -- never builds. The graph_file location is read " +
      "from the user-global ~/.agents/config.json (or $AGENTS_CONFIG_PATH), never from " +
      "this repo. Returns not_configured (never an error) when no code_index config exists.",
    inputSchema: {
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project_dir } = {}) => {
    const projectDir = resolveProjectDir(project_dir);
    const config = loadCodeIndexConfig();
    if (!codeIndexConfigured(config)) {
      return {
        content: [{ type: "text", text: "not_configured: no code_index.graph_file in ~/.agents/config.json" }],
      };
    }
    const { status, reason } = computeCodeIndexStatus(projectDir, config);
    return { content: [{ type: "text", text: `${status}: ${reason}` }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: code_index_build
// ---------------------------------------------------------------------------

server.registerTool(
  "code_index_build",
  {
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
      project_dir: z.string().optional().describe(
        "Workspace root directory. Required when CLAUDE_PROJECT_DIR env var is not set (e.g., VS Code user-scoped MCP)."
      ),
      force: z.boolean().optional().describe(
        "Bypass the staleness guard and run the build command unconditionally (default false)."
      ),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ project_dir, force } = {}) => {
    const projectDir = resolveProjectDir(project_dir);
    const config = loadCodeIndexConfig();
    if (!codeIndexConfigured(config, { requireBuild: true })) {
      return {
        content: [{
          type: "text",
          text: "not_configured: no code_index.build / code_index.graph_file in ~/.agents/config.json",
        }],
      };
    }

    if (!force) {
      const { status, reason } = computeCodeIndexStatus(projectDir, config);
      if (status === "fresh") {
        return { content: [{ type: "text", text: `skipped (fresh): ${reason}` }] };
      }
    }

    const timeoutMs = Number.isFinite(config.timeout_ms) && config.timeout_ms > 0
      ? config.timeout_ms
      : 180000;
    const start = Date.now();
    let output;
    try {
      // execSync (not execFileSync) is intentional here: `build` is a single
      // free-form, user-authored string (e.g. "graphify extract . --force" or
      // a "cmd1 && cmd2" pipeline) that needs shell interpretation for
      // &&/quoting to work. This is safe specifically because `build` comes
      // only from the trusted user-global config (Decision 4) -- never from
      // repo- or attacker-supplied input.
      output = execSync(config.build, {
        cwd: projectDir,
        timeout: timeoutMs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
      const stderrTail = (typeof err.stderr === "string" ? err.stderr : (err.stderr || "").toString())
        .split("\n").filter(Boolean).slice(-10).join("\n");
      if (err.signal === "SIGTERM" || err.killed) {
        throw new Error(
          `code_index_build: build command timed out after ${elapsedS}s ` +
          `(limit ${(timeoutMs / 1000).toFixed(0)}s). build="${config.build}"`
        );
      }
      throw new Error(
        `code_index_build: build command exited with status ${err.status} after ${elapsedS}s. ` +
        `build="${config.build}"${stderrTail ? `\nstderr tail:\n${stderrTail}` : ""}`
      );
    }
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    const tail = output.split("\n").filter(Boolean).slice(-10).join("\n");
    return {
      content: [{ type: "text", text: `built (${elapsedS}s)${tail ? `:\n${tail}` : ""}` }],
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
