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

// bin/a never starts with the real checkout as cwd: a stray repo-local .tasks/ there must stay untouched.
const CLI_CWD = makeRepo("cli-cwd");
const nodeExec = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: CLI_CWD, ...opts });

function runCli(repoPath, args) {
  const fullArgs = [...args, "--repo", repoPath, "--json"];
  const out = nodeExec("node", [CLI, ...fullArgs], {
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

// 3. task new (task create is its hidden alias)
let createdTask;
try {
  createdTask = runCli(repo, ["task", "new", "--title", "Contract Test", "--slug", "contract-test", "--phases-json", '[{"id":1,"name":"Phase 1"}]']);
  matchShape(createdTask, {
    task_dir: "<string>",
    slug: "<string>",
    number: "<number>",
  });
  if (createdTask.number === 1) ok("task new --json shape matches golden (number=1)");
  else fail_("task new number should be 1");
} catch (e) { fail_("task new: " + e); }
try {
  const aliased = runCli(repo, ["task", "create", "--title", "Old Name", "--slug", "old-name"]);
  if (aliased.number === 2 && aliased.slug === "002-old-name") ok("task create still creates a task (the hidden alias of task new)");
  else fail_("task create alias: " + JSON.stringify(aliased));
} catch (e) { fail_("task create alias: " + e); }

// 5. task read (the derived structure of Design 4: the roster row plus the
// phases with after/checked/plan hash, the decisions with their gate, the notes
// and last_land)
try {
  const out = runCli(repo, ["task", "read", "--task-dir", createdTask.slug]);
  matchShape(out, {
    repo_key: "<string>",
    main_root: "<any>",
    number: "<number>",
    slug: "<string>",
    dir: "<string>",
    title: "<string>",
    tier: "<string>",
    mode: "<string>",
    task_status: "<string>",
    phases_checked: "<number>",
    phases_total: "<number>",
    current_phase: "<any>",
    advice: {
      move: "<string>",
      text: "<string>",
      question: "<any>",
      warnings: [],
    },
    approvals: "<string>",
    migrated: "<boolean>",
    attention: "<boolean>",
    landing: "<any>",
    live: "<any>",
    resumable: "<any>",
    worktree: "<any>",
    branch: "<any>",
    updated: "<any>",
    phases: [{
      id: "<number>",
      name: "<any>",
      after: [],
      checked: "<boolean>",
      checked_at: "<any>",
      checked_by: "<any>",
      skipped: "<boolean>",
      plan_file: "<any>",
      plan_hash: "<any>",
      approved: "<boolean>",
      accepted: "<boolean>",
    }],
    decisions: [],
    notes: [],
    last_land: "<any>",
  });
  if (out.task_status === "open" && out.approvals === "none" && out.decisions.length === 0)
    ok("task read --json shape matches golden (the derived structure)");
  else fail_("task read values: status=" + out.task_status + " approvals=" + out.approvals + " decisions=" + JSON.stringify(out.decisions));
} catch (e) { fail_("task read: " + e); }

// 6. task add-phases: a new id appends, the JSON names every phase
try {
  const out = runCli(repo, ["task", "add-phases", "--task-dir", createdTask.slug, "--phases-json", '[{"id":2,"name":"Phase 2","after":[1]}]']);
  matchShape(out, { phases: [{ id: "<number>", name: "<string>", checked: "<boolean>", blocked_by: [] }, { id: "<number>", name: "<string>", checked: "<boolean>", blocked_by: ["<number>"] }] });
  if (out.phases[1].checked === false && out.phases[1].blocked_by[0] === 1) ok("task add-phases --json shape matches golden and appends an unchecked phase");
  else fail_("task add-phases: " + JSON.stringify(out));
} catch (e) { fail_("task add-phases: " + e); }

// 6b. task check and task note
try {
  const checked = runCli(repo, ["task", "check", "--task-dir", createdTask.slug, "--phase-id", "1"]);
  matchShape(checked, { id: "<number>", name: "<string>", checked: "<boolean>", checked_at: "<string>", checked_by: "<string>" });
  const again = runCli(repo, ["task", "check", "--task-dir", createdTask.slug, "--phase-id", "1"]);
  if (checked.checked === true && again.checked_at === checked.checked_at) ok("task check --json shape matches golden and is idempotent");
  else fail_("task check: " + JSON.stringify([checked, again]));
} catch (e) { fail_("task check: " + e); }
try {
  let status = 0, out = "";
  try { nodeExec("node", [CLI, "task", "check", "--task-dir", createdTask.slug, "--phase-id", "9", "--repo", repo, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { status = e.status; out = (e.stdout || "").toString(); }
  const body = out ? JSON.parse(out) : {};
  if (status === 2 && body.error === "unknown_phase" && /add_phases/.test(body.remedy || "")) ok("task check on an unknown phase exits 2 with its remedy");
  else fail_(`task check unknown phase: exit=${status} ${out.slice(0, 200)}`);
} catch (e) { fail_("task check unknown phase: " + e); }
try {
  const noted = runCli(repo, ["task", "note", "--task-dir", createdTask.slug, "--phase-id", "1", "--text", "see the review"]);
  if (noted && noted.phase && noted.phase.note === "see the review") ok("task note sets the phase note");
  else fail_("task note: " + JSON.stringify(noted));
} catch (e) { fail_("task note: " + e); }

// 6c. under overridden roots, a run in a repo with a repo-local .tasks/ leaves that folder alone
try {
  const planted = makeRepo("planted-tasks");
  const old = path.join(planted, ".tasks", "042-old-task");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "task.md"), "# Old\n");
  runCli(planted, ["task", "create", "--title", "Fresh", "--slug", "fresh", "--phases-json", '[{"id":1,"name":"One"}]']);
  runCli(planted, ["ls"]);
  const moved = fs.existsSync(path.join(process.env.AGENTS_TASKS_ROOT, "042-old-task"));
  if (fs.existsSync(path.join(old, "task.md")) && !moved) ok("a run under AGENTS_TASKS_ROOT leaves a repo-local .tasks/ folder untouched");
  else fail_(`planted .tasks/ moved: local=${fs.existsSync(old)} central=${moved}`);
} catch (e) { fail_("planted .tasks: " + e); }

// 7. task set: approvals and land only
try {
  const out = runCli(repo, ["task", "set", "--task-dir", createdTask.slug, "--knob", "approvals", "--value", "none"]);
  matchShape(out, { knob: "<string>", value: "<string>" });
  ok("task set --json shape matches golden");
} catch (e) { fail_("task set: " + e); }
try {
  let status = 0, out = "";
  try { out = nodeExec("node", [CLI, "task", "set", "--task-dir", createdTask.slug, "--knob", "enforcement", "--value", "deny", "--repo", repo, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { status = e.status; out = (e.stdout || "").toString(); }
  const body = JSON.parse(out);
  if (status === 2 && body.error === "unknown_knob" && typeof body.remedy === "string" && body.remedy.length > 0) ok("a refusal under --json carries error, message and remedy");
  else fail_("refusal shape: " + status + " " + out);
} catch (e) { fail_("refusal shape: " + e); }

// 8. a next --json: the advice and its worktree
try {
  const out = runCli(repo, ["next", "--task-dir", createdTask.slug]);
  matchShape(out, {
    task_dir: "<string>",
    title: "<string>",
    advice: {
      phase: { id: "<number>", name: "<string>", plan_path: "<any>", plan: "<boolean>", approved: "<boolean>", accepted: "<boolean>", commits: "<boolean>" },
      move: "<string>",
      advice: "<string>",
      question: "<any>",
      approvals: "<string>",
      migrated: "<boolean>",
      worktree: "<any>",
      ready: ["<number>"],
      checked: [],
      warnings: [],
    },
    decisions: [],
    notes: [],
    worktree: "<any>",
  });
  ok("a next --json shape matches golden (advice, decisions, notes, worktree)");
} catch (e) { fail_("a next: " + e); }

// 9. the state machine's verbs are gone
for (const gone of [["state", "update"], ["state", "flag"], ["state", "prime"], ["run", "start"], ["report"], ["checkpoint", "open"], ["task", "list"], ["task", "migrate"], ["task", "render"], ["tasks", "ls"], ["tasks", "show"]]) {
  try {
    let status = 0;
    try { nodeExec("node", [CLI, ...gone, "--repo", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { status = e.status; }
    if (status === 2) ok(`a ${gone.join(" ")} exits 2 as an unknown verb`);
    else fail_(`a ${gone.join(" ")} should exit 2, got ${status}`);
  } catch (e) { fail_("gone verb: " + e); }
}

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
    nodeExec("node", [CLI, "launch", ...launchArgs], {
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

// 20. --help: `a --help` exits 0 and prints the verbs; `a --help --all` prints
// the group list (derived from the COMMANDS table). Output goes to stdout.
try {
  const help = (extra) => {
    let exitCode = null, stdout = "";
    try {
      stdout = nodeExec("node", [CLI, "--help", ...extra, "--repo", repo], {
        encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
    return { exitCode, stdout };
  };
  const verbs = help([]), all = help(["--all"]);
  const shown = [...verbs.stdout.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]);
  if (verbs.exitCode === null && shown.join() === "start,doctor") ok("a --help exits 0 and shows start and doctor only");
  else fail_(`a --help: exit=${verbs.exitCode} verbs=${shown.join()}`);
  const allLines = all.stdout.trimEnd().split("\n");
  const allVerbs = allLines.slice(0, -1).map((l) => (l.match(/^ {2}(\w+)/) || [])[1]);
  const retiring = (allLines[allLines.length - 1].match(/^retiring: (.*)$/) || [])[1];
  const RETIRING = "attach, session, worktree, cc, launch, repo key, tasks, trash, plan lint, export, task import, task create, policy, hook";
  if (all.exitCode === null && allVerbs.join() === "start,doctor,ls,next,resume,task,decide,land,check" && retiring === RETIRING) ok("a --help --all prints exactly the nine verbs and one retiring line, nothing else");
  else fail_(`a --help --all: exit=${all.exitCode} verbs=${allVerbs.join()} retiring=${retiring}`);
  const hiddenInHelp = RETIRING.split(", ").filter((v) => {
    const first = v.split(" ")[0];
    return allVerbs.includes(first) && !["task"].includes(first);
  });
  if (hiddenInHelp.length === 0) ok("no retiring verb is among the listed verbs");
  else fail_("retiring verbs listed as verbs: " + hiddenInHelp.join());
  const taskHelp = nodeExec("node", [CLI, "task", "--help"], { encoding: "utf8", timeout: 10000 });
  const subs = [...taskHelp.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]);
  if ([...subs].sort().join() === "add-phases,check,close,new,note,read,set") ok("a task --help lists the seven task commands and neither create nor import");
  else fail_("a task --help: " + subs.join());
} catch (e) { fail_("a --help test: " + e); }

// 21. --help short-circuit: `a task set --task-dir <fixture> --help`
// exits 0 WITHOUT running the update — the row's knob is unchanged and no
// knob event is written. Guards against the bug where --help arrived after
// arg validation ran.
try {
  const origEmit = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = require("node:sqlite");
  process.emitWarning = origEmit;
  const dbFile = path.join(process.env.AGENTS_TASKS_ROOT, ".agents.db");
  const rowState = () => {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return JSON.stringify(d.prepare(
        "SELECT land, (SELECT count(*) FROM events WHERE kind = 'knob') AS knobs FROM tasks WHERE task_dir = ?"
      ).get(createdTask.task_dir));
    } finally { d.close(); }
  };
  const before = rowState();
  if (before === "undefined") throw new Error(`no row for ${createdTask.task_dir} in ${dbFile}`);
  let exitCode = null, stdout = "";
  try {
    stdout = nodeExec("node", [CLI, "task", "set", "--task-dir", createdTask.task_dir, "--knob", "land", "--value", "at_end", "--help", "--repo", repo], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
  const after = rowState();
  const beforeRow = JSON.parse(before);
  if (exitCode === null && stdout.includes("task set") && stdout.includes("Set a task knob") &&
      before === after && beforeRow.land === "per_phase") {
    ok("a task set --task-dir <fixture> --help exits 0, changes nothing");
  } else {
    fail_(`task set --help: exit=${exitCode} row=${before}->${after} stdout=${JSON.stringify(stdout.slice(0, 80))}`);
  }
} catch (e) { fail_("task set --help test: " + e); }

// 22. --help on a no-subcommand group: `a land --help` exits 0 (previously
// failed with "--task-dir is required" because --help was not checked).
try {
  let exitCode = null, stdout = "";
  try {
    stdout = nodeExec("node", [CLI, "land", "--help", "--repo", repo], {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { exitCode = e.status; stdout = (e.stdout || "").toString(); }
  if (exitCode === null && stdout.includes("land") && stdout.includes("--task-dir")) {
    ok("a land --help exits 0 and prints usage (no --task-dir error)");
  } else {
    fail_(`land --help: exit=${exitCode} stdout=${JSON.stringify(stdout.slice(0, 120))}`);
  }
} catch (e) { fail_("land --help test: " + e); }

// 23. resume refuses --repo, so its help must not advertise it as a global flag.
try {
  const helpOf = (verb) => nodeExec("node", [CLI, verb, "--help", "--repo", repo], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  const resumeHelp = helpOf("resume"), landHelp = helpOf("land");
  if (!resumeHelp.includes("Global:") && resumeHelp.includes("--no-attach") && /^Global: .*--json.*--repo/m.test(landHelp)) {
    ok("a resume --help lists no Global flags; other verbs still do");
  } else {
    fail_(`resume --help Global line: ${JSON.stringify(resumeHelp)}`);
  }
} catch (e) { fail_("resume --help test: " + e); }

// 24. A task given by absolute path is placed from the tasks root's index; one the index cannot place is refused
// before anything reads policy, launches an agent or writes. The stub claude logs every launch.
const stubBin = path.join(tmpBase, "stubbin");
const claudeLog = path.join(tmpBase, "claude.log");
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, "claude"), `#!/bin/sh\necho "$@" >> '${claudeLog}'\nexit 0\n`, { mode: 0o755 });
const stubEnv = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };

function runIn(cwd, args) {
  const r = require("child_process").spawnSync("node", [CLI, ...args, "--json"], { encoding: "utf8", cwd, timeout: 20000, env: stubEnv });
  let data = null;
  try { data = JSON.parse(r.stdout); } catch { /* the caller's check reports it */ }
  return { status: r.status, data, stdout: r.stdout, stderr: r.stderr };
}

const niTask = runCli(repo, ["task", "new", "--title", "Placed", "--slug", "placed", "--phases-json", '[{"id":1,"name":"One"}]']);
const elsewhere = path.join(tmpBase, "elsewhere");
fs.mkdirSync(elsewhere);
const copy = path.join(elsewhere, path.basename(niTask.task_dir));
fs.cpSync(niTask.task_dir, copy, { recursive: true });
// v2: a copied task dir holds task.md, not task.json; the copy is a folder the
// database has no row for, so every verb must refuse it without writing.
const copyState = () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [[p.slice(copy.length), fs.readFileSync(p)]];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(walk(copy));
};

const NOT_INDEXED = [
  ["NI1 next", ["next", "--task-dir", copy]],
  ["NI3 decide", ["decide", "--task-dir", copy, "--phase-id", "1", "--choice", "approve", "--quote", "go"]],
  ["NI4 task note", ["task", "note", "--task-dir", copy, "--phase-id", "1", "--text", "x"]],
  ["NI5 land", ["land", "--task-dir", copy, "--phase-id", "1"]],
  ["NI6 task add-phases", ["task", "add-phases", "--task-dir", copy, "--phases-json", '[{"id":2,"name":"Two","after":[]}]']],
];
for (const [label, argv] of NOT_INDEXED) {
  try {
    const before = copyState();
    const r = runIn(repo, argv);
    const untouched = before === copyState();
    const launched = fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8") : "";
    if (r.status === 2 && r.data && r.data.error === "not_indexed" && r.data.task_dir === copy && untouched && launched === "") {
      ok(`${label} on a task outside the tasks root exits 2 not_indexed, writes nothing, launches nothing`);
    } else {
      fail_(`${label}: exit=${r.status} stdout=${JSON.stringify((r.stdout || "").slice(0, 160))} untouched=${untouched} launched=${JSON.stringify(launched)}`);
    }
  } catch (e) { fail_(`${label}: ${e}`); }
}

// NI7. An explicit --repo no longer places an unregistered copy: v2 has one
// source, the row, and the copy has none — not_found, nothing written.
try {
  const before = copyState();
  const r = runIn(repo, ["next", "--task-dir", copy, "--repo", repo]);
  if (r.status === 4 && r.data && r.data.error === "not_found" && before === copyState()) ok("NI7 a next --task-dir <copy> --repo <repo> refuses not_found (no row for the copy)");
  else fail_(`NI7: exit=${r.status} stdout=${JSON.stringify((r.stdout || "").slice(0, 160))} stderr=${JSON.stringify((r.stderr || "").slice(0, 160))}`);
} catch (e) { fail_("NI7: " + e); }

// NI9. A task in the index is placed from the index even when the caller stands in another directory.
try {
  const r = runIn(elsewhere, ["next", "--task-dir", niTask.task_dir]);
  if (r.status === 0 && r.data && r.data.advice && typeof r.data.advice.move === "string") ok("NI9 a next --task-dir <indexed task> run from a directory outside any repo exits 0");
  else fail_(`NI9: exit=${r.status} stdout=${JSON.stringify((r.stdout || "").slice(0, 160))} stderr=${JSON.stringify((r.stderr || "").slice(0, 160))}`);
} catch (e) { fail_("NI9: " + e); }

// NT1. The text form prints Phase, Next, Worktree and Task dir lines.
try {
  const asked = runCli(repo, ["task", "create", "--title", "Asked", "--slug", "asked", "--phases-json", '[{"id":1,"name":"One"},{"id":2,"name":"Two"}]']);
  const text = require("child_process").spawnSync("node", [CLI, "next", "--task-dir", asked.task_dir, "--repo", repo], { encoding: "utf8", cwd: CLI_CWD, env: stubEnv });
  if (text.status === 0 && /^Phase: 1 One$/m.test(text.stdout) && /^Next: .+/m.test(text.stdout) && /^Worktree: /m.test(text.stdout) && text.stdout.includes(`Task dir: ${asked.task_dir}`) && !text.stdout.includes("[object Object]")) ok("NT1 a next text prints Phase:, Next:, Worktree: and Task dir: lines");
  else fail_(`NT1: exit=${text.status} stdout=${JSON.stringify(text.stdout)}`);
} catch (e) { fail_("NT1: " + e); }

// D41. The doctor lists the v1 backups beside the database (the migration's .v1.bak files).
try {
  runCli(repo, ["task", "new", "--title", "Doctor probe", "--slug", "doctor-probe", "--phases-json", '[{"id":1,"name":"One"}]']);
  const dbFile = path.join(process.env.AGENTS_TASKS_ROOT, ".agents.db");
  const bak = `${dbFile}.v1.bak`;
  const stamped = `${dbFile}.v1.bak.20261030T120000Z`;
  fs.writeFileSync(bak, "v1\n");
  fs.writeFileSync(stamped, "v1\n");
  const doc = require("child_process").spawnSync("node", [CLI, "doctor", "--json"], { encoding: "utf8", cwd: CLI_CWD, timeout: 20000, env: stubEnv });
  const data = JSON.parse(doc.stdout);
  const listed = data.db && data.db.v1_backups;
  if (JSON.stringify(listed) === JSON.stringify([bak, stamped])) ok("D41 a doctor --json lists every agents.db.v1.bak* beside the database");
  else fail_(`D41: listed=${JSON.stringify(listed)}`);
  const text = require("child_process").spawnSync("node", [CLI, "doctor"], { encoding: "utf8", cwd: CLI_CWD, timeout: 20000, env: stubEnv });
  if (text.stderr.includes(`v1 backup: ${bak}`) && text.stderr.includes(`v1 backup: ${stamped}`)) ok("D41 the doctor's text form prints one line per backup");
  else fail_(`D41 text: ${JSON.stringify(text.stderr.slice(-400))}`);
  fs.rmSync(bak, { force: true });
  fs.rmSync(stamped, { force: true });
} catch (e) { fail_("D41: " + e); }

// not_in_repo: a task verb from a non-repo cwd exits 2 with the code and remedy.
try {
  const nonRepo = path.join(tmpBase, "non-repo-dir");
  fs.mkdirSync(nonRepo, { recursive: true });
  const r = require("child_process").spawnSync("node", [CLI, "next", "--task-dir", "001", "--json"], {
    encoding: "utf8", cwd: nonRepo, timeout: 10000,
  });
  if (r.status === 2 && r.stdout.includes('"not_in_repo"') && r.stderr.includes("not inside a git repository") && r.stderr.includes("Remedy:"))
    ok("not_in_repo: a task verb from a non-repo cwd exits 2 with the code and remedy");
  else fail_(`not_in_repo: exit=${r.status} stdout=${JSON.stringify(r.stdout).slice(0, 120)} stderr=${JSON.stringify(r.stderr).slice(0, 120)}`);
} catch (e) { fail_("not_in_repo: " + e); }

// a task close --delete: the flag trashes; without it, close archives.
try {
  const t1 = runCli(repo, ["task", "new", "--title", "Archive me", "--slug", "archive-me"]);
  const c1 = runCli(repo, ["task", "close", "--task-dir", t1.task_dir]);
  if (c1.action === "archive" && c1.archivePath) ok("task close without --delete archives");
  else fail_(`task close without --delete: ${JSON.stringify(c1).slice(0, 100)}`);

  const t2 = runCli(repo, ["task", "new", "--title", "Delete me", "--slug", "delete-me"]);
  const c2 = runCli(repo, ["task", "close", "--task-dir", t2.task_dir, "--delete"]);
  if (c2.action === "delete" && c2.trashed_to && !fs.existsSync(t2.task_dir)) ok("task close --delete trashes the folder");
  else fail_(`task close --delete: ${JSON.stringify(c2).slice(0, 100)}`);
} catch (e) { fail_("task close --delete: " + e); }

// Cleanup
try { require("./lib/session").unregister(testSid); } catch {}
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
