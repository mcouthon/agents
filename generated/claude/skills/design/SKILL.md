---
name: design
description: "Use when building dashboards, SaaS UIs, admin interfaces, or any interface needing polished professional design. Covers design direction, craft principles, and 9-phase implementation. Triggers on: 'use design mode', 'design system', 'design system upgrade'. Full access mode."
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, LSP]
---

# Premium UI Design & Implementation

A comprehensive guide to premium UI design and implementation. Part 1 establishes design direction, Part 2 covers craft principles, and Part 3 provides the 9-phase implementation approach.

---

## Part 1: Design Direction (REQUIRED)

Before writing any code, commit to a design direction. Don't default. Think about what this specific product needs to feel like.

### Think About Context

- **What does this product do?** A finance tool needs different energy than a creative tool.
- **Who uses it?** Power users want density. Occasional users want guidance.
- **What's the emotional job?** Trust? Efficiency? Delight? Focus?
- **What would make this memorable?** Every product has a chance to feel distinctive.

**SaaS ≠ Marketing.** A SaaS product isn't a landing page. Marketing sites sell with visuals and emotion. Product interfaces serve with clarity and function. Resist the urge to make things "pop"—make them _work_. Glass morphism, gradients, and glow effects are spices, not the meal. The meal is information hierarchy, fast interactions, and clear feedback.

### Start with Intent, Not Aesthetics

Before choosing a personality or color palette, answer these questions:

1. **Who is this human?** What's their context, expertise, and emotional state when they open this tool?
2. **What must they accomplish?** Map the top 3 user tasks. What's primary, secondary, tertiary?
3. **What should this feel like?** Confident? Fast? Calm? The feeling drives every surface decision.
4. **Where does the user need confidence?** Destructive actions, financial data, status indicators.
5. **Where does the user need speed?** Frequent actions, navigation, data scanning.
6. **What information hierarchy does that create?** What's primary, secondary, tertiary?

Design direction flows FROM these answers. If you can't articulate the intent, you're decorating, not designing.

**Intent → Structure → Surface:** Get the information architecture right first. Then establish visual hierarchy. Only then choose personality and aesthetics.

### Choose a Personality

Enterprise/SaaS UI has more range than you think:

| Personality                  | Characteristics                                    | Examples                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------- |
| **Precision & Density**      | Tight spacing, monochrome, information-forward     | Linear, Raycast, terminal tools |
| **Warmth & Approachability** | Generous spacing, soft shadows, friendly colors    | Notion, Coda                    |
| **Sophistication & Trust**   | Cool tones, layered depth, financial gravitas      | Stripe, Mercury                 |
| **Boldness & Clarity**       | High contrast, dramatic negative space, confident  | Vercel                          |
| **Utility & Function**       | Muted palette, functional density, clear hierarchy | GitHub, developer tools         |
| **Data & Analysis**          | Chart-optimized, technical but accessible          | Analytics, BI tools             |

Pick one. Or blend two. But commit.

#### Personality → Implementation Mapping

| Personality              | Border Radius | Shadows      | Spacing | Colors        |
| ------------------------ | ------------- | ------------ | ------- | ------------- |
| Precision & Density      | 4-6px         | Borders only | 8-12px  | Monochrome    |
| Warmth & Approachability | 12-16px       | Soft shadows | 16-24px | Warm neutrals |
| Sophistication & Trust   | 8-12px        | Layered      | 16-20px | Cool slate    |
| Boldness & Clarity       | 8px           | Dramatic     | 24-32px | Pure B&W      |
| Utility & Function       | 4-6px         | Minimal      | 8-12px  | Muted palette |
| Data & Analysis          | 6-8px         | Subtle       | 12-16px | Chart-ready   |

Use these as starting points—adapt to your specific context.

### Choose a Color Foundation

Don't default to warm neutrals. Consider the product:

- **Warm foundations** (creams, warm grays) — approachable, comfortable, human
- **Cool foundations** (slate, blue-gray) — professional, trustworthy, serious
- **Pure neutrals** (true grays, black/white) — minimal, bold, technical
- **Tinted foundations** (slight color cast) — distinctive, memorable, branded

**Light or dark?** Dark feels technical, focused, premium. Light feels open, approachable, clean.

**Accent color** — Pick ONE that means something. Blue for trust. Green for growth. Orange for energy. Violet for creativity.

### Choose a Layout Approach

The content should drive the layout:

- **Dense grids** for information-heavy interfaces where users scan and compare
- **Generous spacing** for focused tasks where users need to concentrate
- **Sidebar navigation** for multi-section apps with many destinations
- **Top navigation** for simpler tools with fewer sections
- **Split panels** for list-detail patterns where context matters

### Choose Typography

- **System fonts** — fast, native, invisible (utility-focused products)
- **Geometric sans** (Geist, Inter) — modern, clean, technical
- **Humanist sans** (SF Pro, Satoshi) — warmer, more approachable
- **Monospace influence** — technical, developer-focused, data-heavy

---

## Part 2: Core Craft Principles

These apply regardless of design direction. This is the quality floor.

### The 4px Grid

All spacing uses a 4px base grid:

| Value  | Usage                                 |
| ------ | ------------------------------------- |
| `4px`  | Micro spacing (icon gaps)             |
| `8px`  | Tight spacing (within components)     |
| `12px` | Standard spacing (related elements)   |
| `16px` | Comfortable spacing (section padding) |
| `24px` | Generous spacing (between sections)   |
| `32px` | Major separation                      |

### Touch Targets & Cursor Discipline

**44px minimum hit area** for all interactive elements. This isn't just mobile—it's motor accessibility and Fitts's Law. Small targets slow everyone down.

- Buttons, links, icons, toggles, tabs: all ≥ 44×44px hit area
- If the visual element is smaller (e.g., a 24px icon), expand the clickable area with padding
- Navigation items, list items, dropdown options: ≥ 44px height

