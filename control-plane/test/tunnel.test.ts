// Per-host tunnels (docs/sandbox/gateway/, Addressing): a sandbox host's enrollment creates one
// Cloudflare Tunnel, its ingress and one proxied record, and answers with the tunnel token and the
// gateway URL; resolve then targets that hostname and carries the Access service token; a dead host's
// assets are deleted and a daily sweep removes leaks, touching only what this cell created. The
// Cloudflare API is a fake behind the `CloudflareApi` interface; the HTTP client has its own test.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { CloudflareError, type CloudflareApi } from "../src/lib/cloudflare";
import { CapacityError, type Ec2, type InstanceState, type LaunchSpec, type ImageInfo } from "../src/lib/ec2";
import type { AwsCellConfig } from "../src/lib/cells";
import { NestError } from "../src/lib/util";
import { ErrorCodes } from "../src/protocol/model";
import type { HandsTarget } from "../src/protocol/gateway";
import { ADMIN, adminJson, BASE, connectHost, csrPem, enrollHost, hostHello, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

const DOMAIN = "nest.example.dev";
const ZONE_ID = "zone-example-dev";
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const label = (host: string) => host.slice("hst_".length);
const hostnameOf = (host: string) => `${label(host)}-gw-nest.example.dev`;
/** Host-shaped ids (26 Crockford base32 characters) that no host in any test has. */
const ORPHAN = "01abcdefgh" + "0".repeat(16);
const STALE = "01jkmnpqrs" + "1".repeat(16);
const YOUNG = "01tvwxyz00" + "2".repeat(16);
const HOUR = 3_600_000;

/** An in-memory Cloudflare account and zone that records every call. */
class FakeCloudflare implements CloudflareApi {
  calls: string[] = [];
  tunnels = new Map<string, { name: string; ingress: string | null }>();
  records = new Map<string, { zone: string; name: string; content: string }>();
  zoneLookups = 0;
  failRecord = false;
  /** `createRecord` waits on this before answering (an enrollment held mid-flight). */
  gate: Promise<void> | null = null;
  /** Tunnel ids whose deletion fails (Cloudflare refuses while connections are active). */
  undeletable = new Set<string>();
  /** Record ids whose deletion fails. */
  undeletableRecords = new Set<string>();
  /** `createTunnel` fails with this HTTP status (401/403: the token is revoked). */
  refuseTunnelWith: number | null = null;
  private n = 0;
  /** What the HTTP client throws for a refused call (test/cloudflare.test.ts proves that shape). */
  private refuse(what: string, status = 502): never {
    throw new CloudflareError(`cloudflare: ${what}`, status, status === 429 || status >= 500);
  }

  seedTunnel(name: string): string {
    const id = `tun-seed-${++this.n}`;
    this.tunnels.set(id, { name, ingress: null });
    return id;
  }
  seedRecord(name: string): string {
    const id = `rec-seed-${++this.n}`;
    this.records.set(id, { zone: ZONE_ID, name, content: "x.cfargotunnel.com" });
    return id;
  }
  tunnelNamed(name: string) {
    return [...this.tunnels].find(([, t]) => t.name === name);
  }
  recordNamed(name: string) {
    return [...this.records].find(([, r]) => r.name === name);
  }

  async zoneId(zone: string): Promise<string> {
    this.zoneLookups++;
    this.calls.push(`zoneId ${zone}`);
    if (zone !== "example.dev") this.refuse(`no zone ${zone}`);
    return ZONE_ID;
  }
  async createTunnel(name: string): Promise<{ id: string; token: string }> {
    this.calls.push(`createTunnel ${name}`);
    if (this.refuseTunnelWith !== null) this.refuse(`HTTP ${this.refuseTunnelWith} (10000: Authentication error)`, this.refuseTunnelWith);
    const id = `tun-${++this.n}`;
    this.tunnels.set(id, { name, ingress: null });
    return { id, token: `eyJ-tunnel-token-${id}` };
  }
  async configureIngress(tunnelId: string, hostname: string): Promise<void> {
    this.calls.push(`configureIngress ${tunnelId} ${hostname}`);
    const t = this.tunnels.get(tunnelId);
    if (!t) this.refuse(`no tunnel ${tunnelId}`);
    t.ingress = hostname;
  }
  async deleteTunnel(tunnelId: string): Promise<void> {
    this.calls.push(`deleteTunnel ${tunnelId}`);
    if (this.undeletable.has(tunnelId)) this.refuse("tunnel has active connections");
    this.tunnels.delete(tunnelId);
  }
  async listTunnels(prefix: string): Promise<{ id: string; name: string }[]> {
    this.calls.push(`listTunnels ${prefix}`);
    return [...this.tunnels].filter(([, t]) => t.name.startsWith(prefix)).map(([id, t]) => ({ id, name: t.name }));
  }
  async createRecord(zoneId: string, hostname: string, tunnelId: string, comment: string): Promise<{ id: string }> {
    this.calls.push(`createRecord ${zoneId} ${hostname} ${tunnelId} ${comment}`);
    if (this.gate) await this.gate;
    if (this.failRecord) this.refuse("record refused");
    const id = `rec-${++this.n}`;
    this.records.set(id, { zone: zoneId, name: hostname, content: `${tunnelId}.cfargotunnel.com` });
    return { id };
  }
  async listRecords(zoneId: string, suffix: string): Promise<{ id: string; name: string }[]> {
    this.calls.push(`listRecords ${zoneId} ${suffix}`);
    return [...this.records].filter(([, r]) => r.zone === zoneId && r.name.endsWith(suffix)).map(([id, r]) => ({ id, name: r.name }));
  }
  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    this.calls.push(`deleteRecord ${zoneId} ${recordId}`);
    if (this.undeletableRecords.has(recordId)) this.refuse("record delete refused");
    this.records.delete(recordId);
  }
}

