---
name: nest-ui-design
description: Use when building or changing any web UI in this repo (the dashboard, the projects app, any new page). The owner's design rules and the source of truth for the apps' themes: stack, tokens (light and dark), layout primitives, gestalt and spacing, navigation, placement, motion, accessibility, and how each is enforced.
---

# Designing nest UIs

**Design for clarity, usability and simple beauty.** Settle what the page is for, who reads it and the one thing they must see first; cut what doesn't serve that; make the rest calm, legible and proportioned. If a rule here hurts clarity, clarity wins: say so in the PR and propose the rule's change here.

The owner's direction (2026-11-02), in their words:
- "bright and monochrome with action highlights in slightly pastel, but not overly pastel … close buttons should be reddish, yellow, green, blue, sort of like bootstrap colors";
- "use a component framework and best practices … instead of hand-rolling HTML";
- "a design system with consistent placement, containers, fonts, spacing, and alignment";
- "make use of gestalt principles and negative space … balanced and proportional";
- "polish where it matters: small animations, smooth transitions … but don't be obnoxious";
- "dark mode (follow system theme)";
- "approach this like an expert designer focused on clarity, usability, and simple beauty."

Each app (`dashboard/`, `projects/`) is its own Worker with its own theme file. **This skill is the source of truth for the values:** a value changes here first, then in both themes, whose tests read the tables below.

## Stack

- React with Mantine (`@mantine/core`, `hooks`, `form`, `notifications`, `modals`) and one theme object (`src/ui/theme.ts`).
- TanStack Query for server state, polling only while the tab is visible; TanStack Router, typed, each page lazy-loaded.
- dnd-kit for drag and drop, `@tabler/icons-react` for icons, Testing Library with Vitest (jsdom) for components.
- Charts follow the `dataviz` skill with the semantic and gray tokens below, never a library's default palette.
- Dependencies: exact pins at least two weeks old, each with a reason in its PR (`CODEOWNERS`).

## Tokens

Defined once in the theme (as Mantine values and CSS variables) and used by name everywhere else.

**Fonts** are self-hosted from npm (`@fontsource-variable/inter` for UI, `@fontsource-variable/jetbrains-mono` for ids, code and numbers in tables); no external font requests. Numbers that line up use `font-variant-numeric: tabular-nums`.

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

**Radii:** `sm 4` (badges, inputs), `md 8` (panels, cards, buttons). **Borders:** 1 px, `border` color. **Shadows:** `raised` (a dragged or hovered card) and `overlay` (drawers, modals, menus); no others.

**Color** is monochrome, with color only for actions and status. The scheme follows the system (`prefers-color-scheme`, Mantine `defaultColorScheme="auto"`), with no toggle.

| Role | Light | Dark | Use |
|---|---|---|---|
| page | `#fafafa` | `#121314` | page background |
| surface | `#ffffff` | `#1a1b1e` | panels, cards, drawers |
| subtle | `#f1f3f5` | `#222327` | hover, column wells, code |
| border | `#e9ecef` | `#2c2e33` | hairlines |
| text | `#212529` | `#e9ecef` | body |
| muted | `#666e76` | `#9aa0a6` | meta, captions |
| primary | `#3b6fc0` | `#5a8ad6` | primary actions; assigned, in progress, in review |
| danger | `#c2414c` | `#d9606a` | close, cancel, delete, deny; cancelled, failed |
| warning | `#dca71c` (dark text) | `#e3b341` (dark text) | stalled, needs input, undelivered, expiring |
| success | `#2c8152` | `#3f9e6a` | done, approve, healthy |

