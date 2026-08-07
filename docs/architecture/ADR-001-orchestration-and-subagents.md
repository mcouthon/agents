# Orchestration & Subagent Architecture

**Source:** Task 006 (February 2026)

## Decision

Introduce a conductor pattern with restricted subagent invocation to enable automated multi-phase task execution while maintaining user control.

## Why

- Manual orchestration of 3-phase tasks required 12+ separate sessions
- Subagent context isolation prevents context bloat from parallel research
- Scope enforcement via `agents` frontmatter prevents unintended agent invocations
- Structured pause points (`askQuestions` / CC: `AskUserQuestion`) give users control without manual intervention

## Problem Statement

The existing workflow required users to manually invoke agents for each step:

1. Explorer → creates task + phases
2. Explorer → creates phase plan (per phase)
3. Phase-review skill → review plan (per phase)
4. Builder → implement (per phase)
5. Reviewer → verify (per phase)
6. Committer → commit (per phase)

This was tedious and error-prone, with no automated progression.

## Solution

### Before

```
User ──(manual)──> Explorer ──(manual)──> Builder ──(manual)──> Reviewer ──(manual)──> Committer
                      │
                      └── (no subagent support)
```

### After

```
Conductor
    │
    ├── Explorer (subagent) ──> Researcher (subagent)
    │       └── agents: ["Explorer", "Researcher"]
    │
    ├── Builder (subagent)
    │
    ├── Reviewer (subagent)
    │
    └── Committer (subagent) ──> Researcher (subagent)
            └── agents: ["Researcher"]
```

## Implementation Phases

| Phase                     | What Changed                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| 1. Agent Locations        | Migrated to `~/.copilot/agents`, added `chat.agentFilesLocations`     |
| 2. Settings & Frontmatter | Added `agents` restrictions, `model` fallbacks to all agents          |
| 3. Skill YAML Fix         | Converted folded blocks to inline strings for VS Code parser          |
| 4. Researcher Subagent    | Created Researcher (read-only) agent                                  |
| 5. Subagent Invocation    | Added `agents` restrictions to Explorer, Builder, Reviewer, Committer |
| 6. Conductor Agent        | Created conductor with mandatory pause points                         |
| 8. Documentation          | RDR-031, prevailing-wisdom.md updates                                 |

## Key Architectural Patterns

### 1. Conductor Agent Pattern

The Conductor agent delegates all work to specialized subagents:

```yaml
# conductor.agent.md frontmatter
agents: ["Explorer", "Builder", "Reviewer", "Committer"]
disable-model-invocation: true # Must be explicitly invoked
```

### 2. Researcher Subagent Pattern

Internal agents hidden from users with `user-invokable: false`:

```yaml
# researcher.agent.md frontmatter
name: Researcher
user-invokable: false
tools: ["read/readFile", "search", "web", "todo"]
model: ["Claude Sonnet 4.5 (copilot)"]
```

### 3. Scope Enforcement via `agents` Restriction

Each agent declares which subagents it can invoke:

```yaml
# explorer.agent.md
agents: ["Explorer", "Researcher"]  # Can self-recurse and use Researcher

# builder.agent.md
agents: ["Builder", "Researcher"]  # Can use skill-powered subagents
```

### 4. Mandatory Pause Points

Orchestrate uses `askQuestions` (CC: `AskUserQuestion`) tool for structured user decisions:

```markdown
| Pause Point       | Trigger                  | User Action                |
| ----------------- | ------------------------- | --------------------------- |
| Phase Plan Ready  | After plan + review      | Approve plan, adopt fixes  |
| Phase Implemented | After Builder + Reviewer | [Commit] / [Abort] (on ISSUES: [Fix Issues] / [Commit Anyway] / [Abort]) |
```

The `Task Created` pause point shown in earlier revisions of this table is
gone (the template moved straight from Step 1b to Step 2 without pausing —
see `## Updates` below). The Phase Implemented checkpoint offers two options (three when Reviewer returned ISSUES — see the Phase 4 amendment below)
(the `[Verify]` option shown in earlier revisions is also gone — see the
2026-08-07 amendment below, its runbook now appears unprompted inside the
delivery report):

- **[Commit]** — Approve and proceed to commit
- **[Abort]** — Stop the flow
- **On ISSUES:** **[Fix Issues]** — re-invoke Builder with the issue list (max 2 attempts per phase)
- **On ISSUES:** **[Commit Anyway]** — accept the phase despite the issues; never implied, only explicit

### 5. Agent Capabilities Table (Task 011)

Explicit capability mapping prevents wrong agent selection:

```markdown
| Agent     | Access Level | Capabilities                         |
| --------- | ------------ | ------------------------------------ |
| Explorer  | Read-only    | Search, read files, create plans     |
| Builder   | Full         | File edits, terminal, run tests      |
| Reviewer  | Verify       | Read, terminal for checks, run tests |
| Committer | Git only     | Stage, commit, no other changes      |
```

