---
name: consolidate-task
description: "Use when a task in .tasks/ is complete and should be summarized into an architectural decision record (ADR) in docs/architecture/. Determines whether an ADR is needed, updates existing ADRs when appropriate, and cleans up the original task folder. Triggers on: 'use consolidate-task mode', 'consolidate-task', 'consolidate task', 'summarize task', 'archive task', 'create ADR', 'task is done'."
allowed-tools: "Read, Edit, Write, Grep, Glob"
---

# Summarize Task to Architectural Decision Record

Read the task file at `.tasks/{task-folder}/task.md` and create an architecture decision summary.

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
