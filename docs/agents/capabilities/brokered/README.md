# Brokered actions

A capability's `brokered` source grants **actions the control plane runs for the agent**, with credentials no agent, brain host or sandbox ever holds: HTTP requests through an operator-defined profile. AgentDO runs the pipeline (`control-plane/src/lib/brokered.ts`, `do/agent.ts`); BrokerDO keeps the credentials ([BrokerDO](../../../control-plane/durable-objects/broker/)).

## Catalog

```yaml
capability: status-api
brokered:
  - {action: http.request, profile: status, base_url: https://api.example.com/v1, methods: [GET, POST], paths: [/incidents],
     auth: {secret: "http:status", header: authorization, scheme: Bearer}, trusted: false, idempotency_header: Idempotency-Key}
prompt: Read and open incidents on the status API (the operator approves a write from a tainted session).
```

- **Actions:** `http.request` only ([actions](#actions)).
- **A profile takes:** `profile` (a name), `base_url` (`https`, no credentials, query or fragment; loopback only with `ALLOW_LOOPBACK_BROKERED=1`), `methods`, optional `paths` (whole-segment prefixes, the [injection](../../../sandbox/networking/egress/injection/#scope) safe-path rules), `auth` (a BrokerDO secret `http:<name>` sent as `<header>: <scheme> <value>`; never `host`, framing, `cookie`, `accept` or `content-type`), `trusted`, `idempotency_header`, `when_tainted` (`approve`, the default, or `allow`) and `per_hour` (1–1000; default 60).
- **Spawn:** the expanded spec copies each entry (`AgentSpec.brokered`), defaults resolved. `overrides.tools` narrows them by tool name: a given list keeps only the actions it names.

## Actions

**Decided (2026-11-15): the kernel's brokered actions are generic; none names a service** ([principle 10](../../../README.md#principles), phase C2 of taking service integrations out of the kernel, [decisions](../../../README.md#settled-decisions)). `http.request` reaches any HTTP API through a profile the operator defines. An app that needs a service's actions (opening a pull request, commenting, forking) runs them itself with its own credentials, or gives its agents an [mcp capability](../mcp/) or a profile for that API. **Why:** a service's actions in the kernel are a use case in the kernel; a profile names no service.

- **Removed:** `github.comment`, `github.create_issue`, `github.create_pr`, `github.review_comment`, `github.fork` and the reserved `email.send` (with the operator's `github_user` token, which only `github.fork` used).
- **Stored entries naming one:** a catalog capability written before is read without those entries (CatalogDO drops them on read; the rest of the capability, its rules included, reads as before, and the row isn't rewritten). A stored spec's grants of one stay in the agent's record but are never shown (`GET /v1/agents/<id>`), listed or callable: the call is an unknown tool, and `brokered{action}` an unknown action. Writing a capability that names one is refused (400), naming the action. **Why not rewrite the rows:** a `wrangler rollback` then runs them again as before.
- **The journal stays readable:** rows of past calls of a removed action are listed by `GET /v1/agents/<id>/brokered` as they were written.

## Tools

**Decided (2026-10-31): one tool per granted action, plus the generic `brokered{action, args}`.** `tools_list` lists `http_request` when the spec grants a profile, with its own schema narrowed to the grants (the `profile` enum is the agent's profiles, each described with its base URL and methods). **Why:** the model gets a schema per action and sees what it may do; the name is the action's with `_` for `.`, because an API tool name matches `^[a-zA-Z0-9_-]{1,128}$`, with no `.` ([define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), read 2026-10-31; unverified for Claude Code's MCP names). `brokered` (a registry tool) reaches the same actions under the same checks, for a backend that wants one entry point. No mcp capability may make a name a brokered tool has (an mcp capability named `http` is refused), nor a removed action's tool (`github_comment`, …, `email_send`) while stored grants of that action may exist: a rollback would route the name to the action again, and rules written for it would match the new tool. The release after this one rewrites the stored rows and frees the names; the list goes the release after that.

## The pipeline

Per call, in AgentDO, in this order ([taint and sinks](../../tools/#taint-and-sinks)):

1. **Grant:** a grant of that action for the profile, its method and path. None: `forbidden`.
2. **Hourly cap:** per agent and action, counted from the journal (refused calls don't count): `rate_limited`, retryable, with when a slot frees.
3. **Stored-value scan:** every string in the arguments (keys too) is checked against every BrokerDO secret's exact value, its base64, any long string inside a JSON value and a PEM's body lines, and against the GitHub installation tokens nest minted and holds (`github_tokens`, until the kernel's GitHub code goes) (`BrokerDO.scanSecrets`, which answers names only). A hit is refused (`forbidden`, "the arguments contain a credential nest holds", never the value or which secret), journaled as `refused` with which secret matched and without the arguments, and never reaches the approval question. **Why before the gate:** the operator's question shows the arguments. So a third-party credential nest doesn't hold, such as one an agent got from a tool result, now reaches the approval question and the trace unredacted. **No credential shapes (decided 2026-11-12):** nothing looks for other services' token formats; the owner: "I don't think that the secret detectors are really something that we need specifically. It would probably be good to trace any of these outbound invocations and network accesses, but I wouldn't bake into any assumptions right now." A shape list names services the kernel shouldn't know (principle 10), and it catches only the shapes it lists.
4. **Sink gate:** the [one gate](../../tools/#taint-and-sinks) every sink uses. A profile is a sink unless its methods are only `GET` and `HEAD`.
5. **Run:** the epoch is checked and the journal row written `sending` in the same synchronous step as the request leaves.
6. **Journal:** the outcome, durable before the result goes back.

Each request an action sends (a retry included) is also an `outbound` event on the agent's live trace: the action, the host and path, the status or why there was none, sizes and duration, never the query, the credential or the body ([the live trace](../../../control-plane/api/#live-trace), 2026-11-12).

## Idempotency

- **Natural key:** a request is the call.
- **A lost answer** (timeout, network): retried once only for `GET`, `HEAD`, `PUT` or `DELETE`, or with the profile's `idempotency_header` (sent with the digest of the call key); otherwise `outcome_unknown`.
- **Redelivery:** a call key with a settled journal row gets its stored outcome. One still `sending` is sent again only when retryable, without the cap, scan or gate again (they passed); otherwise `outcome_unknown`.

## Results and taint

The status, `content-type`, `location` of a redirect (not followed: the credential never goes to another origin) and the body (up to 64 KiB), with the credential masked wherever the answer reflects it. The answer taints unless the profile is `trusted`.

## Journal

AgentDO's `brokered_journal`, one row per call key: action, target (the profile), natural key, arguments digest, the arguments (4 KiB; withheld for a refusal), `sending`, `done`, `failed`, `unknown` or `refused`, attempts, what it came to, the session's taint, created and settled times. Pruned after 7 days with the call ledger. The owner (the operator, or the API client of the agent's subtree) reads it with `GET /v1/agents/:agent/brokered?limit=&before=` (newest first, `limit` at most 500).

## Not built

The `api` source, a per-server or global cap (the cap is per agent), and an exact-value scan of mcp tool arguments (open; shape scanning is decided against, step 3).
