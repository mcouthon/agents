---
name: keyboard-first-ui
description: "Build keyboard-first, information-dense, AI-present interfaces for power-user apps. Covers data-table row patterns, keyboard navigation layers, contextual AI integration, liveness patterns, navigation chrome, visual impact planning, and construction checklists. Triggers on: 'keyboard first', 'keyboard ui', 'data table', 'power user ui', 'information dense', 'keyboard shortcuts', 'row component', 'detail panel', 'command palette', 'liveness', 'skeleton loading', 'activity indicator', 'real-time updates', 'sidebar rail', 'nav chrome', 'navigation chrome', 'sidebar navigation', 'visual impact planning', 'phase sizing', 'keyboard conflict', 'keyboard priority', 'connection status', 'wow factor', 'anti-patterns', 'screenshot test'. Full access mode."

cc:
  allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# Keyboard-First UI Construction Manual

Patterns and checklists for power-user interfaces: information-dense, fully keyboard-operable, AI-present. Stack: React + TypeScript + Tailwind CSS. Adapt token names to your design system.

---

## 0. When to Use This Skill

### Target Archetype

This skill is for **power-user tools** — apps where the primary user is a daily-driver who values speed, density, and keyboard mastery over discoverability and onboarding.

**Good fits:** personal dashboards, admin consoles, developer tools, triage interfaces, AI command centers, ops tools.

**Not for:** marketing sites, onboarding flows, consumer apps prioritizing discoverability, or tools where most users are occasional visitors. For those, use `/design` alone.

### Relationship with /design

The `/design` skill builds your **visual foundation** — tokens, typography, color, shadows, animation system, component styling. This skill layers **interaction architecture** on top: keyboard navigation, information density, AI presence, page structure.

**Workflow:** Start with `/design` for tokens and primitives → apply this skill for page structure and interaction patterns.

When both skills apply, this skill **overrides** these `/design` defaults:

| `/design` default                     | `keyboard-first-ui` override                              | Why                                   |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| Card variants for content display     | 36–40px flat rows for lists; cards for detail panels only | Density — 3× more items visible       |
| PageHeader with title/description     | SectionLabel (ALL-CAPS, 11px, count + meta)               | Vertical space — ~60px saved per page |
| Generous spacing personality          | Dense spacing default                                     | Power users scan, not browse          |
| Layered shadow depth for premium feel | Borders-only or minimal shadows                           | Shadows don't aid scan-line rhythm    |

Everything not in this table follows `/design` as-is. The two skills are complementary, not competing.

---

## 1. Principles

1. **Dense over spacious.** Every pixel earns its place. List rows are 36–40px. Cards are for detail panels — not data grids.
2. **Keyboard-first.** Any task achievable by mouse must be achievable by keyboard. `j`/`k` to move, Enter to act, Escape to retreat.
3. **AI is a first-class citizen.** Contextual "Ask AI" buttons are surface-level — not buried in menus or settings.
4. **Signal over decoration.** Color, weight, and icons carry semantic meaning. No chrome for its own sake.
5. **Progressive reveal.** Actions appear on hover/focus — they don't consume permanent space.
6. **The interface feels alive.** Background activity is visible — pulse indicators, shimmer loading, real-time updates. Static screens feel broken.

---

## 2. Component Patterns

> **Token convention:** Code examples below use raw Tailwind values
> (`text-[11px]`, `bg-white/[0.03]`) for portability. In your project,
> replace these with semantic tokens from your design system:
>
> | Example value              | Replace with        | Purpose             |
> | -------------------------- | ------------------- | ------------------- |
> | `text-[11px]`              | `text-caption`      | Caption/label text  |
> | `text-[13px]`              | `text-body-sm`      | Body text (small)   |
> | `bg-white/[0.03]`          | `bg-surface-hover`  | Subtle hover state  |
> | `text-primary/70`          | `text-accent-muted` | Muted accent text   |
> | `text-muted-foreground/50` | `text-faint`        | Faintest text level |
>
> See the `/design` skill for building your token system.

> **Theme note:** Examples use dark-mode-first values. For light mode,
> invert the opacity pattern: `bg-black/[0.03]` instead of `bg-white/[0.03]`.

