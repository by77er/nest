# Discord bot

My channel to captains: approvals, escalations, chat. It runs on a private server and accepts only my Discord user ID.

## Two halves

| Half | Runs | Handles | Works if the controller host is down? |
|---|---|---|---|
| **Interactions endpoint** | Worker (HTTP, Ed25519-verified requests) | Slash commands (`/captain <name> <msg>`, `/status`, `/workstreams`), buttons (Approve / Deny), modals (free-text answers) | **Yes** |
| **Gateway client** | [Controller host](../../../compute/controller/) (small Rust process) | Free-form messages in threads (`MESSAGE_CREATE`; needs the Message Content intent, which a private bot can simply enable) | No |

The Worker answers an interaction within Discord's 3-second window by deferring, then follows up using the interaction token (valid for 15 minutes).

## Mapping

- **One channel per captain, one thread per workstream.** The control plane posts through the REST API and batches notifications to stay under rate limits.
- **`ask()` and approval requests** become messages with buttons. Each button's `custom_id` carries an opaque request ID. My answer goes to the AgentDO inbox and arrives as the next turn's input.
- **A message I type** in a captain channel or a workstream thread goes to that captain's inbox and wakes it.
- **`notify_user(msg, urgency)`:** urgency decides whether the message @-mentions me or just posts silently.
