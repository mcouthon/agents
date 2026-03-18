---
name: documentation
description: "Documentation standards and best practices for code changes. Use when writing or reviewing documentation, adding public APIs, making user-facing changes, or checking documentation quality. Triggers on: 'use documentation mode', 'document', 'documentation', 'docstring', 'add docs', 'update docs', 'documentation review', 'API documentation', 'README update'. Full access mode - can write documentation and update code comments."

cc:
  allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# Documentation Standards

Write documentation that serves humans and AI agents. Keep it accurate, layered, and close to the code.

> "Documentation is a love letter that you write to your future self." — Damian Conway

## Documentation Hierarchy

Documentation lives in layers. Each layer has a distinct audience, scope, and update cadence.

| Layer                         | Audience                 | Scope                     | Update Frequency         |
| ----------------------------- | ------------------------ | ------------------------- | ------------------------ |
| Code comments                 | Maintainers, AI agents   | Single block / decision   | Every code change        |
| Docstrings                    | Consumers, AI agents     | Function / class contract | Every signature change   |
| Module docs                   | Team members, onboarding | File / package purpose    | When module role changes |
| Project docs (README, guides) | All stakeholders         | System / feature          | Every user-facing change |
| Architecture docs (ADRs)      | Maintainers, future devs | Design decisions          | When decisions are made  |

## Audience Matrix

| Audience                   | What They Need                                | Key Layers                              |
| -------------------------- | --------------------------------------------- | --------------------------------------- |
| Internal maintainers       | Intent, trade-offs, edge cases                | Comments, docstrings, ADRs              |
| New team members           | Orientation, key concepts, how things connect | Module docs, README, architecture       |
| External users / consumers | How to use it, API contracts                  | README, API reference, how-to guides    |
| AI agents                  | Purpose, contracts, intent behind decisions   | Docstrings, architecture docs, comments |

## Layer Rules

### Code Comments

- Explain **why**, never **what** — the code already says what
- Mark non-obvious decisions, trade-offs, and workarounds
- Reference issue/ticket numbers for context: `// Workaround for #1234`
- Delete rather than comment out dead code (use version control)
- Keep comments adjacent to the code they describe

### Docstrings

- **Public APIs**: Complete — params, returns, raises/throws, brief description
- **Internal/private**: Concise — one-line purpose; skip if trivially obvious
- **Skip entirely**: Simple getters/setters, constructors with no logic, obvious wrappers
- Describe the **contract** (what), not the **implementation** (how)
- Include a usage example for non-trivial public APIs

### Module / Package Docs

- Top-of-file docstring or comment: one paragraph explaining purpose
- List key classes/functions and their roles
- Describe usage patterns and entry points
- Update when the module's responsibility changes

### Project Docs

Follow the **Diátaxis framework** (see below). Keep docs in the repo, close to what they describe.

- **README**: Project purpose, quickstart, key links — the front door
- **CHANGELOG**: User-facing changes per release
- **Architecture docs**: Design decisions, system structure, component relationships
- **API reference**: Generated or maintained per public surface

## Diátaxis Quick Reference

Four types of documentation, each serving a different user need:

| Type             | Orientation   | Answers                         | Structure                                   |
| ---------------- | ------------- | ------------------------------- | ------------------------------------------- |
| **Tutorial**     | Learning      | "Follow these steps to learn X" | Step-by-step, hands-on, minimal explanation |
| **How-to Guide** | Task          | "How to accomplish X"           | Goal-oriented steps, assumes knowledge      |
| **Reference**    | Information   | "Specification of X"            | Precise, complete, consistent structure     |
| **Explanation**  | Understanding | "Why X works this way"          | Conceptual, discursive, gives context       |

**Common mistakes:**

- Mixing tutorial steps with reference details
- Writing a how-to guide as a tutorial (too many basics)
- Putting explanations in reference docs (keep them factual)
- Missing how-to guides (users know what they want to do, not where to look)

## Quality Checklist

```markdown
- [ ] Public APIs have complete docstrings (params, returns, raises)
- [ ] Code comments explain "why", not "what"
- [ ] No stale documentation (matches current behavior)
- [ ] User-facing changes reflected in README or relevant guides
- [ ] New modules have a brief purpose description at top of file
- [ ] Architecture-significant decisions documented (ADR or equivalent)
- [ ] Examples are runnable and up-to-date
- [ ] CHANGELOG updated for user-visible changes
```

## Anti-Patterns

| Anti-Pattern                             | Problem                     | Correction                                     |
| ---------------------------------------- | --------------------------- | ---------------------------------------------- |
| Comment restates the code                | Noise, drifts out of sync   | Delete or explain the **why**                  |
| Docstring describes implementation       | Couples docs to internals   | Focus on the contract (what, not how)          |
| README lists features that don't exist   | Misleading, erodes trust    | Audit docs against actual behavior             |
| Docs live only in PR/commit messages     | Invisible to future readers | Move to permanent location in repo             |
| Over-documenting trivial code            | Clutter, maintenance burden | Skip obvious getters/setters/constructors      |
| Copy-pasting docstrings across overloads | Drift between copies        | Document the base, reference it from overloads |
| Huge top-of-file comment blocks          | Nobody reads them           | Keep to one paragraph; link to detailed docs   |

## Docstring Standards

Follow the standard specified by each language's instruction file. Do **not** invent custom formats.

| Language   | Standard     | Reference                                        |
| ---------- | ------------ | ------------------------------------------------ |
| Python     | Google style | `python.instructions.md` — Documentation section |
| TypeScript | TSDoc        | `typescript.instructions.md`                     |
| JavaScript | JSDoc        | `typescript.instructions.md`                     |

When a language-specific instruction file doesn't cover documentation, apply these defaults:

- Public functions: brief description + `@param` + `@returns` + `@throws`
- Classes: brief description + constructor params
- Interfaces/types: brief description of purpose and usage context

## Agent-Specific Guidance

AI agents consume documentation differently than humans. Optimize for both.

**What helps agents most:**

| Documentation Element                    | Agent Benefit                                |
| ---------------------------------------- | -------------------------------------------- |
| Docstrings with typed params             | Navigation, correct usage, type inference    |
| Module-level purpose comments            | Understanding component responsibility       |
| Architecture docs                        | High-level context for cross-cutting changes |
| "Why" comments                           | Making correct decisions about modifications |
| Explicit contracts (pre/post conditions) | Safe refactoring boundaries                  |

**Principles:**

- Keep docs close to code — agents search files, not wikis
- Structured formats (tables, lists) are easier to parse than prose
- Be explicit about edge cases and invariants in docstrings
- Name things well — good names reduce the documentation needed
- When docs and code disagree, the code is right — fix the docs