### 2.1 Section Label

Replace generic page `<h1>` headers with a structured label: ALL-CAPS entity name · count + optional meta + far-right action cluster.

```tsx
interface SectionLabelProps {
  label: string; // ALL-CAPS, e.g. "ISSUES"
  count?: number;
  meta?: string; // e.g. "12 unread"
  actions?: React.ReactNode;
}

function SectionLabel({ label, count, meta, actions }: SectionLabelProps) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {count !== undefined && (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">
          · {count}
        </span>
      )}
      {meta && (
        <span className="ml-auto text-[11px] text-muted-foreground/50">
          {meta}
        </span>
      )}
      {actions && (
        <div className={cn("flex items-center gap-1.5", !meta && "ml-auto")}>
          {actions}
        </div>
      )}
    </div>
  );
}
```

---

### 2.2 Data-Table Row (36–40px)

All list views use flat, fixed-height rows. Never use cards for data grids.

**Anatomy:**

```
[Visual] [Identifier] [Title ·············] [Meta] [Timestamp] [Hover actions]
```

- **Visual** — status dot, priority bars, or source icon (14px, `shrink-0`)
- **Identifier** — short ID, `font-mono text-[11px] tabular-nums text-primary/70 shrink-0`
- **Title** — `min-w-0 flex-1 truncate text-[13px]`, bold for unread, muted for seen
- **Timestamp** — `w-8 font-mono text-[11px] tabular-nums text-muted-foreground/50 shrink-0`
- **Hover actions** — `opacity-0 group-hover:opacity-100`, 28px icon buttons

```tsx
function DataRow({
  id,
  title,
  isNew,
  isFocused,
  isActive,
  timestamp,
  onSelect,
  onAction,
  rowRef,
}) {
  return (
    <div
      ref={rowRef}
      role="row"
      tabIndex={-1}
      aria-selected={isActive}
      onClick={onSelect}
      className={cn(
        "group flex items-center h-9 px-3 gap-2 cursor-pointer border-b border-border transition-colors duration-75",
        "hover:bg-white/[0.03]",
        isActive && "bg-primary/[0.08] border-l-2 border-l-primary",
        isFocused && !isActive && "bg-white/[0.05]",
        isFocused && "ring-1 ring-inset ring-primary/30",
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          isNew ? "bg-blue-400" : "bg-muted-foreground/40",
        )}
      />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-primary/70">
        {id}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          isNew ? "font-medium" : "text-muted-foreground",
        )}
      >
        {title}
      </span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <span className="w-8 text-right font-mono text-[11px] tabular-nums text-muted-foreground/50">
          {timestamp}
        </span>
      </div>
      {/* Hover action cluster — see Section 2.2 hover pattern */}
      <div
        className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip content="Archive (e)">
          <button
            type="button"
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-raised"
            onClick={() => onAction("archive")}
            aria-label="Archive"
          >
            <Archive size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Ask AI (a)">
          <button
            type="button"
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-raised"
            onClick={() =>
              askAI(navigate, `Tell me about: "${title}" (ID: ${id})`)
            }
            aria-label="Ask AI"
          >
            <MessageSquare size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
```

---

### 2.3 Slide-Over Drawer (Detail Panel)

Detail views open as a right-side slide-over (~55vw) — not inline expansion, not a modal. Row click or Enter opens it; Escape or backdrop click closes it.

```tsx
function SlideOver({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          onClick={onClose}
          aria-hidden
        />
      )}
      <div
        className={cn(
          "fixed right-0 top-0 bottom-0 z-50 w-[55vw] max-w-3xl bg-surface border-l border-border",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex flex-col h-full overflow-hidden">{children}</div>
      </div>
    </>
  );
}
```

Escape must close the drawer before the page's list-navigation Escape handler fires — use capture or priority ordering in your keyboard hook.

---

### 2.4 Shared Primitives (Required on Every Page)

```tsx
<SkeletonRow />    {/* repeat 8–12×, same height as real row — loading state */}

<EmptyState        {/* empty state */}
  icon={Inbox} title="No items"
  description="Items appear here once ingested."
  action={<Button size="sm">Refresh</Button>}
/>

<ErrorBanner message="Failed to load." onRetry={refetch} />  {/* error state */}
```

