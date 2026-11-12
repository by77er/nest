## No drift: docs/interfaces/control-host/models/README.md
IDs (crates/nest-protocol/src/model.rs:7-34, control-plane/src/protocol/model.ts:7-21); enums vs protocol/fixtures/enums.json (SandboxState, AgentState, CommitReason, EgressAlertReason, HostRole, PolicyLayer); EgressPolicy/AllowRule/RequestGuard/RequestMatch/InjectionBinding/InjectionSecret fields (model.rs:310-472); AgentEvent/SandboxEvent (model.rs:551-625); GenerationRecord (model.rs:704-718); error codes == codes.json; legacy `unsupported_protocol_version` (model.rs:138,179; model.ts:72); HandsBinding: AgentDO sends `{sandbox}` only (control-plane/src/do/agent.ts:1106).
## Suspected code bugs / stale code comments
- crates/nest-protocol/src/control.rs:431-434 doc comment says the control plane "still sends a copy" of the epoch in HandsBinding; AgentDO sends `{sandbox}` only (control-plane/src/do/agent.ts:1106). Comment drift, not docs/.
STATUS: DONE
