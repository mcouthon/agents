---
name: clarify
description: "Bounded clarification/refinement pass for planning. Use before finalizing a phased plan when unresolved [?] markers or plan-changing ambiguity remain. Triggers on: 'use clarify mode', 'clarify', 'clarify the plan', 'resolve ambiguity', 'clarifying questions'."
---

# Clarify Mode — Bounded Refinement Pass

Run this pass **before finalizing the phased plan** (Step 6) to resolve plan-changing
ambiguity. Work high-level → detailed. This is the single sanctioned place to raise
questions — bounded, not a gate.

## When to skip (opt-out)

Skip entirely and proceed to phasing when:

- No unresolved `[?]` markers AND a single clear interpretation exists, OR
- Open `[?]` markers are present but do not change the plan materially

The ≤5 cap is a ceiling, never a target. Fewer is better.

## Two delivery modes

**Determine which mode you are in before proceeding:**

- **Subagent (spawned by the Conductor or another agent):** you CANNOT prompt the user
  directly. Return your plan draft and append an `## Open clarifying questions` block
  (format below). Do NOT try to ask interactively.
- **Direct invocation (user ran you directly):** ask the user via conversational turns,
  one question at a time where an answer informs the next.
- **If unsure which mode you are in, assume subagent and return questions.**

## How to run the pass

1. Collect plan-changing ambiguities — prefer existing `[?]` markers over new ones.
2. Ask ≤5 targeted questions, highest-impact first.
3. Where an answer to one question informs another, ask one at a time (in sequence).
   Batch only mutually independent questions.
4. Stop early once unambiguous — never force 5 questions.
5. Record each answer and clear the matching `[?]` marker.
6. Finalize and save.

## `## Open clarifying questions` block format (subagent mode)

Append this block to your return after the plan draft:

```
## Open clarifying questions
1. [highest-impact question] — affects: [what part of the plan]
2. [next question, if independent of #1]
```

## Recording format (`task.md`)

Add a dated `## Clarifications` subsection under **Research Findings** before the phase
table is finalized:

```
## Clarifications

### YYYY-MM-DD
- Q: [question] → A: [user's answer]
- Q: [deferred question] → Assumed: [assumption made], no answer given
```

For deferred or unanswered items, record the assumption explicitly. Never silently
guess a plan-changing ambiguity — record it so the Builder and Reviewer can see it.
