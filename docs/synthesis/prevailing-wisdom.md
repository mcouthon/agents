# Prevailing Wisdom in Agentic Coding Frameworks

> **AGENTS**: AI-Guided Engineering — Navigate → Think → Ship

Synthesized from: HumanLayer ACE, CursorRIPER, 12-Factor Agents, Awesome-Copilot, Anthropic Feature-Dev, Superpowers

---

## Executive Summary

After deep analysis of leading agentic coding frameworks, five core principles emerge:

1. **Phase-Based Workflows** - Distinct modes with permission boundaries
2. **Context Engineering** - Deliberate management of the context window
3. **Control Flow Ownership** - Own prompts, tools, and execution flow
4. **Human-in-the-Loop at Leverage Points** - Review plans, not code
5. **Focused Agents** - Small, single-purpose agents over monolithic ones

---

## 1. Phase-Based Workflows

### The Universal Pattern

Every major framework implements some variant of: **Research → Plan → Execute → Review**

| Framework | Phases                                        | Key Insight                                                      |
| --------- | --------------------------------------------- | ---------------------------------------------------------------- |
| ACE       | Research → Plan → Implement                   | "A bad line of plan could lead to hundreds of bad lines of code" |
| RIPER     | Research → Innovate → Plan → Execute → Review | Each mode has explicit permission matrix (read/write/create)     |
| 12-Factor | Implied through control flow ownership        | "Pause between tool selection and tool invocation"               |

### Permission Boundaries

- **Research Mode**: Read-only access. Explore, understand, but never modify.
- **Plan Mode**: Read + create plan documents. No code changes.
- **Execute Mode**: Full write access, but constrained to planned scope.
- **Review Mode**: Read + annotate. Verify, don't modify.

### Implementation Recommendation

Create distinct agent modes for each phase. Use tool restrictions to enforce boundaries:

```yaml
# explore.agent.md
tools: ['codebase', 'search', 'fetch', 'githubRepo', 'usages']  # Read-only tools

# implement.agent.md
tools: ['codebase', 'search', 'editFiles', 'runTests']  # Full access
```

### Clarifying Questions Phase (from Anthropic Feature-Dev)

Before planning, explicitly surface ambiguities:

- What remains unclear from research?
- What edge cases need clarification?
- What business logic needs human input?

Present specific, answerable questions and wait for answers before proceeding. Skip this step only if the request is purely descriptive or all ambiguities are resolved from code.

### Multiple Architecture Options (from Anthropic Feature-Dev)

When planning, present 2-3 approaches with trade-offs:

| Approach               | Description          | Trade-offs                 |
| ---------------------- | -------------------- | -------------------------- |
| **Minimal Changes**    | Fastest, lowest risk | May accumulate tech debt   |
| **Clean Architecture** | Most maintainable    | More refactoring required  |
| **Pragmatic Balance**  | Recommended default  | Balanced speed and quality |

Include recommendation with rationale. Wait for user choice before detailing the plan.

---

## 2. Context Engineering

### Core Principle (from ACE)

> "Frequent Intentional Compaction" - Design your workflow with context compaction in mind from the start.

### Key Guidelines

| Guideline                        | Source    | Rationale                                                         |
| -------------------------------- | --------- | ----------------------------------------------------------------- |
| Keep context at 40-60% capacity  | ACE       | Leaves room for tool outputs and reasoning                        |
| Own your context format          | 12-Factor | Custom XML/structures beat message arrays for information density |
| Unify execution + business state | 12-Factor | One source of truth simplifies recovery, forking, debugging       |
| Compact errors into context      | 12-Factor | Include failed attempts to prevent loops; limit to 2-3 retries    |

### Custom Context Formats (from 12-Factor Factor 3)

Instead of default message arrays, use structured formats:

```xml
<codebase_research>
  <file path="src/auth.py" summary="OAuth2 implementation with JWT tokens"/>
  <dependency name="pyjwt" version="2.8.0" usage="Token encoding/decoding"/>
</codebase_research>

<planned_changes>
  <change file="src/auth.py" type="modify" reason="Add refresh token support"/>
</planned_changes>
```

