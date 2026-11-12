import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { Kms } from "../src/lib/kms";
import type { EnrollResponse, FleetToHost } from "../src/protocol/control";

export const ADMIN = "test-admin-token";
export const BASE = "http://cp.test";

export async function admin(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

export async function adminJson<T = any>(path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const res = await admin(path, init);
  const text = await res.text();
  if (status !== undefined) expect(res.status, text).toBe(status);
  else expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

export const uniqueCell = () => `t-${crypto.randomUUID().slice(0, 8)}`;

export async function csrPem(): Promise<string> {
  x509.cryptoProvider.set(crypto);
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=nest-proxy", keys, signingAlgorithm: alg });
  return csr.toString("pem");
}

export async function enrollHost(cell: string, role: "sandbox" | "brain" = "sandbox"): Promise<EnrollResponse> {
  const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role, cell } });
  const res = await SELF.fetch(`${BASE}/v1/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1, role, cell, proof: { type: "enrollment_token", token }, ...(role === "sandbox" ? { proxy_ca_csr_pem: await csrPem() } : {}),
    }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as EnrollResponse;
}

type Msg = Record<string, any> & { type: string };

/** WebSocket test client with a message queue and typed waits. */
export class Ws {
  readonly received: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private closeWaiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as Msg;
      const w = this.waiters.findIndex((x) => x.pred(m));
      if (w >= 0) this.waiters.splice(w, 1)[0]!.resolve(m);
      else this.received.push(m);
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      for (const w of this.closeWaiters.splice(0)) w();
    });
  }

  static async connect(path: string, token: string): Promise<Ws> {
    const res = await SELF.fetch(`${BASE}${path}`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
    if (res.status !== 101) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
    const ws = res.webSocket!;
    ws.accept();
    return new Ws(ws);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Next message matching `type` (and `pred`), from the backlog or the future. */
  next(type: string, pred: (m: Msg) => boolean = () => true, timeoutMs = 3000): Promise<Msg> {
    const match = (m: Msg) => m.type === type && pred(m);
    const i = this.received.findIndex(match);
    if (i >= 0) return Promise.resolve(this.received.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { pred: match, resolve: (m: Msg) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1); // a timed-out waiter must not swallow later messages
        reject(new Error(`timed out waiting for ${type}; backlog: ${JSON.stringify(this.received).slice(0, 1500)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Resolve `true` if no matching message arrives within `ms`. */
  async none(type: string, ms = 150, pred: (m: Msg) => boolean = () => true): Promise<boolean> {
    try {
      await this.next(type, pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  /** The close, once this end has heard it (a server's close arrives after its last frame), or null after `ms`. */
  async whenClosed(ms = 5000): Promise<{ code: number; reason: string } | null> {
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        this.closeWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.closed;
  }

  drain(): Msg[] {
    return this.received.splice(0);
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      // ignore
    }
  }
}

/** What a test host advertises as its sandbox gateway (the e2e harness uses the same address). */
export const GATEWAY_URL = "ws://127.0.0.1:18790";

export function hostHello(host: string, cell: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    type: "hello",
    protocol_version: 1,
    host,
    instance_id: "nestdtest0000001",
    role: "sandbox",
    cell,
    versions: { nestd: "0.1.0", nest_proxy: "0.1.0", agent_runner: "0.1.0", claude_code: "2.1.296" },
    gateway_url: GATEWAY_URL,
    // A current nestd (keys brains by agent epoch); a test of the previous release passes `false`.
    brain_epochs: true,
    // Its nest-proxy bounds guarded requests; a test of the previous release passes `false`.
    guard_bounds: true,
    sandboxes: [],
    agents: [],
    capacity: { vcpus_free: 8, memory_mib_free: 16384, hugepages_mib_free: 8192, hugepages_mib_total: 8192, sandboxes: 0, agents: 0, warm: [] },
    ...extra,
  };
}

/** Enroll a host and connect its fleet channel (hello acknowledged, the cell's binding keys received). */
export async function connectHost(cell: string, role: "sandbox" | "brain" = "sandbox", hello: Partial<Record<string, unknown>> = {}) {
  const enrolled = await enrollHost(cell, role);
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, { role, ...hello }));
  const ack = await ws.next("hello_ack");
  const keys = (await ws.next("binding_key")).keys as { kid: string; public_key: string }[];
  return { ...enrolled, ws, ack, keys };
}

/** Wait for the next `commands` batch, ack it, and return its commands. */
export async function nextCommands(ws: Ws, pred: (c: any) => boolean = () => true): Promise<any[]> {
  const msg = await ws.next("commands", (m) => (m.commands as any[]).some(pred));
  ws.send({ type: "ack", up_to: msg.seq });
  return msg.commands as any[];
}

/** Event batch seqs are strictly sequential per channel (a gap closes it): one counter per socket. */
const eventSeqs = new WeakMap<Ws, number>();
export function sendEvents(ws: Ws, events: unknown[], seq?: number): number {
  const s = seq ?? (eventSeqs.get(ws) ?? 1000) + 1;
  eventSeqs.set(ws, Math.max(s, eventSeqs.get(ws) ?? 0));
  ws.send({ type: "events", seq: s, events });
  return s;
}

