# A review waits for room in nest (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for the projects app ([the review pipeline](../../projects/README.md#built-the-review-pipeline)).

**Not a one-way deploy, and no ordering constraint.** No nest change. ReviewDO gains a migration step (`capacity_ms`, `room_waits`, `room_told_ms` on `jobs`) and its job table an event, `wait` (running → queued). ProjectDO gains two methods, `reviewWaitingForRoom` and `reviewRoomCleared` (one script with ReviewDO, so they deploy together).
- **Jobs failed before this release** for capacity stay failed, their checks `action_required`: a `check_run` `rerequested` (GitHub's Re-run) or a new push queues them as before.
- **What a rollback does:** the previous release fails a job nest refuses for capacity, as before. A job waiting for room when it rolls back is an ordinary queued job with its check run: it starts from the queue, and the columns are unread. Its check keeps reading "Waiting for room to start a reviewer" (still `in_progress`) until its verdict completes it: the previous release doesn't tell it "Reviewing" again. A long wait's project error stays until this release is redeployed and clears it, or until it's pruned (30 days). Redeploying this release picks it up as it was.
- **nest's capacity refusal, either release:** it reads nest#248's `at_capacity` (429, retryable) and, as the fallback for a nest from before #248, the 403 in ClientDO's words, so it deploys before or after #248 in either order. Drop the fallback a release after #248.
