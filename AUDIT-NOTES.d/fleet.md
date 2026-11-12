## Corrections
| docs/interfaces/control-host/fleet/README.md (`guest_cli` row) | nestd gives up after 30 s | nestd waits 27 s (`CLI_RELAY_TIMEOUT_S`); the guest gives up at 30 s | crates/nestd/src/host.rs:66-68, crates/nest-guest/src/cli.rs:66 |
| docs/interfaces/control-host/README.md (Batching) | FleetDO batches `commands` the same way (1–2 s / 100) | each `issueCommands` call is one `commands` batch, flushed at once; no timer or size trigger | control-plane/src/do/fleet.ts:1611,1638-1640,934-945 |
## No drift
Fleet message tables vs crates/nest-protocol/src/control.rs (HostHello :140-174) and fixtures protocol/fixtures/control/{host_to_fleet,fleet_to_host,command,host_event}; lease 5/20/30 s (control-plane/src/protocol/control.ts:13-15); FLUSH_AT_EVENTS 100 (crates/nestd-core/src/fleet.rs:118), flush default 1 s (crates/nestd/src/config.rs:418); AgentExitReason (control.rs:625, enums.json); HostHeaderMode (control.rs:402). Routes: GET /v1/fleet host, GET /v1/agents/:agent/session host, POST /v1/hosts/gc/{claim,report} host, GET /v1/blobs/*key none (control-plane/src/index.ts:599-620).
STATUS: DONE