async function withCloudflare(cell: string, api: FakeCloudflare = new FakeCloudflare()): Promise<FakeCloudflare> {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
    inst.cloudflareOverride = { api, domain: DOMAIN };
  });
  return api;
}

async function hostRow(cell: string, host: string): Promise<Record<string, unknown> | undefined> {
  return runInDurableObject(fleetStub(cell), (_i: FleetDO, st) =>
    st.storage.sql.exec("SELECT * FROM hosts WHERE host = ?", host).toArray()[0] as Record<string, unknown> | undefined);
}

async function recordIntent(cell: string, host: string, createdMs: number): Promise<void> {
  await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
    st.storage.sql.exec("INSERT OR REPLACE INTO tunnels_created (host, created_ms) VALUES (?, ?)", host, createdMs);
  });
}

/** The hosts this cell recorded creating a tunnel for, sorted. */
async function intents(cell: string): Promise<string[]> {
  return runInDurableObject(fleetStub(cell), (_i: FleetDO, st) =>
    st.storage.sql.exec<{ host: string }>("SELECT host FROM tunnels_created ORDER BY host").toArray().map((r) => r.host));
}

/** Deletions run off the request path (`waitUntil`); wait for the fake to see them. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function runAlarm(cell: string, key: string) {
  await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES (?, 0)", key);
  });
  await runDurableObjectAlarm(fleetStub(cell));
}

async function deadline(cell: string, key: string): Promise<number | undefined> {
  return runInDurableObject(fleetStub(cell), (_i: FleetDO, st) =>
    (st.storage.sql.exec("SELECT at FROM deadlines WHERE key = ?", key).toArray()[0] as { at: number } | undefined)?.at);
}

async function enrollRaw(cell: string, token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol_version: 1, role: "burst", cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: await csrPem() }),
  });
}

/** Enroll as a launched instance (what the Worker does after verifying its identity document). */
async function enrollLaunched(cell: string, instanceId: string) {
  return runInDurableObject(fleetStub(cell), async (inst: FleetDO) =>
    inst.enroll({ role: "burst", proof: { type: "aws_identity_document", document_b64: "", pkcs7_b64: "" }, proxy_ca_csr_pem: await csrPem() } as never,
      cell, { instanceId, accountId: "123456789012", region: "us-east-1" } as never));
}

const sweep = (cell: string) => adminJson<{ tunnels: number; records: number; retried: number; failed: number; unknown: number }>(
  `/v1/admin/tunnels/sweep?cell=${cell}`, { body: {} });

/** Enroll and connect a host whose hello carries `extra` (a `gateway_url`, a `tunnel` state). */
async function connectHostWith(cell: string, extra: Record<string, unknown>) {
  const enrolled = await enrollHost(cell, "burst");
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, extra));
  const ack = await ws.next("hello_ack");
  const keys = (await ws.next("binding_key")).keys as { kid: string; public_key: string }[];
  return { ...enrolled, ws, ack, keys };
}

const ACCESS = { client_id: "abc.access", client_secret: "shh-service-secret" };
const storeAccessToken = () => adminJson("/v1/admin/secrets/access:gateway", { method: "PUT", body: { value: JSON.stringify(ACCESS) } });

/** A sandbox with a worker attached and running on a connected host, ready for `resolve`. */
async function attached(cell: string, hello: Record<string, unknown> = {}) {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-tunnel" } });
  const host = Object.keys(hello).length ? await connectHostWith(cell, hello) : await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "tunnel" } }, 201);
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, start: false } }, 201);
  const [attach] = await nextCommands(host.ws, (c) => c.type === "agent_attach" && c.agent === worker.agent);
  const seq = sendEvents(host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "running", guest: { protocol_version: 1, capabilities: [] } }]);
  await host.ws.next("ack", (m) => m.up_to >= seq);
  await okResult(host.ws, attach.cmd);
  return { host, workstream, sandbox: sbx.sandbox as string, agent: worker.agent as string };
}

