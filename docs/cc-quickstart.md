# Claude Code Quickstart

A hands-on guide for using the AGENTS framework with Claude Code (CC). Covers prerequisites, how agents work, four learning scenarios, and troubleshooting.

---

## 1. Prerequisites

1. **Claude Code CLI installed** — verify with:

   ```bash
   claude --version
   ```

2. **This repo cloned and installed:**

   ```bash
   git clone https://github.com/mcouthon/agents.git
   cd agents
   ./install.sh
   ```

   > **Note:** `make` is only needed if you modify templates in `templates/`. The generated files are committed to git, so `./install.sh` works out of the box.

3. **Verify installation:**

   ```bash
   ls ~/.claude/agents/    # Should show 6 .md files
   ls ~/.claude/skills/    # Should show 12 skill directories
   ```

   You should see agents: `committer.md`, `explorer.md`, `builder.md`, `conductor.md`, `researcher.md`, `reviewer.md`

   And skills: `architecture/`, `consolidate-task/`, `critic/`, `debug/`, `deep-research/`, `design/`, `makefile/`, `mentor/`, `phase-review/`, `security-review/`, `tech-debt/`, `testing/`

4. **Any project directory** to practice on (or use this repo itself)

> **How install works:** `install.sh` generates files with your config to a temp directory, then copies them to `~/.claude/` (agents, skills, rules) and `~/.copilot/` (agents, skills, instructions). A manifest at `~/.agents/manifest.txt` tracks installed files for clean uninstall.

---

## 2. How Agents Work in CC

### Agent Invocation

Invoke any agent by typing in a Claude session:

```
use Explorer to analyze this project's structure
```

The pattern is always: **`use [Agent] to [task description]`**

Available agents: **Explorer**, **Builder**, **Conductor**, **Reviewer**, **Committer**, **Researcher**

### Shell Helpers (Optional)

For faster agent launches from any terminal, install the shell helpers:

```bash
./install.sh helpers
```

This installs `a-*` commands to `~/.local/bin/`:

| Command       | Equivalent                 |
| ------------- | -------------------------- |
| `a-explorer`  | `claude --agent Explorer`  |
| `a-builder`   | `claude --agent Builder`   |
| `a-conductor` | `claude --agent Conductor` |
| `a-reviewer`  | `claude --agent Reviewer`  |
| `a-committer` | `claude --agent Committer` |

Each command supports three modes:

```bash
a-explorer                          # Fresh interactive session
a-explorer continue                 # Auto-detect task in .tasks/, pre-fill prompt
a-explorer "Analyze the auth system"  # Custom initial prompt
```

The `continue` mode finds the most recently modified `NNN-*` directory in `.tasks/` and passes it as the prompt. To uninstall: `./install.sh uninstall-helpers`.

> **PATH note:** If `~/.local/bin` is not in your PATH, the installer will print instructions to add it.

### The `Task()` Tool

When an agent needs to delegate work, it uses CC's `Task()` tool to dispatch a subagent. This creates a **context fork** — a fresh context that receives the prompt, does the work, and returns a summary to the parent.

```
User ──► Conductor ──► Task(Explorer, "research the codebase...")
                              │
                              └──► Explorer runs in isolated context
                              └──► Returns summary to Conductor
```

### Single-Level Nesting

CC enforces **single-level subagent nesting**. Subagents cannot spawn sub-subagents. This means:

- Conductor can invoke `Task(Explorer, ...)`, `Task(Builder, ...)`, etc.
- But Explorer cannot invoke `Task(Researcher, ...)` from within a subagent call
- Explorer and Builder do all their work directly when running as subagents

### Skills

Skills activate from **natural language triggers**:

- "use debug mode" → activates the debug skill
- "use phase-review mode" → activates the phase-review skill
- "use architecture mode" → activates the architecture skill

CC discovers skills from `~/.claude/skills/`. Each skill directory contains a `SKILL.md` with instructions, trigger phrases, and allowed-tools restrictions.

### Checkpoints

Conductor pauses at key decision points using `AskUserQuestion`. In the terminal, this appears as a **free-text prompt** — there are no clickable buttons. You type your choice:

```
Task created with 2 phases. Options:
- [Continue] Approve task structure and proceed to phase planning
- [Abort] Cancel the workflow

> Continue
```

### CC Tool Names

CC has its own tool names for common file and terminal operations:

| Action         | CC Tool            |
| -------------- | ------------------ |
| Read file      | `Read`             |
| Edit file      | `Edit`             |
| Create file    | `Write`            |
| Run command    | `Bash`             |
| Text search    | `Grep`             |
| File search    | `Glob`             |
| Directory list | `Glob`             |
| Ask user       | `AskUserQuestion`  |
| Subagent       | `Task(Agent, ...)` |

