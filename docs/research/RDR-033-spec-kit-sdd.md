# RDR-033: Spec-Kit Spec-Driven Development — Comparison & Backporting

| Field      | Value                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| **Source** | [github.com/github/spec-kit](https://github.com/github/spec-kit); [spec-driven.md](https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md); Slack (colleague) |
| **Date**   | 2026-06-25                                                                                               |
| **Status** | Adopted                                                                                                   |

## Summary

spec-kit (github.com/github/spec-kit) is a modern multi-command Spec-Driven Development
(SDD) toolkit — constitution → specify → clarify → plan → tasks → analyze → implement —
that treats the specification as the primary artifact and code as its expression. A
a colleague has been using it in real production workflows, motivating this
evaluation. This RDR supersedes RDR-001's 2024 evaluation, which targeted a different,
older spec-driven toolkit (`.specstory/` files), not the current multi-command cascade.

## Context & Background

### What spec-kit is

spec-kit is an open-source set of slash-command prompt templates for Spec-Driven
Development, integrating with 30+ AI coding agents (Claude, Copilot, Cursor, Gemini).
Its philosophy: *"Specifications don't serve code — code serves specifications"*
([spec-driven.md](https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md)).
The pipeline is eight discrete commands — constitution, specify, clarify, plan, tasks,
analyze, checklist, implement — each producing structured artifacts. The `clarify` and
`analyze` commands are listed as "Optional" in the README but are treated as recommended
quality gates in their respective prompts ([inventory-spec-kit.md §8.3]).

### Why revisit now

RDR-001 (Rejected, 2024-12-28) evaluated the `.specstory/` spec-file toolkit and found
it duplicative of the Plan agent's output. The thing rejected then is not the thing being
evaluated here. Modern spec-kit introduces a structured `clarify` loop and a
cross-artifact `analyze` gate — capabilities that the `.specstory/` approach lacked
entirely. The colleague's real production usage (running 6 phases × 4 specs concurrently via Docker
sandbox + git worktrees [SLACK-SOURCED]) provides concrete evidence of value, making this
a timely re-evaluation rather than a reconsideration of a closed question.

### Current agents planning flow

The `agents` framework uses a pipeline of Explorer (read-only research + plan,
`templates/agents/explorer.template.md`) → Builder (implement, `builder.template.md`) →
Reviewer → Committer, optionally orchestrated by Conductor
(`templates/agents/conductor.template.md`). Conductor runs phases sequentially with two
unconditional pause checkpoints per phase: one after plan review (Step 2b, conductor
`L327-L357`) and one after implementation (Step 2d, conductor `L464-L509`). The core
design principle: *"The highest leverage point is at the end of research and the beginning
of the plan"* (`README.md L35`). Templates under `templates/` are the source of truth;
`make` regenerates `generated/`; `install.sh` deploys.

---

## Comparison: spec-kit SDD vs Current `agents` Flow

### Legend

- **✅ Already-covered** — agents handles this concept with comparable depth.
- **🟡 Partial** — agents has a related mechanism but the spec-kit version is meaningfully
  richer or more explicit.
- **🔴 Gap** — agents has no direct analogue; this is a genuine capability difference.

### Summary Table

