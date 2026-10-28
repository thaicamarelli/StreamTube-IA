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

### SI-03.1 — Infra: MinIO, Redis, Worker Container e Config Namespaces

**Description:** Sobe a infraestrutura nova da fase (storage, fila, worker) no `compose.yaml` e cria os namespaces de configuração que o resto da fase consome.

**Technical actions:**

1. Adicionar os serviços `minio` (storage, bucket setup) e `redis` (fila) ao `compose.yaml`, com portas, volumes e variáveis de ambiente (per `phase-03-videos/TD-01`, `TD-02`).
2. Adicionar o serviço `video-worker` ao `compose.yaml` com um `Dockerfile.worker` próprio, instalando `ffmpeg` via gerenciador de pacotes do SO (per `phase-03-videos/TD-04`).
3. Criar `src/config/storage.config.ts` (`registerAs('storage', ...)`) com endpoint, bucket names (`videos`, `thumbnails`), credenciais e `forcePathStyle: true` (per `phase-03-videos/TD-02`, seguindo o padrão namespaced de `phase-01-configuracao-base/TD-03`).
4. Criar `src/config/queue.config.ts` (`registerAs('queue', ...)`) com host/porta do Redis (per `phase-03-videos/TD-01`).
5. Estender `src/config/env.validation.ts` com as novas variáveis `STORAGE_*` e `QUEUE_*`/`REDIS_*` no schema Joi (per `phase-01-configuracao-base/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` (estendido) | Integration: novas variáveis `STORAGE_*`/`QUEUE_*` validam com coerção/defaults corretos | `env.validation.integration-spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` traz `minio`, `redis` e `video-worker` com status saudável, junto dos serviços já existentes (`db`, `mailpit`, `nestjs-api`).
- A imagem do `video-worker` responde `ffmpeg -version` com sucesso.
- `ConfigModule` carrega `storage.config.ts` e `queue.config.ts`, injetáveis via `ConfigType`.
- Variáveis de ambiente de storage/fila ausentes ou inválidas fazem o boot falhar, igual ao padrão existente do `env.validation.ts`.

---

### SI-03.2 — Data Model: Video e VideoProcessingEvent

**Description:** Cria a tabela de vídeos (ligada ao canal) e a tabela de auditoria de eventos de processamento.

**Technical actions:**

1. Gerar a migração `CreateVideos` via TypeORM CLI criando a tabela `videos` com todos os campos do Data Model e FK pra `channels.id`.
2. Gerar a migração `CreateVideoProcessingEvents` criando a tabela `video_processing_events` com FK pra `videos.id`.
3. Criar `src/videos/entities/video.entity.ts` (`Video`) com os campos e a relação `ManyToOne` com `Channel`.
4. Criar `src/videos/entities/video-processing-event.entity.ts` (`VideoProcessingEvent`) com os campos e a relação `ManyToOne` com `Video`.
5. Adicionar as relações inversas `OneToMany` em `Channel` (`videos`) e em `Video` (`processingEvents`) — per `.claude/rules/nestjs-entities.md`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints (not null, unique `storage_key`/`thumbnail_key`, enum `status`, default `draft`), FK pra `Channel` | `video.entity.integration-spec.ts` |
| `VideoProcessingEvent` | Integration: constraints, FK pra `Video` | `video-processing-event.entity.integration-spec.ts` |
| migrations | Integration: aplicar todas as migrações cria as tabelas `videos` e `video_processing_events`; reverter remove ambas | `migrations.integration-spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- A migração cria a tabela `videos` com todas as colunas/constraints especificadas, incluindo a FK pra `channels.id`.
- A migração cria a tabela `video_processing_events` com FK pra `videos.id`.
- Inserir um `Video` com `channel_id` inválido falha por violação de FK.
- Inserir dois vídeos com o mesmo `storage_key` falha por violação de unicidade.
- Reverter as migrações remove as duas tabelas sem erro.

---

### SI-03.3 — Catálogo de Erros: Exceções de Domínio do Módulo de Vídeos

**Description:** Define as exceções de domínio específicas de vídeo, reaproveitando o filtro de exceção global já existente.

**Technical actions:**

1. Criar `src/videos/exceptions/video.exceptions.ts` com `VideoNotFoundException` (404), `VideoNotReadyException` (409), `ForbiddenNotOwnerException` (403), `UploadAlreadyCompletedException` (409), `IncompleteMultipartUploadException` (400) e `FileTooLargeException` (400) — todas estendendo `DomainException`, seguindo o padrão de `src/common/exceptions/domain.exception.ts` (per `phase-02-auth/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video.exceptions.ts` | Unit: cada exceção expõe `errorCode`/`httpStatus`/`message` corretos | `video.exceptions.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Instanciar cada exceção de vídeo expõe o `errorCode`, `httpStatus` e `message` definidos no Catálogo de Erros.
- O `DomainExceptionFilter` global mapeia essas novas exceções pro envelope `{ statusCode, error, message }` sem alteração no filtro.
- Todas as novas exceções estendem `DomainException` e preservam o `name` da classe via `this.constructor.name`.

---

### SI-03.4 — Storage Module: Upload Multipart e URLs Pré-assinadas

**Description:** Encapsula toda a interação com o storage de objetos (MinIO/S3) atrás de um serviço único.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `storage.service.ts` com um `S3Client` configurado via `storage.config.ts` (`forcePathStyle: true`), per `phase-03-videos/TD-02`.
2. Implementar `StorageService.createMultipartUpload(bucket, key)` → `CreateMultipartUploadCommand`, retorna `uploadId`.
3. Implementar `StorageService.getPresignedPartUrls(bucket, key, uploadId, partCount)` → uma `UploadPartCommand` presigned URL por parte via `getSignedUrl` (per `phase-03-videos/TD-03`).
4. Implementar `StorageService.completeMultipartUpload(bucket, key, uploadId, parts)` → `CompleteMultipartUploadCommand`.
5. Implementar `StorageService.getPresignedGetUrl(bucket, key, { expiresInSeconds, disposition })` → `GetObjectCommand` presigned URL com TTL ~15min e `ResponseContentDisposition` configurável (per `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real via Compose — round-trip completo de multipart create/upload-part/complete contra um objeto de teste | `storage.service.integration-spec.ts` |
| `StorageService` | Unit: `getPresignedGetUrl` monta disposition/TTL corretos (mock dos argumentos de chamada do `S3Client`) | `storage.service.spec.ts` |

**Dependencies:** SI-03.1 — precisa do MinIO rodando e de `storage.config.ts`

**Acceptance criteria:**

- `createMultipartUpload` retorna um `uploadId` válido reconhecido pelo MinIO.
- `getPresignedPartUrls` gera N URLs assinadas, uma por parte, que aceitam PUT direto no MinIO sem passar pela API.
- `completeMultipartUpload` com as partes corretas finaliza o objeto no bucket `videos`.
- `completeMultipartUpload` com partes incompletas/incorretas lança um erro identificável pela camada de service.
- `getPresignedGetUrl` com `disposition: 'attachment'` gera URL com `response-content-disposition=attachment`; com `'inline'`, gera `inline`.

---

### SI-03.5 — Queue Module: BullMQ Producer e Worker Scaffold

**Description:** Registra a fila `video-processing` na API e cria o scaffold do processo worker separado.

**Technical actions:**

1. Registrar `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } } })` em `VideosModule` (per `phase-03-videos/TD-01`).
2. Criar `src/videos/video-processing.consumer.ts` com a classe `VideoProcessingConsumer` (`@Processor('video-processing')` extends `WorkerHost`) — scaffold sem lógica de negócio ainda.
3. Criar `src/worker/worker.module.ts` registrando `VideoProcessingConsumer` como provider, isolado dos módulos HTTP da API — o worker roda num processo/container separado (per `phase-03-videos/TD-01`).
4. Criar `src/worker-main.ts` como entrypoint standalone (`NestFactory.createApplicationContext(WorkerModule)`), distinto do `main.ts` da API.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` (com `BullModule`) | Unit: compilation test — módulo compila com a fila `video-processing` registrada e injetável via `@InjectQueue` | `videos.module.spec.ts` |
| `WorkerModule` | Unit: compilation test — compila isolado, sem depender de módulos HTTP | `worker.module.spec.ts` |

