import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminJson, connectHost, nextCommands, sleep, uniqueCell } from "./helpers";

describe("egress policy layers", () => {
  it("a temporary grant pushes a newer policy and is withdrawn when it expires", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "x" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    expect(create.policy.version).toBe(1);

    const policy = await adminJson(`/v1/sandboxes/${sbx.sandbox}/grants`, { body: { host: "api.openai.com", ttl_ms: 100, ports: [443] } });
    const grant = policy.allow.find((r: any) => r.host === "api.openai.com");
    expect(grant).toMatchObject({ layer: "sandbox", ports: [443] });
    expect(grant.expires_ms).toBeGreaterThan(Date.now());
    const [update] = await nextCommands(h.ws, (c) => c.type === "policy_update");
    expect(update).toMatchObject({ sandbox: sbx.sandbox, epoch: 1, policy: { version: 2 } });

    await sleep(150);
    await runDurableObjectAlarm(env.SANDBOX.get(env.SANDBOX.idFromName(sbx.sandbox)));
    const [expired] = await nextCommands(h.ws, (c) => c.type === "policy_update" && c.policy.version === 3);
    expect(expired.policy.allow.some((r: any) => r.host === "api.openai.com")).toBe(false);
  });

  it("injection bindings deliver secret values to the host (proxy memory)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await adminJson("/v1/admin/secrets/inject:github", { method: "PUT", body: { value: "ghs_realtoken" } });
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "x" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sbx.sandbox));
    const policy = await stub.setWorkstreamPolicy({
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

describe("workstreams and captain wakes", () => {
  it("batches decision events into one event_batch turn for the captain; progress alone doesn't wake", async () => {
    const cell = uniqueCell();
    await connectHost(cell, "controller");
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk" } });
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "dark mode" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent;
    const ws = env.WORKSTREAM.get(env.WORKSTREAM.idFromName(workstream));
    const cap = env.AGENT.get(env.AGENT.idFromName(captain));

    await ws.ingest({ workstream, ts_ms: Date.now(), type: "progress", summary: "tests green" });
    expect(await runDurableObjectAlarm(ws)).toBe(false);
    expect((await cap.turns()).length).toBe(0);

    await ws.ingest({ workstream, ts_ms: Date.now(), type: "pr_opened", url: "https://github.com/x/y/pull/2", title: "Dark mode" });
    await ws.ingest({ workstream, ts_ms: Date.now(), type: "blocked", reason: "needs design review" });
    expect(await runDurableObjectAlarm(ws)).toBe(true);
    const turns = await cap.turns();
    expect(turns.length).toBe(1);
    expect(turns[0]!.input.kind).toBe("event_batch");
    expect(turns[0]!.input.text).toContain("2 event(s)");
    expect(turns[0]!.input.text).toContain("tests green");
  });
});
