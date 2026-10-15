# Identity

**Bake trust into the image, not secrets.**

**The image contains** the guest agent, the `nest` CLI and the proxy's **CA certificate**. **No credentials.** Anything in an image is shared by every sandbox and fork, ends up in every S3 snapshot, and can't be revoked per sandbox.

## Sandbox identity

- **Implicit, from the vsock channel.** nestd creates each VM's vsock socket, so whatever arrives on it can only have come from that VM. nestd adds `(sandbox, epoch)` to everything.
- **Forks get a new identity automatically:** a new sandbox ID and a new epoch.
- Within a sandbox, `NEST_AGENT_ID` attributes calls to agents. It isn't a secret.

## Outbound credentials

Sandboxes only ever see **placeholders**. nest-proxy substitutes real credentials, and GitHub goes through a GitHub App. See [../../sandbox/networking/egress/injection/](../../sandbox/networking/egress/injection/).

## OIDC tokens (deferred)

`nest token --audience X` (through the guest agent and vsock) would return a short-lived JWT signed by the control plane. Its claims are sandbox, agent, labels and **epoch**, and the Worker would publish the public keys (JWKS). It's for services that verify identity themselves and issue their own short-lived credentials (AWS `AssumeRoleWithWebIdentity`, GCP, Vault). **Deferred** until an agent needs cloud deploy access. Placeholder injection covers token-based APIs.