export async function okResult(ws: Ws, cmd: string) {
  const seq = sendEvents(ws, [{ ts_ms: Date.now(), type: "command_result", cmd, outcome: { status: "ok" } }]);
  await ws.next("ack", (m) => m.up_to >= seq);
}

export const manifest = (c: string) => `blake3:${c.repeat(64)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fn`'s first truthy value, polled for up to `ms`. For what another DO, an alarm or workerd's socket
 * delivery settles on its own time: wait for it rather than sleeping and hoping.
 */
export async function eventually<T>(what: string, fn: () => Promise<T> | T, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * Run a DO's alarm and wait until every deadline due now has run (a test makes one due with `at = 0`).
 * `runDurableObjectAlarm` alone runs only an alarm that is scheduled and not already running: with a real
 * alarm in flight it does nothing, and a row a test wrote never armed one (`Deadlines.set` does that).
 * After the one direct run, the rest is left to the pool's real alarms, which never overlap (a second
 * direct run alongside one in flight would run a handler twice at once, which production never does).
 */
export async function runDue(stub: DurableObjectStub): Promise<void> {
  const t0 = Date.now();
  await runDurableObjectAlarm(stub);
  await eventually("the due deadlines to run", () => runInDurableObject(stub, async (_i: unknown, st: DurableObjectState) => {
    if (!st.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deadlines'").toArray().length) return true;
    const due = st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deadlines WHERE at <= ?", t0).one().n;
    if (due && (await st.storage.getAlarm()) === null) await st.storage.setAlarm(Date.now());
    return due === 0;
  }));
}

const agentDO = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

/** Wait until AgentDO has received `bytes` of the current stream (at `base`, when given): a sent segment lands when workerd delivers it. */
export async function received(agent: string, bytes: number, base?: number): Promise<void> {
  await eventually(`${bytes} bytes received`, async () => {
    const i = await agentDO(agent).info();
    return i.received_bytes >= bytes && (base === undefined || i.recv_base === base);
  });
}

/** Wait until AgentDO holds no runner session socket (a client's close lands when workerd delivers it). */
export async function sessionGone(agent: string): Promise<void> {
  await eventually("the session socket to close", async () =>
    (await runInDurableObject(agentDO(agent), (_i: unknown, st: DurableObjectState) => st.getWebSockets("session").length)) === 0);
}

/** Inbound items (hellos, event batches) submitted for `host` at FleetDO and not finished, the running one included. */
export const inboundPending = (cell: string, host: string) => runInDurableObject(env.FLEET.get(env.FLEET.idFromName(cell)), (inst: FleetDO) =>
  (inst as unknown as { inbound: Map<string, { pending: number }> }).inbound.get(host)?.pending ?? 0);

/** Wait until FleetDO has finished everything it took from `host`: a hello's work goes on after its `hello_ack`. */
export async function inboundSettled(cell: string, host: string): Promise<void> {
  await eventually(`FleetDO to finish ${host}'s inbound`, async () => (await inboundPending(cell, host)) === 0);
}
export type { FleetToHost };

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** DER INTEGER for an unsigned big-endian value (a leading 0x00 when the high bit is set). */
function derInt(v: Uint8Array): number[] {
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++;
  const body = [...v.subarray(i)];
  if (body[0]! & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

/** Stands in for KMS: signs with a local key and answers in KMS's format (a DER ECDSA-Sig-Value). */
/** The same P-256 key as a compressed-point SubjectPublicKeyInfo: valid DER, but not WebCrypto's encoding. */
export function compressedSpki(spki: Uint8Array): Uint8Array {
  if (spki.length !== 91 || spki[26] !== 0x04) throw new Error("not an uncompressed P-256 SubjectPublicKeyInfo");
  const x = spki.slice(27, 59);
  const yOdd = spki[90]! & 1;
  return new Uint8Array([0x30, 0x39, ...spki.slice(2, 23), 0x03, 0x22, 0x00, 0x02 + yOdd, ...x]);
}

export class FakeKms implements Kms {
  calls = 0;
  /** Every key id asked for, in order. */
  keyIds: string[] = [];
  /** How `publicKey` encodes the key: WebCrypto's form, or another valid DER (a compressed point). */
  encoding: "webcrypto" | "compressed" = "webcrypto";
  constructor(private readonly keys: CryptoKeyPair) {}
  static async create() {
    return new FakeKms((await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair);
  }
  async sign(keyId: string, message: Uint8Array) {
    this.calls++;
    this.keyIds.push(keyId);
    const raw = new Uint8Array(await crypto.subtle.sign(SIGN, this.keys.privateKey, message));
    const seq = [...derInt(raw.subarray(0, 32)), ...derInt(raw.subarray(32))];
    return new Uint8Array([0x30, seq.length, ...seq]);
  }
  async publicKey(keyId = "") {
    this.keyIds.push(keyId);
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", this.keys.publicKey)) as ArrayBuffer);
    return this.encoding === "compressed" ? compressedSpki(spki) : spki;
  }
}
