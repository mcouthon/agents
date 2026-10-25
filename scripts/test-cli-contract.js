#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const CLI = path.join(__dirname, "bin", "a");
const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-cli-contract-")));

// Isolate the session registry to a tmpdir so this test never writes to the
// real ~/.agents/sessions. runCli inherits this via process.env.
process.env.AGENTS_SESSIONS_ROOT = path.join(tmpBase, "sessions");
fs.mkdirSync(process.env.AGENTS_SESSIONS_ROOT, { recursive: true });
process.env.AGENTS_TASKS_ROOT = path.join(tmpBase, "tasks-root");
// Clear the parent session's pointer so register() doesn't treat test
// sessions as nested (the parent Claude session sets this env var).
delete process.env.AGENTS_SESSION_DIR;
// Skip process identity check in isLive (test processes run "node", not "claude").
process.env.AGENTS_TEST_SKIP_IDENTITY = "1";
fs.mkdirSync(process.env.AGENTS_TASKS_ROOT, { recursive: true });

function makeRepo(name) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function runCli(repoPath, args) {
  const fullArgs = [...args, "--repo", repoPath, "--json"];
  const out = execFileSync("node", [CLI, ...fullArgs], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function matchShape(actual, golden, p = "root") {
  if (golden === "<string>") {
    if (typeof actual !== "string") throw `${p}: expected string, got ${typeof actual}`;
  } else if (golden === "<number>") {
    if (typeof actual !== "number") throw `${p}: expected number, got ${typeof actual}`;
  } else if (golden === "<boolean>") {
    if (typeof actual !== "boolean") throw `${p}: expected boolean, got ${typeof actual}`;
  } else if (golden === "<any>") {
    if (actual === undefined) throw `${p}: expected any value, got undefined`;
  } else if (Array.isArray(golden)) {
    if (!Array.isArray(actual)) throw `${p}: expected array`;
    if (golden.length > 0 && actual.length > 0) matchShape(actual[0], golden[0], `${p}[]`);
  } else if (typeof golden === "object" && golden !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual))
      throw `${p}: expected object, got ${actual === null ? "null" : typeof actual}`;
    const gk = new Set(Object.keys(golden));
    const ak = new Set(Object.keys(actual));
    for (const k of gk) {
      if (!ak.has(k)) throw `${p}: missing key "${k}"`;
      matchShape(actual[k], golden[k], `${p}.${k}`);
    }
    for (const k of ak) {
      if (!gk.has(k)) throw `${p}: unexpected key "${k}"`;
    }
  } else {
    if (actual !== golden) throw `${p}: expected ${JSON.stringify(golden)}, got ${JSON.stringify(actual)}`;
  }
}

const repo = makeRepo("contract-repo");

// 1. repo key
try {
  const out = runCli(repo, ["repo", "key"]);
  matchShape(out, {
    main_root: "<string>",
    origin_slug: "<string>",
    base: "<string>",
    key: "<string>",
  });
  ok("repo key --json shape matches golden");
} catch (e) { fail_("repo key: " + e); }

// 2. tasks root
try {
  const out = runCli(repo, ["tasks", "root"]);
  matchShape(out, { root: "<string>" });
  ok("tasks root --json shape matches golden");
} catch (e) { fail_("tasks root: " + e); }

// 3. task create
let createdTask;
try {
  createdTask = runCli(repo, ["task", "create", "--title", "Contract Test", "--slug", "contract-test", "--phases-json", '[{"id":1,"name":"Phase 1"}]']);
  matchShape(createdTask, {
    task_dir: "<string>",
    slug: "<string>",
    number: "<number>",
  });
  if (createdTask.number === 1) ok("task create --json shape matches golden (number=1)");
  else fail_("task create number should be 1");
} catch (e) { fail_("task create: " + e); }

// 4. task list
try {
  const out = runCli(repo, ["task", "list"]);
  matchShape(out, {
    updated: "<string>",
    tasks: [{
      slug: "<string>",
      dir: "<string>",
      task_dir_abs: "<string>",
      status: "<string>",
      schema: "<number>",
      tier: "<string>",
      total_phases: "<number>",
      completed_phases: "<number>",
      current_phase: "<any>",
      flags: "<number>",
      updated: "<string>",
    }],
  });
  ok("task list --json shape matches golden");
} catch (e) { fail_("task list: " + e); }