describe("enrollment creates the host's tunnel", () => {
  it("a sandbox host gets a tunnel, its ingress and a proxied record, and the response carries the token and URL", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const h = await enrollHost(cell, "burst");
    const hostname = hostnameOf(h.host);
    expect(h.gateway_url).toBe(`wss://${hostname}`);
    const tunnel = cf.tunnelNamed(`nest-${label(h.host)}`);
    expect(tunnel, "one tunnel named for the host").toBeDefined();
    const [tunnelId, t] = tunnel!;
    expect(h.tunnel_token).toBe(`eyJ-tunnel-token-${tunnelId}`);
    expect(t.ingress, "the ingress routes the hostname").toBe(hostname);
    const record = cf.recordNamed(hostname);
    expect(record, "one record for the hostname").toBeDefined();
    expect(record![1]).toEqual({ zone: ZONE_ID, name: hostname, content: `${tunnelId}.cfargotunnel.com` });
    // The tunnel is configured before the record points at it.
    const order = cf.calls.map((c) => c.split(" ")[0]);
    expect(order.indexOf("configureIngress")).toBeLessThan(order.indexOf("createRecord"));
    // The row records the ids and the hostname; the token is nowhere in the object's storage.
    const row = await hostRow(cell, h.host);
    expect(row).toMatchObject({ tunnel_id: tunnelId, tunnel_hostname: hostname, dns_record_id: record![0] });
    const everything = await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) =>
      JSON.stringify([
        ...st.storage.sql.exec("SELECT * FROM hosts").toArray(), ...st.storage.sql.exec("SELECT * FROM kv").toArray(),
        ...st.storage.sql.exec("SELECT * FROM tunnels_created").toArray(),
      ]));
    expect(everything).not.toContain(h.tunnel_token!);
    // The sweep is armed about a day out, and the operator's view shows the hostname.
    const sweepAt = await deadline(cell, "tunnel_sweep");
    expect(sweepAt).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(sweepAt).toBeLessThan(Date.now() + 25 * HOUR);
    const view = await adminJson<{ hosts: { host: string; tunnel_hostname: string | null }[] }>(`/v1/admin/fleet?cell=${cell}`);
    expect(view.hosts.find((x) => x.host === h.host)?.tunnel_hostname).toBe(hostname);
  });

  it("the zone is looked up once per cell; a brain host gets no tunnel", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    await enrollHost(cell, "burst");
    const before = cf.calls.length;
    const brain = await enrollHost(cell, "controller");
    expect(brain.tunnel_token).toBeUndefined();
    expect(brain.gateway_url).toBeUndefined();
    expect(cf.calls.length, "no Cloudflare call for a brain host").toBe(before);
    await enrollHost(cell, "burst");
    expect(cf.zoneLookups).toBe(1);
    expect(cf.tunnels.size).toBe(2);
  });

  it("without Cloudflare configuration there is no tunnel and the host's hello names the gateway", async () => {
    const cell = uniqueCell();
    const h = await enrollHost(cell, "burst");
    expect(h.tunnel_token).toBeUndefined();
    expect(h.gateway_url).toBeUndefined();
    expect(await hostRow(cell, h.host)).toMatchObject({ tunnel_id: null, tunnel_hostname: null, dns_record_id: null });
  });

  it("a failed record leaves no tunnel behind, fails the enrollment, and the same token enrolls on retry", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    cf.failRecord = true;
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } });
    const res = await enrollRaw(cell, token);
    expect(res.status).toBe(502);
    expect(cf.calls.some((c) => c.startsWith("createTunnel"))).toBe(true);
    expect(cf.tunnels.size, "the tunnel created for the failed enrollment is deleted").toBe(0);
    expect(cf.records.size).toBe(0);
    expect(await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM hosts").toArray()[0]!.n)).toBe(0);
    // The sweep was armed before the first call, so a leak here would be found.
    expect(await deadline(cell, "tunnel_sweep")).toBeGreaterThan(Date.now());
    // The proof was not consumed: the host retries with the same token.
    cf.failRecord = false;
    const retry = await enrollRaw(cell, token);
    expect(retry.status).toBe(200);
    expect(cf.tunnels.size).toBe(1);
  });

  it("a bad proof is refused before any Cloudflare call", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    expect((await enrollRaw(cell, "not-a-token")).status).toBe(401);
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "controller", cell } });
    expect((await enrollRaw(cell, token)).status).toBe(401);
    expect(cf.calls, "no tunnel for an unauthenticated caller").toEqual([]);
  });
});

