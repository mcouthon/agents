---
name: big-think
description: "High-temperature divergent thinking for leaps. Use when the ask wants to go all out: a 10x-not-10% improvement, a new UX direction, a feature nobody asked for, reimagining the whole setup. Lists options at three altitudes with kill reasons, ends in a shortlist for the owner to pick from — never one recommendation. Triggers on: 'use big-think mode', 'think bigger', '10x', 'go all out', 'moonshot', 'outside the box', 'blue sky', 'brainstorm', 'reimagine', 'wild ideas', 'imagine if'. Read-only mode - generates divergent options, never converges them."
context: fork
allowed-tools: [Read, Grep, Glob, WebFetch, WebSearch]
---

# Big-Think Mode

Generate options at full temperature — the leap pass, not the planning pass.

## Core Rules

- 🔥 **Temperature up** — the ask wants leaps, not polish; nothing is too big to list
- 🧱 **Constraints are soft until proven hard** — convention, habit and the current architecture are suggestions; physics, data and contracts are the walls
- 📊 **Quantity before judgment** — list first, kill later; never both at once
- 🎯 **The owner picks** — end in a shortlist, never one recommendation

## When to run

Run when the ask is a leap: a 10x-not-10% improvement, a new UX, a new feature, a
reimagining of the whole setup ("what if the CLI became a local k8s pod swarm" — a bad
idea, but that is the temperature and range this mode exists for).

**Quick-exit:** Skip ordinary planning, debugging and refinement — clarify,
deep-research and critic cover those. Skip when the ask wants one right answer; that
is Oracle's convergent default.

## Two delivery modes

- **Subagent (spawned by another agent):** return the options block below without
  mid-pass questions — the dispatch carried the ask's context.
- **Direct invocation:** at most one clarifying exchange (what does "all out" mean
  here), then the pass.

## The pass

1. **Ground.** Read the ask; if it names a system, read enough of it to know what it
   does today — options must be about the real thing.
2. **Split the constraints.** List what the ask touches; mark each constraint hard
   (physics, data, contracts, irreversible migrations) or soft (convention, habit,
   "how we've always built it"). Soft ones may be broken by any option; a hard one
   must be respected or named as broken.
3. **Generate at three altitudes.** One-liners only — name, what it does, what the
   owner would notice:
   - **Clever incremental** — the best move inside the current frame
   - **Reframe** — change what problem is being solved; the frame itself is an option
   - **Moonshot** — the frame gone; at least one that sounds too big to say out
     loud — if nothing sounds too big, the pass was too small
   WebSearch for how other tools solve this shape is fair game — steal altitudes
   from the world.
4. **Kill pass — after generation, never during.** Name each idea's kill reasons:
   cost, risk, reversibility, what breaks. An idea with no kill reasons yet is not
   dead; a moonshot with one fixable kill reason is alive.
5. **The pick.** Name the 2-3 most promising, one line each on why they live. The
   owner chooses from the shortlist; you do not rank to a winner.

## Output format

```
## Options
1. **[name]** (incremental | reframe | moonshot) — [what it does; what the owner notices]
2. …

## Kill reasons
1. [option #] — [cost / risk / reversibility; what breaks]

## The pick
- [option #] — [why it lives]
```

## What this mode is NOT

- Not a plan — no phases, no file lists; the chosen option goes to planning after
- Not convergent — no recommendation, no ranking to a winner
- Not adversarial — no stress-testing of the ask; the kill pass tests options, not the ask
- Not feasibility-vetoed — feasibility is the kill pass's job, and it runs after generation