**cursor: pointer on everything clickable.** No exceptions. If a user can click it, the cursor must change. Buttons, links, cards, tabs, toggles, chips, dropdown triggers—all get `cursor-pointer`.

### Symmetrical Padding

TLBR must match. If top padding is 16px, left/bottom/right must also be 16px.

```css
/* Good */
padding: 16px;
padding: 12px 16px; /* Only when horizontal needs more room */

/* Bad */
padding: 24px 16px 12px 16px;
```

### Border Radius Consistency

Stick to the 4px grid. Sharper corners feel technical, rounder corners feel friendly:

- **Sharp**: 4px, 6px, 8px
- **Soft**: 8px, 12px
- **Minimal**: 2px, 4px, 6px

Don't mix systems. Consistency creates coherence.

### Depth & Elevation Strategy

Match your depth approach to your design direction. Choose ONE:

**Borders-only (flat)** — Clean, technical, dense. Works for utility-focused tools. Linear, Raycast use almost no shadows—just subtle borders.

**Subtle single shadows** — Soft lift without complexity: `0 1px 3px rgba(0,0,0,0.08)`

**Layered shadows** — Rich, premium, dimensional. Stripe and Mercury use this approach.

**Surface color shifts** — Background tints establish hierarchy without shadows. A card at `#fff` on `#f8fafc` already feels elevated.

```css
/* Borders-only approach */
--border: rgba(0, 0, 0, 0.08);
border: 0.5px solid var(--border);

/* Single shadow approach */
--shadow: 0 1px 3px rgba(0, 0, 0, 0.08);

/* Layered shadow approach */
--shadow-layered:
  0 0 0 0.5px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04),
  0 2px 4px rgba(0, 0, 0, 0.03), 0 4px 8px rgba(0, 0, 0, 0.02);
```

The craft is in the choice, not the complexity.

**Glass, not glow.** Glass morphism is a depth technique—frosted layers that establish hierarchy through translucency and blur. It's NOT about making things shiny. Use glass to separate content layers (sidebar, modals, floating panels). If glass doesn't serve a structural purpose, don't use it. A solid `bg-card` is often better than a blurred panel.

### Card Layouts

Monotonous card layouts are lazy design. A metric card doesn't have to look like a plan card doesn't have to look like a settings card.

Design each card's internal structure for its specific content—but keep the surface treatment consistent: same border weight, shadow depth, corner radius, padding scale, typography.

### Isolated Controls

UI controls deserve container treatment. Date pickers, filters, dropdowns should feel like crafted objects.

**Never use native form elements for styled UI.** Native `<select>`, `<input type="date">` render OS-native controls that cannot be styled. Build custom components instead.

Custom select triggers must use `display: inline-flex` with `white-space: nowrap` to keep text and chevron icons on the same row.

### Monospace for Data

Numbers, IDs, codes, timestamps belong in monospace. Use `tabular-nums` for columnar alignment. Mono signals "this is data."

### Iconography

Use **Phosphor Icons** (`@phosphor-icons/react`). Icons clarify, not decorate—if removing an icon loses no meaning, remove it.

Give standalone icons presence with subtle background containers.

### Contrast Hierarchy

Build a four-level system: **foreground** (primary) → **secondary** → **muted** → **faint**. Use all four consistently.

### Color for Meaning Only

Gray builds structure. Color only appears when it communicates: status, action, error, success. Decorative color is noise.

Ask whether each use of color is earning its place. Score bars don't need to be color-coded by performance—a single muted color works.

### Anti-Default Tests

Every design decision should survive four tests. If a choice is just "what the framework gave me," it's not a decision—it's a default.

**The Swap Test:** Could you swap this component with any other app's version and nobody would notice? If yes, you haven't designed it—you've assembled it.

**The Squint Test:** Squint at the screen. Can you still see the hierarchy? If everything blurs into the same gray mass, your visual hierarchy is broken. Primary actions, key data, and navigation should remain distinct even when blurred.

**The Signature Test:** Cover the logo. Can you tell which product this is? If not, the design has no point of view. At least ONE element should be distinctive to this product.

**The Token Test:** Is every value (color, spacing, radius, shadow) coming from your design tokens? If you're using arbitrary values (`mt-[13px]`, `text-[#3a3a3a]`), you're creating inconsistency. Every value should trace back to the system.

Also question: Is the grid alignment consistent? Is the depth strategy coherent across every surface?

### Navigation Context

Screens need grounding. A data table floating in space feels like a component demo, not a product. Consider including:

- **Navigation** — sidebar or top nav showing where you are in the app
- **Location indicator** — breadcrumbs, page title, or active nav state
- **User context** — who's logged in, what workspace/org

When building sidebars, consider using the same background as the main content area. Tools like Supabase, Linear, and Vercel rely on a subtle border for separation rather than different background colors.

### Dark Mode Considerations

**Borders over shadows** — Shadows are less visible on dark backgrounds. Lean more on borders for definition. A border at 10-15% white opacity might look nearly invisible but it's doing its job.

**Adjust semantic colors** — Status colors (success, warning, error) often need to be slightly desaturated for dark backgrounds.

**Same structure, different values** — The hierarchy system (foreground → secondary → muted → faint) still applies, just with inverted values.

### Working with Component Libraries

When using shadcn/ui, Radix, or similar libraries, this design system overlays on top. Apply the design tokens (colors, shadows, spacing) to the library's components via CSS variables and className overrides. Don't fight the library's accessibility patterns—enhance their visual layer.

---

## Part 3: The 9-Phase Implementation

Design system work is foundational. Skip phases or do them out of order, and you'll create technical debt. Each phase builds on the previous.

