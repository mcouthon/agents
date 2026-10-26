"use strict";

/**
 * `a run`: start an agent headless on a phase, wait for it, and store its
 * structured result exactly as `a report` stores one.
 *
 * A run is a row in `runs` plus three files in its session dir
 * (`<session_dir>/runs/<run_id>.{jsonl,err,exit}`). A detached `sh` wrapper runs
 * `claude -p`, so the parent `a` exits at once; the wrapper writes claude's exit
 * status to the `.exit` file. Any later `a` call reaps a finished run once.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const db = require("./db");
const session = require("./session");
const startLib = require("./start");
const taskLib = require("./task");
const { LockHeldError } = require("./lock");

const { fail } = startLib;

/** Report slot given to `a run` -> the `--agent` name of its claude agent file (the consolidator is a Builder). */
const AGENT_NAMES = { explorer: "Explorer", reviewer: "Reviewer", builder: "Builder", committer: "Committer", consolidator: "Builder" };
const LIVE = db.LIVE_RUN_STATUSES;
const STALE_CLAIM_MS = 60000;
const MAX_WAIT_S = 240;
const WRAPPER = '[ -n "$AGENTS_RUN_ENV_FILE" ] && { set -a; . "$AGENTS_RUN_ENV_FILE"; set +a; }; ' +
  '"$@" > "$AGENTS_RUN_OUT" 2> "$AGENTS_RUN_ERR"; echo $? > "$AGENTS_RUN_EXIT.tmp" && mv "$AGENTS_RUN_EXIT.tmp" "$AGENTS_RUN_EXIT"';

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withoutSkeleton(node) {
  if (Array.isArray(node)) return node.map(withoutSkeleton);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) if (k !== "skeleton") out[k] = withoutSkeleton(v);
  return out;
}

/** The report schema as `--json-schema` text: the renderer-only `skeleton` hints are not JSON Schema. */
function schemaFor(agent) {
  return JSON.stringify(withoutSkeleton(require("./report").loadSchemas()[agent]));
}

function composeBrief({ agent, taskDir, filesDir, phase, brief }) {
  const plan = phase.plan_path ? path.resolve(taskDir, phase.plan_path) : "(none yet)";
  return [
    `You are running headless as the ${AGENT_NAMES[agent]} for one phase of a task.`,
    `Task: ${path.basename(taskDir)}`, `Task dir: ${taskDir}`, `Files dir: ${filesDir}`,
    `Phase id: ${phase.id}`, `Phase: ${phase.name}`, `Plan path: ${plan}`,
    `Your final answer is the structured output the schema describes, with phase_id ${phase.id}; do not answer in prose.`,
    "", brief,
  ].join("\n");
}

function claudeArgs({ agent, sid, resume, model, filesDir, brief, cap }) {
  return [
    "-p", "--agent", AGENT_NAMES[agent], resume ? "--resume" : "--session-id", sid,
    ...(model === "haiku" ? ["--model", "haiku"] : []),
    "--add-dir", filesDir, "--permission-mode", "acceptEdits", "--allowedTools", "Bash",
    "--json-schema", schemaFor(agent), "--output-format", "stream-json", "--verbose",
    "--max-budget-usd", String(cap), brief,
  ];
}

function requireDb() {
  if (!db.enabled()) throw fail(2, "a run needs the agents database; this `a` is in file-only mode");
}

function liveRunOn(taskId, phaseId, sessionId) {
  return db.listRuns({ taskId, live: true }).find((r) => r.phase_id === phaseId || (sessionId && r.session_id === sessionId));
}

function refuseLive(live) {
  throw fail(2, `run ${live.run_id} (${live.agent}) is still ${live.status} on phase ${live.phase_id}; wait for it with: a run wait --run-id ${live.run_id}`);
}

