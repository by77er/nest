import { ErrorCodes, type ErrorBody } from "../protocol/model";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sortable, prefixed id: 10 chars of millisecond time + 16 random chars (Crockford base32). */
export function newId(prefix: string, nowMs = Date.now()): string {
  let t = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let r = "";
  for (const b of rnd) r += CROCKFORD[b % 32];
  return `${prefix}${time}${r}`;
}

/**
 * A prefixed id derived from `key` (26 Crockford base32 chars of its SHA-256, the length of
 * {@link newId}'s): the same key always names the same object, so a re-run of a call that created one
 * creates the same one again (an idempotent create finds it).
 */
export async function keyedId(prefix: string, key: string): Promise<string> {
  const digest = await sha256(`nest-id/${prefix}/${key}`);
  let r = "";
  for (let i = 0; i < 26; i++) r += CROCKFORD[digest[i]! % 32];
  return `${prefix}${r}`;
}

export function errorBody(code: string, message: string, retryable = false): ErrorBody {
  return { code, message, retryable };
}

/**
 * Expected, client-visible error. The code and HTTP status are encoded in `message` as well, because
 * only the message survives Durable Object RPC (see `asNestError`).
 */
export class NestError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(`nest:${code}:${status}:${retryable ? 1 : 0}:${detail}`);
    this.name = "NestError";
  }
  body(): ErrorBody {
    return errorBody(this.code, this.detail, this.retryable);
  }
}

/** Recover a NestError from a local throw or from an error that crossed a Durable Object RPC boundary. */
export function asNestError(e: unknown): NestError | null {
  if (e instanceof NestError) return e;
  const m = e instanceof Error ? /^nest:([a-z_]+):(\d+):([01]):([\s\S]*)$/.exec(e.message) : null;
  return m ? new NestError(m[1]!, m[4]!, Number(m[2]), m[3] === "1") : null;
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  const ne = asNestError(e);
  if (ne) return json({ error: ne.body() }, ne.status);
  console.error("internal error", e);
  return json({ error: errorBody(ErrorCodes.INTERNAL, "internal error", true) }, 500);
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const b64url = (bytes: Uint8Array) => bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64urlToBytes = (s: string) => b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pemToDer(pem: string): Uint8Array {
  return b64ToBytes(pem.replace(/-----(BEGIN|END) [^-]+-----/g, "").replace(/\s+/g, ""));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** `text` cut to at most `max` UTF-8 bytes (on a character boundary), marked when cut. */
export function clip(text: string, max: number): string {
  if (utf8(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8(text.slice(0, mid)) <= max - 3) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