| Phase | Name                 | What It Establishes                      |
| ----- | -------------------- | ---------------------------------------- |
| 1     | Typography           | Font choice, scale, tracking, smoothing  |
| 2     | Color System         | HSL-based colors, semantic tokens, glass |
| 3     | Shadows & Elevation  | Layered shadows, glow effects, depth     |
| 4     | Animation System     | Hooks, keyframes, timing, stagger        |
| 5     | Core Components      | Button, Input, Select, Modal redesign    |
| 6     | Layout Components    | Sidebar, Header, Card variants           |
| 7     | Domain Components    | Feature-specific polish (chat, forms)    |
| 8     | Data Display         | Tables, charts, KPIs, dashboards         |
| 9     | Pages & Final Polish | Headers, responsive, accessibility       |

### Per-Component Checkpoint

Before marking any component done, verify:

1. **Intent:** Does this component serve a clear user task? Can you state it in one sentence?
2. **Hierarchy:** Is the visual weight proportional to importance?
3. **States:** Have you designed all states? (default, hover, active, focus, disabled, loading, error, empty)
4. **Anti-defaults:** Does it pass the Swap Test? Would a user recognize this as YOUR product?
5. **Touch targets:** All interactive elements ≥ 44px hit area
6. **Cursor:** All clickable elements have `cursor: pointer`

Skip nothing. These 6 checks catch 80% of polish issues.

**Example checkpoint for a Button component:**

> Intent: "Triggers primary user actions with clear visual hierarchy."
> States: default, hover (-translate-y-px), active (translate-y-0), focus (ring), disabled (opacity-50), loading (spinner).
> Touch: h-11 = 44px. Cursor: cursor-pointer.

---

## Phase 1: Typography

Typography sets the personality. Get this right first.

### Deliverables

1. **Font selection** — Import via Google Fonts CDN or self-host
2. **CSS variable** — `--font-family` with proper fallback stack
3. **Tailwind config** — `fontFamily.sans` using the new font
4. **Font smoothing** — `-webkit-font-smoothing: antialiased`
5. **Typography scale** — Refined tracking for each size tier

### Font Recommendations

| Personality    | Font Choice | Notes                               |
| -------------- | ----------- | ----------------------------------- |
| Premium/Modern | Poppins     | Geometric, clean, distinct          |
| Technical      | Geist       | Sharp, developer-focused            |
| Approachable   | Inter       | Highly readable, neutral            |
| Native         | System UI   | Fast, invisible, familiar           |
| Data-focused   | Roboto Mono | For code/data with proportional mix |

### Typography Scale Pattern

```js
// tailwind.config.js — representative entries, extend for your full scale
fontSize: {
  display: ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.025em", fontWeight: "600" }],
  title: ["1.125rem", { lineHeight: "1.75rem", letterSpacing: "-0.015em", fontWeight: "600" }],
  body: ["0.875rem", { lineHeight: "1.25rem" }],
  label: ["0.8125rem", { lineHeight: "1.125rem", letterSpacing: "0.01em", fontWeight: "500" }],
  caption: ["0.75rem", { lineHeight: "1rem" }],
}
```

### Tracking Rules

- **Large display text** → Negative tracking (`-0.025em`)
- **Body text** → Default/none
- **Labels/captions** → Slight positive (`0.01em`)
- **Headings** → Slight negative (`-0.01em` to `-0.02em`)

---

## Phase 2: Color System

Convert to HSL-based colors that support opacity modifiers and glass morphism.

### Deliverables

1. **HSL color tokens** — All colors as `H S L` (no hsl() wrapper, no alpha)
2. **Semantic naming** — `--background`, `--foreground`, `--primary`, `--muted`
3. **Glass morphism tokens** — `--glass-border`, `--glass-bg`
4. **Tailwind integration** — Colors with `<alpha-value>` support
5. **Dark mode** — Complete alternate value set

### HSL Pattern

```css
/* CSS: Define as H S L values only */
:root {
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;
  --primary: 211 100% 50%; /* Apple Blue */
  --muted: 210 40% 96%;
  --muted-foreground: 215 16% 47%;
}

.dark {
  --background: 220 16% 4%;
  --foreground: 210 40% 96%;
  --primary: 211 100% 50%;
  --muted: 220 16% 10%;
  --muted-foreground: 215 20% 55%;
}
```

```js
// Tailwind: Use with <alpha-value> for opacity modifiers
colors: {
  background: "hsl(var(--background) / <alpha-value>)",
  foreground: "hsl(var(--foreground) / <alpha-value>)",
  primary: "hsl(var(--primary) / <alpha-value>)",
}
```

This enables `bg-primary/80` → `hsl(211 100% 50% / 0.8)`

**Opacity as a design tool.** HSL with `<alpha-value>` gives you a powerful layering mechanism. Use opacity modifiers (`/80`, `/60`, `/40`) to create depth without adding new colors. A `bg-primary/10` background is more cohesive than a custom light-blue—it automatically adapts to theme changes.

### Glass Morphism Tokens

```css
/* Light mode: black tint for glass */
--glass-border: 0 0% 0% / 0.06;
--glass-bg: 0 0% 0% / 0.02;

/* Dark mode: white tint for glass */
--glass-border: 0 0% 100% / 0.06;
--glass-bg: 0 0% 100% / 0.03;
```

### Semantic Color Naming

| Token                        | Purpose                     |
| ---------------------------- | --------------------------- |
| `background`                 | Page/app background         |
| `foreground`                 | Primary text                |
| `primary`                    | Brand/action color          |
| `muted`                      | Subtle backgrounds          |
| `muted-foreground`           | Secondary text              |
| `card`                       | Card/elevated surfaces      |
| `border`                     | Default borders             |
| `accent`                     | Highlight color (if needed) |
| `success/warning/error/info` | Semantic states             |

See Contrast Hierarchy in Part 2 for the four-level text hierarchy system.

**Dark mode color strategy:** Don't just invert—adjust. Dark backgrounds need lower-contrast text for the muted levels and slightly more saturated accent colors to maintain visual impact.

---

## Phase 3: Shadows & Elevation

> **Note:** Your depth strategy here should match your design direction choice from Part 1. Precision/Density → borders-only, Sophistication/Trust → layered shadows.

