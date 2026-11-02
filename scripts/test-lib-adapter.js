#!/usr/bin/env node
"use strict";

// The adapter boundary's transcript fallback: how a cwd becomes the harness's
// ~/.claude/projects directory name. The rule, verified against the real
// project dirs on disk: every character that is not alphanumeric maps to "-",
// one per character, no collapsing ("." and "_" included — a worktree cwd
// /x/.agents/worktrees/... lives in -x--agents-worktrees-...).

const path = require("path");
const os = require("os");
const claude = require("./lib/adapter/claude-code");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const inProjects = (dir, file) => path.join(os.homedir(), ".claude", "projects", dir, file);

// A registration with transcript_path passes it through untouched.
{
  const got = claude.transcript({ transcript_path: "/tmp/t.jsonl" });
  if (got === "/tmp/t.jsonl") ok("transcript_path passes through");
  else fail_(`transcript_path should pass through, got: ${got}`);
}

// No transcript_path and no {sessionId, cwd} pair means no transcript.
{
  if (claude.transcript({}) === null && claude.transcript(null) === null) ok("no path and no pair returns null");
  else fail_("missing fields should return null");
}

// A cwd whose only special character is "/" encodes exactly as before.
{
  const got = claude.transcript({ sessionId: "s1", cwd: "/Users/t/code/agents" });
  const want = inProjects("-Users-t-code-agents", "s1.jsonl");
  if (got === want) ok("slash-only cwd encodes as before");
  else fail_(`slash-only cwd: want ${want}, got ${got}`);
}

// A worktree-style cwd: the "." in .agents becomes its own dash.
{
  const got = claude.transcript({ sessionId: "s2", cwd: "/Users/t/.agents/worktrees/agents/142-x" });
  const want = inProjects("-Users-t--agents-worktrees-agents-142-x", "s2.jsonl");
  if (got === want) ok("worktree cwd with a dot encodes the dot as a dash");
  else fail_(`dot cwd: want ${want}, got ${got}`);
}

// An underscore maps too (the pytest tmpdirs: /tmp/q_/test_read_x).
{
  const got = claude.transcript({ sessionId: "s3", cwd: "/tmp/q_/test_read_x" });
  const want = inProjects("-tmp-q--test-read-x", "s3.jsonl");
  if (got === want) ok("underscore encodes as a dash");
  else fail_(`underscore cwd: want ${want}, got ${got}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
