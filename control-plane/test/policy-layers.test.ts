import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { admin, adminJson, connectHost, nextCommands, runDue, sleep, uniqueCell } from "./helpers";

describe("egress policy layers", () => {
  it("a temporary grant pushes a newer policy and is withdrawn when it expires", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    expect(create.policy.version).toBe(1);

    // The 100 ms grant may well have lapsed by the time the response arrives on a loaded machine:
    // check the expiry against when it was granted, not against now.
    const granted = Date.now();
    const policy = await adminJson(`/v1/sandboxes/${sbx.sandbox}/grants`, { body: { host: "api.openai.com", ttl_ms: 100, ports: [443] } });
    const grant = policy.allow.find((r: any) => r.host === "api.openai.com");
    expect(grant).toMatchObject({ layer: "sandbox", ports: [443] });
    expect(grant.expires_ms).toBeGreaterThanOrEqual(granted + 100);
    const [update] = await nextCommands(h.ws, (c) => c.type === "policy_update");
    expect(update).toMatchObject({ sandbox: sbx.sandbox, epoch: 1, policy: { version: 2 } });

    await sleep(150);
    await runDue(env.SANDBOX.get(env.SANDBOX.idFromName(sbx.sandbox)));
    const [expired] = await nextCommands(h.ws, (c) => c.type === "policy_update" && c.policy.version === 3);
    expect(expired.policy.allow.some((r: any) => r.host === "api.openai.com")).toBe(false);
  });

  it("injection bindings deliver secret values to the host (proxy memory)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await adminJson("/v1/admin/secrets/inject:github", { method: "PUT", body: { value: "ghs_realtoken" } });
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sbx.sandbox));
    const policy = await stub.setPolicy({
      allow: [{ host: "api.stripe.com" }],
      passthrough: [],
      inject: [{ name: "github", hosts: ["github.com", "api.github.com"], placeholder: "nest-ph-github-7f3a", locations: [{ type: "authorization_bearer" }] }],
      tcp: [],
    });
    expect(policy.inject[0]!.name).toBe("github");
    const cmds = await nextCommands(h.ws, (c) => c.type === "secrets_update");
    const secrets = cmds.find((c) => c.type === "secrets_update");
    expect(secrets.secrets).toEqual([{ binding: "github", value: "ghs_realtoken" }]);
    expect(JSON.stringify(cmds.find((c) => c.type === "policy_update")?.policy ?? {})).not.toContain("ghs_realtoken");
  });
});

describe("temporary grants are checked before anything is stored", () => {
  it("a port outside 1-65535 is refused: nestd's u16 couldn't parse the policy it would join", async () => {
    const sbx = await adminJson("/v1/sandboxes", { body: { cell: uniqueCell() } }, 202);
    for (const ports of [[70000], [0], [-1]]) {
      const r = await admin(`/v1/sandboxes/${sbx.sandbox}/grants`, { body: { host: "example.com", ttl_ms: 60_000, ports } });
      expect(r.status, JSON.stringify(ports)).toBe(400);
    }
    expect((await adminJson(`/v1/sandboxes/${sbx.sandbox}/policy`)).allow.some((r: any) => r.host === "example.com")).toBe(false);
  });

  it("a grant on an unknown sandbox is 404 and leaves no row or alarm behind", async () => {
    const id = "sbx_doesnotexist01";
    const r = await admin(`/v1/sandboxes/${id}/grants`, { body: { host: "example.com", ttl_ms: 60_000 } });
    expect(r.status).toBe(404);
    const left = await runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(id)), async (_i, st) => ({
      grants: st.storage.sql.exec("SELECT COUNT(*) AS n FROM grants").one().n,
      deadlines: st.storage.sql.exec("SELECT key FROM deadlines").toArray().length,
      alarm: await st.storage.getAlarm(),
    }));
    expect(left).toEqual({ grants: 0, deadlines: 0, alarm: null });
  });
});