/** Insert the run row, spawn the wrapper, and mark the row running; on any failure end the registration and mark the row crashed. */
function launch({ taskId, phase, agent, sid, sessionDir, cwd, filesDir, brief, resume, model, resumedFrom, launchCfg }) {
  const cap = require("./policy").budgetFor(agent);
  const paths = (id) => ({ stream_path: path.join(sessionDir, "runs", `${id}.jsonl`), err_path: path.join(sessionDir, "runs", `${id}.err`), exit_path: path.join(sessionDir, "runs", `${id}.exit`) });
  let inserted = null;
  try {
    inserted = db.insertRun({
      task_id: taskId, phase_id: phase.id, agent, status: "starting", session_id: sid, session_dir: sessionDir,
      resumed_from: resumedFrom || null, model: model === "haiku" ? "haiku" : null, requested_model: model, budget_usd: cap, cwd, brief,
    }, paths);
    fs.mkdirSync(path.join(sessionDir, "runs"), { recursive: true });
    const argv = claudeArgs({ agent, sid, resume, model, filesDir, brief, cap });
    const set = { AGENTS_SESSION_DIR: sessionDir, AGENTS_RUN_OUT: inserted.stream_path, AGENTS_RUN_ERR: inserted.err_path, AGENTS_RUN_EXIT: inserted.exit_path };
    if (launchCfg.envFile) set.AGENTS_RUN_ENV_FILE = launchCfg.envFile;
    const child = spawn("sh", ["-c", WRAPPER, `agents-run-${inserted.run_id}`, launchCfg.command, ...argv], {
      cwd, detached: true, stdio: "ignore", env: session.scrubbedEnv(set),
    });
    child.unref();
    if (!child.pid) throw new Error("could not start the run wrapper");
    db.updateRun(inserted.run_id, { status: "running", pid: child.pid });
  } catch (err) {
    session.markEnded(sessionDir);
    if (inserted) db.updateRun(inserted.run_id, { status: "crashed", error: err.message, ended_at: new Date().toISOString() });
    throw err;
  }
  return db.getRun(inserted.run_id);
}

function start({ taskDir, key, phaseId, agent, brief, model = "agent" }) {
  requireDb();
  const task = taskLib.readTaskJson(taskDir);
  if (!task) throw fail(4, `task.json not found at ${taskDir}`);
  const phase = (task.phases || []).find((p) => p.id === phaseId);
  if (!phase) throw fail(4, `Phase ${phaseId} not found in ${path.basename(taskDir)}`);
  if (!AGENT_NAMES[agent]) throw fail(2, `--agent must be one of ${Object.keys(AGENT_NAMES).join(", ")}`);
  if (!["agent", "haiku"].includes(model)) throw fail(2, "--model must be agent or haiku");
  if (!brief) throw fail(2, "--brief is required");
  const taskId = db.taskIdOf(taskDir);
  if (taskId === null) throw fail(2, `a run needs the task in the agents database; ${taskDir} has no tasks row`);
  const cwd = startLib.taskCheckout(key, taskDir, phase, require("./policy").resolvePolicy(key.main_root).base);
  const launchCfg = startLib.launchConfig();

  reap({ taskDir });
  const live = liveRunOn(taskId, phaseId);
  if (live) refuseLive(live);

  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const sid = session.mintId();
  const sessionDir = path.join(session.sessionsRoot(), sid);
  session.register({ session_id: sid, session_dir: sessionDir, origin: "dispatch", initiator: "engine", agent, cwd, repo_key: key.key, task_dir: taskDir });
  const filesDir = taskLib.filesDir(taskDir, task);
  return launch({ taskId, phase, agent, sid, sessionDir, cwd, filesDir, model, launchCfg,
    brief: composeBrief({ agent, taskDir, filesDir, phase, brief }), resume: false });
}

function resume({ runId, brief }) {
  requireDb();
  const source = db.getRun(runId);
  if (!source) throw fail(4, `No run ${runId}`);
  if (!brief) throw fail(2, "--brief is required");
  const launchCfg = startLib.launchConfig();
  reap({ taskDir: source.task_dir });
  const fresh = db.getRun(runId);
  const live = liveRunOn(fresh.task_id, fresh.phase_id, fresh.session_id);
  if (live) refuseLive(live);

  delete process.env.AGENTS_SESSION_DIR;
  delete process.env.AGENTS_SESSION_ID;
  const task = taskLib.readTaskJson(fresh.task_dir);
  const phase = (task.phases || []).find((p) => p.id === fresh.phase_id);
  session.register({ session_id: fresh.session_id, session_dir: fresh.session_dir, pid: null, origin: "dispatch", task_dir: fresh.task_dir, agent: fresh.agent, cwd: fresh.cwd });
  const filesDir = taskLib.filesDir(fresh.task_dir, task);
  return launch({ taskId: fresh.task_id, phase, agent: fresh.agent, sid: fresh.session_id, sessionDir: fresh.session_dir, cwd: fresh.cwd, filesDir,
    model: fresh.requested_model === "haiku" ? "haiku" : "agent", launchCfg, resume: true, resumedFrom: runId,
    brief: composeBrief({ agent: fresh.agent, taskDir: fresh.task_dir, filesDir, phase, brief }) });
}

