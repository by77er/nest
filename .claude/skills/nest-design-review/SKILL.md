---
name: nest-design-review
description: Use for the design review every frontend change needs before merge (a diff under dashboard/ or projects/src/ui/, or to the nest-ui-design skill), as the independent reviewer. The procedure: capture the screens with scripts/ui-review, run its automated checks, judge the screens against nest-ui-design, and give a PASS or FAIL verdict.
---

# Design review of a frontend change

The owner's direction (2026-11-02): "integrate a design review into each frontend change". **A PR touching `dashboard/**`, `projects/src/ui/**` or `.claude/skills/nest-ui-design/` merges only after a design review PASS**, separate from the code review (`nest-review`). The rules judged are `nest-ui-design`'s; this skill is the procedure.

## Who and from what

- **An independent reviewer:** not the author, and never from the author's transcript, report or screenshots. Review from the PR's head, the diff and `nest-ui-design`.
- **Fresh screens,** captured by the reviewer.

## Capture and check

Run [scripts/ui-review/](../../../scripts/ui-review/README.md) against the PR's head for each app it touches:

```bash
(cd scripts/ui-review && npm ci) && (cd <app> && npm ci)
node scripts/ui-review/review.mjs <app> <out-dir>
```

- It captures every configured page and state (empty, error, long content, open overlays, the phone navigation) at 1440, 1280 and 390 px in light and dark, so the unchanged views of a section are there to compare.
- **A page or state the PR adds or changes that the app's config lacks** (`scripts/ui-review/apps/<app>.mjs`) is added to it first, in the same PR. A screen that wasn't captured wasn't reviewed.
- **Every automated check must pass** (exit 0; `report.json` lists each failure): no horizontal scroll or clipping, a stable frame across a section's views, one nav edge with a quiet active row, AA contrast in both schemes, measures on the frame's left edge, and no page errors.
- The apps' own design and theme tests (`npm test`) cover the code side: no inline styles, raw values or off-palette colors.

## Judgement

Look at every screen as a designer, against each section of `nest-ui-design`:
1. **Purpose and focal point:** is the one thing to see first obvious? Does everything there serve the page?
2. **Hierarchy:** the h1, text sizes and weights ([Gestalt](../nest-ui-design/SKILL.md#gestalt-and-negative-space)).
3. **Gestalt:** proximity, common region, similarity, alignment, figure and ground.
4. **Consistency across views:** the frame doesn't move, and shared things look identical everywhere ([Layout primitives](../nest-ui-design/SKILL.md#layout-primitives)).
5. **Negative space and balance:** room around the focal point, no crowded or empty edge, side panels in proportion.
6. **Navigation and placement:** location said once, the quiet active row; actions, destructive actions and status where [Placement](../nest-ui-design/SKILL.md#placement) puts them.
7. **Color and states:** semantic roles only; every status distinguishable, with an icon as well as color; dark mode with the hierarchy of light.
8. **Motion:** only where it explains a change, at the skill's durations, never on a poll, reduced motion honoured.
9. **Usability and accessibility:** keyboard reach and visible focus, hit targets, labels, live regions where updates matter, short clear copy.
10. **Phone:** the layout holds at 390 px, and the navigation and actions are reachable with one hand.

## Verdict

- **PASS or FAIL; no "pass with nits".** FAIL if any automated check fails or any finding hurts clarity, consistency or usability.
- **Each finding gives** the screen file (page, width, scheme), the rule it breaks, what's wrong concretely ("the h1 moves 120 px right between Board and Manager") and a specific fix. Non-blocking polish is listed separately.
- **Post it** as a PR comment, or report it to whoever ran the review, with the screenshot paths.
- **A finding that recurs across PRs** becomes a rule in `nest-ui-design`, with a check in `scripts/ui-review/` where one is possible.