// 5. task read (D33: returns task.json v2 shape, not v1 state.json; D34: additive
// fields landed_sha, warnings, conflict on phases; worktree_path on task)
try {
  const out = runCli(repo, ["task", "read", "--task-dir", createdTask.slug]);
  matchShape(out, {
    schema: "<number>",
    slug: "<string>",
    number: "<number>",
    title: "<string>",
    status: "<string>",
    mode: "<string>",
    tier: "<string>",
    knobs: {
      review_plan: "<boolean>",
      review_code: "<boolean>",
      approve: "<string>",
      commit: "<string>",
      parallel: "<number>",
      enforcement: "<string>",
      land: "<string>",
    },
    binding: "<any>",
    lease: "<any>",
    last_writer: "<any>",
    phases: [{
      id: "<number>",
      name: "<string>",
      status: "<string>",
      owner: "<any>",
      blocked_by: [],
      parallel_group: "<string>",
      plan_path: "<string>",
      manifest: [],
      note: "<string>",
      reports: "<any>",
      commits: [],
      branch: "<string>",
      counters: "<any>",
      started: "<any>",
      completed: "<any>",
      landed_sha: "<any>",
      warnings: [],
      conflict: "<any>",
    }],
    worktree_path: "<string>",
    checkpoints: [],
    flags: [],
    created: "<string>",
    updated: "<string>",
  });
  ok("task read --json shape matches golden (v2)");
} catch (e) { fail_("task read: " + e); }

// 6. state update
try {
  const out = runCli(repo, ["state", "update", "--task-dir", createdTask.slug, "--task-status", "in_progress"]);
  matchShape(out, { updated: "<string>" });
  ok("state update --json shape matches golden");
} catch (e) { fail_("state update: " + e); }

// 6a. state update --commits moves implemented → committed under deny (D34)
//     and refuses an unknown SHA
let commitsTaskSlug;
let commitSha;
try {
  commitsTaskSlug = runCli(repo, ["task", "create", "--title", "Commits Test", "--slug", "commits-test", "--phases-json", '[{"id":1,"name":"Phase 1"}]']).slug;

  // Skip evidence guards so the transition chain doesn't need reports
  runCli(repo, ["task", "set", "--task-dir", commitsTaskSlug, "--knob", "review_plan", "--value", "false"]);
  runCli(repo, ["task", "set", "--task-dir", commitsTaskSlug, "--knob", "review_code", "--value", "false"]);
  runCli(repo, ["task", "set", "--task-dir", commitsTaskSlug, "--knob", "approve", "--value", "auto"]);

  // Make a real commit on the base branch
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  execFileSync("git", ["-C", repo, "add", "feature.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "feat: add feature"], { stdio: "pipe" });
  commitSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // Set phase to implemented directly (setup — not a state update).
  // D35: tasks live at the central root, not repo-local .tasks/.
  const tasksRootDir = runCli(repo, ["tasks", "root"]).root;
  const taskJsonPath = path.join(tasksRootDir, commitsTaskSlug, "task.json");
  const taskObj = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));
  taskObj.phases[0].status = "implemented";
  fs.writeFileSync(taskJsonPath, JSON.stringify(taskObj, null, 2));

  // state update --commits <sha> --phase-status committed → succeeds
  const out = runCli(repo, ["state", "update", "--task-dir", commitsTaskSlug, "--phase-id", "1", "--phase-status", "committed", "--commits", commitSha]);
  matchShape(out, { updated: "<string>" });

  const after = runCli(repo, ["task", "read", "--task-dir", commitsTaskSlug]);
  if (after.phases[0].status === "committed" &&
      after.phases[0].commits.length === 1 &&
      after.phases[0].commits[0] === commitSha)
    ok("state update --commits moves implemented → committed under deny");
  else fail_("state update --commits: status=" + after.phases[0].status + " commits=" + JSON.stringify(after.phases[0].commits));

  // state update --commits <unknown-sha> → refuses
  let refused = false;
  try {
    runCli(repo, ["state", "update", "--task-dir", commitsTaskSlug, "--phase-id", "1", "--commits", "deadbeefnotarealsha"]);
  } catch (e) { refused = true; }
  if (refused) ok("state update --commits refuses an unknown SHA");
  else fail_("state update --commits should refuse unknown SHA");
} catch (e) { fail_("state update --commits: " + e); }

