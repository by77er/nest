import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Fleet, type Host, type Images } from "./api";

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

const whenIso = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Chip({ kind, children }: { kind: "good" | "warn" | "bad" | "muted" | "accent"; children: React.ReactNode }) {
  return <span className={`chip ${kind}`}>{children}</span>;
}

function hostStatus(h: Host): { kind: "good" | "warn" | "bad" | "muted"; label: string } {
  if (h.status === "dead") return { kind: "muted", label: "dead" };
  if (h.status === "draining") return { kind: "warn", label: "draining" };
  if (h.status === "stonith_pending") return { kind: "bad", label: "stonith pending" };
  if (!h.connected) return { kind: "warn", label: "active · disconnected" };
  return { kind: "good", label: "active" };
}

function tunnelChip(h: Host) {
  if (!h.tunnel_hostname) return <Chip kind="muted">no tunnel</Chip>;
  if (h.tunnel_state === "connected") return <Chip kind="good">tunnel connected</Chip>;
  if (h.tunnel_state === "connecting") return <Chip kind="warn">tunnel connecting</Chip>;
  return <Chip kind="bad">tunnel {h.tunnel_state ?? "none"}</Chip>;
}

function stateChip(state: string | null) {
  if (!state) return <Chip kind="muted">placing</Chip>;
  if (state === "running") return <Chip kind="good">running</Chip>;
  if (state === "suspended" || state === "evacuating") return <Chip kind="warn">{state}</Chip>;
  if (state === "failed" || state === "fenced") return <Chip kind="bad">{state}</Chip>;
  return <Chip kind="muted">{state}</Chip>;
}