**Dependencies:** SI-03.1 — precisa do Redis rodando e de `queue.config.ts`

**Acceptance criteria:**

- `VideosModule` compila com a fila `video-processing` registrada.
- `WorkerModule` compila isoladamente.
- O entrypoint `worker-main.ts` inicializa um `ApplicationContext` sem abrir porta HTTP.

---

### SI-03.6 — Endpoint: Iniciar Upload (POST /videos)

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (rascunho criado sob o próprio canal do chamador)

**Description:** Pré-cadastra o vídeo como rascunho e orquestra o início do upload multipart.

**Technical actions:**

1. Criar `CreateVideoDto` (`originalFilename: string`, `fileSizeBytes: number`) com `class-validator`, incluindo `@Max(10737418240)` em `fileSizeBytes` (per `phase-02-auth/TD-06`).
2. Implementar `VideosService.initiateUpload(channelId, dto)` — cria o `Video` em `draft` com `original_filename`, chama `StorageService.createMultipartUpload` + `getPresignedPartUrls`, persiste `upload_id`.
3. Implementar `POST /videos` em `VideosController`, protegido pelo `AuthGuard` existente, retornando `201`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: cria draft + orquestra storage (mock `StorageService`) | `videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: cria o `Video` real no banco com `status: draft` e `upload_id` de um multipart real no MinIO | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video`), SI-03.3 (exceções), SI-03.4 (`StorageService`)

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id`, `uploadId` e `parts` (uma URL por parte).
- `POST /videos` com `fileSizeBytes` acima de 10GB retorna `400` com `errorCode: "FILE_TOO_LARGE"`.
- `POST /videos` sem token de acesso válido retorna `401`.
- Após a chamada, existe um `Video` persistido com `status: "draft"` e `channel_id` igual ao canal do chamador.

---

### SI-03.7 — Endpoint: Completar Upload (POST /videos/:id/complete)

**Route:** POST /videos/:id/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner

**Description:** Finaliza o upload multipart no storage e enfileira o processamento em segundo plano.

**Technical actions:**

1. Criar `CompleteVideoUploadDto` (`parts: { partNumber: number, eTag: string }[]`) com validação nested.
2. Implementar `VideosService.completeUpload(videoId, callerChannelId, dto)` — valida existência (`VideoNotFoundException`), ownership (`ForbiddenNotOwnerException`), status `draft` (`UploadAlreadyCompletedException`), chama `StorageService.completeMultipartUpload` (erro mapeado pra `IncompleteMultipartUploadException`), seta `status: "processing"`, enfileira o job `video.process` na fila `video-processing` (per `phase-03-videos/TD-01`).
3. Implementar `POST /videos/:id/complete` em `VideosController`, protegido pelo `AuthGuard`, retornando `202`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic — not found, not owner, status errado (mock repo + storage + fila) | `videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: real DB + MinIO + fila — fluxo completo de upload multipart real (criar, enviar partes via PUT nas URLs assinadas, completar) e job enfileirado | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (fluxo de iniciar upload), SI-03.5 (fila)

