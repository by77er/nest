import { useEffect, useMemo, useState } from "react";
import { Abandoned } from "./Abandoned";
import { type AgentsResponse, api, ApiError, type Fleet, type Host, type Images, type SandboxState } from "./api";

const REFRESH_MS = 10_000;

/** `hst_01m5…bgn6gq` reads better than the whole id; the title holds the full one. */
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 4)}…${id.slice(-6)}` : "");

function age(ms: number | null | undefined, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

type Kind = "good" | "warn" | "bad" | "muted" | "accent";

function Chip({ kind, children, title }: { kind: Kind; children: React.ReactNode; title?: string }) {
  return <span className={`chip ${kind}`} title={title}>{children}</span>;
}

/** Every sandbox state has a kind, so a new state fails the typecheck until it has one. */
const STATE_KIND: Record<SandboxState, "good" | "warn" | "bad" | "muted"> = {
  running: "good",
  creating: "warn", restoring: "warn", suspending: "warn", archiving: "warn",
  suspended: "muted", archived: "muted", destroyed: "muted",
  failed: "bad", fenced: "bad",
};

/** A lease's state; null before the host's first report. */
function stateChip(state: SandboxState | null) {
  if (!state) return <Chip kind="muted">starting</Chip>;
  return <Chip kind={STATE_KIND[state]}>{state}</Chip>;
}

// An agent's fields come from `GET /v1/agents/:agent`, outside the typed view, as strings: a value
// not listed here is shown muted.
/** protocol/model.ts `AgentState`: an agent's `state`, and its `activity` (the runner's last report). */
const AGENT_STATE_KIND: Record<string, Kind> = {
  ready: "good", working: "good",
  starting: "warn", waiting_permission: "warn", waiting_input: "warn", compacting: "warn", quota_parked: "warn",
  idle: "muted", detached: "muted",
  errored: "bad", stalled: "bad", needs_attention: "bad",
};
/** protocol/model.ts `AgentLifecycle`: AgentDO's own part of `state`. */
const LIFECYCLE_KIND: Record<string, Kind> = { ready: "good", starting: "warn", detached: "muted", errored: "bad" };
/** lib/brain.ts `Brain.phase`: `condemned` once none of the brain's sessions is current. */
const PHASE_KIND: Record<string, Kind> = { live: "good", starting: "warn", condemned: "bad" };

function valueChip(kinds: Record<string, Kind>, value: string | null) {
  if (!value) return <span className="muted">—</span>;
  return <Chip kind={kinds[value] ?? "muted"}>{value}</Chip>;
}

const describe = (e: unknown) => (e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** A host is live when it is active and connected; everything else is history. */
const isLive = (h: Host) => h.status === "active" && h.connected;

function HostCard({ h, now }: { h: Host; now: number }) {
  const cap = h.capacity;
  return (
    <article className="host">
      <header>
        <h3 title={h.host}><span className="mono">{short(h.host)}</span></h3>
        <div className="chips">
          {h.tunnel_state === "connected" ? <Chip kind="good">reachable</Chip>
            : h.tunnel_hostname ? <Chip kind="warn">tunnel {h.tunnel_state}</Chip> : <Chip kind="muted">no tunnel</Chip>}
        </div>
      </header>
      <p className="muted small">
        up {age(h.enrolled_ms, now)}
        {cap && <> · {(cap.memory_mib_free / 1024).toFixed(1)} GiB free · {cap.vcpus_free} vCPU free</>}
      </p>
      <div className="residents">
        <div>
          <h4>Sandboxes</h4>
          {h.sandboxes.length === 0 ? <p className="muted">none</p> : (
            <ul>
              {h.sandboxes.map((s) => (
                <li key={s.sandbox}><span className="mono" title={s.sandbox}>{short(s.sandbox)}</span>{stateChip(s.state)}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>Brains</h4>
          {h.agents.length === 0 ? <p className="muted">none</p> : (
            <ul>
              {h.agents.map((a) => <li key={a}><span className="mono" title={a}>{short(a)}</span></li>)}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}

export function App() {
  const [cells, setCells] = useState<string[]>([]);
  const [cell, setCell] = useState<string>("");
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [images, setImages] = useState<Images | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentsResponse | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api.cells().then((c) => {
      setCells(c.cells);
      const fromHash = location.hash.replace(/^#/, "");
      setCell(c.cells.includes(fromHash) ? fromHash : (c.cells[0] ?? ""));
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!cell) return;
    let cancelled = false;
    const load = async () => {
      try {
        // The agents' detail is extra: when it cannot be read, the rest of the page still is (its rows say unknown).
        const [f, i, a] = await Promise.all([
          api.fleet(cell), api.images(cell), api.agents(cell).then((r) => ({ r }), (e: unknown) => ({ e: describe(e) })),
        ]);
        if (cancelled) return;
        setFleet(f);
        setImages(i);
        setAgentInfo("r" in a ? a.r : null);
        setAgentsError("e" in a ? a.e : null);
        setError(null);
        setUpdated(Date.now());
      } catch (e: unknown) {
        if (cancelled) return;
        setError(describe(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [cell]);

  const hosts = useMemo(() => (fleet?.hosts ?? []).filter(isLive), [fleet]);
  // An agent is live when a live host indexes its brain (one being replaced may be on two); its
  // detail is AgentDO's, read by the Worker for the same list.
  const agents = useMemo(() => {
    const on = new Map<string, string>();
    for (const h of hosts) for (const a of h.agents) if (!on.has(a)) on.set(a, h.host);
    const rows = new Map((agentInfo?.agents ?? []).map((r) => [r.agent, r]));
    return [...on].sort(([a], [b]) => a.localeCompare(b)).map(([agent, host]) => ({ agent, host, row: rows.get(agent) }));
  }, [hosts, agentInfo]);
  // Live sandboxes are the ones on a host; one parked in S3 is counted, not listed.
  const sandboxes = useMemo(() => (fleet?.sandboxes ?? []).filter((s) => s.host), [fleet]);
  // Without a host, the sandbox's own state says where it is: parked in S3, waiting for a host (a
  // new one, or one resuming), or anything else (failed, fenced, or unreadable), counted apart.
  const unplaced = useMemo(() => (fleet?.sandboxes ?? []).filter((s) => !s.host), [fleet]);
  const parked = unplaced.filter((s) => s.sandbox_state === "suspended" || s.sandbox_state === "archived").length;
  const waiting = unplaced.filter((s) => s.sandbox_state === "creating" || s.sandbox_state === "restoring").length;
  const other = unplaced.length - parked - waiting;

  return (
    <main>
      <header className="top">
        <div>
          <h1>nest</h1>
          <p className="muted">
            cell{" "}
            <select id="cell" value={cell} onChange={(e) => { setCell(e.target.value); location.hash = e.target.value; }}>
              {cells.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {updated && <> · live, updated {age(updated, now)} ago</>}
          </p>
        </div>
        <div className="totals">
          <div><b>{agents.length}</b><span>agents</span></div>
          <div><b>{sandboxes.length}</b><span>sandboxes</span></div>
          <div><b>{hosts.length}</b><span>hosts</span></div>
        </div>
      </header>

      {error && <p className="error">Could not read the control plane: {error}</p>}

      <section>
        <h2>Agents</h2>
        {agentsError && <p className="error">Could not read the agents' detail: {agentsError}</p>}
        {agents.length === 0 ? <p className="muted">No brain is running.</p> : (
          <div className="tbl"><table>
            <thead><tr>
              <th>agent</th><th>template</th><th>state</th><th>lifecycle</th><th>activity</th><th>turn</th>
              <th>brain on host</th><th>phase</th><th>phase since</th><th>sandbox</th>
            </tr></thead>
            <tbody>
              {agents.map(({ agent, host, row }) => {
                const i = row?.info;
                const brainHost = i?.brain?.host ?? host;
                return (
                  <tr key={agent}>
                    <td className="mono" title={agent}>{short(agent)}</td>
                    {!row ? <td colSpan={5} className="muted">{agentsError ? "unknown" : "loading"}</td>
                      : !i ? <td colSpan={5}><Chip kind="bad" title={row.error ?? ""}>could not read: {row.error}</Chip></td> : <>
                        <td className="mono">{i.template ?? "—"}</td>
                        <td>{valueChip(AGENT_STATE_KIND, i.state)}</td>
                        <td>{valueChip(LIFECYCLE_KIND, i.lifecycle)}</td>
                        <td>{valueChip(AGENT_STATE_KIND, i.activity)}</td>
                        <td className="mono" title={i.current_turn ?? ""}>{i.current_turn ? short(i.current_turn) : <span className="muted">—</span>}</td>
                      </>}
                    <td className="mono" title={brainHost}>{short(brainHost)}</td>
                    <td>{valueChip(PHASE_KIND, i?.brain?.phase ?? null)}</td>
                    <td title={i?.brain ? new Date(i.brain.since_ms).toISOString() : ""}>{i?.brain ? `${age(i.brain.since_ms, now)} ago` : ""}</td>
                    <td className="mono" title={i?.sandbox ?? ""}>{i?.sandbox ? short(i.sandbox) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        {!!agentInfo?.omitted && <p className="muted">{agentInfo.omitted} more agents not read (the Worker reads at most {agentInfo.agents.length}).</p>}
      </section>

      <section>
        <h2>Sandboxes</h2>
        {sandboxes.length === 0 ? <p className="muted">None on a host.</p> : (
          <div className="tbl"><table>
            <thead><tr><th>sandbox</th><th>template</th><th>on host</th><th>state</th><th>age</th></tr></thead>
            <tbody>
              {sandboxes.map((s) => (
                <tr key={s.sandbox}>
                  <td className="mono" title={s.sandbox}>{short(s.sandbox)}</td>
                  <td className="mono">{s.image ?? "—"}</td>
                  <td className="mono" title={s.host ?? ""}>{short(s.host)}</td>
                  <td>{stateChip(s.lease_state)}</td>
                  <td>{age(s.registered_ms, now)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {(parked > 0 || waiting > 0 || other > 0) && (
          <p className="muted">
            {parked > 0 && <>{parked} suspended or archived in S3, not on a host. </>}
            {waiting > 0 && <>{waiting} waiting for a host. </>}
            {other > 0 && <>{other} off any host in another state (failed, fenced or unreadable).</>}
          </p>
        )}
      </section>

      <Abandoned cell={cell} now={now} />

      <section>
        <h2>Hosts</h2>
        {hosts.length === 0 ? <p className="muted">None: the cell is at zero. A sandbox request starts one.</p> : (
          <div className="grid">{hosts.map((h) => <HostCard key={h.host} h={h} now={now} />)}</div>
        )}
      </section>

      <section>
        <h2>Templates</h2>
        {!images ? <p className="muted">loading</p> : (
          <div className="tbl"><table>
            <thead><tr><th>template</th><th>live sandboxes</th></tr></thead>
            <tbody>
              {images.templates.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name} {t.default && <Chip kind="accent">default</Chip>}</td>
                  <td>{sandboxes.filter((s) => s.image === t.name).length}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <footer className="muted">Read-only; refreshes every {REFRESH_MS / 1000} s.</footer>
    </main>
  );
}
