// What is left lying around, read by the Worker: `GET /v1/admin/lifetimes`, followed page by page
// (at most MAX_LIFETIME_PAGES) and merged into one answer. The control plane classifies; the page
// only shows (docs/control-plane/dashboard/#abandoned). Typed by the admin view contract.
import type { AgentLifetimeKind, LifetimeAgentView, LifetimeSandboxView, LifetimesView, SandboxLifetimeKind } from "../../protocol/admin/view";

/** Pages the Worker reads per request (the control plane's are 50 sandboxes, then 50 agents). */
export const MAX_LIFETIME_PAGES = 20;

/** What `GET /api/lifetimes` answers: the pages merged, how many were read, and whether more were left. */
export interface LifetimesResponse extends Omit<LifetimesView, "next_cursor"> {
  pages: number;
  truncated: boolean;
}

/** Pages merged in order: sandboxes appended, an agent found on two pages listed once, counts summed. */
export function mergePages(pages: readonly LifetimesView[], truncated: boolean): LifetimesResponse {
  const first = pages[0]!;
  const agents = new Map<string, LifetimeAgentView>();
  const sandboxes: LifetimeSandboxView[] = [];
  const counts = structuredClone(first.counts);
  let omitted = 0;
  for (const [i, p] of pages.entries()) {
    sandboxes.push(...p.sandboxes);
    for (const a of p.agents) if (!agents.has(a.agent)) agents.set(a.agent, a);
    omitted += p.agents_omitted;
    if (i === 0) continue;
    for (const k of Object.keys(p.counts.sandboxes) as SandboxLifetimeKind[]) counts.sandboxes[k] = (counts.sandboxes[k] ?? 0) + p.counts.sandboxes[k];
    for (const k of Object.keys(p.counts.agents) as AgentLifetimeKind[]) counts.agents[k] = (counts.agents[k] ?? 0) + p.counts.agents[k];
  }
  return {
    cell: first.cell, now_ms: first.now_ms, quiet_ms: first.quiet_ms, cell_idle_ttl_ms: first.cell_idle_ttl_ms,
    sandboxes, agents: [...agents.values()], counts, agents_omitted: omitted, pages: pages.length, truncated,
  };
}

/** The control plane's cursors: a sandbox page's, then the agent pages' (`a`, `a.<ms>.<agent>`). */
const CURSOR = /^(\d{1,16}\.sbx_[A-Za-z0-9]+|a|a\.\d{1,16}\.agt_[A-Za-z0-9]+)$/;

/**
 * Every page through `read` (the upstream GET for a cursor, null the first), up to the cap; more
 * left is `truncated`. A page that fails fails the answer with its response; a cursor not shaped like
 * the control plane's stops the walk, never sent on.
 */
export async function collectLifetimes(read: (cursor: string | null) => Promise<Response>): Promise<{ ok: LifetimesResponse } | { failed: Response }> {
  const pages: LifetimesView[] = [];
  let next: string | null = null;
  do {
    const res = await read(next);
    if (!res.ok) return { failed: res };
    const page = (await res.json()) as LifetimesView;
    pages.push(page);
    next = page.next_cursor;
  } while (next !== null && CURSOR.test(next) && pages.length < MAX_LIFETIME_PAGES);
  return { ok: mergePages(pages, next !== null) };
}
