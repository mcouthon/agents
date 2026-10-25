#!/usr/bin/env node
"use strict";
// The one-screen help and the verb list, through the CLI.
// Isolation: help runs touch nothing, but HOME and the roots point into a temp dir anyway.

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

const VERBS = ["start", "ls", "attach", "resume", "next", "report", "land", "task", "doctor"];
const help = cli(["--help"]);
const lines = help.out.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

// V1
check(help.status === 0 && lines.length <= 24 && lines.every((l) => l.length <= 80),
  `V1: a --help exits 0 in at most 24 lines of at most 80 columns (exit ${help.status}, ${lines.length} lines, widest ${Math.max(...lines.map((l) => l.length))})`);

// V2: the verbs block is the lines between the usage line and the closing line, one verb per line.
const block = lines.filter((l) => /^ {2}[a-z]+( {2,}|$)/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
check(block.length <= 10 && VERBS.every((v) => block.includes(v)), `V2: the verbs block lists ${VERBS.join(" ")} and at most 10 verbs (${block.join(" ")})`);

// V3
for (const v of VERBS) {
  const r = cli([v, "--help"]);
  check(r.status === 0 && r.out.split("\n")[0].startsWith(`Usage: a ${v}`) && r.err === "", `V3: a ${v} --help prints its usage (exit ${r.status}, first line ${JSON.stringify(r.out.split("\n")[0])}, stderr ${JSON.stringify(r.err)})`);
}
const unknown = cli(["nosuchverb", "--help"]);
check(unknown.err.length > 0, "V3: an unknown verb's --help writes to stderr");

// V4
const all = cli(["--help", "--all"]);
check(all.status === 0 && /\bcc\b/.test(all.out) && /\bsession\b/.test(all.out), "V4: a --help --all still lists cc and session");
const ccLs = cli(["cc", "ls", "--help"]);
check(ccLs.status === 0 && ccLs.out.includes("Usage: a cc ls") && ccLs.err === "", `V4: a cc ls --help still answers (exit ${ccLs.status})`);
const task = cli(["task", "--help"]);
check(/\bcreate\b/.test(task.out) && /\bimport\b/.test(task.out) && /\bclose\b/.test(task.out) && !/\bmigrate\b/.test(task.out), "V4: a task --help lists create, import and close, not migrate");
const sess = cli(["session", "--help"]);
check(/\bregister\b/.test(sess.out) && /\bls\b/.test(sess.out), "V4: a session --help still lists its commands");
const cc = cli(["cc", "--help"]);
check(/\battach\b/.test(cc.out) && /\bkill\b/.test(cc.out), "V4: a cc --help still lists its commands");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
