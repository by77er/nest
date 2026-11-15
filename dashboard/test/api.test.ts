// The page's types are the admin view contract (protocol/admin/view.ts), which the control plane is
// typed by too, so the fields are checked by `npm run typecheck`, and the control plane checks that
// the view's enums equal its protocol's. The other half of the bargain, that the dashboard stays an
// independent Worker importing the contract as types only, is a module boundary
// (scripts/boundaries.toml). This test holds how the page reads the fleet response.
import { describe, expect, it } from "vitest";
import { fleet } from "../fixtures/admin";
import { normalizeFleet, type FleetResponse } from "../src/api";

describe("the fleet response", () => {
  it("passes the current shape through", () => {
    expect(normalizeFleet(fleet)).toEqual(fleet);
  });

  it("takes the previous release's shape for one release", () => {
    const old: FleetResponse = {
      hosts: [{ ...fleet.hosts[0]!, tunnel_state: null, role: "burst", max_brains: undefined }],
      launches: [],
      sandboxes: [
        { sandbox: "sbx_on", registered_ms: 1, host: "hst_a", epoch: 1, state: "running", image: "nest-base:latest", workstream: "ws_a" },
        { sandbox: "sbx_parked", registered_ms: 2, host: null, epoch: 3, state: "suspended", image: "nest-base:latest", workstream: "ws_a" },
        { sandbox: "sbx_unreadable", registered_ms: 3, host: null, epoch: null, state: null, image: null, workstream: null },
      ],
    };
    const v = normalizeFleet(old);
    expect(v.hosts[0]!.tunnel_state).toBe("none");
    expect(v.hosts[0]!).toMatchObject({ role: "sandbox", max_brains: null });
    expect(v.sandboxes).toEqual([
      { sandbox: "sbx_on", registered_ms: 1, host: "hst_a", epoch: 1, lease_state: "running", sandbox_state: null, image: "nest-base:latest", workstream: "ws_a", info_error: false },
      { sandbox: "sbx_parked", registered_ms: 2, host: null, epoch: 3, lease_state: null, sandbox_state: "suspended", image: "nest-base:latest", workstream: "ws_a", info_error: false },
      { sandbox: "sbx_unreadable", registered_ms: 3, host: null, epoch: null, lease_state: null, sandbox_state: null, image: null, workstream: null, info_error: true },
    ]);
  });
});
