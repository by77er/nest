// One trace connection for every view of an agent under it: the Manager page's Chat and Trace tabs read
// the same socket and history, so switching between them neither reconnects (a backlog of a thousand
// events replayed) nor fetches a history page again. A view outside a provider, or of another agent,
// connects for itself.

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useTrace } from "./useTrace";

type Trace = ReturnType<typeof useTrace>;

const Shared = createContext<{ agent: string; trace: Trace } | null>(null);

/** Connects to `agent`'s trace for the views under it (none while `agent` is null). */
export function SharedTrace({ agent, children }: { agent: string | null; children: ReactNode }) {
  const trace = useTrace(agent);
  const { state, loadOlder } = trace;
  const value = useMemo(() => (agent ? { agent, trace: { state, loadOlder } } : null), [agent, state, loadOlder]);
  return <Shared.Provider value={value}>{children}</Shared.Provider>;
}

/** `agent`'s trace: the provider's above, if it's for this agent, or a connection of its own. */
export function useAgentTrace(agent: string | null): Trace {
  const shared = useContext(Shared);
  const mine = !!agent && shared?.agent === agent;
  const own = useTrace(mine ? null : agent);
  return mine ? shared.trace : own;
}