describe("resolve through the tunnel", () => {
  it("targets the tunnel hostname once the host reports it connected, and carries the Access token", async () => {
    const cell = uniqueCell();
    await withCloudflare(cell);
    const s = await attached(cell, { tunnel: "connected" });
    // A tunnel target without the Access credential would be refused at the edge on every call:
    // refused here instead, for an operator, not retried by the runner.
    const refused = await sandboxStub(s.sandbox).resolve(s.agent).then(() => null, (e: unknown) => e as Error);
    expect(refused?.message, "no Access token stored yet").toMatch(/access:gateway is not stored/);
    expect(refused?.message).toMatch(/^nest:internal:500:0:/);
    await storeAccessToken();
    const t2 = await sandboxStub(s.sandbox).resolve(s.agent);
    expect(t2.url).toBe(`wss://${hostnameOf(s.host.host)}`);
    expect(t2.edge).toEqual(ACCESS);
    const viaApi = await adminJson<HandsTarget>(`/v1/sandboxes/${s.sandbox}/resolve`, { body: { client: s.agent } });
    expect(viaApi.url).toBe(t2.url);
    expect(viaApi.edge).toEqual(t2.edge);
  });

  it("the tunnel is advertised only while the host reports it connected; connecting and none wait, never the hello URL", async () => {
    const cell = uniqueCell();
    await withCloudflare(cell);
    await storeAccessToken();
    // An old nestd, or one without cloudflared: the hello says nothing about a tunnel. Its hello URL
    // is its own loopback, which no runner on another host can reach: not ready, never that URL.
    const s = await attached(cell);
    const down = await sandboxStub(s.sandbox).resolve(s.agent).then(() => null, (e: unknown) => e as NestError);
    expect(down?.code).toBe(ErrorCodes.SANDBOX_NOT_READY);
    expect(down?.retryable).toBe(true);
    expect(await fleetStub(cell).hostGatewayUrl(s.host.host)).toEqual({ kind: "down", tunnel: hostnameOf(s.host.host) });
    // cloudflared is up but has no ready connection: nothing answers at the hostname yet.
    let seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "tunnel_state", state: "connecting" }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect(await fleetStub(cell).hostGatewayUrl(s.host.host)).toEqual({ kind: "connecting" });
    const waiting = await sandboxStub(s.sandbox).resolve(s.agent).then(() => null, (e: unknown) => e as NestError);
    expect(waiting?.code).toBe(ErrorCodes.SANDBOX_NOT_READY);
    expect(waiting?.retryable).toBe(true);
    // Ready: the tunnel, with the edge credential.
    seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "tunnel_state", state: "connected" }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    const t1 = await sandboxStub(s.sandbox).resolve(s.agent);
    expect(t1.url).toBe(`wss://${hostnameOf(s.host.host)}`);
    expect(t1.edge).toEqual(ACCESS);
    const view = (await fleetStub(cell).fleetView()) as { hosts: { host: string; tunnel_state: string | null }[] };
    expect(view.hosts.find((h) => h.host === s.host.host)?.tunnel_state).toBe("connected");
    // The connection dropped: back to waiting, not to a target the edge would answer 5xx.
    seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "tunnel_state", state: "connecting" }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect(await fleetStub(cell).hostGatewayUrl(s.host.host)).toEqual({ kind: "connecting" });
  });

  it("a host without a tunnel never gets the Access token, whatever scheme its hello advertises", async () => {
    await storeAccessToken();
    // The harness: a loopback gateway.
    const plain = await attached(uniqueCell());
    const t1 = await sandboxStub(plain.sandbox).resolve(plain.agent);
    expect(t1.url).toBe("ws://127.0.0.1:18790");
    expect(t1.edge).toBeUndefined();
    // A host with its own TLS in front of the gateway: no Access edge, so no secret to send it.
    const direct = await attached(uniqueCell(), { gateway_url: "wss://gw.direct.example.net" });
    const t2 = await sandboxStub(direct.sandbox).resolve(direct.agent);
    expect(t2.url).toBe("wss://gw.direct.example.net");
    expect(t2.edge).toBeUndefined();
    // Even a host that claims a connected tunnel it was never given.
    const claims = await attached(uniqueCell(), { tunnel: "connected" });
    const t3 = await sandboxStub(claims.sandbox).resolve(claims.agent);
    expect(t3.url).toBe("ws://127.0.0.1:18790");
    expect(t3.edge).toBeUndefined();
  });
});

