# Object store (S3, per cell)

- **Standard** for older generations; **Express One Zone** (single-AZ, low latency) for hot generations, in the same AZ as the burst hosts. Express, after its April 2025 price cut ([AWS](https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/)): $0.00113 per 1k PUTs, $0.00003 per 1k GETs, $0.0032/GB uploaded, $0.0006/GB retrieved, $0.11/GB-month stored. Its per-GB charges make it the hot tier only.
- **Access** comes from the host instance role. A gateway endpoint lets the bucket policy require `aws:SourceVpce`.
- **Built:** nestd's `S3Store` (`storage: {type: "s3"}`) keeps chunks and manifests under `store/chunks/<hex>` and `store/manifests/<hex>` in the cell's Standard bucket, SigV4-signed with the instance role's IMDSv2 credentials, behind a local write-through cache. Express One Zone, multipart uploads and the sweep aren't built.
- **Data transfer** between EC2 and S3 in the same region is free. Requests are still billed: about $0.005 per 1k PUTs and $0.0004 per 1k GETs.

| Operation | Requests | Cost |
|---|---|---|
| Resume prefetching 400 MB | ~200 GETs | ~$0.0001 |
| Full hydration of 4 GB | ~2k GETs | ~$0.001 |
| A busy sandbox writing back every minute, 8 h/day | ~290k PUTs/mo | ~$1.50/mo |

- **Chunk size is the main cost lever.** Never go below MB-sized chunks.
- **Portability:** code against the S3 API with a configurable endpoint per cell. A generation is pinned to its cell; moving it to another cell is an explicit copy.

## Garbage collection

Mark and sweep. It runs on a burst host, because the control plane holds no S3 credentials.

- **Roots:** every `ready` generation a SandboxDO retains (heads, the [retained chain](../#retention), generations pinned by an in-flight resume, fork or restore, orphaned sibling heads until they expire), plus FleetDO's [base generations](../memory/#base-generations). A checkpoint's memory is a root only while it's a [restore source](../#restore-sources); a `deleting` generation is never one.
- **Mark** from the roots' manifests. Manifests are shared by forks, so they're swept like chunks, never deleted with a generation.
- **Sweep** using **S3 Inventory**, not LIST (LIST is billed at the PUT rate). An unmarked object goes once it's older than a **24 h grace**, and a pass deletes only within 12 h of its mark.
- **Age counts from the last upload, not the first.** A commit reuses an existing chunk only if it was uploaded under 12 h ago, and uploads it again otherwise ([verified before commit](../#generations)), so every chunk a new generation needs is inside the grace. This is also the reaper for generations stuck uploading: one that never commits loses its chunks 24 h after their last upload attempt, not 24 h after it was cut.
- **Deletes are exact:** the sweep deletes only the object version it judged, by version id in versioned Standard buckets, and with `x-amz-if-match-last-modified-time` in Express One Zone, the only bucket type that supports it ([DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)). A re-upload that races the sweep survives. A lifecycle rule expires noncurrent versions after a day.
- **Generations are deleted through SandboxDO:** it marks one `deleting` before a sweep can take its bytes, never reverses that, and never deletes a restore source. Its single writer serializes this with fork admission and sandbox destruction.
- **Dry run first:** a cell's first sweep, and the first after any change to marking, only reports what it would delete. Every pass deletes at most a capped number of objects.
- **Incomplete multipart uploads** are aborted by a lifecycle rule.
