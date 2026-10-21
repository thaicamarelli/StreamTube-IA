---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-21
scope_description: "Backend video upload and processing: object storage, background job queue, upload-to-10GB strategy, worker-based metadata/thumbnail extraction, streaming/download delivery, and video processing status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module, the storage client, the queue producer (API side), the video worker (consumer side), and the new Compose infrastructure (object storage, queue broker, worker container).
- `next-frontend/` — not initialized, and video upload/playback UI is explicitly out of scope for this phase (deferred to Fase 05 — Página de Visualização do Vídeo). No open decision in this document.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` and `nestjs-project/CLAUDE.md` already model a dedicated "Message Queue" container between the API and the Video Worker, explicitly marked `TBD`. The API must enqueue a job when a video upload completes; a separate worker process must consume it to extract metadata and generate a thumbnail without blocking the HTTP request. No queue infrastructure exists yet in the stack — this decision also determines whether a new infra dependency (Redis) is introduced or the project stays on Postgres-only infra.

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Redis-backed queue with first-class retry/backoff, delayed jobs, and a dedicated `Processor` class consumed by a separate worker process. `@nestjs/bullmq` is NestJS's own official queue module (the older `@nestjs/bull` is in maintenance mode).
- **Pros:** Official NestJS integration, mature retry/backoff/dead-letter support directly usable for TD-06's failure handling, highest throughput, large ecosystem (Bull Board for observability), the de-facto standard for exactly this "transcode/thumbnail on upload" use case.
- **Cons:** Introduces a new infra dependency (Redis container) the project doesn't have today — one more service in `compose.yaml` and one more thing to operate.

### Option B: pg-boss (PostgreSQL-backed)
- Queue implemented entirely on top of Postgres using `SELECT ... FOR UPDATE SKIP LOCKED`, no extra infra — reuses the `db` service already in `compose.yaml`.
- **Pros:** Zero new infra, ACID guarantees tying job state to the same transaction as entity writes, simplest Compose footprint.
- **Cons:** Throughput ceiling is bounded by Postgres write performance (hundreds–low thousands of jobs/sec) — a non-issue at this project's scale, but it competes for I/O with the primary application database under load. Less mature retry/backoff ergonomics than BullMQ; no official NestJS wrapper (community-maintained integration only).

### Option C: RabbitMQ (via `amqplib` / `@golevelup/nestjs-rabbitmq`)
- General-purpose AMQP broker designed for service-to-service messaging and pub/sub, not specifically for job queues.
- **Pros:** Battle-tested broker, strong delivery guarantees, useful if the project later needs cross-service event fan-out.
- **Cons:** Over-engineered for a single producer → single consumer job queue; no built-in job-specific ergonomics (progress, repeatable jobs) that BullMQ/pg-boss provide out of the box; adds the heaviest new infra footprint of the three options.

**Recommendation:** **Option A (BullMQ + Redis)** — this is a single-producer/single-consumer background job (not a cross-service messaging need, ruling out C), and the project will clearly benefit from BullMQ's built-in retry/backoff for TD-06's processing-failure handling and its official `@nestjs/bullmq` integration. The one new Redis container is a small, well-understood addition (no config needed for this use case) compared to the risk of coupling queue throughput to the primary Postgres instance (Option B) for a workload — video processing jobs — that is expected to grow with the platform.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Object Storage Access & Bucket/Key Organization

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails), URL única por vídeo, sem conflito com outros vídeos

**Context:** The storage backend itself is not open — the project targets an S3-compatible API, running as MinIO locally in Docker. What is open is which client library to use and how buckets/keys are organized, which also determines how capability "URL única por vídeo, sem conflito com outros vídeos" is satisfied at the storage layer (the public-facing unique identifier is already resolved by the existing UUID-primary-key convention in `.claude/rules/nestjs-entities.md`; this TD only decides how that same UUID maps to object keys).

**Options:**

### Option A: Single bucket, UUID-prefixed keys (`videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`)
- One bucket (e.g. `streamtube`) holding both assets per video, grouped under the video's own UUID as the key prefix.
- **Pros:** Co-locates all of a video's assets for simple cleanup (delete-by-prefix when a video is removed), minimal bucket/IAM surface, collision-free by construction (UUID is already the entity's unique PK).
- **Cons:** Mixing asset types in one bucket makes per-type lifecycle policies (e.g., different retention/CDN caching rules for thumbnails vs. originals) slightly harder to express later — acceptable since no such policy exists yet.

### Option B: Two buckets by asset type (`videos`, `thumbnails`), both keyed by `{videoId}.<ext>`
- Separate buckets per asset type, each object still keyed by the video's UUID.
- **Pros:** Clean separation for future per-type policies (CDN cache headers, lifecycle rules, public-read ACLs on thumbnails only).
- **Cons:** Two buckets to provision/configure instead of one; deleting a video requires two delete calls instead of one prefix delete.

### Option C: Per-channel bucket (one bucket per channel)
- A new bucket is created per channel at channel-creation time.
- **Pros:** Strong per-tenant isolation.
- **Cons:** Buckets are not designed to scale to per-tenant cardinality (most S3-compatible deployments impose practical/soft limits on bucket counts); unnecessary operational complexity for a feature (multi-tenant isolation) nothing in the current scope requires.

**Recommendation:** **Option A (single bucket, UUID-prefixed keys)** — the project has no per-asset-type policy requirement yet, and co-locating a video's assets under its own UUID keeps deletion and key-collision avoidance trivial, reusing the identifier scheme the project already committed to for entities. Client library: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (AWS SDK v3) with `forcePathStyle: true` — the standard, actively maintained way to talk to MinIO as an S3-compatible endpoint from Node.js; MinIO's own JS SDK (`minio` package) was considered but rejected because it is MinIO-specific, while the AWS SDK keeps the code portable to real S3 in production without rewriting the storage client, per the project's own framing of MinIO as a local stand-in for S3.

**Decision:** B (Two buckets by asset type: `videos`, `thumbnails`) — chosen over the recommendation for the cleaner per-type separation. Deleting both assets for a video stays a single logical operation at the application layer (one service method firing both bucket deletes in parallel via `Promise.all`, keyed by the same video UUID in each bucket) — the two-bucket cost is bucket provisioning, not deletion complexity.

---

## TD-03: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` §4 explicitly warns the upload must not block the system and should tolerate connection failures. Passing a 10GB file through the NestJS API process (buffering or even streaming it through a single HTTP handler) ties up a request worker and memory for the full transfer duration — this is the "wrong path" the challenge explicitly warns against. The video entity's "pré-cadastro automático como rascunho" capability (TD-06) also depends on this TD: the draft row must be created at the moment the upload is *initiated*, before any bytes land in storage.

