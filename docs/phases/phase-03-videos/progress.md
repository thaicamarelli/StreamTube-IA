# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/9 completed

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
- **Tests:** 21 passing (7 unit + 3 integration em `videos.service`; 4 e2e em `videos-initiate-upload`; 2 unit + 2 integration novos em `ChannelsService.findByUserId`; 1 integration novo e 1 unit novo em `StorageService`/exceções)
- **Observations:**
  - `CreateVideoDto.fileSizeBytes` deliberadamente não usa `@Max(10GB)` — um limite de schema geraria um erro de validação genérico em vez do `FILE_TOO_LARGE` (400) específico exigido pelo Error Catalog. O limite de 10GB é verificado em `VideosService.initiateUpload` e lança `FileTooLargeException`.
  - `ChannelsService` ganhou um segundo parâmetro de construtor (`channelRepository`, via `@InjectRepository(Channel)`) para suportar `findByUserId`. Isso quebrou todo arquivo que instanciava `new ChannelsService(dataSource)` com um único argumento, e todo `ALL_ENTITIES` de teste que incluía `Channel` sem `Video`/`VideoProcessingEvent` (a nova relação `@OneToMany` de `Channel` para `Video` exige que `Video` esteja registrado no mesmo DataSource). Afetou 10 arquivos fora do escopo direto da SI: `channels.module.spec.ts`, `channels.service.integration-spec.ts`, `channel.entity.integration-spec.ts`, `user.entity.integration-spec.ts`, `users.module.spec.ts`, `users.service.integration-spec.ts` (+ 2 call sites de `ChannelsService`), `verification-token.entity.integration-spec.ts`, `refresh-token.entity.integration-spec.ts`, `auth.service.integration-spec.ts`, `auth.module.spec.ts`. Todos corrigidos e revalidados.
  - Bug real encontrado ao rodar a suíte completa (não relacionado à SI em si, mas exposto por ela): `migrations.integration-spec.ts` fazia os `DROP TABLE ... CASCADE` do `beforeAll` via `Promise.all`, disparando múltiplas conexões concorrentes do pool. Com a nova FK `videos.channel_id -> channels.id`, isso passou a causar `deadlock detected` real no Postgres (um DROP CASCADE em `channels` conflitava com o DROP direto em `videos`/`video_processing_events` rodando em paralelo). Corrigido trocando para drops sequenciais (`for...of` com `await`).
  - Suíte completa (33 suites / 192 testes) e e2e (4 suites / 55 testes) revalidadas 100% verdes após as correções acima; `tsc --noEmit` limpo.
  - Revisão pós-SI (agente em background) encontrou 3 bugs reais, todos corrigidos: (1) ausência de canal pra o usuário autenticado lançava `new Error(...)` genérico em vez de `DomainException` — como `DomainExceptionFilter` só captura `DomainException`, isso vazava como 500 fora do envelope padrão da API; criada `ChannelNotFoundException` (404); (2) a orquestração multipart→DB não tinha compensação — se o `save`/`update` do `Video` falhasse depois do `createMultipartUpload` no MinIO, o upload ficava aberto no storage sem nenhum jeito de rastreá-lo ou cancelá-lo (`StorageService` nem tinha `abortMultipartUpload`); adicionado `abortMultipartUpload` e reestruturado `initiateUpload` pra fazer toda a orquestração de storage antes do único `save` no banco (já com `upload_id` incluso, eliminando o `update` separado), com `abortMultipartUpload` disparado em qualquer falha após a criação do upload; (3) `CreateVideoDto.originalFilename` não tinha `@MaxLength(255)` compatível com a coluna da entidade — um filename maior vazava como `QueryFailedError` cru (500) em vez de `400`; adicionado o `@MaxLength(255)`.
  - Revisão também apontou testes de baixa qualidade e lacunas de cobertura, todos fechados: teste de "sem canal" que só checava `.rejects.toThrow()` sem verificar o tipo da exceção (agora verifica `ChannelNotFoundException`); e2e fabricava usuário/canal direto via repository + `jwtService.sign` manual em vez do fluxo HTTP real de registro/confirmação/login (reescrito pra usar `registerConfirmAndLogin`, no padrão de `auth.e2e-spec.ts`); faltava teste pra `fileSizeBytes` exatamente no limite de 10GB, falha do `StorageService` no meio da orquestração (2 cenários: falha ao gerar as URLs de parte, falha ao salvar no banco — ambos verificando que `abortMultipartUpload` é chamado), e `originalFilename` acima de 255 chars (unit + e2e).
  - Contagem de erros de lint subiu de 150 (baseline anterior) pra 207 — crescimento esperado, não uma regressão de categoria nova: os testes novos seguem o mesmo padrão já estabelecido no projeto (mocks tipados como `any` em `.spec.ts`, `response.body` não tipado em `.e2e-spec.ts`), que já gera os mesmos `no-unsafe-member-access`/`no-unsafe-assignment` em todo o resto da suite de testes (ex: `auth.service.spec.ts` já tinha 45, `auth.e2e-spec.ts` já tinha 48). Fica dentro da decisão já tomada de deferir todo o lint pra fase de encerramento.

### SI-03.7 — Endpoint: Completar Upload (POST /videos/:id/complete)
- **Status:** completed
- **Tests:** 17 passing (6 unit + 5 integration em `VideosService.completeUpload`; 6 e2e em `videos-complete-upload`)
- **Observations:**
  - `VideosService.completeUpload(userId, videoId, dto)` resolve o canal do chamador via `ChannelsService.findByUserId` (mesmo padrão de `initiateUpload`) em vez de receber `callerChannelId` já resolvido como o texto do plano sugeria — manter a resolução dentro do service evita vazar essa lógica de autorização pro controller (thin controller, per `nestjs-layer-separation.md`). Chamador sem canal nenhum também cai em `ForbiddenNotOwnerException` (não `ChannelNotFoundException` — este endpoint é owner-only, então "não tem canal" e "não é o dono" são o mesmo caso de borda do ponto de vista do Error Catalog).
  - Ordem de validação segue exatamente a do plano: existência (`VideoNotFoundException`, 404) → ownership (`ForbiddenNotOwnerException`, 403) → status `draft` (`UploadAlreadyCompletedException`, 409) → `StorageService.completeMultipartUpload` (erro mapeado pra `IncompleteMultipartUploadException`, 400) → `status: processing` → enfileira `video.process` na fila `video-processing`.
  - Erro do storage não avança estado nenhum: se `completeMultipartUpload` falha, nem o `status` do vídeo muda nem o job é enfileirado (testado explicitamente nos 3 níveis — unit, integration, e2e).
  - Teste de integração usa fila BullMQ real (Redis do Compose) via `BullModule.forRoot` + `registerQueue` no `TestingModule`, no mesmo padrão já usado em `videos.module.spec.ts` — nunca mockando a fila, seguindo a convenção do projeto de não mockar libs configuradas.
  - e2e cobre os 4 cenários do spec (`videos-complete-upload.plan.md`) mais 2 adicionais fora do spec original: `401` sem token e `400 INCOMPLETE_MULTIPART_UPLOAD` com partes incorretas — ambos códigos de erro do catálogo que não tinham cenário dedicado no spec gerado.

### SI-03.8 — Endpoints de Leitura e Entrega (GET /videos/:id, /stream, /download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video Worker: Extração de Metadados e Geração de Thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none