---

## 3. Navigation Chrome

The sidebar rail IS the chrome. No top header bar, no hamburger menu. A narrow icon rail on the left provides navigation, ambient status, and grouping — always visible, never collapsible.

### 3.1 Sidebar Rail

A narrow command rail (48–56px wide) — not a full sidebar with text labels. Monochrome icons only; text labels appear as tooltips on hover.

**Active states — opacity-based, not color-based:**

| State    | Style                                       |
| -------- | ------------------------------------------- |
| Inactive | Icon at 40% opacity, no background          |
| Hover    | Icon at 70% opacity, no background          |
| Active   | Icon at 90% opacity, `bg-white/[0.05]` fill |

No borders, no accent colors, no colored backgrounds on active items. The subtle 5% white fill is the only differentiation — this keeps the rail calm and monochrome.

**Grouping — organize by function, not alphabet:**

| Group   | Contents                                      | Position    |
| ------- | --------------------------------------------- | ----------- |
| Primary | Core workflows the user visits daily          | Top         |
| Admin   | Settings, configuration, system management    | Bottom area |
| System  | Connection status, theme toggle, user/profile | Rail footer |

Separate groups with subtle spacing (8–12px gap), not dividers or labels.

```tsx
interface NavItemProps {
  icon: React.ComponentType<{ size?: number }>;
  label: string; // Tooltip text
  path: string;
  isActive: boolean;
  badge?: number; // Unread/active count
  pulse?: boolean; // Activity indicator (cross-ref §5.1)
}

function NavItem({
  icon: Icon,
  label,
  path,
  isActive,
  badge,
  pulse,
}: NavItemProps) {
  return (
    <Tooltip content={label} side="right">
      {/* Replace with your router's <Link> or onClick + navigate */}
      <button
        onClick={() => navigate(path)}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex items-center justify-center w-10 h-10 rounded-md transition-all duration-150",
          isActive
            ? "bg-white/[0.05] text-foreground/90"
            : "text-foreground/40 hover:text-foreground/70",
        )}
      >
        <Icon size={18} />
        {badge !== undefined && badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-primary text-[9px] font-medium text-primary-foreground flex items-center justify-center px-0.5">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        {pulse && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
```

**Adding a nav item:** one `NavItem` in the appropriate group. Wire `isActive` to the current route. Use a monochrome icon from your icon library (Lucide, Heroicons, etc.) — no custom colored SVGs.

Rail items are reachable via `g + letter` chord navigation (see Keyboard Architecture, Layer 1) — Tab-based rail traversal is unnecessary since chord navigation is faster for power users.

---

### 3.2 Ambient Status

System status lives in the sidebar — not a header bar, not a toast, not a modal.

**Where status belongs:**

| Indicator                 | Location                 | Cross-reference         |
| ------------------------- | ------------------------ | ----------------------- |
| Connection health dot     | Rail footer              | §5.3 `ConnectionStatus` |
| Background activity pulse | On the relevant nav item | §5.1 `ActivityPulse`    |
| Unread/active count badge | On the relevant nav item | `NavItem` `badge` prop  |

- **Connection dot:** Always visible in the rail footer. Green/amber/red (see §5.3). The user should never have to click to discover connectivity state.
- **Activity pulse:** When a section has background work running (syncing, processing, indexing), its nav item shows a small emerald pulse dot. This replaces spinners or toast messages.
- **Badge counts:** Unread counts or active item counts on nav items. Use sparingly — only for items that genuinely need attention. A nav rail full of badges is noise.

---

### 3.3 No Header Bar

Traditional header bars (logo + nav links + search + avatar) waste 44–64px of vertical space and duplicate functionality that belongs elsewhere.

**Where header bar contents go instead:**

| Traditional header element | Keyboard-first location                                       | Why                                           |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Logo / app name            | Not needed — daily-driver users know what app they're in      | Reclaim 44px+ vertical space                  |
| Navigation links           | Sidebar rail (§3.1)                                           | Always visible, grouped by function           |
| Search bar                 | Command palette trigger `⌘K` (Keyboard Architecture, Layer 3) | Search is an action, not a fixture            |
| User avatar / menu         | Rail footer or command palette                                | Infrequent action, doesn't earn top-row space |
| Theme toggle               | Rail footer or command palette                                | One-time setting, not persistent chrome       |
| Notifications bell         | Badge count on relevant nav item                              | Contextual, not generic                       |