### Goal Drift Prevention (from Manus/planning-with-files)

After 15-50+ tool calls, original goals can drift from attention ("lost in the middle" effect). Combat this:

| Technique                    | How It Works                                       |
| ---------------------------- | -------------------------------------------------- |
| **Read-Before-Decide**       | Re-read plan/handoff before major decisions        |
| **Todo as Attention Anchor** | Frequent todo updates force goal re-statement      |
| **Periodic Re-Read**         | Every ~15 tool calls, re-read the original plan    |
| **Phase Boundaries**         | Natural breakpoints; re-state goals at phase start |

The key insight: updating working state (todos, progress) keeps goals in the attention window.

### Session Continuity

For memory and session continuity patterns (including task-centric persistence adopted by AGENTS), see [Memory and Session Continuity](./memory-and-continuity.md).

---

## 3. Control Flow Ownership

### The 12-Factor Principles

| Factor | Principle                    | Why It Matters                                  |
| ------ | ---------------------------- | ----------------------------------------------- |
| 2      | Own your prompts             | Don't outsource to framework black boxes        |
| 3      | Own your context window      | Custom formats > standard message formats       |
| 4      | Tools are structured outputs | Deterministic code decides execution            |
| 8      | Own your control flow        | Interrupt between tool selection and invocation |
| 10     | Small, focused agents        | 3-20 steps max; manageable context              |
| 12     | Stateless reducer            | Each step as pure function of (state, action)   |

### Key Implementation Pattern

```python
# Bad: Framework controls execution
agent.run(tools=[...])  # Black box

# Good: You control execution
next_step = llm.determine_next_step(context)
if next_step.needs_approval:
    await human_review(next_step)
result = execute(next_step)  # You decide how
context.append(result)
```

### Tool Call Philosophy

> "Just because an LLM called a tool doesn't mean you have to execute a specific corresponding function in the same way every time."

Tools are **structured output declarations**, not function calls. Your code decides:

- Whether to execute
- How to execute
- What to do with results
- When to pause for human review

---

## 4. Human-in-the-Loop at Leverage Points

### The ACE Insight

> "The highest leverage point is at the end of research and the beginning of the plan. A human can skim 30 seconds and provide a sentence of feedback that could save the agent hours of incorrect implementation."

### Where to Place Human Checkpoints

| Checkpoint           | Leverage             | Why                                                     |
| -------------------- | -------------------- | ------------------------------------------------------- |
| After Research       | 🔴 Very High         | Validate understanding before planning                  |
| After Plan           | 🔴 Very High         | Catch bad plans before they become bad code             |
| After Implementation | 🟡 Medium            | Code review, but damage already done if plan was bad    |
| Tool Approval        | 🟢 Context-dependent | High-stakes tools only (production data, external APIs) |

### Implementation Pattern

```yaml
# In agent mode, use handoffs for human review
handoffs:
  - label: "Review Research Findings"
    agent: plan
    prompt: "Review the research above and confirm direction before planning."
    send: false # Don't auto-submit; let human review
```

---

## 5. Review Quality (from Anthropic Feature-Dev)

### Confidence-Based Filtering

Rate potential issues on confidence (0-100) to reduce noise in reviews:

| Score  | Meaning                                           | Action                        |
| ------ | ------------------------------------------------- | ----------------------------- |
| 90-100 | Certain: Confirmed bug that will cause problems   | Report in Issues Found        |
| 70-89  | High: Very likely a real issue based on evidence  | Report in Issues Found        |
| 50-69  | Medium: Possibly intentional or context-dependent | Note without requiring action |
| 0-49   | Low: Uncertain; likely false positive             | Omit or brief mention         |

Only report issues with confidence ≥70% in the Issues Found section. Lower-confidence observations go in a Notes section without required action.

---

