# No credential-shape detection (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No table, column, route or wire field. The brokered pipeline stops refusing arguments for credential shapes (GitHub, Anthropic, AWS, Slack and Stripe prefixes, PEM private keys), and the live trace stops redacting those shapes. The scan of stored secrets' exact values (now also matching the GitHub installation tokens nest minted and caches in `github_tokens`, which only the GitHub-token shape caught before), the trace's redaction of nest's own credentials, `Bearer`/`Basic` values and credential-named keys, and nest-proxy's masking of the values it injected all stay.

- **What a `wrangler rollback` does:** the previous release scans for the shapes again, and its trace redacts them again. Nothing this release wrote changes that. A call it refuses is journaled `refused` as before.
- **Journal rows from before:** a row refused for a shape keeps its detail (such as "a GitHub token"). A redelivery of that call key gets the same refusal, as for any refused row.
- **The cloud check `brokered_check.py`** now stores a random throwaway value as `http:brokered-check-scan` and expects the scan of stored values to refuse it. Run against a previous release, it still passes: that release scans stored values too.
- **No shim to drop.**