**Options:**

### Option A: Presigned multipart upload (API orchestrates, client uploads directly to storage)
- API creates the draft video row, calls `CreateMultipartUpload` on the storage client, and returns presigned per-part PUT URLs (via `@aws-sdk/s3-request-presigner`) to the caller; the caller uploads each part directly to MinIO/S3 and calls a `complete` endpoint that calls `CompleteMultipartUpload` and enqueues the processing job (TD-01).
- **Pros:** Zero video bytes ever pass through the NestJS process — matches the "no performance impact" requirement exactly. Native S3 protocol (required above S3's 5GB single-PUT limit, so it's the only standards-compliant path to 10GB). A failed part can be retried independently without re-uploading the whole file.
- **Cons:** More orchestration endpoints (initiate / per-part URL / complete) than a single upload call; true byte-level resume mid-part is not covered — only whole-part retry.

### Option B: Single presigned PUT URL
- One presigned PUT URL for the whole object.
- **Pros:** Simplest possible handshake (one URL, one request).
- **Cons:** AWS S3 enforces a 5GB cap on a single PUT — a 10GB file is simply impossible through this path on real S3. Relying on MinIO's more permissive local default would silently break portability to production S3, contradicting the project's own framing of MinIO as a drop-in S3 stand-in.

### Option C: tus resumable upload protocol (`@tus/server`)
- Open resumable-upload protocol with true byte-offset resume, implemented via a dedicated tus server component sitting in front of storage.
- **Pros:** Best-in-class resumability — survives a dropped connection mid-chunk, not just mid-part.
- **Cons:** Adds an entirely new server component/protocol to operate and secure, on top of the already-new storage/queue/worker infrastructure this phase introduces; no direct-to-S3-compatible-storage mode without extra glue, so it doesn't actually remove API-side involvement in the byte stream the way Option A does.

### Option D: Proxy upload through the NestJS API (streaming multipart body to storage)
- The client uploads to a NestJS endpoint, which streams the body on to storage.
- **Pros:** Single endpoint, conventional multipart form upload, easy to reason about.
- **Cons:** This is the exact anti-pattern the challenge calls out explicitly ("passar o arquivo inteiro pela API é o caminho errado") — a 10GB transfer still occupies an API request/connection end-to-end, defeating the "no performance impact" requirement regardless of whether the handler streams the bytes.

**Recommendation:** **Option A (presigned multipart upload)** — it is the only option that both reaches the 10GB target and keeps bytes off the API process entirely, and it is the native, portable S3 protocol (works unchanged against real AWS S3 later). Option C's extra resumability is a genuine but non-essential upgrade this phase does not require; it can be revisited later if partial-connection-failure resume becomes a hard product requirement. Depends on TD-02 (same storage client issues the presigned part URLs).

