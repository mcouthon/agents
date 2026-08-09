# Agent-Pipeline Measurement Methodology

**Source:** Task 001 (agent-latency-reduction) and Task 105 (latency-ab-experiment), Aug 2026

## Decision

Adopt seven measurement guards, below, as standing methodology for any future
attempt to measure agent-pipeline cost or latency. Each guard exists because
its absence produced a real, paid, wrong number or a wrong verdict during
these two tasks.

## Why

Tasks 001 and 105 both tried to measure agent-pipeline cost/latency
empirically. Both produced defects that would have silently corrupted the
result if undetected — a transcript-only token count off by up to 37.4x, a
parser that undercounted gates only on the arm expected to win, a guard that
returned the same value regardless of the tree it ran against, and a
paid-but-dead MCP server with no surfaced error. None of these were caught by
the harness itself; all were caught by a human or an agent re-deriving the
number by hand. This ADR exists so the next measurement task starts from the
guard, not from the defect.

## Findings

### 1. Token accounting: transcript-only counts undercount by 8.3x-37.4x

**Finding:** `result.modelUsage` (the field on the top-level `claude -p`
result) is the only trustworthy token source for a delegating run. Summing
transcript entries undercounts, because subagent (`Task`-spawned) usage never
appears in the parent transcript — `analyze.py:59-70` recorded a confirmed
8.3x-37.4x undercount from transcript-only counting against the same
delegating session.

**Consequence:** any cost/latency figure computed from transcript entries
alone, on a run that delegates to subagents, is wrong by up to an order of
magnitude and looks plausible enough not to be questioned.

**Guard:** compute
`delegation_capture_ratio = billed_total / primary_actor_usage`. A ratio
> 1.5 is proof that delegation happened and that transcript-only accounting
is invalid for this run; treat it as a hard gate on the accounting method,
not an interesting side-statistic.

### 2. Parser bias is directional, not random

**Finding:** the harness's checkpoint parser matched human-approval gates by
the literal heading `#### 🛑 CHECKPOINT:`. Post-change templates (task 001,
Phase 5) head the implementation-complete gate `#### 📦 Delivered:` instead.
The old parser returned zero matches on that shape, so `impl_complete_gate_count`
undercounted by one specifically on turns using the new heading — which only
post-change arms ever produce.

**Consequence:** the miscount was not random noise, it was a one-directional
bias that landed only on the arm the experiment expected to win, silently
inflating the appearance of fewer gates post-change.

**Guard:** validate any output parser against real, captured turn text from
every arm — especially the arm expected to win, since that is exactly where a
directional bug hides.

### 3. The guard that cannot fail

**Finding:** the characteristic verification defect surfaced repeatedly across
both tasks: a check that returns the same result before and after the change
it claims to verify. Concrete instances found: a regression guard in task 001
whose literal string (`**Try it:**`) the live template had already renamed to
`**Tried it:**`, so the guard read the same value both before and after the
phase it was meant to gate, and could never have failed; and a discipline,
stated explicitly while building task 001's Phase 8 tests, that a guard must
be written against the exact broken string rather than a prefix the corrected
pattern would also match, or it proves nothing about the fix.

**Rule:** every guard must be demonstrated to FAIL on the pre-change tree
before it is trusted to PASS on the post-change tree. A guard that cannot
fail, or that fails on arrival unrelated to the change, is not a guard.

### 4. Silent MCP failure

