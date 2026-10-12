# Security

**Threat model:** the adversary is **one of my own agents after a prompt injection**, not me. Injected instructions act through hands, which run inside a sandbox.

## Trust boundaries

| Boundary | Guarantee |
|---|---|
| Sandbox VM | Hard isolation (Firecracker; gVisor only in cells without KVM). **Holds no credentials,** only placeholders. Anything that needs isolation gets its own sandbox. |
| Agents within one sandbox | One shared trust domain. Grants give attribution only. |
| Brain (Claude Code process on a host) | Holds the subscription token in its process environment. It has no local exec or file tools, and repo config can't load. A prompt injection can only act through `nest` tools. |
| Hosts (nestd, proxy, runner) | Trusted, but fenced by lease and STONITH. No R2 credentials. |
| Control plane | Authoritative. No S3 credentials; EC2 permissions scoped. |

## Defense layers

- Credentials stay outside VMs: [identity/](identity/)
- Egress allowlist, credential injection, secret scan, no raw ssh: [../sandbox/networking/egress/](../sandbox/networking/egress/)
- The harness runs on the host, with a clean environment, restricted mode and managed settings: [../agents/runner/](../agents/runner/)
- Brokered actions, approval gates and grants: [../agents/tools/](../agents/tools/)
- Epoch fencing of side effects: [../sandbox/fencing/](../sandbox/fencing/)

## Components

- [model-access/](model-access/): Claude Code on my subscription, and the terms
- [identity/](identity/): sandbox identity, credential injection, OIDC tokens
- [credentials/](credentials/): an inventory of every credential and where it lives
