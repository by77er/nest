## Corrections
| docs/interfaces/host-internal/nestd-runner/README.md (error codes) | `already_running`: a duplicate `agent_start` for a live brain | no code emits it; the same start again is a no-op (the doc's own rule) and a test asserts the code is never sent | grep finds it only in crates/nest-runner/tests/lifecycle.rs:270 |
## No drift
RunnerCommand/RunnerEvent/ExitReason (crates/nest-protocol/src/host.rs:400-513, protocol/fixtures/host/runner_*); timeouts 120/20/10 s (crates/nest-runner/src/agent.rs:59-61), exit grace 30 s (crates/nest-runner/src/config.rs:63), interrupt grace 10 s (config.rs:62), session_open_timeout 10 s (config.rs:66), cancel grace 5 s (crates/nest-runner/src/hands.rs:25), killed brain 60 s (crates/nestd/src/runner_link.rs:55); other runner-local codes found in crates/nest-runner/src.
STATUS: DONE
