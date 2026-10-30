# Identity

**Bake trust into the image, not secrets.**

**The image contains** the guest agent, the `nest` CLI and the proxy's **CA certificate**. **No credentials.** Anything in an image is shared by every sandbox and fork, ends up in every S3 snapshot, and can't be revoked per sandbox.

## Sandbox identity

- **Implicit, from the vsock channel.** nestd creates each VM's vsock socket, so whatever arrives on it can only have come from that VM. nestd adds `(sandbox, epoch)` to everything.
- **Forks get a new identity automatically:** a new sandbox ID and a new epoch.
- Within a sandbox, `NEST_AGENT_ID` attributes calls to agents. It isn't a secret.

## Client identity at the gateway

A brain, a person's `nest` CLI or any other client reaches a sandbox only through its host's [gateway](../../sandbox/gateway/), and the gateway admits a connection only with a **binding**: a token SandboxDO's `resolve` mints for an attached client, naming the sandbox, its epoch, the client, a scope (`hands`, `pty` or `ingress`) and an expiry of about an hour. A client resolves again before it expires; `detach` and any epoch bump void it. The gateway verifies the signature with the cell's binding key and pins `(sandbox, epoch)` on every frame, and the guest checks the epoch again. In front of the gateway, the host's tunnel hostname sits behind a Cloudflare Access service token that the control plane and brain hosts hold and a sandbox never does. A brain's own fencing token is its **agent epoch**, issued by AgentDO at each start and carried by platform tool calls and brokered actions ([AgentDO](../../control-plane/durable-objects/agent/)).

## Outbound credentials

Sandboxes only ever see **placeholders**. nest-proxy substitutes real credentials, only on each binding's exact hosts (and methods and path prefix, when set), and GitHub goes through a GitHub App. See [../../sandbox/networking/egress/injection/](../../sandbox/networking/egress/injection/).

## OIDC tokens (deferred)

`nest token --audience X` (through the guest agent and vsock) would return a short-lived JWT signed by the control plane. Its claims are sandbox, agent, labels and **epoch**, and the Worker would publish the public keys (JWKS). It's for services that verify identity themselves and issue their own short-lived credentials (AWS `AssumeRoleWithWebIdentity`, GCP, Vault). **Deferred** until an agent needs cloud deploy access. Placeholder injection covers token-based APIs.