**The math:** A 44px header on a 900px viewport is ~5% of your screen permanently consumed by chrome. On a 36–40px-row layout, that's ~1.2 rows of data you'll never get back. The sidebar rail costs ~52px of horizontal space but gives you the full vertical viewport for content.

**The sidebar IS the chrome.** Navigation, status, and identity all live in the rail. The main content area is 100% data.

---

## 4. Keyboard Architecture

Four layers, always present. Register all four when adding a new page.

### Layer 1 — Global Navigation (`g` + letter)

Chord-based routing, wired once at app root.

```tsx
const GO_TARGETS: Record<string, { label: string; path: string }> = {
  i: { label: "Inbox", path: "/inbox" },
  t: { label: "Tasks", path: "/tasks" },
  c: { label: "Chat", path: "/chat" },
  s: { label: "Settings", path: "/settings" },
  // one entry per top-level section
};

// In root layout:
useEffect(() => {
  let gPending = false;
  const onKey = (e: KeyboardEvent) => {
    if (isInputFocused()) return;
    if (e.key === "g") {
      gPending = true;
      setTimeout(() => {
        gPending = false;
      }, 1000);
      return;
    }
    if (gPending && GO_TARGETS[e.key]) {
      navigate(GO_TARGETS[e.key].path);
      gPending = false;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [navigate]);
```

**Adding a page:** one entry in `GO_TARGETS`, unused letter.

---

### Layer 2 — List Navigation (`j`/`k` cursor)

Per-page hook. Manages focused index, scrolls into view, dispatches action keys.

```tsx
function useListKeyboard({ itemCount, onNavigate, onAction, enabled = true }) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, itemCount - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && focusedIndex >= 0)
        onNavigate?.(focusedIndex);
      else if (e.key === "Escape") setFocusedIndex(-1);
      else if (focusedIndex >= 0) onAction?.(e.key, focusedIndex);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, focusedIndex, itemCount, onNavigate, onAction]);
  return { focusedIndex, setFocusedIndex };
}

const isInputFocused = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement)?.isContentEditable
  );
};
```

Pass `isFocused={focusedIndex === index}` to each row and a `rowRef` callback for scroll-into-view. Disable the hook while drawer or search are open.

> **Implementation note:** The `focusedIndex` read inside the `keydown`
> handler may be stale due to closure capture. Use a ref
> (`focusedIndexRef.current`) or a reducer for production code.

---

### Layer 3 — Command Palette (⌘K)

Global fuzzy search + action launcher. Opens with `⌘K`, Escape closes.

```tsx
function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const results = useSearch(query); // entity + action search
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl p-0">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or jump to…"
          className="w-full px-4 py-3 bg-transparent text-[14px] outline-none border-b border-border"
        />
        <ul role="listbox" className="max-h-96 overflow-y-auto py-1">
          {results.map((r) => (
            <CommandResult key={r.id} result={r} onSelect={onClose} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
```

Every result should offer an "Ask AI about this" secondary action.

---

### Layer 4 — Shortcut Bar + Overlay

**ShortcutBar** — persistent bottom strip, route-driven hints.

```tsx
function getHints(pathname: string): Hint[] {
  if (pathname === "/inbox")
    return [
      { keys: ["j", "k"], label: "navigate" },
      { keys: ["↵"], label: "open" },
      { keys: ["e"], label: "archive" },
      { keys: ["a"], label: "ask AI" },
      { keys: ["?"], label: "help" },
    ];
  // ... per-page branches
  return [
    { keys: ["g…"], label: "go to" },
    { keys: ["⌘K"], label: "search" },
    { keys: ["?"], label: "help" },
  ];
}
```

**ShortcutOverlay** — full reference opened with `?`.

