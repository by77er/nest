// The attention list's reading of the fleet view, beyond what the page tests render: hosts that are
// neither live nor history, a tunnel not up, and sandboxes off any host that failed or can't be read.
// The inputs are the recorded responses (fixtures/admin.ts), changed one field at a time.
import { describe, expect, it } from "vitest";
import { fleet as recordedFleet } from "../../fixtures/admin";
import type { Fleet } from "../../src/api";
import { attention, live } from "../../src/ui/fleet";

const NOW = recordedFleet.hosts[0]!.last_rx! + 90_000;
const fleet = (change: (f: Fleet) => void): Fleet => {
  const f = structuredClone(recordedFleet) as Fleet;
  change(f);
  return f;
};
const read = (f: Fleet) => attention({ fleet: f, agents: undefined, agentsError: null, lifetimes: undefined, lifetimesError: null, now: NOW });
const brief = (f: Fleet) => read(f).map((i) => `${i.role} ${i.noun} ${i.label}`);

describe("the attention list", () => {
  it("is empty for the recorded fleet: a live host, a running sandbox", () => {
    expect(read(structuredClone(recordedFleet) as Fleet)).toEqual([]);
  });

  it("a host active but disconnected is a warning, one awaiting STONITH an error; neither is live", () => {
    const off = fleet((f) => { f.hosts[0]!.connected = false; });
    expect(brief(off)).toEqual(["warning Host disconnected"]);
    expect(read(off)[0]!.reason).toBe("Active but not connected; last heard 1m ago");
    expect(live(off, undefined).hosts).toEqual([]);
    expect(brief(fleet((f) => { f.hosts[0]!.status = "stonith_pending"; f.hosts[0]!.connected = false; }))).toEqual(["danger Host stonith pending"]);
  });

  it("draining, expired and dead hosts are not attention: draining is deliberate, the others hold nothing", () => {
    for (const status of ["draining", "expired", "dead"] as const) {
      expect(brief(fleet((f) => { f.hosts[0]!.status = status; f.hosts[0]!.connected = status === "draining"; }))).toEqual([]);
    }
  });

  it("a live host whose tunnel is named but not connected is a warning; one with no tunnel is not", () => {
    expect(brief(fleet((f) => { f.hosts[0]!.tunnel_hostname = "h-sbx-nest.example"; f.hosts[0]!.tunnel_state = "connecting"; }))).toEqual(["warning Host tunnel connecting"]);
  });

  it("a sandbox off any host that failed, or whose SandboxDO did not answer, is an error; one parked in S3 is not", () => {
    const off = (state: Fleet["sandboxes"][number]["sandbox_state"], infoError = false) =>
      fleet((f) => { Object.assign(f.sandboxes[0]!, { host: null, lease_state: null, sandbox_state: state, info_error: infoError }); });
    expect(brief(off("fenced"))).toEqual(["danger Sandbox fenced"]);
    expect(brief(off(null, true))).toEqual(["danger Sandbox unreadable"]);
    expect(brief(off("suspended"))).toEqual([]);
    expect(live(off("suspended"), undefined)).toMatchObject({ parked: 1, waiting: 0, other: 0, sandboxes: [] });
  });
});

describe("the cell's enrolment breakers", () => {
  it("an open one is a warning naming the type whole, its failures and the next try; a closed one with failures is not attention", () => {
    const f = fleet((x) => {
      x.enroll_breakers = [
        { role: "sandbox", type: "c8id.large", failures: 3, open_until_ms: NOW + 25 * 60_000, open: true },
        { role: "sandbox", type: "c8i.large", failures: 2, open_until_ms: null, open: false },
      ];
    });
    expect(brief(f)).toEqual(["warning Launches paused"]);
    expect(read(f)[0]).toMatchObject({ subject: "c8id.large", subjectWhole: true, reason: "3 sandbox host launches in a row never enrolled; next try in 25m", target: null });
  });

  it("a control plane before the breaker sends none: nothing to show", () => {
    const f = fleet((x) => { delete x.enroll_breakers; });
    expect(brief(f)).toEqual([]);
  });
});
