// The gateway boundary from the control plane's side: every fixture under protocol/fixtures/gateway/
// round-trips through the TypeScript mirrors, the signed token fixture verifies with the fixture's
// public key (the cross-language oracle for base64url, the signing domain and the r‖s signature
// format), and a token signed here parses and verifies the way the gateway will.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as G from "../src/protocol/gateway";
import {
  generateBindingKey,
  importPrivateJwk,
  kidOf,
  parseBinding,
  signBinding,
  toBindingKey,
  verifyBinding,
} from "../src/lib/binding";
import { b64urlToBytes } from "../src/lib/util";

const files = import.meta.glob("../../protocol/fixtures/gateway/**/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;

type Entry = { schema: z.ZodType; variants?: string[] };
const byType = (variants: readonly { shape: { type: { value: unknown } } }[]) => variants.map((v) => String(v.shape.type.value));
const dirs: Record<string, Entry> = {
  client_message: { schema: G.ClientMessage, variants: byType(G.ClientMessageVariants) },
  gateway_message: { schema: G.GatewayMessage, variants: byType(G.GatewayMessageVariants) },
  binding_claims: { schema: G.BindingClaims },
  hands_target: { schema: G.HandsTarget },
};

const grouped = new Map<string, Record<string, unknown>[]>();
for (const [path, value] of Object.entries(files)) {
  const parts = path.split("/");
  const dir = parts[parts.length - 2]!;
  grouped.set(dir, [...(grouped.get(dir) ?? []), { name: parts[parts.length - 1]!, value }]);
}

describe("gateway fixtures", () => {
  it("every message directory has a schema", () => {
    for (const dir of grouped.keys()) {
      if (dir === "binding_token") continue;
      expect(dirs[dir], `no TypeScript schema for protocol/fixtures/gateway/${dir}`).toBeDefined();
    }
  });

  for (const [dir, entry] of Object.entries(dirs)) {
    it(`${dir} round-trips${entry.variants ? " and covers every variant" : ""}`, () => {
      const seen = new Set<string>();
      for (const { name, value } of grouped.get(dir) ?? []) {
        const parsed = entry.schema.safeParse(value);
        expect(parsed.success, `${dir}/${name}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(value);
        const tag = (value as Record<string, unknown>).type;
        if (typeof tag === "string") {
          expect(String(name).split(".")[0]).toBe(tag);
          seen.add(tag);
        }
      }
      if (entry.variants) expect([...seen].sort()).toEqual([...entry.variants].sort());
    });
  }
});

describe("binding tokens", () => {
  const signed = (grouped.get("binding_token") ?? []).find((f) => f.name === "signed.json")!.value as {
    kid: string;
    public_key: string;
    token: string;
    claims: G.BindingClaims;
  };

  it("the signed fixture verifies with its public key and names its claims and kid", async () => {
    const pub = b64urlToBytes(signed.public_key);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(4);
    expect(await kidOf(pub)).toBe(signed.kid);
    const claims = await verifyBinding(pub, signed.token);
    expect(claims).toEqual(signed.claims);
    expect(claims?.kid).toBe(signed.kid);
    expect(parseBinding(signed.token).signature.length).toBe(64);
  });

  it("a tampered signature, tampered claims or another key fails to verify", async () => {
    const pub = b64urlToBytes(signed.public_key);
    const dot = signed.token.lastIndexOf(".");
    const sig = signed.token.slice(dot + 1);
    const flipped = (sig[3] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifyBinding(pub, signed.token.slice(0, dot + 1) + flipped)).toBeNull();
    const parsed = parseBinding(signed.token);
    const other = await signBinding(await importPrivateJwk((await generateBindingKey()).privateJwk), { ...parsed.claims, epoch: 5 });
    expect(await verifyBinding(pub, other)).toBeNull();
    expect(await verifyBinding(pub, "nbd_" + signed.token.slice(4).replace(/^./, "x"))).toBeNull();
  });

  it("a token signed here parses to its claims, verifies, and carries the kid of its key", async () => {
    const pair = await generateBindingKey();
    const key = await importPrivateJwk(pair.privateJwk);
    const claims: G.BindingClaims = {
      v: G.BINDING_VERSION, kid: pair.kid, sandbox: "sbx_01jb7m2a4c", epoch: 4, client: "agt_01jb7n0w1e", scope: "hands",
      exp_ms: 1760274000000,
    };
    const token = await signBinding(key, claims);
    expect(token.startsWith(G.BINDING_PREFIX)).toBe(true);
    expect(parseBinding(token).claims).toEqual(claims);
    expect(await verifyBinding(pair.publicKey, token)).toEqual(claims);
    expect(toBindingKey(pair).kid).toBe(await kidOf(pair.publicKey));
    expect(() => parseBinding(token.replace("nbd_", "nht_"))).toThrow(/prefix/);
    expect(() => parseBinding("nbd_abc")).toThrow(/shape/);
  });
});
