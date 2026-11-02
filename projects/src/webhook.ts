// nest's events to the app (docs/control-plane/api/clients/#events-to-the-owner): each POST to
// /hooks/nest is one event, `{id, type, …fields}`, signed `Nest-Signature: t=<ms>,v1=<hex
// HMAC-SHA256(secret, "<t>.<body>")>` with the secret's UTF-8 bytes as the key.

/** How far a signature's time may be from now, either way. */
export const TOLERANCE_MS = 5 * 60 * 1000;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The signature header for `body` at `t` (tests sign with it; the check recomputes it). */
export async function sign(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

/** Whether `header` signs `body` with `secret`, within the tolerance of `now`. */
export async function verifySignature(secret: string, header: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,16}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === null || sigs.length === 0 || Math.abs(now - t) > TOLERANCE_MS) return false;
  const want = await sign(secret, t, body);
  let match = false;
  for (const s of sigs) match = constantTimeEqual(s, want) || match;
  return match;
}

/** The events the app acts on; any other type is acknowledged and ignored. */
export type NestEvent =
  | { id: string; type: "agent.turn_completed"; agent: string; turn?: unknown; text?: string }
  | { id: string; type: "agent.exited"; agent: string; reason?: string; text?: string }
  | { id: string; type: "agent.ask"; agent: string; ask: string; question?: string; approval?: unknown }
  | { id: string; type: "agent.error"; agent: string; code?: string; message?: string };

/** The event if `raw` is one the app routes by agent, else null (acknowledged and ignored). */
export function routable(raw: unknown): NestEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id || typeof e.type !== "string" || typeof e.agent !== "string") return null;
  switch (e.type) {
    case "agent.turn_completed":
    case "agent.exited":
    case "agent.error":
      return e as unknown as NestEvent;
    case "agent.ask":
      return typeof e.ask === "string" ? (e as unknown as NestEvent) : null;
    default:
      return null;
  }
}