// 6b. committed → landed is refused without test evidence, then records landed_sha on base once a Builder report has it
try {
  let refusal = "";
  try {
    runCli(repo, ["state", "update", "--task-dir", commitsTaskSlug, "--phase-id", "1", "--phase-status", "landed"]);
  } catch (e) { refusal = String(e.stderr) + String(e.stdout); }
  const unchanged = runCli(repo, ["task", "read", "--task-dir", commitsTaskSlug]).phases[0].status;
  if (refusal.includes("land refused for phase 1: missing tests.") && unchanged === "committed")
    ok("state update --phase-status landed is refused without test evidence and the phase stays committed");
  else fail_("state update landed without evidence: refusal=" + JSON.stringify(refusal) + " status=" + unchanged);

  const tasksRoot = runCli(repo, ["tasks", "root"]).root;
  const landedTaskPath = path.join(tasksRoot, commitsTaskSlug, "task.json");
  const landedTask = JSON.parse(fs.readFileSync(landedTaskPath, "utf8"));
  landedTask.phases[0].reports.builder = { files_touched: [], verification: [{ cmd: "npm test", exit: 0, summary: "ok" }], deviations: [], summary: "built" };
  fs.writeFileSync(landedTaskPath, JSON.stringify(landedTask, null, 2));

  const out = runCli(repo, ["state", "update", "--task-dir", commitsTaskSlug, "--phase-id", "1", "--phase-status", "landed"]);
  matchShape(out, { updated: "<string>" });

  const after = runCli(repo, ["task", "read", "--task-dir", commitsTaskSlug]);
  if (after.phases[0].status === "landed" && after.phases[0].landed_sha === commitSha)
    ok("committed → landed on base records landed_sha");
  else fail_("committed → landed: status=" + after.phases[0].status + " landed_sha=" + after.phases[0].landed_sha);
} catch (e) { fail_("committed → landed on base: " + e); }

// 6c. task read exposes landed_sha (D34)
try {
  const out = runCli(repo, ["task", "read", "--task-dir", commitsTaskSlug]);
  if (out.phases[0].landed_sha === commitSha)
    ok("task read --json exposes landed_sha");
  else fail_("task read should expose landed_sha: got " + out.phases[0].landed_sha);
} catch (e) { fail_("task read exposes landed_sha: " + e); }

// 7. state flag
let flagId;
try {
  const out = runCli(repo, ["state", "flag", "--task-dir", createdTask.slug, "--phase-id", "1", "--type", "blocked", "--message", "test"]);
  matchShape(out, {
    id: "<string>",
    phase: "<number>",
    type: "<string>",
    total_flags: "<number>",
  });
  flagId = out.id;
  ok("state flag --json shape matches golden");
} catch (e) { fail_("state flag: " + e); }

// 8. state clear-flag
try {
  const out = runCli(repo, ["state", "clear-flag", "--task-dir", createdTask.slug, "--flag-id", flagId]);
  matchShape(out, {
    removed: "<string>",
    remaining: "<number>",
  });
  ok("state clear-flag --json shape matches golden");
} catch (e) { fail_("state clear-flag: " + e); }

// 9. state add-phases
try {
  const phasesJson = JSON.stringify([{ id: 2, name: "Phase 2" }]);
  const out = runCli(repo, ["state", "add-phases", "--task-dir", createdTask.slug, "--phases-json", phasesJson]);
  matchShape(out, {
    added: "<number>",
    summary: "<string>",
    total: "<number>",
  });
  ok("state add-phases --json shape matches golden");
} catch (e) { fail_("state add-phases: " + e); }

// 10. state prime
try {
  const out = runCli(repo, ["state", "prime", "--task-dir", createdTask.slug]);
  matchShape(out, {
    task: "<string>",
    status: "<string>",
    phases_done: "<number>",
    phases_total: "<number>",
    current: "<string>",
    flags: "<number>",
  });
  ok("state prime --json shape matches golden");
} catch (e) { fail_("state prime: " + e); }

