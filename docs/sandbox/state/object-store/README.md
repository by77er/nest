# Object store (S3, per cell)

- **Standard** for older generations; **Express One Zone** (single-AZ, low latency) for hot generations, in the same AZ as the burst hosts. Express, after its April 2025 price cut ([AWS](https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/)): $0.00113 per 1k PUTs, $0.00003 per 1k GETs, $0.0032/GB uploaded, $0.0006/GB retrieved, $0.11/GB-month stored. Its per-GB charges make it the hot tier only.
- **Access** comes from the host instance role. A gateway endpoint lets the bucket policy require `aws:SourceVpce`.
- **Data transfer** between EC2 and S3 in the same region is free. Requests are still billed: about $0.005 per 1k PUTs and $0.0004 per 1k GETs.

| Operation | Requests | Cost |
|---|---|---|
| Resume prefetching 400 MB | ~200 GETs | ~$0.0001 |
| Full hydration of 4 GB | ~2k GETs | ~$0.001 |
| A busy sandbox writing back every minute, 8 h/day | ~290k PUTs/mo | ~$1.50/mo |

- **Chunk size is the main cost lever.** Never go below MB-sized chunks.
- **GC:** mark from the manifests the DOs reference; sweep using **S3 Inventory**, not LIST (LIST is billed at the PUT rate). Allow a 24 h grace period. A lifecycle rule aborts incomplete multipart uploads.
- **Portability:** code against the S3 API with a configurable endpoint per cell. A generation is pinned to its cell; moving it to another cell is an explicit copy.
