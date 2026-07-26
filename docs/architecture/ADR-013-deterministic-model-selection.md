# Deterministic Model Selection for VS Code Copilot Agents

**Source:** Task 101 (July 2026)

## Decision

For every generated GitHub Copilot custom agent, emit a **same-tier fallback ARRAY of
bare model names** (e.g. `["Claude Sonnet 5", "Claude Sonnet 4.6"]`) instead of a single
pinned string, so that when VS Code fails to resolve the primary pin, it exhausts the
rest of the array — landing on another model of the **same tier** — before it ever falls
through to an arbitrary picker/session/internal-default model. Shipped in commit
`71a7981`. The generate-time hard-fail allowlist and a runtime model self-report
(originally planned as Phase 3) were considered and **deliberately not implemented** in
this task. Deterministically pinning or disabling VS Code's built-in Explore
(Code Research) subagent (originally Phase 2) is resolved as **documentation of a manual
user step**, not an installer change.

## Why

- A custom agent's `model:` frontmatter is honored by VS Code Copilot Chat **~95% of the
  time** — Builder normally runs its configured Sonnet, Explorer normally runs Opus. But
  on an intermittent ~5% miss, VS Code does not fail loudly; it **silently falls back**
  to a different model outside the framework's control (observed: Builder running on
  GPT-5.3-Codex, a model the user never selected in the picker).
- A single scalar pin gives VS Code nowhere to go but that silent fallback on a miss. An
  array is a genuine VS Code feature — "the system tries each model in order until an
  available one is found" — so listing only same-tier models turns an unbounded fallback
  (any vendor, any tier) into a bounded one (same tier, always).
- The one genuine config bug (`researcher` resolving to the nonexistent `Claude Haiku
  4.6`) *always* missed and therefore *always* triggered the uncontrolled fallback — this
  was the highest-leverage, purely-in-repo fix available.
- 100% enforcement is not achievable from a static generator: VS Code resolves the model
  at runtime, and the extension's resolution/fallback code is not statically inspectable
  from this repo (minified, not present in the local extensions manifest). The
  determinism ceiling this ADR documents exists precisely because some levers are VS
  Code's, not the framework's.

## Problem Statement

Framework agents dispatched through GitHub Copilot Chat in VS Code occasionally ran on a
model the user never configured or selected:

- **Builder → GPT-5.3-Codex** (a non-Claude vendor, and a model absent from the user's
  own model picker at the time).
- **Builder → Claude Opus 4.6** (a Claude model, but the wrong version/tier for Builder's
  Sonnet configuration).
- **An exploration step → Claude Haiku 4.5** — traced to VS Code's own built-in Explore
  (Code Research) subagent, not the framework's custom Explorer agent.

Investigation (recorded in full in `.tasks/101-deterministic-model-selection/task.md`)
went through several rounds because the first two rounds targeted the wrong runtime
entirely (the standalone `copilot` CLI, not the VS Code Copilot Chat extension the user
actually runs). The corrected root cause and the resulting scope are below.

## Root Cause

VS Code Copilot Chat honors a custom agent's declared `model:` on the large majority of
dispatches. On the residual miss, the resolution logic:

1. Tries to match the declared model string against the live, server-fetched
   `copilot`-vendor model catalog.
2. If the string does not resolve (transient unavailability/overload of the pinned
   model, catalog/display-name drift, org-policy timing, or — for a `researcher` pin at
   the time — a genuinely **nonexistent** model version), VS Code **silently drops the
   pin** rather than erroring.
3. It falls back to a default that is **not reliably the user's own model-picker
   selection**. The user never selected GPT-5.3-Codex, yet Builder ran on it — the
   activity's use of the Codex-native "Apply Patch" tool suggests a per-tool/internal
   coding-task default rather than a session/picker inheritance. The exact mechanism of
   this fallback target could not be confirmed (the extension is not statically
   inspectable on this machine) and is an accepted residual unknown.

Because the *exact* external fallback target is unconfirmed and outside repo control,
the durable fix does not depend on knowing it: a **same-tier fallback array** bounds the
blast radius regardless of what VS Code falls back to externally, because VS Code
exhausts every entry in the array first.

## Solution

### Before

Each agent declared a single scalar (or, for the Conductor, a cross-tier) model pin.
A resolution miss on that one string had nothing left in-tier to try and fell straight
through to VS Code's uncontrolled external default:

```yaml
# generated/copilot/agents/researcher.agent.md (before)
model: ["Claude Haiku 4.6"]   # <- does not exist in the catalog; ALWAYS misses
```

