// "Left lying around": the control plane's lifetimes view (docs/control-plane/dashboard/#abandoned).
// The control plane decides what each thing is; the page sorts by age, says when the idle TTL will
// destroy a sandbox, and shows the API call an operator would make, as text. It acts on nothing.
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type AgentLifetimeKind, type LifetimeAgent, type LifetimeSandbox, type LifetimesResponse, type SandboxLifetimeKind } from "./api";

/** Heavier than the rest (every registered sandbox and the agents they lead to): read less often. */
export const LIFETIMES_REFRESH_MS = 60_000;

type Kind = "good" | "warn" | "bad" | "muted" | "accent";

const SANDBOX_KIND: Record<SandboxLifetimeKind, Kind> = {
  dormant: "muted", held: "bad", unknown: "warn", in_use: "good", destroyed: "warn", unreadable: "bad",
};
const AGENT_KIND: Record<AgentLifetimeKind, Kind> = {
  quiet: "warn", ending: "bad", gone: "bad", unreadable: "bad", active: "good", recent: "good", ended: "muted",
};
const SANDBOX_WHY: Record<SandboxLifetimeKind, string> = {
  dormant: "no agent attached and no VM up: its idle TTL runs",
  held: "attached only to agents nobody uses: never dormant, so no TTL takes it",
  unknown: "an attached agent could not be read",
  in_use: "in use",
  destroyed: "SandboxDO says destroyed; the registry still lists it",
  unreadable: "SandboxDO did not answer",
};

const short = (id: string | null | undefined) => (id ? `${id.slice(0, 4)}…${id.slice(-6)}` : "");

/** `3d 4h`, `5h 2m`, `40m`, `12s`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** When the idle TTL takes it, as the page says it. */
export function destroyIn(s: Pick<LifetimeSandbox, "kind" | "destroy_at_ms">, now: number): string {
  if (s.kind !== "dormant") return "never (not dormant)";
  if (s.destroy_at_ms === null) return "clock not started";
  return s.destroy_at_ms <= now ? "due now" : `in ${span(s.destroy_at_ms - now)}`;
}

/** Since when nobody has used it: its dormancy, else its agents' latest turn, else its registration. */
export function idleSince(s: LifetimeSandbox, agents: ReadonlyMap<string, LifetimeAgent>): number {
  if (s.dormant_since_ms !== null) return s.dormant_since_ms;
  const turns = s.attached.map((a) => agents.get(a)?.last_turn_ms ?? null).filter((t): t is number => t !== null);
  return turns.length ? Math.max(...turns) : s.registered_ms;
}

/** The API call an operator would make about it (text only: the page acts on nothing). */
export function operatorCall(s: LifetimeSandbox): string {
  if (s.kind === "dormant") return `PUT /v1/sandboxes/${s.sandbox}/lifetime (keep) · DELETE /v1/sandboxes/${s.sandbox} (now)`;
  if (s.kind === "held") return `end its agents: POST /v1/agents/<id>/stop {"end": true}`;
  return `GET /v1/sandboxes/${s.sandbox}`;
}

export const agentCall = (a: LifetimeAgent) =>
  a.kind === "quiet" ? `POST /v1/agents/${a.agent}/stop {"end": true${a.sandbox ? `, "destroy_sandbox": true` : ""}}` : `GET /v1/agents/${a.agent}`;

/** Oldest first; an agent that never had a turn first of all. */
export const byAge = <T,>(rows: readonly T[], at: (r: T) => number | null) =>
  [...rows].sort((a, b) => (at(a) ?? -Infinity) - (at(b) ?? -Infinity));

const total = (counts: Record<string, number> | undefined) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);

function Chip({ kind, children, title }: { kind: Kind; children: React.ReactNode; title?: string }) {
  return <span className={`chip ${kind}`} title={title}>{children}</span>;
}

export function Abandoned({ cell, now }: { cell: string; now: number }) {
  const [view, setView] = useState<LifetimesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cell) return;
    let cancelled = false;
    setView(null);
    const load = () => api.lifetimes(cell).then((v) => {
      if (cancelled) return;
      setView(v);
      setError(null);
    }, (e: unknown) => {
      if (cancelled) return;
      // A control plane from before the route answers 404 (the two deploy separately).
      setError(e instanceof ApiError && e.status === 404 ? "this control plane does not serve GET /v1/admin/lifetimes yet"
        : e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e));
    });
    void load();
    const timer = setInterval(() => void load(), LIFETIMES_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cell]);

  return <AbandonedView view={view} error={error} now={now} />;
}

