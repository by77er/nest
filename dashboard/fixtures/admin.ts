// Recorded responses of the control plane's two read routes, held to the control plane's view
// types (src/api.ts re-exports them): `npm run typecheck` fails when a field is missing, extra or of
// another type.
// Recorded once from the control plane's test pool (a throwaway vitest case in control-plane/test
// against FleetDO: one connected burst host with a running sandbox, an agent and a launch, then
// GET /v1/admin/fleet and GET /v1/admin/images); re-record when fleetView or images change.
import type { Fleet, Images } from "../src/api";

export const fleet = {
  "hosts": [
    {
      "host": "hst_01m5pv156anzgr2gqs5stpewgt",
      "role": "burst",
      "instance_id": "i-0f1e2d3c4b5a69788",
      "status": "active",
      "idle_since": null,
      "enrolled_ms": 1792841651402,
      "last_rx": 1792841651414,
      "tunnel_hostname": null,
      "tunnel_state": "none",
      "capacity": {
        "vcpus_free": 8,
        "memory_mib_free": 16384,
        "hugepages_mib_free": 8192,
        "hugepages_mib_total": 8192,
        "sandboxes": 0,
        "agents": 0,
        "warm": []
      },
      "leases": 1,
      "connected": true,
      "sandboxes": [
        {
          "sandbox": "sbx_01m5pv15859msjvnej5q24jmkm",
          "epoch": 1,
          "state": "running",
          "vcpus": 2,
          "memory_mib": 4096
        }
      ],
      "agents": [
        "agt_01jbx8k2m9qv3t7w5y4n6p0r1s"
      ]
    }
  ],
  "launches": [
    {
      "instance_id": "i-0f1e2d3c4b5a69788",
      "launched_ms": 1792841591472,
      "host": "hst_01m5pv156anzgr2gqs5stpewgt",
      "reason": null,
      "ended_ms": null
    }
  ],
  "sandboxes": [
    {
      "sandbox": "sbx_01m5pv15859msjvnej5q24jmkm",
      "registered_ms": 1792841651465,
      "host": "hst_01m5pv156anzgr2gqs5stpewgt",
      "epoch": 1,
      "lease_state": "running",
      "sandbox_state": "running",
      "image": "nest-base:latest",
      "workstream": "ws_01m5pv1581hvrmhfbravczqzf3",
      "info_error": false
    }
  ]
} satisfies Fleet;

export const images = {
  "current": "ami-0a1b2c3d4e5f60718",
  "current_since_ms": 1761213600000,
  "images": [
    {
      "image_id": "ami-0a1b2c3d4e5f60718",
      "name": "nest-use1-host-2026-10-23",
      "created": "2026-10-23T10:00:00.000Z",
      "state": "available",
      "size_gib": 30,
      "tags": {
        "nest": "true"
      }
    }
  ],
  "templates": [
    {
      "name": "nest-base:latest",
      "default": true,
      "source": "release (nest-base.ext4.zst)",
      "in_use": 1
    }
  ]
} satisfies Images;
