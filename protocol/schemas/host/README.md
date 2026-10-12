# Host-internal schemas

There are no hand-written JSON Schemas for host-internal messages, because every endpoint is Rust using `nest_protocol::host`. The fixtures in `protocol/fixtures/host/` are the contract. External formats (Claude Code hooks, MCP, stream-json) are documented in `docs/interfaces/host-internal/` and `protocol/claude-code/`.