Selection guidance: "Need terminal? → Builder/Reviewer, NOT Explorer"

### 6. Verification Layer (Task 029)

Structured verification across the agent pipeline ensures quality gates before commit:

| Agent     | Verification Responsibility                                                              |
| --------- | ---------------------------------------------------------------------------------------- |
| Explorer  | Phase plans require `## Verification` (1-3 critical flow checks) and `## Tests` sections |
| Builder   | Automated checks with evidence (actual terminal output, not summaries); also performs the first-pass manual exercise of the change and pastes real observed output (as of 2026-08-07 — see amendment below) |
| Reviewer  | Audits Builder's manual-exercise evidence — accepts credible evidence, re-runs only what's missing, implausible, or contradicted by the diff — instead of performing first-pass functional verification (as of 2026-08-07 — see amendment below) |
| Conductor | Surfaces the manual runbook inside the Phase Implemented delivery report (single confirmation; the former separate `[Verify]` checkpoint option is gone as of 2026-08-07) |

Implement handles automated verification (tests, types, lint) plus the first-pass manual exercise of the change, and must paste terminal output as evidence for both. Review audits that evidence — automated results and manual-exercise output alike — re-running only what is missing or implausible, rather than duplicating first-pass execution. This separation prevents both agents from skipping verification while keeping the write-capable agent as the one that first discovers and fixes problems.

### 7. ADR Consolidation Ordering (Task 029)

Task consolidation (ADR creation) moved from post-commit step 2g to pre-commit step 2e.5. This ensures ADR files are committed together with code and documentation in a single commit pass, eliminating orphaned uncommitted files. Consolidation uses Builder (write-capable) instead of Explorer (read-only outside `.tasks/`).

As of 2026-08-07 (Task 104), the same 2e.5 step produces a second, independently-skippable
output alongside the ADR verdict: a process-learnings instruction delta derived from
execution friction recorded during the build. See amendment below.

## Current Structure

```
generated/copilot/agents/
├── conductor.agent.md    # Conductor - coordinates workflow
├── explorer.agent.md     # READ-ONLY research and planning
├── builder.agent.md      # Code implementation
├── reviewer.agent.md     # Code review and verification
├── committer.agent.md    # Git commit generation
└── researcher.agent.md   # Internal: context-isolated research (user-invokable: false)
```

## Evolution Insights

Key learnings from iterative refinements (Tasks 007-011):

### Checkpoint Enforcement

Initial PAUSE markers were buried as notes at the end of action sequences. The agent
read ahead and treated them as descriptive text, not blocking instructions.

**Solution:** Visual `### 🛑 CHECKPOINT` headers as distinct workflow steps. Checkpoints
fire **unconditionally**—even if user says "plan only" or "skip implementation",
the checkpoint still presents options.

### LLM Instruction Patterns

Discovered that LLMs follow instructions more reliably when:

| Pattern                     | Example                                 |
| --------------------------- | --------------------------------------- |
| Commands before actions     | STOP block precedes action steps        |
| Visual markers stand out    | Emoji headers, horizontal rules         |
| Consequences are explicit   | "Violating this defeats the purpose..." |
| Structure enforces behavior | Separate sections that can't be skipped |

### Mode Simplification

Ambiguous examples ("plan all phases", "just create", "review only") caused
inconsistent behavior. Replaced with two explicit modes:

- **Full Execution:** Plan → Implement → Commit per phase
- **Plan Only:** Create task.md with phases, stop after planning

Mode is set once per task and recorded in frontmatter.

### First Action Protocol

Agent skipped task creation when given direct questions. Added explicit decision tree:

1. Check `.tasks/` for existing task matching context
2. If found → Resume existing task
3. If not found → Create new task (Step 1)

This ensures state persistence across sessions.

### Drift Prevention (Task 013)

The agent consistently "drifted" — losing track of execution position after clarifying questions,
detours, or subagent results. Root cause: advisory tracking sections weren't enforced.

**Solutions implemented:**

| Mechanism             | Implementation                                                         |
| --------------------- | ---------------------------------------------------------------------- |
| Tool restriction      | Removed `search` tool — prevents self-research tangents                |
| Conductor constraints | Explicit prohibitions: "NEVER research", "NEVER edit files directly"   |
| Position Lock         | Exactly ONE `[in-progress]` todo item = current instruction            |
| Embedded reminders    | `> Before invoking: Verify this matches your [in-progress] todo item.` |
| Detour recovery       | Protocol to return to workflow after handling interruptions            |

### First Action Protocol Enforcement (Task 014)

The agent skipped the First Action Protocol (checking `.tasks/` before any work) when requests
felt urgent. Root cause: the FAP section was buried at line 51, after the agent had already
formed an execution plan from the user's message.

