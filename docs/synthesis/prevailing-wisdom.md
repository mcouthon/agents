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
# explorer.agent.md
tools: ['codebase', 'search', 'fetch', 'githubRepo', 'usages']  # Read-only tools

# builder.agent.md
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

| Guideline                        | Source     | Rationale                                                         |
| -------------------------------- | ---------- | ----------------------------------------------------------------- |
| Keep context at 40-60% capacity  | ACE, Ralph | Leaves room for tool outputs and reasoning                        |
| Own your context format          | 12-Factor  | Custom XML/structures beat message arrays for information density |
| Unify execution + business state | 12-Factor  | One source of truth simplifies recovery, forking, debugging       |
| Compact errors into context      | 12-Factor  | Include failed attempts to prevent loops; limit to 2-3 retries    |
| Subagent fan-out                 | Ralph      | Use main agent as scheduler; spawn subagents for heavy reads      |

### Subagent Fan-Out (from Ralph Wiggum)

Use the main agent context as a "scheduler" and spawn subagents for heavy file reading/searching:

- Each subagent gets its own context that's garbage collected after completion
- Main agent receives only the subagent's summary, not all file contents
- Enables investigating 3+ independent areas without bloating main context
- "Subagents as memory extension" - fan out to avoid polluting main context

### Retrieval Over Recall (from Vercel Evals)

> "Prefer retrieval-led reasoning over pre-training-led reasoning"

Agents trained on older data will generate outdated patterns. Combat this by:

- **Read actual files** before suggesting patterns—don't assume you know the codebase
- **Check config files** rather than guessing structure or defaults
- **Trace imports and dependencies** rather than relying on training knowledge
- **Consult existing code** to match project conventions

Vercel's evals showed 100% pass rate with docs available in context vs 53% baseline. The key: passive context (always available) beats on-demand retrieval (agent must decide to look it up).

**Horizontal vs Vertical Context:**

| Type           | Mechanism          | Use For                                      |
| -------------- | ------------------ | -------------------------------------------- |
| **Horizontal** | AGENTS.md          | Always-on baseline context, project patterns |
| **Vertical**   | Skills (on-demand) | Explicit workflows users trigger             |

Our skills use explicit triggers ("use debug mode") to avoid the 56% non-invocation rate Vercel observed with agent-decided skill loading.

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

### Single-Purpose Interactions (from Claude Code Mastery)

Research shows significant degradation when mixing topics:

| Finding                 | Impact                                    |
| ----------------------- | ----------------------------------------- |
| Multi-turn topic mixing | 39% performance drop                      |
| Context rot             | Recall decreases as context grows         |
| Early context pollution | 2% misalignment early → 40% failure later |

**Implications for AGENTS:**

- Phase-based workflow naturally enforces single-purpose interactions
- Each agent (Explorer, Builder, Reviewer, Committer) has one clear purpose
- Subagent fan-out keeps each context focused on one investigation

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

### Advisory vs Enforcement (from Claude Code Mastery)

Instruction files (CLAUDE.md, agent definitions, skills) are **advisory**—the LLM weighs them against other context and may override them. For **deterministic enforcement**, use platform-level mechanisms:

| Mechanism             | Type        | Reliability                          |
| --------------------- | ----------- | ------------------------------------ |
| Instructions          | Advisory    | Can be overridden under pressure     |
| **Hooks**             | Enforcement | Always executes (exit code 2 blocks) |
| **Tool restrictions** | Enforcement | Agent can't use restricted tools     |

AGENTS uses tool restrictions (VS Code agent `tools` field) for enforcement of phase boundaries. For additional enforcement (e.g., blocking secrets access), users should implement platform-specific hooks.

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

### Backpressure via Tests (from Ralph Wiggum)

Tests, typechecks, and lints serve as "gates" that reject invalid work:

- Prompt says "run tests" generically; configuration specifies actual commands
- Failed tests force the agent to fix issues before proceeding
- Creates natural iteration loop: implement → test → fix → test
- Backpressure extends beyond code: LLM-as-judge can validate subjective criteria

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

## 7. VSCode Copilot Customization

VS Code provides multiple customization layers. Key file types:

| File Type              | Location                   | Purpose                              |
| ---------------------- | -------------------------- | ------------------------------------ |
| Global Instructions    | `~/.copilot/instructions/` | Apply to all workspaces              |
| Workspace Instructions | `.github/`                 | Apply to this workspace              |
| Agent Modes            | `.github/agents/`          | Switchable personas with tool limits |
| Cross-Agent            | `AGENTS.md`                | Instructions for all AI agents       |

**Key frontmatter (agents):**

