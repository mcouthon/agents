# Framework Comparison Matrix

Detailed comparison of key frameworks analyzed during Phase 1 research.

---

## Overview Comparison

| Aspect             | HumanLayer ACE                        | CursorRIPER                | 12-Factor Agents              |
| ------------------ | ------------------------------------- | -------------------------- | ----------------------------- |
| **Primary Focus**  | Context engineering for coding agents | Structured workflow modes  | Agent architecture principles |
| **Target IDE**     | IDE-agnostic (concepts)               | Cursor                     | IDE-agnostic (concepts)       |
| **Workflow Model** | Research → Plan → Implement           | RIPER (5 modes)            | Flexible, principle-based     |
| **Key Innovation** | Frequent Intentional Compaction       | Permission matrix per mode | Control flow ownership        |
| **Human-in-Loop**  | At research/plan boundaries           | Mode transitions           | Tool-level interruption       |

---

## Workflow Modes Comparison

### ACE Framework

| Phase     | Purpose                        | Human Involvement               |
| --------- | ------------------------------ | ------------------------------- |
| Research  | Deep codebase understanding    | Review findings before planning |
| Plan      | Create implementation strategy | Approve plan before execution   |
| Implement | Execute planned changes        | Review completed work           |

### CursorRIPER Framework

| Mode     | Symbol | Purpose                | Permissions        |
| -------- | ------ | ---------------------- | ------------------ |
| Research | 🔍 R   | Information gathering  | Read only          |
| Innovate | 💡 I   | Brainstorm solutions   | Read only          |
| Plan     | 📝 P   | Create structured plan | Read + create docs |
| Execute  | ⚙️ E   | Implement changes      | Full access        |
| Review   | 🔎 RV  | Verify and validate    | Read + annotate    |

### 12-Factor (Implied Workflow)

| Principle                 | Workflow Impact                |
| ------------------------- | ------------------------------ |
| Own control flow          | Pause/resume at any point      |
| Launch/pause/resume       | Explicit state management      |
| Contact humans with tools | Interrupt for approval         |
| Small focused agents      | Break complex work into phases |

---

## Context Management Comparison

| Aspect                  | ACE                   | RIPER              | 12-Factor                  |
| ----------------------- | --------------------- | ------------------ | -------------------------- |
| **Target Utilization**  | 40-60%                | Not specified      | Minimize bloat             |
| **Context Format**      | Custom (XML-like)     | Memory bank files  | Custom structured          |
| **Persistence**         | Per-phase files       | Memory bank system | Thread/state serialization |
| **Compaction Strategy** | Intentional summaries | Progress tracking  | Stateless reducer pattern  |

### Memory/State Approaches

**ACE: Phase-Based Files**

```
research_output.md → Plan input
plan.md → Implementation input
implementation_summary.md → Review input
```

**RIPER: Memory Bank System**

```
projectbrief.md      # Core requirements (rarely changes)
systemPatterns.md    # Established patterns
techContext.md       # Tech stack details
activeContext.md     # Current focus (frequently updated)
progress.md          # Task status tracking
protection.md        # Code protection markers
```

**12-Factor: Unified State**

```python
thread = {
    "events": [...],  # All tool calls, results, decisions
    "status": "...",  # Current execution state
}
# Business state + execution state unified
```

---

## Tool Philosophy Comparison

| Aspect                   | ACE                     | RIPER             | 12-Factor                               |
| ------------------------ | ----------------------- | ----------------- | --------------------------------------- |
| **Tool Restrictions**    | Implied by phase        | Explicit per mode | None enforced                           |
| **Tool Call Philosophy** | Standard function calls | Permission-gated  | "Structured output, not function calls" |
| **Execution Control**    | Framework-managed       | Mode-managed      | Developer-owned                         |

### 12-Factor Tool Call Pattern

```python
# Tool call is just structured output
next_step = llm.determine_next_step(context)

# You control what happens
if next_step.function == 'high_stakes_action':
    approval = await human_review(next_step)
    if not approval:
        return

result = execute(next_step)  # Your code, your rules
```

---

## Protection/Safety Comparison