**Finding:** `--strict-mcp-config` does not fail the `claude` invocation when
a configured MCP server crashes at startup — it only makes that server's
tools unavailable, with no error surfaced in `halted_reason` or `error`.
Task 105's harness passed the shared, unsubstituted `mcp-config.json`
template (containing the literal placeholder `__STATE_SERVER_JS_PATH__`) to
every arm instead of each arm's own substituted file, so `node
__STATE_SERVER_JS_PATH__` crashed on startup on both arm A's and arm B's real,
already-paid invocations. Confirmed against `results/ab-runs.jsonl`: both
runs' recorded `mcp_config_sha256` matched the unsubstituted template's hash,
not any per-arm file.

**Consequence:** two paid runs executed with a dead state-manager MCP server
and no error surfaced anywhere in the run's own output.

**Guard:** assert the MCP child process is alive during each run rather than
inferring health from the absence of an error field, and substitute per-arm
MCP configs from a template rather than pointing every arm at one shared,
unsubstituted file.

### 5. Search-tool traps (`rg` 15.1.0)

**Finding:** building a cross-arm-contamination check surfaced three
independent `rg` behaviors that each produce a false-negative silently:

- `.tasks/` is a hidden directory; `rg` does not descend into hidden
  directories without `--hidden`. The plan's literal command returned zero
  matches on a fixture containing only a planted canary under `.tasks/`.
- Inside a git repository, `rg` still honours the **global** gitignore
  (`core.excludesFile`, typically `~/.gitignore`) even with `--hidden` —
  `--no-ignore-vcs` is required in addition.
- A negated glob with an explicit nested path (`--glob '!.tasks/foo/**'`)
  silently excludes nothing in this installed `rg` version; only a
  slash-free basename pattern or an explicit `**/`-prefixed pattern actually
  excludes. Separately, a basename-only negated glob fails to exclude when
  the current working directory itself shares that basename.

**Consequence:** without these fixes, the contamination check would have
"passed" vacuously — never having searched `.tasks/` at all — while looking
identical to a real pass.

**Guard:** treat any `rg`-based check as unverified until it has been proven,
on a throwaway fixture, to actually find the thing it is supposed to find —
the same "demonstrated to fail before it is trusted to pass" discipline as
finding 3, applied to the search tool itself rather than the code under test.

### 6. Orchestration mechanics: spawn asymmetry and underestimated cost

**Finding, spawn asymmetry:** a subagent's foreground window is shorter than
a headless pipeline run takes to complete. Launching a run and collecting its
result are two separate spawns, not one — expecting a single spawn to do both
orphaned runs and briefly lost a paid result during task 105's execution.

**Finding, cost underestimation:** the harness's own cost model was low three
times in succession: the Phase 4 estimate (`$1.22-$1.87` best case, `$1.32-
$2.02` with one rework loop) was superseded by arm B's real two-turn cost of
$2.9705; the cap was then raised to accommodate that figure with headroom
(`PER_RUN_CAP` $2.40 -> $3.50), and arm B's re-run still exceeded the raised
cap at $4.3160411.

**Guard:** treat one spawn as launch-only and budget a second spawn to
collect the result. Set budget caps with large headroom above the best
current cost estimate — this experiment's caps were revised upward twice and
still needed a third revision.

### 7. The empirical finding that justified the work

Pre-change, Conductor's task-discovery glob `.tasks/*` matched files, not
directories, and returned zero task directories — Conductor could not
discover any task and never entered its own pipeline, reporting no tasks
existed while planted tasks sat in front of it. Corrected to
`.tasks/*/task.md`, which returns all task directories (verified live: 21).

A commit message in the history (`39c9ff5`) misdescribes this root cause as
"Entry Gate pattern was matching gitignored `.tasks/` directory" — the actual
defect was file-vs-directory glob semantics, not gitignore. Readers of `git
log` for this fix should not take the commit message's stated cause at face
value.

## Limitation

This ADR records methodology and discovery findings, not a verified
pre/post latency verdict. Task 105's A/B experiment has exactly one complete,
graded arm: **A′** (a hand-built synthetic pre-change tree isolating the glob
fix alone), cost **$2.1389321**, all four grading criteria PASS. Arm B was
still in flight — halted twice on budget before reaching grading — when this
ADR was written; arm C was not run. The original "~50% latency reduction"
claim from task 001 remains **unverified**. The early partial signal that
does exist (arm B's real per-run cost growing from an estimated $1.22-$2.02
to a measured $2.9705 to $4.3160411 across two attempts) points against that
claim, not toward it, but is not itself a controlled comparison and should
not be read as one.

## What Does NOT Change

| Area | Reason |
| ---- | ------ |
| ADR-001's own amendments on task 001's falsified premises (leniency, Phase 7 duplication, severity-as-confidence-band). Recommendation 6 was deferred, not falsified: its own measurement — 8.0% of invocations / 11.0% of diff reviews (`.tasks/001-agent-latency-reduction/task.md`, Approved Scope) — is a different population from Phase 8's 6.9% (16/231) no-shell-substitutable share (same task.md, Phase 8 material); the two are not the same measurement, so no threshold test between them is valid and Rec 6's premise remains untested | Recorded there; this ADR does not restate them |
| Task 105's in-flight harness code and configs | Out of scope — this ADR documents findings already surfaced, not the ongoing experiment |
| The task-discovery glob fix itself (`.tasks/*/task.md`) | Already shipped and recorded in ADR-001's Phase 8 amendment; finding 7 here adds only the commit-message caveat |

## Related

- [ADR-001: Orchestration & Subagent Architecture](ADR-001-orchestration-and-subagents.md) — task 001's falsified premises (leniency, duplication, severity taxonomy) and Recommendation 6's deferral, which remains untested rather than falsified (see ADR-001's own amendment); this ADR does not duplicate those
- `.tasks/001-agent-latency-reduction/` — source task for findings 3 (partial), 6 (spawn asymmetry), 7
- `.tasks/105-latency-ab-experiment/` — source task for findings 1, 2, 3 (partial), 4, 5, 6 (cost), and the Limitation section
