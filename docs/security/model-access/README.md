# Model access

**The platform's only model traffic comes from unmodified Claude Code processes on hosts, using my subscription.** Apps in sandboxes that call LLM APIs bring their own keys; that isn't a platform concern.

**Anthropic's terms:**
- **Allowed:** signing in to the **unmodified** Claude Code binary with my own subscription, including where a platform hosts Claude Code. Provisioning my own *API keys* for my own use is also explicitly allowed. We don't use that today.
- **Not allowed:**
  - using subscription OAuth tokens in other products or tools, or routing requests through them
  - third parties collecting, storing or intermediating Claude.ai credentials

  Anthropic has enforced this server-side since early 2026.

**How nest complies:**
- One OAuth token from `setup-token`, used only by unmodified Claude Code.
- Only documented flags.
- **No proxy decrypts, injects or rewrites OAuth traffic.**
- The token never enters a VM.
- Usage stays within ordinary personal use; the [scheduler](../../orchestration/scheduling/) caps concurrency.

**Platform-owned API usage:** only the future [api-loop captain backend](../../orchestration/captains/backends/api-loop/), with a key the control plane holds.

Sources: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [authentication](https://code.claude.com/docs/en/authentication)
