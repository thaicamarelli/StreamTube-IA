---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-complete-upload.e2e-spec.ts
---

# POST /videos/:id/complete Test Plan

## Application Overview

Endpoint que finaliza um upload multipart no storage de objetos e enfileira o processamento em segundo plano do vídeo. Só o dono do canal do vídeo pode completar o upload, e o vídeo precisa estar em `draft`.

## Test Scenarios

### 1. Upload completion

**Setup:** `beforeEach` truncar as tabelas `videos`, `users`, `channels` via `dataSource.query('DELETE FROM ...')`; bootstrap do app via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `main.ts`; registrar dois usuários/canais distintos (`owner` e `other`) e autenticar ambos; antes de cada cenário, chamar `POST /videos` como `owner` pra ter um vídeo em `draft` com `uploadId` real e enviar as partes via PUT direto nas URLs pré-assinadas retornadas (MinIO real via Compose).

#### 1.1. valid-completion-returns-202-and-sets-processing

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos/:id/complete como `owner`, com body `{ parts: [{ partNumber: 1, eTag: "<etag-da-parte-enviada>" }, ...] }`
    - expect: status `202`
  2. Consultar a tabela `videos` pelo `id`
    - expect: `status: "processing"`
  3. Consultar a fila `video-processing` (via o `Queue` do BullMQ injetado no teste, ou via inspeção direta do Redis)
    - expect: exatamente um job `video.process` enfileirado com `{ videoId: "<id>" }`

#### 1.2. nonexistent-video-returns-video-not-found

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos/00000000-0000-0000-0000-000000000000/complete como `owner`, com body `{ parts: [{ partNumber: 1, eTag: "qualquer" }] }`
    - expect: status `404`
    - expect: body `{ error: "VIDEO_NOT_FOUND" }`

#### 1.3. non-owner-returns-forbidden

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. POST /videos/:id/complete autenticado como `other` (não é o dono do canal do vídeo), com body de parts válido
    - expect: status `403`
    - expect: body `{ error: "FORBIDDEN_NOT_OWNER" }`

#### 1.4. already-completed-returns-conflict

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. Completar o upload com sucesso como `owner` (vídeo passa pra `processing`)
  2. POST /videos/:id/complete de novo como `owner`, com o mesmo body de parts
    - expect: status `409`
    - expect: body `{ error: "UPLOAD_ALREADY_COMPLETED" }`