## 6. Focused, Single-Purpose Agents

### The Problem with Monolithic Agents

- Context bloat from unrelated information
- Unclear responsibilities lead to unpredictable behavior
- Difficult to debug when things go wrong
- One failure mode affects everything

### The Solution (from 12-Factor)

> "The magic number is probably 3-20 tool calls. If your agent regularly runs 50+ steps, consider breaking it up."

### Agent Specialization Examples

| Agent       | Purpose                    | Tools                       | Max Steps |
| ----------- | -------------------------- | --------------------------- | --------- |
| Researcher  | Understand codebase        | search, codebase, fetch     | 5-10      |
| Planner     | Create implementation plan | search, codebase (read)     | 3-5       |
| Implementer | Execute planned changes    | editFiles, runTests         | 10-20     |
| Reviewer    | Verify changes             | search, problems, runTests  | 5-10      |
| Tech Debt   | Identify/fix debt          | search, codebase, editFiles | 10-15     |

---

## 7. Code Protection (from RIPER)

### Protection Levels

Mark code with protection indicators:

| Level     | Marker | Meaning                                |
| --------- | ------ | -------------------------------------- |
| PROTECTED | `[P]`  | Never modify without explicit approval |
| GUARDED   | `[G]`  | Requires human review before changes   |
| DEBUG     | `[D]`  | Temporary code, remove before merge    |
| TEST      | `[T]`  | Test code, can modify freely           |

### Implementation

Add protection comments:

```python
# [P] Core authentication logic - do not modify without security review
def verify_token(token: str) -> Claims:
    ...
```

Agent modes should recognize and respect these markers.

---

## 8. VSCode Copilot Customization Hierarchy

### File Types and Locations

| File Type              | Extension                 | Location                                           | Purpose                              |
| ---------------------- | ------------------------- | -------------------------------------------------- | ------------------------------------ |
| Global Instructions    | `.instructions.md`        | `~/Library/Application Support/Code/User/prompts/` | Apply to all workspaces              |
| Workspace Instructions | `copilot-instructions.md` | `.github/`                                         | Apply to this workspace              |
| Targeted Instructions  | `*.instructions.md`       | `.github/instructions/`                            | Apply to matched files via `applyTo` |
| Agent Modes            | `*.agent.md`              | `.github/agents/` or user prompts folder           | Switchable personas                  |
| Prompt Files           | `*.prompt.md`             | `.github/prompts/`                                 | Reusable task prompts                |
| Cross-Agent            | `AGENTS.md`               | Workspace root                                     | Instructions for all AI agents       |

### Frontmatter Fields

**Instructions:**

```yaml
---
applyTo: "**/*.py" # Glob pattern
description: "Python coding standards"
---
```

**Agent Modes:**

```yaml
---
name: "Researcher"
description: "Deep codebase exploration without modifications"
tools: ["codebase", "search", "fetch", "githubRepo", "usages"]
model: "claude-sonnet-4" # Optional
handoffs:
  - label: "Create Plan"
    agent: planner
    prompt: "Based on the research above, create an implementation plan."
---
```

**Prompt Files:**

```yaml
---
name: "security-review"
description: "Perform security review of code"
agent: "ask" # or "edit", "agent", or custom agent name
tools: ["codebase", "search", "problems"]
---
```

---

## 9. Anti-Patterns to Avoid

### From Research Analysis

| Anti-Pattern                     | Why It's Bad                     | Better Approach                   |
| -------------------------------- | -------------------------------- | --------------------------------- |
| Jumping to code                  | Skips understanding and planning | Research → Plan → Execute         |
| Bare `except:`                   | Hides real errors                | Catch specific exceptions         |
| "// TODO: implement"             | Placeholder that never gets done | Implement or don't commit         |
| Repeating visible code           | Wastes context tokens            | Reference by path/line            |
| Generic advice                   | Not actionable                   | Specific, concrete guidance       |
| Summarizing before understanding | Loses important nuance           | Read fully first, then synthesize |
| Monolithic agents                | Context bloat, unpredictable     | Small, focused agents             |

