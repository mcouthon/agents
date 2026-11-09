#!/usr/bin/env node
"use strict";
// The backup job's snapshot commit: one retry across a failed first commit (B1) and a
// held .git/index.lock (B2).
// Isolation: nothing here may touch the real HOME, config, git config or tasks root.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")));
  for (const d of ["home", "xdg", "logs"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    AGENTS_LOGS_ROOT: path.join(t, "logs"),
    AGENTS_TEST_TMP: t,
  });
  for (const k of ["AGENTS_SESSION_DIR", "AGENTS_SESSION_ID", "AGENTS_NODE", "AGENTS_HOOKS_OFF", "AGENTS_TEST_SKIP_IDENTITY",
    "CLAUDE_CODE_SESSION_ID", "ZMX_SESSION", "AGENTS_BACKUP_RETRY_WAIT_MS"]) delete process.env[k];
})();

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const A = path.join(__dirname, "bin", "a");
const T = process.env.AGENTS_TEST_TMP;
let counter = 0;
const mk = (label) => { const d = path.join(T, `${label}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };

// A tasks-root fixture: a git repo with one committed file, then made dirty.
function fixtureRoot(label) {
  const root = mk(label);
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "seed.md"), "# seed\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(root, "record.md"), "# a record\n");
  return root;
}

function backup(root, env = {}) {
  const r = spawnSync(process.execPath, [A, "tasks", "backup", "--json"], {
    encoding: "utf8", timeout: 60000, cwd: T,
    env: { ...process.env, AGENTS_TASKS_ROOT: root, AGENTS_DB: path.join(root, "no.db"), ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const bodyOf = (out) => { try { return JSON.parse(out); } catch { return null; } };

// B1: a first commit that fails once — the retry commits. A pre-commit hook consumes its
// fail-once flag on the first commit it sees, so the failure at attempt 1 is causal, not
// a clock window the pool's load can miss; the flag gone plus a clean tree is the retry's proof.
{
  const root = fixtureRoot("b1");
  const hooks = path.join(root, ".git", "hooks");
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nd=$(dirname \"$0\")\n[ -f \"$d/fail-once\" ] && { rm -f \"$d/fail-once\"; exit 1; }\nexit 0\n");
  fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
  fs.writeFileSync(path.join(hooks, "fail-once"), "");
  const r = backup(root, { AGENTS_BACKUP_RETRY_WAIT_MS: "100" });
  const body = bodyOf(r.out);
  check(r.status === 0 && body && body.committed === true,
    `B1: a first commit that fails once commits on the retry (exit ${r.status}: ${r.out.trim().slice(0, 120)}${r.err.trim().slice(0, 120)})`);
  check(!fs.existsSync(path.join(hooks, "fail-once")),
    "B1: the first attempt's commit genuinely failed (the hook consumed its fail-once flag)");
  const clean = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  check(clean === "", `B1: the retry committed the dirty record (${JSON.stringify(clean)})`);
}

// B2: a permanent lock — both attempts fail, the error names them, and the run stops there.
{
  const root = fixtureRoot("b2");
  fs.writeFileSync(path.join(root, ".git", "index.lock"), "");
  const r = backup(root, { AGENTS_BACKUP_RETRY_WAIT_MS: "100" });
  // Exiting 2 with the twice-error is the no-loop proof: a loop could never exit — it
  // would die at the child's 60 s timer as a timeout, not exit 2 with this message.
  check(r.status === 2 && r.err.includes("failed twice") && r.err.includes("attempt 1") && r.err.includes("attempt 2"),
    `B2: a permanent lock fails naming both attempts, retried once and stopped (exit ${r.status}: ${r.err.trim().slice(0, 200)})`);
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  check(dirty.includes("record.md"), `B2: nothing was committed under the lock (${JSON.stringify(dirty)})`);
}

// B3: the happy path — no lock, one commit, no retry.
{
  const root = fixtureRoot("b3");
  // The retry wait sits above the child's 60 s kill timer: a run that entered the retry
  // could never exit 0, so a clean exit is itself the no-retry proof — no clock bound,
  // which the check pool's load would move.
  const r = backup(root, { AGENTS_BACKUP_RETRY_WAIT_MS: "120000" });
  const body = bodyOf(r.out);
  check(r.status === 0 && body && body.committed === true && body.pushed === false,
    `B3: an uncontended root commits once with no retry and skips the push (exit ${r.status}: ${JSON.stringify(body)})`);
  const again = backup(root);
  const againBody = bodyOf(again.out);
  check(again.status === 0 && againBody && againBody.committed === false && /nothing to snapshot/.test(againBody.message),
    `B3: a clean root reports nothing to snapshot (${JSON.stringify(againBody)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
