// A check only a browser can make: switching a sheet's tabs away from an agent's trace and back keeps
// the trace as it was. Its socket stays open (no second connection), its history isn't fetched again,
// and the reader's scroll and what they expanded are where they left them. (A component test can't see
// this: Mantine renders `keepMounted` tabs without React's <Activity> in its test environment, and
// <Activity hidden> is what ran the trace's effect cleanups and closed its socket, PR #131.)
//
// The app's `serve` counts the traffic on `page.traffic` (`countTraffic`): trace sockets opened, and
// history pages asked for.

/** The trace's log (its scroller). */
export const LOG = "[data-ds=terminal] .mantine-ScrollArea-viewport";

/** Start counting a page's trace traffic; the app's routes call `traffic.socket()` and `traffic.history()`. */
export function countTraffic(page) {
  page.traffic = { sockets: 0, history: 0, socket() { this.sockets += 1; }, historyPage() { this.history += 1; } };
  return page.traffic;
}

export async function tabKeepCheck(page) {
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  // Only where the trace is a tab (a sheet below its two-column width).
  if (!(await tab("Trace").count()) || !(await tab("Details").count())) return [];
  await tab("Trace").click();
  const log = page.locator(LOG).first();
  await log.waitFor();
  await page.waitForTimeout(500);
  // Something to keep: a result expanded, and the log scrolled to its middle.
  const more = page.locator("[data-slot=more][aria-expanded=false]").first();
  if (await more.count()) await more.click();
  await page.waitForTimeout(200);
  const top = await log.evaluate((v) => {
    v.scrollTop = Math.floor((v.scrollHeight - v.clientHeight) / 2);
    v.dispatchEvent(new Event("scroll"));
    return v.scrollTop;
  });
  await page.waitForTimeout(400);
  const expanded = () => page.locator("[data-slot=more][aria-expanded=true]").count();
  const before = { sockets: page.traffic.sockets, history: page.traffic.history, expanded: await expanded() };
  await tab("Details").click();
  await page.waitForTimeout(500);
  await tab("Trace").click();
  await page.waitForTimeout(800);
  const after = { sockets: page.traffic.sockets, history: page.traffic.history, expanded: await expanded(), top: await page.locator(LOG).first().evaluate((v) => v.scrollTop) };
  const problems = [];
  if (after.sockets > before.sockets) problems.push(`switching tabs opened ${after.sockets - before.sockets} more trace socket(s)`);
  if (after.history > before.history) problems.push(`switching tabs fetched ${after.history - before.history} history page(s) again`);
  if (after.expanded !== before.expanded) problems.push(`switching tabs lost what was expanded (${before.expanded} open, then ${after.expanded})`);
  if (Math.abs(after.top - top) > 2) problems.push(`switching tabs moved the log's scroll from ${top} to ${after.top} px`);
  return problems;
}
