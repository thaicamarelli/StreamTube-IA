# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/9 completed

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
- **Status:** completed
- **Tests:** 6 passing
- **Observations:** none

### SI-03.4 — Storage Module: Upload Multipart e URLs Pré-assinadas
- **Status:** completed
- **Tests:** 11 passing
- **Observations:**
  - `getPresignedGetUrl` é pura (assinatura local, sem round-trip de rede), então o teste unitário inspeciona a URL assinada de verdade (query params `response-content-disposition`/`X-Amz-Expires`) em vez de mockar o `S3Client`.
  - Tamanho de parte fixado em 100MB (`PART_SIZE_BYTES`); não é um valor citado no plano, foi uma escolha de implementação dentro do que a TD-03 deixou aberto (orquestração do multipart).
  - Revisão pós-SI encontrou e corrigiu 3 bugs reais: (1) URLs de upload de parte usavam o TTL de 15min do GET (TD-05), insuficiente pra um upload de 10GB que pode levar mais de uma hora — criada constante separada de 24h só pra isso; (2) `completeMultipartUpload` não ordenava as partes por `partNumber` antes de montar o payload — S3 real exige ordem ascendente (MinIO é mais tolerante, mascarava o problema); (3) o filename do `Content-Disposition` de attachment não escapava aspas nem tinha fallback RFC 6266 pra nomes com acentos — adicionado `buildAttachmentDisposition` com `filename*=UTF-8''...`.
  - Um teste novo ("fewer parts than uploaded") partiu de premissa errada: `CompleteMultipartUpload` monta o objeto só com as partes *listadas* no pedido — submeter um subconjunto das partes enviadas é comportamento válido do S3, não erro. Corrigido pra testar o cenário que de fato falha (referenciar um `partNumber` nunca enviado).

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
