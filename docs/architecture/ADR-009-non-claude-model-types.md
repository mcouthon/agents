# Non-Claude Model Types for Copilot

**Source:** Task 085 (June 2026)

## Decision

Introduce a `MODEL_TYPES` registry as the single source of truth for model-type rendering. Extend the `models` config map to accept non-Claude types (e.g. `gpt`) as first-class peers of Claude tiers. Add a per-agent `agents` config section that overrides which type a given agent uses for Copilot output. CC output remains Claude-only by structural enforcement in the registry.

## Why

- Users running GitHub Copilot want to direct specific agents (e.g. the Conductor) to GPT-class models without editing committed templates
- The previous `resolveModels` hardcoded the string `"Claude"` — there was no extension point for non-Claude vendors
- Per-agent overrides follow the established `agentTools` convention (same agent-name keying) to keep the config shape consistent
- CC must stay Claude-only; gating the override on `platform === "copilot"` and marking `gpt` as `platforms: ["copilot"]` in the registry makes this a structural guarantee rather than a policy comment

## Problem Statement

Before this change:

- `resolveModels` in `scripts/generate.js` hardcoded `Claude ${tierName} ${version} (copilot)` — no way to emit non-Claude strings
- `readConfig` warned on any type outside `["opus", "sonnet", "haiku"]` — `"gpt"` was a validation error
- There was no config-level way to reassign an agent's model type; the template was the only source of truth for which tier each agent used

A user who wanted Copilot's Conductor to use GPT had to edit `templates/agents/conductor.template.md` directly — a committed file that would conflict with repo updates.

## Solution

### Before

```javascript
// scripts/generate.js — hardcoded vendor
function resolveModels(modelSpec, config, platform) {
  const version = config.models[tier] || "4.5";
  if (platform === "copilot") {
    return `Claude ${Tier} ${version} (copilot)`; // "Claude" hardcoded
  }
  return tier;
}
```

```json
// readConfig allowed types — hardcoded
["opus", "sonnet", "haiku"]
```

### After

```javascript
// MODEL_TYPES registry — single source of truth for rendering
const MODEL_TYPES = {
  opus:   { family: "Claude Opus",   separator: " ", platforms: ["copilot", "cc"] },
  sonnet: { family: "Claude Sonnet", separator: " ", platforms: ["copilot", "cc"] },
  haiku:  { family: "Claude Haiku",  separator: " ", platforms: ["copilot", "cc"] },
  gpt:    { family: "GPT",           separator: "-", platforms: ["copilot"] },
};

function resolveModels(modelSpec, config, platform, agentName) {
  // 1. Apply per-agent override (copilot only)
  if (platform === "copilot" && config.agents?.[agentName]?.copilot) {
    type = config.agents[agentName].copilot;
  }
  const { family, separator, platforms } = MODEL_TYPES[type];
  // 2. CC-isolation: fall back to template type if type not valid for platform
  if (!platforms.includes(platform)) { /* use template default */ }
  // 3. Render
  if (platform === "copilot") {
    return `${family}${separator}${version} (copilot)`;
  }
  return type;
}
```

```json
// ~/.agents/config.json — user config
{
  "models": { "opus": "4.6", "sonnet": "4.6", "haiku": "4.5", "gpt": "5.5" },
  "agents": {
    "conductor": { "copilot": "gpt" }
  }
}
```

Result for the Conductor agent:
- Copilot output: `model: ["GPT-5.5 (copilot)"]`
- CC output: `model: opus` (unchanged — template default)

## Key Architectural Decisions

### Registry as Single Source of Truth

The `MODEL_TYPES` registry centralizes three formerly scattered concerns:

| Property     | Was                                      | Now                                  |
| ------------ | ---------------------------------------- | ------------------------------------ |
| Vendor name  | Hardcoded `"Claude"` string in function  | `family` field per type              |
| Separator    | Implicit (space, Claude convention)      | `separator` field per type           |
| CC validity  | Implicit (everything was Claude)         | `platforms` field per type           |
| Valid types  | Hardcoded array in `readConfig`          | Derived from `Object.keys(MODEL_TYPES)` |

Adding a new vendor (e.g. Gemini) is a one-line registry entry.

### Config `models` stays a flat type→version map

An earlier design proposed `{ version, copilot }` per-tier objects. This was rejected: asymmetric value shapes complicate existing readers, and the version is the same concept regardless of platform. The flat string map is preserved; the registry provides all rendering metadata.

### Per-agent override lives in `agents` config, not templates

Alternatives considered:

| Option                                         | Rejected because                                          |
| ---------------------------------------------- | --------------------------------------------------------- |
| Edit `model:` in the template directly         | Commits a vendor-specific choice into shared templates    |
| Remap an existing Claude tier to GPT in `models` | Semantically wrong; a tier is a capability level, not a vendor |
| Flatten override into `models` (e.g. `conductor-copilot`) | No existing convention; breaks type→version semantics |
| New `agentModels` top-level key                | Diverges from the `agentTools` naming; no benefit        |

The chosen shape (`agents: { agentName: { copilot: type } }`) mirrors `agentTools` exactly — same agent-name key, same platform-keyed value. This makes the config surface internally consistent and leaves room for a future `cc` key without a schema break.

### CC output is Claude-only by structural enforcement

Non-Claude overrides are silently ignored for CC. The enforcement mechanism is structural:

1. The registry marks `gpt` as `platforms: ["copilot"]` — CC is absent
2. `resolveModels` checks `platforms.includes(platform)` and falls back to the template's CC type when the overridden type is not valid for the platform
3. No `cc` key is honored in the `agents` override for this task (reserved in the schema, not implemented)

This means a user cannot accidentally route a CC agent to GPT by misconfiguring `config.json` — the generator ignores it and the CC output is byte-identical to the no-override case.

### `defaults/config.json` left unchanged (opt-in)

The `gpt` type and `agents` section are not added to `defaults/config.json`. Rationale: `migrate-config.js` adds missing top-level keys from defaults to existing user configs. Adding `agents` to defaults would auto-propagate an empty `agents: {}` to all users on next install — low harm but unnecessary churn. Non-Claude models remain opt-in: users add `gpt` to their `models` map and `agents` entries manually.

## Implementation Phases

| Phase | What Changed                                                                                  |
| ----- | --------------------------------------------------------------------------------------------- |
| 1     | `MODEL_TYPES` registry in `scripts/generate.js`; `resolveModels` renders from registry; CC output unchanged |
| 2     | `readConfig` derives allowed types from `Object.keys(MODEL_TYPES)`; `gpt` accepted without warning |
| 3     | `agents` config section; `agentName` threaded into `resolveSectionModels` → `resolveModels`; CC-isolation enforced |
| 4     | Tests 28-32 in `tests/test-generate.sh`: registry rendering, GPT override, CC isolation, no-override regression |
| 5     | Migration round-trip test; `models.gpt` + `agents` survive `migrate-config` + install; CC isolation verified |
| 6     | README, templates/README, CHANGELOG docs                                                       |

## Extends

- [ADR-006 Personalization Framework](ADR-006-personalization-framework.md) — introduced the `models` config map and tier-based resolution. This ADR extends that model to support non-Claude vendors without changing the flat `type → version` map shape.

## Out of Scope

- Non-Claude models for Claude Code (CC runs Claude-only; the `cc` key in `agents` is reserved but not honored)
- Validating that a chosen model is available in the user's Copilot subscription (Copilot handles fallback at runtime)
- Changing how templates declare their default type (templates keep `model: <type>` unchanged)
