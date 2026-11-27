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
- A full-page screenshot renders what `content-visibility: auto` skips far below the viewport (a long board's lower rows), as a reader scrolling there sees it; the checks run on the page as it is.
- Output: `<state>-<width>-<scheme>.png` for every screen, and `report.json` (`passed`, failures per check, each screen's frame geometry, and every failure with its screen). Exit 0 if every check passed, 1 if any failed, 2 on a usage or setup error.

## Checks

| Check | Fails when |
|---|---|
| `overflow` | the page scrolls sideways, or an element is partly outside the viewport, other than inside its own scroller (a table or board) |
| `clipping` | text is cut by its own `overflow` or ellipsis, or something runs past its Panel's edge; a deliberate one-line cut (`data-ds=truncate`) passes only with its whole text as its `title` |
| `frame` | a screen hasn't exactly one visible h1; or across a section's views (same width and scheme), the h1's left edge, the header's width or the content's left edge differs by more than 1 px from the section's first view |
| `nav` | the visible nav rows' icons or labels aren't on one left edge, the product's name is off it, or the active row's ground, rule or text is a role color (chromatic) |
| `contrast` | visible text is under WCAG AA (4.5:1, or 3:1 for large text) against the composited background, in either scheme; text under an overlay, disabled, or transparent (a character drawn as something else) is skipped |
| `measure` | a `form` or `reading` measure doesn't start on the frame's left edge |
| `hit-overlap` | at touch widths (the 390 px context is a touch screen: `hasTouch`, `isMobile`), over everything the reader can scroll to (`scanHits`: the page in viewport steps, then every scroller in the topmost layer, sideways or down, a drawer's body included, each stepped through), a tap on a control lands on another one whose hit area (its box, grown by any absolutely positioned `::before` or `::after`) reaches over it |
| `hit-size` | at touch widths, over the same scroll scan, a control is covered at its centre (other than by a pinned bar or a layer open over it; a control inside a drawer or dialog is judged in it, its misses counted); or another control's centre is closer than 24 px (WCAG 2.5.8's spacing); or fewer than 90% of 25 taps across its square (44 px, or its share when another control is nearer) land on it. A link inside running text is the inline exception and fails only on a line under 24 px; a whole-card link (its `::after` over the card) must take at least half its card |
| `page-error` | an uncaught error, a console error, the app's error page, or a capture that failed |
| `content` | in user content (`selectors.content`: a manager's message), a heading is above the level it's demoted to or smaller than the text; or a figure's ground is dark or it's inverted, not on a fixed light canvas |
| `card-links` (projects) | clicking a context or chat card's PR link doesn't open the PR in a new tab, or moves the page (the whole-card link took it) |
| `chat-fit` (projects) | on the Manager's chat, at both ends of its scroll (the log, or on a phone the page's column): the document scrolls, the composer is off screen or not pinned at the viewport's bottom, or at the end it isn't right under the log; a two-line draft (Shift+Enter) isn't kept unsent. Planted cases in `selftest.mjs`. Beside it, the context column scrolls in itself while the viewport has room below it (`context-empty-chat`, a `clipping` failure) |
| `rhythm` (projects) | measured on what's painted (text and badges), never the grown hit boxes, at 390: the header's meta text moves more than 4 px from the h1's on touch against a mouse; or in the trace (consecutive calls in document order), a call's gap to its result is more than half its gap to the next call; or in a task's PRs, a gap between its lines (number and title, badges, who attached it) is more than half the gap to the next PR; or the Manager's context differs touch against mouse. Planted cases in `selftest.mjs` |
| `chat-scroll` (projects) | acted out with the wheel: reading back, the line moves more than 2 px as content above grows or a reply arrives; a reply while reading back shows no cue; while following (on open, after growth, after the pill, after sending), the newest message isn't at least `md` (12 px) above the composer |
| `board-list` (projects) | the board's list scrolls sideways; or from 768 px up a row is taller than one line (44 px), or the rows' titles or times don't line up; or a row moved by keyboard (space, arrow down, space) isn't where it was dropped (`board-keyboard-move`); or mid-drag the dragged row isn't lifted, its shadow and a hairline round it (`board-dragging`) |
| `link-targets` (projects) | a Settings Panel opened by its link (`#triage`, `#pr-comments`): the Panel's top isn't in the viewport, or focus isn't on its heading with the theme's ring (2 px solid); Needs you's Leave it unset answered 502 (`comments-cleared-unset-failed`): focus drops to the page or a native-disabled button while it's sent or after, the button isn't `aria-busy`, or the item goes |
| `asks` (projects) | "Needs you" read from nest (`asks-*` states): while the asks are read, the app's own items aren't shown, the list doesn't say it's reading, its count isn't "?", or with none of its own items the board's heading moves more than 1 px across the read; nest unreadable (also with nothing else waiting), or the first read failing: the panel is gone, doesn't say the asks couldn't be read, or its count isn't "?", or a count shows that couldn't be checked (the Board row, the projects list); a later failure without the "Couldn't refresh" line, or the Board row keeping a number; answering: the item flickers (comes and goes more than once), focus drops to the page or a native-disabled button, the 409 shows no note or a failure notification, the 502 isn't announced, the sidebar's count doesn't follow the answer; the last item answered: the panel stays, focus isn't on the board's heading with the theme's ring (2 px solid, 2 px offset), or the live region doesn't say so; an empty panel with a warning tone or a count |
| `trace` (projects) | an agent trace's log scrolls sideways (its long lines must wrap), or one of its glyphs renders in an emoji font |
| `trace-tabs` (projects, `trace-tabs.mjs`) | switching the task drawer's tabs away from the trace and back opens a second trace socket, fetches a history page again, or loses the log's scroll or what was expanded (a browser-only check: Mantine's test environment renders `keepMounted` tabs without React's `<Activity>`) |

The apps' own `npm test` covers the code side (no inline styles, raw values or off-palette colors; tokens equal the skill's). Judgement (hierarchy, balance, placement) stays the reviewer's.

## perf.mjs

The projects app's performance harness: every page and main flow, played the same way against a built client with large generated fixtures, so a change's speed is measured before and after ([projects' Performance](../../projects/README.md#performance)). Like the captures, it never needs the deployed app or a credential; CI doesn't run it.

```bash
cd projects && npm ci && npm run build                          # the client, in dist/client
node scripts/ui-review/perf.mjs <out-dir> --dist projects/dist/client [--commit SHA] [--label NAME]
node scripts/ui-review/perf.mjs <out-dir> --base-url URL ...   # or a static server of it you run
node scripts/ui-review/perf.mjs --compare before.json after.json   # a before/after table, with deltas
```

- **Served:** `--dist` serves the build itself as the app's Worker does: index.html for any other path, an ETag on everything (`304` to a match), br or gzip, and `--assets worker` (the default) caching as `projects/src/asset-cache.ts` does since #318 (a content-hashed `/assets/` file immutable for a year, everything else `no-cache`); `--assets workers-assets` is Workers Assets' own `public, max-age=0, must-revalidate` on everything, for a commit before #318. `--base-url` takes any server of it instead.
- **The API** comes from `perf-fixtures.mjs`, generated from a seed (`--seed`, default 1) on top of the demo fixture's objects: 6 projects, the open one with 300 tasks (60% done), 200 chat messages (Markdown, code, math, task references; pages of 50), 100 review jobs, 6 routines with 60 runs, 40 issues, 30 secrets, 24 hosts per network rule list. `--shape full` answers the task list with every body and spec (the API before #308); `summary` (the default) without them. Every `GET` answer has an ETag and is `304` to a matching `If-None-Match`; a client that never sends one gets `200`s. Each answer waits `--api-ms` (default 40), a Worker's round trip; its bytes are counted gzipped, as Cloudflare sends them. It's answered through CDP's `Fetch` interception on `*/api/*`, not `page.route`: Playwright turns the HTTP cache off while it routes, and the warm loads need it.
- **Traces:** every agent's has 2,000 events: 500 in five history pages (Load older), a 1,000-event backlog sent on connecting (`context.routeWebSocket`, as `selftest.mjs` does), and 500 streamed live, only in the streaming flows, at `--rate` events/s (default 20).
- **Pages**, each loaded cold (a new browser, cache empty), then warm (a new tab, cache filled), then left idle for `--idle` s (default 15): `projects`, `board`, `board-drawer` (a task with a worker's trace), `manager-chat`, `manager-trace`, `reviews`, `reviews-trace`, `routines`, `routines-trace`, `triage`, `secrets`, `network`, `settings`, `admin`.
- **Flows**, each on its page once loaded: `switch-view` (Board → Manager → Reviews), `switch-project`, `drawer` (open and close), `type-composer` (40 characters, with all 200 messages shown), `stream-chat` and `stream-trace` (a 10 s live turn), `open-trace` (the Trace tab, its 1,000-event backlog), `older-chat` and `older-trace` (three older pages), `drag-reorder` (a board row by pointer), `tab-switch` (Chat ↔ Trace, three times), `idle-board` and `idle-manager` (60 s of polling). `--only` takes names, `page` or `flow`.
- **Measured** per window (cold, warm, idle, or the flow): requests and bytes by type (document, script, style, font, API; the trace's WebSocket messages apart; bodies as sent, without headers) and API requests per endpoint with their `304`s; for an idle window, API requests and bytes per minute; time to the content (a stated selector, polled every frame); long tasks (`PerformanceObserver('longtask')`: count, total, max and the time over 50 ms); the renderer's script, layout and style time (CDP `Performance.getMetrics` deltas), its DOM nodes and JS heap; for typing, each key's keydown to the frame after its paint (worst and median).
- **CPU** throttled `--cpu` times (CDP, default 4); the report states it, the shape, the asset caching, the API latency and the rate.
- **Measuring an older commit:** build it in a `git worktree` and add `--shape full` before #308 and `--assets workers-assets` before #318.
- **Output:** `<out-dir>/perf.json` and `perf.md` (a row per window); with `--compare other.json`, also `compare.md` (other as before). A scenario that failed, or whose page threw (a fixture whose shape drifted from the API's, say), is an error, and leaves `<name>-error.png` and `.html` there. Each scenario runs alone, in its own browser. Exit 0 whatever the numbers; 2 when a scenario couldn't be played, or on a usage or setup error.
- **In a sandbox** (small, shared): nothing heavy alongside, `free -m` between runs, and run it detached with its output to a file (a long foreground call gets cut). Absolute times swing between machines and runs: compare runs from one machine, and rerun before trusting a change smaller than the variation [projects' Performance](../../projects/README.md#performance) gives.

## Adding a page or state

A PR that adds or changes a page or state adds it to `apps/<app>.mjs` in the same PR:
- a state is `{ name, section, path }`, plus optionally `fixture` (a variant the app's `serve` understands), `after(page)` (open a drawer, click a tab), `full: false` (an overlay: capture and check the viewport only), `widths` (a subset), `httpErrors` (a state that fails requests on purpose) and `check(page, { width, scheme })` returning problems for an app-specific rule;
- `section` groups the views whose frame must not move;
- data a state needs goes in `fixtures/<app>/`;
- `selectors` say where the app's primitives mark the frame, header, measures, panels and nav.

A new check goes in `checks.mjs`, with a planted violation in `selftest.mjs`.
