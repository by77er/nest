# nestd doc audit (docs/compute/nestd/README.md)

## Corrections
| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| docs/compute/nestd/README.md:5 | sandbox host refuses the process driver / unjailed Firecracker unless `unconfined_driver` | also allowed when enrollment is `static` (tests) | crates/nestd/src/config.rs:332-335 |
| docs/compute/nestd/README.md:6 | nestd installs the root-namespace rule rejecting nest-proxy's non-public egress (stated as built) | no such rule anywhere: no `skuid`/root-ns output rule in crates/ or deploy/; marked designed, not built | grep `skuid\|169.254.0.0/16\|root namespace` over crates/ deploy/ (only nest-proxy/src/http.rs:901, the proxy's own check) |

## Parent summary lines to update

## Unconfirmed claims

## Suspected code bugs
- docs/compute/nestd/README.md:11 — "nest-proxy ... run unprivileged": nest-proxy.service has no User= and nest-proxy drops no privileges (known from parent; text left).
- docs/compute/nestd/README.md:11 — "the agent runner run[s] unprivileged": nest-runner.service has no User= (Environment=HOME=/root, deploy/host/install.sh:190-215), so the runner runs as root. The gateway runs as nest-gw only when nestd reports the `gateway-user` feature; otherwise as root with CAP_DAC_OVERRIDE (install.sh:65-72). Text left.

## Drift outside the area
- docs/sandbox/networking/egress/steering/README.md:34-40 ("Kernel backstop") describes nestd's root-namespace nft `meta skuid` reject rule as fact; no code installs it (not built). Should be marked designed, not built.

## Docs with no drift