/** The section for a view read (null: not yet) or the error reading it. */
export function AbandonedView({ view, error, now }: { view: LifetimesResponse | null; error: string | null; now: number }) {
  const agents = useMemo(() => new Map((view?.agents ?? []).map((a) => [a.agent, a])), [view]);
  const sandboxes = useMemo(() => (view ? byAge(view.sandboxes, (s) => idleSince(s, agents)) : []), [view, agents]);
  const agentRows = useMemo(() => byAge(view?.agents ?? [], (a) => a.last_turn_ms), [view]);
  const c = view?.counts;

  return (
    <section>
      <h2>Left lying around</h2>
      {error && <p className="error">Could not read the lifetimes view: {error}</p>}
      {!view ? (!error && <p className="muted">loading</p>) : <>
        <p className="muted">
          Agents with no turn for {span(view.quiet_ms)} count as quiet; the cell's idle TTL is {span(view.cell_idle_ttl_ms)}.
          {" "}Read {total(c?.sandboxes)} sandboxes ({c?.sandboxes.in_use ?? 0} in use, not listed) and {total(c?.agents)} agents
          {" "}({c?.agents.active ?? 0} active and {c?.agents.recent ?? 0} recently used, {c?.agents.ended ?? 0} ended awaiting their 30-day prune: not listed).
          {" "}Footprint in S3 is shown as generation counts: the control plane has no sizes.
        </p>
        <h3 className="sub">Sandboxes</h3>
        {sandboxes.length === 0 ? <p className="muted">Nothing: every sandbox is in use.</p> : (
          <div className="tbl"><table>
            <thead><tr>
              <th>sandbox</th><th>kind</th><th>state</th><th>unused for</th><th>idle TTL</th><th>destroyed</th><th>generations</th><th>attached</th><th>made for</th><th>operator</th>
            </tr></thead>
            <tbody>
              {sandboxes.map((s) => (
                <tr key={s.sandbox}>
                  <td className="mono" title={s.sandbox}>{short(s.sandbox)}</td>
                  <td><Chip kind={SANDBOX_KIND[s.kind]} title={s.error ?? SANDBOX_WHY[s.kind]}>{s.kind}</Chip></td>
                  <td className="mono">{s.state ?? "—"}</td>
                  <td title={new Date(idleSince(s, agents)).toISOString()}>{span(now - idleSince(s, agents))}</td>
                  <td>{s.idle_ttl_ms === null ? "—" : <>{span(s.idle_ttl_ms)}{s.own_ttl && <> <Chip kind="accent">own</Chip></>}</>}</td>
                  <td title={s.destroy_at_ms ? new Date(s.destroy_at_ms).toISOString() : ""}>{destroyIn(s, now)}</td>
                  <td>{s.generations === null ? "—" : `${s.generations}${s.memory_generations ? ` (${s.memory_generations} with memory)` : ""}`}</td>
                  <td className="mono">{s.attached.length ? s.attached.map((a) => <span key={a} title={a}>{short(a)} </span>) : <span className="muted">—</span>}</td>
                  <td className="mono" title={s.owner ?? ""}>{s.owner ? short(s.owner) : <span className="muted">operator</span>}</td>
                  <td className="mono small muted">{operatorCall(s)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <h3 className="sub">Agents</h3>
        {agentRows.length === 0 ? <p className="muted">None quiet, stuck ending or gone among the agents these sandboxes lead to.</p> : (
          <div className="tbl"><table>
            <thead><tr>
              <th>agent</th><th>kind</th><th>template</th><th>last turn</th><th>sandbox</th><th>live children</th><th>subscriptions</th><th>found via</th><th>operator</th>
            </tr></thead>
            <tbody>
              {agentRows.map((a) => (
                <tr key={a.agent}>
                  <td className="mono" title={a.agent}>{short(a.agent)}</td>
                  <td>
                    <Chip kind={AGENT_KIND[a.kind]} title={a.error ?? (a.ended_reason ? `ended (${a.ended_reason})` : "")}>{a.kind}</Chip>
                    {a.stopped_by_operator && <> <Chip kind="muted">stopped</Chip></>}
                  </td>
                  <td className="mono">{a.template ?? "—"}</td>
                  <td>{a.last_turn_ms === null ? <span className="muted">never</span> : `${span(now - a.last_turn_ms)} ago`}</td>
                  <td className="mono" title={a.sandbox ?? ""}>{a.sandbox ? short(a.sandbox) : <span className="muted">—</span>}</td>
                  <td>{a.live_children.length || <span className="muted">0</span>}</td>
                  <td>{a.subscriptions || <span className="muted">0</span>}</td>
                  <td className="muted">{a.found_via}</td>
                  <td className="mono small muted">{agentCall(a)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {(view.truncated || view.agents_omitted > 0) && (
          <p className="muted">
            {view.truncated && <>More sandboxes than the {view.pages} pages read. </>}
            {view.agents_omitted > 0 && <>{view.agents_omitted} agents found but not read (over the per-page cap).</>}
          </p>
        )}
        <p className="muted small">
          Agents are found through sandboxes (attached, or made for) and then their owners and children: a quiet agent with no
          sandbox, owner or child among them is not seen.
        </p>
      </>}
    </section>
  );
}
