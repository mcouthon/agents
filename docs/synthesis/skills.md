# Skills Methodology

| Field      | Value             |
| ---------- | ----------------- |
| **Date**   | 2026-02-14        |
| **Status** | Partially Adopted |

## Summary

How to create, test, review, and invoke skills. Consolidates methodology from TDD testing, systematic review, subagent integration, and ecosystem analysis.

---

## TDD Skill Testing (from RDR-004)

**Source:** [obra/superpowers](https://github.com/obra/superpowers)

Skills-based workflow framework for AI agents with TDD-inspired skill creation methodology. Skills are tested using "pressure scenarios" before deployment.

### Methodology

| Step        | Action                            |
| ----------- | --------------------------------- |
| 🔴 RED      | Watch agent fail without skill    |
| 🟢 GREEN    | Write skill                       |
| 🔵 REFACTOR | Close loopholes, tighten triggers |

### What We Adopted

- TDD-based skill testing (validate with test scenarios)
- Rich skill descriptions with trigger keywords for discovery
- Progressive disclosure (<500 lines for main skill file)
- Skill namespace (personal skills override framework skills)

### Rejected

- Mandatory workflow enforcement (too prescriptive for advisory philosophy)
- Emphatic/forceful tone ("YOU MUST")
- Command system (`/superpowers:brainstorm`)—we use agent modes
- Subagent-driven development (platform-specific)

### Key Insight

Skills should be TDD-tested: watch agent fail without skill (RED), write skill (GREEN), close loopholes (REFACTOR). This is unit testing for documentation.

---

## Skill Review Criteria (from RDR-019)

**Source:** Internal review

Systematic review of 6 existing skills against quality criteria from Superpowers and prevailing wisdom.

### Quality Checklist

- [ ] Distinct behavioral constraints (not just format guidance)
- [ ] Minimal overlap with existing skills
- [ ] Clear trigger conditions
- [ ] Under 500 lines

### Review Results

| Skill          | Verdict   | Rationale                                      |
| -------------- | --------- | ---------------------------------------------- |
| `debug`        | ✅ Keep   | Strong: hypothesis-driven investigation        |
| `mentor`       | ✅ Keep   | Strong: Socratic questions-only mode           |
| `critic`       | ✅ Keep   | Strong: adversarial probing, no solutions      |
| `architecture` | ⚠️ Polish | Strengthen scope constraint, add anti-patterns |
| `tech-debt`    | ⚠️ Expand | Absorb janitor's deletion philosophy           |
| `janitor`      | 🔴 Remove | 80% overlap with tech-debt                     |

### Actions Taken

- Merged janitor into tech-debt (added deletion philosophy, safe deletion patterns)
- Polished architecture (strengthened "interfaces in, interfaces out" constraint)
- Skills reduced from 6 → 5

### Key Insight

Future skills should pass the overlap test before creation. Strong skills have distinct behavioral constraints that change how agents work, not just format guidance.

---

## Skill-Powered Subagents (from RDR-027)

**Source:** Internal design  
**See:** [ADR-004](../architecture/ADR-004-skill-powered-subagents.md) for the architectural decision.

Agents can invoke skills via subagents by including skill trigger keywords in the subagent prompt. This combines skill expertise with context isolation.

### Pattern

| Factor         | Inline Skill                      | Subagent + Skill                   |
| -------------- | --------------------------------- | ---------------------------------- |
| Context impact | All findings stay in main context | Subagent context garbage-collected |
| Focus          | Mixed with other agent concerns   | Pure skill mode operation          |
| Output         | Full reasoning visible            | Summary only returned              |
| Control        | Auto-triggered by keywords        | Agent decides when to invoke       |

### Agent → Skill Pairings

| Agent    | Skill        | Trigger Scenario                    |
| -------- | ------------ | ----------------------------------- |
| Explorer | architecture | Understanding system structure      |
| Builder  | debug        | Tests failing during implementation |
| Reviewer | critic       | Stress-testing implementation       |
| Reviewer | tech-debt    | Code quality scanning               |

### Key Insight

Subagents act as "skill invokers"—by crafting prompts with skill trigger keywords, agents get specialized behavior without bloating their own context. The skill's progressive loading (discovery → instructions → resources) happens in the subagent's isolated context.

---

## Skills Ecosystem (from RDR-028)

**Source:** [skills.sh](https://skills.sh/), [trailofbits/skills](https://github.com/trailofbits/skills), [getsentry/skills](https://github.com/getsentry/skills), [obra/superpowers](https://github.com/obra/superpowers)

Reviewed ~80 skills across the skills.sh ecosystem. Our SKILL.md format is fully compatible—same YAML frontmatter, markdown body, progressive disclosure pattern.

### High-Value Discoveries

| Repo                   | Notable Skills                                           | Relevance                                          |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| **obra/superpowers**   | systematic-debugging, test-driven-development            | 4-phase process, rationalization prevention tables |
| **trailofbits/skills** | differential-review, sharp-edges, code-maturity-assessor | Security review patterns, "blast radius" concept   |
| **getsentry/skills**   | commit, create-pr, iterate-pr, find-bugs                 | Git workflow automation, PR iteration patterns     |

### Patterns Worth Adopting

1. **Rationalization Prevention Tables** (obra/trailofbits) — ✅ Implemented
   - `| Excuse | Reality | Required Action |` format
   - 46 rows across 8 templates (3 skills, 5 agents)
   - Skills: `debug` (6 rows), `testing` (6), `tech-debt` (5)
   - Agents: `builder` (6), `reviewer` (6), `explorer` (6), `committer` (5), `conductor` (5)
   - Net result: -168 lines via concurrent prose trimming (net-zero text principle)

2. **Four-Phase Debugging** (obra)
   - Root Cause → Pattern Analysis → Hypothesis Testing → Implementation
   - "NEVER fix symptom" mandate with redundancy

3. **Blast Radius Calculation** (trailofbits)
   - Quantify change impact by counting callers
   - Risk classification (HIGH/MEDIUM/LOW)

### Not Adopted

- Framework-specific skills (React, Vue, Next.js, etc.)—out of scope
- Document format skills (pdf, docx, pptx)—proprietary/source-available
- Claude Code-specific plugin mechanics—different runtime
- Direct skill imports (format compatible but context differs)

---

## Skill Evaluation Checklist

Before adding or keeping a skill, evaluate it against these criteria:

| Criterion           | Question to Ask                                       | Pass Indicator                                |
| ------------------- | ----------------------------------------------------- | --------------------------------------------- |
| **Distinct Value**  | Does it provide guidance an agent wouldn't do anyway? | Without skill, agent clearly fails the task   |
| **Trigger Clarity** | Are activation keywords specific and discoverable?    | Keywords in description match user vocabulary |
| **Constraint/Mode** | Does it meaningfully change agent behavior?           | Agent acts differently with vs without skill  |
| **Size**            | Is the SKILL.md under ~150 lines?                     | Core instructions focused; reference material in linked files |
| **Overlap**         | Does it overlap significantly with other skills?      | <20% overlap with existing skills             |
| **TDD Testable**    | Can you observe failure without it, success with it?  | RED/GREEN test scenario documented            |

**Scoring:**

- 4+ criteria = strong skill, keep or add
- 2-3 criteria = needs polish, strengthen weak areas
- 0-1 criteria = consider removing or merging into another skill

---

## Skill Authoring Patterns (from mattpocock/skills)

**Source:** [mattpocock/skills](https://github.com/mattpocock/skills) (104k ⭐)

Matt Pocock's skills collection demonstrates that radical conciseness produces effective skills. His most impactful skill (`grill-me`) is 10 lines — a pure behavioral directive.

### Size Target: ~150 Lines

Split SKILL.md at ~150 lines. Move reference material (examples, anti-patterns catalog, technique lists) into linked files:

```
skill-name/
├── SKILL.md           # Core instructions (~150 lines max)
├── techniques.md      # Extended reference (if needed)
├── examples.md        # Usage examples (if needed)
```

Our longest skills (design, power-ui) exceed 400 lines. Consider splitting their reference sections.

### "THIS IS THE SKILL" Emphasis

Not all steps in a skill are equally important. Mark the critical phase with disproportionate emphasis:

- Pocock's `diagnose` skill spends 60% of its prose on Phase 1 (building a feedback loop), marking it "**This is the skill.** Everything else is mechanical."
- This teaches agents WHERE to invest effort vs treating all phases equally
- Use when one step is the difference between success and failure

### Every Line Must Change Behavior

Before each line, ask: "Would a capable agent do this anyway without being told?" If yes, delete it. Skills are behavioral constraints, not tutorials.

**Signs of skill bloat:**
- Restating what capable agents already do ("Be thorough", "Consider edge cases")
- Format templates the agent would generate naturally
- Explaining WHY the approach works (agents don't need convincing)
- Redundant framing ("In this mode, you will...")

---

## See Also

- [ADR-004](../architecture/ADR-004-skill-powered-subagents.md) — Skill-powered subagent pattern
- [RDR-020-design-skill.md](../research/RDR-020-design-skill.md) — Skill creation example
- [agentskills.io](https://agentskills.io/specification) — Skills format specification
