# Revoke routes (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table or host change: two admin routes (`DELETE /v1/admin/secrets/<name>`, `DELETE /v1/admin/capabilities/<name>/oauth`) and two BrokerDO methods. Mid-deploy, a BrokerDO of the previous release lacks the methods and the routes answer 503 (`newMethod`). A `wrangler rollback` removes the routes; what they deleted stays deleted.
