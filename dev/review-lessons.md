# Review lessons

Short, standalone lessons from real findings in this repo. The reviewer agent checks each change against them; a finding that recurs gets added here. Each lesson says what to look for and why.

1. **A test that can't fail isn't a test.** Look for early `return`s on missing tools, `--exact` filters that may match nothing, and catch-alls that log and pass. Skips print a marker and fail in CI; re-executed tests acknowledge that they ran.
2. **A deadline set from inside its own handler must survive the handler's cleanup.** A "keep the earlier deadline" rule plus "delete after running" swallowed a re-arm made during the run. Test re-arming from within the handler.
3. **Waits in tests must outlast the timers they depend on.** A 30 s wait raced a 30 s idle flush. State the timer the wait covers, and add margin.
4. **Anything a restart reads must be durable before the restart.** `--resume` was built from flushed bytes only, so a brain restarted right after a turn lost the tail. Flush before start, and test resume with unflushed bytes.
5. **Match the real tool's encoding, not a guess.** Claude Code's transcript directory rule (non-alphanumerics to `-`, a hash suffix past 200 characters) was observed, then implemented with the observed samples as tests.
6. **Retries must not stop after the first failure.** A placement retry and a start retry each fired once and gave up silently. Every retry path has a test that fails twice.
7. **Advisories arrive in dependencies you didn't change.** Run `cargo deny check` before claiming a TLS or crypto change is safe; a patch release can carry the fix.
8. **A fake collaborator hides binding errors.** `this.fetchFn(...)` with the global `fetch` as the default threw "Illegal invocation" in the live Worker while every test, which injected a fake, passed. One test per injected global runs the default against the platform (`fetchMock`), not a fake.