**Decision:** A (Presigned multipart upload)

---

## TD-04: Video Processing Tooling (Metadata Extraction & Thumbnail Generation)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker (consuming TD-01's queue) needs to extract duration/metadata from the uploaded video and generate a thumbnail from a frame. FFmpeg/ffprobe are the de-facto tools for this; the open question is how Node.js code invokes them.

**Options:**

### Option A: Native `child_process` + FFmpeg/ffprobe CLI binaries installed in the worker image
- The worker's Dockerfile installs `ffmpeg` (which bundles `ffprobe`) via the OS package manager; Node code spawns `ffprobe -print_format json -show_format -show_streams <file>` for metadata and `ffmpeg -ss <t> -i <file> -vframes 1 <out>.jpg` for the thumbnail, parsing stdout/JSON directly.
- **Pros:** No dependency on a wrapper library's maintenance status — talks to FFmpeg exactly as its own documentation describes; always compatible with whatever FFmpeg version is installed; full control over flags, timeouts, and process lifecycle.
- **Cons:** More boilerplate than a fluent wrapper (manual argument arrays, manual stdout parsing) — acceptable, isolated to one worker-side module.

### Option B: `fluent-ffmpeg`
- The traditionally popular Node.js fluent API wrapping FFmpeg CLI invocation.
- **Pros:** Familiar, chainable API; was for years the default recommendation for this exact use case.
- **Cons:** **Rejected** — the `fluent-ffmpeg` repository was archived in May 2025, is no longer maintained, and is reported to no longer work reliably with recent FFmpeg versions. Adopting it in a greenfield 2026 project would start the worker on an unmaintained dependency with no path to fixes.

### Option C: `ffmpeg.wasm`
- FFmpeg compiled to WebAssembly, runs without a native binary/OS install.
- **Pros:** Still actively maintained (unlike `fluent-ffmpeg`); portable across environments without an OS-level FFmpeg install.
- **Cons:** Primarily built and optimized for browser use; server-side Node usage is less common and comes with worse CPU-bound performance and weaker multi-threading than a native binary — a real cost for a background worker whose entire job is CPU-bound transcoding/frame-extraction work.

