# Discord bot

My bridge to channels: approvals, escalations, chat with any agent. It runs on a private server and accepts only my Discord user ID.

## Two halves

| Half | Runs | Handles | Works if the controller host is down? |
|---|---|---|---|
| **Interactions endpoint** | Worker (HTTP, Ed25519-verified requests) | Slash commands (`/post <channel> <msg>`, `/bridge <channel>`, `/status`, `/list`), buttons (Approve / Deny), modals (free-text answers) | **Yes** |
| **Gateway client** | [Controller host](../../../compute/controller/) (small Rust process) | Free-form messages in bridged channels and threads (`MESSAGE_CREATE`; needs the Message Content intent, which a private bot can simply enable) | No |

The Worker answers an interaction within Discord's 3-second window by deferring, then follows up using the interaction token (valid for 15 minutes).

## Mapping

- **Bridges:** a Discord channel or thread can be bridged to a nest channel (`/bridge <channel>`). The `user` channel is always bridged. Posts in a bridged nest channel appear in Discord; the control plane posts through the REST API and batches to stay under rate limits.
- **A message I type** in a bridged Discord channel or thread becomes a post from `user`. Typed in an agent's inbox bridge, it wakes that agent.
- **Questions** (`kind: question`) become messages with buttons. Each button's `custom_id` carries an opaque message reference; my click or modal answer is posted as the reply.
- **Mentions:** a post that mentions me (`mentions: [user]`) or is a `question` @-mentions me; anything else posts silently.
- **What gets bridged is up to me** (`/bridge`); an agent can ask me to bridge a channel, e.g. a captain for each workstream channel.
