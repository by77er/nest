## No drift: docs/interfaces/gateway/README.md
Constants (crates/nest-protocol/src/gateway.rs:27-49,126-131,271-302; control-plane/src/protocol/gateway.ts:7-13,68); gateway timers 5 s bind, 256 pre-bind (crates/nest-gateway/src/server.rs:29-38); 501/404 (server.rs:240-242), 1011 (server.rs:198); runner budgets 30 s / 120 s (crates/nest-runner/src/hands.rs:58-59); 60 s refresh margin (crates/nest-hands-client/src/lib.rs:120); HandsTarget fields both sides (gateway.rs:55-80, gateway.ts:28-38); hands_resolved outcome (crates/nest-protocol/src/control.rs:858-900); POST /v1/sandboxes/:sandbox/resolve admin (control-plane/src/index.ts:834); Workers 32 MiB (fetched developers.cloudflare.com/workers/runtime-apis/websockets/: "32 MiB (33,554,432 bytes)").
## Unconfirmed
- gateway README:18 "under the 32 MiB a Worker or Durable Object accepts": the Cloudflare page states the limit for Workers only.
STATUS: DONE
