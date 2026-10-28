---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

Endpoint que pré-cadastra um vídeo como rascunho e orquestra o início de um upload multipart direto pro storage de objetos (MinIO), sem passar os bytes do vídeo pela API. Exige autenticação — o vídeo é criado sob o canal do chamador.

## Test Scenarios

### 1. Upload initiation

**Setup:** `beforeEach` truncar as tabelas `videos`, `users`, `channels` via `dataSource.query('DELETE FROM ...')`; bootstrap do app via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `main.ts` (ValidationPipe global, filtro de exceção); registrar um usuário + canal real e autenticar pra obter um `access_token`.

#### 1.1. valid-upload-request-returns-draft-and-presigned-parts

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ originalFilename: "video.mp4", fileSizeBytes: 52428800 }`
    - expect: status `201`
    - expect: body contém `id` (uuid), `uploadId` (string), `parts` (array não vazio de `{ partNumber, url }`) e `partSizeBytes`
  2. Consultar a tabela `videos` pelo `id` retornado
    - expect: existe uma linha com `status: "draft"`, `original_filename: "video.mp4"` e `channel_id` igual ao canal do usuário autenticado

#### 1.2. file-size-above-10gb-returns-file-too-large

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ originalFilename: "huge.mp4", fileSizeBytes: 10737418241 }` (10GB + 1 byte)
    - expect: status `400`
    - expect: body `{ error: "FILE_TOO_LARGE" }` (envelope per `phase-02-auth/TD-07`)

#### 1.3. missing-access-token-returns-unauthorized

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos sem header `Authorization` e body `{ originalFilename: "video.mp4", fileSizeBytes: 52428800 }`
    - expect: status `401`