Shadows create depth and hierarchy. A comprehensive shadow system is essential for polish.

**Craft note:** The difference between amateur and premium shadow work is subtlety. If you can obviously _see_ a shadow, it's probably too heavy. Shadows should be felt, not seen—they create spatial relationships without drawing attention to themselves.

### Deliverables

1. **Ambient shadows** — Ultra-subtle, for slight depth
2. **Base shadow scale** — sm, md, lg, xl, 2xl
3. **Card shadows** — Optimized for card components
4. **Glass shadows** — For glass morphism components
5. **Elevated shadows** — For floating elements (modals, dropdowns)
6. **Glow shadows** — Colored shadows for interactive states
7. **Inset shadows** — For pressed/active states

### Shadow Pattern

```css
/* Ambient — ultra-subtle background depth */
--shadow-ambient: 0 1px 2px 0 rgba(0, 0, 0, 0.02);
--shadow-ambient-md: 0 2px 4px 0 rgba(0, 0, 0, 0.04);

/* Card — for card components */
--shadow-card: 0 1px 2px 0 rgba(0, 0, 0, 0.02);
--shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.06);

/* Glass — for glass morphism */
--shadow-glass: 0 4px 16px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
--shadow-glass-lg: 0 8px 32px rgba(0, 0, 0, 0.06);

/* Elevated — floating elements */
--shadow-elevated:
  0 8px 24px rgba(0, 0, 0, 0.08), 0 4px 8px rgba(0, 0, 0, 0.04);
--shadow-elevated-lg: 0 16px 48px rgba(0, 0, 0, 0.1);

/* Glow — colored for interactive elements */
--shadow-glow-blue: 0 4px 16px rgba(0, 113, 227, 0.15);
--shadow-glow-blue-lg: 0 8px 32px rgba(0, 113, 227, 0.2);
--shadow-glow-green: 0 4px 16px rgba(16, 185, 129, 0.15);
--shadow-glow-red: 0 4px 16px rgba(239, 68, 68, 0.15);

/* Inset — pressed states */
--shadow-inset: inset 0 1px 2px rgba(0, 0, 0, 0.06);
```

### Dark Mode Shadow Adjustments

Dark mode needs different shadow treatment:

- Use **lower opacity** (shadows less visible on dark)
- Lean more on **borders** for definition
- **Glow effects** become more prominent and effective

```css
.dark {
  --shadow-card: 0 1px 2px 0 rgba(0, 0, 0, 0.2);
  --shadow-elevated: 0 8px 24px rgba(0, 0, 0, 0.4);
  --shadow-glow-blue: 0 4px 24px rgba(0, 113, 227, 0.25);
}
```

---

## Phase 4: Animation System

Animations make interfaces feel alive. Build a library of reusable animations.

### Deliverables

1. **Timing functions** — Apple-style easing curves
2. **Duration scale** — Fast (150ms) to slow (400ms)
3. **Keyframe animations** — Fade, slide, scale, modal, shimmer
4. **Animation hooks** — useInView + additional hooks as needed
5. **Stagger delay pattern** — For cascading reveals

### Duration Scale

| Token    | Duration | Usage                             |
| -------- | -------- | --------------------------------- |
| `fast`   | 150ms    | Micro-interactions (hover, focus) |
| `base`   | 200ms    | Component transitions             |
| `smooth` | 250ms    | Standard animations               |
| `slow`   | 350ms    | Page transitions, modals          |
| `slower` | 400ms    | Complex orchestrated sequences    |

### Easing Functions

```js
transitionTimingFunction: {
  smooth: "cubic-bezier(0.25, 1, 0.5, 1)",    // General purpose
  apple: "cubic-bezier(0.25, 1, 0.5, 1)",     // Apple-style
  spring: "cubic-bezier(0.22, 1, 0.36, 1)",   // Springy feel
  "ease-out-expo": "cubic-bezier(0.19, 1, 0.22, 1)",  // Dramatic slowdown
}
```

### Core Keyframe Animations

```js
keyframes: {
  "fade-in": {
    "0%": { opacity: "0" },
    "100%": { opacity: "1" },
  },
  "fade-slide-up": {
    "0%": { opacity: "0", transform: "translateY(8px)" },
    "100%": { opacity: "1", transform: "translateY(0)" },
  },
  "scale-in": {
    "0%": { opacity: "0", transform: "scale(0.95)" },
    "100%": { opacity: "1", transform: "scale(1)" },
  },
  "modal-enter": {
    "0%": { opacity: "0", transform: "scale(0.96) translateY(8px)" },
    "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
  },
  "shimmer": {
    "0%": { transform: "translateX(-100%)" },
    "100%": { transform: "translateX(100%)" },
  },
}
```

### Animation Hooks

Create a `hooks/use-animations.ts` file with reusable hooks.

#### useInView — Intersection Observer

```tsx
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: {
    threshold?: number;
    rootMargin?: string;
    triggerOnce?: boolean;
  } = {},
): [RefObject<T | null>, boolean] {
  const { threshold = 0.1, rootMargin = "0px", triggerOnce = true } = options;
  const ref = useRef<T>(null);
  const [isInView, setIsInView] = useState(false);
  const hasTriggered = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || (triggerOnce && hasTriggered.current)) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          if (triggerOnce) {
            hasTriggered.current = true;
            observer.disconnect();
          }
        } else if (!triggerOnce) {
          setIsInView(false);
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold, rootMargin, triggerOnce]);

  return [ref, isInView];
}
```

#### Additional Hooks

Implement these as needed. Follow the useInView pattern above.

| Hook                      | Purpose          | Key Detail                                                                                         |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `useStagger`              | Cascading delays | Returns `getStaggerClass(index)` / `getStaggerStyle(index)` with configurable base + stagger delay |
| `useCountUp`              | Animated numbers | `requestAnimationFrame` + `easeOutExpo` easing, configurable duration/decimals                     |
| `useAnimationState`       | Mount/unmount    | Tracks `entering → entered → exiting → exited` phases with configurable durations                  |
| `usePrefersReducedMotion` | Accessibility    | Listens to `prefers-reduced-motion` media query, returns boolean                                   |

