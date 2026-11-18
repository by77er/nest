# HostDrain (TLA+)

A model of a sandbox host's forced drain ([autoscaling](../../../docs/compute/autoscaling/), "Drain"): a spot notice or an operator's request, through to the instance ending. It has:
- one host and two sandboxes, each starting as a resident (running or suspended, as FleetDO last heard) or as a stale incarnation not yet salvaged;
- FleetDO's drain, its evictions, its stale-incarnation records and the retirement of an empty draining host;
- nestd's suspend commit, its fence of an incarnation whose lease was revoked, and the salvage;
- SandboxDO's wake and what it is told of an eviction;
- AWS taking the instance at the notice's deadline, and a clock.

`HostDrain.tla` maps each action to code in its header, and constants switch the code's guards and the fixes of 2026-11-18 off, or a fix shape on. Results, conformance and what it abstracts: [docs/verification/host-drain/](../../../docs/verification/host-drain/).

## Running

`verification/run.sh --only tla --spec host-drain`, or one config by hand:

```
java -XX:+UseParallelGC -Xmx3g -cp ../../.tools/tla2tools-1.7.4.jar tlc2.TLC -workers 4 \
  -metadir /var/tmp/tlc-host-drain -config MC_spot.cfg HostDrain.tla
```

Every config is in `expect.tsv` with its expected outcome; all are `ci` (the largest has about 116,000 distinct states).