```tsx
const SECTIONS: ShortcutSection[] = [
  {
    heading: "Navigation",
    rows: [
      { keys: [["g"], ["i"]], label: "Go to Inbox" },
      // one row per GO_TARGET
    ],
  },
  {
    heading: "Global",
    rows: [
      { keys: [["⌘K"]], label: "Command palette" },
      { keys: [["?"]], label: "Keyboard reference" },
      { keys: [["Esc"]], label: "Close / cancel" },
    ],
  },
  {
    heading: "List pages",
    rows: [
      { keys: [["j"], ["k"]], label: "Next / Previous" },
      { keys: [["↵"]], label: "Open item" },
      { keys: [["a"]], label: "Ask AI about item" },
      { keys: [["/"]], label: "Focus search" },
    ],
  },
  // append one section per page
];
```

**Adding a page:** one `Hint[]` branch in `getHints()` + one `ShortcutSection` in `SECTIONS`.

---

### Layer Priority & Conflict Resolution

When multiple layers could handle the same keypress, highest priority wins. Lower layers must not fire.

| Priority    | Layer                     | Example                                                |
| ----------- | ------------------------- | ------------------------------------------------------ |
| 1 (highest) | Modal / Drawer focus trap | `Escape` closes drawer before clearing list focus      |
| 2           | Command palette           | `Escape` closes palette; typing routes to search input |
| 3           | List navigation           | `j`/`k`/`Enter` when no overlay is open                |
| 4 (lowest)  | Global navigation         | `g`+letter chords                                      |

**Implementation pattern — `enabled` booleans:**

Each layer's hook accepts an `enabled` flag. Disable lower layers when a higher layer is active:

```tsx
// Page component
const [drawerOpen, setDrawerOpen] = useState(false);
const [paletteOpen, setPaletteOpen] = useState(false);

useListKeyboard({
  itemCount: items.length,
  onNavigate: openDrawer,
  enabled: !drawerOpen && !paletteOpen,
});
```

For apps with many layers, centralize with a shared context:

```tsx
const layer = useActiveLayer(); // returns 'modal' | 'palette' | 'list' | 'global'
useListKeyboard({ enabled: layer === "list" });
```

**Escape key chain — explicit priority order:**

```
if (drawerOpen)        → close drawer
else if (paletteOpen)  → close palette
else if (focusedIndex >= 0) → clear list focus (set to -1)
else                   → no-op
```

Each consumer calls `e.stopPropagation()` after handling, so lower layers never see the event.

**Common conflicts and solutions:**

| Key       | Conflict                                   | Solution                                                               |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `/`       | Focus search input vs type in input        | Guard with `isInputFocused()` — only intercept when no input has focus |
| `Enter`   | Open list item vs submit form              | List hook skips when `document.activeElement` is a form control        |
| `Escape`  | Multiple consumers (drawer, palette, list) | Priority chain above — highest open layer consumes first               |
| `j` / `k` | Scroll page vs list navigation             | `e.preventDefault()` in list hook; guard with `isInputFocused()`       |

---

## 5. Liveness Patterns

A static screen feels broken. Every page must communicate activity, progress, and connectivity without the user asking.

### 5.1 Activity Pulse

An animated indicator showing that background processes are running. Place near the entity being processed, in the sidebar nav, or in a status area.

```tsx
function ActivityPulse({ active, label }: { active: boolean; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      aria-label={label ?? (active ? "Processing" : "Idle")}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full transition-colors duration-300",
          active ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30",
        )}
      />
      {label && (
        <span className="text-[11px] text-muted-foreground">{label}</span>
      )}
    </span>
  );
}
```

**Placement guidance:**

- **Sidebar nav item** — next to the label when that section has background work in progress.
- **Section header** — inside `SectionLabel` `meta` slot: `<ActivityPulse active={isSyncing} />`.
- **Status bar** — persistent footer area for global process status.

---

### 5.2 Skeleton Shimmer

Skeleton rows **must** match real row height to prevent layout shift. For 36–40px data rows, use `h-9` (or `h-10` for metadata-dense rows). Render 8–12 skeleton rows to fill the viewport.