- Each semantic role is a 10-shade Mantine tuple whose filled shade is the value above (`primaryShade: {light: 6, dark: 5}` or equivalent). Light (tinted) badge and banner variants come from the same tuple.
- **Text on a filled role:** white in light (dark on warning); in dark, the dark `page` (`#121314`) on every role, since white on the dark values is only 3.3 to 3.6:1.
- **A role's text on the ground** (an error line, a warning caption): shade 7 in light (8 for warning), shade 3 in dark. Shade 6 of warning is under 2:1 on white.
- No pure RGB, and no color outside this table.
- **Contrast:** all text, every filled role's text and every light badge meet WCAG AA (4.5:1) in both schemes. A failing value is fixed here and in the theme together. (Bootstrap's `#6c757d` is 4.49:1 on light `page`, hence `muted` `#666e76`.)

## Layout primitives

Every screen is composed from these, in `src/ui/layout/`. Feature code arranges primitives and components; it doesn't style.

| Primitive | What it fixes |
|---|---|
| `AppFrame` | The sidebar (the product name small at its top, the places, a footer set apart by a hairline; a burger-toggled drawer on a phone) and the content area |
| `NavRow` / `NavGroup` | One row style for every place: icon column, height, padding, left edge and the quiet active state ([Navigation](#navigation)) |
| `Page` | Max content width 1440 px, centred. Gutters `2xl` desktop, `xl` tablet, `lg` phone; `2xl` between page-level blocks. The frame never moves: every view of a section uses the same `Page`; narrow content goes in a left-aligned `Measure` |
| `WithContext` / `SectionGrid` | A narrow view's content on the frame's left edge with a sticky context column beside it, at most a third of the width (a disclosure above it when narrow); sections as Panels in a responsive two-column grid, aligned to the top |
| `PageHeader` | The h1 (the thing the page is about) and a meta line; no breadcrumb. Actions right-aligned on the title's baseline, wrapping below it when narrow |
| `Section` | A heading row (h3, optional count, actions right) over content, `lg` below the heading; sections `2xl` apart |
| `Panel` | The bordered surface (`md` radius, `lg` padding, `md` when dense). Cards, side panels, banners and table frames are all Panels |
| `Toolbar` | Filters and actions in one row, `sm` gaps, wrapping |
| `Stack` / `Row` | Gaps only from the spacing scale |
| `FieldGroup` | Labels above fields, one column, `lg` between fields; actions bottom-right |
| `EmptyState` / `LoadingState` / `ErrorState` | Centred in their container, at most one action; errors offer a retry |

**The frame is stable.** Across the views of a section, the h1's position and width, the content's left edge, the gutters, the header and the nav don't move or change shape. Shared things (task cards, badges, status colors) look identical wherever they appear.

## Gestalt and negative space

- **Proximity:** a gap inside a group is at most half the gap between groups (`sm` between a card's lines, `md` between cards, `2xl` between sections).
- **Common region:** what belongs together sits in one Panel. Panels nest at most one deep; inside one, group with spacing and dividers, not another border.
- **Similarity:** one card style, one badge style per status, one button hierarchy (filled primary, default secondary, subtle tertiary).
- **Alignment:** one shared left edge per container; column headers align with their cards' padding; numbers right-aligned, text left; centring only for empty states and single-purpose dialogs.
- **Figure and ground:** one focal element per view (the board, the fleet table). Color marks only actions and status, so the eye goes where something needs doing.
- **User content** (Markdown, SVG) can't change the page's outline, hierarchy or ground: its headings are demoted below the page's own and set at body size by weight; its figures sit on a fixed light canvas in both schemes, never inverted.
- **Hierarchy:** one h1 per page, at most three text sizes in a component, weight before size.
- **Negative space:** don't fill every pixel; leave room around the focal element; side panels take at most a third of the width; dense data gets dense rows (`xs`/`sm`) inside a frame that keeps the page's outer space.
- **Continuity:** within a section of an app, switching views never moves the header or the page edges. A view whose content is narrow left-aligns it to the frame and uses the remaining width for related context, not empty margins.
- **Balance:** no edge crowded, none empty. A layout heavy on one side is fixed in the grid, not with individual margins.

## Navigation

- **Where you are is said once:** the sidebar's active row (and the switcher for the parent). No breadcrumb, and no h1 naming the view: the h1 is the thing (a project's name), or the page's own name off any thing ("Projects", "Admin"). A view needing a heading gets a quiet h3 ("Tasks").
- **A switcher for the parent, flat rows for its views,** one level each; never a tree repeating the views under every parent. The switcher (the parent's name, a button) opens a searchable, keyboard-first list: "all", then every parent with its badge; a pick keeps the current view where the parent has it. Outside a parent, only the switcher and the list's link.
- **One left edge, one row style:** every row (views, "all", Admin) is a `NavRow`: one icon column, height, padding and left edge. The product's name sits on that edge at the top, small and caption-weight, not a second heading.
- **A quiet active state, no role color:** the `subtle` ground, full-weight text and a 2 px left rule in the `text` color. Hover is `subtle` at lower emphasis; focus is the focus ring. The nav never outshouts the focal element.
- **A badge on the thing that needs attention, once:** the current parent's count on the view that handles it (a project's Board row), not again on the switcher's button; the switcher's list shows every parent's. Never beside a chevron.
- **Proximity:** rows `xs` apart, groups `xl` apart; the footer (Admin) set apart by space and a hairline.
- **Phone:** a burger opens the same sidebar as a drawer, the switcher first; picking a place closes it.

## Placement

- A section's primary action is at its top right, secondary actions to its left.
- Destructive actions come last, set apart by space or a divider, and always confirm, with cancel as the default.
- Form and dialog actions are bottom-right, the primary rightmost.
- Status is a badge right after the thing it's about; meta (who, when) is a caption line below.
- Toasts go bottom-right, only for results that happen elsewhere; inline errors stay next to their field or panel.

## Motion

Motion explains a change; it never decorates.

- **Durations:** `fast` 120 ms for hover, press and focus; `base` 180 ms for small enter and leave (badges, toasts, menus); `slow` 240 ms for drawers, modals and panel collapse.
- **Easing:** `cubic-bezier(0.2, 0, 0, 1)` on entering and `cubic-bezier(0.4, 0, 1, 1)` on leaving. No bounce or overshoot.
- **Only `opacity` and `transform` animate,** plus a collapse's height, through Mantine `Transition`/`Collapse`, the theme's defaults and dnd-kit's drop animation.
- **Uses:** lists reorder with a short slide; a polled value that changes may fade or flash its tint once (`base`), never pulse; loading shows skeletons or one spinner per container, only after 300 ms.
- **Never:** a loop other than a loading indicator, parallax, or animation on every poll.
- **Reduced motion** (`prefers-reduced-motion: reduce`) drops transforms and keeps instant opacity changes.

## Accessibility

- A visible focus ring (2 px, primary, 2 px offset); AA contrast as in [Tokens](#tokens).
- Everything reachable by keyboard, drag included (dnd-kit's keyboard sensor).
- Hit targets at least 32 px on desktop and 44 px on touch.
- A label on every control; `aria-live` for polled changes that matter.
- Works from 390 px up with no horizontal page scroll; only a board or table may scroll, inside its own scroller.

## Enforcement

- **The apps' design tests** fail feature code (`src/ui/features/**` or the equivalent) with an inline `style={{…}}`, a raw px, rem or hex value, a color outside the roles and grays, or a spacing prop off the scale. Only the theme and the primitives define values.
- **Navigation:** sidebar places render through `NavRow` (Mantine's `NavLink` and `Breadcrumbs` are refused in feature code), and the nav primitives' styles name no role color except the focus ring.
- **The theme tests** check every token against the tables here, AA contrast in light and dark, and each status's semantic role.
- **Every UI PR** is captured and checked by [scripts/ui-review/](../../../scripts/ui-review/README.md) (1440, 1280 and 390 px, light and dark) and passes a design review (`nest-design-review`) before it merges.