| # | spec-kit concept | What spec-kit does | Current `agents` analogue | Classification |
|---|------------------|--------------------|---------------------------|----------------|
| 1 | Gradual high-level → detailed spec refinement | `clarify` formalizes iterative refinement (max 5 Qs/session); "requirements and design become continuous activities" | Explorer is single-pass; phase-review vets a finished plan; Conductor checkpoint 2b is the closest "refine before commit" point | 🟡 Partial |
| 2 | Formalized spec artifact vs prose+MD plan | `spec.md` = WHAT/WHY, tech-agnostic, business-stakeholder audience; enforced by `specify` | `task.md` blends Overview/Goal (WHAT/WHY) with phase plans (HOW); no separate artifact boundary enforced | 🟡 Partial |
| 3 | Staged commands (specify / clarify / plan / tasks / analyze) | Discrete commands, each producing verifiable artifacts; clear spec→plan→tasks→implement spine | Explorer (research+plan combined), phase-review (review), Builder (implement); no separate tasks/analyze commands | 🟡 Partial |
| 4 | `[NEEDS CLARIFICATION]` markers + clarify taxonomy loop | Max-3 markers in `specify` for critical ambiguities; `clarify` runs 9-category taxonomy scan (max 5 Qs/session) to surface and resolve gaps | Explorer `[?]` uncertainty markers (`explorer L111, L151-L152`); "Clarifying Questions (Only If Necessary)" deliberately minimizes questions (`explorer L416-L424`) | 🔴 Gap |
| 5 | `analyze` cross-artifact consistency gate | Read-only gate over spec↔plan↔tasks for gaps/dupes/contradictions/constitution-alignment; runs after `tasks`, before `implement` | `phase-review` reviews exactly ONE phase plan; no cross-phase/cross-artifact consistency pass (`phase-review L13`) | 🔴 Gap |
| 6 | `[P]` parallel markers + sequential implement | `[P]` marks intra-phase parallel-eligibility in `tasks.md`; upstream `implement` is still sequential phase-by-phase | Conductor runs phases strictly sequentially with unconditional checkpoints (`conductor L167`); no in-plan parallel-eligibility markers | 🟡 Partial |
| 7 | Sandbox / worktree parallelism (colleague's harness) | External orchestration (Docker sandbox + git worktrees + draft PRs + `speckit.status` agent) — NOT upstream spec-kit [SLACK-SOURCED] | No built-in worktree/sandbox parallelism; Conductor's unconditional checkpoints create direct tension with autonomous parallel runs (`conductor L167`) | 🔴 Gap |
| 8 | Constitution (immutable project principles gate) | `.specify/memory/constitution.md` gates downstream; `analyze` enforces MUST rules as non-negotiable | `AGENTS.md` "Learned Patterns" + repo `CONTEXT.md` + ADRs under `docs/architecture/`; `consolidate-task` creates ADRs (`consolidate-task L13-L48`) | 🟡 Partial |

> **Note on `checklist`:** spec-kit's `checklist` command is a requirements-quality
> validation step ("unit tests for requirements writing") and has no meaningful analogue
> in agents, which focuses on code-quality validation. It is deliberately omitted from
> the table above rather than mapped imprecisely. This omission is explicit.

---

### Concept 1: Gradual High-Level → Detailed Spec Refinement

**Classification: 🟡 Partial.** spec-kit formalizes refinement as continuous activity:
*"requirements and design become continuous activities rather than discrete phases"*
([spec-driven.md](https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md)
§4.7). The `clarify` command is the concrete mechanism — a max-5-questions-per-session
taxonomy scan across nine ambiguity categories ([clarify.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/clarify.md);
inventory-spec-kit.md §3.3, §4.7). The colleague identifies this gradual refinement (very
high-level → progressively detailed spec → plan → tasks) as spec-kit's core value
[SLACK-SOURCED]. agents' Explorer is single-pass: it does research and produces a plan in
one invocation (`explorer L194-L225`); the phase-review skill (`phase-review L9-L16`)
vets a plan after it's written. Conductor's checkpoint 2b (`conductor L327-L357`) is the
closest "user refines before committing" gate, but it reviews a finished plan rather than
driving iterative spec elaboration. The gap is the absence of a progressive multi-pass
spec escalation step before phasing begins.

### Concept 2: Formalized Spec Artifact vs Prose+MD Plan

**Classification: 🟡 Partial.** This concept directly revisits RDR-001. spec-kit enforces
an explicit WHAT/WHY / HOW split at the artifact level: `spec.md` (produced by `specify`)
is technology-agnostic and written for business stakeholders; plan artifacts
(`research.md`, `data-model.md`, `/contracts/`, `quickstart.md`) carry the HOW
([spec-driven.md](https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md)
§4.2; [specify.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/specify.md);
inventory-spec-kit.md §3.2, §4.2). agents' `task.md` captures intent in its
Overview/Goal section (WHAT/WHY) alongside phase plans (HOW) in the same file
(`explorer L340-L375`). RDR-001's objection — that a separate spec file "would duplicate
the Plan agent's output and add file maintenance overhead" (RDR-001 Decision/Rationale,
L21-L29) — still applies to the *static spec-file* idea. The partial coverage is that
`task.md` captures intent, not that it enforces a clean artifact boundary.

### Concept 3: Staged Commands (specify / clarify / plan / tasks / analyze)

**Classification: 🟡 Partial.** spec-kit's cascade breaks planning into discrete
verifiable stages, each producing a separate artifact with explicit scope constraints
(inventory-spec-kit.md §2). The spec→plan→implement spine exists in agents via
Explorer→Builder (`inventory-agents-flow.md §1` pipeline, §4 roles table). What agents
lacks are the finer subdivisions: a separate `specify` step (WHAT/WHY only), a `clarify`
step, a dedicated `tasks` step (dependency-ordered, file-paths-required task list), and
an `analyze` gate. The phase-review skill (`phase-review L9-L16`) approximates the
review function but is narrower (one phase at a time, not cross-artifact). This partial
coverage means the overall skeleton is present; the rigor at each subdivision is not.

### Concept 4: `[NEEDS CLARIFICATION]` Markers + Clarify Taxonomy Loop

**Classification: 🔴 Gap.** This is the most significant capability difference.
spec-kit's `specify` command mandates a maximum of three `[NEEDS CLARIFICATION]` markers
per run for critical ambiguities, preventing the model from silently assuming an answer
([specify.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/specify.md);
inventory-spec-kit.md §3.2, §4.3). The `clarify` command then runs a structured taxonomy
scan across nine categories (max 5 questions per session, one at a time), updating the
spec with a dated Clarifications section after each accepted answer
([clarify.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/clarify.md);
inventory-spec-kit.md §3.3). **Open question (inventory-spec-kit.md §8.1):** `clarify`
does NOT directly resolve `[NEEDS CLARIFICATION]` markers via text scan; whether the
taxonomy scan incidentally addresses them is unconfirmed. agents has `[?]` uncertainty
markers (`explorer L111, L151-L152`) but the "Clarifying Questions (Only If Necessary)"
guidance at `explorer L416-L424` deliberately *discourages* asking questions. There is no
driven resolution loop: agents marks uncertainty but does not mandate resolution before
proceeding. The colleague identifies this loop as spec-kit's top value [SLACK-SOURCED].

### Concept 5: `analyze` Cross-Artifact Consistency Gate

**Classification: 🔴 Gap.** `/speckit.analyze` is a read-only gate that runs after
`tasks` and before `implement`, scanning spec↔plan↔tasks simultaneously for coverage
gaps, duplication, contradictions, and constitution-alignment violations ([analyze.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/analyze.md);
inventory-spec-kit.md §3.6, §4.4). It is the only stage with a simultaneous view across
all three core artifacts. agents' `phase-review` skill (`phase-review L13`) reviews
exactly ONE phase plan at a time and explicitly must not modify plan files — it has no
cross-artifact or cross-phase view (`inventory-agents-flow.md §6`). **Note:** README
labels `analyze` "Optional"; per-command prompts treat it as a recommended gate before
implementation (inventory-spec-kit.md §8.3). The gap is real regardless: no cross-phase
consistency pass exists in agents.

### Concept 6: `[P]` Parallel Markers + Sequential Implement

**Classification: 🟡 Partial.** The sequential execution default is covered: agents'
Conductor runs phases strictly sequentially with two unconditional checkpoints per phase
(`conductor L167`; `inventory-agents-flow.md §2, §3`). This matches spec-kit's upstream
`implement` behavior — phase-by-phase sequential execution, completing each phase before
the next ([implement.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/implement.md);
inventory-spec-kit.md §3.8, §5). The gap is the `[P]` marker mechanism itself: spec-kit's
`tasks` command annotates individual tasks as parallel-eligible when they involve
different files with no incomplete-task dependencies ([tasks.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/tasks.md);
inventory-spec-kit.md §3.5, §4.5). agents has no in-plan parallel-eligibility annotation.
The Partial verdict reflects: sequential-by-default behavior is covered; explicit
parallel-eligibility marking is the gap.

### Concept 7: Sandbox / Worktree Parallelism (Colleague's Harness)

**Classification: 🔴 Gap.** This capability is entirely the colleague's custom external layer —
not upstream spec-kit ([SLACK-SOURCED]; inventory-spec-kit.md §5, §6). The colleague runs
`implement` autonomously inside a Docker sandbox, uses git worktrees so multiple
implementations run in parallel on separate branches, captures each run as a draft PR,
and monitors with a custom `speckit.status` agent and iTerm tab colors. Neither spec-kit
upstream nor agents provides this. Conductor's unconditional checkpoints (`conductor L167`)
create a direct architectural tension with autonomous parallel runs: checkpoints require
user approval before each phase's implementation, which is incompatible with fire-and-forget
parallel execution. Phase 4 will assess whether and how to address this gap.

### Concept 8: Constitution (Immutable Project Principles Gate)

**Classification: 🟡 Partial.** spec-kit's `constitution` command produces
`.specify/memory/constitution.md` — a versioned governance document with cascade
consistency rules: all downstream artifacts must align with any amendment, and `analyze`
enforces MUST rules as non-negotiable ([constitution.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/constitution.md);
[analyze.md](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/analyze.md);
inventory-spec-kit.md §3.1, §4.4). agents has analogous artifacts: `AGENTS.md` "Learned
Patterns" (project-level conventions), `CONTEXT.md` (domain vocabulary), and
architecture ADRs under `docs/architecture/` created by the `consolidate-task` skill
(`consolidate-task L13-L48`). The gap is that agents lacks an immutable per-project
principles gate and no downstream agent enforces constitutional compliance automatically.

---

### Reconciliation with Prior Decisions

#### RDR-001 (Rejected, 2024-12-28)

RDR-001 evaluated the `.specstory/` spec-file toolkit and rejected it because *"the Plan
agent produces implementation plans that serve the same purpose as spec files"* and a
separate format *"would duplicate the Plan agent's output and add file maintenance
overhead"* (RDR-001 L21-L29). That objection targeted the *static spec-file* concept: a
structured Markdown file capturing requirements alongside the plan. RDR-033 revisits a
different target. Modern spec-kit is a multi-command discipline — constitution, specify,
clarify, plan, tasks, analyze, implement — whose most distinctive capabilities (the
`clarify` resolution loop, the `analyze` cross-artifact gate) did not exist in the
`.specstory/` toolkit RDR-001 evaluated. RDR-033 does not contradict RDR-001: the
"duplicate-of-the-plan" objection still applies to the static spec-file idea (Concept 2),
but it does not dispose of the `clarify` loop (Concept 4) or the `analyze` gate (Concept
5), which are new.

#### RDR-012 (Partially Adopted, 2026-01-03)

RDR-012 adopted the "read-before-decide" attention technique but explicitly rejected
mandatory multi-file scaffolding as *"too much friction"* (RDR-012 Decision, L14-L24;
Key Insight, L26-L28). This is the friction-vs-value lens every Phase 4 recommendation
must pass through. Any backport that adds mandatory artifacts — a separate `spec.md`,
a `constitution.md`, per-feature `/contracts/` directories — inherits RDR-012's burden of
proof: the friction must be justified by concrete, non-duplicative value. Phase 3 frames
this test; Phase 4 applies it per concept.

---

### Open Questions Carried into the Comparison

1. **`[NEEDS CLARIFICATION]` ↔ `clarify` linkage (Concept 4).** `specify` produces
   `[NEEDS CLARIFICATION]` markers; `/speckit.clarify` performs a fresh taxonomy scan
   rather than scanning for those marker strings. Whether the taxonomy scan incidentally
   resolves the same ambiguities is unconfirmed (inventory-spec-kit.md §8.1). Phase 4
   should not over-claim a clean mapping between agents' `[?]` markers and a potential
   `clarify` analogue.

2. **`clarify` and `analyze` as truly "Optional" (Concepts 4 and 5).** The spec-kit
   README classifies both as "Optional Commands." The per-command prompts treat them as
   recommended gates before planning and before implementation respectively
   (inventory-spec-kit.md §8.3). Any backport recommendation should name which framing
   it adopts.

---

## Recommendations

### Decision Summary