**Acceptance criteria:**

- `POST /videos/:id/complete` com partes válidas retorna `202` e muda o `status` do vídeo pra `"processing"`.
- `POST /videos/:id/complete` pra um `:id` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.
- `POST /videos/:id/complete` chamado por quem não é dono do canal retorna `403` com `errorCode: "FORBIDDEN_NOT_OWNER"`.
- `POST /videos/:id/complete` chamado num vídeo que não está em `draft` retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`.
- Completar com sucesso enfileira exatamente um job `video.process` com o `videoId` correto.

---

### SI-03.8 — Endpoints de Leitura e Entrega (GET /videos/:id, /stream, /download)

**Routes:** GET /videos/:id, GET /videos/:id/stream, GET /videos/:id/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous (stream/download exigem `status: "ready"`)

**Description:** Expõe a leitura do status do vídeo e a entrega por streaming/download via redirect pra URL pré-assinada.

**Technical actions:**

1. Implementar `GET /videos/:id` em `VideosController` — retorna os campos públicos do vídeo, sem autenticação.
2. Implementar `VideosService.getDeliveryUrl(videoId, disposition)` — valida `status: "ready"` (`VideoNotReadyException`), chama `StorageService.getPresignedGetUrl`.
3. Implementar `GET /videos/:id/stream` — chama `getDeliveryUrl(id, 'inline')`, responde `302` com `Location`.
4. Implementar `GET /videos/:id/download` — chama `getDeliveryUrl(id, 'attachment')`, responde `302` com `Location`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDeliveryUrl` | Unit: valida `status: "ready"`, chama storage com a disposition correta (mock `StorageService`) | `videos.service.spec.ts` |

**Dependencies:** SI-03.4 (`StorageService`), SI-03.2 (entidade `Video`)

**Acceptance criteria:**

