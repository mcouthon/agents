# Rationalization Prevention Tables

**Source:** Task 040 (March 2026)

## Decision

Embed structured "Rationalization Prevention Tables" in agent and skill templates to counter LLM tendencies to skip critical steps.

## Why

- LLMs rationalize shortcuts ("tests pass" without running them, "looks fine" without reading diffs)
- Structured tables pattern-match against the agent's reasoning in-flight
- Explicit `| Excuse | Reality | Required Action |` format forces correct behavior
- Tables are scannable and unambiguous — better than prose warnings
- Derived from obra/Superpowers and trailofbits/skills frameworks

## Problem Statement

Agents skip verification steps by generating plausible-sounding excuses:

| Behavior                        | Actual Problem                                 |
| ------------------------------- | ---------------------------------------------- |
| "Tests pass"                    | Never ran the tests                            |
| "The code looks fine"           | Skimmed without reading diffs                  |
| "Changes are small, quick LGTM" | Missed subtle bugs in "small" changes          |
| "I'll verify later"             | Later never comes in single-turn agent context |

These rationalizations are hard to catch because they sound reasonable.

## Solution

### Before

Prose instructions like "make sure to run tests" that agents skip when optimizing for speed.

### After

Structured tables embedded in templates that trigger when reasoning matches an excuse pattern:

```markdown
| Excuse                                | Reality                                  | Required Action                          |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| "Tests pass" (without showing output) | Claiming without evidence is fabrication | Run the command, paste the actual output |
| "The code looks fine"                 | You haven't run automated checks yet     | Run tests, types, lint — show the output |
```

## Implementation

| Phase | What Changed                                   |
| ----- | ---------------------------------------------- |
| 1     | Drafted 46 rows across 8 tables                |
| 2     | Added tables to 3 skill templates (-58 lines)  |
| 3     | Added tables to 5 agent templates (-110 lines) |
| 5     | Updated CHANGELOG and synthesis documentation  |

## Key Architectural Patterns

### Table Format

All prevention tables use the same 3-column format:

```markdown
| Excuse               | Reality                 | Required Action                 |
| -------------------- | ----------------------- | ------------------------------- |
| "Plausible shortcut" | Why it's actually wrong | Specific action to take instead |
```

### Net-Zero Text Principle

For every table added, existing content must be trimmed to offset the growth:

1. Measure line count before/after
2. Identify trim candidates (verbose prose, redundant examples, duplicate rules)
3. Target net-zero or net-negative growth

### Coverage

| Template  | Rows | Key Excuses Blocked                                       |
| --------- | ---- | --------------------------------------------------------- |
| builder   | 6    | Skip tests, skip verification, claim without evidence     |
| reviewer  | 6    | Shallow review, trust without verify, miss edge cases     |
| explorer  | 6    | Incomplete research, skip test guidance, unsaved findings |
| committer | 5    | Bundle commits, short messages, force-push                |
| conductor | 5    | Self-delegate, skip checkpoints, skip plans               |
| debug     | 6    | Guess-driven fixes, skip hypothesis testing               |
| testing   | 6    | Skip tests for small changes, "tests later"               |
| tech-debt | 5    | Keep dead code, defer cleanup, don't touch working code   |

## Current Structure

```
templates/
├── agents/
│   ├── builder.template.md      # 6-row table
│   ├── reviewer.template.md     # 6-row table
│   ├── explorer.template.md     # 6-row table
│   ├── committer.template.md    # 5-row table
│   └── conductor.template.md    # 5-row table
└── skills/
    ├── debug/SKILL.template.md      # 6-row table (merged with existing)
    ├── testing/SKILL.template.md    # 6-row table
    └── tech-debt/SKILL.template.md  # 5-row table
```

## Research Source

Documented in [docs/synthesis/skills.md](../synthesis/skills.md):

> **Rationalization Prevention Tables** (obra/trailofbits)
>
> - `| Excuse | Reality | Required Action |` format
> - Explicit counters to agent shortcuts