**Solutions implemented:**

| Mechanism                 | Implementation                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Entry Gate at primacy     | New section immediately after frontmatter — first thing LLM sees                         |
| Tool-coupled first action | "Your FIRST tool call MUST be `list_dir` on `.tasks/`" — forces mechanical compliance    |
| Anti-bypass language      | "Even to: urgent bugs, production issues, 'quick' questions" — addresses rationalization |

**Entry Gate pattern:**

```markdown
## ⚠️ Entry Gate

**BEFORE responding to ANY user message:**

1. Read `.tasks/` directory
2. Resolve task state (existing task or new)
3. ONLY THEN proceed with workflow
```

This applies the Checkpoint Enforcement insight (visual markers, commands before actions) to
the entry point of the workflow. Tool-coupling mirrors how checkpoints force `askQuestions` (CC: `AskUserQuestion`)
calls — now extended to the very first action.

**Position Lock format:**

```
→ 2a.1. Phase 1: Create Plan    [in-progress]  ← CURRENT INSTRUCTION
  2a.2. Phase 1: Review Plan    [not-started]
```

Before ANY action, agent must verify the in-progress item matches the intended action.
This transforms the todo list from advisory to enforcement mechanism.

## Frontmatter Reference (VS Code 1.109+)

| Attribute                  | Purpose                                  | Example                                    |
| -------------------------- | ---------------------------------------- | ------------------------------------------ |
| `agents: [...]`            | Restricts which subagents can be invoked | `["Explorer", "Researcher"]`               |
| `user-invokable: false`    | Hides agent from UI (internal only)      | For internal subagents                     |
| `disable-model-invocation` | Prevents auto-invocation by model        | For explicit-only agents                   |
| `model: [...]`             | Fallback models if first unavailable     | `["Claude Opus 4.5", "Claude Sonnet 4.5"]` |

## Updates