// 10a. a next --json carries how: {tool, command} for every step (D37)
try {
  const out = runCli(repo, ["next", "--task-dir", createdTask.slug]);
  matchShape(out, {
    step: "<string>",
    phase_ids: ["<number>"],
    agent: "<any>",
    reason: "<string>",
    checkpoint: "<any>",
    caps: "<any>",
    overrides: "<any>",
    warnings: [],
    how: { tool: "<any>", command: "<any>" },
  });
  ok("a next --json shape matches golden (includes how: {tool, command})");
} catch (e) { fail_("a next: " + e); }

// 11. policy
try {
  const out = runCli(repo, ["policy"]);
  matchShape(out, {
    push: "<string>",
    worktree: "<string>",
    merge: "<string>",
    base: "<string>",
    source: "<string>",
  });
  ok("policy --json shape matches golden");
} catch (e) { fail_("policy: " + e); }

// 12. session register
const testSid = `contract-${Date.now()}`;
const SESSION_REGISTER_GOLDEN = {
  registration: {
    schema: "<number>",
    origin: "<string>",
    session_id: "<string>",
    terminal_id: "<any>",
    workflow_id: "<any>",
    task_dir: "<any>",
    commitment_id: "<any>",
    project_id: "<any>",
    initiator: "<any>",
    agent: "<string>",
    repo_key: "<any>",
    cwd: "<string>",
    pid: "<any>",
    transcript_path: "<any>",
    tmux: "<any>",
    created_at: "<string>",
    updated_at: "<string>",
  },
  session_dir: "<string>",
};
try {
  const out = runCli(repo, ["session", "register", "--session-id", testSid, "--agent", "conductor"]);
  matchShape(out, SESSION_REGISTER_GOLDEN);
  ok("session register --json shape matches golden");
} catch (e) { fail_("session register: " + e); }

// 12b. register again after unregister: still the same golden (no pid_at, no
// mux key, no ended_at left over from the unregister).
try {
  const gone = runCli(repo, ["session", "unregister", "--session-id", testSid]);
  matchShape(gone, { unregistered: "<boolean>" });
  const again = runCli(repo, ["session", "register", "--session-id", testSid, "--agent", "conductor"]);
  matchShape(again, SESSION_REGISTER_GOLDEN);
  ok("session register after unregister matches the golden and clears ended_at");
} catch (e) { fail_("session register after unregister: " + e); }

// 13. session ls
try {
  const out = runCli(repo, ["session", "ls"]);
  matchShape(out, [{
    schema: "<number>",
    origin: "<string>",
    session_id: "<string>",
    terminal_id: "<any>",
    workflow_id: "<any>",
    task_dir: "<any>",
    commitment_id: "<any>",
    project_id: "<any>",
    initiator: "<any>",
    agent: "<any>",
    repo_key: "<any>",
    cwd: "<any>",
    pid: "<any>",
    transcript_path: "<any>",
    tmux: "<any>",
    created_at: "<string>",
    updated_at: "<string>",
  }]);
  ok("session ls --json shape matches golden");
} catch (e) { fail_("session ls: " + e); }

// 13a. session touch --json
try {
  const out = runCli(repo, ["session", "touch", "--session-id", testSid]);
  matchShape(out, { touched: "<boolean>" });
  ok("session touch --json shape matches golden");
} catch (e) { fail_("session touch: " + e); }

// 13b. cc ls --json (tmux-absent path: tmux_sessions is empty when no pav
// tmux server is running; the golden tolerates a running server too)
try {
  const out = runCli(repo, ["cc", "ls"]);
  matchShape(out, { sessions: [], tmux_sessions: ["<string>"], zmx_sessions: ["<string>"] });
  const found = out.sessions.some((s) => s && s.session_id === testSid);
  if (!found) throw `sessions should include registered testSid ${testSid}`;
  ok("cc ls --json shape matches golden (sessions + tmux_sessions arrays)");
} catch (e) { fail_("cc ls: " + e); }

// 14. session unregister
try {
  const out = runCli(repo, ["session", "unregister", "--session-id", testSid]);
  matchShape(out, { unregistered: "<boolean>" });
  ok("session unregister --json shape matches golden");
} catch (e) { fail_("session unregister: " + e); }

// 15. Deliberately-broken golden — proves the guard can fail
try {
  const out = runCli(repo, ["repo", "key"]);
  matchShape(out, {
    main_root: "<string>",
    origin_slug: "<string>",
    base: "<string>",
    key: "<string>",
    extra_key_that_does_not_exist: "<string>",
  });
  fail_("deliberately-broken golden should have failed but passed");
} catch (e) {
  ok("deliberately-broken golden correctly fails: " + e);
}

