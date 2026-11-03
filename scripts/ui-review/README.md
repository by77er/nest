# ui-review

The design review's tooling ([nest-design-review](../../.claude/skills/nest-design-review/SKILL.md)): it captures an app's pages and states at 1440, 1280 and 390 px (as a touch device) in light and dark, runs the automated checks on each screen, and exits non-zero on any failure. The rules it checks are [nest-ui-design](../../.claude/skills/nest-ui-design/SKILL.md)'s.

It has its own pinned Playwright and is never a dependency of an app. CI doesn't run it (Actions minutes); the author runs it before review, and the design reviewer runs it again on the PR's head.

## Install

```bash
cd scripts/ui-review && npm ci
npx playwright install --only-shell chromium   # once per machine, if Chromium isn't cached
cd ../../<app> && npm ci                        # the app's own vite, for `vite dev`
```

## Use

```bash
node scripts/ui-review/review.mjs <app> <out-dir> [--base-url URL] [--pages a,b] [--widths 1440,390] [--schemes dark]
node scripts/ui-review/selftest.mjs             # the checks fail their planted violations
```

- `<app>` is `projects` or `dashboard` (a config in `apps/`). `<out-dir>` must be outside the repo.
- It starts the app's `vite dev` on a free port (log in `<out-dir>/vite.log`) and stops it at exit, or uses `--base-url`.
- The API is served from `fixtures/<app>/` (`page.route`), so states only live events produce (stalled tasks, asks, reviews, live traces, a busy fleet) are reproducible. Fixtures hold made-up ids only, never a credential.
- `--pages` takes state names or section names.
- Output: `<state>-<width>-<scheme>.png` for every screen, and `report.json` (`passed`, failures per check, each screen's frame geometry, and every failure with its screen). Exit 0 if every check passed, 1 if any failed, 2 on a usage or setup error.

## Checks

| Check | Fails when |
|---|---|
| `overflow` | the page scrolls sideways, or an element is partly outside the viewport, other than inside its own scroller (a table or board) |
| `clipping` | text is cut by its own `overflow` or ellipsis, or something runs past its Panel's edge |
| `frame` | a screen hasn't exactly one visible h1; or across a section's views (same width and scheme), the h1's left edge, the header's width or the content's left edge differs by more than 1 px from the section's first view |
| `nav` | the visible nav rows' icons or labels aren't on one left edge, the product's name is off it, or the active row's ground, rule or text is a role color (chromatic) |
| `contrast` | visible text is under WCAG AA (4.5:1, or 3:1 for large text) against the composited background, in either scheme; text under an overlay, disabled, or transparent (a character drawn as something else) is skipped |
| `measure` | a `form` or `reading` measure doesn't start on the frame's left edge |
| `hit-overlap` | at touch widths (the 390 px context is a touch screen: `hasTouch`, `isMobile`), a tap on a control lands on another one whose hit area (its box, grown by any absolutely positioned `::before` or `::after`) reaches over it; not where the first is clipped away (a row scrolled out of its log), since no tap there is meant for it |
| `hit-size` | at touch widths, a control is covered at its centre (other than by a pinned bar or an open layer); or another control's centre is closer than 24 px (WCAG 2.5.8's spacing); or fewer than 90% of 25 taps across its square (44 px, or its share when another control is nearer) land on it. A link inside running text is the inline exception and fails only on a line under 24 px; a whole-card link (its `::after` over the card) must take at least half its card |
| `page-error` | an uncaught error, a console error, the app's error page, or a capture that failed |
| `content` | in user content (`selectors.content`: a manager's message), a heading is above the level it's demoted to or smaller than the text; or a figure's ground is dark or it's inverted, not on a fixed light canvas |
| `card-links` (projects) | clicking a context or chat card's PR link doesn't open the PR in a new tab, or moves the page (the whole-card link took it) |
| `rhythm` (projects) | measured on what's painted (text and badges), never the grown hit boxes, at 390: the header's meta text moves more than 4 px from the h1's on touch against a mouse; or in the trace (consecutive calls in document order), a call's gap to its result is more than half its gap to the next call; or in a task's PRs, a gap between its lines (number and title, badges, who attached it) is more than half the gap to the next PR; or the Manager's context differs touch against mouse. Planted cases in `selftest.mjs` |
| `chat-scroll` (projects) | acted out with the wheel: reading back, the line moves more than 2 px as content above grows or a reply arrives; a reply while reading back shows no cue; while following (on open, after growth, after the pill, after sending), the newest message isn't at least `md` (12 px) above the composer |
| `board-columns` (projects) | at 1280 px and up, the board's six columns don't fit without scrolling |
| `trace` (projects) | an agent trace's log scrolls sideways (its long lines must wrap), or one of its glyphs renders in an emoji font |
| `trace-tabs` (projects, `trace-tabs.mjs`) | switching the task drawer's tabs away from the trace and back opens a second trace socket, fetches a history page again, or loses the log's scroll or what was expanded (a browser-only check: Mantine's test environment renders `keepMounted` tabs without React's `<Activity>`) |

The apps' own `npm test` covers the code side (no inline styles, raw values or off-palette colors; tokens equal the skill's). Judgement (hierarchy, balance, placement) stays the reviewer's.

## Adding a page or state

A PR that adds or changes a page or state adds it to `apps/<app>.mjs` in the same PR:
- a state is `{ name, section, path }`, plus optionally `fixture` (a variant the app's `serve` understands), `after(page)` (open a drawer, click a tab), `full: false` (an overlay: capture and check the viewport only), `widths` (a subset), `httpErrors` (a state that fails requests on purpose) and `check(page, { width, scheme })` returning problems for an app-specific rule;
- `section` groups the views whose frame must not move;
- data a state needs goes in `fixtures/<app>/`;
- `selectors` say where the app's primitives mark the frame, header, measures, panels and nav.

A new check goes in `checks.mjs`, with a planted violation in `selftest.mjs`.