// ---------------------------------------------------------------- reading a run

function readStream(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return { lines: [], result: null, init: null }; }
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* a line cut short by a kill */ }
  }
  const result = [...lines].reverse().find((l) => l.type === "result") || null;
  const init = lines.find((l) => l.type === "system" && l.subtype === "init") || null;
  return { lines, result, init };
}

function pidIsRun(run) {
  try { process.kill(run.pid, 0); } catch { return false; }
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(run.pid)], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.split(/\s+/).includes(`agents-run-${run.run_id}`);
}

function isFinished(run) {
  if (fs.existsSync(run.exit_path)) return true;
  const { lines } = readStream(run.stream_path);
  if (lines.length > 0 && lines[lines.length - 1].type === "result") return true;
  if (!run.pid) return run.status === "starting" && Date.now() - Date.parse(run.started_at) > 60000;
  return !pidIsRun(run);
}

function exitCodeOf(run) {
  try {
    const n = parseInt(fs.readFileSync(run.exit_path, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

function tailOf(file, chars) {
  try { return fs.readFileSync(file, "utf8").slice(-chars).trim(); } catch { return ""; }
}

function gitStatusOf(cwd) {
  const r = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trimEnd() : `git status failed: ${(r.error && r.error.message) || (r.stderr || "").trim()}`;
}

function transcriptOf(run) {
  const reg = session.readRegistration(run.session_dir);
  if (reg && reg.transcript_path) return reg.transcript_path;
  let real = run.cwd;
  try { real = fs.realpathSync(run.cwd); } catch { /* the checkout is gone */ }
  const guess = path.join(os.homedir(), ".claude", "projects", real.replace(/[^A-Za-z0-9]/g, "-"), `${run.session_id}.jsonl`);
  return fs.existsSync(guess) ? guess : null;
}

/** Store a structured result like `a report` does; LockHeldError is retried once after 2 s. */
function persist(run, structured, projectDir) {
  const reportLib = require("./report");
  const submit = () => reportLib.submitReport({
    taskDir: run.task_dir, phaseId: run.phase_id, agentType: run.agent, report: structured, projectDir,
    writer: { session_id: run.session_id, agent: run.agent, run_id: run.run_id },
  });
  try {
    return submit();
  } catch (err) {
    if (!(err instanceof LockHeldError)) throw err;
    sleepMs(2000);
    return submit();
  }
}

function classify(run, stream, exitCode) {
  const { result } = stream;
  if (result && result.subtype === "error_max_budget_usd") {
    return { status: "capped", error: (result.errors || []).join("; ") || "budget exhausted" };
  }
  if (result && result.structured_output && typeof result.structured_output === "object") {
    let submitted;
    try {
      submitted = persist(run, result.structured_output, require("./repo").repoKey(run.cwd).main_root);
    } catch (err) {
      if (err instanceof LockHeldError) return { deferred: `report not stored yet: ${err.message}; the next reap retries` };
      return { status: "refused", error: err.message };
    }
    if (!submitted.valid) return { status: "refused", error: submitted.errors.join("; ") };
    return { status: "succeeded", transition: submitted.result.transition };
  }
  if (result) return { status: "no_report", result_text: String(result.result || "").slice(0, 4000) };
  if (exitCode === 124 || (exitCode !== null && exitCode >= 129 && exitCode <= 159)) return { status: "killed" };
  if (exitCode === null && !fs.existsSync(run.exit_path)) return { status: "killed" };
  return { status: "crashed", error: tailOf(run.err_path, 2000) || `claude exited ${exitCode}` };
}

/** Reap one finished run; null when another caller holds the claim. */
function reapRun(run) {
  if (!db.claimRun(run.run_id, new Date(Date.now() - STALE_CLAIM_MS).toISOString())) return null;
  try {
    const stream = readStream(run.stream_path);
    const exitCode = exitCodeOf(run);
    const outcome = classify(run, stream, exitCode);
    if (outcome.deferred) {
      db.updateRun(run.run_id, { status: "running", reaping_at: null, error: outcome.deferred });
      return db.getRun(run.run_id);
    }
    const { result, init } = stream;
    let endedAt = new Date().toISOString();
    try { endedAt = fs.statSync(run.exit_path).mtime.toISOString(); } catch { /* no exit file: the wrapper was killed */ }
    const models = result && result.modelUsage ? Object.keys(result.modelUsage).join(",") : "";
    db.updateRun(run.run_id, {
      error: null, ...outcome, exit_code: exitCode, subtype: result ? result.subtype || null : null,
      terminal_reason: result ? result.terminal_reason || null : null, cost_usd: result ? result.total_cost_usd ?? null : null,
      duration_ms: result ? result.duration_ms ?? null : null, num_turns: result ? result.num_turns ?? null : null,
      permission_denials: result ? JSON.stringify(result.permission_denials || []) : null,
      model: models || (init && init.model) || run.model, transcript_path: transcriptOf(run), ended_at: endedAt, reaping_at: null,
      git_status: outcome.status === "succeeded" ? null : gitStatusOf(run.cwd),
    });
    const reg = session.readRegistration(run.session_dir);
    if (reg && !reg.ended_at) session.markEnded(run.session_dir);
  } catch (err) {
    db.updateRun(run.run_id, { status: "crashed", error: `reap failed: ${err.message}`, reaping_at: null, ended_at: new Date().toISOString() });
  }
  return db.getRun(run.run_id);
}

/** Reap every finished live run of a task (or of the database); a no-op without the database. */
function reap({ taskDir } = {}) {
  if (!db.enabled()) return [];
  let taskId;
  if (taskDir) {
    taskId = db.taskIdOf(taskDir);
    if (taskId === null) return [];
  }
  const reaped = [];
  for (const run of db.listRuns({ taskId, live: true })) {
    if (!isFinished(run)) continue;
    const row = reapRun(run);
    if (row) reaped.push(row);
  }
  return reaped;
}

function nextFor(run) {
  const key = require("./repo").repoKey(run.cwd);
  const task = taskLib.readTaskJson(run.task_dir);
  const policy = require("./policy").resolvePolicy(key.main_root);
  return require("./next").computeNext(task, { projectDir: key.main_root, policy, taskDir: run.task_dir });
}

function wait({ runId, seconds = MAX_WAIT_S }) {
  requireDb();
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_S) throw fail(2, `--seconds must be between 1 and ${MAX_WAIT_S}`);
  let run = db.getRun(runId);
  if (!run) throw fail(4, `No run ${runId}`);
  const started = Date.now();
  let finished = !LIVE.includes(run.status);
  while (!finished) {
    if (isFinished(run)) break;
    if (Date.now() - started >= seconds * 1000) break;
    sleepMs(1000);
    run = db.getRun(runId);
    finished = !LIVE.includes(run.status);
  }
  if (!finished && isFinished(run)) {
    reapRun(run);
    run = db.getRun(runId);
    for (let i = 0; i < 10 && run.status === "reaping"; i++) { sleepMs(1000); run = db.getRun(runId); }
    finished = true;
  }
  return { run, next: finished ? nextFor(run) : null, finished, waited_s: Math.round((Date.now() - started) / 1000) };
}

function detailOf(input) {
  const value = input.command || input.file_path || input.path || input.pattern || input.url || input.description || JSON.stringify(input).slice(0, 120);
  return String(value).replace(/\s*\n\s*/g, " ");
}

function tail({ runId, lines = 10 }) {
  requireDb();
  const run = db.getRun(runId);
  if (!run) throw fail(4, `No run ${runId}`);
  const { lines: events, result } = readStream(run.stream_path);
  const uses = [];
  for (const e of events) {
    if (e.type !== "assistant" || !e.message || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) if (c.type === "tool_use") uses.push({ name: c.name, detail: detailOf(c.input || {}) });
  }
  const cost = run.cost_usd ?? (result ? result.total_cost_usd ?? null : null);
  const elapsed = Math.round(((run.ended_at ? Date.parse(run.ended_at) : Date.now()) - Date.parse(run.started_at)) / 1000);
  return { run_id: run.run_id, status: run.status, agent: run.agent, elapsed_s: elapsed, tool_calls: uses.length, cost_usd: cost, tool_uses: uses.slice(-lines) };
}

// ---------------------------------------------------------------- the CLI glue

const present = (row) => {
  const { brief, ...rest } = row;
  let denials = rest.permission_denials;
  try { denials = denials === null ? null : JSON.parse(denials); } catch { /* keep the text */ }
  return { ...rest, permission_denials: denials };
};

function intFlag(args, name, required) {
  const raw = args[name];
  if (raw === undefined || raw === true) {
    if (required) throw fail(2, `${name} is required`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw fail(2, `${name} must be an integer`);
  return n;
}

const word = (v) => (v === undefined || v === true ? undefined : v);

/**
 * `a run <start|wait|reap|resume|tail>`; `args` is the parsed flag object (keys with their dashes),
 * `ctx.key` the repo key and `ctx.taskDirOf(input)` resolves a task dir input to a path.
 */
function cli(cmd, args, ctx) {
  if (cmd === "start") {
    if (!word(args["--task-dir"])) throw fail(2, "--task-dir is required");
    const row = start({
      taskDir: ctx.taskDirOf(args["--task-dir"]), key: ctx.key, phaseId: intFlag(args, "--phase-id", true),
      agent: word(args["--agent"]), brief: word(args["--brief"]), model: word(args["--model"]),
    });
    const shown = { run_id: row.run_id, status: row.status, pid: row.pid, agent: row.agent, phase_id: row.phase_id, session_id: row.session_id, cwd: row.cwd, stream_path: row.stream_path, err_path: row.err_path, exit_path: row.exit_path };
    return { exitCode: 0, json: shown, text: `Run ${row.run_id} started: ${row.agent} on phase ${row.phase_id} (session ${row.session_id.slice(0, 8)}); follow it with: a run wait --run-id ${row.run_id}` };
  }
  if (cmd === "wait") {
    const out = wait({ runId: intFlag(args, "--run-id", true), seconds: intFlag(args, "--seconds") });
    const text = `Run ${out.run.run_id} ${out.run.status}${out.finished ? "" : " (still running)"} after ${out.waited_s}s${out.next ? `; next: ${out.next.step}` : ""}${out.run.error ? `; ${out.run.error}` : ""}`;
    return { exitCode: 0, json: { ...out, run: present(out.run) }, text };
  }
  if (cmd === "reap") {
    const rows = reap({ taskDir: word(args["--task-dir"]) ? ctx.taskDirOf(args["--task-dir"]) : undefined });
    return { exitCode: 0, json: rows.map(present), text: rows.length ? rows.map((r) => `Run ${r.run_id} ${r.status}`).join("\n") : "nothing to reap" };
  }
  if (cmd === "resume") {
    const row = resume({ runId: intFlag(args, "--run-id", true), brief: word(args["--brief"]) });
    return { exitCode: 0, json: present(row), text: `Run ${row.run_id} resumed from ${row.resumed_from}; follow it with: a run wait --run-id ${row.run_id}` };
  }
  if (cmd === "tail") {
    const out = tail({ runId: intFlag(args, "--run-id", true), lines: intFlag(args, "--lines") });
    const header = `Run ${out.run_id} ${out.agent} ${out.status} ${out.elapsed_s}s, ${out.tool_calls} tool calls${out.cost_usd === null ? "" : `, $${out.cost_usd}`}`;
    const { agent, ...json } = out;
    return { exitCode: 0, json, text: [header, ...out.tool_uses.map((u) => `${u.name}: ${u.detail}`)].join("\n") };
  }
  throw fail(2, `unknown run command: ${cmd}`);
}

module.exports = { AGENT_NAMES, schemaFor, claudeArgs, composeBrief, start, wait, reap, resume, tail, cli };
