# ClientDO

One instance per [API client](../../api/clients/), named by its id (`cli_…`), and one more, `directory`, for the names.

- **The record:** name, grant, the token's SHA-256 (the token itself is shown once, at create and rotate), created and rotated times. The Worker hashes a bearer token and ClientDO compares the hash in constant time. A deleted or unknown client answers 401.
- **The directory:** name → id, unique (`claimName` refuses a taken name, 409), and the list of clients. A create writes the record first and claims the name second, so a create that dies between them leaves an orphan record whose token was never handed out.
- **The subtree's registry** (`members`): each agent and sandbox in the client's subtree, with its cell, owner, labels and state (`reserved`, `live`, `ended`). It is what `max_agents` and `max_sandboxes` count and what the client lists (`GET /v1/agents`, `GET /v1/sandboxes`). It's an index: the records (AgentDO's `client`, SandboxDO's `client`) decide.
- **Counting:**
  - A create (`POST /v1/agents`, `POST /v1/sandboxes`, `agent_spawn` and the sandbox it makes) first calls `admit`. That checks the cell against the grant and the count against the maximum, and inserts the row as `reserved`, all in one synchronous step, so parallel creates can't pass the maximum.
  - A retry with the same id finds its row. A create that fails for good gives its place back (`release`).
  - The object then reports itself from its own alarm, retried until ClientDO answers: AgentDO from its `registry` deadline (live, then ended once its end is done), and SandboxDO from its `client` deadline (live, then destroyed, armed in the destroy decision's step). Ended is final.
  - A report for a row that isn't there (the reconcile dropped it) inserts the row, so the count never misses an object that exists.
- **Reconcile:** a row still `reserved` `RESERVE_CHECK_MS` (10 min) after `admit` is checked against its object. One that was never created goes; one that exists is counted as it stands. A failure to ask counts as live.
- **Recheck:** the hourly prune reads up to 100 live rows against their objects, least recently checked first, so an end or destroy whose report never came (a rollback ran meanwhile) frees its place.
- **Retention:** ended rows 7 days (hourly prune). The record lives until the client is deleted.
- **Delete:** `markDeleted` is refused (409) while any row is reserved or live. Otherwise no token works and nothing more is admitted. The Worker then deletes the catalog namespace and the name, and `purge` empties the object.
- **Events** ([events to the owner](../../api/clients/#events-to-the-owner)):
  - `kv` holds the webhook (`{url, secret, set_ms}`) and delivery's state (`{failures, dropped, last_error, failed_ms}`), so the retry schedule survives a restart.
  - `outbox` is the backlog, in arrival order, with the event's `id` unique: `enqueue` (an agent's or sandbox's hand-off) inserts in one synchronous step and never waits on a delivery, so a hand-off retried after a lost answer is stored once. Past 10,000 rows the oldest go, counted in `dropped`. Without a webhook nothing is kept.
  - The `deliver` deadline sends the oldest event, one request at a time, deleting it on a 2xx, up to 100 a run. The first failure (another status, a network error, or no answer within 10 s, `AbortSignal`) stops the run and arms the next one `1 s · 2^(failures-1)` later, at most 5 min; an `enqueue` doesn't advance a deadline that is waiting out its backoff.
  - The hourly prune arms `deliver` again for a backlog with no deadline (a rolled-back release has no handler for it).
- **Deploying it was one-way:** a new class ([deploy](../../../../dev/deploy.md)).
