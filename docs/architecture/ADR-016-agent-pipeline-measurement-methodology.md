# Agent-Pipeline Measurement Methodology

**Source:** Task 001 (agent-latency-reduction) and Task 105 (latency-ab-experiment), Aug
2026. Amended Aug 2026 by Task 108 (graphify-usage-telemetry), an observational (zero-spend,
no new runs) telemetry study rather than a benchmark — findings 8–10 below.

## Decision

Adopt ten measurement guards, below, as standing methodology for any future
attempt to measure agent-pipeline cost, latency, or tool utilization. Each guard exists
because its absence produced a real, paid, wrong number or a wrong verdict during
these tasks.

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

### 8. Utilization of a navigation tool is additive, not substitutive

**Finding:** Task 108's census predicate ("transcripts with ≥1 `mcp__graphifyy__*`
`tool_use`") and a substitution predicate ("did the tool displace `Read`/`Grep`") measure
different things, and only the second is a real adoption signal. A transcript with one
Graphify orientation call followed by twenty `Read` calls registers as "used" under a call
census and as "barely used" under substitution — while the tool did exactly the job it was
called for (Finding R6). Conversely a zero-call transcript can be correct non-use (no index
present, or the agent was already handed explicit file paths) rather than a utilization
failure (Finding R2) — the same category error a small-N census must guard against on the
opposite side.

**Consequence:** a raw call count, or a "calls per session" average, simultaneously
overstates tools used for one cheap orientation call and understates tools that fully
replaced a multi-turn `Read`/`Grep` loop they made unnecessary. "Replaces `Grep`" is not a
valid success metric for an additive tool, and per-session call counts alone understate real
use.

**Guard:** report utilization availability-gated (was the tool reachable, was an index
present) and paired with an explicit substitution signal (did `Read`/`Grep` calls in the
same transcript happen for information the tool's own answer did not already contain) —
never a bare call count alone. A pre-registered "substitution" secondary metric should be
treated as load-bearing, not secondary: Task 108's own utilization-only number would have
reported a win that substitution showed was not there.

### 9. An honest-N floor must be a code-level refusal, not a written reminder

**Finding:** Task 108 built `telemetry/gate.py` as a mechanical, threshold-driven refusal —
not prose asking the report-writer to be careful — that blocks any average, rate, or
percentage computed below a floor (`FORBID_AGGREGATE_BELOW_N = 3`), while still permitting
per-session raw rows at any N. Used across Phases 1, 3, and 7, this is what let a
three-session Copilot cohort be reported as three raw token/TTFT rows instead of a
spuriously precise mean, and forced a `code/agents` utilization pair to `utilization_ratio:
null` (not a computed ratio) at N=5 once one of the two utilizing sessions was
independently flagged as reflexive (a study session about the study itself) — a refusal the
generic small-N tier alone would not have produced.

**Guard:** for any task producing an aggregate statistic, implement the floor as a function
that raises or refuses computation, not as an instruction telling the writer to be careful
with small N — the same class of fix ADR-007's Rationalization Prevention tables apply to
reasoning, applied here to arithmetic.

### 10. A magnitude or pairing claim must be re-derived against real data before it enters a report, never inherited from a prior finding's prose

**Finding:** three separate claims in Task 108 were stated in one phase's prose and failed
re-derivation when a later phase re-ran the literal predicate that had produced them: (1) a
"~20× undercount" between two Copilot log sources, based on comparing raw un-deduped line
counts across two structurally incomparable formats, collapsed to 0.86×–1.17× once both
sides were parsed structurally and deduped by `toolCallId` — retracted, not softened
(Findings C1–C2). (2) A "Grep calls went from 4 to 2" pre/post pairing was real on both
sides, but the "4" traced to a smoke-test subagent transcript that predated the guidance
install and was neither of the two exemplar transcripts its own source finding had named —
the comparison also mixed a subagent-shaped pre-side against a main-session-shaped post-side
(Finding R13). (3) A plan's claim that legacy `.json` session files carry no `toolId` key
was falsified during implementation — the `rg` check behind the original claim assumed
compact JSON and missed the pretty-printed form actually on disk; the correction happened
to leave the headline number unchanged (0 of 1,213 legacy files carry a *graphify*
`toolId`) only because a second, independent check confirmed the conclusion anyway.

**Consequence:** none of these three would have been caught by re-reading the prose more
carefully — each required literally re-running the counting or comparison logic against the
real files. A magnitude gap, a before/after pairing, or an absence claim cited from a prior
phase's write-up is an unverified number until re-derived, not a fact inherited for free.

**Guard:** before a magnitude claim (an "N×" gap, a before/after pairing, or a "never
occurs" claim) is written into a report or a downstream plan, re-run the exact predicate
that produced it against real, current files — never the prior phase's stated conclusion.
This extends finding 3's "a guard must be demonstrated to fail before it is trusted to
pass" discipline from harness code to reported numbers.

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
- [ADR-007: Rationalization Prevention Tables](ADR-007-rationalization-prevention.md) — the reasoning-side pattern (a table that forces a required action) that finding 9's code-level honest-N gate applies to arithmetic instead of prose
- [ADR-011: Machine-Readable State](ADR-011-machine-readable-state.md) — Task 108's companion amendment there covers the guidance-content and `project_dir`-validation decisions from the same task; this ADR covers only its measurement-methodology findings (8–10)
- `.tasks/001-agent-latency-reduction/` — source task for findings 3 (partial), 6 (spawn asymmetry), 7
- `.tasks/105-latency-ab-experiment/` — source task for findings 1, 2, 3 (partial), 4, 5, 6 (cost), and the Limitation section
- `.tasks/108-graphify-usage-telemetry/` — source task for findings 8–10; an observational study (Overview: "not a benchmark") that reused this ADR's honest-N framing rather than introducing a new one
