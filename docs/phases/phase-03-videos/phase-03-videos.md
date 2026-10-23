---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-23T19:07:38-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-23T19:06:41-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-23T18:55:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar o upload de vídeos de até 10GB sem passar os bytes pela API (upload multipart via URL pré-assinada), o pré-cadastro automático do vídeo como rascunho, o processamento em segundo plano (fila BullMQ + worker dedicado) que extrai metadados e gera thumbnail via FFmpeg, a entrega por streaming/download via redirect para URL pré-assinada, e o ciclo de status do vídeo (draft → processing → ready | error) com auditoria de eventos de processamento.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → channels.id, not null |
| title | varchar(255) | nullable — populated at upload time from `original_filename` as a default; editable title/description arrive in Fase 04 |
| original_filename | varchar(255) | not null |
| status | enum('draft','processing','ready','error') | not null, default `draft` |
| storage_key | varchar(255) | not null, unique — object key in the `videos` bucket (equals `id`, per `phase-03-videos/TD-02`) |
| thumbnail_key | varchar(255) | nullable, unique — object key in the `thumbnails` bucket (equals `id`, per `phase-03-videos/TD-02`); null until processing succeeds |
| duration_seconds | integer | nullable — populated by the worker on successful processing (per `phase-03-videos/TD-04`) |
| upload_id | varchar(255) | nullable — the storage multipart `UploadId` (per `phase-03-videos/TD-03`); set on upload initiation |
| error_reason | text | nullable — populated when `status = error` (per `phase-03-videos/TD-06`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one, `channel_id`).
**Indexes:** index on `channel_id`; unique on `storage_key`; unique on `thumbnail_key`.

#### VideoProcessingEvent

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| video_id | uuid | FK → videos.id, not null |
| status | enum('processing','ready','error') | not null — the status transition this event records |
| attempt | integer | not null — the queue job's attempt number (per `phase-03-videos/TD-01`'s retry/backoff) |
| message | text | nullable — error detail or informational note |
| created_at | timestamptz | default now() |

**Relations:** `Video` has many `VideoProcessingEvent` (one-to-many); `VideoProcessingEvent` belongs to `Video` (many-to-one, `video_id`).
**Indexes:** index on `video_id`.

*(Chosen per `phase-03-videos/TD-06` — Option B, status enum + audit table, over the simpler recommendation.)*

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- originalFilename: string, required
- fileSizeBytes: number, required — max 10,737,418,240 (10GB, per `phase-03-videos/TD-03`)

**Response 201:**
- id: string (uuid)
- uploadId: string — the storage multipart UploadId
- parts: array of `{ partNumber: number, url: string }` — one presigned PUT URL per part (per `phase-03-videos/TD-03`)
- partSizeBytes: number

**Error responses:**
- 400 FILE_TOO_LARGE: when `fileSizeBytes` exceeds the 10GB limit
- 400 validation error: when the request body fails schema validation
- 401 (inherited error envelope, `phase-02-auth/TD-07`): when no valid access token is present — this endpoint requires authentication (the draft video is owned by the caller's channel)

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required — one entry per uploaded part

**Response 202:** Accepted — processing enqueued. No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match an existing video
- 403 FORBIDDEN_NOT_OWNER: when the caller is not the owner of the video's channel
- 409 UPLOAD_ALREADY_COMPLETED: when the video's `status` is not `draft`
- 400 INCOMPLETE_MULTIPART_UPLOAD: when the submitted `parts` list does not match what storage expects (fails `CompleteMultipartUpload`)
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:id (SI-03.7)

**Response 200:**
- id: string (uuid)
- channelId: string (uuid)
- title: string | null
- status: string (`draft` | `processing` | `ready` | `error`)
- durationSeconds: number | null
- errorReason: string | null
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match an existing video

*(No authentication required — anonymous read access, per `phase-03-videos/TD-05`'s framing that anonymous viewing is a first-class platform feature in this phase; visibility restrictions arrive in Fase 04.)*

---

#### GET /videos/:id/stream (SI-03.7)

**Response 302:** Redirect — `Location` header is a short-lived (~15 min) presigned GET URL with `response-content-disposition=inline` (per `phase-03-videos/TD-05`). The client's video element follows the redirect and issues `Range` requests directly against storage, which natively returns `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match an existing video
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

---

#### GET /videos/:id/download (SI-03.7)

**Response 302:** Redirect — same mechanism as `/stream`, but the presigned URL sets `response-content-disposition=attachment; filename="{original_filename}"` (per `phase-03-videos/TD-05`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match an existing video
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

#### Validation Rules — Videos

- `originalFilename`: required, non-empty string
- `fileSizeBytes`: required, integer, `1 <= fileSizeBytes <= 10737418240`
- `parts`: required, non-empty array; each entry requires `partNumber` (positive integer) and `eTag` (non-empty string)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|----------------|-------|
| POST /videos | ✗ | ✓ *(draft created under caller's own channel)* | n/a |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:id | ✓ | ✓ | ✓ |
| GET /videos/:id/stream | ✓ *(only when `status = ready`)* | ✓ | ✓ |
| GET /videos/:id/download | ✓ *(only when `status = ready`)* | ✓ | ✓ |

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_LARGE | 400 | `fileSizeBytes` no `POST /videos` excede 10GB |
| INCOMPLETE_MULTIPART_UPLOAD | 400 | A lista de `parts` enviada em `POST /videos/:id/complete` não corresponde ao que o storage espera |
| VIDEO_NOT_FOUND | 404 | `:id` não corresponde a um vídeo existente, em qualquer endpoint `/videos/:id*` |
| FORBIDDEN_NOT_OWNER | 403 | Chamador autenticado não é o dono do canal do vídeo em `POST /videos/:id/complete` |
| UPLOAD_ALREADY_COMPLETED | 409 | `POST /videos/:id/complete` chamado quando o vídeo não está em `draft` |
| VIDEO_NOT_READY | 409 | `GET /videos/:id/stream` ou `/download` chamado quando `status != ready` |

*(Envelope format inherited from `phase-02-auth/TD-07` — `{ statusCode, error, message }` via `DomainException` subclasses + the existing exception filter; no new envelope shape introduced.)*

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (SI-03.6, per `phase-03-videos/TD-01`, `TD-03`) — enqueues the job immediately after `CompleteMultipartUpload` succeeds, before responding `202` to the client.
**Consumer:** `VideoProcessingConsumer` (SI-03.8, per `phase-03-videos/TD-01`, `TD-04`) — runs `ffprobe` for duration/metadata, extracts the thumbnail frame at 10% of total duration via `ffmpeg` (per `TD-04`'s clarification), uploads the thumbnail to the `thumbnails` bucket, then updates `Video.status` to `ready` or `error` and appends a `VideoProcessingEvent` row (per `TD-06`).
**Trigger:** Fires on every successful `POST /videos/:id/complete` call.
**Delivery semantics:** at-least-once, with `attempts: 3` and exponential `backoff` (`delay: 1000ms`) (per `phase-03-videos/TD-01`). After the final attempt fails, the worker sets `Video.status = error` with `error_reason` populated (per `phase-03-videos/TD-06`) instead of retrying indefinitely.

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
