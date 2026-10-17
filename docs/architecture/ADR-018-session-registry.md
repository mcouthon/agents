# Session Registry and Identity by Registration File

> **Status: Accepted** (task 128, phase 2, October 2026). This is the
> registry contract that AGENTS phase 2 implements and PAV phase 1 builds
> against (task 128: "Write ADR-018 (registry contract) at the start of A2
> so P1 can begin against it"). The `registration.json` shape follows
> task 128 §1 ("Identity by registration file"), which is the binding
> source; PAV's task 281 phase 0 explicitly defers to this ADR
> ("schema per AGENTS ADR-018").

**Source:** Task 128 — pav-agents determinism, §1 and §2; binding decisions
D1, D2, D3, D6, D7 (decision log, 2026-10-17).

**Criteria met:** cross-cutting — every session on the machine (PAV-launched,
`a cc`, bare `claude`, headless `a run`) flows through the registry, and four
consumers depend on it: hooks, the `a` CLI, the MCP server, and PAV's
read model; not derivable — the code shows files and env vars but not why
ids travel in one file behind one pointer instead of per-id env keys, why
session state is separate from task state, or why ownership is a lease while
writes take a mkdir lock; new — no existing ADR covers session identity
([ADR-011](ADR-011-machine-readable-state.md) covers task `state.json`,
[ADR-012](ADR-012-worktree-tasks-resolution.md) covers worktrees,
[ADR-017](ADR-017-branch-aware-worktree-launch.md) covered launch-time
worktree decisions and is superseded).

## Decision

Every session on the machine gets **one directory** under a single registry
root, `~/.agents/sessions/<id>/`, holding **one id-carrier file**,
`registration.json`, plus its sidecars (`meta.json`, `attention.json`,
`launch.sh`). Launchers (PAV, `a cc`) mint all ids before launch, write them
into `registration.json`, and put **a single pointer** to that directory in
the pane environment: `AGENTS_SESSION_DIR` (renaming today's
`PAV_TERMINAL_DIR`). No per-id env keys. There is **no launch prompt**
(D2): the agent template says how to behave, task files say what the work
is, and the SessionStart hook says which task — it registers the session,
binds the task, and injects one line naming the bound `task_dir`.

Session state (`live/exited/lost`) is tracked by the registry and is
**separate from task state** (D3): a task is never done because its process
disappeared. Concurrent task **ownership** is a lease keyed by session id;
state-file **writes** are serialised by an exclusive `mkdir` lock holding
session id + pid (D6). PAV's terminal directory points at the registry root
— one location, one format (D7) — and its `terminals` table becomes a read
model rebuilt from it.

## Problem Statement

Before the registry, identity was scattered: per-id env keys
(`PAV_TERMINAL_ID`, `PAV_TERMINAL_DIR`, `PAV_AGENT`) snapped into tmux at
launch and could not be updated after it; a `/clear` or rebind orphaned
the linkage; nested `claude -p` processes inherited id snapshots and could
rebind the parent's task; PAV derived "done" from absence in
`claude agents` output, orphaning live terminals after crashes; and a bare
`claude` outside PAV was invisible to the system entirely. Each consumer
(ADRs, hooks, MCP, PAV) re-derived identity differently.

## Why

- **A file beats env keys** (D1): it can be updated after launch (rebind
  after `/clear`), nested processes inherit a *pointer* (the env var) not a
  *snapshot* (the ids), PAV re-reads it after reboot, and new fields never
  touch tmux plumbing.
- **One root for every session** (D7): a bare `claude` self-registers into
  the same root, so external-session detection reads the registry instead of
  polling `claude agents --json` and matching cwd realpath.
- **Session state ≠ task state** (D3): the "absent from `claude agents` →
  done → archive worktree" path destroyed live work. Process absence means
  `exited`/`lost`, never `done`.
- **Lease vs lock** (D6): ownership is a long-lived, liveness-reclaimable
  lease; the write lock is ms-scale mutual exclusion needing an atomic
  primitive (`mkdir`). Conflating them would either leak ownership after a
  crash or make writes wait on a human timescale.

## Key Architectural Decisions

### `registration.json` schema

Written to `~/.agents/sessions/<id>/registration.json` (§1; field set is
binding):

```json
{
  "schema": 1,
  "origin": "pav",
  "terminal_id": "3f2a1c…",
  "session_id": "8c1d4e…",
  "workflow_id": 412,
  "task_dir": "/Users/me/code/agents/.tasks/128-pav-agents-determinism",
  "commitment_id": "…",
  "project_id": "…",
  "initiator": "intake",
  "agent": "conductor",
  "repo_key": "agents",
  "cwd": "/Users/me/code/agents",
  "pid": 4242,
  "tmux": { "server": "pav", "session": "3f2a1c…" },
  "created_at": "2026-10-17T09:00:00.000Z"
}
```

| Field          | Type            | Filled by   | Semantics |
| -------------- | --------------- | ----------- | --------- |
| `schema`       | int             | writer      | registration schema version (currently `1`); additive fields never bump it |
| `origin`       | enum            | launcher / hook | `pav` (UI launch), `cli` (`a cc`), `external` (self-registered bare `claude`) |
| `terminal_id`  | uuid \| null    | launcher    | PAV terminal id; null for non-PAV sessions |
| `session_id`   | uuid            | launcher, completed by hook | the Claude Code session id (`--session-id`) |
| `workflow_id`  | int \| null     | launcher    | PAV CodingWorkflow; null outside PAV |
| `task_dir`     | absolute path \| null | launcher (via `a task create`) | bound task directory; null when unbound |
| `commitment_id`| id \| null      | launcher    | one Commitment per CodingTask; intake's own adopted by id |
| `project_id`   | id \| null      | launcher    | honoured from intake |
| `initiator`    | string \| null  | launcher    | who asked (e.g. `intake`, `mission`, user); draft-only git-guard keys on it |
| `agent`        | string          | launcher / hook | agent type (conductor, builder, …) |
| `repo_key`     | string          | launcher / hook | repo identity computed by the pure path function (D5) |
| `cwd`          | absolute path   | launcher / hook | session working directory |
| `pid`          | int \| null     | hook        | pid of the session's claude process; basis for liveness and MCP ppid match |
| `parent_session_id` | uuid \| null | hook    | set when this is a nested process (D28): the parent's session id; null for top-level sessions |
| `tmux`         | `{server, session}` \| null | launcher | tmux coordinates; null outside tmux (legible but not persistent) |
| `created_at`   | ISO 8601        | writer      | registration timestamp |

Unknown fields are additive: consumers ignore fields they do not know, so
new fields never require changes to tmux plumbing or launchers (D1). The
registry entry id (`<id>` in the path) is the **terminal id when a launcher
minted one, else the session id** (§2). The `agents-core` register primitive
(`scripts/lib/session.js#L18-L39`) currently writes the id subset
(`session_id`, `pid`, `terminal_id`, `cwd`, `agent`, `repo_key`, `task_dir`,
`initiator`, `created_at`); phase 2 completes it to the full shape above.

### The env pointer: `AGENTS_SESSION_DIR`

The pane environment carries exactly one new variable, `AGENTS_SESSION_DIR`,
whose value is the session directory
`~/.agents/sessions/<id>/` (renaming PAV's `PAV_TERMINAL_DIR`; PAV may keep
exporting its legacy names during transition — PAV source today still sets
`PAV_TERMINAL_DIR`, `backend/app/services/terminal_ops.py:151`). Rules:

- No per-id env keys are exported to tmux; ids are read from the file the
  pointer names (D1).
- Rebinding (`/clear`, re-task) rewrites `registration.json` in place; the
  pointer never changes, so every descendant process sees the update on next
  read.
- The MCP server and hooks resolve identity from the pointer's file, not
  from their own env snapshot.
- `AGENTS_SESSION_ID` (used today as a fast path in MCP temp-file scoping,
  `scripts/state-server.js#L115-L123`) is derived convenience, not a
  contract: launchers must not need to set it.

### One registry root (D7)

`~/.agents/sessions/<id>/` holds every session on the machine — PAV, `a cc`,
bare `claude`, headless `a run`. Contents: `registration.json` (identity),
`meta.json` (session metadata), `attention.json` (attention/transcript
state), `launch.sh` (how the session was started). PAV's terminal-dir
setting points here instead of `~/.pav/terminals`; there is no second
location. PAV treats the directory as the source of truth; its `terminals`
table is a read model rebuilt on boot and by watchdog.

### Write lock and temp file (D6)

State-file writes serialise on an exclusive `mkdir` lock
(`<task_dir>/.lock`, implemented in `scripts/lib/lock.js#L18-L54`):

- The lock directory holds `{session_id, pid}`.
- A stale lock whose holder pid is no longer alive is reclaimed
  (registry liveness: liveness of the holder is decided by whether its
  registered pid is running); waiters back off exponentially (10 ms →
  100 ms) and fail with `LockHeldError` after ~2 s naming the holder.
- The write itself goes to `.state.<session_id>.tmp` in the task directory,
  then an atomic rename — no random temp names, and a crashed writer leaves
  a scoped, identifiable fragment.
- The lock is mutual exclusion only, milliseconds-scale. It grants no
  ownership.

### Task ownership: the lease (D6)

Ownership of a task is a lease in the task's state file:
`lease: {session_id, expires_at}`.

- **Claimed** at registration (SessionStart) when the session binds a task.
- **Renewed** on every UserPromptSubmit (the `lease` hook).
- **Released** on SessionEnd.
- **Reclaimed** when the holder is dead — the holder session is no longer
  live in the registry (its pid is gone). There is **no expiry gate**: both
  refusal (second session at register) and reclaim key on holder liveness
  only, so killing a holder's process frees the task immediately. `expires_at`
  is renewal bookkeeping (refreshed on every UserPromptSubmit), not a
  condition for reclaim.
- A second session registering against a leased task is **refused with the
  holder's id**, so the human sees who holds it rather than a silent steal.

Lease and lock are distinct mechanisms with distinct lifetimes: the lease
outlives individual tool calls (human timescale, liveness-reclaimed); the
lock covers single state writes (machine timescale, timeout-reclaimed).

### Session state lifecycle (D3)

The registry tracks `session_state ∈ {live, exited, lost}`, orthogonal to
task phase status:

| State    | Entered when | Meaning |
| -------- | ------------ | ------- |
| `live`   | registered, pid alive | the agent process is running |
| `exited` | SessionEnd fired, or attention state reports a clean exit | the session ended normally |
| `lost`   | process gone with no SessionEnd (crash, `kill -9`, reboot), beyond a liveness grace (PAV default 120 s) | the session vanished without saying so |

Neither `exited` nor `lost` ever advances task state. `done` derives only
from task truth (task state transitions, recorded SHAs, merged PRs). PAV's
revive-on-`exited|lost` resumes with `claude --resume <session_id>` in the
recorded directory — the registry carries enough to do that (session id,
cwd, tmux coordinates).

### Hook contract

Global hooks call `agents-core` CLI commands; all are no-ops when the
session has no pointer and no binding. A hook skips entirely only when stdin
carries `agent_id` (a subagent spawned by the Agent tool). Nested `claude`
processes are detected by the **pointer**, not by `CLAUDE_CODE_CHILD_SESSION`:
Claude Code sets that variable on every subprocess it spawns (hooks included,
even for a top-level session), so it cannot distinguish a nested session from
a top-level one (D28). With `AGENTS_SESSION_DIR` set, `register` binds
(claims the pointer's registration and lease) iff the pointer's
`session_id` equals the hook's session id, or the pointer's recorded `pid` is
`null`, dead, or equals `$CLAUDE_PID`; otherwise the recorded pid is alive and
foreign — a nested process — and it registers under its own session id with
`origin: "external"` and `parent_session_id` pointing at the parent, never
touching the parent's registration or lease. Without a pointer every session
registers, nested or not. `unregister` and `touch` act only on the caller's
own session id (they resolve to the pointer dir only when it records that id):

| Event             | Command             | Does |
| ----------------- | ------------------- | ---- |
| SessionStart      | `a session register` | fills `session_id`/`pid`, writes `binding` into the task's state file, claims the lease, emits one line of `additionalContext` naming the bound `task_dir`, and POSTs `/api/coding/terminals/{id}/bind` to PAV when reachable — the file stays as the fallback PAV adopts by watchdog |
| UserPromptSubmit  | touch + lease renew  | refreshes session liveness and lease expiry (keeps `live` honest between prompts) |
| SessionEnd        | `a session unregister` | releases the lease, sets `ended_at` on the registration and marks the session `exited`; the directory is kept (retention is PAV's call) |

A **bare `claude` with no pointer** self-registers through the same
SessionStart hook: the hook creates the registry entry keyed by session id
with `pid = $CLAUDE_PID` (falling back to `$PPID` when unset) — the claude
process pid, which lease liveness must track. `$PPID` alone is the
transient hook shell, which exits before the session ends and would make
every lease look "dead"; `CLAUDE_PID` is the long-lived process the lease
keys on. This gives every session — even outside tmux and PAV — a legible
identity in the same root (§2).

### MCP self-identification

The MCP server must know which session it serves without per-session
configuration. It resolves identity in priority order
(`scripts/state-server.js#L110-L123`):

1. `AGENTS_SESSION_ID` in env, **if live in the registry** (fast path);
2. `session.find({ pid: process.ppid })` — the registry entry whose `pid`
   matches the MCP server's parent process (the canonical path: the hook
   registered the parent's pid, so the server finds itself by lineage);
3. a synthetic `pid-<pid>` scope, so temp files never collide even when
   unregistered.

The registry is what makes step 2 possible: identity comes from matching
the parent pid against registrations, not from an env snapshot inherited
through nested processes.

## Consequences

- **Positive:** one identity source for hooks, CLI, MCP, and PAV; rebind and
  `/clear` work without relaunch; nested processes cannot corrupt the
  parent's registration; a crashed session is distinguishable from a
  finished one, so worktrees and terminals are never archived on process
  absence; bare `claude` sessions become legible; new metadata is additive
  with zero plumbing changes.
- **Negative:** two resolution paths exist for MCP identity (env fast path
  and ppid match) and must stay consistent; registry entries for sessions
  that die without SessionEnd linger until liveness reclamation runs; a
  file read on every hook invocation adds an fs cost hooks did not have
  (bounded: one small JSON read); a bare `claude` with no env pointer that
  runs `/clear` cannot locate its previous registration to append to
  `session_history`, so the old entry lingers until pid-death reclaim
  (ownership is unaffected — lease reclaim keys on holder death only).
- **Neutral:** PAV's transition is mechanical — it renames its terminal dir
  to the registry root, exports the new pointer name, and rebuilds its read
  model; until its phase lands, PAV source still uses `PAV_TERMINAL_DIR`
  (`backend/app/services/terminal_ops.py:151`) and writes no
  `registration.json`.

## See Also

- Task 128 §1–§3 (`.tasks/128-pav-agents-determinism/task.md`) — binding
  source for the schema, hook table, and decision log D1/D2/D3/D6/D7.
- [ADR-011](ADR-011-machine-readable-state.md) — machine-readable task
  state; the lease and `binding` live in the state file it defines.
- [ADR-012](ADR-012-worktree-tasks-resolution.md) — worktree-per-workstream
  isolation; worktree sessions register into the same root.
- PAV task 281 (`~/code/pav/.tasks/281-agents-integration-determinism/`) —
  the consumer side: read-model rebuild, bind endpoint, watchdog adoption.

## Updates

| Date         | Task | Summary       |
| ------------ | ---- | ------------- |
| October 2026 | 128  | Initial decision. |
| October 2026 | 128  | Phase-2 review reconciliation: `origin` value `bare` → `external` and `schema` added to the binding field table; lease reclaim keyed to holder death with no expiry gate (matches D6); SessionEnd keeps the registry directory and sets `ended_at`. |
| October 2026 | 128  | Phase-2 defect fixes: hook records `$CLAUDE_PID` (fallback `$PPID`) so lease liveness tracks the claude process, not the transient hook shell; `install.sh install` links `a` to `~/.local/bin/a` (global hooks depend on it); `AGENTS_SESSIONS_ROOT` env override isolates the registry root for tests. |
| October 2026 | 128  | D28: `CLAUDE_CODE_CHILD_SESSION` is not a nested-session signal (Claude Code sets it on every subprocess, hooks included) and is no longer consulted by hooks. Nested detection is pointer-based — a live, foreign `pid` at `AGENTS_SESSION_DIR` means a nested process that registers under its own id with `origin: "external"` and `parent_session_id`, leaving the parent's registration and lease untouched; `unregister`/`touch` act only on the caller's own session id. Added `parent_session_id` to the registration schema (additive). |
