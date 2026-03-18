# Documentation Skill — POC Validation

Structured proof-of-concept validation for the `documentation` skill. Follows the TDD for Documentation approach: RED (baseline without skill) → GREEN (with skill) → REFACTOR (quality improvements).

---

## Section 1: Validation Summary

### What Is Being Tested

The `documentation` skill (`templates/skills/documentation/SKILL.template.md`) — a new skill that makes documentation a first-class concern in the agentic workflow rather than an afterthought.

### Why

Before this skill, agents would implement features and review code without structured documentation standards. Documentation quality depended entirely on the user remembering to ask. The skill provides:

- A documentation hierarchy (comments → docstrings → module docs → project docs → ADRs)
- Quality checklist for consistent reviews
- Diátaxis framework guidance for project-level docs
- Anti-pattern detection
- Agent-specific guidance (optimizing docs for AI consumption)

### Expected Outcomes

- [ ] Skill passes all structural validation (`validate-skills.sh`)
- [ ] Skill generates correctly for both Copilot and Claude Code (`test-generate.sh`)
- [ ] Builder agent references the skill and uses it during implementation
- [ ] Reviewer agent references the skill and checks documentation quality
- [ ] Conductor delegates documentation tasks using the skill
- [ ] Skill auto-activates on relevant trigger keywords

---

## Section 2: Skill Structural Validation

### File Structure Checklist

| Check                                                                        | Expected | Status |
| ---------------------------------------------------------------------------- | -------- | ------ |
| Template exists at `templates/skills/documentation/SKILL.template.md`        | Yes      |        |
| Copilot skill generated at `generated/copilot/skills/documentation/SKILL.md` | Yes      |        |
| Claude skill generated at `generated/claude/skills/documentation/SKILL.md`   | Yes      |        |
| Single file in template directory (no extra files)                           | Yes      |        |

### Frontmatter Validation

| Field                                           | Expected Value                                              | Status |
| ----------------------------------------------- | ----------------------------------------------------------- | ------ |
| `name`                                          | `documentation`                                             |        |
| `description`                                   | Starts with "Documentation standards and best practices..." |        |
| `description` contains "Use when"               | Yes — "Use when writing or reviewing documentation..."      |        |
| `description` contains "Triggers on:"           | Yes — includes trigger keywords                             |        |
| `description` contains "use documentation mode" | Yes — unique mode trigger                                   |        |
| `cc.allowed-tools` (template)                   | `[Read, Edit, Write, Bash, Grep, Glob, LSP]`                |        |
| `allowed-tools` (Claude generated)              | Same as template cc section                                 |        |

### Trigger Keywords

Verify these keywords are in the description's `Triggers on:` block:

| Trigger                  | Present |
| ------------------------ | ------- |
| `use documentation mode` |         |
| `document`               |         |
| `documentation`          |         |
| `docstring`              |         |
| `add docs`               |         |
| `update docs`            |         |
| `documentation review`   |         |
| `API documentation`      |         |
| `README update`          |         |

### Content Validation (compare with peer skills like `testing`, `debug`)

| Check                                              | Expected                                | Status |
| -------------------------------------------------- | --------------------------------------- | ------ |
| Has a main heading (`# Documentation Standards`)   | Yes                                     |        |
| Includes actionable guidance (not just philosophy) | Yes — hierarchy, layer rules, checklist |        |
| Quality Checklist section with checkboxes          | Yes                                     |        |
| Anti-patterns table                                | Yes                                     |        |
| Line count reasonable (< 500)                      | Yes — 146 lines (Copilot)               |        |
| Description length < 500 chars                     | Verify with `validate-skills.sh`        |        |

### Agent Integration Checklist

