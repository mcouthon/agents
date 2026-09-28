---
name: consolidate-task
description: "Use when a task completes: evaluate whether it warrants an architectural decision record (the default is none) and propose an instruction delta for future agents. Triggers on: 'use consolidate-task mode', 'consolidate-task', 'consolidate task', 'summarize task', 'retrospective', 'what did we learn', 'compound learnings'."
allowed-tools: [Read, Edit, Write, Grep, Glob]
---

# Consolidate a Completed Task

One pass over `.tasks/{task-folder}/` evaluates two independently skippable outputs:

| Output               | Audience          | Question                            | Destination                                 |
| -------------------- | ----------------- | ----------------------------------- | ------------------------------------------- |
| Architectural record | future developers | What did the code decide?           | `docs/architecture/ADR-NNN-*.md`            |
| Instruction delta    | future agents     | What should agents do differently?  | routed by scope — see Process Learnings     |

**For most tasks the outcome is neither** — no ADR is the norm, not a missing output.
Read `.tasks/{task-folder}/task.md` for the architectural record, and the phase plans
for the instruction delta.

## When to Create an ADR

**The default answer is no ADR.** ADRs record decisions that future developers must
follow — not features, not fixes, not process notes. Most tasks, including large
ones, need none. Evaluate in order and stop at the first match: **skip → update →
create**.

**Skip — the normal outcome — when any is true:**

- The result is derivable from the code and README: a competent reader of both could
  reconstruct why each choice beat its alternatives
- A prior ADR already documents the pattern and the task merely followed it
- Nothing outside the changed files must conform — no future work elsewhere is
  constrained by the decision

**Update an existing ADR when:** the task changes a pattern a prior ADR documents
(new trade-off, new rejected alternative, or scope change). Add a row to that ADR's
Updates table; do not fork a new ADR for an amendment.

**Create a new ADR only when ALL three hold — and the ADR names each:**

1. **Cross-cutting** — the decision constrains code beyond the files that implement
   it; future work elsewhere must follow it or consciously reverse it
2. **Not derivable** — a reader of the code and README cannot reconstruct why this
   choice beat its alternatives
3. **New or reversing** — no existing ADR covers the pattern, or the decision
   reverses one

If you cannot state in one sentence per criterion how all three hold, the answer is
skip — and **"ADR skipped: [criterion]" is a successful report**, not a missing
output.

## File Naming

**Required format:** `ADR-NNN-{decision-name}.md`

1. Scan `docs/architecture/` for existing `ADR-*` files
2. Check if any existing ADR covers the same architectural area (update if so)
3. For new ADRs: find the highest number (e.g., `ADR-003-*` → next is `004`)
4. Start at `001` if no ADR files exist
5. Save to: `docs/architecture/ADR-NNN-{decision-name}.md`

Example: `ADR-004-unified-query-execution.md`

## Output Format

Target: an ADR for a real decision fits in **40-60 lines**. Every section after
Decision is one short block (paragraph, bullet list, table, or snippet) — never
more.

````markdown
# {Decision Title}

**Source:** Task {NNN} ({Month Year})
**Criteria met:** cross-cutting — {how}; not derivable — {why code + README cannot
say it}; new/reversing — {what is new, or which ADR is reversed}

## Decision

One sentence describing the architectural choice.

## Why

- The motivation: what problem, what constraint
- Only the reasoning a code reader cannot reconstruct

## Alternatives Considered

- {Rejected option} — {why, one line}
- At least one real alternative is required: if none existed, the "not derivable"
  criterion fails and the ADR should have been skipped

## Solution

Brief before/after, only what a follower of the pattern needs. At most one code
snippet, and only if the pattern is genuinely new — otherwise the code is its own
reference.

## Current Structure (optional)

Only the directories a follower must know exist — never a full tree.

## Replaced

One line: what this deleted or superseded, if anything.

## Updates (for existing ADRs only)

| Date         | Task  | Summary                              |
| ------------ | ----- | ------------------------------------ |
| {Month Year} | {NNN} | One-line description of what changed |
````

## Process Learnings (Instruction Delta)