| Date          | Task | Summary                                                                                                                                                             |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| February 2026 | 007  | Added 🛑 CHECKPOINT headers, strengthened enforcement; pause compliance fixed                                                                                       |
| February 2026 | 008  | Validated patterns against Atlas/Orchestra; confirmed context conservation approach                                                                                 |
| February 2026 | 009  | Made checkpoints unconditional; review returns findings (doesn't modify plans)                                                                                      |
| February 2026 | 010  | Simplified to two modes; 544→450 lines; made task state mandatory                                                                                                   |
| February 2026 | 011  | Added Agent Capabilities table, First Action protocol, removed handoffs; 473→471 lines                                                                              |
| February 2026 | 013  | Drift prevention: Position Lock, removed `search` tool, detour recovery; 479→420 lines                                                                              |
| February 2026 | 014  | FAP enforcement: Entry Gate at primacy position, tool-coupled first action, anti-bypass language; 427→438 lines                                                     |
| February 2026 | 029  | Verification layer: [Verify] checkpoint, evidence-based Implement output, functional Review step, ADR consolidation before commit (2e.5), testing skill integration |
| July 2026     | 089  | Orchestration now consumes machine-readable `state.json`: `parallel_group` state-driven fan-out, `execution` model routing, flag-on-resume (ADR-011)                |
| July 2026     | 091  | Structured verification report: Builder emits auditable evidence; Reviewer audits rather than re-runs automated checks (see amendment below)                        |
| August 2026   | agent-latency-reduction (Phase 5) | Satellite questions fold into the two mandatory pause points; delivery report reduced to user impact + manual try-it, automated checks still run but no longer reported; `[Verify]` removed. **Amends the ADR-009 "checkpoints are unconditional" decision** — the single exception is an explicit, recorded, opt-in Fast Path mode, never inferred (see amendment below) |
| August 2026   | agent-latency-reduction (Phase 1) | Plan review capped at one pass per phase plan, then accept or escalate to the human with a mechanically-computed verdict; Plan Only mode plans one phase per request, not the backlog. A `BLOCKING` plan-review verdict pauses even under Fast Path (see amendment below) |
| August 2026   | agent-latency-reduction (Phase 4) | Reviewer tags every finding 🔴/🟡 against objective criteria (severity decoupled from confidence); the *fix's* re-review is auto-skipped when pass 1 raised no 🔴, overridable up by "review this properly"; the 2c.1 fix gate folds into the Phase Implemented checkpoint (cap and `error` escalation intact) — the skip is measured, the fold is a human preference for fewer gates (see amendment below) |
| August 2026   | 104 (Phase 1) | Builder now performs the first-pass manual exercise of a change and pastes real output; Reviewer audits that evidence instead of performing first-pass functional verification (see amendment below) |
| August 2026   | 104 (Phase 2) | The 2e.5 consolidation step gains a second, independently-skippable output: a cited, confirmation-gated process-learnings instruction delta derived from execution friction recorded during the build (see amendment below) |
| August 2026   | agent-latency-reduction (Phase 8) | Conductor's task-discovery pattern fixed to be directory-aware; Reviewer reframed as the system's read-only shell with a `Recon (not a review):` mode carrying a reduced, ceremony-free protocol; Conductor's Detour Recovery routes free-form questions instead of defaulting to an unlabelled review spawn (see amendment below) |

## Amendment: Structured Verification Report (Jul 2026)

**Source:** Task 091 (July 2026)

### Problem

The Verification Layer (section 6) established that Builder runs automated checks and Reviewer handles functional verification. However, Builder's delivery report only carried pass/fail status — no commands, no output. This made the evidence opaque to Reviewer, which had no choice but to re-run the same tests, types, and lint commands to satisfy its own anti-rationalization rule ("Run the checks yourself and show evidence").

Net effect: every phase cycle ran automated verification twice, wasting tokens and time with no quality benefit.

Root cause: the anti-rationalization entry "I trust the Builder ran verification" was calibrated correctly when Builder's output was opaque, but became a liability once Builder could emit auditable evidence.

### Decision

Builder's delivery report gets a structured `## Verification Report` section containing:

1. Exact commands run
2. Abbreviated output proving pass/fail (key lines, not full dumps)
3. Pass/fail status per check (tests, types, lint)

Reviewer audits this report in place of re-running automated checks. Reviewer's unique value — plan adherence, code quality inspection, edge case analysis, functional verification — is unaffected.

The Conductor prompt is updated to pass Builder's verification report to Reviewer and to reframe Reviewer's directive from "tests pass, no regressions" to "audit Builder's verification report."

### What Does NOT Change

| Area | Reason |
| ---- | ------ |
| Reviewer functional verification (Steps 313-341) | Unique to Reviewer; Builder explicitly skips manual verification steps |
| Reviewer code quality / plan adherence / edge cases | Independent value; Builder cannot objectively self-review |
| Fix loop (Conductor re-invokes Builder then Reviewer on ISSUES) | Unaffected — if Builder reports FAIL, the fix loop triggers before Reviewer is called |
| Phase-review skill | Out of scope |
| Committer agent | Out of scope |

### Design Principle Reinforced

Evidence changes what "trust" means. The Reviewer anti-rationalization rule was correct for opaque pass/fail claims. With commands and output in the report, auditing replaces re-running — same epistemic standard, lower cost. When an agent's output format changes to include machine-verifiable evidence, downstream agents should be updated to consume that evidence rather than regenerate it.

## Amendment: Reduced Comms, Folded Satellites, Opt-In Fast Path (Aug 2026)

**Source:** `.tasks/001-agent-latency-reduction` Phase 5

**Problem:** 36.6% of Conductor's own output was re-summarizing subagent reports the
human could have read directly, and a 3-phase task produced ~20 approval gates from
6 phase transitions — most of them satellite questions (open clarifications, resume
flags, a second `[Verify]` confirmation), not the two mandatory pause points.

**Decision:**

1. The delivery report is reduced to two things, both quoted verbatim from Builder's
   own report: what changed (user impact) and how to try it by hand. Automated checks
   still run in full; passing checks are no longer presented as evidence to the human,
   and a failing check still blocks delivery with the error quoted.
2. Satellite questions (Step 2a.3's open clarifications, the Resume Flow's flag check
   and continue prompt) fold into the nearest mandatory pause point's single call
   instead of taking their own round trip. The `[Verify]` second confirmation is
   removed — its runbook now appears unprompted inside the Phase Implemented report.
3. **This explicitly amends the ADR-009 "checkpoints are unconditional" decision**
   (`## Updates` row, February 2026, task 009): the two mandatory pause points (Phase
   Plan Ready, Phase Implemented) remain unconditional and per-phase, never merged
   with each other or across phases — with one disclosed exception. **Fast Path
   mode** collapses per-phase pauses at task scope, but only when the human
   explicitly requests it ("just do it", "auto-pilot"); it is recorded in task.md
   frontmatter, revocable, and never inferred from anything less than an explicit
   request. Nothing in the pipeline itself is skipped under Fast Path — only the
   pauses between phases. One pause survives: a `BLOCKING` plan-review verdict
   **stops for the human even under Fast Path** (amended by Phase 1, below).

**What does NOT change:** the two mandatory pause points still exist and are still
unconditional by default; Builder still runs every automated check in the plan;
Reviewer's `ISSUES` verdict still surfaces verbatim to the human.

## Amendment: Bounded Plan Review, One Phase at a Time (Aug 2026)

**Source:** `.tasks/001-agent-latency-reduction` Phase 1

**Problem:** a 4-pass review→revise→finalize→re-review cascade on one phase's plan cost
23.7 min / 114,707 output tokens before a line of code, superseded minutes later by a
human directive to remove what had just been built. Separately, planning a whole backlog
ahead of the build decision cost 12 subagents / 50.4 min / 218,850 output tokens and
shipped zero code.

**Decision:**

1. Plan review is capped at exactly one pass per phase plan. The reviewing skill tags
   every finding High/Medium/Low against objective criteria and computes the verdict
   from the tags (one or more High → `BLOCKING`, always) — the verdict is not left to
   the reviewing agent's discretion.
2. On `APPROVED` or `APPROVED WITH SUGGESTIONS`, the phase is marked reviewed. On
   `BLOCKING`, Conductor does not spawn another review — it escalates to the human at
   the plan checkpoint with the verdict quoted verbatim, who decides.
3. A revision made after adopting suggestions is never re-reviewed by an agent; the
   human is the second reader at the checkpoint.
4. Plan Only mode plans one phase per request, then stops and reports, instead of
   rolling on into the next phase's plan.
5. A `BLOCKING` verdict pauses for the human even under Fast Path mode — Fast Path
   collapses routine per-phase pauses, not an unresolved blocker.

**What does NOT change:** the two mandatory pause points (Phase Plan Ready, Phase
Implemented); the 2c.1 Reviewer gate on the built artifact (**narrowed by Phase 4, below** — the *fix's* re-review is skipped when pass 1 raised no 🔴, and the max-2 fix loop's own gate folds into the Phase Implemented checkpoint, cap and `error` escalation intact; the first-pass gate itself is untouched); the
single plan-revision spawn itself; opt-in cross-phase analyze mode; Fast Path's
opt-in-only, never-inferred trigger. No leniency claim is made — both measured wastes
above hold independent of model quality.

## Amendment: Builder Performs First-Pass Functional Verification (Aug 2026)

**Source:** Task 104, Phase 1

### Problem

The Verification Layer (section 6) split automated verification (Builder) from
functional verification (Reviewer), but `builder.template.md:308-310` went further and
explicitly forbade Builder from executing manual verification steps at all: "Do NOT
execute manual steps — functional validation is Reviewer's job." This left the one
agent capable of *fixing* a problem forbidden from *finding* it — an untried change
could reach Reviewer, and the human, without ever having been run.

### Decision

Builder now exercises the change by hand — a real command, endpoint call, or script
invocation appropriate to the change type — before reporting completion, and pastes the
real observed output. Findings are fixed with red/green TDD (an existing capability,
now explicitly routed to catch manual-exercise findings, not just reported bugs) and
the change is re-exercised. The evidence lands in the phase plan's existing
`## Verification Evidence` sink, alongside the automated Verification Report the Jul
2026 amendment already established.

Reviewer's functional-verification role becomes an audit of that evidence, mirroring
the audit-don't-re-run posture the Jul 2026 amendment already established for automated
checks: a credible pasted command + output is accepted; missing, implausible, or
diff-contradicted evidence triggers a targeted re-run. Steps Builder could not execute
(visual judgement, external credentials, a physical device) still surface as the manual
runbook for the human's single confirmation — that part of Reviewer's role is
unchanged.

Conductor's delivery report gains a third field, `Tried it:` (Builder's real command +
output, quoted verbatim), alongside `What changed:` and `What's left for you:` (the
residual manual gap, stated explicitly rather than left implicit). This is a bounded,
user-approved partial reopening of the Aug 2026 "Reduced Comms" amendment's two-field
collapse: it does not reinstate the removed automated Verification Report table, and it
earns its place because it supplies the audit-grade evidence that table used to carry,
at a fraction of its length.