- `GET /videos/:id` existente retorna `200` com os campos do vídeo.
- `GET /videos/:id` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.
- `GET /videos/:id/stream` com `status: "ready"` retorna `302` com `Location` apontando pra uma URL assinada com `response-content-disposition=inline`.
- `GET /videos/:id/stream` com `status != "ready"` retorna `409` com `errorCode: "VIDEO_NOT_READY"`.
- `GET /videos/:id/download` com `status: "ready"` retorna `302` com `Location` apontando pra uma URL assinada com `response-content-disposition=attachment`.

---

### SI-03.9 — Video Worker: Extração de Metadados e Geração de Thumbnail

**Description:** Consome a fila de processamento e executa a extração de metadados e a geração de thumbnail, atualizando o ciclo de status do vídeo.

**Technical actions:**

1. Implementar `VideoProcessingConsumer.process(job)` — acessa o arquivo original no bucket `videos` (stream direto do MinIO, ou um diretório temporário do container quando `ffmpeg` exigir um caminho de arquivo).
2. Executar `ffprobe -print_format json -show_format` via `child_process` pra extrair `duration` (per `phase-03-videos/TD-04`).
3. Executar `ffmpeg -ss {duration * 0.1} -vframes 1` via `child_process` pra gerar a thumbnail, e subir pro bucket `thumbnails` via `StorageService` (per `TD-04`'s clarificação do frame em 10% da duração).
4. Em caso de sucesso: atualizar `Video.status = "ready"`, `duration_seconds`, `thumbnail_key`; registrar `VideoProcessingEvent(status: "ready", attempt)`.
5. Em caso de falha (após esgotar os `attempts` da fila): atualizar `Video.status = "error"`, `error_reason`; registrar `VideoProcessingEvent(status: "error", attempt, message)` (per `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Integration: fila BullMQ real + MinIO real + ffmpeg real — upload de um vídeo de teste pequeno, processa, verifica `status: "ready"`, `duration_seconds` e `thumbnail_key` persistidos | `video-processing.consumer.integration-spec.ts` |
| `VideoProcessingConsumer` | Integration: vídeo inválido/corrompido esgota os retries e termina em `status: "error"` com `error_reason` populado | `video-processing.consumer.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidades), SI-03.4 (`StorageService`), SI-03.5 (fila/worker scaffold), SI-03.7 (precisa que o job seja enfileirado por `completeUpload`)

**Acceptance criteria:**

- Um job `video.process` processado com sucesso atualiza `Video.status` pra `"ready"`, preenche `duration_seconds` e `thumbnail_key`.
- A thumbnail gerada corresponde ao frame em 10% da duração do vídeo.
- Um job que falha em todas as tentativas (`attempts: 3`) deixa `Video.status = "error"` com `error_reason` preenchido.
- Cada tentativa de processamento (sucesso ou falha) gera uma linha em `video_processing_events` com o `attempt` correto.

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

```
SI-03.1 (root) — Infra: MinIO, Redis, worker container
├── SI-03.4 — depends on SI-03.1 (storage module precisa do MinIO)
└── SI-03.5 — depends on SI-03.1 (fila precisa do Redis)

SI-03.2 (root) — Data Model: Video, VideoProcessingEvent

SI-03.3 (root) — Catálogo de Erros: exceções de domínio

SI-03.6 — depends on SI-03.2, SI-03.3, SI-03.4 (endpoint: iniciar upload)
└── SI-03.7 — depends on SI-03.5, SI-03.6 (endpoint: completar upload)
    └── SI-03.9 — depends on SI-03.2, SI-03.4, SI-03.5, SI-03.7 (video worker)

SI-03.8 — depends on SI-03.2, SI-03.4 (endpoints de leitura/entrega)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: MinIO, Redis, Worker Container e Config Namespaces
- [ ] SI-03.2 — Data Model: Video e VideoProcessingEvent
- [ ] SI-03.3 — Catálogo de Erros: Exceções de Domínio do Módulo de Vídeos
- [ ] SI-03.4 — Storage Module: Upload Multipart e URLs Pré-assinadas
- [ ] SI-03.5 — Queue Module: BullMQ Producer e Worker Scaffold
- [ ] SI-03.6 — Endpoint: Iniciar Upload (POST /videos)
- [ ] SI-03.7 — Endpoint: Completar Upload (POST /videos/:id/complete)
- [ ] SI-03.8 — Endpoints de Leitura e Entrega (GET /videos/:id, /stream, /download)
- [ ] SI-03.9 — Video Worker: Extração de Metadados e Geração de Thumbnail

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