The ADR tells future developers what the code decided. This tells future agents what to do
differently. Same pass, second audience.

### Input — read, don't recall

1. `.tasks/{task-folder}/plan/phase-*.md` → every `## Execution Notes` section. **Primary
   and preferred evidence** — Builder writes these while the friction happens.
2. `.tasks/{task-folder}/task.md` → the phase table's Notes column and any deviation notes.
3. Phase plans whose `## Verification` section proved insufficient — a manual-testing
   finding that no planned check would have caught is itself a learning about how plans
   get written.

**If there are no `## Execution Notes` anywhere, output "no process learnings" and stop.**
Do not reconstruct a retrospective from the diff or from memory. That is fabrication.

### Filter — what qualifies

A learning must be *generalizable* and *actionable*: one sentence must be able to complete
"next time, the instruction should say ___."

| Qualifies                                          | Does not                                       |
| -------------------------------------------------- | ----------------------------------------------- |
| An instruction was ambiguous and cost a retry      | A one-off bug in this task's code              |
| A convention exists that no instruction states     | A preference with no evidence behind it        |
| A verification step is routinely missing from plans | Anything already covered by an existing instruction |
| A recurring shape of mistake across phases         | A restatement of the ADR                       |

**At most 3 proposals per task.** More than three means the filter isn't being applied.

### Routing — by scope of the learning, not by a fixed path

| Scope of the learning                                              | Destination                                    | Notes                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A convention or non-obvious dependency of *this repository*        | `AGENTS.md` → `## Learned Patterns` table      | Same sink Explorer's Repository Patterns step uses. Create the section if absent.                                                 |
| Domain terminology / naming                                        | `CONTEXT.md` at workspace root                 | Read by Explorer and Builder                                                                                                      |
| A gap in how an **agent or skill** behaves                         | The instruction file that owns that behavior   | In a framework repo that is the template source of truth (never edit generated output; run its build+install after). In a consuming repo it is the user's own agent/skill files. |
| A gap in the *framework's* posture, not one agent's                | Note it for `docs/research/BACKLOG.md`         | Out of write scope — propose only                                                                                                 |

### Output — propose, never apply silently

```
📝 Process learnings from task {NNN}

1. [What happened] → [proposed instruction change]
   Evidence: .tasks/{slug}/plan/phase-N-*.md ## Execution Notes
   Destination: [file] → [section]

Apply these? [All] [Select] [None]
```

- Every proposal cites the `## Execution Notes` line it came from. **No citation, no
  proposal.**
- Nothing is written without confirmation.
- On confirmation, if a destination is a template source of truth, **run the build and
  install yourself** (in this framework repo: `make && ./install.sh`) before reporting
  completion — do not merely state that it is required.
- **"No process learnings this task" is a normal, expected, good outcome.** Do not pad to
  look useful.
- **Fast Path Mode:** when the invoking prompt says the task runs under Fast Path Mode, do
  **not** block for confirmation here. Return the proposal list unapplied and apply
  nothing; Conductor folds it into the final Delivery Report, where approval happens once.

## Guidelines

1. **Default to skip** — When any criterion is arguable, skip; an unnecessary ADR
   costs future readers more than a missing one
2. **High-level only** — Implementation details a reader can get from the code stay out
3. **Record the why** — Alternatives and trade-offs; the reasoning the code cannot show
4. **Code examples** — At most one, only for a genuinely new pattern
5. **Keep it scannable** — Bullets over paragraphs; a real decision fits in 40-60 lines

## After Saving

1. Update `docs/architecture/README.md` (create if missing with a decisions table)
2. Delete or archive the original task folder
3. If updating an existing ADR: add entry to the Updates table at the bottom
4. Report both outcomes: the ADR — created/updated (path and criterion met) or skipped
   (criterion); and the instruction delta — which instruction files were changed, or "no
   process learnings". When a template source of truth was changed on confirmation,
   confirm the build+install (`make && ./install.sh` here) was **run**, quoting its
   output — not that it is required. Under Fast Path Mode nothing was applied: report the
   pending proposal count instead, and note that build+install runs only if a
   template-targeted proposal is approved at the final Delivery Report.
