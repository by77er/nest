# Discord bot

My bridge to agents: approvals, escalations, chat with any agent. It runs on a private server and accepts only my Discord user ID.

## Two halves

| Half | Runs | Handles | Works while no brain host is up? |
|---|---|---|---|
| **Interactions endpoint** | Worker (HTTP, Ed25519-verified requests) | Slash commands (`/send <agent> <msg>`, `/bridge <agent>`, `/status`, `/list`), buttons (Approve / Deny), modals (free-text answers) | **Yes** |
| **Gateway client** | A [brain host](../../../compute/brain-hosts/): a small Rust process, a singleton FleetDO places on one brain host and places again when that host goes | Free-form messages in bridged threads (`MESSAGE_CREATE`; needs the Message Content intent, which a private bot can simply enable) | No |

The Worker answers an interaction within Discord's 3-second window by deferring, then follows up using the interaction token (valid for 15 minutes).

## Mapping

- **Bridges:** a Discord thread can be bridged to an agent (`/bridge <agent>`). What I type there goes to its inbox as a message from `user` and wakes it. What it says comes back through agent events delivered to its owner (kernel, not built: [principle 9](../../../README.md#principles)); the control plane posts through the REST API and batches to stay under rate limits.
- **Approvals** (an agent's open asks, `GET /v1/agents/<id>/asks`) become messages with buttons. Each button's `custom_id` carries the ask's reference; my click or modal answer is the ask's answer.
- **Mentions:** an approval @-mentions me; anything else posts silently.
- **What gets bridged is up to me** (`/bridge`); an agent can ask me to bridge it, e.g. a captain.