describe("enrollment again before the host ever connected", () => {
  it("an enrollment token used by a host that never said hello enrolls again: the first host dies with its tunnel; after hello it is 409", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } });
    const first = (await (await enrollRaw(cell, token)).json()) as { host: string };
    const [firstTunnel] = cf.tunnelNamed(`nest-${label(first.host)}`)!;
    // nestd never saved the answer (it timed out, or was killed): it retries with the same token.
    const res = await enrollRaw(cell, token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as { host: string; host_token: string; tunnel_token: string; gateway_url: string };
    expect(second.host).not.toBe(first.host);
    expect(second.gateway_url).toBe(`wss://${hostnameOf(second.host)}`);
    expect(await hostRow(cell, first.host)).toMatchObject({ status: "dead" });
    await until(() => !cf.tunnels.has(firstTunnel) && !cf.recordNamed(hostnameOf(first.host)), "the first host's assets to go");
    expect(cf.tunnelNamed(`nest-${label(second.host)}`), "the second host has its own tunnel").toBeDefined();
    // Once the host connects, the token is spent: a third enrollment would be a replay.
    const ws = await Ws.connect("/v1/fleet", second.host_token);
    ws.send(hostHello(second.host, cell));
    await ws.next("hello_ack");
    expect((await enrollRaw(cell, token)).status).toBe(409);
    expect(await hostRow(cell, second.host)).toMatchObject({ status: "active" });
    ws.close();
  });

  it("an AWS instance that never connected enrolls again with its identity; a connected one is a replay", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    await adminJson("/v1/admin/launched", { body: { instance_id: "i-0reenroll", role: "burst", cell } });
    const first = await enrollLaunched(cell, "i-0reenroll");
    const [firstTunnel] = cf.tunnelNamed(`nest-${label(first.host)}`)!;
    const second = await enrollLaunched(cell, "i-0reenroll");
    expect(second.host).not.toBe(first.host);
    expect(await hostRow(cell, first.host)).toMatchObject({ status: "dead" });
    await until(() => !cf.tunnels.has(firstTunnel), "the first host's tunnel to go");
    const ws = await Ws.connect("/v1/fleet", second.host_token);
    ws.send(hostHello(second.host, cell));
    await ws.next("hello_ack");
    await expect(enrollLaunched(cell, "i-0reenroll")).rejects.toThrow(/already enrolled/);
    ws.close();
  });
});

describe("a revoked tunnel API token", () => {
  it("enrolls the host without a tunnel instead of failing every enrollment, and the sweep has nothing to delete", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    cf.refuseTunnelWith = 403;
    const res = await enrollRaw(cell, (await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } })).token);
    expect(res.status).toBe(200);
    const h = (await res.json()) as Record<string, unknown>;
    expect(h.tunnel_token).toBeUndefined();
    expect(h.gateway_url).toBeUndefined();
    expect(await hostRow(cell, h.host as string)).toMatchObject({ tunnel_id: null, tunnel_hostname: null, dns_record_id: null });
    expect(cf.tunnels.size).toBe(0);
    expect(await sweep(cell)).toEqual({ tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 0, forgotten: 0 });
    // An outage is different: the enrollment fails and the host retries.
    cf.refuseTunnelWith = 503;
    expect((await enrollRaw(cell, (await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } })).token)).status).toBe(502);
  });
});

describe("retirement releases the tunnel", () => {
  const config: AwsCellConfig = {
    region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"], spot: true,
    max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  };
  class MockEc2 implements Ec2 {
    terminated: string[] = [];
    launched: LaunchSpec[] = [];
    async launch(spec: LaunchSpec) {
      if (spec.instanceType === "none") throw new CapacityError("InsufficientInstanceCapacity");
      this.launched.push(spec);
      return `i-0${this.launched.length.toString(16).padStart(8, "0")}`;
    }
    imagesList: ImageInfo[] = [];
  async images() {
    return this.imagesList;
  }
  async terminate(id: string) {
      this.terminated.push(id);
    }
    async state(): Promise<InstanceState> {
      return "terminated";
    }
  }
  /** Run FleetDO's tick now, `shiftMs` in the future as far as the idle clock is concerned. */
  async function tickAt(cell: string, ec2: MockEc2, shiftMs = 0) {
    await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = config;
      st.storage.sql.exec("UPDATE hosts SET idle_since = idle_since - ? WHERE idle_since IS NOT NULL", shiftMs);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleetStub(cell));
  }
  /** A launched instance, enrolled (with a tunnel) and connected. */
  async function launchedHost(cell: string, instanceId: string) {
    await adminJson("/v1/admin/launched", { body: { instance_id: instanceId, role: "burst", cell } });
    const enrolled = await enrollLaunched(cell, instanceId);
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell, { tunnel: "connected" }));
    await ws.next("hello_ack");
    return { ...enrolled, ws };
  }

  it("an idle host retired after the grace loses its tunnel and record", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const ec2 = new MockEc2();
    const h = await launchedHost(cell, "i-0idle0001");
    const [tunnelId] = cf.tunnelNamed(`nest-${label(h.host)}`)!;
    await tickAt(cell, ec2);
    expect((await fleetStub(cell).hostStatus(h.host))!.status).toBe("active");
    await tickAt(cell, ec2, 61_000);
    expect((await fleetStub(cell).hostStatus(h.host))!.status).toBe("dead");
    await until(() => !cf.tunnels.has(tunnelId) && !cf.recordNamed(hostnameOf(h.host)), "the idle host's assets to go");
    expect(await hostRow(cell, h.host)).toMatchObject({ tunnel_id: null, tunnel_hostname: null, dns_record_id: null });
  });

  it("a drained host (spot notice, no sandboxes left) loses its tunnel and record", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const ec2 = new MockEc2();
    const h = await launchedHost(cell, "i-0drain001");
    const [tunnelId] = cf.tunnelNamed(`nest-${label(h.host)}`)!;
    const seq = sendEvents(h.ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    await h.ws.next("ack", (m) => m.up_to >= seq);
    expect((await fleetStub(cell).hostStatus(h.host))!.status).toBe("draining");
    await tickAt(cell, ec2);
    expect((await fleetStub(cell).hostStatus(h.host))!.status).toBe("dead");
    await until(() => !cf.tunnels.has(tunnelId) && !cf.recordNamed(hostnameOf(h.host)), "the drained host's assets to go");
    expect(await hostRow(cell, h.host)).toMatchObject({ tunnel_id: null, tunnel_hostname: null, dns_record_id: null });
  });
});

describe("a dead host's tunnel", () => {
  it("is deleted with its record when the host is declared dead, and the row forgets them", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const a = await connectHost(cell);
    const [tunnelId] = cf.tunnelNamed(`nest-${label(a.host)}`)!;
    const b = await connectHost(cell);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    await until(() => !cf.tunnels.has(tunnelId) && !cf.recordNamed(hostnameOf(a.host)), "the dead host's assets to go");
    expect(await hostRow(cell, a.host)).toMatchObject({ status: "dead", tunnel_id: null, tunnel_hostname: null, dns_record_id: null });
    expect(await fleetStub(cell).hostGatewayUrl(a.host), "no URL points at a deleted tunnel").toBeNull();
    // The live host keeps everything.
    expect(cf.tunnelNamed(`nest-${label(b.host)}`)).toBeDefined();
    expect(cf.recordNamed(hostnameOf(b.host))).toBeDefined();
    // Cloudflare still lists the tunnel later (a delete whose answer was lost): the sweep knows the
    // host as this cell's and dead, and deletes it.
    cf.tunnels.set(tunnelId, { name: `nest-${label(a.host)}`, ingress: null });
    expect(await sweep(cell)).toEqual({ tunnels: 1, records: 0, retried: 0, failed: 0, unknown: 0, forgotten: 0 });
    expect(cf.tunnels.has(tunnelId)).toBe(false);
  });

  it("a delete Cloudflare refuses is retried by the sweep, for the tunnel and for the record", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const a = await connectHost(cell);
    const [tunnelId] = cf.tunnelNamed(`nest-${label(a.host)}`)!;
    cf.undeletable.add(tunnelId);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    await until(() => !cf.recordNamed(hostnameOf(a.host)), "the record to go");
    await until(() => cf.calls.some((c) => c === `deleteTunnel ${tunnelId}`), "the tunnel delete to be attempted");
    expect(cf.tunnels.has(tunnelId), "Cloudflare refused the delete").toBe(true);
    expect(await hostRow(cell, a.host)).toMatchObject({ tunnel_id: tunnelId, tunnel_hostname: hostnameOf(a.host), dns_record_id: null });
    // The connections drain; the daily sweep finishes the job and arms itself again.
    cf.undeletable.delete(tunnelId);
    await runAlarm(cell, "tunnel_sweep");
    expect(cf.tunnels.has(tunnelId)).toBe(false);
    expect(await hostRow(cell, a.host)).toMatchObject({ tunnel_id: null, tunnel_hostname: null });
    expect(await deadline(cell, "tunnel_sweep")).toBeGreaterThan(Date.now() + 23 * HOUR);

    // The other way round: the record's delete fails, the tunnel's succeeds.
    const b = await connectHost(cell);
    const [recordId] = cf.recordNamed(hostnameOf(b.host))!;
    cf.undeletableRecords.add(recordId);
    b.ws.close();
    await adminJson(`/v1/admin/hosts/${b.host}/confirm-dead?cell=${cell}`, { body: {} });
    await until(() => !cf.tunnelNamed(`nest-${label(b.host)}`), "the tunnel to go");
    await until(async () => (await hostRow(cell, b.host))?.tunnel_id === null, "the row to forget the tunnel");
    expect(await hostRow(cell, b.host)).toMatchObject({ tunnel_id: null, dns_record_id: recordId });
    cf.undeletableRecords.delete(recordId);
    expect(await sweep(cell)).toMatchObject({ retried: 1, failed: 0 });
    expect(cf.records.has(recordId)).toBe(false);
    expect(await hostRow(cell, b.host)).toMatchObject({ dns_record_id: null });
  });
});

