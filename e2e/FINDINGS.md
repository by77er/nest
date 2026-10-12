# Findings from the e2e harness

All earlier findings are fixed: the admin policy API, the readable deny inside the CONNECT tunnel, the hands doc on env persistence, the double fence, the missing-cwd warning, and the stale READMEs.

## Open

1. **Info: the process driver can only exercise the explicit-proxy path.** The guest isn't behind tap0, so transparent interception and the nft tap0 rules are covered only by nestd's unit and integration tests (`netns_redirect_reaches_listener`), not by this harness.

## Notes

- A raw-socket `CONNECT` that never starts TLS hangs until the proxy's 10 s ClientHello timeout. This is expected: a denied or allowed CONNECT is accepted, and the readable 403 is served inside the TLS tunnel. That was the cause of the earlier "exit code 124" in this harness; it isn't a proxy bug.
