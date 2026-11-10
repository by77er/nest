# A client's start credential (2026-11-06)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table or host change. `BrokerDO.credentialRef` takes an optional second argument, and AgentDO records an optional `start_error`. In a mixed window, a BrokerDO of the previous release ignores the argument and may fall back, but a new AgentDO refuses any reference except the spec's own for a client's agent. A new BrokerDO called without the argument (an old AgentDO) decides as before, for the operator. A `wrangler rollback` brings the fallback back (the bug) until this release is redeployed; the `start_error` it leaves on a record is ignored.