describe("the sweep", () => {
  it("deletes only what this cell created, for hosts that are dead or never enrolled, and leaves everything else", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const live = await connectHost(cell);
    // The account's other tunnels and records; nest-shaped names this cell never created (another
    // cell's, a hand-made one); look-alikes with nest's prefix or suffix but no host id shape; and
    // two tunnels this cell did create whose enrollment never finished: one old, one in flight.
    const bitty = cf.seedTunnel("bitty");
    const rollout = cf.seedTunnel("rollout");
    const orphan = cf.seedTunnel(`nest-${ORPHAN}`);
    const lookalike = cf.seedTunnel("nest-UPPER_case");
    const otherLabel = cf.seedTunnel("nest2-01abc");
    const stale = cf.seedTunnel(`nest-${STALE}`);
    const young = cf.seedTunnel(`nest-${YOUNG}`);
    const bittyRec = cf.seedRecord("bitty.example.dev");
    const orphanRec = cf.seedRecord(`${ORPHAN}-gw-nest.example.dev`);
    const staleRec = cf.seedRecord(`${STALE}-gw-nest.example.dev`);
    const otherSuffix = cf.seedRecord("01abc-gw-nest2.example.dev");
    const lookalikeRec = cf.seedRecord("a_b-gw-nest.example.dev");
    await recordIntent(cell, `hst_${STALE}`, Date.now() - 2 * HOUR);
    await recordIntent(cell, `hst_${YOUNG}`, Date.now());
    const counts = await sweep(cell);
    expect(counts).toEqual({ tunnels: 1, records: 1, retried: 0, failed: 0, unknown: 4, forgotten: 0 });
    expect(cf.tunnels.has(stale), "an hour without a row: the enrollment failed").toBe(false);
    expect(cf.records.has(staleRec)).toBe(false);
    for (const id of [bitty, rollout, orphan, lookalike, otherLabel, young]) expect(cf.tunnels.has(id), id).toBe(true);
    for (const id of [bittyRec, orphanRec, otherSuffix, lookalikeRec]) expect(cf.records.has(id), id).toBe(true);
    expect(cf.tunnelNamed(`nest-${label(live.host)}`), "the live host's tunnel").toBeDefined();
    expect(cf.recordNamed(hostnameOf(live.host)), "the live host's record").toBeDefined();
    // Only nest's name prefix and hostname suffix were ever listed.
    expect(cf.calls.filter((c) => c.startsWith("list"))).toEqual([`listRecords ${ZONE_ID} -gw-nest.example.dev`, "listTunnels nest-"]);
    // The next complete listing no longer shows the failed enrollment's assets: its record of
    // creating them goes. The one in flight (inside the grace) and the live host's stay.
    expect(await sweep(cell)).toMatchObject({ tunnels: 0, records: 0, failed: 0, forgotten: 1 });
    expect(await intents(cell)).toEqual([`hst_${YOUNG}`, live.host].sort());
    // Nothing configured: the sweep is a no-op.
    expect(await sweep(uniqueCell())).toEqual({ tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 0, forgotten: 0 });
  });

  it("never deletes another cell's live host from the shared account", async () => {
    const cf = new FakeCloudflare();
    const mine = uniqueCell();
    const theirs = uniqueCell();
    await withCloudflare(mine, cf);
    await withCloudflare(theirs, cf);
    const other = await connectHost(theirs);
    const own = await connectHost(mine);
    expect(await sweep(mine)).toEqual({ tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 2, forgotten: 0 });
    expect(cf.tunnelNamed(`nest-${label(other.host)}`), "the other cell's tunnel").toBeDefined();
    expect(cf.recordNamed(hostnameOf(other.host)), "the other cell's record").toBeDefined();
    expect(cf.tunnelNamed(`nest-${label(own.host)}`)).toBeDefined();
    // The other cell's own sweep sees the same picture from its side.
    expect(await sweep(theirs)).toMatchObject({ tunnels: 0, records: 0, unknown: 2 });
  });

  it("spares an enrollment still in flight", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    let release!: () => void;
    cf.gate = new Promise<void>((r) => (release = r));
    const enrolling = enrollHost(cell, "burst");
    await until(() => cf.calls.some((c) => c.startsWith("createRecord")), "the tunnel to exist before its record");
    cf.gate = null;
    // The tunnel is listed and has no hosts row yet: this cell created it moments ago, so it stays.
    expect(await sweep(cell)).toEqual({ tunnels: 0, records: 0, retried: 0, failed: 0, unknown: 0, forgotten: 0 });
    release();
    const h = await enrolling;
    const [tunnelId] = cf.tunnelNamed(`nest-${label(h.host)}`)!;
    expect(await hostRow(cell, h.host)).toMatchObject({ tunnel_id: tunnelId, tunnel_hostname: hostnameOf(h.host) });
  });

  it("a refused list call costs only its own pass", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    const stale = cf.seedTunnel(`nest-${STALE}`);
    await recordIntent(cell, `hst_${STALE}`, Date.now() - 2 * HOUR);
    const listRecords = cf.listRecords.bind(cf);
    cf.listRecords = async () => (cf as unknown as { refuse(what: string): never }).refuse("records unavailable");
    expect(await sweep(cell)).toEqual({ tunnels: 1, records: 0, retried: 0, failed: 1, unknown: 0, forgotten: 0 });
    expect(cf.tunnels.has(stale)).toBe(false);
    cf.listRecords = listRecords;
  });

  it("forgets what it created only once a complete listing shows nothing left", async () => {
    const cell = uniqueCell();
    const cf = await withCloudflare(cell);
    // A failed enrollment left only its record behind.
    const staleRec = cf.seedRecord(`${STALE}-gw-nest.example.dev`);
    await recordIntent(cell, `hst_${STALE}`, Date.now() - 2 * HOUR);
    const listRecords = cf.listRecords.bind(cf);
    cf.listRecords = async () => (cf as unknown as { refuse(what: string): never }).refuse("records unavailable");
    // The tunnel listing shows nothing, but the records were never listed: proof of nothing.
    expect(await sweep(cell)).toMatchObject({ records: 0, failed: 1, forgotten: 0 });
    expect(await intents(cell)).toEqual([`hst_${STALE}`]);
    cf.listRecords = listRecords;
    expect(await sweep(cell)).toMatchObject({ records: 1, failed: 0, forgotten: 0 });
    expect(cf.records.has(staleRec)).toBe(false);
    expect(await sweep(cell)).toMatchObject({ records: 0, forgotten: 1 });
    expect(await intents(cell)).toEqual([]);
  });
});