### Code Generation Anti-Patterns (from Taming Copilot)

- ❌ Asking for "clean code" without defining what that means
- ❌ Expecting Copilot to infer project conventions
- ❌ Accepting first suggestion without verification
- ❌ Skipping tests to save time

---

## 10. Recommended Agent Modes

Based on synthesized patterns, these agent modes provide maximum coverage:

### Tier 1: Core Workflow

1. **Research** - Read-only exploration, no modifications
2. **Plan** - Create structured implementation plans
3. **Implement** - Execute planned changes with tests
4. **Review** - Verify changes, check for issues

### Tier 2: Specialized Tasks

5. **Tech Debt** - Identify and fix technical debt
6. **Debug** - Systematic bug investigation and fixing
7. **Architecture** - High-level design and documentation
8. **Mentor** - Teaching mode with Socratic questioning

### Tier 3: Utility

9. **Janitor** - Cleanup, simplification, dead code removal
10. **Critic** - Challenge assumptions, play devil's advocate

---

## 11. Skill Quality (from Superpowers)

### TDD for Documentation

Skills should be validated before deployment using a test-driven approach:

1. **RED**: Run a representative task WITHOUT the skill, note failures or suboptimal behavior
2. **GREEN**: Add the skill, run the same task, verify improvement
3. **REFACTOR**: If the agent rationalizes around the skill, strengthen the guidance

> If you didn't see it fail without the skill, you don't know if the skill helps.

### Skill Description Optimization

YAML `description` field should be optimized for discovery:

- ✅ Include trigger keywords ("debug", "failing test", "broken")
- ✅ Describe symptoms that activate the skill
- ❌ Don't summarize the workflow (agent may follow description instead of skill content)

### Progressive Disclosure

| Content Type       | Location        | Guideline                     |
| ------------------ | --------------- | ----------------------------- |
| Core instructions  | Main SKILL.md   | <500 lines                    |
| Reference material | Separate files  | APIs, syntax guides, examples |
| Code patterns      | Inline in skill | Only for illustration         |

Keep main skill files focused; split heavy reference material to avoid context bloat.

---

## 12. Key Quotes to Remember

> "Frequent Intentional Compaction" - ACE on context management

> "A bad line of plan could lead to hundreds of bad lines of code" - ACE on planning

> "Own your prompts. Own your context window. Own your control flow." - 12-Factor philosophy

> "Just because an LLM called a tool doesn't mean you have to execute it the same way every time" - 12-Factor on tool flexibility

> "Less Code = Less Debt. Deletion is the most powerful refactoring." - Janitor mode philosophy

> "The magic number is probably 3-20 tool calls" - 12-Factor on agent scope

---

## Source Material Reference

### Critical Sources (Fully Read)

- [HumanLayer ACE Framework](../sources/humanlayer/ace-fca.md) - Context engineering, workflow design
- [CursorRIPER Framework](../sources/cursorriper/) - RIPER modes, memory bank, protection levels
- [12 Factor Agents](../sources/12-factor-agents/) - Control flow, context ownership, focused agents
- [Anthropic Feature-Dev](../sources/repomirror/) - Clarifying questions, architecture options, confidence scoring
- [Superpowers](https://github.com/obra/superpowers) - Skill quality, TDD for documentation, progressive disclosure

### Important Sources (Fully Read)

- [Awesome Copilot Instructions](../sources/awesome-copilot/instructions/) - Instruction file patterns
- [Awesome Copilot Agent Modes](../sources/awesome-copilot/agents/) - Agent mode examples
- [VSCode Copilot Customization Docs](https://code.visualstudio.com/docs/copilot/customization/overview) - Official documentation

### Related Documents

- [Framework Comparison](./framework-comparison.md) - Detailed comparison of source frameworks
- [Memory and Session Continuity](./memory-and-continuity.md) - How AGENTS handles cross-session memory