### Model Defaults

| Agent                           | Model    |
| ------------------------------- | -------- |
| Conductor, Explorer, Builder    | `opus`   |
| Reviewer, Committer, Researcher | `sonnet` |

---

## 3. Scenario 1: Basic Explorer

**Goal:** Invoke Explorer, create a task, confirm `.tasks/` persistence.

### Steps

1. Open a terminal in any project directory

2. Start a Claude session:

   ```bash
   claude
   ```

3. Invoke Explorer:

   ```
   use Explorer to analyze the project structure and create a task plan for adding a health check endpoint
   ```

4. **Observe:** Explorer reads files, searches patterns, builds understanding of the codebase

5. **Observe:** Explorer creates `.tasks/001-add-health-check/task.md` with phases

6. **Verify:**

   ```bash
   cat .tasks/001-add-health-check/task.md
   ```

   Confirm research findings and phase table are present.

7. End session or continue to Scenario 2

### What to Look For

- Explorer **only reads files and writes to `.tasks/`** — it never edits source code
- The task.md has a phase table with `⬜ Not Started` entries
- Research findings reference specific files and line numbers

### Expected Output Excerpt

```markdown
## Phases

| #   | Phase           | Status         | Plan | Notes             |
| --- | --------------- | -------------- | ---- | ----------------- |
| 1   | Route setup     | ⬜ Not Started | —    | Add /health route |
| 2   | Response format | ⬜ Not Started | —    | JSON status body  |
```

---

## 4. Scenario 2: Builder from Plan

**Goal:** Invoke Builder with an existing task to execute a planned phase.

**Prerequisite:** Scenario 1 completed (task exists in `.tasks/`).

### Steps

1. In the same or new Claude session:

   ```
   use Builder to work on the health check task
   ```

2. **Observe:** Builder reads `.tasks/001-add-health-check/task.md`

3. **Observe:** Lists available phases, picks the first `⬜ Not Started` phase

4. **Observe:** Reads all files referenced in the plan

5. **Observe:** Creates/edits source files, runs tests if applicable

6. **Verify:** Check the created files match the plan

7. **Observe:** Builder updates phase status to `✅ Done`

### What to Look For

- Builder has full file access (`Edit`, `Write`, `Bash`)
- It follows the plan's checklist items
- It does **not** run `git commit` (that's the Committer agent's job)
- Phase status in task.md gets updated

### Troubleshooting

If Builder doesn't find the task, specify the path directly:

```
The task is at .tasks/001-add-health-check/task.md
```

---

## 5. Scenario 3: Full Conductor

**Goal:** Run the Conductor pattern end-to-end on a small task.

> **Tip:** For a faster first run, use a trivial task (badge, comment, config tweak) so phases complete quickly.

### Steps

1. Start a fresh Claude session:

   ```bash
   claude
   ```

2. Invoke:

   ```
   use Conductor to add a README badge showing the Node.js version
   ```

3. **Step 1 — Task Initialization:**
   - Conductor invokes `Task(Explorer, ...)` to research and create the task
   - Explorer returns a summary

4. **🛑 Checkpoint: Task Created** — Conductor asks via `AskUserQuestion`:

   ```
   Task created with 1 phase. Options:
   - [Continue] Approve task structure and proceed to phase planning
   - [Abort] Cancel the workflow
   ```

   Type: `Continue`

5. **Step 2a — Phase Planning:**
   - Conductor invokes `Task(Explorer, ...)` to create a detailed plan
   - Then invokes `Task(Explorer, ...)` with the phase-review skill

6. **🛑 Checkpoint: Plan Review** — Conductor presents review findings and asks:

   ```
   - [Adopt Suggestions] ...
   - [Reject Suggestions] ...
   - [Skip Phase] ...
   ```

   Type: `Reject Suggestions` (or `Adopt Suggestions` to see the revision flow)

7. **Step 2c — Implementation:**
   - Conductor invokes `Task(Builder, ...)`
   - Then `Task(Reviewer, ...)` to verify

8. **🛑 Checkpoint: Implementation Complete** — Type: `Commit`

9. **Step 2f — Commit:**
   - Conductor invokes `Task(Committer, ...)`
   - Phase marked `✅ Done`

10. Summary displayed

### What to Look For

- Conductor **never reads/edits source code itself** — it only coordinates via `Task()` calls
- Each checkpoint requires **your explicit typed response** (not clicks)
- Subagent summaries are returned between steps
- The `.tasks/` directory persists the full workflow state

---

## 6. Scenario 4: Skill Activation

**Goal:** Test three skills: phase-review, debug, consolidate-task.

### 4a. Phase-Review Skill

1. Have a task with a planned phase (from Scenario 1 or 2)