describe("starting a brain on a chosen host", () => {
  it("runs the agent where the operator says, and refuses a host that is not active and connected in the cell", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-start" } });
    const sandboxHost = await connectHost(cell);
    const brainHost = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "chosen host" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(sandboxHost.ws, (c) => c.type === "sandbox_create");
    const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, start: false } }, 201);
    await nextCommands(sandboxHost.ws, (c) => c.type === "agent_attach" && c.agent === worker.agent);
    await adminJson(`/v1/agents/${worker.agent}/start`, { body: { host: "hst_nosuchhost0000000000000" } }, 409);
    await adminJson(`/v1/agents/${worker.agent}/start`, { body: { host: "not-a-host-id" } }, 400);
    const malformed = await SELF.fetch(`${BASE}/v1/agents/${worker.agent}/start`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const started = await adminJson<{ host: string }>(`/v1/agents/${worker.agent}/start`, { body: { host: brainHost.host } });
    expect(started.host).toBe(brainHost.host);
    const [start] = await nextCommands(brainHost.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
    expect(start.hands).toMatchObject({ sandbox: sbx.sandbox, epoch: 1 });
    await sandboxHost.ws.none("commands", 200);
    // A captain can be put on a sandbox host the same way.
    const captain = await adminJson("/v1/agents", { body: { role: "captain", workstream, cell, start: false } }, 201);
    expect((await adminJson<{ host: string }>(`/v1/agents/${captain.agent}/start`, { body: { host: sandboxHost.host } })).host).toBe(sandboxHost.host);
    const [cstart] = await nextCommands(sandboxHost.ws, (c) => c.type === "agent_start" && c.agent === captain.agent);
    expect(cstart.role).toBe("captain");
    // A host that dropped its fleet channel is refused like `controllerHost` would skip it; so is a dead one.
    brainHost.ws.close();
    await until(async () => !(await fleetStub(cell).hostStatus(brainHost.host))!.connected, "the host to disconnect");
    await adminJson(`/v1/agents/${worker.agent}/start`, { body: { host: brainHost.host } }, 409);
    await adminJson(`/v1/admin/hosts/${brainHost.host}/confirm-dead?cell=${cell}`, { body: {} });
    await adminJson(`/v1/agents/${worker.agent}/start`, { body: { host: brainHost.host } }, 409);
  });
});