### Stagger Pattern

Generate `.stagger-1` through `.stagger-12` CSS classes with 50ms increments. Include `.stagger-item` base class with `opacity: 0; animation-fill-mode: forwards;` and a defensive `.stagger-item:not([class*="animate-"]) { opacity: 1; }` override.

Usage with the `useStagger` hook:

```tsx
function ItemList({ items }: { items: Item[] }) {
  const { getStaggerClass } = useStagger();
  return (
    <ul>
      {items.map((item, i) => (
        <li
          key={item.id}
          className={cn(
            "stagger-item animate-fade-slide-up",
            getStaggerClass(i),
          )}
        >
          {item.name}
        </li>
      ))}
    </ul>
  );
}
```

### Elevation Utility Classes

| Class                    | Styles                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `.elevation-card`        | `shadow-card transition-all duration-200` → hover: `shadow-card-hover -translate-y-0.5`                                 |
| `.elevation-interactive` | `shadow-card transition-all duration-200` → hover: `shadow-glow-blue -translate-y-1`                                    |
| `.elevation-glass`       | `shadow-glass transition-all duration-200` → hover: `shadow-glass-lg -translate-y-0.5`                                  |
| `.elevation-primary`     | `shadow-glow-blue transition-all duration-200` → hover: `shadow-glow-blue-lg -translate-y-px` → active: `translate-y-0` |
| `.elevation-float`       | `shadow-elevated` / `.elevation-float-lg`: `shadow-elevated-lg`                                                         |

---

## Phase 5: Core Components

With the foundation in place, redesign core UI primitives. Run the Per-Component Checkpoint after completing each component below.

### Components to Redesign

1. **Button** — Glow effects, elevation on hover, press states
2. **Input/Textarea** — Subtle focus rings, background shift
3. **Select** — Custom dropdown with chevron icon
4. **Checkbox/Radio** — Custom styled, not native
5. **Modal** — Backdrop blur, entrance/exit animations

### Button Pattern

```tsx
const variantStyles = {
  primary: cn(
    "bg-primary text-primary-foreground",
    "shadow-glow-blue hover:shadow-glow-blue-lg",
    "hover:bg-primary/90 hover:-translate-y-px",
    "active:translate-y-0 active:shadow-glow-blue",
  ),
  secondary: cn(
    "bg-card/60 backdrop-blur-sm text-foreground",
    "border border-glass-border hover:border-glass-border-hover",
    "shadow-card hover:shadow-card-hover hover:-translate-y-px",
  ),
  ghost: cn(
    "text-foreground-secondary",
    "hover:bg-muted hover:text-foreground",
  ),
  danger: cn(
    "bg-error text-white",
    "shadow-glow-red hover:shadow-glow-red",
    "hover:bg-error/90 hover:-translate-y-px",
    "active:translate-y-0",
  ),
};

// Usage
<button
  className={cn(
    "inline-flex items-center justify-center font-medium cursor-pointer",
    "transition-all duration-250 ease-apple",
    "focus-visible:ring-2 focus-visible:ring-primary/50",
    variantStyles[variant],
  )}
/>;
```

#### Button Sizes

Define a consistent size scale. All sizes must maintain 44px minimum touch target:

```tsx
const sizeStyles = {
  sm: "h-8 px-3 text-caption rounded-lg gap-1.5", // Visual 32px, pad to 44px hit area
  md: "h-10 px-4 text-body rounded-xl gap-2", // 40px, near target
  lg: "h-11 px-5 text-body rounded-xl gap-2", // 44px, meets target
  xl: "h-12 px-6 text-label rounded-xl gap-2.5", // 48px, generous
};
```

### Input & Textarea Pattern

```tsx
const baseInputStyles = cn(
  "w-full px-3.5 py-2.5 text-body rounded-xl",
  "bg-muted/30 border border-glass-border",
  "text-foreground placeholder:text-foreground-muted",
  "transition-all duration-200 ease-apple",
  "hover:border-glass-border-hover hover:bg-muted/40",
  "focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 focus:bg-card",
  "disabled:bg-muted disabled:text-foreground-muted disabled:cursor-not-allowed",
);

const errorStyles = "border-error/50 focus:border-error/60 focus:ring-error/20";
```

Ensure inputs have a minimum height of 44px (`h-11` or `py-2.5` with text) for touch target compliance.

### Select Pattern (Custom Chevron)

```tsx
import { ChevronDown } from "lucide-react";

<div className="relative">
  <select
    className={cn(
      baseInputStyles,
      "appearance-none pr-10", // Hide native arrow, add padding for icon
    )}
  >
    {options.map((opt) => (
      <option key={opt.value} value={opt.value}>
        {opt.label}
      </option>
    ))}
  </select>
  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted pointer-events-none" />
</div>;
```

### Checkbox Pattern

Key techniques for custom checkboxes:

- `sr-only` input + visible proxy div for full styling control
- `peer-checked:bg-primary peer-checked:border-primary` for checked state
- `peer-focus-visible:ring-2 peer-focus-visible:ring-primary/30` for keyboard a11y
- Custom check icon with `scale-75 → scale-100` transition on check
- `cursor-pointer` on the wrapping `<label>`

### Modal Pattern

Modals need three things: backdrop blur for depth, entrance animation for presence, and focus trapping for accessibility. Always trap focus inside the modal and close on Escape key.

```tsx
// Backdrop
<div className={cn(
  "fixed inset-0 bg-black/60 backdrop-blur-sm",
  "animate-backdrop-enter",
)} />

// Content
<div className={cn(
  "bg-card/90 backdrop-blur-xl border border-glass-border",
  "rounded-2xl shadow-elevated-lg",
  "animate-modal-enter",
)} />
```

---

## Phase 6: Layout Components

Layout components establish the overall feel of the application. These should reflect your design direction from Part 1—the sidebar, header, and cards set the tone for every page.

### Components to Create/Redesign

1. **Card** — Multiple variants (default, elevated, glass, interactive)
2. **Sidebar** — Color-coded nav, refined spacing
3. **Header** — Glass effect, proper hierarchy
4. **PageHeader** — Title with gradient, description

### Card Variants Pattern

```tsx
const variants = {
  default: "bg-card border border-border rounded-lg shadow-card",
  elevated: cn(
    "bg-card/70 backdrop-blur-xl border border-glass-border rounded-2xl",
    "shadow-elevated hover:shadow-elevated-lg hover:-translate-y-0.5",
  ),
  glass: cn(
    "bg-card/60 backdrop-blur-xl border border-glass-border rounded-2xl",
    "shadow-glass hover:shadow-glass-lg hover:-translate-y-0.5",
  ),
  interactive: cn(
    "bg-card/70 backdrop-blur-xl border border-glass-border rounded-2xl",
    "shadow-card cursor-pointer",
    "hover:shadow-glow-blue hover:border-primary/20 hover:-translate-y-1",
  ),
};
```

### Sidebar Pattern

- **Same background** as main content (separated by border, not color)
- **Color-coded icons** — Each nav section has a color: `text-blue-400`, `text-cyan-400`
- **Active state** — Accent background with left border indicator

#### Color-Coded Icon Mapping

```tsx
const iconColors: Record<string, string> = {
  Dashboard: "text-blue-400",
  Chat: "text-cyan-400",
  Insights: "text-amber-400",
  "Saved Items": "text-emerald-400",
  Reports: "text-violet-400",
  Settings: "text-slate-400",
};
```

#### Nav Item Pattern

```tsx
<NavLink
  to={item.href}
  className={cn(
    "flex items-center gap-3 rounded-lg py-2.5 text-label cursor-pointer",
    "transition-all duration-200 ease-apple",
    isActive
      ? cn(
          "bg-primary/10 text-foreground font-semibold",
          "border-l-2 border-primary pl-[10px] pr-3",
          "shadow-blue",
        )
      : cn(
          "text-muted-foreground px-3",
          "hover:bg-muted/50 hover:text-foreground",
        ),
  )}
>
  <item.icon
    className={cn(
      "h-5 w-5 transition-colors duration-200",
      isActive ? iconColors[item.name] : "text-muted-foreground",
    )}
  />
  {item.name}
</NavLink>
```

#### Logo & Ambient Glow

For logo marks: Use `bg-gradient-to-br` with primary color and `shadow-glow-blue` for a glowing logo mark. For gradient text: `bg-clip-text text-transparent bg-gradient-to-r`. For ambient glow behind navigation: use a `::before` pseudo-element with `radial-gradient(circle, hsl(var(--primary)), transparent 70%)` at low opacity (0.03) with `blur(100px)`.

#### Header Glass Pattern

```tsx
<header
  className={cn(
    "sticky top-0 z-40 h-14 flex items-center px-6",
    "bg-background/80 backdrop-blur-xl",
    "border-b border-border",
  )}
>
  <div className="flex items-center justify-between w-full">
    <h1 className="text-label font-semibold">{title}</h1>
    <div className="flex items-center gap-2">{/* Actions */}</div>
  </div>
</header>
```

---

## Phase 7: Domain Components

Apply the design system to feature-specific components. Each component here should pass the Anti-Default Tests from Part 2—domain components are where products become generic if you're not careful.

### Message Bubble Pattern

```tsx
// User message — gradient with glow
<div className="max-w-[85%] bg-gradient-to-br from-primary to-primary/90 text-white px-4 py-3 rounded-2xl shadow-glow-blue">
  {content}
</div>

// AI/System message — glass morphism
<div className="glass rounded-2xl shadow-card min-w-[300px] max-w-[800px]">
  {content}
</div>
```

### Empty State Pattern

```tsx
function EmptyState({
  icon: Icon,
  title,
  description,
  suggestions,
  onSuggestionClick,
}: Props) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center animate-fade-slide-up">
        <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-glow-blue">
          <Icon className="h-8 w-8 text-white" />
        </div>
        <h2 className="text-title text-foreground mb-2">{title}</h2>
        <p className="text-body text-muted-foreground mb-8">{description}</p>
        {suggestions && (
          <div className="space-y-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => onSuggestionClick?.(s)}
                className="w-full text-left px-4 py-3 rounded-xl text-body glass hover:bg-card/60 transition-all duration-200 hover:shadow-card hover:-translate-y-px cursor-pointer"
              >
                "{s}"
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### Typing Indicator

For chat or AI-response loading states:

```js
// Keyframe for tailwind.config.js
"typing-dot": {
  "0%, 60%, 100%": { opacity: "0.3", transform: "translateY(0)" },
  "30%": { opacity: "1", transform: "translateY(-4px)" },
}
```

Render 3 dots with staggered `animationDelay` (0ms, 150ms, 300ms). Use `h-2 w-2 rounded-full bg-primary animate-typing-dot`.

### Scroll Shadows

```css
.scroll-shadow-top {
  box-shadow: inset 0 24px 16px -16px hsl(var(--background) / 0.8);
}
.scroll-shadow-bottom {
  box-shadow: inset 0 -24px 16px -16px hsl(var(--background) / 0.8);
}
.scroll-shadow-both {
  box-shadow:
    inset 0 24px 16px -16px hsl(var(--background) / 0.8),
    inset 0 -24px 16px -16px hsl(var(--background) / 0.8);
}
```

---

## Phase 8: Data Display Components

Apply polish to tables, KPI cards, and data-heavy interfaces. Data display is where monospace, `tabular-nums`, and clear visual hierarchy earn their keep. Every number should be scannable. Every column should align.

### KPI Card Pattern

```tsx
function KPICard({ label, value, trend, trendDirection }: Props) {
  return (
    <div className="elevation-card rounded-xl p-4 bg-card border border-border">
      <p className="text-caption text-muted-foreground mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-display font-bold text-foreground tabular-nums">
          {value}
        </span>
        {trend && (
          <span
            className={cn(
              "text-caption font-medium flex items-center gap-0.5",
              trendDirection === "up" ? "text-success" : "text-error",
            )}
          >
            {trendDirection === "up" ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}
```

### Data Table Pattern

```tsx
// Table container
<div className="rounded-xl border border-border overflow-hidden">
  <table className="w-full">
    <thead>
      <tr className="bg-muted/50 border-b border-border">
        <th className="px-4 py-3 text-left text-label font-medium text-muted-foreground">
          Column
        </th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row, i) => (
        <tr
          key={i}
          className={cn(
            "border-b border-border last:border-0",
            "transition-colors duration-fast",
            "hover:bg-muted/30",
          )}
        >
          <td className="px-4 py-3 text-body">{row.value}</td>
        </tr>
      ))}
    </tbody>
  </table>
</div>

// Numeric columns use tabular-nums
<td className="text-body tabular-nums text-right font-mono">
  {formatNumber(value)}
</td>
```

For empty states in data views, use the generic `EmptyState` component from Phase 7.

### Chart Containers

Wrap charts in an `elevation-card` with a title row and fixed height. Use a consistent color palette for multi-series data:

```tsx
const chartColors = [
  "hsl(211, 100%, 50%)", // Blue (primary)
  "hsl(160, 84%, 39%)", // Green
  "hsl(38, 92%, 50%)", // Amber
  "hsl(280, 65%, 60%)", // Purple
  "hsl(350, 80%, 60%)", // Rose
];
```

### Skeleton/Loading Pattern

```css
.shimmer-effect {
  position: relative;
  overflow: hidden;
}
.shimmer-effect::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    var(--shimmer-highlight),
    transparent
  );
  animation: shimmer 1.5s ease-in-out infinite;
}
:root {
  --shimmer-highlight: rgba(255, 255, 255, 0.08);
}
.dark {
  --shimmer-highlight: rgba(255, 255, 255, 0.04);
}
```

```tsx
function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("bg-muted/50 rounded-md shimmer-effect", className)} />
  );
}
// Usage: <Skeleton className="h-4 w-32" /> (text), <Skeleton className="h-10 w-full" /> (input)
```

---

## Phase 9: Pages & Final Polish

This is the integration phase. Every page should feel cohesive—the design system tokens, components, and patterns from Phases 1–8 should work together seamlessly. If something feels off, trace it back to the phase that owns it.

### Page Header Pattern

```tsx
function PageHeader({ title, description }: Props) {
  return (
    <div className="mb-8">
      <h1
        className={cn(
          "text-3xl font-bold tracking-tight",
          "bg-clip-text text-transparent",
          "bg-gradient-to-r from-foreground via-foreground/90 to-foreground/70",
        )}
      >
        {title}
      </h1>
      {description && (
        <p className="text-muted-foreground mt-2 text-base">{description}</p>
      )}
    </div>
  );
}
```

### Pre-Delivery Checklist

Before shipping UI:

#### Visual Quality

- [ ] No emojis as icons (use SVG)
- [ ] Consistent icon set throughout (Phosphor recommended)
- [ ] Hover states don't cause layout shift
- [ ] All elements on 4px grid
- [ ] Typography hierarchy is consistent
- [ ] Color used for meaning, not decoration
- [ ] Depth strategy consistent (all borders OR all shadows)

#### Interaction

- [ ] All interactive elements have hover states
- [ ] Clickable elements have `cursor: pointer`
- [ ] Focus states use ring, not outline
- [ ] Loading states for async operations
- [ ] Transitions are 150-300ms with apple easing
- [ ] Error states are clear and actionable
- [ ] Focus states visible for keyboard navigation
- [ ] Touch targets minimum 44px on all interactive elements

#### Feedback

- [ ] Buttons show pressed/active state
- [ ] Forms validate on blur or submit
- [ ] Success feedback for completed actions
- [ ] Empty states guide users to action

#### Responsive

- [ ] Works at 375px, 768px, 1024px, 1440px
- [ ] No horizontal scroll on mobile
- [ ] Content not hidden behind fixed elements
- [ ] Touch targets minimum 44px
- [ ] Text readable without zooming
- [ ] Sidebar collapses or becomes drawer on mobile
- [ ] Grid layouts adapt column count to viewport

#### Accessibility

- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] Interactive elements are keyboard accessible
- [ ] Form inputs have visible labels
- [ ] Images have alt text where meaningful
- [ ] Reduced motion respected (`prefers-reduced-motion`)

#### Technical

- [ ] Scrollbar styling (webkit) for consistency
- [ ] Selection styling (`::selection`)
- [ ] Smooth scroll behavior
- [ ] Backdrop filter fallback for older browsers
- [ ] `-webkit-backdrop-filter` for Safari

### Scrollbar Styling

```css
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: hsl(var(--muted-foreground) / 0.3);
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--muted-foreground) / 0.5);
}
```

### Selection Styling

```css
::selection {
  background: hsl(var(--primary) / 0.3);
  color: inherit;
}
```

### Reduced Motion Support

```css
@media (prefers-reduced-motion: reduce) {
  .animate-fade-slide-up,
  .animate-typing-dot,
  .animate-chip-in,
  .animate-pulse,
  .stagger-item {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }

  /* Disable hover translations */
  .hover\:-translate-y-px:hover,
  .hover\:-translate-y-0\.5:hover,
  .hover\:-translate-y-1:hover {
    transform: none !important;
  }

  /* Keep transitions very short for focus states */
  * {
    transition-duration: 0.01ms !important;
  }
}
```

### Backdrop Filter Fallback

```css
@supports not (backdrop-filter: blur(24px)) {
  .glass {
    background: hsl(var(--card) / 0.95);
  }
  .glass-subtle {
    background: hsl(var(--card) / 0.9);
  }
  .glass-strong {
    background: hsl(var(--card));
  }
}
```

### Glass Utility Classes

```css
.glass {
  background: hsl(var(--card) / 0.6);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid hsl(var(--glass-border));
}

.glass-subtle {
  background: hsl(var(--card) / 0.4);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid hsl(0 0% 100% / 0.04);
}

.glass-strong {
  background: hsl(var(--card) / 0.8);
  backdrop-filter: blur(32px);
  -webkit-backdrop-filter: blur(32px);
  border: 1px solid hsl(0 0% 100% / 0.08);
}

.glow-primary {
  box-shadow:
    0 0 20px hsl(var(--primary) / 0.15),
    0 0 40px hsl(var(--primary) / 0.1);
}

.divider-glow {
  height: 1px;
  width: 100%;
  background: linear-gradient(
    to right,
    transparent,
    hsl(var(--primary) / 0.2),
    transparent
  );
}
```

---

## Part 4: Anti-Patterns

### Never Do This

- Dramatic drop shadows (`box-shadow: 0 25px 50px...`)
- Large border radius (16px+) on small elements
- Asymmetric padding without clear reason
- Pure white cards on colored backgrounds
- Thick borders (2px+) for decoration
- Excessive spacing (margins > 48px between sections)
- Spring/bouncy animations
- Gradients for decoration
- Multiple accent colors in one interface
- Mixing hex and HSL colors
- Using opacity in color definitions (use `/alpha` syntax)
- Hard-coded shadow values (use tokens)
- Missing dark mode shadow adjustments
- Skipping phases (each builds on previous)
- Over-animating (subtle > dramatic)
- Different elevation systems in same app
- Native `<select>` without custom styling
- Missing `prefers-reduced-motion` support
- Forgetting `-webkit-backdrop-filter` for Safari
- Using `outline` instead of `ring` for focus states

---

## Part 5: Quick Reference

| Pattern            | Code                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Elevation-on-hover | `hover:-translate-y-px active:translate-y-0`                                                        |
| Glass morphism     | `glass` utility class (see Phase 9)                                                                 |
| Transition stack   | `transition-all duration-250 ease-apple`                                                            |
| Focus ring         | `focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2` |
| Gradient text      | `bg-clip-text text-transparent bg-gradient-to-r from-foreground via-foreground/90 to-foreground/70` |
| Avatar gradient    | `bg-gradient-to-br from-primary to-primary/70 shadow-glow-blue`                                     |
| Tabular numbers    | `tabular-nums font-mono`                                                                            |
| Status colors      | `text-{status} bg-{status}/10 border-{status}/20` (success/warning/error/info)                      |
| Active glow        | `isActive && "shadow-glow-blue animate-pulse"`                                                      |

### Glass Morphism Stack

```css
.glass {
  background: hsl(var(--card) / 0.6);
  backdrop-filter: blur(24px);
  border: 1px solid hsl(var(--glass-border));
  box-shadow: var(--shadow-glass);
}
```

### Status Color Pattern

```tsx
const statusColors = {
  success: "text-success bg-success/10 border-success/20",
  warning: "text-warning bg-warning/10 border-warning/20",
  error: "text-error bg-error/10 border-error/20",
  info: "text-info bg-info/10 border-info/20",
};
```

### Progress/Active State Glow

```tsx
className={cn(
  "transition-all duration-300",
  isActive && "shadow-glow-blue animate-pulse",
  isComplete && "shadow-card",
)}
```

---

## Tailwind Config Extensions

```js
// tailwind.config.js — structure overview (tokens defined in Phases 2-4)
module.exports = {
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: { DEFAULT: "hsl(var(--primary) / <alpha-value>)" },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)" },
        border: { DEFAULT: "hsl(var(--border) / <alpha-value>)" },
        "glass-border": "hsl(var(--glass-border))",
        // ... success, warning, error, info semantic colors
      },
      boxShadow: {
        ambient: "var(--shadow-ambient)",
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        glass: "var(--shadow-glass)",
        "glass-lg": "var(--shadow-glass-lg)",
        elevated: "var(--shadow-elevated)",
        "elevated-lg": "var(--shadow-elevated-lg)",
        "glow-blue": "var(--shadow-glow-blue)",
        "glow-blue-lg": "var(--shadow-glow-blue-lg)",
        // ... glow-green, glow-red
      },
      transitionTimingFunction: {
        apple: "cubic-bezier(0.25, 1, 0.5, 1)",
        spring: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      transitionDuration: { 250: "250ms", 350: "350ms", 400: "400ms" },
      keyframes: {
        // ... animation keyframes from Phase 4 (fade-in, fade-slide-up, scale-in, modal-enter, shimmer)
      },
      borderRadius: {
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
      },
    },
  },
};
```

---

## Part 6: File Structure Summary

After implementing all phases, you should have:

```
src/
├── index.css                  # CSS variables, glass utilities, reduced motion
├── hooks/
│   └── use-animations.ts      # useInView, useStagger, useCountUp, etc.
├── components/
│   ├── ui/
│   │   ├── Button.tsx         # Glow effects, elevation
│   │   ├── Input.tsx          # Glass borders, focus shift
│   │   ├── Select.tsx         # Custom chevron
│   │   ├── Checkbox.tsx       # Custom styled
│   │   ├── Modal.tsx          # Entry/exit animations
│   │   └── Card.tsx           # Variants: default, elevated, glass, interactive
│   └── layout/
│       ├── Sidebar.tsx        # Color-coded icons, gradient logo
│       ├── Header.tsx         # Glass effect
│       └── PageHeader.tsx     # Gradient title
tailwind.config.js             # Extended colors, shadows, animations
```
