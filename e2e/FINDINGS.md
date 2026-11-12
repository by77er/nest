# Findings from the e2e harness

All earlier findings are fixed: the admin policy API, the readable deny inside the CONNECT tunnel, the hands doc on env persistence, the double fence, the missing-cwd warning, and the stale READMEs.

## Open

1. **Info: the process driver can only exercise the explicit-proxy path.** The guest isn't behind tap0, so transparent interception and the nft tap0 rules are covered only by nestd's unit and integration tests (`netns_redirect_reaches_listener`), not by this harness.

## Notes

- A raw-socket `CONNECT` that never starts TLS hangs until the proxy's 10 s ClientHello timeout. This is expected: a denied or allowed CONNECT is accepted, and the readable 403 is served inside the TLS tunnel. That was the cause of the earlier "exit code 124" in this harness; it isn't a proxy bug.
- `wrangler dev`'s proxy forwards to the worker on pooled keep-alive connections, and the worker's runtime closes one idle for 5 s (measured: both sides drop it at 5.0 s). A request sent on one the worker is closing is lost before the worker reads it. The proxy resends only a GET or HEAD itself; any other method comes back as a text `500 Error: Network connection lost.` from miniflare, which the Worker never answers (its errors are JSON). A busy runtime widens the window: stalling the worker's runtime for 1 s across the 5 s mark loses the request every time. It failed the MCP scenario's stop right after the control-plane restart, about 5 s after the health check. The harness's `api` resends such a request at most twice, logging each; it changes nothing on Cloudflare, where there is no dev proxy.