function HostCard({ h, now }: { h: Host; now: number }) {
  const st = hostStatus(h);
  const cap = h.capacity;
  return (
    <article className={`host ${h.status === "dead" ? "dead" : ""}`}>
      <header>
        <h3 title={h.host}>
          <span className="mono">{short(h.host)}</span>
        </h3>
        <div className="chips">
          <Chip kind={st.kind}>{st.label}</Chip>
          {h.status !== "dead" && tunnelChip(h)}
        </div>
      </header>
      <dl className="facts">
        <div><dt>instance</dt><dd className="mono">{h.instance_id ?? "—"}</dd></div>
        <div><dt>enrolled</dt><dd>{age(h.enrolled_ms, now)} ago</dd></div>
        <div><dt>last seen</dt><dd>{h.last_rx ? `${age(h.last_rx, now)} ago` : "never"}</dd></div>
        {h.idle_since && h.status !== "dead" && <div><dt>idle for</dt><dd>{age(h.idle_since, now)}</dd></div>}
        {h.tunnel_hostname && <div><dt>hostname</dt><dd className="mono small">{h.tunnel_hostname}</dd></div>}
      </dl>
      {cap && h.status !== "dead" && (
        <div className="capacity">
          <span title="free vCPUs as the host last reported">{cap.vcpus_free} vCPU free</span>
          <span title="free 2 MiB hugepages, what sandboxes are backed by">{(cap.hugepages_mib_free / 1024).toFixed(1)} GiB hugepages free</span>
          <span>{cap.sandboxes} sandbox{cap.sandboxes === 1 ? "" : "es"} · {cap.agents} brain{cap.agents === 1 ? "" : "s"}</span>
        </div>
      )}
      <div className="residents">
        <div>
          <h4>Sandboxes</h4>
          {h.sandboxes.length === 0 ? <p className="muted">none</p> : (
            <ul>
              {h.sandboxes.map((s) => (
                <li key={s.sandbox}>
                  <span className="mono" title={s.sandbox}>{short(s.sandbox)}</span>
                  <span className="muted">epoch {s.epoch}</span>
                  {stateChip(s.state)}
                  {s.memory_mib && <span className="muted">{s.vcpus} vCPU · {s.memory_mib} MiB</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>Brains</h4>
          {h.agents.length === 0 ? <p className="muted">none</p> : (
            <ul>
              {h.agents.map((a) => (
                <li key={a}><span className="mono" title={a}>{short(a)}</span></li>
              ))}
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
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showDead, setShowDead] = useState(false);

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
        const [f, i] = await Promise.all([api.fleet(cell), api.images(cell)]);
        if (cancelled) return;
        setFleet(f);
        setImages(i);
        setError(null);
        setUpdated(Date.now());
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof ApiError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
        setError(msg);
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

  const live = useMemo(() => (fleet?.hosts ?? []).filter((h) => h.status !== "dead"), [fleet]);
  const dead = useMemo(() => (fleet?.hosts ?? []).filter((h) => h.status === "dead").reverse(), [fleet]);
  const inFlight = useMemo(() => (fleet?.launches ?? []).filter((l) => !l.ended_ms && !l.host), [fleet]);
  const recentLaunches = useMemo(() => (fleet?.launches ?? []).slice(-8).reverse(), [fleet]);
  // Without a lease a sandbox is either waiting for a host or parked in S3; its own state says which.
  const unplaced = useMemo(() => (fleet?.sandboxes ?? []).filter((s) => !s.host && s.state !== "suspended" && s.state !== "archived"), [fleet]);
  const brains = useMemo(() => live.flatMap((h) => h.agents.map((a) => ({ agent: a, host: h.host }))), [live]);
  const sandboxCount = fleet?.sandboxes.length ?? 0;

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
            {updated && <> · updated {age(updated, now)} ago</>}
          </p>
        </div>
        <div className="totals">
          <div><b>{live.length}</b><span>hosts</span></div>
          <div><b>{sandboxCount}</b><span>sandboxes</span></div>
          <div><b>{brains.length}</b><span>brains</span></div>
          <div><b>{inFlight.length}</b><span>launching</span></div>
        </div>
      </header>

      {error && <p className="error">Could not read the control plane: {error}</p>}

      <section>
        <h2>Hosts</h2>
        {live.length === 0 && inFlight.length === 0 && <p className="muted">The cell is at zero. A sandbox request launches a host.</p>}
        <div className="grid">
          {live.map((h) => <HostCard key={h.host} h={h} now={now} />)}
          {inFlight.map((l) => (
            <article className="host launching" key={l.instance_id}>
              <header><h3 className="mono">{l.instance_id}</h3><div className="chips"><Chip kind="warn">launching</Chip></div></header>
              <p className="muted">started {age(l.launched_ms, now)} ago; enrolls on boot</p>
            </article>
          ))}
        </div>
        {dead.length > 0 && (
          <p className="muted">
            <button type="button" className="link" onClick={() => setShowDead((v) => !v)}>
              {showDead ? "hide" : "show"} {dead.length} retired host{dead.length === 1 ? "" : "s"}
            </button>
          </p>
        )}
        {showDead && (
          <div className="tbl"><table>
            <thead><tr><th>host</th><th>instance</th><th>enrolled</th><th>last seen</th></tr></thead>
            <tbody>
              {dead.map((h) => (
                <tr key={h.host}>
                  <td className="mono" title={h.host}>{short(h.host)}</td>
                  <td className="mono">{h.instance_id ?? "—"}</td>
                  <td>{age(h.enrolled_ms, now)} ago</td>
                  <td>{h.last_rx ? `${age(h.last_rx, now)} ago` : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section>
        <h2>Sandboxes</h2>
        {sandboxCount === 0 ? <p className="muted">none live</p> : (
          <div className="tbl"><table>
            <thead><tr><th>sandbox</th><th>template</th><th>host</th><th>epoch</th><th>state</th><th>age</th></tr></thead>
            <tbody>
              {(fleet?.sandboxes ?? []).map((s) => (
                <tr key={s.sandbox} className={!s.host && s.state !== "suspended" && s.state !== "archived" ? "unplaced" : ""}>
                  <td className="mono" title={s.sandbox}>{short(s.sandbox)}</td>
                  <td className="mono">{s.image ?? "—"}</td>
                  <td className="mono" title={s.host ?? ""}>{s.host ? short(s.host) : s.state === "suspended" ? <span className="muted">in S3</span> : <Chip kind="warn">unplaced</Chip>}</td>
                  <td>{s.epoch ?? "—"}</td>
                  <td>{stateChip(s.state)}</td>
                  <td>{age(s.registered_ms, now)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {unplaced.length > 0 && <p className="muted">{unplaced.length} waiting for placement: the autoscaler launches a host when none fits.</p>}
      </section>

      <section>
        <h2>Brains</h2>
        {brains.length === 0 ? <p className="muted">none running</p> : (
          <div className="tbl"><table>
            <thead><tr><th>agent</th><th>on host</th></tr></thead>
            <tbody>
              {brains.map((b) => (
                <tr key={b.agent}><td className="mono" title={b.agent}>{short(b.agent)}</td><td className="mono" title={b.host}>{short(b.host)}</td></tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section>
        <h2>Launches</h2>
        {recentLaunches.length === 0 ? <p className="muted">none yet</p> : (
          <div className="tbl"><table>
            <thead><tr><th>instance</th><th>launched</th><th>became host</th><th>outcome</th></tr></thead>
            <tbody>
              {recentLaunches.map((l) => (
                <tr key={l.instance_id}>
                  <td className="mono">{l.instance_id}</td>
                  <td>{age(l.launched_ms, now)} ago</td>
                  <td className="mono" title={l.host ?? ""}>{l.host ? short(l.host) : "—"}</td>
                  <td>{l.ended_ms ? <Chip kind={l.reason === "enroll_timeout" ? "bad" : "muted"}>{l.reason ?? "ended"}</Chip> : l.host ? <Chip kind="good">serving</Chip> : <Chip kind="warn">booting</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section>
        <h2>Sandbox templates</h2>
        {!images?.templates ? <p className="muted">loading</p> : (
          <div className="tbl"><table>
            <thead><tr><th>template</th><th>comes from</th><th>live sandboxes</th></tr></thead>
            <tbody>
              {images.templates.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name} {t.default && <Chip kind="accent">default</Chip>}</td>
                  <td>{t.source}</td>
                  <td>{t.in_use}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <p className="muted">A sandbox names its template at create (<span className="mono">image</span>); every host installs the release's templates at boot.</p>
      </section>

      <section>
        <h2>Host images</h2>
        {!images ? <p className="muted">loading</p> : images.images.length === 0 ? <p className="muted">no AMIs tagged for nest</p> : (
          <div className="tbl"><table>
            <thead><tr><th>AMI</th><th>name</th><th>built</th><th>size</th><th>state</th></tr></thead>
            <tbody>
              {images.images.map((i) => (
                <tr key={i.image_id} className={i.image_id === images.current ? "current" : ""}>
                  <td className="mono">{i.image_id} {i.image_id === images.current && <Chip kind="accent">launch template</Chip>}</td>
                  <td>{i.name}</td>
                  <td>{whenIso(i.created)}</td>
                  <td>{i.size_gib ? `${i.size_gib} GiB` : "—"}</td>
                  <td>{i.state}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {images?.current && !images.images.some((i) => i.image_id === images.current) && (
          <p className="error">The launch template resolves to {images.current}, which is not among the account's nest AMIs.</p>
        )}
        {images?.current_since_ms && <p className="muted">The launch template's AMI was last changed {age(images.current_since_ms, now)} ago. Older images are pruned by the cell's lifecycle policy (two newest kept).</p>}
      </section>

      <footer className="muted">Read-only. Reads <span className="mono">/v1/admin/fleet</span> and <span className="mono">/v1/admin/images</span> every {REFRESH_MS / 1000} s.</footer>
    </main>
  );
}