### What Does NOT Change

| Area | Reason |
| ---- | ------ |
| Reviewer's code-quality, plan-adherence, and edge-case review | Independent value; Builder cannot objectively self-review |
| Reviewer's read/test-only write lockdown (ADR-015) | Reviewer still cannot fix what it finds — findings go back to Builder as issues |
| The Jul 2026 audit-don't-re-run posture for automated checks | Unaffected; this amendment is its functional-verification counterpart |
| The Aug 2026 two-field delivery report collapse | Not reversed — `Tried it:` is a narrowly-scoped third field, not a return of the removed table |

## Amendment: Execution Friction → Instruction Delta (Aug 2026)

**Source:** Task 104, Phase 2

### Problem

The architectural-memory loop (`consolidate-task` → `docs/architecture/ADR-NNN-*.md`,
wired at the 2e.5 step per section 7 above) records what the code decided. Nothing
recorded what went wrong *while building it* — an ambiguous instruction that cost a
retry, a plan that was wrong about the code, a check that would have caught a problem
earlier. Explorer's Repository Patterns step (Step 5.5) captures codebase patterns
discovered during research, but never sees build-time friction, and a retrospective
reconstructed from memory at the end of a task is the same fabrication failure mode the
Phase 1 amendment above exists to eliminate.

### Decision

