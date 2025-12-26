# Skill Activation Test Scenarios

Manual test scenarios to verify skills activate correctly.

## How to Test

1. Start a new Copilot chat session
2. Say the prompt
3. Verify the expected skill activates (check skill name in response or behavior)

---

## Explicit Mode Switching

These should ALWAYS activate the correct skill.

| Prompt                  | Expected Skill      |
| ----------------------- | ------------------- |
| "use research mode"     | `research-codebase` |
| "use plan mode"         | `create-plan`       |
| "use implement mode"    | `implement-plan`    |
| "use review mode"       | `review-code`       |
| "use debug mode"        | `debug`             |
| "use tech-debt mode"    | `tech-debt`         |
| "use architecture mode" | `architecture`      |
| "use mentor mode"       | `mentor`            |
| "use janitor mode"      | `janitor`           |
| "use critic mode"       | `critic`            |

---

## Core Workflow Skills

### research-codebase

| Prompt                               | Expected                 |
| ------------------------------------ | ------------------------ |
| "how does the auth system work?"     | Research skill activates |
| "explore the codebase"               | Research skill activates |
| "trace the flow of data from X to Y" | Research skill activates |

### create-plan

| Prompt                                 | Expected             |
| -------------------------------------- | -------------------- |
| "create a plan to add notifications"   | Plan skill activates |
| "I want to add OAuth support"          | Plan skill activates |
| "how should I implement this feature?" | Plan skill activates |

### implement-plan

| Prompt               | Expected                  |
| -------------------- | ------------------------- |
| "implement the plan" | Implement skill activates |
| "execute phase 1"    | Implement skill activates |
| "start coding"       | Implement skill activates |

### review-code

| Prompt                    | Expected               |
| ------------------------- | ---------------------- |
| "review my changes"       | Review skill activates |
| "is this ready to merge?" | Review skill activates |
| "code review"             | Review skill activates |

---

## Utility Skills

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

| Prompt               | Expected                    | NOT               |
| -------------------- | --------------------------- | ----------------- |
| "fix this bug"       | `debug` (investigate first) | NOT `create-plan` |
| "simplify this code" | `janitor`                   | NOT `tech-debt`   |
| "clean up the code"  | `janitor`                   | NOT `tech-debt`   |
| "remove dead code"   | `janitor`                   | NOT `tech-debt`   |

---

## Workflow Handoff Tests

Verify skills guide to the next step correctly.

| Scenario               | Expected Behavior                        |
| ---------------------- | ---------------------------------------- |
| Debug finds root cause | Ends with "Create a plan to fix [issue]" |
| Plan is complete       | Ends with "Implement the plan"           |
| Implementation done    | Ends with "Review my changes"            |

---

## Last Tested

Date: ****\_\_\_****
Tester: ****\_\_\_****
Results: [ ] All pass / [ ] Issues found (see notes)

Notes:
