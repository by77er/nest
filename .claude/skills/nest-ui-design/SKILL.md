---
name: nest-ui-design
description: Use when building or changing any web UI in this repo (the dashboard, the projects app, any new page). The owner's design guidance: stack, tokens (light and dark), layout primitives, gestalt and spacing rules, placement, motion, accessibility, and how it's enforced.
---

# Designing nest UIs

**Design like an expert designer, for clarity, usability and simple beauty.** Before any detail, settle what the page is for, who reads it, and the one thing they must see first. Remove whatever doesn't serve that. Then make what's left calm, legible and well proportioned. When a rule below and the user's clarity conflict, clarity wins; say so in the PR and propose the rule's change here.

The owner's direction (2026-11-02), in their words first:
- "bright and monochrome with action highlights in slightly pastel, but not overly pastel … close buttons should be reddish, yellow, green, blue, sort of like bootstrap colors";
- "use a component framework and best practices … instead of hand-rolling HTML";
- "a design system with consistent placement, containers, fonts, spacing, and alignment";
- "make use of gestalt principles and negative space … balanced and proportional";
- "polish where it matters: small animations, smooth transitions … but don't be obnoxious";
- "dark mode (follow system theme)";
- "approach this like an expert designer focused on clarity, usability, and simple beauty."

Each app (`dashboard/`, `projects/`) is its own Worker and imports nothing from another, so each keeps its own theme file. **This skill is the source of truth for the values.** An app's theme must match the tables below, and a change to them changes this file first.

## Stack

- **Base libraries:** React with Mantine (`@mantine/core`, `hooks`, `form`, `notifications`, `modals`) and one theme object (`src/ui/theme.ts`).
- **Server state:** TanStack Query, polling only while the tab is visible.
- **Routes:** TanStack Router, typed, with each page lazy-loaded.
- **Supporting libraries:**
  - dnd-kit for drag and drop;
  - `@tabler/icons-react` for icons;
  - Testing Library with Vitest (jsdom) for components.
- **Charts:** follow the `dataviz` skill, using the semantic and gray tokens below, never a library's default palette.
- **Dependencies:** exact pins at least two weeks old, each with a reason in its PR, and in `CODEOWNERS`.

## Tokens

Defined once in the theme (as Mantine values and CSS variables) and used by name everywhere else.

**Fonts** are self-hosted from npm (`@fontsource-variable/inter` for UI, `@fontsource-variable/jetbrains-mono` for ids, code and numbers in tables). No external font requests. Use `font-variant-numeric: tabular-nums` wherever numbers line up.

**Type scale** (size/line height in px; weights 400 body, 500 labels, 600 headings):

| Token | Size/LH | Use |
|---|---|---|
| caption | 12/16 | meta lines, timestamps, badges |
| small | 13/20 | secondary text, table cells |
| body | 14/20 | default |
| body-lg | 16/24 | lead text, chat |
| h4 | 14/20, 600 | panel and column titles |
| h3 | 16/24, 600 | section titles |
| h2 | 20/28, 600 | drawer and modal titles |
| h1 | 24/32, 600 | the page title, once per page |

**Spacing** (4 px base): `2xs 2`, `xs 4`, `sm 8`, `md 12`, `lg 16`, `xl 24`, `2xl 32`, `3xl 48`, `4xl 64`. Nothing else.

**Radii:** `sm 4` (badges, inputs), `md 8` (panels, cards, buttons). **Borders:** 1 px, `border` color. **Shadows:** `raised` (a card being dragged, a hovered card) and `overlay` (drawers, modals, menus); no others.

**Color** is monochrome, with color only for actions and status. Each role has a light and a dark value. The scheme follows the system (`prefers-color-scheme`, Mantine `defaultColorScheme="auto"`) with no toggle.

| Role | Light | Dark | Use |
|---|---|---|---|
| page | `#fafafa` | `#121314` | page background |
| surface | `#ffffff` | `#1a1b1e` | panels, cards, drawers |
| subtle | `#f1f3f5` | `#222327` | hover, column wells, code |
| border | `#e9ecef` | `#2c2e33` | hairlines |
| text | `#212529` | `#e9ecef` | body |
| muted | `#656d75` | `#9aa0a6` | meta, captions |
| primary | `#3b6fc0` | `#5a8ad6` | primary actions; assigned, in progress, in review |
| danger | `#c2414c` | `#d9606a` | close, cancel, delete, deny; cancelled, failed |
| warning | `#dca71c` (dark text) | `#e3b341` (dark text) | stalled, needs input, undelivered, expiring |
| success | `#2c8152` | `#3f9e6a` | done, approve, healthy |

- Each semantic role is a 10-shade Mantine tuple, with the filled shade as above. Dark mode uses Mantine's `primaryShade: {light: 6, dark: 5}` or equivalent.
- **Text on a filled role:** white in light (dark on warning); dark (the dark `page`, `#121314`) in dark, on every role. White on the dark values above is only 3.3 to 3.6:1.
- **A role's text on the ground** (an error line, a warning caption): shade 7 in light (8 for warning), shade 3 in dark. Shade 6 of warning is under 2:1 on white.
- Light (tinted) variants for badges and banners come from the same tuple.
- Never use pure RGB, and never invent a color outside this table.
- **Contrast:** text on every filled color, and every light badge, meets WCAG AA (4.5:1) in both schemes, checked by a test. If a dark value above fails, adjust it here and in the theme together.