Extend the existing 2e.5 hook rather than add a new skill or Conductor step — it
already fires on the final phase and already reads the finished task record. Two
halves:

1. **Capture.** Builder records friction in the phase plan under `## Execution Notes`
   as it happens — one line each, only when something cost real work a better
   instruction would have prevented. A clean phase writes nothing; this is a floor, not
   a target, and padding a trivial note to look thorough is the same failure in
   reverse.
2. **Convert.** `consolidate-task`, invoked at 2e.5 alongside the ADR decision, reads
   every `## Execution Notes` section across the task's phase plans and proposes up to
   3 cited, generalizable, actionable instruction-delta edits — never applied without
   confirmation. Proposals route by the **scope** of the learning, not a fixed path: a
   repo convention goes to `AGENTS.md`'s new `## Learned Patterns` table (the same sink
   Explorer's Step 5.5 uses); domain terminology goes to `CONTEXT.md`; a gap in an
   agent or skill's behavior goes to the instruction file that owns it (in this repo,
   `templates/*.template.md` — the skill runs `make && ./install.sh` itself on
   confirmation, never editing `generated/` directly); a gap in the framework's own
   posture is proposed for `docs/research/BACKLOG.md` only, since that is outside the
   skill's write scope. Under Fast Path mode, proposals defer unapplied to the final
   Delivery Report instead of blocking at 2e.5. "No process learnings" is a normal,
   expected outcome — if no `## Execution Notes` exist anywhere, the skill says so and
   stops rather than reconstructing a retrospective.

This is the fourth loop in the task.md research table's loop inventory (external
learning, architectural memory, research-time codebase patterns, and now execution
friction) and the first to close the gap between what happened during a build and what
future agents inherit from it.

### What Does NOT Change

| Area | Reason |
| ---- | ------ |
| The ADR output and its Skip/Update/Create decision tree | Independent of the second output; both are produced from the same 2e.5 pass but evaluated separately |
| `## Execution Notes` capture surface (Builder only) | Not extended to Reviewer or Explorer in this task — a deliberate scope boundary, a separate future decision |
| Confirmation-gating before any write | Fast Path only defers the confirmation to the final Delivery Report; it never skips it |
| `docs/research/BACKLOG.md` write access | Remains propose-only for this skill regardless of mode |

## Amendment: Criterion-Based Severity, Skipped Re-Review, Folded Fix Gate (Aug 2026)

**Source:** `.tasks/001-agent-latency-reduction` Phase 4

### Problem

13 re-review runs were surveyed, 11 clean; both exceptions caught the fix introducing a
new defect, and both followed a 🔴 in executable code. A rule that skips the re-review
after a 🟡-only pass 1 would pay for itself — but only if pass 1's 🔴/🟡 labels are
trustworthy. They were not: Reviewer's severity table defined 🔴 as a confidence band of
90% or higher, so a high-certainty doc nit was mechanically 🔴, and one observed label
was not even internally consistent with that table (90% confidence logged as 🟡). A
skip rule built on an unreliable input inherits the unreliability.

### Decision

1. **Severity is decoupled from confidence.** Reviewer's `### Severity and Confidence`
   now defines 🔴 **Critical** by six objective criteria (guard-surface change, an
   existing control bypassed or weakened, an unmet success criterion or failing check,
   behaviour outside the phase's scoped files, a widened permission/grant/hook/`agents:`
   scope, irreversible data loss with no guard) plus an explicit **Never-🔴** list
   (doc/CHANGELOG drift, comment/naming drift, lint/style, line-count overage,
   `.tasks/` markdown, additive config). Confidence keeps one job — a ≥70% noise
   filter — and is stated not to substitute for a severity. An untagged issue counts as
   🔴 (fail-safe on malformed output).
2. **The fix's re-review is auto-skipped when pass 1 raised no 🔴.** A 🔴 makes the
   re-review non-skippable **in every mode, including Fast Path** — "just do it"
   suppresses nothing extra because Fast Path's own text already skips nothing in the
   pipeline. "Review this properly" forces one re-review, phase-scoped only, then
   reverts to default; it is not recorded in task.md frontmatter and is not a
   persisting mode like Fast Path.
3. **The 2c.1 fix gate (`[Fix] [Skip] [Abort]`) folds into the Phase Implemented
   checkpoint** as `[Fix Issues]` / `[Commit Anyway]` / `[Abort]`. A phase with issues
   can never be committed unless the human explicitly picks `[Commit Anyway]` — the
   rename from `[Skip]` is deliberate, to make the acceptance explicit. The max-2
   fix-attempt cap and its `state_flag`/`error` escalation and PAUSE are unchanged in
   effect, only relocated: after a 2nd failed attempt, `[Fix Issues]` is not offered
   again, and only `[Commit Anyway]` / `[Abort]` remain. The counter is per phase and
   counts fix attempts, not review passes; it survives regardless of whether a
   re-review ran.
4. **Coherence rule:** Conductor always presents the most recently *completed* review
   pass, labelled (`Reviewer (pass N) ISSUES:`). On the 🟡-only path, no pass 2 runs, so
   the checkpoint shows Builder's fix summary and states plainly that no re-review ran
   and why — it never re-prints the stale pass-1 list as current.
5. **The parallel-batch checkpoint (2c-parallel) gains the same fold:** `[Commit All]`
   never commits a phase with issues; `[Fix Issues]` is offered for the phases that
   returned them; the max-2 counter is tracked per phase, not per batch.

### Evidence status, stated explicitly

| | The 🔴/🟡 skip | The fold |
| - | ------------- | -------- |
| Evidence | 13 re-reviews, 11 clean; both exceptions followed a 🔴 | **None** |
| Basis | Measured waste | **Human preference for fewer gates** |

The two are recorded separately, in the CHANGELOG and here, so the measured half is
never used to imply evidence for the unmeasured half.

### What Does NOT Change

| Area | Reason |
| ---- | ------ |
| The *first* Reviewer pass on every phase | Untouched — this amendment governs only the fix's re-review |
| The max-2-fix-attempt cap, its `state_flag`/`error` escalation, and the PAUSE | Relocated to the Phase Implemented checkpoint, not removed |
| The human's ability to decline a fix | Preserved as `[Commit Anyway]`, renamed from `[Skip]` for explicitness |
| Builder's full automated verification on a fix pass | Unaffected — Step 3's "After implementing all changes in a phase" scope already covers a fix |
| `**BLOCKED:**` on a failing check | Still opens the checkpoint on failure, on either path |
| Reviewer's `ISSUES` surfacing verbatim | Unaffected (Jul 2026 amendment) |
| Fast Path's opt-in-only, never-inferred trigger | Unaffected; a 🔴 re-review is simply not one of the things it skips |
| Recommendation 6 (the non-executable-surface skip of the *first* pass) | Still deferred — measured at 11.0% of diff reviews / 8.0% of invocations, below the ~20% bar |

## Amendment: Reviewer as Read-Only Shell, Labelled Recon Mode, Fixed Task Discovery (Aug 2026)

**Source:** `.tasks/001-agent-latency-reduction` Phase 8

### Problem

A census of 224 completed Reviewer invocations found 26.8% (60/224) were not reviews at
all — read-only recon, git forensics, log analysis and shell proxying — rising to 60.5%
(23/38) in `opus-5`-era sessions. A refinement pass during planning split the 231-record
population by *why* Reviewer was used: 23.4% (54/231) genuinely need a shell (git
history, process/runtime state, "execute the verification plan") and will always need to
be delegated somewhere; 6.9% (16/231) are no-shell-substitutable — Conductor or Explorer
could answer them directly — the same order as Recommendation 6's deferred 8.0%.
Mechanism: Conductor's Detour Recovery step told it to "address it" on any off-checkpoint
question with no routing, and its only shell-bearing delegation target was a Reviewer
prompted as a review, so a mid-flow "what happened to that commit?" was mislabelled a
review with no diff to grade. Separately, and independently measured: Conductor's Entry
Gate and Step 1c task-discovery glob used the bare pattern `.tasks/*`, which matches
files, not directories, so it could never discover a task directory — the defect behind
commit `b31c250`, where another task's uncommitted work folded into this task's commit
because Conductor was blind to 21 sibling task directories. The corrected pattern,
`.tasks/*/task.md`, returns all of them. One of the two broken discovery sites had also
leaked a Claude-Code-only tool name, unfenced, into the generated Copilot conductor,
where that tool does not exist.

### Decision

1. **Conductor's Selection guidance gains two routing bullets**, alongside the existing
   Builder/Explorer pair: a question that needs a shell (git history/forensics, log or
   process state, observing an existing command's behaviour) is delegated labelled
   `Recon (not a review):`; a question answerable from `.tasks/` alone is answered
   directly — never delegated. Detour Recovery's "address it" now routes through this
   rule instead of defaulting to an unlabelled spawn.
2. **`Recon (not a review):` is a labelled mode with a reduced, ceremony-free protocol.**
   Reviewer's mode statement now states plainly: on that label (or an equivalent explicit
   recon request), answer the question and stop — no plan-completion table, no severity
   tags, no PASS/NEEDS_WORK verdict, no Before-Declaring-PASS checklist. Those exist to
   grade a diff; a recon spawn has none. Reviewer remains not a *general* recon service —
   a no-shell-answerable question still gets answered (cheapest route), with one line
   naming the cheaper tool so the caller stops routing it here; Reviewer never refuses and
   bounces a question back, which would cost the caller a second round trip after an
   already-paid cold start.
