---
name: consolidate-task
description: "Use when you need to consolidate a completed task into an architectural decision record and a proposed instruction delta for future agents, reducing clutter in .tasks/. Triggers on: 'use consolidate-task mode', 'consolidate-task', 'consolidate task', 'summarize task', 'retrospective', 'what did we learn', 'compound learnings'."

cc:
  allowed-tools: [Read, Edit, Write, Grep, Glob]
---

# Consolidate a Completed Task

One pass over `.tasks/{task-folder}/` produces up to two outputs:

| Output               | Audience          | Question                            | Destination                                 |
| -------------------- | ----------------- | ----------------------------------- | ------------------------------------------- |
| Architectural record | future developers | What did the code decide?           | `docs/architecture/ADR-NNN-*.md`            |
| Instruction delta    | future agents     | What should agents do differently?  | routed by scope — see Process Learnings     |

Each is independently skippable. Most tasks produce one; some produce neither. Read
`.tasks/{task-folder}/task.md` for the architectural record, and the phase plans for the
instruction delta.

## When to Create an ADR

Not every completed task needs an ADR. ADRs document **architectural decisions**, not implementation work.

**Skip ADR entirely when:**

- Task adds a minor feature within existing patterns
- Task fixes bugs or refines implementation details
- Task is routine maintenance or cleanup
- Changes follow conventions already documented elsewhere

**Update existing ADR when:**

- Task extends or modifies patterns documented in a prior ADR
- Task adds significant new component to an existing architectural area
- Changes affect how future developers should approach that area

**Create new ADR when:**

- Task introduces new architectural patterns
- Task reverses or significantly modifies a prior decision
- Task establishes new conventions for the codebase

When updating, add an entry to the "Updates" table and integrate changes into relevant sections.

## File Naming

**Required format:** `ADR-NNN-{decision-name}.md`

1. Scan `docs/architecture/` for existing `ADR-*` files
2. Check if any existing ADR covers the same architectural area (update if so)
3. For new ADRs: find the highest number (e.g., `ADR-003-*` → next is `004`)
4. Start at `001` if no ADR files exist
5. Save to: `docs/architecture/ADR-NNN-{decision-name}.md`

Example: `ADR-004-unified-query-execution.md`

## Output Format

````markdown
# {Decision Title}

**Source:** Task {NNN} ({Month Year})

## Decision

One sentence describing the high-level architectural choice.

## Why

- Bullet points explaining the motivation
- Focus on problems solved, not implementation details

## Problem Statement (if applicable)

What issue prompted this change? What was broken or suboptimal?

## Solution

Brief description with before/after comparison:

### Before

{Old approach - can include diagrams or code}

### After

{New approach - can include diagrams or code}

## Implementation Phases

| Phase     | What Changed       |
| --------- | ------------------ |
| 1. {Name} | {One-line summary} |
| ...       | ...                |

## Key Architectural Patterns

Include 2-3 code snippets showing the most important patterns established.
Only patterns that future developers need to understand and follow.

## Current Structure

```
relevant/directory/
├── file1.py # Brief purpose
├── file2.py # Brief purpose
```

## Deleted

- List of deleted files/code (shows what was replaced)

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

1. **High-level only** — Skip implementation details that don't affect architecture
2. **Focus on patterns** — What should future code follow?
3. **Include deletions** — Shows what was replaced, not just what was added
4. **Code examples** — Only for patterns that repeat across the codebase
5. **Keep it scannable** — Tables and bullets over paragraphs

## After Saving

1. Update `docs/architecture/README.md` (create if missing with a decisions table)
2. Delete or archive the original task folder
3. If updating an existing ADR: add entry to the Updates table at the bottom
4. Report the instruction delta outcome: which instruction files were changed, or "no
   process learnings". When a template source of truth was changed on confirmation,
   confirm the build+install (`make && ./install.sh` here) was **run**, quoting its
   output — not that it is required. Under Fast Path Mode nothing was applied: report the
   pending proposal count instead, and note that build+install runs only if a
   template-targeted proposal is approved at the final Delivery Report.