**Recommendation:** **Option A (native `child_process` + CLI binaries)** — the "obvious" choice (`fluent-ffmpeg`) is dead and actively unsafe to adopt in a new project; direct CLI invocation avoids that risk entirely, stays current with whatever FFmpeg version the worker image installs, and is a well-documented, standard pattern (`ffprobe -print_format json` is FFmpeg's own supported machine-readable interface). This also fully resolves both of this TD's capabilities together, since metadata extraction (`ffprobe`) and thumbnail generation (`ffmpeg -vframes 1`) are the same tool invoked two ways.

**Decision:** A (Native `child_process` + FFmpeg/ffprobe CLI binaries)

---

## TD-05: Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário

**Context:** Once a video is `ready` (TD-06), it must be playable via HTTP Range requests (206 Partial Content) without a full download, and separately downloadable. Both capabilities read the same stored object (TD-02); the open question is whether the NestJS API proxies the bytes itself or hands the client a way to talk to storage directly.

**Options:**

### Option A: NestJS Range-proxy (API streams bytes from storage to client)
- The API reads the object from storage with the client's `Range` header forwarded, and pipes the response back with `206 Partial Content` / `Content-Range`, using `StreamableFile` or a manual stream pipe.
- **Pros:** Every byte served passes through the API, so authorization (e.g., future unlisted/private visibility rules from Fase 04) can be enforced per request with no extra moving parts.
- **Cons:** All playback and download bandwidth flows through the API process — exactly the kind of load the project's "sem impacto na performance" concern was written to avoid, just on the read path instead of the write path.

### Option B: Presigned GET redirect (302 to a time-limited presigned URL)
- The endpoint validates the request, then issues `302` to a short-lived presigned GET URL; the client's browser/video element follows the redirect and talks to storage directly, which natively supports `Range` requests and 206 responses on its own.
- **Pros:** Bandwidth is fully offloaded to the storage layer (and a CDN later, with no code change); Range/206 support comes for free from the S3-compatible API; the API's involvement is a cheap authorization check, not a data-transfer bottleneck.
- **Cons:** The real video URL is temporarily exposed (mitigated by short expiry on the presigned URL); a redirect adds one extra round trip before playback starts.

### Option C: Hybrid — API proxies metadata/authorization, returns a presigned URL in the JSON response for the client to fetch directly
- Similar to B, but the presigned URL is returned in a JSON payload instead of a redirect, letting the caller decide how to use it (e.g., feed directly into a `<video>` tag's `src`).
- **Pros:** Same bandwidth-offloading benefit as B, without relying on redirect semantics (useful if a future player needs the URL for more than one request, e.g. adaptive players).
- **Cons:** Slightly more contract surface (a JSON envelope instead of a bare redirect) for a phase with no frontend consumer yet to validate the shape against.

**Recommendation:** **Option B (presigned GET redirect)** — it satisfies "streaming without full download" for free (S3-compatible storage already implements Range/206 correctly) and keeps the API off the bandwidth-heavy read path, consistent with the same performance concern that drove TD-03's upload decision. The authorization check (today: none beyond the video existing and being `ready`; later: Fase 04's visibility rules) happens before the redirect is issued, so moving the bytes off-API does not weaken access control. Download reuses the same mechanism with `response-content-disposition=attachment` set on the presigned URL instead of `inline`.

**Decision:** B (Presigned GET redirect) — with a short TTL (~15 minutes) on the presigned URL and client-side reissue on expiry (the player requests a fresh redirect when a long video outlives the current URL's validity). Exposure risk is bounded by this TTL and, in this phase, moot in practice: there is no access-control rule yet for the redirect to bypass (anonymous viewing is a first-class platform feature per `docs/project-plan.md`; visibility rules only arrive in Fase 04). Revisit Option A (full API proxy) if Fase 04 introduces confidentiality needs stricter than "unlisted".

---

## TD-06: Video Processing Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload, Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** A video row must exist as a draft the moment upload begins (TD-03), move through processing (TD-01/TD-04), and land on a terminal state. The project's own `docs/project-plan.md` doesn't prescribe the exact states; the challenge brief explicitly calls this decision out, including what happens when processing fails.

**Options:**

### Option A: Simple status enum (`draft → processing → ready | error`) + queue-level retry/backoff
- A `status` column on the `videos` entity transitions: API sets `draft` when the upload is initiated (TD-03) and `processing` when the upload completes and the job is enqueued; the worker sets `ready` on success or `error` (with an `error_reason` column) once the queue's built-in retry/backoff (BullMQ `attempts` + `backoff`, per TD-01) is exhausted.
- **Pros:** Simplest model that still satisfies both capabilities; queryable directly from the `videos` table (list a channel's drafts/processing/ready/error videos with one `WHERE status = ...`); retry logic is delegated to infrastructure already chosen in TD-01 instead of being reinvented.
- **Cons:** No historical record of *why* a retry happened or how many attempts preceded a terminal `error` — acceptable, since nothing in this phase's scope needs that audit trail.

### Option B: Status enum + a separate processing-events audit table
- Same enum as A, plus a `video_processing_events` table logging every status transition and worker attempt.
- **Pros:** Full observability/audit history per video.
- **Cons:** Introduces a second table and write path for a capability the phase doesn't ask for (no "processing history" UI or requirement exists anywhere in `docs/project-plan.md` for Fase 03 or its immediate successors) — speculative scope beyond what's needed now.

### Option C: Status derived from live queue job state (no persisted status column)
- The video's "status" is computed on read by querying BullMQ for the job's current state instead of persisting it on the entity.
- **Pros:** No risk of the persisted status drifting from the real job state.
- **Cons:** Breaks the DB-as-source-of-truth pattern the rest of the project follows; listing videos by status would require querying the queue for every row instead of a single indexed SQL filter; job records are not meant to be a durable, queryable history (BullMQ jobs are typically cleaned up after completion).

**Recommendation:** **Option A (simple enum + queue-level retry/backoff)** — it is the minimal model that satisfies both the draft pre-registration and the processing/failure capabilities, keeps the `videos` table as the single source of truth for status queries, and reuses TD-01's queue retry mechanism instead of building a parallel one. Option B's audit trail is a reasonable future addition but is not required by anything in scope today.

**Decision:** B (Status enum + `video_processing_events` audit table) — chosen over the recommendation for observability into processing attempts/failures from the start.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | Object Storage Access & Bucket/Key Organization | Single bucket, UUID-prefixed keys + AWS SDK v3 | B (Two buckets by asset type) |
| TD-03 | Backend | Large File Upload Strategy (up to 10GB) | Presigned multipart upload | A (Presigned multipart upload) |
| TD-04 | Backend | Video Processing Tooling (metadata & thumbnail) | Native `child_process` + FFmpeg/ffprobe CLI | A (Native `child_process` + CLI) |
| TD-05 | Backend | Streaming & Download Delivery Strategy | Presigned GET redirect (302) | B (Presigned GET redirect, short TTL + reissue) |
| TD-06 | Backend | Video Processing Status Lifecycle & Failure Handling | Simple enum + queue-level retry/backoff | B (Status enum + audit events table) |