```tsx
function SkeletonRow() {
  return (
    <div className="flex items-center h-9 px-3 gap-2 border-b border-border animate-shimmer">
      {/* Status dot placeholder */}
      <span className="h-2 w-2 rounded-full bg-muted-foreground/10" />
      {/* ID placeholder */}
      <span className="h-3 w-12 rounded bg-muted-foreground/10" />
      {/* Title placeholder */}
      <span className="h-3 flex-1 max-w-[60%] rounded bg-muted-foreground/10" />
      {/* Timestamp placeholder */}
      <span className="h-3 w-8 rounded bg-muted-foreground/10 ml-auto" />
    </div>
  );
}

function SkeletonList({ rows = 10 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
```

**`animate-shimmer` is a custom Tailwind class (not built-in) — the CSS keyframe block below is required:**

```css
@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

.animate-shimmer {
  background: linear-gradient(
    90deg,
    transparent 25%,
    rgba(255 255 255 / 0.03) 50%,
    transparent 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

**Critical rule:** Skeleton `h-9` must match `DataRow` `h-9`. If your rows use a different height, match it exactly. Height mismatch causes visible jump when real data loads.

---

### 5.3 Connection / Health Status

An ambient dot showing system connectivity. Place in the sidebar footer or a persistent status area — never in a modal or toast.

| State    | Color                      | Meaning               |
| -------- | -------------------------- | --------------------- |
| Healthy  | `bg-emerald-400`           | All systems connected |
| Degraded | `bg-amber-400`             | Partial connectivity  |
| Down     | `bg-red-400 animate-pulse` | Connection lost       |

```tsx
function ConnectionStatus({
  state,
  details,
}: {
  state: "healthy" | "degraded" | "down";
  details?: string;
}) {
  const colors = {
    healthy: "bg-emerald-400",
    degraded: "bg-amber-400",
    down: "bg-red-400 animate-pulse",
  };

  return (
    <Tooltip content={details ?? state}>
      <span
        className={cn("inline-block h-2 w-2 rounded-full", colors[state])}
        role="status"
        aria-label={`Connection: ${state}${details ? ` — ${details}` : ""}`}
      />
    </Tooltip>
  );
}
```

**Placement:** Sidebar footer, bottom-left, next to version or user info. Always visible — never hidden behind a click.

---

### 5.4 Real-Time Updates

When new items arrive in a list, they should **fade in at the top** with a brief highlight — not cause a hard re-render that resets scroll position or focus.

**Pattern:**

- New items prepend to the list with a CSS transition: `opacity-0 → opacity-100` over 200ms.
- Apply a temporary highlight class (e.g., `bg-primary/[0.06]`) that fades after 1–2 seconds.
- Preserve the current `focusedIndex` — if the user is at index 3, they should stay on the same item, not shift down.

**Optimistic UI for user actions:**

- When a user archives/completes an item, remove it from the list immediately with a fade-out.
- If the server rejects the action, restore the item with an error indicator.
- Never wait for a server round-trip to update the list.

---

## 6. AI Integration

### 6.1 Contextual "Ask AI" Navigation

Surface AI at point of need — rows, detail panels, command palette. Never behind menus.

```tsx
// lib/ask-ai.ts
// Replace "/chat" with your app's AI interface route,
// or adapt to open an inline AI panel.
export function askAI(navigate: NavigateFunction, message: string): void {
  navigate("/chat", { state: { prefill: message } });
}

// Chat page: read prefill on mount and auto-submit
const { state } = useLocation();
useEffect(() => {
  if (state?.prefill) {
    setInput(state.prefill);
    submitMessage(state.prefill);
  }
}, []);
```

**Message format** — include entity type, title, and ID:

```tsx
// Row hover button
onClick={() => askAI(navigate, `Tell me about this issue: "${item.title}" (ID: ${item.id})`)}

// Detail panel header button
onClick={() => askAI(navigate, `Summarize ${item.id}: "${item.title}". What should I do next?`)}