// 16. launch mints a UUID session-id and does not exit 2 (usage error).
// A capture script stands in for `claude` so we can assert the exact argv
// `a launch` spawns, without depending on the real CLI (which rejects
// non-UUID --session-id with exit 0, masking the bug this test guards).
const captureScript = path.join(tmpBase, "capture.js");
const captureFile = path.join(tmpBase, "capture-args.json");
fs.writeFileSync(captureScript,
  "#!/usr/bin/env node\n" +
  "const fs = require(\"fs\");\n" +
  "fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)) + \"\\n\");\n");
fs.chmodSync(captureScript, 0o755);
const captureConfig = path.join(tmpBase, "launch-config.json");
fs.writeFileSync(captureConfig, JSON.stringify({ launch: { command: captureScript } }));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runLaunch(launchArgs) {
  const env = { ...process.env, AGENTS_CONFIG_PATH: captureConfig, CAPTURE_FILE: captureFile };
  let exitCode = null;
  let stderr = "";
  try {
    execFileSync("node", [CLI, "launch", ...launchArgs], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env,
    });
  } catch (e) {
    exitCode = e.status;
    stderr = (e.stderr || "").toString();
  }
  let captured = null;
  if (fs.existsSync(captureFile)) {
    captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    fs.unlinkSync(captureFile);
  }
  return { exitCode, stderr, captured };
}

try {
  const { exitCode, captured } = runLaunch(["--agent", "test", "--cwd", tmpBase, "--", "--add-dir", tmpBase]);
  const sidIdx = captured ? captured.indexOf("--session-id") : -1;
  const sidVal = sidIdx >= 0 ? captured[sidIdx + 1] : null;
  const hasAddDir = captured ? captured.includes("--add-dir") : false;
  if (exitCode === null && sidIdx >= 0 && UUID_RE.test(sidVal) && hasAddDir) {
    ok(`launch mints UUID session-id, forwards -- passthrough (sid=${sidVal})`);
  } else {
    fail_(`launch: exit=${exitCode} sid=${sidVal} addDir=${hasAddDir} captured=${JSON.stringify(captured)}`);
  }
} catch (e) { fail_("launch test: " + e); }

// 17. launch passes an explicit --session-id through unchanged (does not
// overwrite a caller-supplied UUID with a minted one).
try {
  const explicit = "11111111-2222-3333-4444-555555555555";
  const { captured } = runLaunch(["--session-id", explicit, "--agent", "test", "--cwd", tmpBase]);
  const sidIdx = captured ? captured.indexOf("--session-id") : -1;
  const sidVal = sidIdx >= 0 ? captured[sidIdx + 1] : null;
  if (sidVal === explicit) ok(`launch passes explicit --session-id through unchanged`);
  else fail_(`launch explicit sid: got ${sidVal}, expected ${explicit}`);
} catch (e) { fail_("launch explicit-sid test: " + e); }

// 18. launch: a value-flag immediately before `--` does not consume `--` as
// its value — `--` is always a separator. Guards `a cc --worktree -- --add-dir`.
try {
  const { exitCode, captured } = runLaunch(["--agent", "test", "--cwd", tmpBase, "--worktree", "--", "--add-dir", tmpBase]);
  const hasAddDir = captured ? captured.includes("--add-dir") : false;
  const worktreeIdx = captured ? captured.indexOf("--worktree") : -1;
  // Bare --worktree before -- must not reach claude; --add-dir must survive.
  if (exitCode === null && hasAddDir && worktreeIdx === -1) {
    ok("launch: `--` separates a value-flag (bare --worktree not consumed, --add-dir forwarded)");
  } else {
    fail_(`launch -- separator: exit=${exitCode} addDir=${hasAddDir} wtIdx=${worktreeIdx} captured=${JSON.stringify(captured)}`);
  }
} catch (e) { fail_("launch -- separator test: " + e); }

