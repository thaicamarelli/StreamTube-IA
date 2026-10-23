---
libs:
  "@nestjs/bullmq":
    version: "latest (Nest 11-compatible; peer deps @nestjs/common ^10||^11, @nestjs/core ^10||^11)"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-23T22:06:18Z"
  "bullmq":
    version: "^6.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-23T22:06:18Z"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-23T22:06:18Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-23T22:06:18Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-23T18:55:47-03:00"
---

# phase-03-videos — Library References

## @nestjs/bullmq

Context7: `/nestjs/bull` (covers both the legacy `@nestjs/bull` and the current `@nestjs/bullmq` module — same package family, docs are shared).

**Queue registration** (API side — the producer):

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'video-processing',
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
})
export class VideosModule {}
```

**Worker/processor** (worker side — the consumer, per TD-01 + TD-04):

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing', { concurrency: 2 })
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ffprobe metadata extraction + ffmpeg thumbnail (TD-04), update status (TD-06)
  }
}
```

`@Processor` options support `configKey` to point at a named `forRoot`/`registerQueue` connection — relevant if the worker runs as a separate process/container sharing the same Redis connection config as the API.

## bullmq

Context7: `/taskforcesh/bullmq` (v6.3.11 docs snapshot).

**Retry/backoff** (feeds TD-06's failure-handling model — queue-level retry before the worker marks a video `error`):

```ts
import { Queue } from 'bullmq';

const queue = new Queue('video-processing');

await queue.add(
  'process-video',
  { videoId },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s between retries
  },
);
```

`backoff.jitter` (0–1) is available to randomize retry delay and avoid thundering-herd retries if multiple jobs fail simultaneously — worth considering if upload bursts are expected, not required for this phase's scope.

## @aws-sdk/client-s3

Context7: `/aws/aws-sdk-js-v3` (AWS SDK for JavaScript v3 monorepo — contains `@aws-sdk/client-s3`).

**MinIO-compatible client config** (per TD-02 — `forcePathStyle: true` is mandatory for MinIO, since MinIO is not subdomain-per-bucket like real S3):

```ts
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'http://minio:9000', // Docker Compose service name, per project convention
  region: 'us-east-1', // required by the SDK even though MinIO ignores it
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY!,
    secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  },
});
```

v2's `s3ForcePathStyle` was renamed to `forcePathStyle` in v3 — relevant since some older examples online still use the v2 name.

Multipart upload (per TD-03) uses three commands against this client: `CreateMultipartUploadCommand` → `UploadPartCommand` (one per part, each returns an `ETag`) → `CompleteMultipartUploadCommand` (submits the list of `{ETag, PartNumber}` for every part). Context7 did not return a direct code sample for this exact sequence in this fetch (only the `CompleteMultipartUpload` XML wire format was surfaced); the 3-command sequence itself is AWS's standard, stable multipart API shape and is well-documented in the AWS SDK v3 `@aws-sdk/client-s3` command reference — confirm exact method signatures against the installed version when implementing.

## @aws-sdk/s3-request-presigner

Context7: `/aws/aws-sdk-js-v3` (same monorepo, `packages/s3-request-presigner`).

**Presigned PUT** (per TD-03 — one presigned URL per multipart part):

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';

const command = new UploadPartCommand({
  Bucket: 'videos',
  Key: videoId,
  UploadId: uploadId,
  PartNumber: partNumber,
});
const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
```

**Presigned GET** (per TD-05 — streaming/download redirect, short TTL):

```ts
import { GetObjectCommand } from '@aws-sdk/client-s3';

const command = new GetObjectCommand({
  Bucket: 'videos',
  Key: videoId,
  ResponseContentDisposition: forDownload ? `attachment; filename="${title}.mp4"` : undefined,
});
const url = await getSignedUrl(s3, command, { expiresIn: 900 }); // ~15 min per TD-05
```

`expiresIn` defaults to 900 seconds (15 minutes) when omitted — this happens to match TD-05's decided TTL exactly, so passing it explicitly is for clarity, not a required override. `signableHeaders` / `unhoistableHeaders` exist to sign additional headers (e.g., `Content-Type`, checksum headers) into the presigned URL if stricter validation is needed later — not required for this phase's baseline flow.