// Command palette secondary action
{ label: `Ask AI about "${result.title}"`, onSelect: () => askAI(navigate, `...`) }
```

### 6.2 AI Confidence Indicator

Show AI confidence inline for any AI-generated content (rankings, suggestions, summaries):

```tsx
function ConfidenceDots({ score }: { score: number }) {
  // 0–1
  const filled = Math.round(score * 4);
  return (
    <span className="flex items-center gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "w-1 h-1 rounded-full",
            i < filled ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </span>
  );
}
```

---

## 7. Visual Impact Planning

### The Invisible Change Trap

Spreading micro-adjustments across many files — 2-4px spacing tweaks, subtle color shifts, slightly different font weights — produces zero visible transformation. Each change is correct in isolation, invisible in aggregate. The user sees "nothing changed" despite dozens of modified files.

### Phase Sizing Rules

1. **Every phase = one page or one major component, fully transformed.** Don't split a page's redesign across multiple phases.
2. **5-second test per phase:** compare before/after screenshots side-by-side. If the change isn't visible within 5 seconds of looking, combine it with other changes until it is.
3. **Screenshot diff required:** take before and after screenshots of the affected page. If they look the same at arm's length, the phase isn't meaningful — merge it into a larger phase.
4. **Technical-only phases are OK** when they're prerequisites (token migration, hook refactors, build changes) — but label them clearly as "infrastructure" and don't count them as visual progress.

### Organize by Page, Not by Concern

| ❌ Bad (by concern)              | ✅ Good (by page)               |
| -------------------------------- | ------------------------------- |
| Phase 1: Update all color tokens | Phase 1: Redesign Inbox page    |
| Phase 2: Update all shadows      | Phase 2: Redesign Focus page    |
| Phase 3: Update all typography   | Phase 3: Redesign Settings page |
| Phase 4: Update all components   | Phase 4: Redesign Chat page     |

**Why "by concern" fails:** each phase touches every file in the codebase, produces no visible page-level transformation, and makes rollback impossible — reverting Phase 2 means unwinding shadow changes across every component.

**Why "by page" works:** each phase produces a complete, shippable transformation for one area. Users see an obvious before/after. Rollback is surgical — revert one page without touching others. Progress is visible and demoable after every phase.

---

## 8. New Page Checklist

### Structure

- [ ] `SectionLabel` with ALL-CAPS `label` + `count` + `meta` + `actions` (no generic `<h1>`)
- [ ] Skeleton rows (same height as real rows) for loading state
- [ ] `EmptyState` with icon + title + description + CTA
- [ ] `ErrorBanner` with retry for error state

### Keyboard Integration

- [ ] `useListKeyboard` wired for every list on the page
- [ ] Page hints added to `ShortcutBar` `getHints()`
- [ ] Page shortcuts added to `ShortcutOverlay` `SECTIONS`
- [ ] `g+letter` entry added to `GO_TARGETS` (new top-level pages only)

### Navigation & Discovery

- [ ] Route registered in app router
- [ ] Sidebar/nav item added (top-level pages)
- [ ] ⌘K navigation command added to command palette
- [ ] Entity registered in universal search (if searchable)
- [ ] Cross-entity links where applicable (name → profile)

### Quality Gates

- [ ] **Screenshot test** — would you share this as an example of great UI?
- [ ] **Mouse-free test** — can a user complete the #1 action without touching the mouse?
- [ ] **5-second test** — does a new user understand the page's purpose in 5 seconds?
- [ ] **AI-visible test** — is AI's contribution surface-level, not buried?
- [ ] **Distinctiveness test** — does the page have a visual element or interaction that no other app has?

### Liveness

- [ ] Skeleton loading matches real row height — no layout shift
- [ ] 8-12 skeleton rows rendered during loading
- [ ] Activity indicators visible when background processes run
- [ ] New items animate into list (fade-in, not hard swap)

### Navigation Chrome

- [ ] Sidebar nav item added with monochrome icon (if top-level page)
- [ ] Active state uses opacity shift, not color or border
- [ ] Unread/active count badge (if applicable)

---

## 9. New Row Component Checklist

### Layout

- [ ] Fixed height `h-9` / `h-10` (36–40px) — single flex line, no wrapping
- [ ] `group flex items-center h-9 px-3 gap-2 cursor-pointer border-b border-border`
- [ ] `onClick` opens slide-over or triggers primary action
- [ ] `*RowSkeleton` companion for loading state

### States

- [ ] Hover: `hover:bg-white/[0.03]`
- [ ] Active (drawer open): `bg-primary/[0.08] border-l-2 border-l-primary`
- [ ] Keyboard-focused: `bg-white/[0.05] ring-1 ring-inset ring-primary/30`
- [ ] Props: `isFocused: boolean`, `isActive: boolean`, `rowRef: RefCallback`

### Content

- [ ] Title: `min-w-0 flex-1 truncate text-[13px]` — never wraps
- [ ] Timestamps: `font-mono text-[11px] tabular-nums` in faintest foreground
- [ ] Identifiers: `font-mono text-[11px] tabular-nums text-primary/70`

### Hover Actions

- [ ] Wrapper: `opacity-0 group-hover:opacity-100 transition-opacity`
- [ ] Each button: `p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-surface-raised`
- [ ] "Ask AI" button included: `askAI(navigate, contextualMessage)`
- [ ] Each button in `<Tooltip content="Action (key)">` showing keyboard shortcut
- [ ] `onClick={(e) => e.stopPropagation()}` on action wrapper

### Accessibility

- [ ] `role="row"` · `tabIndex={-1}` · `aria-selected={isActive}`
- [ ] `aria-label` on every icon-only button

---

## 10. Anti-Patterns & Quality Gates

| Anti-pattern                   | Problem                            | Fix                                                |
| ------------------------------ | ---------------------------------- | -------------------------------------------------- |
| Cards for data-grid lists      | 4× space waste; breaks scan rhythm | Use 36–40px flat rows                              |
| Modal for detail view          | Loses list context                 | Use slide-over drawer (~55vw)                      |
| AI hidden in settings/menus    | AI never gets used                 | Surface "Ask AI" on hover in every row             |
| Mouse-required primary actions | Excludes keyboard users            | Wire every action to a key                         |
| Decorative icons               | Visual noise without signal        | Every icon must carry semantic meaning             |
| Wrapping row content           | Destroys scan-line rhythm          | `truncate` on all text, single flex line           |
| Raw color values in JSX        | Breaks theming                     | Token classes only (`text-primary`, not `#3b82f6`) |
| Generic `<h1>` page headers    | Wastes vertical real estate        | `SectionLabel` with count + meta                   |