```yaml
tools: ["codebase", "search"] # Tool restrictions
handoffs: [...] # Phase transitions
agents: ["Explorer"] # Subagent whitelist (1.109+)
```

For detailed settings and frontmatter reference, see [vscode-platform.md](./vscode-platform.md).

---

## 8. Skill-Powered Subagents

Agents invoke skills by spawning subagents with skill trigger keywords. This combines skill expertise with context isolation—subagent context is garbage-collected, returning only summaries.

### Agent → Skill Pairings

| Agent    | Skill        | When to Invoke                                         |
| -------- | ------------ | ------------------------------------------------------ |
| Explorer | architecture | Understanding system structure, high-level design      |
| Builder  | debug        | Tests failing, unexpected errors during implementation |
| Reviewer | critic       | Stress-testing approach, finding edge cases            |
| Reviewer | tech-debt    | Scanning for code smells, dead code, cleanup needs     |

For invocation patterns and adding new pairings, see [ADR-004](../architecture/ADR-004-skill-powered-subagents.md).

---

## 9. Orchestration Pattern

The Conductor agent coordinates specialized agents without doing work directly:

| Agent          | Role             | Scope                      |
| -------------- | ---------------- | -------------------------- |
| **Conductor**  | Coordinates      | Reads state, spawns agents |
| **Explorer**   | Research + Plan  | Read + .tasks/ write       |
| **Builder**    | Execute changes  | Full access                |
| **Reviewer**   | Verify quality   | Read + tests               |
| **Committer**  | Semantic commits | Git + read                 |
| **Researcher** | Context-isolated | Read + web (internal)      |

Human-in-the-loop at leverage points: after task creation, after phase planning, after implementation, before commit.

For detailed orchestration patterns and evolution, see [ADR-001](../architecture/ADR-001-orchestration-and-subagents.md).

---

## 10. Anti-Patterns to Avoid

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

## 11. AGENTS Framework Structure

### Core Agents (User-Invokable)

| Agent         | Purpose                       | Tool Access       |
| ------------- | ----------------------------- | ----------------- |
| **Conductor** | Automate multi-phase workflow | Read + Agent      |
| **Explorer**  | Research + create plans       | Read + Task Write |
| **Builder**   | Execute planned changes       | Full access       |
| **Reviewer**  | Verify implementation quality | Read + Test       |
| **Committer** | Create semantic commits       | Git + Read        |

### Internal Agents (Not User-Invokable)

| Agent          | Purpose                  | Used By             |
| -------------- | ------------------------ | ------------------- |
| **Researcher** | Context-isolated reading | Conductor, Explorer |

### Skills (Auto-Activate)

Skills provide specialized capabilities without needing agent switches:

- `debug` — Hypothesis-driven investigation
- `tech-debt` — Code smell detection, cleanup
- `architecture` — System structure documentation
- `mentor` — Socratic teaching
- `critic` — Adversarial probing

---

## 12. Skill Quality

### TDD for Documentation

Skills should be validated before deployment:

1. **RED**: Run task WITHOUT skill, note failures
2. **GREEN**: Add skill, verify improvement
3. **REFACTOR**: If agent rationalizes around skill, strengthen guidance

### Description Optimization

- ✅ Include trigger keywords ("debug", "failing test", "broken")
- ✅ Describe symptoms that activate the skill
- ❌ Don't summarize workflow (agent may follow description instead of skill content)

For the full evaluation checklist, see [skills.md](./skills.md).

---

## Source Material Reference

### Critical Sources (Fully Read)

- [HumanLayer ACE Framework](../sources/humanlayer/ace-fca.md) - Context engineering, workflow design
- [CursorRIPER Framework](../sources/cursorriper/) - RIPER modes, memory bank
- [12 Factor Agents](../sources/12-factor-agents/) - Control flow, context ownership, focused agents
- [Anthropic Feature-Dev](../sources/repomirror/) - Clarifying questions, architecture options, confidence scoring
- [Superpowers](https://github.com/obra/superpowers) - Skill quality, TDD for documentation, progressive disclosure

### Important Sources (Fully Read)

- [Awesome Copilot Instructions](../sources/awesome-copilot/instructions/) - Instruction file patterns
- [Awesome Copilot Agent Modes](../sources/awesome-copilot/agents/) - Agent mode examples
- [VSCode Copilot Customization Docs](https://code.visualstudio.com/docs/copilot/customization/overview) - Official documentation
- [Claude Code Mastery](https://github.com/TheDecipherist/claude-code-mastery) - Advisory vs enforcement, single-purpose chats

### Related Documents

- [Framework Comparison](./framework-comparison.md) - Detailed comparison of source frameworks
- [Memory and Session Continuity](./memory-and-continuity.md) - How AGENTS handles cross-session memory
