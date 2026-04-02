# Skill-Powered Subagents

**Source:** RDR-027 (via skills-methodology.md), February 2026

## Decision

Agents invoke skills via subagents by including skill trigger keywords in prompts. This combines skill expertise with context isolation.

## Why

- Context isolation: subagent findings don't bloat main context
- Specialized behavior: skills fundamentally change how an agent operates
- Progressive loading: skill discovery happens in isolated context
- Composability: any agent can use any skill via subagent prompt
- Garbage collection: subagent context is discarded after returning summary

## Problem Statement

Skills auto-activate based on keywords in the user's request. But what about agent-to-agent communication?

| Scenario                               | Problem                                               |
| -------------------------------------- | ----------------------------------------------------- |
| Inline skill activation                | All findings stay in main context, consuming capacity |
| Some explorations are throwaway        | Shouldn't persist or pollute parent context           |
| Different agents need different skills | No mechanism for agent → skill → agent flow           |
| Parent context bloat                   | Long debug sessions fill context with hypotheses      |

Skills provide specialized behavior (debug methodology, architecture analysis, Socratic mentoring), but loading them inline adds to the main context window.

## Solution

### Pattern: Agent → Skill via Subagent Prompt

```markdown
# Explorer invoking architecture skill

Run the Researcher agent as a subagent: Use architecture mode to analyze
the payment system. Document high-level design and data flow.
Return: Component overview and dependency map.
```

```markdown
# Builder invoking debug skill when tests fail

Run the Builder agent as a subagent: Debug this failing test.
Use systematic hypothesis-driven investigation to trace the root cause.
Return: Root cause analysis, hypotheses tested, and recommended fix.
```

The subagent inherits the skill (via trigger keywords), executes with specialized behavior, and returns only the summary. Parent context stays lean.

### Factor Comparison

| Factor         | Inline Skill                      | Subagent + Skill                   |
| -------------- | --------------------------------- | ---------------------------------- |
| Context impact | All findings stay in main context | Subagent context garbage-collected |
| Focus          | Mixed with other agent concerns   | Pure skill mode operation          |
| Output         | Full reasoning visible            | Summary only returned              |
| Control        | Auto-triggered by keywords        | Agent decides when to invoke       |
| Capacity       | Consumes parent context           | Isolated context window            |

### Common Agent → Skill Pairings

| Agent    | Skill         | Trigger Scenario                        |
| -------- | ------------- | --------------------------------------- |
| Explorer | architecture  | Understanding system structure          |
| Explorer | deep-research | Exhaustive investigation with citations |
| Builder  | debug         | Tests failing during implementation     |
| Builder  | mentor        | Learning while implementing             |
| Reviewer | critic        | Stress-testing implementation           |
| Reviewer | tech-debt     | Code quality and smell detection        |
| Reviewer | security      | Attack surface analysis                 |

### Subagent Prompt Structure

```markdown
Run the [Builder|Researcher] agent as a subagent: [Skill trigger phrase].
[Specific task description with context].
Return: [What the parent agent needs back].
```

**Key elements:**

1. **Agent choice:** Builder (full access) or Researcher (read-only)
2. **Skill trigger:** Keywords that activate the relevant skill
3. **Context:** What the subagent needs to know
4. **Return spec:** What comes back to parent (keeps it lean)

## Key Insights

Subagents act as "skill invokers"—by crafting prompts with skill trigger keywords, agents get specialized behavior without bloating their own context.

The skill's progressive loading (discovery → instructions → resources) happens in the subagent's isolated context. When the subagent completes, only the summary returns to the parent. All intermediate reasoning, hypotheses, and exploration are garbage-collected.

This pattern enables deep specialization (multi-phase debugging, exhaustive research) without sacrificing parent context capacity.

## See Also

- [skills.md](../synthesis/skills.md) — Skill creation and testing
- [ADR-001](ADR-001-orchestration-and-subagents.md) — Subagent architecture
- [prevailing-wisdom.md](../../docs/synthesis/prevailing-wisdom.md) — Skill evaluation criteria
