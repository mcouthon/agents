#!/usr/bin/env node
// AGENTS State Server -- the Conductor's eight engine tools, plus the older state-manager tools.
//
// Each engine tool runs one `a` command: it spawns ~/.agents/bin/node on
// ~/.agents/bin/current/scripts/bin/a per call, so the engine a call runs is the one `current` names
// at that moment. This file requires nothing from scripts/lib; a long-lived server never reloads its
// own code, and an engine import would freeze the engine it started with. The older tools live in
// state-server-legacy.js and are loaded last; a failure there leaves the eight up.
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

const LEGACY_TOOLS = [
  "state_init", "state_update", "state_add_phases", "state_flag", "state_clear_flag", "state_read", "state_prime",
  "tasks_list", "task_create", "repo_policy", "state_next", "task_set", "code_index_status", "code_index_build",
  "memory_seed", "memory_status", "workspace_init",
];
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
// The eight tools: every argument is required, none is defaulted from context
// ---------------------------------------------------------------------------

const task = z.string().refine((v) => path.isAbsolute(v), "task must be the absolute task dir (the prime hook's Task dir: line)")
  .describe("Absolute path of the task dir: the Task dir: line the prime hook prints");
const phase = z.number().int().min(1).describe("Phase id");
const runId = z.number().int().min(1).describe("Run id returned by dispatch or resume");
const nonEmpty = (what) => z.string().min(1).describe(what);

const TOOLS = [
  {
    name: "prime",
    description: "The task's next step: runs `a next --phases`, returning step, call, who it awaits, the live run and the phases.",
    shape: { task },
    seconds: 120,
    argv: ({ task: t }) => ["next", `--task-dir=${t}`, "--phases"],
    label: "next",
  },
  {
    name: "dispatch",
    description: "Start one agent headless on a phase: runs `a run start`; returns the run id at once. Wait for it with wait.",
    shape: {
      task, phase,
      agent: z.enum(["explorer", "reviewer", "builder", "committer", "consolidator"]).describe("The agent the step names"),
      brief: nonEmpty("What the agent must achieve, in the owner's terms"),
      model: z.enum(["agent", "haiku"]).describe("agent: the agent's own model; haiku: for a small step the owner allowed"),
    },
    seconds: 60,
    argv: ({ task: t, phase: p, agent, brief, model }) => ["run", "start", `--task-dir=${t}`, `--phase-id=${p}`, `--agent=${agent}`, `--brief=${brief}`, `--model=${model}`],
    label: "run start",
  },
  {
    name: "wait",
    description: "Wait for a run: runs `a run wait` for up to `seconds` (at most 240); returns the run, its report and the next step.",
    shape: { task, run_id: runId, seconds: z.number().int().min(1).max(240).describe("Seconds to wait, 1 to 240") },
    seconds: 300,
    argv: ({ task: t, run_id, seconds }) => ["run", "wait", `--task-dir=${t}`, `--run-id=${run_id}`, `--seconds=${seconds}`],
    label: "run wait",
  },
  {
    name: "resume",
    description: "Resume a run's agent session with a new brief: runs `a run resume`; returns the new run id.",
    shape: { task, run_id: runId, brief: nonEmpty("What the agent must do next") },
    seconds: 60,
    argv: ({ task: t, run_id, brief }) => ["run", "resume", `--task-dir=${t}`, `--run-id=${run_id}`, `--brief=${brief}`],
    label: "run resume",
  },
  {
    name: "decide",
    description: "Record the owner's answer on a phase: runs `a decide`; `quote` is their words exactly as typed.",
    shape: {
      task, phase,
      choice: z.enum(["approve", "reject", "skip", "abort", "answer", "override", "land_anyway"]).describe("The choice the owner's words name"),
      quote: nonEmpty("The owner's words, exactly as typed"),
    },
    seconds: 60,
    argv: ({ task: t, phase: p, choice, quote }) => ["decide", `--task-dir=${t}`, `--phase-id=${p}`, `--choice=${choice}`, `--quote=${quote}`],
    label: "decide",
  },
  {
    name: "land",
    description: "Land a phase: runs `a land`, which checks the evidence, re-runs the recorded checks and merges. No time limit.",
    shape: { task, phase },
    seconds: 0,
    argv: ({ task: t, phase: p }) => ["land", `--task-dir=${t}`, `--phase-id=${p}`],
    label: "land",
  },
  {
    name: "add_phases",
    description: "Append phases to the task: runs `a state add-phases`.",
    shape: {
      task,
      phases: z.array(z.object({
        id: z.number().int().min(1),
        name: z.string().min(1),
        blocked_by: z.array(z.number().int().min(1)),
        parallel_group: z.string().nullable(),
      }).strict()).min(1).describe("The new phases: id, name, blocked_by (phase ids, may be empty) and parallel_group (a name or null)"),
    },
    seconds: 60,
    argv: ({ task: t, phases }) => ["state", "add-phases", `--task-dir=${t}`, `--phases-json=${JSON.stringify(phases)}`],
    label: "state add-phases",
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
// The older tools
// ---------------------------------------------------------------------------

try {
  require("./state-server-legacy").register(server);
} catch (e) {
  process.stderr.write(`[state-server] the older tools failed to load: ${e.message}\n`);
  for (const name of LEGACY_TOOLS) {
    try {
      server.registerTool(name, {
        description: "Unavailable: the older state-manager tools failed to load.",
        inputSchema: z.looseObject({}),
      }, async () => refusal(`the older state-manager tools failed to load: ${e.message}`));
    } catch (dup) {
      if (dup.message !== `Tool ${name} is already registered`) throw dup;
    }
  }
}

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