| Agent     | Integration Point                                           | How                                                                                | Status |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| Builder   | Frontmatter `skills:`                                       | `skills: [debug, testing, documentation]`                                          |        |
| Builder   | Body references                                             | "load the documentation skill for standards", "Documentation Requirements" section |        |
| Reviewer  | Frontmatter `skills:`                                       | `skills: [critic, tech-debt, security-review, testing, documentation]`             |        |
| Reviewer  | Body references                                             | "load the documentation skill and verify quality", "Documentation" review section  |        |
| Conductor | Body references                                             | "Load the documentation skill for quality standards" in subagent delegation        |        |
| Conductor | NOT in frontmatter skills (delegates, doesn't use directly) | Correct — Conductor has no `skills:` field                                         |        |

---

## Section 3: RED Tests (Baseline Without Skill)

**Setup:** Temporarily remove or rename the documentation skill to establish baseline behavior.

> ⚠️ These are manual observational tests. Restore the skill after testing.

### RED-1: Builder implements a function without documentation guidance

**Steps:**
1. Remove/rename `generated/copilot/skills/documentation/SKILL.md`
2. Open a new Copilot chat with Builder agent
3. Ask: "Implement a `calculateDiscount(price: number, percentage: number): number` function in a new file"
4. Observe the output

**Expected (RED — no skill):**
- Builder creates the function
- Does NOT proactively write JSDoc/docstrings
- Does NOT reference a documentation quality checklist
- Does NOT mention documentation hierarchy or Diátaxis

**Record:**
- [ ] Observation matches expected baseline
- Notes: ___

### RED-2: Reviewer reviews code without documentation checks

**Steps:**
1. Ensure documentation skill is still removed
2. Open a new Copilot chat with Reviewer agent
3. Provide a code snippet with a public API function lacking documentation
4. Ask: "Review this code"

**Expected (RED — no skill):**
- Reviewer checks code quality, tests, security
- Does NOT specifically flag missing docstrings using documentation skill standards
- Does NOT reference documentation hierarchy or quality checklist

**Record:**
- [ ] Observation matches expected baseline
- Notes: ___

### RED-3: Natural language trigger does not activate skill

**Steps:**
1. Ensure documentation skill is still removed
2. Ask: "add docs for this API"
3. Ask: "check documentation quality"

**Expected (RED — no skill):**
- Agent provides generic help but does NOT load structured documentation standards
- No reference to Diátaxis framework, audience matrix, or quality checklist

**Record:**
- [ ] Observation matches expected baseline
- Notes: ___

---

## Section 4: GREEN Tests (With Skill Active)

**Setup:** Restore the documentation skill. Start fresh chat sessions.

### GREEN-1: Builder implements a function WITH documentation

**Steps:**
1. Ensure documentation skill is present
2. Open a new Copilot chat with Builder agent
3. Ask: "Implement a `calculateDiscount(price: number, percentage: number): number` function in a new file"
4. Observe the output

**Expected (GREEN — skill active):**
- Builder creates the function WITH docstrings/JSDoc
- References documentation standards when writing public API docs
- Follows the documentation skill's layer rules (docstrings describe contract, not implementation)

**Record:**
- [ ] Function has proper JSDoc/docstring
- [ ] Documentation follows "contract, not implementation" principle
- Notes: ___

### GREEN-2: Reviewer flags missing documentation

**Steps:**
1. Open a new Copilot chat with Reviewer agent
2. Provide a code snippet with a public API function lacking documentation
3. Ask: "Review this code"

**Expected (GREEN — skill active):**
- Reviewer flags missing docstrings
- References the documentation quality checklist
- May mention the documentation hierarchy (public APIs need complete docstrings)

**Record:**
- [ ] Reviewer flagged missing documentation
- [ ] Referenced quality checklist or documentation standards
- Notes: ___

### GREEN-3: "add docs" triggers documentation skill

**Steps:**
1. Open a new Copilot chat
2. Ask: "add docs for this API" (pointing to a file with undocumented functions)

**Expected (GREEN — skill auto-activates):**
- Documentation skill activates (visible in agent behavior)
- Writes docstrings following the skill's standards (Google style for Python, TSDoc for TS)
- Applies layer rules: complete for public APIs, concise for private

**Record:**
- [ ] Skill activated on "add docs" trigger
- [ ] Docstrings follow language-specific standards
- Notes: ___

### GREEN-4: "check documentation quality" triggers quality audit

**Steps:**
1. Open a new Copilot chat
2. Ask: "check documentation quality" for a module

**Expected (GREEN — skill auto-activates):**
- Documentation skill activates
- Applies the Quality Checklist from the skill
- Reports findings structured around: docstrings, comments, staleness, README, module docs, ADRs, examples, CHANGELOG

**Record:**
- [ ] Skill activated on "check documentation quality" trigger
- [ ] Quality checklist applied systematically
- Notes: ___

### GREEN-5: "use documentation mode" explicit activation

**Steps:**
1. Open a new Copilot chat
2. Say: "use documentation mode"
3. Then ask for help with documentation tasks

**Expected (GREEN — explicit mode):**
- Skill loads immediately
- Subsequent responses use documentation skill standards throughout

**Record:**
- [ ] Explicit mode activation worked
- Notes: ___

---

## Section 5: Integration Validation

### Automated Tests

Run these commands and verify all pass:

| Command                      | Expected                                            | Actual Result |
| ---------------------------- | --------------------------------------------------- | ------------- |
| `make validate`              | Exit 0, no errors                                   |               |
| `./tests/validate-skills.sh` | `documentation: Valid`, no errors for documentation |               |
| `./tests/test-generate.sh`   | All tests pass, skill count ≥ 13                    |               |

### Template → Generated Parity

| Check                                  | Command                                                                                                                                         | Expected                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Copilot skill matches template content | `diff <(sed '1,/^---$/d' templates/skills/documentation/SKILL.template.md) <(sed '1,/^---$/d' generated/copilot/skills/documentation/SKILL.md)` | No diff (body identical) |
| Claude skill matches template content  | `diff <(sed '1,/^---$/d' templates/skills/documentation/SKILL.template.md) <(sed '1,/^---$/d' generated/claude/skills/documentation/SKILL.md)`  | No diff (body identical) |

### Agent Template References

Verify with grep that the skill is referenced where expected:

```bash
# Builder template references documentation skill in frontmatter
grep -c 'documentation' templates/agents/builder.template.md
# Expected: 8+ matches (frontmatter + body references)

# Reviewer template references documentation skill in frontmatter
grep -c 'documentation' templates/agents/reviewer.template.md
# Expected: 5+ matches (frontmatter + body references)

# Conductor template references documentation skill in body
grep -c 'documentation' templates/agents/conductor.template.md
# Expected: 8+ matches (body references for delegation)
```

### Cross-Platform Parity

| Check                                                                           | Status |
| ------------------------------------------------------------------------------- | ------ |
| `validate-skills.sh` reports "Skill count matches" for both platforms           |        |
| Claude skill has `allowed-tools` in frontmatter (instead of `cc.allowed-tools`) |        |
| Copilot skill has `cc` block stripped from frontmatter                          |        |

### Skill Activation Entry in `tests/scenarios/skill-activation.md`

| Check                                                         | Status |
| ------------------------------------------------------------- | ------ |
| `documentation` listed under "Explicit Mode Switching"        |        |
| `documentation` has its own keyword test table                |        |
| Trigger prompts match the frontmatter `Triggers on:` keywords |        |

---

## Section 6: Results

### Automated Validation Results

| Test Suite           | Date | Result | Notes |
| -------------------- | ---- | ------ | ----- |
| `validate-skills.sh` |      |        |       |
| `test-generate.sh`   |      |        |       |
| `make validate`      |      |        |       |

### Manual Test Results

| Test ID | Date | Tester | Result | Notes |
| ------- | ---- | ------ | ------ | ----- |
| RED-1   |      |        |        |       |
| RED-2   |      |        |        |       |
| RED-3   |      |        |        |       |
| GREEN-1 |      |        |        |       |
| GREEN-2 |      |        |        |       |
| GREEN-3 |      |        |        |       |
| GREEN-4 |      |        |        |       |
| GREEN-5 |      |        |        |       |

### Integration Results

| Check                       | Date | Tester | Result | Notes |
| --------------------------- | ---- | ------ | ------ | ----- |
| Template → Generated parity |      |        |        |       |
| Agent template references   |      |        |        |       |
| Cross-platform parity       |      |        |        |       |
| Skill activation entries    |      |        |        |       |

### Overall Verdict

- [ ] **PASS** — Documentation skill is fully functional and integrated
- [ ] **PARTIAL** — Skill works but has issues (see notes)
- [ ] **FAIL** — Skill does not meet requirements

**Sign-off:** ___  
**Date:** ___
