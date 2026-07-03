# Spec-Kit Planning Backports (Clarify Skill, Soft-Gate Constitution, Cross-Phase Analyze)

**Source:** Task 087 (June 2026)

## Decision

Adopt three backports from RDR-033's spec-kit evaluation as Option B (stay on `agents` +
backport, not migrate): a new on-demand `clarify` skill driving a bounded ≤5-question
refinement loop; an `AGENTS.md` soft-gate consulted by Explorer + Reviewer during planning
and review; and an opt-in read-only cross-phase consistency mode added to the `phase-review`
skill. A brevity authoring principle was also recorded in `AGENTS.md` as a standing
convention.

## Why

The migrate-vs-stay analysis found that spec-kit and `agents` serve different purposes:
spec-kit is a planning-discipline prompt pack (strong _front half_ — clarify/analyze gates),
while `agents` is a multi-agent execution-safety framework (strong _back half_ — role-based
tool gating, Conductor checkpoints, multi-tool generation, ADR-009 per-agent model routing).
Migrating would trade away the back-half investment to buy a front half that is cheaply
backportable. The two 🔴 Gaps (clarify loop, cross-phase analyze) and the 🟡 constitution
gap are closable as small `templates/` edits — backporting captures the value at a fraction
of the cost and risk.

## Problem Statement

Three capabilities from spec-kit's planning cascade were absent from `agents`:

| Gap                              | Severity | Symptom                                                                           |
| -------------------------------- | -------- | --------------------------------------------------------------------------------- |
| No bounded clarification pass    | 🔴 Gap   | Explorers proceeded on ambiguous tasks without surfacing assumptions              |
| No `AGENTS.md` soft-gate         | 🟡       | Agents appended to Learned Patterns but never consulted them as a planning gate   |
| No cross-phase consistency check | 🔴 Gap   | Multi-phase tasks had no read-only pass to catch coverage gaps and contradictions |

In addition, the pattern of inlining every situational procedure into always-in-context
agent prose was causing template growth without an explicit principle to counteract it.

## Key Architectural Decisions

### Skill extraction over inlining

Situational procedures (the clarify pass) live in an on-demand skill
(`templates/skills/clarify/`), paid for in context only when the skill is actually run.
Explorer loads it by name when unresolved `[?]` markers remain before finalizing a plan.
This controls always-in-context growth — the ~40-line procedure costs zero context on every
task that doesn't need clarification.

**Amendment (Task 088):** The `[?]`-marker trigger was too passive — LLMs default to
confident interpretation over flagging uncertainty, so `[?]` markers rarely appear
organically. The clarify skill now has an explicit **ambiguity scan** that runs automatically
for any multi-phase plan (quick-exit for single-phase / trivially-scoped tasks). The ≤5-cap
is a ceiling, never a target. Explorer's rationalization table gains a row: "The requirements
are clear enough" → "Run the ambiguity scan; only skip if genuinely single-interpretation."

### Soft gate, not mandatory infrastructure

The constitution analogue already exists: the repo's own `AGENTS.md` Learned Patterns
section. Explorer and Reviewer now consult it as a soft planning and review gate when
present. Absence of the file is not a build error or a blocker — this deliberately avoids
the RDR-012 friction risk of mandating a new file. No `constitution.md` is created.

**Amendment (Task 088):** Rather than silently no-oping when `AGENTS.md` is absent, Explorer
and Reviewer now report "AGENTS.md not found — convention check skipped" (Explorer) /
"AGENTS.md not found — convention check skipped" (Reviewer) in their output. This makes the
gate's execution visible — the user knows the check was attempted regardless of outcome.

### Mode-in-skill, no Conductor hook

Cross-phase consistency analysis is added as a second opt-in mode inside the existing
`phase-review` skill (+0 always-in-context lines, no new orchestration step). The mode is
reachable via auto-trigger description phrases and via Conductor naming it explicitly in a
spawn prompt — exactly as it already names single-phase `phase-review`. A proactive
Conductor auto-offer is deliberately deferred: it would re-bloat the just-trimmed Conductor
for an opt-in, minority-of-tasks feature.

### Brevity as standing convention

Recorded in `AGENTS.md`: "replace > append; push situational behavior into on-demand skills
rather than always-in-context agent prose; delete > comment out." This is the principle that
justified extracting `clarify` into a skill, made explicit so future template authors default
to lean edits.

### Phase-count right-sizing (Amendment — Task 088)

Explorer and Conductor previously had unconditional "always produce a phased plan" / "break
into numbered phases" instructions, normalizing 3+ phases as the expected count. This
inflated planning overhead for small tasks. The amendment replaces all three pressure points:

| Pressure point              | Before                            | After                                                                                           |
| --------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Explorer `Initial Research` | "always produce a phased plan"    | Right-size to work: single-phase when scope is clear; multi-phase when concerns are independent |
| Explorer `Step Sizing`      | "Too big → break" (unconditional) | "Too big → break _when it spans multiple independent concerns_"                                 |
| Conductor Step 1 spawn      | "Break into numbered phases"      | "Size the plan to the task — one phase for well-scoped changes"                                 |

The Conductor's phase loop and Step 1b presentation work correctly for N=1 without changes.

## See Also

- [RDR-033](../research/RDR-033-spec-kit-sdd.md) — research, comparison, and recommendations
- [ADR-009](ADR-009-non-claude-model-types.md) — preserved by these backports (no frontmatter touched)
- [ADR-007](ADR-007-rationalization-prevention.md) — a prior prose-convention ADR (style reference)

## Updates

| Date     | Task | Summary                                                                                                                                                                                      |
| -------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jul 2026 | 088  | Phase-count calibration (Explorer/Conductor neutral heuristic); clarify ambiguity scan made automatic for multi-phase plans; AGENTS.md gate reports when absent instead of silently no-oping |