| Aspect              | ACE                 | RIPER                     | 12-Factor                     |
| ------------------- | ------------------- | ------------------------- | ----------------------------- |
| **Code Protection** | Not explicit        | Explicit levels (P/G/D/T) | Via human approval            |
| **Guardrails**      | Human review points | Permission matrix         | Own your control flow         |
| **Error Handling**  | Not specified       | Not specified             | Compact errors, limit retries |

### RIPER Protection Levels

| Level     | Marker | Meaning                                |
| --------- | ------ | -------------------------------------- |
| PROTECTED | `[P]`  | Never modify without explicit approval |
| GUARDED   | `[G]`  | Requires careful review before changes |
| DEBUG     | `[D]`  | Temporary, remove before merge         |
| TEST      | `[T]`  | Test code, modify freely               |

---

## Human Interaction Comparison

| Aspect                  | ACE                        | RIPER                   | 12-Factor               |
| ----------------------- | -------------------------- | ----------------------- | ----------------------- |
| **Primary Checkpoint**  | After research, after plan | Mode transitions        | Any tool call           |
| **Approval Mechanism**  | Human reviews summaries    | Human selects next mode | Tool-level interruption |
| **Communication Style** | Markdown summaries         | Mode-specific outputs   | Structured requests     |

### Best Practice Synthesis

1. **Always** get human approval after research findings
2. **Always** get human approval before executing a plan
3. **Optionally** require approval for high-stakes tool calls
4. **Never** require approval for read-only operations

---

## Strengths & Weaknesses

### HumanLayer ACE

| Strengths                                    | Weaknesses                              |
| -------------------------------------------- | --------------------------------------- |
| ✅ Excellent context management guidance     | ❌ Less specific implementation details |
| ✅ Clear human checkpoint philosophy         | ❌ Cursor-focused examples              |
| ✅ "Frequent Intentional Compaction" concept | ❌ No tool restriction patterns         |
| ✅ High-leverage human review points         |                                         |

### CursorRIPER

| Strengths                          | Weaknesses                            |
| ---------------------------------- | ------------------------------------- |
| ✅ Explicit permission matrix      | ❌ Cursor-specific (needs adaptation) |
| ✅ Memory bank persistence pattern | ❌ Complex mode system                |
| ✅ Code protection markers         | ❌ Heavy upfront setup                |
| ✅ Clear mode transitions          |                                       |

### 12-Factor Agents

| Strengths                            | Weaknesses                          |
| ------------------------------------ | ----------------------------------- |
| ✅ Framework-agnostic principles     | ❌ More abstract, less prescriptive |
| ✅ Control flow ownership philosophy | ❌ Requires more custom code        |
| ✅ Flexible tool call handling       | ❌ No built-in workflow structure   |
| ✅ Small focused agent guidance      |                                     |

---

## Synthesis: Best of Each

### Adopt from ACE

- Frequent Intentional Compaction mindset
- 40-60% context utilization target
- Human review at research/plan boundaries
- Phase-based workflow structure

### Adopt from RIPER

- Explicit tool restrictions per mode
- Memory bank concept (adapted for Copilot)
- Code protection markers
- Clear mode transition points

### Adopt from 12-Factor

- Own your prompts (no black boxes)
- Own your context window (custom formats)
- Small, focused agents (3-20 steps)
- Compact errors into context (limit retries)

---

## Conflicts & Resolutions

### Conflict 1: Mode Complexity

- **RIPER**: 5 distinct modes with complex transitions
- **ACE**: 3 simpler phases
- **Resolution**: Use 4 core modes (Research/Plan/Execute/Review) with specialized agents for specific tasks

### Conflict 2: Context Persistence

- **RIPER**: Permanent memory bank files
- **12-Factor**: Unified state per thread
- **Resolution**: Use memory bank concept for project-level context, thread state for session-level

### Conflict 3: Tool Control

- **RIPER**: Framework controls via permission matrix
- **12-Factor**: Developer controls via code
- **Resolution**: Use Copilot's tool restrictions in agent modes (framework control) but maintain awareness that we're choosing this

### Conflict 4: Human Interaction Frequency

- **ACE**: Strategic checkpoints only
- **12-Factor**: Potentially any tool call
- **Resolution**: Strategic checkpoints (ACE style) for workflow phases; optional per-tool approval for high-stakes operations only