```yaml
# generated/copilot/agents/builder.agent.md (before)
model: ["Claude Sonnet 5"]   # single entry; a transient miss has no same-tier fallback
```

### After

`scripts/generate.js` gained a `COPILOT_TIER_FALLBACKS` table and a `copilotPrimaryTier()`
helper. The Copilot branch of `resolveSectionModels` now emits the config-resolved
primary followed by the rest of that tier, deduped, bare (no `(copilot)` vendor suffix —
held in reserve as a future lever):

```javascript
// scripts/generate.js
const COPILOT_TIER_FALLBACKS = {
  opus:   ["Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.6"],
  sonnet: ["Claude Sonnet 5", "Claude Sonnet 4.6"],
  haiku:  ["Claude Haiku 4.5", "Claude Sonnet 5"],  // no ENABLED haiku exists;
                                                     // cross-tier Sonnet 5 is the
                                                     // guaranteed-available safety net
};
```

```yaml
# generated/copilot/agents/builder.agent.md (after)
model: ["Claude Sonnet 5", "Claude Sonnet 4.6"]
```

```yaml
# generated/copilot/agents/researcher.agent.md (after)
model: ["Claude Haiku 4.5", "Claude Sonnet 5"]
```

`defaults/config.json` bumped `models.opus`/`models.sonnet` to `"5"` and added explicit
`agents.researcher`/`agents.committer` → `{"copilot":"haiku"}` overrides, so researcher no
longer silently inherits an unconfigured, version-drifted template default.

**Trade-off accepted for the `haiku` tier:** no Claude Haiku model is currently ENABLED
(selectable) in the live catalog — only a hidden Haiku 4.5 exists. The array's real,
always-available safety net is therefore the cross-tier `Claude Sonnet 5`, not another
haiku model. This means a `researcher`/`committer` resolution miss can land one tier up
(Sonnet) rather than staying in haiku — an explicit, surfaced trade-off, not an oversight.

## VS Code Explore (Code Research) Subagent

The Haiku "exploration step" observed alongside the Builder incidents is **VS Code's own
built-in Explore subagent** (branded "Code Research" in-product), not the framework's
custom Explorer agent. It is governed entirely by VS Code settings the framework's
generator does not control:

| Setting | Scope | Effect |
| --- | --- | --- |
| `github.copilot.chat.exploreAgent.enabled` | Experimental | Toggles the built-in Explore subagent on/off. |
| `github.copilot.chat.exploreAgent.model` | Experimental | **Decisive** override for the Explore subagent's model. Empty → falls to VS Code's built-in fast/small default list (Haiku 4.5 / Gemini Flash class models). This is the direct, confirmed cause of the observed Haiku exploration step. |
| `chat.exploreAgent.defaultModel` | Core (non-experimental) | Does **not** rescue an empty `exploreAgent.model` for the experimental Explore agent — evidence: setting this to `"Claude Sonnet 5 (Copilot)"` while `exploreAgent.model` stayed empty still produced a Haiku exploration step. It appears to govern only the core/non-experimental Explore path. |

**Superseded setting name:** `github.copilot.chat.searchSubagent.enabled` was the 1.109
name for this mechanism. It was renamed in 1.110+ to the `exploreAgent.*` keys above and
is inert in any current build — do not target it.

**Framework decision (this task): document, do not automate.** Pinning
(`exploreAgent.model` → a real model string) or disabling
(`exploreAgent.enabled` → `false`) the Explore subagent is left as a **manual,
user-controlled VS Code setting**. The installer (`scripts/configure-vscode-settings.js`)
intentionally does **not** write any of these three keys. Two reasons:

1. **User choice, not a framework default.** Whether to keep the Explore subagent (fast,
   cheap, but non-deterministic without a pin) or disable it (deterministic dispatch to
   the framework's own custom agents, but losing a dedicated exploration pass) is a
   per-user trade-off, not a repo-wide policy this task should impose.
2. **Context-window trade-off.** The Explore subagent exists specifically to keep
   exploratory reads (file scanning, codebase search) out of the *main* agent's context
   window. Disabling it moves that read volume back into the primary agent's context.
   Pinning it to a real model preserves the context-window benefit but still costs a
   deliberate, model-aware choice about which model does that exploratory work.

If a user notices Haiku-quality exploration output, the fix is manual: set
`github.copilot.chat.exploreAgent.model` to a real catalog model string (recommended:
match the tier used elsewhere, e.g. `"Claude Sonnet 5 (Copilot)"`), or set
`github.copilot.chat.exploreAgent.enabled` to `false` to disable the subagent entirely.

## Determinism Ceiling — What the Framework Can vs Cannot Enforce

| Can enforce (this repo's static generator) | Cannot enforce (VS Code / manual) |
| --- | --- |
| Same-tier fallback arrays per agent (`COPILOT_TIER_FALLBACKS`) | The VS Code model picker's current selection |
| Catalog-valid model strings (no nonexistent versions like the old `Claude Haiku 4.6`) | VS Code's silent-ignore → fallback behavior on a resolution miss (target is not reliably the picker; may be an internal/coding-task default) |
| Each agent's `agents:` frontmatter scope (already correct, unaffected by this task) | The Explore (Code Research) built-in subagent's model, unless the user sets `exploreAgent.model`/`enabled` manually |
| — | Internal VS Code operations (request/title summarization) that run on a cheap default regardless of custom-agent config |

100% enforcement is structurally out of reach for a generator that only writes
`*.agent.md` frontmatter at install time: VS Code resolves the effective model at
dispatch time, inside an extension that is not statically inspectable from this repo
(no local `copilot-chat` entry in the VS Code extensions manifest, and the bundle is
minified regardless). The array mechanism above is the best available static lever —
it does not eliminate the miss, it bounds where a miss lands.

## Descoped

The following were planned (Phase 3 in the task) and **deliberately not implemented**:

- **Generate-time hard-fail allowlist** — validating every emitted `model:` string
  against a configured allowlist of real VS Code Copilot display names, and failing
  `generate`/`install` on an unknown or non-catalog string.
- **Runtime model self-report** — a prompt-level instruction for each agent to state its
  actually-running model at the top of its output, so a silent VS Code fallback becomes
  visible to a human or the orchestrator.

Both remain a reasonable next step if the fallback-array mitigation in this ADR proves
insufficient in practice, but the user chose to close this task with the fallback-array
fix (Phase 1) plus this documentation, rather than build additional guardrail code.

## Implementation Phases

| Phase | What Changed |
| --- | --- |
| 1. Fallback arrays | `scripts/generate.js` `COPILOT_TIER_FALLBACKS`/`copilotPrimaryTier()`; `defaults/config.json` opus/sonnet → `5`, explicit researcher/committer haiku overrides; all six `generated/copilot/agents/*.agent.md` regenerated. Committed `71a7981`. |
| 2. Explore subagent control | Resolved as documentation only (this ADR) — no installer change shipped. |
| 3. Guardrails + tests | Descoped — not implemented. |
| 4. Docs + ADR | This document. |

## Consequences

- **Positive:** a resolution miss on any framework agent now lands within the correct
  model tier instead of an arbitrary vendor/version, closing the highest-severity
  observed failure (Builder on a non-Claude model). The one always-triggering bug
  (nonexistent `Claude Haiku 4.6`) is fixed at the repo-default level.
- **Negative / cost:** the framework still cannot force 100% determinism — the Explore
  subagent's model and VS Code's exact silent-fallback target remain outside repo
  control and require a manual per-user VS Code setting or acceptance of the residual
  risk. No automated guardrail (allowlist, self-report) exists yet to detect a miss when
  it does happen.
- **Neutral:** the `haiku` tier's real safety net is cross-tier (`Claude Sonnet 5`), not
  another haiku model, because no Claude Haiku model is currently ENABLED in the catalog
  — a deliberate, surfaced trade-off rather than an oversight.

## Manual Steps for Users

1. **Fix a stale personal config.** If `~/.agents/config.json` has `models.haiku` set to
   a nonexistent version (e.g. `"4.6"`), change it to `"4.5"` (the only real Haiku
   version at the time of writing), and add explicit `agents.researcher`/
   `agents.committer` haiku overrides if missing, then run `make install` to regenerate.
2. **Address Haiku-quality VS Code exploration**, if observed: in VS Code settings, set
   `github.copilot.chat.exploreAgent.model` to a real catalog string (e.g.
   `"Claude Sonnet 5 (Copilot)"`), or set `github.copilot.chat.exploreAgent.enabled` to
   `false` to disable the built-in Explore subagent entirely. The framework installer
   does not set either key.

## See Also

- `.tasks/101-deterministic-model-selection/task.md` — the full multi-round
  investigation, including the superseded CLI-runtime analysis (rounds 1-4) and the
  corrected VS Code Copilot Chat runtime analysis (round 5+).
- [ADR-009](ADR-009-non-claude-model-types.md) — the `MODEL_TYPES` registry and
  per-agent `agents.<name>.copilot` override this task builds on.
- Commit `71a7981` — `fix(generate): emit per-tier same-tier model fallback arrays for
  VS Code Copilot`.