3. **Reviewer is named, in its own mode statement, as this system's least-privilege
   shell** — `disallowedTools: [Edit, Write]` plus the `write-guard.sh reviewer`
   `PreToolUse` hook (see ADR-015) — which is why recon routes to it rather than to
   Builder, the weaker pattern already in use at the Resume Flow's
   `git status --porcelain` step (left unchanged, see "What Does NOT Change").
4. **The git-provenance prohibition gets a narrow, same-line carve-out.** Reviewer's rule
   against investigating error provenance during a review is unchanged; a single added
   clause, on the same physical line, states that `git log`/`git show` history inspection
   is not forbidden when the prompt explicitly opens with `Recon (not a review):` — that
   is provenance investigation the caller requested, not the unprompted digging the rule
   prohibits during a review. Scoped to the explicit label so it cannot be read as a
   general licence.
5. **The task-discovery pattern is fixed at both broken sites** (the Entry Gate and Step
   1c) to `.tasks/*/task.md`, and the leaked CC-only tool name at the second site is
   reworded platform-neutrally so nothing CC-specific ships into the Copilot variant.

Binding on this record, verbatim in substance (human decision 2026-08-07): "Phase 8 ships
in full: the glob fix, a reduced recon protocol, and Conductor's Detour Recovery routing.
The justification is the 23.4% of Reviewer spawns (54/231) that genuinely require a
shell — they get cheaper handling under the reduced protocol — plus the asymmetry that a
recon label can never wrongly skip a review of a diff, because there is no diff to skip.
It is not justified by the 6.9% eliminable share (16/231), which sits below the 8.0%
invocation share that got Recommendation 6 deferred."

### Evidence status, stated explicitly

| | The task-discovery glob fix | The recon routing (labelled mode + reduced protocol) |
| - | --------------------------- | ------------------------------------------------------ |
| Evidence | Measured, reproducible defect with a named consequence (`b31c250`) | A **volume** count of invocations (26.8% / 60.5%), not a cost measurement |
| Per-run cost figure | N/A — the defect made discovery fail outright | **None.** The 83-run survey's ~93K tokens / ~4.7 min average was measured on diff reviews, not recon spawns; recon spawns are plausibly cheaper but this is not quantified |
| Basis for shipping | Direct reproduction (the bare `.tasks/*` pattern → 0 task directories; `.tasks/*/task.md` → 21) | Not volume alone — the eliminable share (6.9%) is the same order as the deferred Rec 6 (8.0%). Justified instead by **absence of misjudgement risk**: a recon label can never wrongly skip a review of a diff, because there is no diff to skip — the exact failure mode that got Rec 6 deferred does not exist here |

### What Does NOT Change

| Area | Reason |
| ---- | ------ |
| The first Reviewer pass on every phase | Untouched — recon is a distinct, explicitly-labelled mode, never a substitute for a review of a diff |
| Every tool permission, grant, hook, and `agents:` scope | Zero widened — verified by asserting no `tools:`/`grant`/`agents:` diff in `generated/**` |
| Conductor's `.tasks/`-only Read/Glob ceiling | Explicit prior decision; not touched, and grep-asserted intact |
| Fast Path's opt-in-only, never-inferred trigger | Unaffected — recon labelling is orthogonal to Fast Path |
| The Explorer-obtained-shell-by-delegation isolation fix | Still deferred to a separate task — this amendment removes the *incentive* to proxy through Reviewer, not the *ability*; a `PreToolUse`/`matcher: "Task"` fix (or dropping `Task` from Explorer) remains the candidate remedy |
| Recommendation 6 (the non-executable-surface skip of the first pass) | Still deferred — this amendment does not revisit it, and its eliminable-share evidence deliberately does not borrow Rec 6's deferral logic in reverse |
| `conductor.template.md`'s `git status --porcelain` routed to Builder | Deliberately left as-is (human decision 2026-08-07) — Builder already owns that Resume Flow step, and moving it would be churn for no measured gain; recorded here as the existing counter-example to the read-only-shell pattern, not retrofitted |

## Related

- [RDR-031: VS Code 1.109 Orchestration](../../docs/research/RDR-031-vscode-1109-orchestration.md)
- [RDR-035: Agentic Engineering Patterns](../../docs/research/RDR-035-agentic-engineering-patterns.md) — the external research decision behind the two Aug 2026 amendments above
- [prevailing-wisdom.md](../../docs/synthesis/prevailing-wisdom.md) — Updated with new frontmatter
- [memory-and-continuity.md](../../docs/synthesis/memory-and-continuity.md) — §9 describes the execution-feedback loop and how it differs from the external-research and research-time-pattern loops
- [ADR-011](ADR-011-machine-readable-state.md) — machine-readable state that orchestration reads for parallel fan-out and flag routing
