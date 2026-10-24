import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
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

export async function enrollHost(cell: string, role: "burst" | "controller" = "burst"): Promise<EnrollResponse> {
  const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role, cell } });
  const res = await SELF.fetch(`${BASE}/v1/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1, role, cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: await csrPem(),
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
    role: "burst",
    cell,
    versions: { nestd: "0.1.0", nest_proxy: "0.1.0", agent_runner: "0.1.0", claude_code: "2.1.296" },
    gateway_url: GATEWAY_URL,
    sandboxes: [],
    agents: [],
    capacity: { vcpus_free: 8, memory_mib_free: 16384, hugepages_mib_free: 8192, hugepages_mib_total: 8192, sandboxes: 0, agents: 0, warm: [] },
    ...extra,
  };
}

/** Enroll a host and connect its fleet channel (hello acknowledged, the cell's binding keys received). */
export async function connectHost(cell: string, role: "burst" | "controller" = "burst") {
  const enrolled = await enrollHost(cell, role);
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, { role }));
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
export type { FleetToHost };
