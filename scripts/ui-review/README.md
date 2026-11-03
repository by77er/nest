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
| `contrast` | visible text is under WCAG AA (4.5:1, or 3:1 for large text) against the composited background, in either scheme; text under an overlay or disabled is skipped |
| `measure` | a `form` or `reading` measure doesn't start on the frame's left edge |
| `page-error` | an uncaught error, a console error, the app's error page, or a capture that failed |
| `content` | in user content (`selectors.content`: a manager's message), a heading is above the level it's demoted to or smaller than the text; or a figure's ground is dark or it's inverted, not on a fixed light canvas |
| `chat-scroll` (projects) | acted out with the wheel: reading back, the line moves more than 2 px as content above grows or a reply arrives; a reply while reading back shows no cue; after sending, or while following as content grows, the newest message isn't clear of the composer |
| `board-columns` (projects) | at 1280 px and up, the board's six columns don't fit without scrolling |

The apps' own `npm test` covers the code side (no inline styles, raw values or off-palette colors; tokens equal the skill's). Judgement (hierarchy, balance, placement) stays the reviewer's.

## Adding a page or state

A PR that adds or changes a page or state adds it to `apps/<app>.mjs` in the same PR:
- a state is `{ name, section, path }`, plus optionally `fixture` (a variant the app's `serve` understands), `after(page)` (open a drawer, click a tab), `full: false` (an overlay: capture and check the viewport only), `widths` (a subset), `httpErrors` (a state that fails requests on purpose) and `check(page, { width, scheme })` returning problems for an app-specific rule;
- `section` groups the views whose frame must not move;
- data a state needs goes in `fixtures/<app>/`;
- `selectors` say where the app's primitives mark the frame, header, measures, panels and nav.

A new check goes in `checks.mjs`, with a planted violation in `selftest.mjs`.