// 19. cc: Courier without --task, --title, or prompt errors (D38 item 3).
// Proves `a cc courier` parses correctly and the Courier guard fires.
try {
  let exitCode = null, stderr = "";
  try {
    execFileSync("node", [CLI, "cc", "courier", "--repo", repo, "--no-attach"], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { exitCode = e.status; stderr = (e.stderr || "").toString(); }
  if (exitCode === 2 && stderr.includes("Courier needs")) {
    ok("cc courier without task/title/prompt errors with 'Courier needs' (exit 2)");
  } else {
    fail_(`cc bare worktree: exit=${exitCode} stderr=${JSON.stringify(stderr)}`);
  }
} catch (e) { fail_("cc bare worktree test: " + e); }

// 20. --help: `a --help` exits 0 and prints the verbs; `a --help --all` prints
// the group list (derived from the COMMANDS table). Output goes to stdout.
try {
  const help = (extra) => {
    let exitCode = null, stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "--help", ...extra, "--repo", repo], {
        encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
    return { exitCode, stdout };
  };
  const verbs = help([]), all = help(["--all"]);
  if (verbs.exitCode === null && /^ {2}start /m.test(verbs.stdout) && !verbs.stdout.includes("Groups:")
    && all.exitCode === null && all.stdout.includes("Groups:") && all.stdout.includes("state update|flag")) {
    ok("a --help exits 0 and prints the verbs; a --help --all prints the group list");
  } else {
    fail_(`a --help: exit=${verbs.exitCode}/${all.exitCode} stdout=${JSON.stringify(verbs.stdout.slice(0, 120))}`);
  }
} catch (e) { fail_("a --help test: " + e); }

// 21. --help short-circuit: `a state update --task-dir <fixture> --help`
// exits 0 WITHOUT running the update — the fixture's task.json is unchanged.
// Guards against the bug where --help arrived after arg validation ran.
try {
  const taskDirAbs = path.isAbsolute(createdTask.task_dir)
    ? createdTask.task_dir : path.resolve(repo, createdTask.task_dir);
  const taskJsonPath = path.join(taskDirAbs, "task.json");
  const before = fs.existsSync(taskJsonPath)
    ? fs.readFileSync(taskJsonPath, "utf8") : null;
  let exitCode = null, stdout = "";
  try {
    stdout = execFileSync("node", [CLI, "state", "update", "--task-dir", createdTask.task_dir, "--help", "--repo", repo], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
  const after = fs.existsSync(taskJsonPath)
    ? fs.readFileSync(taskJsonPath, "utf8") : null;
  if (exitCode === null && stdout.includes("state update") && stdout.includes("(required)") &&
      before !== null && before === after) {
    ok("a state update --task-dir <fixture> --help exits 0, changes nothing");
  } else {
    fail_(`state update --help: exit=${exitCode} changed=${before !== after} stdout=${JSON.stringify(stdout.slice(0, 80))}`);
  }
} catch (e) { fail_("state update --help test: " + e); }

// 22. --help on a no-subcommand group: `a land --help` exits 0 (previously
// failed with "--task-dir is required" because --help was not checked).
try {
  let exitCode = null, stdout = "";
  try {
    stdout = execFileSync("node", [CLI, "land", "--help", "--repo", repo], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
  if (exitCode === null && stdout.includes("land") && stdout.includes("--task-dir")) {
    ok("a land --help exits 0 and prints usage (no --task-dir error)");
  } else {
    fail_(`land --help: exit=${exitCode} stdout=${JSON.stringify(stdout.slice(0, 120))}`);
  }
} catch (e) { fail_("land --help test: " + e); }

// 23. attach and resume refuse --repo, so their help must not advertise it as a global flag.
try {
  const helpOf = (verb) => execFileSync("node", [CLI, verb, "--help", "--repo", repo], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  const attachHelp = helpOf("attach"), resumeHelp = helpOf("resume"), landHelp = helpOf("land");
  if (!attachHelp.includes("Global:") && !resumeHelp.includes("Global:") && attachHelp.includes("Example:") && resumeHelp.includes("--no-attach") && landHelp.includes("Global: --json, --repo")) {
    ok("a attach --help and a resume --help list no Global flags; other verbs still do");
  } else {
    fail_(`attach/resume --help Global line: ${JSON.stringify(attachHelp)} / ${JSON.stringify(resumeHelp)}`);
  }
} catch (e) { fail_("attach/resume --help test: " + e); }

// Cleanup
try { require("./lib/session").unregister(testSid); } catch {}
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
