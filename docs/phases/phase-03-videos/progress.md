# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/9 completed

### SI-03.1 — Infra: MinIO, Redis, Worker Container e Config Namespaces
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - `minio/minio` e `quay.io/minio/minio` foram descontinuados pelo Docker Hub/Quay em 2026-09-24; `quay.io/minio/aistor/minio` é a nova oficial mas exige licença comercial (bloqueia operações S3 sem ela). Usado `bitnamilegacy/minio` como alternativa livre, com `MINIO_DEFAULT_BUCKETS=videos,thumbnails` criando os buckets automaticamente no boot (elimina a necessidade de lógica de "ensure bucket" na SI-03.4).
  - Healthcheck do MinIO trocado de `mc ready local` (binário `mc` não necessariamente presente) para `curl -f http://localhost:9000/minio/health/live`, mais portável.

### SI-03.2 — Data Model: Video e VideoProcessingEvent
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - O status da `videos` table reusa o enum `VideoStatus` (draft/processing/ready/error); `video_processing_events.status` usa um enum próprio e mais estreito (`VideoProcessingEventStatus`: processing/ready/error, sem `draft`) já que um evento de auditoria nunca registra um rascunho.
  - `video.entity.integration-spec.ts`, `video-processing-event.entity.integration-spec.ts` e `cleanAllTables` seguem o padrão existente de `channel.entity.integration-spec.ts`.
  - `migrations.integration-spec.ts` estendido: agora espera 3 migrações e 6 tabelas; o teste "revert last migration" passou a verificar a remoção de `videos`/`video_processing_events` (a nova última migração), não mais `refresh_tokens`/`verification_tokens`.

### SI-03.3 — Catálogo de Erros: Exceções de Domínio do Módulo de Vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Storage Module: Upload Multipart e URLs Pré-assinadas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Queue Module: BullMQ Producer e Worker Scaffold
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint: Iniciar Upload (POST /videos)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint: Completar Upload (POST /videos/:id/complete)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoints de Leitura e Entrega (GET /videos/:id, /stream, /download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video Worker: Extração de Metadados e Geração de Thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none