## Layout primitives

Every screen is composed from these, in `src/ui/layout/`. Feature code arranges primitives and components; it doesn't style.

| Primitive | What it fixes |
|---|---|
| `AppFrame` | The header (product name left, nav right) and the content area |
| `Page` | Max content width 1440 px, centred. Gutters: `2xl` on desktop, `xl` on tablet, `lg` on phone. Vertical rhythm `2xl` between page-level blocks |
| `PageHeader` | Breadcrumb, then the h1 and a meta line. Actions go right-aligned on the title's baseline and wrap below it on narrow screens |
| `Section` | A heading row (h3, optional count, actions right) over content, `lg` below the heading. Sections are `2xl` apart |
| `Panel` | The bordered surface (`md` radius, `lg` padding; `md` when dense). Cards, side panels, banners and table frames are all Panels |
| `Toolbar` | Filters and actions in one row: `sm` gaps, wrapping |
| `Stack` / `Row` | Gaps only from the spacing scale |
| `FieldGroup` | Labels above fields, one column, `lg` between fields. Actions bottom-right |
| `EmptyState` / `LoadingState` / `ErrorState` | Centred in their container, at most one action; errors offer a retry |

## Gestalt and negative space

- **Proximity:** the gap inside a group is at most half the gap between groups. For example, use `sm` between a card's lines, `md` between cards, and `2xl` between sections. Related things touch; unrelated things breathe.
- **Common region:** a group that belongs together sits in one Panel. Don't nest Panels more than one deep; inside a Panel, group with spacing and dividers, not another border.
- **Similarity:** the same kind of thing always looks the same: one card style, one badge style per status, one button hierarchy (filled primary, default secondary, subtle tertiary).
- **Alignment and continuity:**
  - everything sits on a shared left edge per container;
  - column headers align with their cards' padding;
  - numbers are right-aligned, text left;
  - centring is only for empty states and single-purpose dialogs.
- **Figure and ground:** each view has one focal element (the board, the fleet table). Color marks only actions and status, so the eye goes where something needs doing.
- **Hierarchy:** one h1 per page, at most three text sizes in a component, and weight before size.
- **Negative space:**
  - don't fill every pixel, and leave room around the focal element;
  - side panels take at most a third of the width;
  - dense data (tables) gets dense spacing (`xs`/`sm` rows), but its frame keeps the page's outer space.
- **Balance:** the visual weight is spread so no edge is crowded and none is empty. When a layout looks heavy on one side, fix the grid, not individual margins.

## Placement

- A section's primary action is at its top right. Secondary actions sit to its left.
- Destructive actions come last, set apart by space or a divider, and always ask for confirmation, with cancel as the default.
- In forms and dialogs, the actions are bottom-right, with the primary rightmost.
- Status goes in a badge right after the thing it's about. Meta (who, when) goes on a caption line below.
- Toasts go bottom-right, only for results that happen elsewhere. Inline errors stay next to their field or panel.

## Motion

Subtle and functional. Motion explains a change; it never decorates.

- **Durations:**
  - `fast` 120 ms for hover, press and focus;
  - `base` 180 ms for small enter and leave (badges, toasts, menus);
  - `slow` 240 ms for drawers, modals and panel collapse.
- **Easing:** `cubic-bezier(0.2, 0, 0, 1)` on entering and `cubic-bezier(0.4, 0, 1, 1)` on leaving. No bounce or overshoot.
- **What may move:** animate only `opacity` and `transform`, plus the height of a collapse. Use Mantine `Transition`/`Collapse`, the theme's transition defaults, and dnd-kit's drop animation.
- **Where it's used:**
  - lists reorder with a short slide;
  - a value that updates by polling may fade or flash its tint once (`base`), never pulse;
  - loading uses skeletons or one spinner per container, and only after 300 ms.
- **Never:**
  - nothing loops except a loading indicator;
  - no parallax;
  - nothing animates on every poll.
- **Reduced motion:** honour `prefers-reduced-motion: reduce` by dropping transforms and keeping instant opacity changes.

## Accessibility

- AA contrast in both schemes.
- A visible focus ring (2 px, primary, 2 px offset).
- Everything reachable by keyboard, including drag (dnd-kit's keyboard sensor).
- Hit targets at least 32 px on desktop and 44 px on touch.
- Labels on every control, `aria-live` for polled changes that matter.
- Layout works from 390 px up with no horizontal page scroll, except a board or table inside its own scroller.

## Enforcement

- **A test fails** if feature code (`src/ui/features/**`, or the app's equivalent) has:
  - an inline `style={{…}}`;
  - a raw px, rem or hex value;
  - a color outside the semantic roles and grays;
  - a spacing prop outside the scale names.
  
  Only the theme and the primitives may define values.
- **The theme tests:**
  - check every token against the tables here;
  - check AA contrast in light and dark;
  - check that each status maps to its semantic role.
- **Every UI PR** includes screenshots at 1440, 1280 and 390 px in light and dark. They come from Playwright, run in a script outside the app's dependencies, together with an overflow and clipping check.
