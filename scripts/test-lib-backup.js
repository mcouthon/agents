#!/usr/bin/env node
"use strict";
// The backup job's snapshot commit: one retry across a held .git/index.lock.
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
const { spawn, spawnSync, execFileSync } = require("child_process");

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
  const started = Date.now();
  const r = spawnSync(process.execPath, [A, "tasks", "backup", "--json"], {
    encoding: "utf8", timeout: 60000, cwd: T,
    env: { ...process.env, AGENTS_TASKS_ROOT: root, AGENTS_DB: path.join(root, "no.db"), ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - started };
}
const bodyOf = (out) => { try { return JSON.parse(out); } catch { return null; } };

// B1: a lock present at the first attempt, released during the retry wait — the retry commits.
{
  const root = fixtureRoot("b1");
  const lock = path.join(root, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  // The holder drops the lock 0.15 s in; the retry wait is 0.4 s, so the second attempt runs unlocked.
  const holder = spawn("/bin/sh", ["-c", '/bin/sleep "$1" && /bin/rm -f "$2"', "holder", "0.15", lock], { stdio: "ignore", detached: true });
  holder.unref();
  const r = backup(root, { AGENTS_BACKUP_RETRY_WAIT_MS: "400" });
  const body = bodyOf(r.out);
  check(r.status === 0 && body && body.committed === true,
    `B1: a lock released during the wait commits on the retry (exit ${r.status}: ${r.out.trim().slice(0, 120)}${r.err.trim().slice(0, 120)})`);
  check(r.ms >= 350, `B1: the success took the retry wait, not an instant pass (${r.ms} ms)`);
  const clean = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  check(clean === "", `B1: the retry committed the dirty record (${JSON.stringify(clean)})`);
}

// B2: a permanent lock — both attempts fail, the error names them, and the run stops there.
{
  const root = fixtureRoot("b2");
  fs.writeFileSync(path.join(root, ".git", "index.lock"), "");
  const r = backup(root, { AGENTS_BACKUP_RETRY_WAIT_MS: "100" });
  check(r.status === 2 && r.err.includes("failed twice") && r.err.includes("attempt 1") && r.err.includes("attempt 2"),
    `B2: a permanent lock fails naming both attempts (exit ${r.status}: ${r.err.trim().slice(0, 200)})`);
  check(r.ms < 1500, `B2: the run retried once and stopped, no loop (${r.ms} ms)`);
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  check(dirty.includes("record.md"), `B2: nothing was committed under the lock (${JSON.stringify(dirty)})`);
}

// B3: the happy path — no lock, one commit, no retry wait.
{
  const root = fixtureRoot("b3");
  const r = backup(root);
  const body = bodyOf(r.out);
  check(r.status === 0 && body && body.committed === true && body.pushed === false,
    `B3: an uncontended root commits once and skips the push (exit ${r.status}: ${JSON.stringify(body)})`);
  // The bound detects the default 5 s retry wait; boot plus git cost can run ~0.9 s under load.
  check(r.ms < 4000, `B3: the happy path takes no retry wait (${r.ms} ms)`);
  const again = backup(root);
  const againBody = bodyOf(again.out);
  check(again.status === 0 && againBody && againBody.committed === false && /nothing to snapshot/.test(againBody.message),
    `B3: a clean root reports nothing to snapshot (${JSON.stringify(againBody)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
