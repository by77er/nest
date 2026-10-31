// One signed AWS API call (EC2, KMS, SSM), bounded like every Cloudflare call (`cloudflare.ts`): a
// slow or failing AWS must never hold a tick, an enrollment or a placement for long.
import { AwsClient } from "aws4fetch";

export interface AwsOptions {
  /** The fetch to send with (tests pass a fake). */
  fetchFn?: typeof fetch;
  /** The whole call's bound, retries included. */
  timeoutMs?: number;
}

/** A 5xx or a throttle (429) is retried this many times, with jittered backoff, inside the bound. */
const RETRIES = 2;
const TIMEOUT_MS = 10_000;

export class AwsApi {
  private readonly client: AwsClient;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(service: string, accessKeyId: string, secretAccessKey: string, region: string, opts: AwsOptions = {}) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, region, service });
    this.endpoint = `https://${service}.${region}.amazonaws.com/`;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** POST `body` to the service's regional endpoint: the final response's status and text. */
  async post(headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number; text: string }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    // Never `this.fetchFn(...)`: the global fetch called as a method gets the wrong `this` in workerd.
    const fetchFn = this.fetchFn;
    for (let i = 0; ; i++) {
      const res = await fetchFn(await this.client.sign(this.endpoint, { method: "POST", headers, body }), { signal });
      if ((res.status < 500 && res.status !== 429) || i === RETRIES) return { ok: res.ok, status: res.status, text: await res.text() };
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, Math.random() * 50 * 2 ** i));
    }
  }

  /** A JSON-protocol call (`x-amz-json-1.1`, as KMS and SSM speak) of `target`. */
  json(target: string, body: unknown) {
    return this.post({ "content-type": "application/x-amz-json-1.1", "x-amz-target": target }, JSON.stringify(body));
  }
}
