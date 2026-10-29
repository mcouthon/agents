#!/usr/bin/env node
"use strict";
// The one-screen help and the verb list, through the CLI.
// Isolation: HOME and the roots point into a temp dir; the runs that need a repo or a task create theirs inside it.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-verbs-")));
  for (const d of ["home", "xdg", "tasks", "sessions", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_DB: path.join(t, "agents.db"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_HOOKS_OFF", "CLAUDE_CODE_SESSION_ID", "ZMX_SESSION"]) delete process.env[k];
})();

const path = require("path");
const { spawnSync } = require("child_process");

const A = path.join(__dirname, "bin", "a");
let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }
function cli(args) {
  const r = spawnSync(process.execPath, [A, ...args], { encoding: "utf8", cwd: process.env.AGENTS_TEST_TMP, timeout: 30000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const VERBS = ["start", "doctor"];
const MACHINE_VERBS = ["ls", "next", "resume", "task", "decide", "land"];
const RETIRING = ["attach", "session", "worktree", "cc", "launch", "repo key", "tasks", "trash", "plan lint", "export", "task import", "task create", "policy", "hook"];
const help = cli(["--help"]);
const lines = help.out.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

// V1
check(help.status === 0 && lines.length <= 24 && lines.every((l) => l.length <= 80),
  `V1: a --help exits 0 in at most 24 lines of at most 80 columns (exit ${help.status}, ${lines.length} lines, widest ${Math.max(...lines.map((l) => l.length))})`);

// V2: the verbs block is the lines between the usage line and the closing line, one verb per line.
const verbLines = lines.filter((l) => /^ {2}([a-z]+)(, [a-z])?( {2,}|$)/.test(l));
const block = verbLines.map((l) => l.trim().split(/[\s,]+/)[0]);
check(JSON.stringify(block) === JSON.stringify(VERBS), `V2: a --help shows start and doctor only (${block.join(" ")})`);

// V2b
const labelOf = (l) => l.trim().split(/ {2,}/)[0];
const labels = verbLines.map(labelOf);
check(JSON.stringify(labels) === JSON.stringify(["start, s", "doctor, d"]), `V2b: the human verbs keep their aliases (${labels.join(" | ")})`);

// V3
for (const v of [...VERBS, ...MACHINE_VERBS]) {
  const r = cli([v, "--help"]);
  check(r.status === 0 && r.out.split("\n")[0].startsWith(`Usage: a ${v}`) && r.err === "", `V3: a ${v} --help prints its usage (exit ${r.status}, first line ${JSON.stringify(r.out.split("\n")[0])}, stderr ${JSON.stringify(r.err)})`);
}
const unknown = cli(["nosuchverb", "--help"]);
check(unknown.err.length > 0, "V3: an unknown verb's --help writes to stderr");

// V4: --help --all is the eight verbs and one retiring line, and its verb set is exactly that.
const all = cli(["--help", "--all"]);
const allLines = all.out.trimEnd().split("\n");
const allVerbs = allLines.slice(0, -1).map((l) => (l.match(/^ {2}(\w+)/) || [])[1]);
const retiringLine = allLines[allLines.length - 1];
check(all.status === 0 && JSON.stringify(allVerbs) === JSON.stringify([...VERBS, ...MACHINE_VERBS]) && allLines.slice(0, -1).every((l) => /^ {2}\w/.test(l)),
  `V4: a --help --all lists the eight verbs and nothing else before the retiring line (${allVerbs.join(" ")})`);
check(retiringLine === `retiring: ${RETIRING.join(", ")}`, `V4: the last line is the retiring list (${retiringLine})`);
for (const gone of [["state", "update"], ["run", "start"], ["report"], ["checkpoint", "open"], ["note"], ["task", "list"], ["task", "migrate"], ["task", "render"], ["tasks", "ls"], ["tasks", "show"]]) {
  const r = cli(gone);
  check(r.status === 2 && /Unknown|Usage/i.test(r.err), `V4: a ${gone.join(" ")} is gone (exit ${r.status})`);
}
// Each retiring verb still runs: its --help exits 0 with a usage page.
for (const v of RETIRING.filter((r) => r !== "hook")) {
  const r = cli([...v.split(" "), "--help"]);
  check(r.status === 0 && /^Usage: a /.test(r.out) && !/^Unknown/m.test(r.err), `V4: retiring verb "${v}" still answers --help (exit ${r.status})`);
}
const hookRun = cli(["hook", "no-such-hook"]);
check(hookRun.status === 0 && hookRun.err === "", `V4: retiring verb "hook" still runs and fails open (exit ${hookRun.status})`);
const tasksRoot = cli(["tasks", "root", "--json"]);
check(tasksRoot.status === 0 && typeof JSON.parse(tasksRoot.out).root === "string", `V4: a tasks root --json still runs (exit ${tasksRoot.status})`);
const ccLs = cli(["cc", "ls", "--help"]);
check(ccLs.status === 0 && ccLs.out.includes("Usage: a cc ls") && ccLs.err === "", `V4: a cc ls --help still answers (exit ${ccLs.status})`);
const task = cli(["task", "--help"]);
check(["new", "close", "read", "check", "add-phases", "set", "note"].every((c) => new RegExp(`^ {2}${c}\\b`, "m").test(task.out)) && !/^ {2}(create|import|migrate)\b/m.test(task.out), "V4: a task --help lists the seven task commands, not create, import or migrate");
const sess = cli(["session", "--help"]);
check(/\bregister\b/.test(sess.out) && /\bls\b/.test(sess.out), "V4: a session --help still lists its commands");
const cc = cli(["cc", "--help"]);
check(/\battach\b/.test(cc.out) && /\bkill\b/.test(cc.out), "V4: a cc --help still lists its commands");

// V5: every flag a help page prints has a short form, and no short letter means two flags.
const PAGES = [["start"], ["ls"], ["attach"], ["resume"], ["next"], ["land"], ["doctor"], ["task", "new"], ["task", "create"], ["task", "import"], ["task", "close"]];
const NO_GLOBAL = ["attach", "resume"];
for (const page of PAGES) {
  const name = page.join(" ");
  const out = cli([...page, "--help"]).out.split("\n");
  const flagLabels = [];
  for (let i = out.indexOf("Flags:") + 1; i > 0 && out[i]; i++) flagLabels.push(labelOf(out[i]));
  const longOnly = flagLabels.filter((l) => l.startsWith("--") && !l.startsWith("-- ") && !l.startsWith("--report-json"));
  check(longOnly.length === 0, `V5: every flag of a ${name} --help is written -x, --long (long-only: ${longOnly.join(" ") || "none"})`);

  const globalLine = out.find((l) => l.startsWith("Global:"));
  if (NO_GLOBAL.includes(name)) check(globalLine === undefined, `V5: a ${name} --help prints no Global line`);
  else check(globalLine === "Global: -j, --json, -r, --repo <path>", `V5: a ${name} --help Global line carries -j and -r (${globalLine})`);

  const pairs = [];
  for (const l of flagLabels) { const m = /^(-[A-Za-z]), (--[a-z][a-z-]*)/.exec(l); if (m) pairs.push([m[1], m[2]]); }
  if (globalLine) for (const m of globalLine.matchAll(/(-[A-Za-z]), (--[a-z][a-z-]*)/g)) pairs.push([m[1], m[2]]);
  const clash = pairs.filter(([s, long]) => pairs.some(([s2, long2]) => s === s2 && long !== long2));
  check(clash.length === 0 && !pairs.some(([s]) => s === "-h"), `V5: a ${name} --help maps each short letter to one long flag and none to -h (${pairs.map((p) => p.join("=")).join(" ")})`);
}

// V6: an alias behaves exactly like its verb.
const ALIAS_PAIRS = [
  [["s", "--bogus"], ["start", "--bogus"]],
  [["l", "--json"], ["ls", "--json"]],
  [["a"], ["attach"]],
  [["r"], ["resume"]],
  [["n"], ["next"]],
  [["t", "new"], ["task", "new"]],
  [["d", "hooks", "bogus"], ["doctor", "hooks", "bogus"]],
];
for (const [short, long] of ALIAS_PAIRS) {
  const s = cli(short), l = cli(long);
  check(s.status === l.status && s.out === l.out && s.err === l.err,
    `V6: a ${short.join(" ")} equals a ${long.join(" ")} (exit ${s.status} vs ${l.status})`);
}

const protoVerb = cli(["constructor"]);
check(protoVerb.status === 2 && protoVerb.err.startsWith("Usage: a <verb>"), `V6: a constructor is an unknown verb like any other (exit ${protoVerb.status}: ${protoVerb.err.split("\n")[0]})`);

// V7
const helpShort = cli(["-h"]);
check(helpShort.status === 0 && helpShort.out.split("\n")[0].startsWith("Usage: a <verb>"), "V7: a -h prints the verb list");
const startShort = cli(["s", "-h"]);
check(startShort.status === 0 && startShort.out.split("\n")[0].startsWith("Usage: a start") && startShort.out.includes("-t, --title <text>"), "V7: a s -h prints the start page with its short flags");
const taskShort = cli(["t", "-h"]);
check(taskShort.status === 0 && /^ {2}new\b/m.test(taskShort.out), "V7: a t -h lists new");

// V8: bin/a's own parser expands shorts before it reads flags.
const fs = require("fs");
const fx = path.join(process.env.AGENTS_TEST_TMP, "fx");
fs.mkdirSync(fx);
const git = (...a) => spawnSync("git", ["-C", fx, "-c", "user.email=t@e", "-c", "user.name=t", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(fx, "f.txt"), "x\n");
git("add", "f.txt");
git("commit", "-q", "-m", "init");
require("./lib/task").createTask({ repo: require("./lib/repo").repoKey(fx), title: "Fx", slug: "fx", mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" });

const shortAll = cli(["ls", "-a", "-j"]), longAll = cli(["ls", "--all", "--json"]);
check(shortAll.status === 0 && shortAll.out === longAll.out, `V8: a ls -a -j prints what a ls --all --json prints (exit ${shortAll.status})`);
const viaSpace = cli(["ls", "001", "-r", fx, "-j"]), viaEq = cli(["ls", "001", `-r=${fx}`, "-j"]), viaLong = cli(["ls", "001", "--repo", fx, "--json"]);
check(viaSpace.status === 0 && viaSpace.out === viaLong.out && viaEq.out === viaLong.out && JSON.parse(viaLong.out).task.title === "Fx",
  `V8: -r <path> and -r=<path> select the repo like --repo (exits ${viaSpace.status}/${viaEq.status}/${viaLong.status})`);
const noRepo = cli(["ls", "001", "--json"]);
check(noRepo.status === 4 && noRepo.out.includes('"error":"not_found"'), `V8: without -r the same task is not found (exit ${noRepo.status})`);
const bundled = cli(["ls", "-aj"]);
check(bundled.status === 2 && bundled.err.includes("-a") && bundled.err.includes("-j"), `V8: a ls -aj is refused naming -a and -j (exit ${bundled.status}: ${bundled.err.trim()})`);
const unknownShort = cli(["ls", "-z"]);
check(unknownShort.status === 2 && unknownShort.err.includes("-z"), `V8: a ls -z is refused naming -z (exit ${unknownShort.status}: ${unknownShort.err.trim()})`);

// V9: start and doctor name every failure they can print in their help.
{
  const literalSegments = (message) => message.replace(/\\(.)/g, "$1").split(/\$\{[^}]*\}/).map((s) => s.trim()).filter((s) => s.length >= 6);
  const sitesOf = (file, ...res) => res.flatMap((re) => [...fs.readFileSync(path.join(__dirname, file), "utf8").matchAll(re)].flatMap((m) => m.slice(1).map((lit) => lit.slice(1, -1))));
  const FAIL_RE = /\bfail\(\s*\d+\s*,\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*")/g;
  const LIT = "(`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\")";
  const TERNARY_RE = new RegExp(`\\bfail\\(\\s*\\d+\\s*,\\s*[\\w.]+\\s*\\?\\s*${LIT}\\s*:\\s*${LIT}`, "g");
  const ISSUE_RE = /issues\.push\(\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*")/g;
  for (const [page, file, re] of [["start", "lib/start.js", [FAIL_RE, TERNARY_RE]], ["doctor", "bin/a", [ISSUE_RE]]]) {
    const helpOut = cli([page, "--help"]).out;
    const sites = sitesOf(file, ...re);
    const missing = sites.flatMap(literalSegments).filter((seg) => !helpOut.includes(seg));
    check(sites.length > 0 && missing.length === 0 && /\nExample:\n {2}a \w+/.test(helpOut) && helpOut.split("Example:").length === 2,
      `V9: a ${page} --help carries one example and all ${sites.length} failure messages (missing: ${[...new Set(missing)].join(" | ") || "none"})`);
  }
}

// V10: every verb PAV's agents_cli.py runs still exits 0, with parseable JSON where PAV parses it.
{
  const { execFileSync } = require("child_process");
  const tmp = process.env.AGENTS_TEST_TMP;
  const stubBin = path.join(tmp, "pav-stubs");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "zmx"), '#!/bin/sh\ncase "$1" in --version) echo "zmx 0.8.1" ;; esac\nexit 0\n', { mode: 0o755 });
  const claudeLog = path.join(tmp, "pav-claude.log");
  fs.writeFileSync(path.join(stubBin, "claude"), `#!/bin/sh\necho "$@" >> '${claudeLog}'\nexit 0\n`, { mode: 0o755 });
  process.env.PATH = `${stubBin}:${process.env.PATH}`;

  const gitIn = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const origin = path.join(tmp, "pav-origin.git");
  const R = path.join(tmp, "pav-repo");
  fs.mkdirSync(R);
  gitIn(tmp, "init", "-q", "--bare", "-b", "main", origin);
  gitIn(R, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(R, "README.md"), "# pav\n");
  gitIn(R, "add", ".");
  gitIn(R, "commit", "-q", "-m", "init");
  gitIn(R, "remote", "add", "origin", origin);
  gitIn(R, "push", "-q", "-u", "origin", "main");
  gitIn(R, "remote", "set-head", "origin", "main");
  require("./lib/db").open({ create: true });
  const mkTask = (slug) => require("./lib/task").createTask({ repo: require("./lib/repo").repoKey(R), title: slug, slug, mode: "full", tier: "standard", phases: [{ id: 1, name: "Build" }], description: "" }).task_dir;
  const T1 = mkTask("pav-one"), T2 = mkTask("pav-two"), T3 = mkTask("pav-three");

  const pav = (label, args, { json = true, parses = true, cwd = R } = {}) => {
    const argv = json ? [...args, "--json"] : args;
    const r = spawnSync(process.execPath, [A, ...argv], { encoding: "utf8", cwd, timeout: 60000 });
    let data;
    try { data = JSON.parse(r.stdout); } catch { data = undefined; }
    check(r.status === 0 && (!parses || data !== undefined), `V10: PAV runs ${label} (${args.join(" ").slice(0, 50)}) -> exit ${r.status}${parses ? `, JSON ${data === undefined ? "NOT parseable: " + r.stdout.slice(0, 80) + r.stderr.slice(0, 120) : "parses"}` : ""}${r.status === 0 ? "" : " " + r.stdout.slice(0, 200) + r.stderr.slice(0, 160)}`);
    return data;
  };

  pav("session ls", ["session", "ls"]);
  pav("task read", ["task", "read", "--task-dir", T1, "--repo", R]);
  pav("next", ["next", "--task-dir", T1, "--repo", R]);
  const created = pav("task create", ["task", "create", "--title", "From PAV", "--repo", R, "--slug", "from-pav", "--mode", "full", "--tier", "strategic", "--description", "d", "--phases-json", JSON.stringify([{ id: 1, name: "One" }])]);
  check(created && created.slug === "004-from-pav", `V10: task create through PAV's arguments made task 004 (${created && created.slug})`);
  const root = pav("tasks root", ["tasks", "root", "--repo", R]);
  check(root && typeof root.root === "string" && root.root.length > 0, `V10: tasks root names a root PAV reads (${root && root.root})`);
  const courier = pav("start courier", ["start", "--title", "PAV courier", "--courier", "--repo", R]);
  check(courier && typeof courier.session_id === "string" && typeof courier.cwd === "string" && courier.mux && typeof courier.mux.name === "string", "V10: start --courier prints the session fields PAV reads (session_id, cwd, mux.name)");
  const here = pav("start here", ["start", T2, "--here", "--repo", R]);
  check(here && typeof here.session_id === "string" && here.mux && typeof here.mux.name === "string", "V10: start <task> --here prints the session fields PAV reads");
  const wt = pav("start worktree", ["start", T3, "--worktree", "--repo", R]);
  check(wt && typeof wt.session_id === "string" && typeof wt.cwd === "string" && wt.cwd !== R, "V10: start <task> --worktree prints a session in a worktree");
  pav("resume", ["resume", courier ? courier.session_id : "missing", "--no-attach"]);
  const added = pav("worktree add", ["worktree", "add", "--task", T1, "--repo", R]);
  check(added && typeof added.path === "string" && typeof added.branch === "string", "V10: worktree add prints the path and branch PAV reads");
  const listed = pav("worktree list", ["worktree", "list", "--repo", R]);
  check(Array.isArray(listed) && listed.length > 0 && listed.every((w) => "path" in w && "branch" in w), "V10: worktree list prints the array of entries with path and branch that PAV reads");
  pav("worktree remove", ["worktree", "remove", added ? added.path : "missing", "--repo", R], { parses: false });
  pav("worktree clean", ["worktree", "clean", "--repo", R]);
  pav("launch", ["launch", "--agent", "conductor", "--session-id", "11111111-2222-3333-4444-555555555555", "--cwd", R], { json: false, parses: false });
  check(fs.existsSync(claudeLog) && /--session-id 11111111-2222-3333-4444-555555555555/.test(fs.readFileSync(claudeLog, "utf8")), "V10: launch ran the claude stub with the session id PAV passed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