**Screenshot test:** Before shipping, ask — would someone screenshot this as an example of excellent UI? Common failures: excess whitespace, no keyboard hints visible, AI nowhere in sight, inconsistent row heights.

**5-second test:** A stranger should identify the page's purpose and primary action within 5 seconds. If not, the information hierarchy is broken.

### Wow Factor Checklist

Final pre-ship gut check (see Quality Gates in the New Page Checklist for detailed per-page verification):

- [ ] Does this phase produce a visible 5-second change? (see Visual Impact Planning)
- [ ] Would you use this page in a portfolio or demo?

### Studying Reference Apps

When analyzing competitors or inspiration:

| Steal                                                 | Don't copy                               |
| ----------------------------------------------------- | ---------------------------------------- |
| Interaction patterns (keyboard model, triage flow)    | Visual identity (colors, logo treatment) |
| Information density model (row height, column layout) | Domain-specific IA (their nav hierarchy) |
| Liveness cues (how they show activity)                | Features specific to their domain        |
| Shortcut discovery patterns (how hints appear)        | Onboarding flows (different audience)    |

Document your reference mapping: "From [App]: steal [pattern], skip [feature]."

---

## 11. Related Skills

| Skill      | Use when                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| `/design`  | Starting a design system from scratch; token philosophy; visual craft principles  |
| `/testing` | Writing behavioral tests for keyboard interactions and component state            |
| `/debug`   | Diagnosing keyboard event conflicts, focus trapping issues, z-index stacking bugs |

### Boundary with /design

These two skills target different layers of the stack:

- **`/design`** = visual foundation layer (tokens, typography, color palettes, shadow systems, animation curves, core component styling)
- **`keyboard-first-ui`** = interaction architecture layer (keyboard navigation, information density, AI presence, page structure, row patterns)

**When building a power-user app:** load both skills. Let `/design` set up your token system and component primitives first. Then apply `keyboard-first-ui` for page layouts, row patterns, and keyboard wiring. Where they conflict (see override table in Section 0), this skill wins.

**When building a standard SaaS app:** use `/design` alone. This skill's density and keyboard patterns add unnecessary complexity for apps without a power-user audience.
