# Personalization Framework

**Source:** Task 035 (March 2026)

## Decision

Replace symlink-based installation with copy-based installation using manifest tracking, enabling per-user model configuration without modifying committed files.

## Why

- Symlinks expose committed `generated/` files directly — any user customization would dirty the repo
- Users want different Claude model versions (e.g., stick with 4.5 vs upgrade to 4.6)
- Install/uninstall needed deterministic tracking — symlinks had no authoritative list of what was installed
- Migration from old installs needed a clear path

## Problem Statement

The original install flow symlinked `~/.copilot/agents/*` → `generated/copilot/agents/*`. This meant:

1. Users couldn't customize model versions without modifying committed templates
2. Multiple users sharing a repo saw different installed state based on symlink targets
3. Uninstall had to guess which symlinks belonged to the framework
4. No way to detect what changed between installs

## Solution

### Before

```
templates/ → generate.js → generated/ → symlink → ~/.copilot/
                                 ↑
                           (committed files)
```

Users had to edit `templates/agents/*.template.md` to change models.

### After

```
templates/ → generate.js → generated/     (committed, repo default)
                  ↓
             (at install time)
                  ↓
         ~/.agents/config.json → generate.js → temp/ → copy → ~/.copilot/
                                                 ↓
                                         ~/.agents/manifest.txt
```

- `defaults/config.json` defines repo defaults (committed)
- `~/.agents/config.json` overrides for the user (not committed, created on first install)
- `generate.js --config --output-dir` supports generating to arbitrary locations
- `install.sh` generates to temp, copies to targets, writes manifest
- Manifest tracks every installed file path for deterministic uninstall

## Implementation Phases

| Phase | What Changed                                                              |
| ----- | ------------------------------------------------------------------------- |
| 1a    | generate.js: add `--config`, `--output-dir` flags; model tier resolution  |
| 1a    | Templates: replace hardcoded model strings with tier names (opus, sonnet) |
| 1a    | install.sh: copy-based install with manifest tracking                     |
| 1a    | Symlink migration for legacy installs                                     |

## Key Architectural Patterns

### Model Tier Resolution

Templates use tier names, resolved at generation time:

```yaml
# templates/agents/explorer.template.md
copilot:
  model: opus # tier name, not full string
```

```javascript
// scripts/generate.js
function resolveModels(modelSpec, config, platform) {
  const version = config.models[tier] || "4.5";
  if (platform === "copilot") {
    return `Claude ${Tier} ${version} (copilot)`;
  }
  return tier; // CC uses tier name directly
}
```

### Manifest-Based Tracking

```bash
# ~/.agents/manifest.txt
# Installed by AGENTS framework — do not edit
# Generated: 2026-03-13T10:00:00Z
/Users/user/.copilot/agents/builder.agent.md
/Users/user/.copilot/agents/explorer.agent.md
...
```

Uninstall reads manifest and removes exactly those files.

### Copy with Change Detection

```bash
copy_tree() {
    # ... for each file:
    if [[ -f "$dest_file" ]] && ! diff -q "$file" "$dest_file"; then
        CHANGED_FILES+=("$dest_file")
    fi
    cp "$file" "$dest_file"
    MANIFEST_LINES+=("$dest_file")
}
```

Reports changed files only — silent for no-op re-installs.

## Current Structure

```
defaults/
└── config.json           # Repo defaults (committed)

~/.agents/
├── config.json           # User overrides (not committed)
└── manifest.txt          # Installed file paths

scripts/
└── generate.js           # --config, --output-dir, model resolution
```

## Deleted

- `link_files()`, `link_dirs()`, `unlink_files()`, `unlink_dirs()` — symlink helpers
- Hardcoded model strings in agent templates
- Implicit `~/.agents/config.json` fallback in generate.js (now explicit `--config` flag)
