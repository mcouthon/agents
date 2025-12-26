# Activation Test Scenarios

Manual test scenarios to verify agents and skills activate correctly.

## How to Test

### Custom Agents

1. Open the **agent picker dropdown** in VS Code
2. Select the agent
3. Verify the agent loads and has correct tool access

### Agent Skills

1. Start a new Copilot chat session
2. Say the prompt naturally
3. Verify the expected skill activates (check skill name in response or behavior)

---

## Custom Agents (Select from Dropdown)

These agents appear in the agent picker and have **enforced tool access**.

| Agent       | Purpose                       | Tool Restrictions          |
| ----------- | ----------------------------- | -------------------------- |
| `Research`  | Deep codebase exploration     | Read-only (no editFiles)   |
| `Plan`      | Create implementation plans   | Read-only (no editFiles)   |
| `Implement` | Execute planned changes       | Full access                |
| `Review`    | Verify implementation quality | Read + Test (no editFiles) |

### Agent Handoff Tests

| Agent       | Expected Handoff Button                  |
| ----------- | ---------------------------------------- |
| `Research`  | "Create Plan" → Plan agent               |
| `Plan`      | "Start Implementation" → Implement agent |
| `Implement` | "Review Changes" → Review agent          |
| `Review`    | (none - workflow complete)               |

---

## Agent Skills (Auto-Activate)

These skills activate automatically based on prompt keywords.

### Explicit Mode Switching

| Prompt                  | Expected Skill |
| ----------------------- | -------------- |
| "use debug mode"        | `debug`        |
| "use tech-debt mode"    | `tech-debt`    |
| "use architecture mode" | `architecture` |
| "use mentor mode"       | `mentor`       |
| "use janitor mode"      | `janitor`      |
| "use critic mode"       | `critic`       |

---

## Utility Skills (Auto-Activate)

### debug

| Prompt                      | Expected              |
| --------------------------- | --------------------- |
| "why is this test failing?" | Debug skill activates |
| "investigate this error"    | Debug skill activates |
| "this is broken"            | Debug skill activates |

### tech-debt

| Prompt                       | Expected                  |
| ---------------------------- | ------------------------- |
| "find TODOs in the codebase" | Tech-debt skill activates |
| "identify code smells"       | Tech-debt skill activates |
| "technical debt audit"       | Tech-debt skill activates |

### architecture

| Prompt                             | Expected                     |
| ---------------------------------- | ---------------------------- |
| "document the system architecture" | Architecture skill activates |
| "create a component diagram"       | Architecture skill activates |
| "high-level overview"              | Architecture skill activates |

### mentor

| Prompt                               | Expected               |
| ------------------------------------ | ---------------------- |
| "teach me how this works"            | Mentor skill activates |
| "help me understand the pattern"     | Mentor skill activates |
| "don't give me the answer, guide me" | Mentor skill activates |

### janitor

| Prompt                  | Expected                |
| ----------------------- | ----------------------- |
| "clean up dead code"    | Janitor skill activates |
| "remove unused imports" | Janitor skill activates |
| "simplify this code"    | Janitor skill activates |

### critic

| Prompt                           | Expected               |
| -------------------------------- | ---------------------- |
| "challenge this approach"        | Critic skill activates |
| "what could go wrong?"           | Critic skill activates |
| "find weaknesses in this design" | Critic skill activates |

---

## Disambiguation Tests

These test that overlapping phrases go to the right skill.

| Prompt               | Expected  | NOT           |
| -------------------- | --------- | ------------- |
| "fix this bug"       | `debug`   | NOT janitor   |
| "simplify this code" | `janitor` | NOT tech-debt |
| "clean up the code"  | `janitor` | NOT tech-debt |
| "remove dead code"   | `janitor` | NOT tech-debt |

---

## Core Workflow vs Skill

| Goal                        | Use                          |
| --------------------------- | ---------------------------- |
| Research → Plan → Implement | **Custom Agents** (dropdown) |
| Quick debugging session     | **Skill** (auto-activates)   |
| Want enforced read-only     | **Custom Agent**             |
| Just need a methodology     | **Skill**                    |

---

## Last Tested

Date: \_**\_
Tester: \_\_**
Results: [ ] All pass / [ ] Issues found (see notes)

Notes:
