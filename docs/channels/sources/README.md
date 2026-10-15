# External event sources

**Everything from outside becomes a post on a channel.** A webhook, an email or a Discord message is verified at the edge, turned into a [channel](../) message, and delivered to whoever subscribes. Agents never get a separate trigger mechanism: they subscribe to the channel, so batching, loop guards, taint, wake envelopes and scale-to-zero waking all apply unchanged.

```
GitHub / Stripe / any sender ── POST /v1/hooks/<hk_…> ──► Worker: verify, map, dedup
                                                              └─► ChannelDO: post (from: hook:<hk_…>, tainted)
                                                                     └─► subscribed agents wake (brain starts if idle)
```

## Webhooks

A **hook** is a resource (`hk_…`, with an owner and labels) that receives HTTP posts and turns each one into a message on its target channel.

```yaml
hook: hk_01…
channel: ws/auth/ci
verify: github{secret: hook:hk_01…}     # or stripe{…}, hmac{header, algo, secret}, token{secret}
filter: {kinds: [github.push, github.pull_request, github.check_suite]}
map:    {kind: "github.{header:X-GitHub-Event}", key?: …, text: "{repository.full_name}: {action}"}
dedup:  {header: X-GitHub-Delivery}
```

- **Verified, always:** each hook names a scheme (GitHub's `X-Hub-Signature-256`, Stripe's signed timestamp, a generic HMAC, or a secret token for senders that can't sign). There's no unverified mode. The secret lives in BrokerDO as `hook:<hk_…>`.
- **Replay-safe:** the provider's delivery id becomes the post's idempotency key, and signed timestamps outside a 5-minute window are rejected. A provider's retries land once.
- **Fast acknowledgement:** the Worker answers 2xx once the post is durable in the ChannelDO, which is well inside providers' timeouts. Anything slower (an agent's turn) happens after.
- **Mapped, not interpreted:** `kind`, `text` and `key` come from headers and payload fields through a small template, and the full payload goes in `data` (or R2, past 32 KB). The platform never makes sense of a payload; agents do.
- **Bounded:** a body limit (1 MB), a rate limit per hook, and a filter that drops event kinds nobody wants before they're stored. Drops are counted on the hook's own `events`.
- **Untrusted:** every hook message has `from: hook:<hk_…>` and is **tainted**, since anyone who can trigger the sender (open a PR, file an issue) controls its content.
- **Authority flows from the creator:** a hook can post to its channel only while its creator holds `post` there, so revoking the creator's grant silences the hook. Hooks of a removed owner are parked with the rest of what it owned.

## Creating and wiring hooks

- **The `hooks` [capability](../../agents/capabilities/)** gives `hook_create(channel, verify, filter?, map?)`, which returns the hook's URL, plus `hook_delete` and `list`. **The secret is never shown to an agent.**
- **Wiring a provider:**
  - **Through a brokered action:** e.g. `github.create_webhook(repo, hook)`. BrokerDO sends the secret straight to GitHub, so no transcript ever contains it.
  - **By me:** I create the hook through the API or Discord, and the secret is shown to me once to paste into the provider.
- **URL:** `https://<control plane>/v1/hooks/<hk_…>`. The id isn't a credential; the verification is.

## Other sources

| Source | Path to a channel | `from` |
|---|---|---|
| **Email** | Cloudflare Email Routing → Email Worker → a hook-like address (`<hk_…>@<domain>`) whose config names the channel and allowed senders. SPF/DKIM results go in `data`; the body goes to R2 past 32 KB. | `hook:<hk_…>` (tainted) |
| **Discord** | The [Discord bridge](../../control-plane/api/discord/): messages in bridged threads | `user` when it's me |
| **Scheduled wakes** | Not a source: an agent schedules its own with [`wake_at`](../../agents/capabilities/#schedules) | — |
| **Polling** (feeds, prices, pages) | Not a source: a monitor agent polls with `wake_at` plus an `api` or `web` capability, and posts what changed | the monitor |

**Why polling isn't a platform source:** what's worth noticing in a feed or a page is a judgment, and judgments belong to agents. The platform takes only what needs an endpoint it hosts: pushes.

**Implementation:** the hook route is a Worker path in front of ChannelDO, and hook configs live in a `HookDO` per hook. Not built.