2. In a Claude session:

   ```
   use Explorer to review phase 1 of the health-check task using phase-review mode
   ```

3. **Observe:** Explorer loads the phase-review skill, reads the plan, produces a structured review

4. **Verify:** Review output includes approval status and suggestions. The phase status in task.md is updated to `⭐ Reviewed`

### 4b. Debug Skill

1. Introduce or find a bug in the project (e.g., a failing test)

2. In a Claude session:

   ```
   use Builder to debug why the health check test is failing
   ```

3. **Observe:** Builder activates the debug skill — follows the 4-phase process (Assessment → Hypotheses → Test → Fix)

4. **Verify:** The debug output shows hypothesis formation before jumping to fixes

### 4c. Consolidate-Task Skill

1. Have a completed task (all phases `✅ Done`)

2. In a Claude session:

   ```
   use Explorer to consolidate the health-check task
   ```

3. **Observe:** Explorer loads the consolidate-task skill, reads task.md, decides whether to create/skip an ADR

4. **Verify:** If an ADR is created, it appears in `docs/architecture/` with proper format

### What to Look For Across All Skills

- Skills activate from **natural language** — no special syntax required
- The skill frontmatter (`allowed-tools`) restricts what tools the agent can use during skill execution
- Skills work across sessions — trigger phrases and behavior are consistent

---

## 7. Troubleshooting

| Problem                           | Cause                                      | Fix                                                                      |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| "Agent not found"                 | `install.sh` not run or files missing      | Run `./install.sh`, verify `ls ~/.claude/agents/`                        |
| Agent doesn't follow instructions | Generated files out of date                | Run `./install.sh` (or `make && ./install.sh` if you modified templates) |
| Skill doesn't activate            | Skill not installed or trigger not matched | Check `ls ~/.claude/skills/`, use explicit "use X mode"                  |
| Conductor skips checkpoints       | Rare model behavior                        | Re-invoke; checkpoints are unconditional in the agent instructions       |
| Subagent can't spawn sub-subagent | CC single-level nesting limit              | Expected behavior; agents do work directly                               |
| `AskUserQuestion` unclear         | Terminal prompt without rich UI            | Type the option name (e.g., "Continue", "Abort")                         |
| Task not found by Builder         | Builder didn't scan `.tasks/`              | Specify: "The task is at .tasks/NNN-slug/task.md"                        |
| Permission denied errors          | CC permission mode too strict              | Use `--dangerously-skip-permissions` for testing, or approve tools       |
| Responses seem lower quality      | Wrong model in agent frontmatter           | Check model field — Conductor/Explorer/Builder should be `opus`          |
| Session state lost                | CC sessions are stateless between runs     | Task persistence in `.tasks/` provides continuity across sessions        |

---

## 8. Appendix: Copilot Comparison

> **Note:** This section is for users who also work with VS Code Copilot. If you only use Claude Code, you can skip this.

| Concept               | VS Code Copilot                        | Claude Code                                                                                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Start agent**       | `@Explorer` in Chat panel              | `use Explorer to...`                                                                                    |
| **Switch agent**      | Click handoff button or `@Agent`       | Type `use [Agent] to...`                                                                                |
| **Subagent dispatch** | "Run the Explorer agent as a subagent" | `Task(Explorer, "prompt")`                                                                              |
| **User prompt**       | `askQuestions` with clickable options  | `AskUserQuestion` — type response                                                                       |
| **File read**         | `read_file`                            | `Read`                                                                                                  |
| **File edit**         | `replace_string_in_file`               | `Edit`                                                                                                  |
| **File create**       | `create_file`                          | `Write`                                                                                                 |
| **Terminal**          | `run_in_terminal`                      | `Bash`                                                                                                  |
| **Search (text)**     | `grep_search`                          | `Grep`                                                                                                  |
| **Search (files)**    | `file_search`                          | `Glob`                                                                                                  |
| **Directory list**    | `list_dir`                             | `Glob`                                                                                                  |
| **Handoff buttons**   | In-context action buttons              | Not available — manually invoke next agent                                                              |
| **Skill activation**  | Natural language                       | Natural language (identical)                                                                            |
| **Nesting depth**     | Multi-level (agent → Research → ...)   | Single-level only                                                                                       |
| **Project config**    | `.copilot/` directory                  | `.claude/` directory                                                                                    |
| **Global config**     | `~/.copilot/`                          | `~/.claude/`                                                                                            |
| **Permission model**  | VS Code tool approval dialogs          | `permissionMode` frontmatter (`plan`, `bypassPermissions`) or `--dangerously-skip-permissions` CLI flag |
| **Model selection**   | VS Code model picker                   | Agent frontmatter `model:` field                                                                        |
