#!/usr/bin/env node
// AGENTS State Server -- the Conductor's engine tools, plus the two code-index tools.
//
// Each engine tool runs one `a` command: it spawns ~/.agents/bin/node on
// ~/.agents/bin/current/scripts/bin/a per call, so the engine a call runs is the one `current` names
// at that moment. The engine tools require nothing from scripts/lib; a long-lived server never reloads
// its own code, and an engine import would freeze the engine it started with. The one exception is the
// code-index pair (lib/code-index, lib/project-dir), which answers in-process.
//
// Registration (user scope, every repo): `./install.sh --mcp`, or by hand
//   claude mcp add --scope user state-manager ~/.agents/bin/node ~/.agents/bin/current/scripts/state-server.js

for (const mod of ["@modelcontextprotocol/sdk/server/mcp.js", "zod"]) {
  try {
    require.resolve(mod);
  } catch {
    process.stderr.write(
      `[state-server] cannot load ${mod} for ${__filename}: an installed snapshot needs its node_modules link (run ./install.sh); a checkout needs npm ci\n`
    );
    process.exit(1);
  }
}

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const MAX_BUFFER = 16 * 1024 * 1024;

const server = new McpServer({ name: "state-manager", version: "1.0.0" });

// ---------------------------------------------------------------------------
// Running `a`
// ---------------------------------------------------------------------------

const refusal = (text) => ({ isError: true, content: [{ type: "text", text }] });

/** Run `a <argv> --json` under the recorded node; `seconds` 0 means no timeout. */
function runEngine(label, argv, seconds) {
  const home = os.homedir();
  const node = path.join(home, ".agents", "bin", "node");
  const engine = path.join(home, ".agents", "bin", "current", "scripts", "bin", "a");
  for (const needed of [node, engine]) {
    if (!fs.existsSync(needed)) return Promise.resolve(refusal(`${needed} is missing; run ./install.sh`));
  }
  return new Promise((resolve) => {
    execFile(node, [engine, ...argv, "--json"], {
      cwd: home, env: process.env, timeout: seconds * 1000, killSignal: "SIGTERM", maxBuffer: MAX_BUFFER, encoding: "utf8",
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ content: [{ type: "text", text: stdout }] });
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve(refusal(`a ${label} printed more than ${MAX_BUFFER} bytes and was stopped`));
      if (err.killed) return resolve(refusal(`a ${label} did not finish within ${seconds} s and was stopped\n${stderr || ""}`));
      if (typeof err.code !== "number") return resolve(refusal(`a ${label} could not start: ${err.message}`));
      let parsed = stdout;
      try { parsed = JSON.parse(stdout); } catch { /* the raw text is the error */ }
      return resolve(refusal(JSON.stringify({ exit: err.code, error: parsed, stderr: stderr || "" })));
    });
  });
}

// ---------------------------------------------------------------------------
// The engine tools: none is defaulted from context
// ---------------------------------------------------------------------------

const task = z.string().refine((v) => path.isAbsolute(v), "task must be the absolute task dir (the Task dir: line of prime)")
  .describe("Absolute path of the task dir: the Task dir: line prime prints");
const phase = z.number().int().min(1).describe("Phase id");
const nonEmpty = (what) => z.string().min(1).describe(what);

const TOOLS = [
  {
    name: "prime",
    description: "The task's advice: runs `a next`, returning the next move, its one-sentence advice, any question for the owner, and the worktree.",
    shape: { task },
    seconds: 120,
    argv: ({ task: t }) => ["next", `--task-dir=${t}`],
    label: "next",
  },
  {
    name: "decide",
    description: "Record the owner's answer on a phase: runs `a decide`; `quote` is their words exactly as typed.",
    shape: {
      task, phase,
      choice: z.enum(["approve", "accept", "reject", "answer", "skip", "land_anyway"]).describe("The choice the owner's words name"),
      quote: nonEmpty("The owner's words, exactly as typed"),
    },
    seconds: 60,
    argv: ({ task: t, phase: p, choice, quote }) => ["decide", `--task-dir=${t}`, `--phase-id=${p}`, `--choice=${choice}`, `--quote=${quote}`],
    label: "decide",
  },
  {
    name: "land",
    description: "Land the task's branch: runs `a land` (fetch, rebase, the named checks, then push or PR). A refusal carries its remedy.",
    shape: {
      task,
      check: z.array(z.string().min(1)).optional().describe("Commands to run in the task's tree before the push; default: zsh scripts/check.sh"),
      policy: z.enum(["pr", "direct"]).optional().describe("Landing policy to record for a repo that has none"),
    },
    seconds: 900,
    argv: ({ task: t, check, policy }) => ["land", `--task-dir=${t}`, ...(check || []).map((c) => `--check=${c}`), ...(policy ? [`--policy=${policy}`] : [])],
    label: "land",
  },
  {
    name: "add_phases",
    description: "Add or rename phases: runs `a task add-phases`. A new id appends a not_started phase; an existing id updates its name and after only.",
    shape: {
      task,
      phases: z.array(z.object({
        id: z.number().int().min(1),
        name: z.string().min(1),
        after: z.array(z.number().int().min(1)),
      }).strict()).min(1).describe("The phases: id, name, and after (phase ids that must be checked first, may be empty)"),
    },
    seconds: 60,
    argv: ({ task: t, phases }) => ["task", "add-phases", `--task-dir=${t}`, `--phases-json=${JSON.stringify(phases)}`],
    label: "task add-phases",
  },
  {
    name: "note",
    description: "Set a phase's note to the given text: runs `a note`.",
    shape: { task, phase, text: nonEmpty("The note, in the owner's words") },
    seconds: 60,
    argv: ({ task: t, phase: p, text }) => ["note", `--task-dir=${t}`, `--phase-id=${p}`, `--text=${text}`],
    label: "note",
  },
];

for (const tool of TOOLS) {
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: z.object(tool.shape).strict(),
    annotations: { readOnlyHint: false },
  }, (args) => runEngine(tool.label, tool.argv(args), tool.seconds));
}

// ---------------------------------------------------------------------------
// The code-index tools (in-process)
// ---------------------------------------------------------------------------

const PROJECT_DIR_DESC =
  "Absolute path to the workspace root. Optional -- when omitted the server uses " +
  "CLAUDE_PROJECT_DIR, then the process working directory. Pass it only when you know " +
  "the exact path; never guess one.";

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
  const codeIndex = require("./lib/code-index");
  const { projectDir, warning } = require("./lib/project-dir").resolveProjectDirChecked(project_dir);
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
  const projectDir = require("./lib/project-dir").resolveProjectDir(project_dir);
  const text = require("./lib/code-index").runCodeIndexBuild(projectDir, project_dir, force);
  return { content: [{ type: "text", text }] };
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
