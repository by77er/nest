# A review waits for room in nest (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for the projects app ([the review pipeline](../../projects/README.md#built-the-review-pipeline)).

**Not a one-way deploy, and no ordering constraint.** No nest change. ReviewDO gains a migration step (`capacity_ms` on `jobs`) and its job table an event, `wait` (running → queued).
- **Jobs failed before this release** for capacity stay failed, their checks `action_required`: a `check_run` `rerequested` (GitHub's Re-run) or a new push queues them as before.
- **What a rollback does:** the previous release fails a job nest refuses for capacity, as before. A job waiting for room when it rolls back is an ordinary queued job with its check run: it starts from the queue, and the column is unread. Redeploying this release picks it up as it was.
