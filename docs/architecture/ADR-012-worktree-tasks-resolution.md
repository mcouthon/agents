# Concurrent Workloads in a Shared Checkout

**Source:** Task 096, Phases 1–3 (July 2026)

## Decision

Support N concurrent task workflows that share one git checkout with a
**two-pronged** approach:

1. **Pathspec-scoped Reviewer / Committer (Phases 1–2)** — defense-in-depth for the
   *shared-foreground-tree* case (multiple foreground chats in one window, which by
   definition share one working tree, index, and `HEAD`). The Reviewer inspects
   changes only via `git diff -- <paths-from-manifest>` and the Committer stages /
   commits only the phase's `## Files Modified` paths. Foreign concurrent edits become
   invisible; neither agent is tempted into per-file diff loops or patch-staging.
2. **Git worktrees + auto-derived shared `.tasks/` (Phase 3)** — the primary
   *true-isolation* path. One `git worktree` per workstream gives each workload its own
   working tree, index, and `HEAD`, eliminating the shared-checkout race at the git
   layer. The MCP state server (`scripts/state-server.js`) auto-derives the repo's
   **main worktree root** inside `resolveProjectDir` and resolves `.tasks/` there, so a
   linked worktree rolls up to its primary checkout and every worktree of a repo shares
   one `tasks.json` dashboard — with **zero manual configuration**.

The two prongs are complementary: worktrees are the recommended isolation path when a
workstream can run in its own window (or via background/cloud agents), while pathspec
scoping is the load-bearing fallback for the foreground-multi-chat runtime that
worktrees cannot isolate.

### Path resolution (per tool call)

`resolveProjectDir(callProjectDir)` resolves in this order, deriving the main worktree
root of the selected candidate:

1. **`project_dir` arg** present → `deriveMainWorktreeRoot(arg)`.
2. **`CLAUDE_PROJECT_DIR`** set → `deriveMainWorktreeRoot(env)`.
3. **else** → warn to stderr, then `deriveMainWorktreeRoot(process.cwd())`.

`deriveMainWorktreeRoot(candidate)` runs at most one git invocation:
`git -C <candidate> rev-parse --path-format=absolute --git-common-dir`
(via `execFileSync`, fixed-arg array, no shell, 1s timeout, `LC_ALL=LANG=C`). The
common dir resolves to `<main>/.git`, whose parent is the main worktree root. It is
a **no-op for a primary/non-worktree candidate** (result equals the candidate,
byte-for-byte backward compatible) and rolls a **linked worktree up to its primary**.

### Committer worktree-root wording

The committer instruction "always run git commands from the repo root" is reworded
to "run git commands from your worktree root (your current working directory); under
`git worktree` this is the worktree, not the main checkout" (inside the CC-only block).

## Why

- **The system assumed one task == one clean working tree.** Git's working tree, index,
  and `HEAD` are process-global per checkout, so concurrent workloads see the union of
  each other's uncommitted changes. Pathspec scoping makes each Reviewer/Committer blind
  to foreign edits; worktrees remove the sharing entirely.
- **`.tasks/` is untracked** in consumer repos, so a fresh linked worktree has no
  `.tasks/` of its own. Rolling every worktree up to the repo's main checkout is what
  keeps ONE dashboard across worktrees without any tracked state.
- **Zero config in the normal case:** single checkouts and multi-worktree setups both
  Just Work with no env var and no template pinning. The Conductor keeps passing the
  per-session workspace root exactly as before; derivation on that arg is what keeps
  `.tasks/` shared on Claude Code (which auto-points `CLAUDE_PROJECT_DIR` at the
  worktree) in the unconfigured case.
- **Repo-scoped, not machine-wide:** git auto-derivation is per-repo — each repo's
  worktrees roll to that repo's own main, so per-project isolation is preserved. A
  machine-wide pin would wrongly collapse every repo's `.tasks/` into one directory.
- **Structural git isolation** (separate working tree / index / `HEAD` per worktree)
  removes the git-safety need for a cross-workload ownership guard; the shared-foreground
  fallback stays covered by the Phase 1–2 pathspec scoping.

## Problem Statement

Running concurrent workstreams in one shared checkout means every `git status` /
`git diff` / `git add` sees the union of all workstreams' uncommitted changes. This
drove the Reviewer into per-file `git diff -- <path>` loops and the Committer into
patch-staging to isolate "its" files. Worktrees give each workstream its own working
tree, index, and `HEAD` — but because `.tasks/` is untracked, a naive per-worktree
`.tasks/` would split the unified dashboard, and a machine-wide env pin would wrongly
collapse unrelated repos. The resolution logic needed to share `.tasks/` per-repo
automatically, without manual setup, without ever breaking a plain single checkout, and
without throwing when git is old, missing, or the directory is not a repo.

## Key Architectural Decisions

### Pathspec scoping as defense-in-depth (Phases 1–2)

The per-phase `## Files Modified` manifest is the pathspec the Reviewer and Committer
scope every git operation to. This is load-bearing for the foreground-multi-chat
runtime, where multiple chats in one window share one working tree and worktrees provide
no isolation.

### Derive the explicit `project_dir` arg (not just env/cwd)

The Conductor keeps passing the workspace root (= the linked worktree) exactly as
today. Because `deriveMainWorktreeRoot` is idempotent, repo-scoped, and a no-op for
primary worktrees, applying it to the arg preserves "caller authoritative" for every
non-worktree use (result == arg) while rolling linked worktrees up to their own repo's
main — no Conductor change required.

### Never throws; one-time stderr hint on old/missing git

Any failure (not a repo, no git, bare repo, `--separate-git-dir`, timeout, unparseable
output) falls back to the candidate directory. The common "not a git repository" case
stays silent (expected for non-git projects and tmp dirs; classification is
locale-hardened via `LC_ALL=LANG=C`). The old-git (< 2.31, which lacks
`--path-format`) / missing-git / parse-failure cases additionally emit a **one-time**
stderr hint (module-level flag, never stdout — stdout carries the MCP protocol)
suggesting an upgrade to git >= 2.31.

### `worktree` helper + docs

`scripts/worktree.js` (Node, `npm run worktree`) provides `add`/`open`/`merge`/
`remove`/`list`. README/AGENTS document the worktree-per-window workflow, the
auto-derived shared `.tasks/`, the foreground caveat, and the background-agent option.

## Consequences

- **Positive:** concurrent workloads are safe in both runtimes — worktrees give
  structural git isolation with a single shared dashboard and zero configuration, and
  pathspec scoping covers the irreducibly shared foreground case. Single checkouts are
  byte-for-byte unchanged; different repos keep their own `.tasks/`; resolution never
  throws.
- **Negative / cost:** one git invocation per resolved candidate (memoized per process);
  old/missing git loses the rollup and falls back to per-worktree `.tasks/` (with a
  one-time hint); pathspec scoping relies on an accurate `## Files Modified` manifest.
- **Neutral:** the normal path needs no env var at all; the Conductor keeps passing the
  workspace root unchanged.

## See Also

- [ADR-011](ADR-011-machine-readable-state.md) — the MCP state server and `state.json`
  shadow whose `resolveProjectDir` this decision extends with git auto-derivation.
- [ADR-002](ADR-002-task-centric-persistence.md) — the `.tasks/` persistence pattern.
- `.tasks/096-concurrent-workloads-shared-tree/` — the implementing task (Phases 1–2
  pathspec scoping; Phase 3 worktree support).