This RDR proposes backporting the clarify/refinement loop as the single highest-value
change to the `agents` framework: it addresses the most significant capability gap
identified (Concept 4 is classified 🔴 Gap), is directly confirmed by the colleague's real-world
experience as spec-kit's core value [SLACK-SOURCED], and targets the high-leverage moment
already recognised in agents' design (`README.md L35`). The formal-spec-artifact idea
(Concept 2) and the command-subdivision ceremonies (Concept 3) are assessed as
friction > value — consistent with RDR-001 L25 (duplication) and RDR-012 L22-L24
(mandatory infrastructure) — and are skipped. The sandbox/worktree harness (Concept 7)
is explicitly out of scope: it is the colleague's external layer, not an `agents` framework concern.
Status: **Proposed** — these are recommendations the maintainer acts on separately by editing
`templates/` files; no template edits are made by this RDR.

### Verdict Table (at-a-glance)

**Change-size scale:** Small = edit one template's prose/guidance (no new file, no new
agent/skill). Medium = one new skill OR a substantive new section/mode across 1-2
templates. Large = new agent, new orchestration step, or cross-cutting change to the
Conductor loop/checkpoint model.

| # | Concept | Verdict | Maps onto (`templates/` file) | Size | Friction-vs-value (RDR-012 lens) |
|---|---------|---------|-------------------------------|------|----------------------------------|
| 1+4 | Refinement + clarify loop | **Backport** ⭐ | `templates/agents/explorer.template.md` (L416-L424); opt. new `templates/skills/clarify/SKILL.template.md` | Small (prose) / Medium (new skill) | Value clearly exceeds friction (cited as the colleague's #1 value; pre-checkpoint; question cap bounds it) |
| 2 | Formalized spec artifact | **Skip** | — (no change; `task.md` already covers intent) | — | Friction > value: duplicates `task.md` (RDR-001 L25); mandatory file (RDR-012 L22-L24) |
| 3 | Staged command subdivision | **Skip** (spine already covered) | — (Explorer→Builder spine sufficient) | — | Ceremony > value for single-Explorer model |
| 5 | Cross-artifact consistency gate | **Partial-backport** | `templates/skills/phase-review/SKILL.template.md` | Medium | Opt-in, read-only; mandatory gate would fail RDR-012 for small tasks |
| 6 | `[P]` parallel markers | **Skip** (inert) | — (no parallel executor exists in agents) | — | Inert annotation without a consumer |
| 7 | Sandbox/worktree parallelism | **Skip** / Out of scope | — (external harness; architectural tension with `conductor L167`) | — | Out of scope: not a framework concern |
| 8 | Constitution / principles gate | **Partial-backport** (lean) | `templates/agents/explorer.template.md`; `templates/agents/reviewer.template.md` | Small | Reuse `AGENTS.md`; new mandatory file fails RDR-012 L22-L24 |

### Per-Concept Recommendations

#### Concepts 1+4: Refinement + Clarify / `[NEEDS CLARIFICATION]` Resolution Loop — BACKPORT ⭐ Top Priority

*(Concepts 1 and 4 describe the same backport from two angles — the gradual refinement
workflow and the `[NEEDS CLARIFICATION]` / clarify-loop mechanism — and are covered in
this single merged subsection.)*

**Verdict: Backport.** The `agents` Explorer is single-pass: it researches and plans in
one invocation, with "Clarifying Questions (Only If Necessary)" guidance that actively
discourages questions (`explorer L416-L424`). `[?]` uncertainty markers exist
(`explorer L111, L151-L152`) but no resolution loop drives them to closure before
phasing begins. spec-kit's `clarify` runs a structured nine-category taxonomy scan, capped
at five questions per session, one at a time, recording accepted answers in the spec with a
dated Clarifications section (`inventory-spec-kit.md §3.3, §4.3, §7`). The colleague identifies
this gradual high-level → detailed refinement as spec-kit's top value [SLACK-SOURCED].

**Concrete mapping:** Two graduated options:

- **(a) Small** — Reword `explorer L416-L424` from "ask only if necessary" toward a
  bounded, structured clarify pass: surface `[?]` markers, ask up to N questions (one at
  a time), record answers in `task.md` before phasing begins. No new files.
- **(b) Medium** — Add a dedicated `clarify` skill at
  `templates/skills/clarify/SKILL.template.md` that Explorer invokes, analogous to the
  existing `phase-review` skill (`phase-review L9-L16`), driving a `[?]`-resolution loop
  before the phase table is finalised.

**Open-question caveat (`inventory-spec-kit.md §8.1`):** spec-kit's `clarify` does NOT
directly resolve `[NEEDS CLARIFICATION]` markers via text scan — it runs a fresh taxonomy
scan whose coverage of those markers is unconfirmed. The agents version (resolving `[?]`
markers directly) is actually cleaner; do not over-claim a one-to-one correspondence.

**RDR-012 friction note:** This adds an interactive step. Justified: it resolves
uncertainty *before* the high-leverage plan checkpoint (`README.md L35`) — exactly the
moment where friction has the highest return. Bound it with a question cap (≤5) to prevent
open-ended back-and-forth. Start with option (a); graduate to (b) once the value is
demonstrated.

#### Concept 5: Cross-Artifact / Cross-Phase Consistency Pass — PARTIAL-BACKPORT

**Verdict: Partial-backport.** The `phase-review` skill reviews exactly ONE phase plan and
must not modify plan files (`phase-review L13`); it has no cross-phase or cross-artifact
view (`inventory-agents-flow.md §6`). spec-kit's `/speckit.analyze` is a read-only gate
that runs across spec↔plan↔tasks simultaneously, scanning for coverage gaps, duplication,
contradictions, and constitution-alignment violations before implementation
(`inventory-spec-kit.md §3.6, §4.4, §7`).

**Concrete mapping:** Add an optional cross-phase consistency mode to the `phase-review`
skill (`templates/skills/phase-review/SKILL.template.md`) — or create a sibling
`analyze`-style skill — that reads the full `task.md` phase set and surfaces gaps and
contradictions across phases. Keep it read-only (consistent with phase-review's no-edit
rule) and opt-in.

**Size: Medium** — a new skill or a substantive mode extension to an existing skill.

**RDR-012 friction note:** A mandatory cross-artifact gate on every task would fail the
RDR-012 test for small, single-phase tasks. Keep it opt-in, invoked by the user or
Conductor for multi-phase tasks only, matching spec-kit's own "Optional" classification of
`analyze` in the README.

#### Concept 8: Constitution / Project-Principles Gate — PARTIAL-BACKPORT (Lean)

**Verdict: Partial-backport (lean).** agents already has close analogues to the
constitution: `AGENTS.md` "Learned Patterns" (project-level conventions), repo
`CONTEXT.md` (domain vocabulary), and architecture ADRs created by the
`consolidate-task` skill (`consolidate-task L13-L48`). The gap is that no downstream
agent explicitly enforces these as a gate — no equivalent of `analyze`'s MUST-rule
enforcement.

**Concrete mapping (Small):** Add explicit `AGENTS.md` consultation guidance to
`templates/agents/explorer.template.md` (planning gate) and
`templates/agents/reviewer.template.md` (review gate) — have each agent consult
`AGENTS.md` as a de-facto constitution when available, rather than treating it as
optional background reading. No new file required.

**Size: Small** — prose additions to two existing templates, no new agent or skill.

**RDR-012 friction note:** A new mandatory `.specify/memory/constitution.md` per project
is exactly the "mandatory infrastructure" RDR-012 rejected (RDR-012 L22-L24). Reusing
`AGENTS.md` avoids the friction entirely — the file already exists in repos that use this
framework, so the only cost is making the gate explicit in the templates.

#### Concept 2: Formalized Spec Artifact — SKIP

**Verdict: Skip.** This is the concept RDR-001 already rejected. The specific objection
(RDR-001 L25): adding a separate spec file *"would duplicate the Plan agent's output and
add file maintenance overhead."* That sentence applies directly to a standalone `spec.md`
enforcing a WHAT/WHY boundary alongside `task.md`. agents' `task.md` already captures
WHAT/WHY in its Overview/Goal section (`explorer L340-L375`); the boundary exists
informally. A separately enforced `spec.md` artifact fails both RDR-001 L25 (duplication
of intent already in `task.md`) and RDR-012 L22-L24 (mandatory new file with maintenance
overhead). Friction > value.

#### Concept 3: Staged Command Subdivision — SKIP (Spine Already Covered)

**Verdict: Skip / Already-covered (spine).** The spec→plan→implement spine exists in
agents via Explorer→Builder (`inventory-agents-flow.md §1, §4`). Subdividing this into
separate `specify`, `tasks`, and additional `analyze` commands would add ceremony without
proportional value for agents' single-Explorer model. The one genuinely missing
subdivision — the clarify loop — is captured as Concepts 1+4 above; the cross-artifact
gate is captured as Concept 5. The remaining subdivisions (separate `specify` step,
separate `tasks` step) replicate structure agents already has under different names.
**Skip** the subdivisions; the spine is covered.

#### Concept 6: `[P]` Parallel Markers — SKIP (Inert)

**Verdict: Skip.** agents' Conductor already matches spec-kit's sequential-by-default
execution — phases run strictly in order with unconditional checkpoints (`conductor L167`;
`inventory-spec-kit.md §5`). An in-plan `[P]` parallel-eligibility marker has no consumer
in agents: there is no parallel executor that would act on it. Adding `[P]` annotations
to `tasks.md` entries would be inert documentation. **Skip** until/unless a parallel
executor exists.

#### Concept 7: Sandbox / Worktree Parallelism — SKIP / OUT OF SCOPE

**Verdict: Skip — out of scope.** This capability is entirely the colleague's custom external
layer, NOT upstream spec-kit (`inventory-spec-kit.md §5, §6` [SLACK-SOURCED]). The colleague runs
`implement` autonomously inside a Docker sandbox, uses git worktrees for parallel
branches, captures each run as a draft PR, and monitors with a custom `speckit.status`
agent. Neither spec-kit upstream nor agents provides this.

**Assessment:** This does **not** belong in `agents` as currently designed. Conductor's
unconditional checkpoints (`conductor L167`) require user approval before each phase's
implementation — a direct architectural incompatibility with fire-and-forget parallel
runs. If autonomous parallelism is ever wanted, that is a separate, large architectural
project (relaxing or overriding the unconditional-checkpoint model across the full
Conductor loop), not a spec-kit backport. Mark **OUT OF SCOPE**, not merely "skip."

---

### NOT Worth Backporting (and Why)

The following concepts are explicitly assessed as not worth backporting. Each is listed
with its reason, bucketed for quick scanning:

**Already covered — no action:**

- Spec→plan→implement spine (Concept 3 spine) — Explorer→Builder already provides this
  structure; separate command names add ceremony without new capability.
- Sequential-by-default execution (Concept 6 sequencing) — Conductor's checkpoint model
  already enforces sequential phase execution, matching spec-kit's upstream `implement`
  behavior.

**Friction > value (RDR-012 / RDR-001):**

- Formalized standalone `spec.md` (Concept 2) — duplicates `task.md` Overview/Goal
  (RDR-001 L25: "would duplicate the Plan agent's output and add file maintenance
  overhead"); mandatory file (RDR-012 L22-L24).
- Separate `specify` / `tasks` command subdivision (Concept 3 subdivisions) — the
  existing Explorer+task.md structure already covers this; finer subdivision adds
  ceremony.
- New mandatory `constitution.md` file (Concept 8 — new-file variant) — reuse `AGENTS.md`
  instead; a per-project constitution file is exactly what RDR-012 L22-L24 rejected as
  "mandatory infrastructure."

**Inert without a consumer:**

- `[P]` parallel-eligibility markers (Concept 6) — no parallel executor exists in agents;
  annotation would be ignored.

**External harness, not framework (OUT OF SCOPE):**

- Docker sandbox + git worktrees + draft-PR parallelism + `speckit.status` agent
  (Concept 7) — colleague's custom external layer [SLACK-SOURCED]; not upstream spec-kit; direct
  architectural tension with Conductor's unconditional checkpoints.

**Not evaluated / no analogue:**

- spec-kit's `checklist` command (requirements-quality validation, "unit tests for
  requirements writing") — no meaningful analogue in agents, which focuses on code-quality
  validation. Disposition: out of scope for this RDR (explicitly omitted, not implicitly
  overlooked).

---

### Suggested Sequencing

Ordered highest-value-lowest-friction first:

1. **Clarify / `[?]`-resolution loop in Explorer (Concepts 1+4)** — the colleague's cited #1 value; start
   with the **small** prose edit to `explorer L416-L424` (bounded, structured question
   pass, question cap ≤5, answers recorded in `task.md`). Optionally graduate to a
   dedicated `clarify` skill later. *Do this first.*

2. **Lean constitution via `AGENTS.md` (Concept 8)** — small, no new mandatory file; add
   explicit `AGENTS.md` consultation guidance to Explorer and Reviewer templates. Low
   effort, immediate reward.

3. **Opt-in cross-phase consistency pass (Concept 5)** — medium; pursue after the clarify
   loop proves out, since both share the same design ethos (lightweight, opt-in,
   read-only). This is the only medium-size change in the backport list.

4. **Everything in "NOT worth backporting"** — no action needed. Revisit Concept 7
   (sandbox/worktree parallelism) only if a parallel-execution architecture is ever
   pursued — that is a large, separate architectural project, not a spec-kit backport.

---

### How Adoption Would Be Recorded

Adoption means editing the relevant files under `templates/` and running `make &&
./install.sh` to regenerate and deploy (`inventory-agents-flow.md §7`; `README.md
L389-L417`). This RDR remains `Proposed` until those edits land. Once they do:

- If all recommended backports are implemented: Status → `Adopted`
- If a subset is implemented: Status → `Partially Adopted`
- Per-status semantics: `docs/research/RESEARCH.md L98-L104`

The Committer updates both the RDR front-matter and the CATALOG.md row at that time to
keep the two in sync.

---

## Decision & Outcome

**Date:** 2026-06-26 · **Decision-maker:** maintainer · **Status:** Adopted (Option B)

**Option B — stay on `agents` and backport spec-kit's planning ideas** was adopted, rather
than migrating to spec-kit (Option A) or running a hybrid (Option C). The migrate-vs-stay
analysis concluded that spec-kit and `agents` are different kinds of tool: spec-kit is a
planning-discipline prompt pack (strong *front half* — clarify/analyze gates), while `agents`
is a multi-agent execution-safety framework (strong *back half* — role-based tool gating,
Conductor checkpoints, multi-tool generation, ADR-009 per-agent model routing). Migrating would
trade away the back-half investment to buy a front half that is cheaply backportable. The two
🔴 Gaps (clarify loop, cross-phase analyze) and the 🟡 constitution gap are closable as small
`templates/` edits — so backporting captures the value at a fraction of the cost and risk.

### What landed (Task 087)

All three recommended backports were fully implemented as `templates/` edits, regenerated into
both `generated/claude/` and `generated/copilot/`, with `make validate` clean. (The
"Partial-backport" labels in the Verdict Table describe the recommended *scope* of each
backport, not incomplete implementation — all three items were fully implemented as planned.)

| Backport | Concept(s) | What shipped | Commit(s) |
| --- | --- | --- | --- |
| Clarify / refinement loop | 1 + 4 (🔴 Gap) | NEW on-demand `clarify` skill (bounded ≤5-question pass, dated `## Clarifications` recording, two delivery modes); minimal Explorer pointer; Conductor Step 2a.3 routing | 90f8059, 14a8d60 |
| Lean constitution (soft gate) | 8 (🟡) | Explorer + Reviewer consult `AGENTS.md` as a soft planning/review gate; **brevity authoring principle** added to `AGENTS.md` | b799a58 |
| Opt-in cross-phase analyze | 5 (🔴 Gap) | Read-only multi-phase consistency mode in the `phase-review` skill; opt-in, no Conductor hook, +0 always-in-context lines | 83c1a6e |

### Growth-control outcome

Backporting was done lean, not additively: the clarify procedure was **extracted into an
on-demand skill** rather than inlined into the always-in-context Explorer template; the
Conductor was **trimmed** as part of the constitution work (folded-in brevity edits); and a
**brevity principle** ("replace > append; push situational behavior into on-demand skills;
delete > comment out") was recorded in `AGENTS.md` so future template edits default to lean.
Net always-in-context instruction growth was kept minimal despite adding three capabilities.

The skipped items (Concepts 2, 3, 6, 7) remain skipped, consistent with this RDR's
recommendations — none were recommended for backport, so this is full adoption of the
recommendation set (→ `Adopted`, per `RESEARCH.md` status semantics).

> Architecture decision recorded in
> [ADR-010](../architecture/ADR-010-spec-kit-planning-backports.md).
