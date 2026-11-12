# Security

**Threat model:** the adversary is **one of my own agents after a prompt injection**, not me. Injected instructions act through hands, which run inside a sandbox, and through platform tools, which are bounded by the agent's grants. Messages carry untrusted content between agents (inbox posts, transcripts, MCP tool results), and injections spread from agent to agent. Content from outside (a PR, an email, a web page) is attacker-reachable: anyone who can open a PR or send an email shapes it, so it's tainted, including when an app relays it into an inbox under its source's name (`from`). A compromised agent acts only where it holds grants, and what it sends another agent carries its taint. Model robustness lowers the odds but isn't a boundary; grants, taint and sinks are.

## Trust boundaries

| Boundary | Guarantee |
|---|---|
| Sandbox VM | Hard isolation (Firecracker; gVisor only in cells without KVM). **Holds no credentials,** only placeholders. Anything that needs isolation gets its own sandbox. |
| Agents within one sandbox | One shared trust domain. Grants give attribution only. |
| Brain (Claude Code process on a brain host) | Holds the subscription token in its process environment. It has no local exec or file tools, and repo config can't load. A prompt injection can only act through `nest` tools and the web built-ins (tainting; **not built:** a host allowlist for them, so they reach any host on port 443, the only port the brain hosts' security group opens). |
| Gateway (on each sandbox host) | The only way into a sandbox's hands, terminals and ports. Admits a connection only with a binding SandboxDO signed for that sandbox, epoch, client and scope, behind an Access service token at the edge; the guest checks the epoch again. |
| Sandbox hosts (nestd, proxy, gateway, cloudflared) | Trusted, but fenced by lease and STONITH. S3 for their whole cell through the instance role; no R2 credentials; no subscription token; no brain. nest-proxy can't reach IMDS or other non-public addresses (kernel rule on its uid). The gateway, which parses input from the internet, runs as its own user with no capabilities and no IP beyond loopback (so not IMDS); beyond what any local user reaches (loopback services, world-connectable unix sockets, world-readable files) it gets only nestd's gateway socket and the guests' vsock sockets ([gateway](../sandbox/gateway/)); cloudflared runs as its own user too. |
| Brain hosts (nestd, runner) | Trusted, but fenced by lease and the agent epoch. No KVM, no sandbox state; in S3 it may read the release (`releases/*`) only. |
| Control plane | Authoritative. No S3 credentials; AWS permissions scoped to EC2 and to KMS `Sign` with the proxy root key. Operator access is by scoped token (built: one admin token); an [API client](../control-plane/api/clients/) acts by its own token, only on its subtree and within its grant. |

## Defense layers

- Credentials stay outside VMs: [identity/](identity/)
- Egress allowlist, hard deny of non-public addresses (in the proxy and the kernel), request sanitizing, live policy re-checks, scoped credential injection, reflected-secret masking, no raw ssh: [../sandbox/networking/egress/](../sandbox/networking/egress/)
- Short-lived CA chain under a KMS root, since guests check no revocation: [../sandbox/networking/egress/tls/](../sandbox/networking/egress/tls/)
- Every credential issuance, push and refusal is audited by BrokerDO (not built): [../control-plane/durable-objects/broker/](../control-plane/durable-objects/broker/)
- The harness runs on brain hosts, with a clean environment, restricted mode and managed settings: [../agents/runner/](../agents/runner/)
- One door into every sandbox, with a signed binding per client and an edge check: [../sandbox/gateway/](../sandbox/gateway/)
- Grants, attenuated from me (an agent passes on only what it holds), taint tracking with approval on sinks, brokered actions and approval gates: [../agents/tools/](../agents/tools/)
- Epoch fencing of side effects: [../sandbox/fencing/](../sandbox/fencing/)

## Components

- [model-access/](model-access/): Claude Code on my subscription, and the terms
- [identity/](identity/): sandbox identity, client identity at the gateway, credential injection, OIDC tokens
- [credentials/](credentials/): an inventory of every credential and where it lives
