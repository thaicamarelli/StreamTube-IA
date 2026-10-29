# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/9 completed

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
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - `@nestjs/bullmq` é distribuído como ESM puro; o Jest exclui `node_modules` da transformação por padrão, quebrando o import com `SyntaxError: Unexpected token 'export'`. Corrigido com `transformIgnorePatterns` em `package.json` (jest config) e `test/jest-e2e.json` liberando `@nestjs/bullmq`, `@nestjs/bull-shared` e `bullmq`.
  - `ioredis` precisou ser instalado como dependência direta — o BullMQ exige ele em runtime pra construir a conexão Redis, mas só aparecia como peer dependency transitiva, nunca instalada de fato.
  - Seguindo a convenção do projeto de não mockar libs configuradas (`.claude/skills/testing-guide-nestjs-project`), os testes de compilação do módulo usam uma conexão Redis real (serviço `redis` do Compose), não um mock da fila.

### SI-03.6 — Endpoint: Iniciar Upload (POST /videos)
- **Status:** completed
- **Tests:** 13 passing (4 unit + 2 integration em `videos.service`; 3 e2e em `videos-initiate-upload`; 2 unit + 2 integration novos em `ChannelsService.findByUserId`)
- **Observations:**
  - `CreateVideoDto.fileSizeBytes` deliberadamente não usa `@Max(10GB)` — um limite de schema geraria um erro de validação genérico em vez do `FILE_TOO_LARGE` (400) específico exigido pelo Error Catalog. O limite de 10GB é verificado em `VideosService.initiateUpload` e lança `FileTooLargeException`.
  - `ChannelsService` ganhou um segundo parâmetro de construtor (`channelRepository`, via `@InjectRepository(Channel)`) para suportar `findByUserId`. Isso quebrou todo arquivo que instanciava `new ChannelsService(dataSource)` com um único argumento, e todo `ALL_ENTITIES` de teste que incluía `Channel` sem `Video`/`VideoProcessingEvent` (a nova relação `@OneToMany` de `Channel` para `Video` exige que `Video` esteja registrado no mesmo DataSource). Afetou 10 arquivos fora do escopo direto da SI: `channels.module.spec.ts`, `channels.service.integration-spec.ts`, `channel.entity.integration-spec.ts`, `user.entity.integration-spec.ts`, `users.module.spec.ts`, `users.service.integration-spec.ts` (+ 2 call sites de `ChannelsService`), `verification-token.entity.integration-spec.ts`, `refresh-token.entity.integration-spec.ts`, `auth.service.integration-spec.ts`, `auth.module.spec.ts`. Todos corrigidos e revalidados.
  - Bug real encontrado ao rodar a suíte completa (não relacionado à SI em si, mas exposto por ela): `migrations.integration-spec.ts` fazia os `DROP TABLE ... CASCADE` do `beforeAll` via `Promise.all`, disparando múltiplas conexões concorrentes do pool. Com a nova FK `videos.channel_id -> channels.id`, isso passou a causar `deadlock detected` real no Postgres (um DROP CASCADE em `channels` conflitava com o DROP direto em `videos`/`video_processing_events` rodando em paralelo). Corrigido trocando para drops sequenciais (`for...of` com `await`).
  - Suíte completa (33 suites / 192 testes) e e2e (4 suites / 55 testes) revalidadas 100% verdes após as correções acima; `tsc --noEmit` limpo.

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
