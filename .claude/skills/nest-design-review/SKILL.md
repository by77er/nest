---
name: nest-design-review
description: Use for the design review every frontend change needs before merge (anything under dashboard/ or projects/src/ui/, or a change to the nest-ui-design skill). How an independent reviewer captures the screens, runs the automated checks and judges the design against nest-ui-design, ending in PASS or FAIL.
---

# Design review of a frontend change

The owner's direction (2026-11-02): "integrate a design review into each frontend change". **Every PR that touches `dashboard/**`, `projects/src/ui/**` or `.claude/skills/nest-ui-design/` needs a design review verdict of PASS before it merges.** It's separate from the code review (`nest-review`), and it's done by someone who didn't build the change.

## Who and from what

- **An independent reviewer.** Not the author, and never from the author's transcript or report. Review from the running app, the diff and the `nest-ui-design` skill.
- **Fresh screens,** captured by the reviewer against the PR's head, never the author's screenshots.

## Capture

Use the shared tooling in `scripts/ui-review/` (pinned Playwright, run with `npx` outside the apps' dependencies; see its README). For the app the PR touches:
- **Every page and state the change affects**, at **1440, 1280 and 390 px**, in **light and dark**. Include:
  - empty, loading and error states;
  - long and overflowing content;
  - open overlays (drawers, menus, modals);
  - the phone navigation.
- **Every other view in the same section**, even unchanged ones, so consistency across views can be judged.

## Automated checks

All must pass, and they come from the same tooling:
- no horizontal page scroll; nothing clipped or truncated inside its container;
- **the frame is stable**: the h1's position and width and the content's left edge are identical across the views of a section;
- one left edge in navigation, with the active nav state using no role color;
- AA contrast for text, muted text, filled roles and badges in both schemes;
- reading and form measures left-aligned to the frame;
- no inline styles, raw values or off-palette colors in feature code (the apps' `design` tests).

## Judgement

Look at the screens as a designer focused on clarity, usability and simple beauty. For each, ask these questions, which map to `nest-ui-design`:
1. **Purpose and focal point:** is the one thing to see first obvious? Is anything there that doesn't serve the page?
2. **Hierarchy:**
   - one h1;
   - weight before size;
   - at most three text sizes in a component;
   - titles that say where you are.
3. **Gestalt:**
   - **proximity:** within-group gaps at most half of between-group gaps;
   - **common region:** Panels at most one deep;
   - **similarity:** the same kind of thing looks the same everywhere;
   - **alignment:** one left edge per container, numbers right-aligned;
   - **figure and ground:** color only for actions and status.
4. **Consistency across views:** the frame, header, gutters and nav don't move or change shape between views of a section, and shared things (task cards, badges, status colors) look identical wherever they appear.
5. **Negative space and balance:**
   - room around the focal point;
   - no crowded edge, no empty half-page;
   - side panels at most a third of the width.
6. **Placement:**
   - a primary action top-right of its section;
   - destructive actions last, separated and confirmed;
   - form actions bottom-right.
7. **Color and states:**
   - semantic roles only;
   - pass, fail and every status distinguishable, with an icon as well as color;
   - dark mode with the same hierarchy as light.
8. **Motion:**
   - only where it explains a change;
   - durations from the skill;
   - nothing on every poll;
   - reduced motion honoured.
9. **Usability and accessibility:**
   - keyboard reachable, with visible focus;
   - hit targets;
   - labels;
   - live regions where updates matter;
   - copy that's clear and short.
10. **Phone:** the layout holds at 390 px, and the navigation and actions are reachable with one hand.

## Verdict

- **PASS or FAIL. No "pass with nits".** FAIL if any automated check fails or any finding hurts clarity, consistency or usability.
- **Each finding gives:**
  - the screen file (page, width, scheme);
  - the principle it breaks;
  - what's wrong, concretely (e.g. "the h1 moves 120 px right between Board and Manager");
  - a specific fix.
- **Non-blocking polish** is listed separately.
- **Where it goes:** the PR's verdict is posted as a PR comment, or reported to whoever runs the review, with the screenshot paths. A finding that recurs across PRs goes into `nest-ui-design` as a rule, with a mechanical check where one is possible.
