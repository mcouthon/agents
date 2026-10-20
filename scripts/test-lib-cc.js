#!/usr/bin/env node
"use strict";

const { resolveWorktree, buildLaunchCommand } = require("./lib/cc");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

// --- resolveWorktree (gap 1: bare --worktree) ---

// T1: bare --worktree with --task derives <NNN>-<slug> (matches `a worktree add --task`)
try {
  const name = resolveWorktree({ worktreeFlag: true, taskDir: "/repo/.tasks/128-pav-agents-determinism" });
  if (name === "128-pav-agents-determinism") ok("T1: bare --worktree with --task derives <NNN>-<slug>");
  else fail_(`T1: bare worktree name, got ${JSON.stringify(name)}`);
} catch (e) { fail_("T1: bare worktree with task threw: " + e); }

// T2: bare --worktree without --task errors
try {
  resolveWorktree({ worktreeFlag: true, taskDir: null });
  fail_("T2: bare --worktree without --task should error");
} catch (e) {
  if (e.message === "--worktree needs a name") ok("T2: bare --worktree without --task errors");
  else fail_(`T2: wrong error message: ${JSON.stringify(e.message)}`);
}

// T3: explicit --worktree value passes through unchanged
try {
  const name = resolveWorktree({ worktreeFlag: "my-wt", taskDir: null });
  if (name === "my-wt") ok("T3: explicit --worktree value passes through");
  else fail_(`T3: explicit worktree, got ${JSON.stringify(name)}`);
} catch (e) { fail_("T3: explicit worktree threw: " + e); }

// T4: absent --worktree returns undefined
try {
  const name = resolveWorktree({ worktreeFlag: undefined, taskDir: null });
  if (name === undefined) ok("T4: absent --worktree returns undefined");
  else fail_(`T4: absent worktree, got ${JSON.stringify(name)}`);
} catch (e) { fail_("T4: absent worktree threw: " + e); }

// T5: explicit value wins even when a task is bound (no derivation)
try {
  const name = resolveWorktree({ worktreeFlag: "custom", taskDir: "/repo/.tasks/128-foo" });
  if (name === "custom") ok("T5: explicit --worktree value wins over task derivation");
  else fail_(`T5: explicit-with-task, got ${JSON.stringify(name)}`);
} catch (e) { fail_("T5: explicit-with-task threw: " + e); }

// --- buildLaunchCommand (gap 2: -- passthrough + --add-dir) ---

// T6: always adds `-- --add-dir <tasksRoot>` even with no passthrough
try {
  const cmd = buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: undefined, tasksRoot: "/home/.agents/tasks/key", passthrough: [],
  });
  const sepIdx = cmd.indexOf("--");
  const ddIdx = cmd.indexOf("--add-dir");
  if (sepIdx >= 0 && ddIdx === sepIdx + 1 && cmd[ddIdx + 1] === "/home/.agents/tasks/key") {
    ok("T6: always appends `-- --add-dir <tasksRoot>`");
  } else fail_(`T6: add-dir placement wrong: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T6: buildLaunchCommand add-dir threw: " + e); }

// T7: forwards passthrough args after --add-dir
try {
  const cmd = buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: undefined, tasksRoot: "/root",
    passthrough: ["--settings", "/s.json", "--add-dir", "/extra"],
  });
  const ddIdx = cmd.indexOf("--add-dir");
  const tail = cmd.slice(ddIdx);
  if (tail[0] === "--add-dir" && tail[1] === "/root" &&
      tail.includes("--settings") && tail.includes("/s.json") &&
      tail.includes("/extra")) {
    ok("T7: forwards passthrough args after --add-dir <tasksRoot>");
  } else fail_(`T7: passthrough not forwarded: ${JSON.stringify(tail)}`);
} catch (e) { fail_("T7: buildLaunchCommand passthrough threw: " + e); }

// T8: includes --worktree <name> when given
try {
  const cmd = buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: "128-slug", tasksRoot: "/root", passthrough: [],
  });
  const wtIdx = cmd.indexOf("--worktree");
  if (wtIdx >= 0 && cmd[wtIdx + 1] === "128-slug" && wtIdx < cmd.indexOf("--")) {
    ok("T8: includes --worktree <name> before the -- separator");
  } else fail_(`T8: worktree not placed before --: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T8: buildLaunchCommand worktree threw: " + e); }

// T9: omits --worktree when absent
try {
  const cmd = buildLaunchCommand({
    agent: "conductor", sessionId: "sid-1", cwd: "/repo",
    worktree: undefined, tasksRoot: "/root", passthrough: [],
  });
  if (!cmd.includes("--worktree")) ok("T9: omits --worktree when absent");
  else fail_(`T9: worktree should be absent: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T9: omit worktree threw: " + e); }

// T10: starts with `a launch` and carries agent/session/cwd
try {
  const cmd = buildLaunchCommand({
    agent: "courier", sessionId: "uuid-1", cwd: "/r",
    worktree: undefined, tasksRoot: "/root", passthrough: [],
  });
  if (cmd[0] === "a" && cmd[1] === "launch" &&
      cmd[2] === "--agent" && cmd[3] === "courier" &&
      cmd[4] === "--session-id" && cmd[5] === "uuid-1" &&
      cmd[6] === "--cwd" && cmd[7] === "/r") {
    ok("T10: starts with `a launch --agent --session-id --cwd`");
  } else fail_(`T10: header wrong: ${JSON.stringify(cmd)}`);
} catch (e) { fail_("T10: header threw: " + e); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
