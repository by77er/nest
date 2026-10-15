# HookDO

The authority for one [webhook](../../../channels/sources/): its config, counters and recent delivery ids.

- **Receive:** the Worker routes `POST /v1/hooks/<hk_…>` here.
  1. Check size and rate limits.
  2. Ask BrokerDO to verify the signature (`verify(hook:<hk_…>, scheme, headers, body)`). The secret never leaves BrokerDO.
  3. Apply the filter and the mapping.
  4. Post to the target channel with the delivery id as idempotency key, `from: hook:<hk_…>` and taint set.
  5. Answer 2xx once the post is durable.
- **Authority:** posting checks that the hook's creator still holds `post` on the channel (the [grant chain](../../../agents/tools/#grants)). A revoked or parked hook answers 410, and providers stop retrying.
- **Counters** (received, rejected, filtered, rate-limited) go to the hook's own `events`, batched.
- **Cost:** an idle hook holds no socket and no alarm.

**Not built.**
