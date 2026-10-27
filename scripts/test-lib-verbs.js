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

const VERBS = ["start", "ls", "attach", "resume", "next", "decide", "land", "run", "task", "doctor"];
const help = cli(["--help"]);
const lines = help.out.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

// V1
check(help.status === 0 && lines.length <= 24 && lines.every((l) => l.length <= 80),
  `V1: a --help exits 0 in at most 24 lines of at most 80 columns (exit ${help.status}, ${lines.length} lines, widest ${Math.max(...lines.map((l) => l.length))})`);

// V2: the verbs block is the lines between the usage line and the closing line, one verb per line.
const verbLines = lines.filter((l) => /^ {2}([a-z]+)(, [a-z])?( {2,}|$)/.test(l));
const block = verbLines.map((l) => l.trim().split(/[\s,]+/)[0]);
check(block.length <= 10 && VERBS.every((v) => block.includes(v)), `V2: the verbs block lists ${VERBS.join(" ")} and at most 10 verbs (${block.join(" ")})`);

// V2b
const ALIASED = ["start, s", "ls, l", "attach, a", "resume, r", "next, n", "task, t", "doctor, d"];
const labelOf = (l) => l.trim().split(/ {2,}/)[0];
const labels = verbLines.map(labelOf);
check(ALIASED.every((a) => labels.includes(a)), `V2b: the verbs block shows the aliases ${ALIASED.join(" | ")} (${labels.join(" | ")})`);
check(labels.includes("decide") && labels.includes("land") && labels.includes("run") && !labels.includes("report"), `V2b: decide, land and run carry no alias, and report has left the block (${labels.join(" | ")})`);

// V3
for (const v of VERBS) {
  const r = cli([v, "--help"]);
  check(r.status === 0 && r.out.split("\n")[0].startsWith(`Usage: a ${v}`) && r.err === "", `V3: a ${v} --help prints its usage (exit ${r.status}, first line ${JSON.stringify(r.out.split("\n")[0])}, stderr ${JSON.stringify(r.err)})`);
}
for (const hidden of ["report", "note"]) {
  const r = cli([hidden, "--help"]);
  check(r.status === 0 && r.out.split("\n")[0].startsWith(`Usage: a ${hidden}`) && r.err === "", `V3: a ${hidden} --help still prints its usage (exit ${r.status}, first line ${JSON.stringify(r.out.split("\n")[0])})`);
}
const unknown = cli(["nosuchverb", "--help"]);
check(unknown.err.length > 0, "V3: an unknown verb's --help writes to stderr");

// V4
const all = cli(["--help", "--all"]);
check(all.status === 0 && /\bcc\b/.test(all.out) && /\bsession\b/.test(all.out), "V4: a --help --all still lists cc and session");
check(/\breport\b/.test(all.out) && /\bnote\b/.test(all.out), "V4: a --help --all lists report and note");
const ccLs = cli(["cc", "ls", "--help"]);
check(ccLs.status === 0 && ccLs.out.includes("Usage: a cc ls") && ccLs.err === "", `V4: a cc ls --help still answers (exit ${ccLs.status})`);
const task = cli(["task", "--help"]);
check(/\bcreate\b/.test(task.out) && /\bimport\b/.test(task.out) && /\bclose\b/.test(task.out) && !/\bmigrate\b/.test(task.out), "V4: a task --help lists create, import and close, not migrate");
const sess = cli(["session", "--help"]);
check(/\bregister\b/.test(sess.out) && /\bls\b/.test(sess.out), "V4: a session --help still lists its commands");
const cc = cli(["cc", "--help"]);
check(/\battach\b/.test(cc.out) && /\bkill\b/.test(cc.out), "V4: a cc --help still lists its commands");

// V5: every flag a help page prints has a short form, and no short letter means two flags.
const PAGES = [["start"], ["ls"], ["attach"], ["resume"], ["next"], ["report"], ["land"], ["doctor"], ["task", "create"], ["task", "import"], ["task", "close"]];
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
  [["t", "create"], ["task", "create"]],
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
check(taskShort.status === 0 && /\bcreate\b/.test(taskShort.out), "V7: a t -h lists create");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
