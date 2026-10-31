// The AWS clients (src/lib/aws.ts, ec2.ts, kms.ts, ssm.ts) against a fake fetch: every call is
// signed for its service and region, bounded (a hung AWS never holds a tick), retried only on a 5xx
// or a throttle, and EC2's instance state never reads an unparseable answer as "gone".
import { describe, expect, it } from "vitest";
import { AwsApi } from "../src/lib/aws";
import { AwsEc2, isDead, type InstanceState } from "../src/lib/ec2";
import { AwsKms } from "../src/lib/kms";
import { AwsSsm } from "../src/lib/ssm";

type Answer = { status?: number; body: string } | "hang";

function fake(answers: Answer[]) {
  const calls: Request[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(input as Request);
    const a = answers.shift() ?? { status: 500, body: "no answer left" };
    if (a === "hang") {
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    }
    return new Response(a.body, { status: a.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const STATE = (name: string) =>
  `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-0a</instanceId><instanceState><code>16</code><name>${name}</name></instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;

describe("AwsApi", () => {
  it("signs for the service's regional endpoint", async () => {
    const f = fake([{ body: "{}" }]);
    await new AwsApi("kms", "AKIDEXAMPLE", "secret", "eu-west-1", { fetchFn: f.fetchFn }).json("TrentService.Sign", {});
    expect(f.calls[0]!.url).toBe("https://kms.eu-west-1.amazonaws.com/");
    expect(f.calls[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/kms\/aws4_request/);
    expect(f.calls[0]!.headers.get("x-amz-target")).toBe("TrentService.Sign");
  });

  it("retries a 5xx or a throttle twice, and never a 4xx", async () => {
    const api = (answers: Answer[]) => {
      const f = fake(answers);
      return { f, api: new AwsApi("ssm", "a", "s", "us-east-1", { fetchFn: f.fetchFn }) };
    };
    const a = api([{ status: 503, body: "" }, { status: 429, body: "" }, { body: "ok" }]);
    expect(await a.api.json("X", {})).toMatchObject({ ok: true, text: "ok" });
    expect(a.f.calls).toHaveLength(3);
    const b = api([{ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "last" }, { body: "never" }]);
    expect(await b.api.json("X", {})).toMatchObject({ ok: false, status: 500, text: "last" });
    expect(b.f.calls).toHaveLength(3);
    const c = api([{ status: 400, body: "bad" }, { body: "never" }]);
    expect(await c.api.json("X", {})).toMatchObject({ ok: false, status: 400 });
    expect(c.f.calls).toHaveLength(1);
  });

  it("gives up on a hung call within its bound", async () => {
    const f = fake(["hang"]);
    const t0 = Date.now();
    await expect(new AwsEc2("a", "s", "us-east-1", { fetchFn: f.fetchFn, timeoutMs: 100 }).terminate("i-0a")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("AwsEc2.state", () => {
  const ec2 = (body: string, status = 200) => new AwsEc2("a", "s", "us-east-1", { fetchFn: fake([{ status, body }]).fetchFn });

  it("reads the instance's state, and only a missing instance as gone", async () => {
    expect(await ec2(STATE("running")).state("i-0a")).toBe("running");
    expect(await ec2(STATE("shutting-down")).state("i-0a")).toBe("shutting-down");
    expect(await ec2("<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code></Error></Errors></Response>", 400).state("i-0a")).toBeNull();
    expect(await ec2("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>").state("i-0a")).toBeNull();
  });

  it("throws on an answer it can't read: a wrong region or account must never confirm a host dead (B-10)", async () => {
    await expect(ec2("<html>a captive portal</html>").state("i-0a")).rejects.toThrow(/no state/);
  });

  it("only terminated, or an instance EC2 no longer knows, proves a host dead", () => {
    const dead: Record<InstanceState, boolean> = {
      pending: false, running: false, "shutting-down": false, terminated: true, stopping: false, stopped: false, unknown: false,
    };
    for (const [s, want] of Object.entries(dead)) expect([s, isDead(s as InstanceState)]).toEqual([s, want]);
    expect(isDead(null)).toBe(true);
  });
});

describe("AwsKms and AwsSsm", () => {
  it("send their JSON targets and read the answers", async () => {
    const k = fake([{ body: JSON.stringify({ PublicKey: btoa("\x01\x02"), KeySpec: "ECC_NIST_P256" }) }]);
    expect(await new AwsKms("a", "s", "us-east-1", { fetchFn: k.fetchFn }).publicKey("alias/x")).toEqual(new Uint8Array([1, 2]));
    expect(k.calls[0]!.headers.get("x-amz-target")).toBe("TrentService.GetPublicKey");
    const s = fake([{ body: JSON.stringify({ Parameters: [{ Name: "/nest/ami", Value: "ami-0a", LastModifiedDate: 1.5 }] }) }]);
    expect(await new AwsSsm("a", "s", "us-east-1", { fetchFn: s.fetchFn }).parameter("/nest/ami")).toEqual({ value: "ami-0a", modified_ms: 1500 });
    expect(s.calls[0]!.headers.get("x-amz-target")).toBe("AmazonSSM.GetParameters");
  });
});
